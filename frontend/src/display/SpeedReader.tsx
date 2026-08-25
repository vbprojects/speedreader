// src/display/SpeedReader.tsx
// Reading-view display: a normal wrapped text block (like an epub reader)
// where the current word is highlighted inline. As reading progresses, the
// block auto-scrolls so the current word stays vertically centered.
//
// Design: DOM-only (no canvas/Pretext). The visible window of words renders
// as a flowing paragraph; the current word gets a highlight pill; a scroll
// effect keeps the highlighted word centered in the viewport.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WordStream } from "../epub/types";
import { InteractionOverlay } from "../interactions";
import type { InteractionResponse, ReaderInteraction } from "../interactions/types";
import type { PacingEngine } from "../pacing/engine";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import { NavTreeView } from "../navigation";
import { SelfCorrectingClock } from "./clock";
import { buildFrame } from "./renderer";
import { traditionalEntryScrollNudge } from "./traditional-gesture";
import type { DisplayConfig, DisplayFrame, ReaderViewMode } from "./types";
import { WordContextMenu, type WordContextMenuState } from "./WordContextMenu";

/** True when the viewport is at or below the given breakpoint. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export interface SpeedReaderProps {
  stream: WordStream;
  pacing: PacingEngine;
  config?: Partial<DisplayConfig>;
  /** Visual settings applied to the reader. */
  fontFamily?: string;
  fontSize?: number;
  theme?: Theme;
  /** Show the navigation tree sidebar. */
  showNav?: boolean;
  /** Max tree depth (undefined = all metadata levels). */
  navMaxDepth?: number;
  /** Whether the nav sidebar is collapsed (mobile-friendly). */
  navCollapsed?: boolean;
  /** Called when the user toggles the sidebar. */
  onToggleNav?: () => void;
  /** Word index to start at (resume position). Defaults to 0. */
  initialIndex?: number;
  /** Called whenever the current word index changes (tick or seek). */
  onPositionChange?: (index: number) => void;
  /** Called when the playback state changes (play/pause). */
  onRunningChange?: (running: boolean) => void;
  /** Called when a reader interaction is submitted to the owning format. */
  onInteractionSubmit?: (response: InteractionResponse) => Promise<void>;
  /** IDs already completed for this book/session. */
  initialCompletedInteractionIds?: string[];
  /** Called after an interaction response is accepted. */
  onInteractionResolved?: (interactionId: string) => void;
}

const DEFAULT_CONFIG: DisplayConfig = {
  wpm: 600,
};

/** Size of the stable text chunk rendered around the current word in RSVP mode. */
const CHUNK_SIZE = 400;
/** When the current word gets within this distance of a chunk edge, re-chunk in RSVP mode. */
const CHUNK_REFRESH_MARGIN = 100;

/** Initial number of words to render around current position in traditional infinite-scroll mode. */
const TRADITIONAL_BATCH_SIZE = 400;
/** Distance from top/bottom scroll boundary (in px) before loading more words. */
const TRADITIONAL_SCROLL_THRESHOLD = 300;

export function SpeedReader({ stream, pacing, config, fontFamily = "system-ui", fontSize = 28, theme = "light", showNav = true, navMaxDepth, navCollapsed, onToggleNav, initialIndex = 0, onPositionChange, onRunningChange }: SpeedReaderProps) {
  const cfg: DisplayConfig = { ...DEFAULT_CONFIG, ...config };
  const themeStyle = themeTokens(theme);

  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [viewMode, setViewMode] = useState<ReaderViewMode>("rsvp");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [chunkStart, setChunkStart] = useState(0);
  const [traditionalRange, setTraditionalRange] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [controlsOpen, setControlsOpen] = useState(true);
  const [wordMenu, setWordMenu] = useState<WordContextMenuState | null>(null);
  const [jumpDialogOpen, setJumpDialogOpen] = useState(false);
  const [jumpInputVal, setJumpInputVal] = useState("");
  const [pendingInteraction, setPendingInteraction] = useState<ReaderInteraction | null>(null);
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const isMobile = useMediaQuery("(max-width: 640px)");
  const clockRef = useRef<SelfCorrectingClock | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const traditionalContainerRef = useRef<HTMLDivElement | null>(null);
  const traditionalCurrentWordRef = useRef<HTMLSpanElement | null>(null);
  const currentWordRef = useRef<HTMLSpanElement | null>(null);
  // A pending bounded scroll adjustment from the gesture that entered native reading.
  const traditionalEntryNudgeRef = useRef<number | null>(null);
  const resolvedInteractionIdsRef = useRef(new Set(initialCompletedInteractionIds ?? []));
  const resumeAfterInteractionRef = useRef(false);
  const onInteractionSubmitRef = useRef(onInteractionSubmit);
  const onInteractionResolvedRef = useRef(onInteractionResolved);
  onInteractionSubmitRef.current = onInteractionSubmit;
  onInteractionResolvedRef.current = onInteractionResolved;

  // Sync running state to parent coordinator
  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);

  // Long-press detection on words in traditional view
  const wordLongPressRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    wordIndex: number | null;
    wordText: string;
    startX: number;
    startY: number;
    triggered: boolean;
  }>({
    timer: null,
    wordIndex: null,
    wordText: "",
    startX: 0,
    startY: 0,
    triggered: false,
  });

  // Swipe gesture tracking (smooth accelerated scrub).
  // Separate swipe preview and visual drag from layout centering.
  const swipeRef = useRef<{
    active: boolean;
    locked: boolean;
    startX: number;
    startY: number;
    startIndex: number;
    lastX: number;
    lastT: number;
    velocity: number;
    pointerId: number | null;
  }>({
    active: false,
    locked: false,
    startX: 0,
    startY: 0,
    startIndex: 0,
    lastX: 0,
    lastT: 0,
    velocity: 0,
    pointerId: null,
  });

  const swipedRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const pendingIndexRef = useRef<number | null>(null);

  // Visual drag offset: subtle resistance tilt, capped so text never flies off screen.
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Keep the latest config in a ref so the clock's onTick always reads the
  // current context window (avoids a stale closure when settings change).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // The stable chunk of words rendered around the current position in RSVP mode. Only
  // re-chunks when the current word nears the chunk edge — between refreshes
  // the text is static, so nothing reflows or shifts while reading.
  const chunkWords = useMemo(() => {
    const start = Math.max(0, Math.min(chunkStart, stream.words.length - 1));
    const end = Math.min(stream.words.length, start + CHUNK_SIZE);
    return stream.words.slice(start, end);
  }, [stream, chunkStart]);

  // Words slice for the traditional view (supports infinite scrolling in both directions).
  const traditionalWords = useMemo(() => {
    const start = Math.max(0, Math.min(traditionalRange.start, stream.words.length - 1));
    const end = Math.min(stream.words.length, Math.max(start, traditionalRange.end));
    return stream.words.slice(start, end);
  }, [stream, traditionalRange]);

  // Initialize or center traditional range when entering traditional mode or when frame index jumps
  useEffect(() => {
    if (viewMode === "traditional") {
      const cur = frame?.index ?? initialIndex;
      const start = Math.max(0, cur - Math.floor(TRADITIONAL_BATCH_SIZE / 2));
      const end = Math.min(stream.words.length, start + TRADITIONAL_BATCH_SIZE);
      setTraditionalRange({ start, end });
    }
  }, [viewMode, stream.words.length]);

  // Re-chunk when the current word drifts near the chunk's edge.
  useEffect(() => {
    if (!frame) return;
    const rel = frame.index - chunkStart;
    if (rel < CHUNK_REFRESH_MARGIN || rel > CHUNK_SIZE - CHUNK_REFRESH_MARGIN) {
      const nextStart = Math.max(0, frame.index - Math.floor(CHUNK_SIZE / 2));
      setChunkStart(nextStart);
    }
  }, [frame, chunkStart]);

  // Precompute durations once for the stream.
  const durations = useMemo(() => {
    const stats = { totalWords: stream.meta.totalWords, avgWordLength: stream.meta.avgWordLength };
    return pacing.durations(stream.words, stats);
  }, [stream, pacing]);

  // A boundary is a count of consumed words. Only unresolved interactions gate playback.
  const interactionAtBoundary = (boundary: number): ReaderInteraction | null =>
    (stream.interactions ?? []).find(
      (interaction) =>
        interaction.boundary === boundary && !resolvedInteractionIdsRef.current.has(interaction.id)
    ) ?? null;

  // Create the clock. Recreated when durations change (e.g. WPM/settings),
  // but preserves the current position so changing speed does not reset the book.
  useEffect(() => {
    const prevIndex = clockRef.current?.index ?? initialIndex;
    const wasRunning = clockRef.current?.running ?? false;
    const clock = new SelfCorrectingClock({
      durations,
      canStart: (index) => interactionAtBoundary(index) === null,
      canAdvance: (_fromIndex, nextIndex) => {
        const allowed = interactionAtBoundary(nextIndex) === null;
        if (!allowed) resumeAfterInteractionRef.current = true;
        return allowed;
      },
      onBlocked: (boundaryIndex) => {
        const interaction = interactionAtBoundary(boundaryIndex);
        if (!interaction) return;
        setPendingInteraction(interaction);
        setInteractionError(null);
        setInteractionBusy(false);
        setRunning(false);
      },
      onTick: (index) => {
        setFrame(buildFrame(stream.words, index, cfgRef.current));
        const effectiveTotal = stream.meta.totalWordsExpected || stream.words.length;
        setProgress(effectiveTotal ? Math.min(1, index / effectiveTotal) : 0);
        onPositionChange?.(index);
      },
      onEnd: () => {
        // If stream is still streaming in the background, remain running waiting for more chunks.
        if (stream.meta.isComplete !== false) {
          setRunning(false);
        }
      },
    });
    clockRef.current = clock;
    clock.seek(prevIndex);
    setFrame(buildFrame(stream.words, prevIndex, cfgRef.current));
    const effectiveTotal = stream.meta.totalWordsExpected || stream.words.length;
    setProgress(effectiveTotal ? Math.min(1, prevIndex / effectiveTotal) : 0);
    if (wasRunning) {
      resumeAfterInteractionRef.current = true;
      clock.start(prevIndex);
      setRunning(clock.running);
    }
    return () => clock.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durations, stream]);

  // Pin the current word to the exact center of the viewport (both axes) by
  // translating the whole text block. Unlike scrolling, this guarantees the
  // word is at a FIXED point — the eye never has to move (true speedreader).
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // useLayoutEffect (not useEffect): it runs synchronously BEFORE paint, so the
  // corrected offset is applied in the SAME frame as the new word's highlight.
  // With useEffect, the browser would paint the highlight at the old position
  // first (the "shadow" flash) before the text moved to center it.
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    const word = currentWordRef.current;
    if (!viewport || !word) return;
    const vr = viewport.getBoundingClientRect();
    const wr = word.getBoundingClientRect();
    // Where the word's center currently is vs. where we want it (viewport center).
    const dx = vr.left + vr.width / 2 - (wr.left + wr.width / 2);
    const dy = vr.top + vr.height / 2 - (wr.top + wr.height / 2);
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  }, [frame]);

  const toggle = () => {
    // If we're in traditional mode, playing immediately returns to RSVP mode.
    if (viewMode === "traditional") {
      setViewMode("rsvp");
    }
    const clock = clockRef.current!;
    if (clock.running) {
      resumeAfterInteractionRef.current = false;
      clock.pause();
      setRunning(false);
    } else {
      resumeAfterInteractionRef.current = true;
      clock.resume();
      setRunning(clock.running);
    }
  };

  const seek = (delta: number) => {
    const clock = clockRef.current!;
    const next = Math.max(0, Math.min(clock.index + delta, stream.words.length - 1));
    jumpTo(next);
  };

  /** Update visible frame and chunk without stopping clock or persisting every frame. */
  const previewIndex = (index: number) => {
    const clamped = Math.max(0, Math.min(index, stream.words.length - 1));
    const f = buildFrame(stream.words, clamped, cfg);
    const start = Math.max(0, clamped - Math.floor(CHUNK_SIZE / 2));
    setChunkStart(start);
    setFrame(f);
    setProgress(stream.words.length ? clamped / stream.words.length : 0);
  };

  /** Jump to an absolute index: update frame, chunk, clock, and notify coordinator. */
  const jumpTo = (index: number) => {
    const clock = clockRef.current!;
    if (!clock) return;
    const clamped = Math.max(0, Math.min(index, stream.words.length - 1));
    clock.seek(clamped);
    previewIndex(clamped);
    onPositionChange?.(clamped);
  };

  const seekTo = (index: number) => {
    jumpTo(index);
  };

  // The first vertical gesture centers the current word in traditional mode,
  // then applies only a small directional nudge. Once there, subsequent
  // gestures use ordinary native vertical scrolling.
  useLayoutEffect(() => {
    if (viewMode !== "traditional" || traditionalEntryNudgeRef.current === null) return;
    const word = traditionalCurrentWordRef.current;
    const container = traditionalContainerRef.current;
    if (!word || !container) return;

    word.scrollIntoView({ block: "center", behavior: "auto" });
    const nudge = traditionalEntryNudgeRef.current;
    requestAnimationFrame(() => {
      container.scrollBy({ top: nudge, behavior: "smooth" });
      traditionalEntryNudgeRef.current = null;
    });
  }, [viewMode, traditionalRange]);

  // Handle infinite scroll in traditional view
  const onTraditionalScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const { scrollTop, scrollHeight, clientHeight } = el;

    // Load more subsequent words when scrolling near the bottom
    if (scrollHeight - (scrollTop + clientHeight) < TRADITIONAL_SCROLL_THRESHOLD) {
      setTraditionalRange((prev) => {
        if (prev.end >= stream.words.length) return prev;
        const nextEnd = Math.min(stream.words.length, prev.end + TRADITIONAL_BATCH_SIZE);
        return { ...prev, end: nextEnd };
      });
    }

    // Load more previous words when scrolling near the top
    if (scrollTop < TRADITIONAL_SCROLL_THRESHOLD) {
      setTraditionalRange((prev) => {
        if (prev.start <= 0) return prev;
        const nextStart = Math.max(0, prev.start - TRADITIONAL_BATCH_SIZE);
        if (nextStart === prev.start) return prev;

        // Preserve scroll position when prepending words above
        const previousScrollHeight = el.scrollHeight;
        requestAnimationFrame(() => {
          const addedHeight = el.scrollHeight - previousScrollHeight;
          if (addedHeight > 0) {
            el.scrollTop += addedHeight;
          }
        });

        return { ...prev, start: nextStart };
      });
    }
  };

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  // --- RSVP swipe scrubber and entry gesture ---
  // - Horizontal swipes scrub only in RSVP mode.
  // - The first paused vertical swipe enters traditional reading near the
  //   current word; traditional mode then uses the browser's native scrolling.
  const SWIPE_ACTIVATION_PX = 10;
  const VERTICAL_MODE_SWIPE_PX = 36;
  const PX_PER_WORD = 16;
  const MAX_VISUAL_DRAG_PX = 48; // Subtle resistance, prevents moving text off screen

  const onSwipeStart = (e: React.PointerEvent) => {
    // Only handle primary button / touches
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const clock = clockRef.current;
    const currentIndex = clock ? clock.index : (frame?.index ?? initialIndex);

    swipeRef.current = {
      active: true,
      locked: false,
      startX: e.clientX,
      startY: e.clientY,
      startIndex: currentIndex,
      lastX: e.clientX,
      lastT: performance.now(),
      velocity: 0,
      pointerId: e.pointerId,
    };
  };

  const onSwipeMove = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    if (!s.active) return;

    const dx = e.clientX - s.startX;
    const dy = e.clientY - s.startY;

    // Gesture direction lock
    if (!s.locked) {
      if (Math.abs(dx) < SWIPE_ACTIVATION_PX && Math.abs(dy) < SWIPE_ACTIVATION_PX) {
        return;
      }
      // Check for horizontal swipe
      if (Math.abs(dx) >= Math.abs(dy) * 1.2) {
        // Horizontal swipe locked
        s.locked = true;
        swipedRef.current = true;
        setDragging(true);
        // Pause normal reading clock during swipe
        if (clockRef.current?.running) {
          clockRef.current.pause();
          setRunning(false);
        }
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          // ignore if capture unsupported
        }
      } else if (Math.abs(dy) >= Math.abs(dx) * 1.2 && !running) {
        // Vertical swipe detected while paused -> enter traditional e-reader mode near the current word
        if (Math.abs(dy) >= VERTICAL_MODE_SWIPE_PX) {
          s.active = false;
          swipedRef.current = true;
          traditionalEntryNudgeRef.current = traditionalEntryScrollNudge(dy);
          setViewMode("traditional");
        }
        return;
      } else {
        // Active playback or uncommitted diagonal -> cancel swipe tracking
        s.active = false;
        return;
      }
    }

    // Velocity estimation with exponential smoothing
    const now = performance.now();
    const dt = Math.max(1, now - s.lastT);
    const instVelocity = ((e.clientX - s.lastX) / dt) * 1000;
    s.velocity = 0.7 * s.velocity + 0.3 * instVelocity;
    s.lastX = e.clientX;
    s.lastT = now;

    // Subtle elastic visual pull (bounded so words remain readable and on-screen)
    const sign = dx < 0 ? -1 : 1;
    const boundedDrag = sign * Math.min(MAX_VISUAL_DRAG_PX, Math.log1p(Math.abs(dx)) * 8);
    setDragX(boundedDrag);

    // Target word calculation: swipe left (dx < 0) moves forward, swipe right moves backward
    const wordDelta = -dx / PX_PER_WORD;
    const target = Math.round(s.startIndex + wordDelta);
    const clamped = Math.max(0, Math.min(target, stream.words.length - 1));

    // Schedule RAF update for preview
    pendingIndexRef.current = clamped;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (pendingIndexRef.current !== null) {
          previewIndex(pendingIndexRef.current);
        }
      });
    }
  };

  const onSwipeEnd = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    if (!s.active) return;

    const wasLocked = s.locked;
    const finalPointerId = s.pointerId;

    s.active = false;
    s.locked = false;
    s.pointerId = null;
    setDragging(false);
    setDragX(0);

    if (finalPointerId !== null) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(finalPointerId);
      } catch {
        // ignore
      }
    }

    if (wasLocked) {
      swipedRef.current = true;
      // Add a controlled momentum flick at release
      const momentumWords = -s.velocity * 0.035;
      const finalTarget = (pendingIndexRef.current ?? s.startIndex) + Math.round(momentumWords);
      const clamped = Math.max(0, Math.min(finalTarget, stream.words.length - 1));
      jumpTo(clamped);
    }
  };

  const onSwipeCancel = (e: React.PointerEvent) => {
    const s = swipeRef.current;
    if (!s.active) return;
    s.active = false;
    s.locked = false;
    setDragging(false);
    setDragX(0);
    if (s.pointerId !== null) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(s.pointerId);
      } catch {
        // ignore
      }
    }
    if (pendingIndexRef.current !== null) {
      jumpTo(pendingIndexRef.current);
    }
  };

  // --- Long-Press Context Menu on Traditional View Words ---
  const WORD_LONG_PRESS_MS = 400;

  const clearWordLongPress = () => {
    const wlp = wordLongPressRef.current;
    if (wlp.timer) clearTimeout(wlp.timer);
    wlp.timer = null;
    wlp.wordIndex = null;
    wlp.wordText = "";
  };

  const handleWordPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const target = (e.target as HTMLElement).closest("[data-word-index]");
    if (!target) return;

    const idxStr = target.getAttribute("data-word-index");
    if (idxStr === null) return;
    const wordIndex = parseInt(idxStr, 10);
    const wordText = target.getAttribute("data-word-text") || (stream.words[wordIndex]?.text ?? "");

    clearWordLongPress();
    const wlp = wordLongPressRef.current;
    wlp.wordIndex = wordIndex;
    wlp.wordText = wordText;
    wlp.startX = e.clientX;
    wlp.startY = e.clientY;
    wlp.triggered = false;

    wlp.timer = setTimeout(() => {
      wlp.triggered = true;
      swipedRef.current = true; // suppress viewport click toggle
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate(25);
      }
      setWordMenu({
        x: e.clientX,
        y: e.clientY,
        wordIndex,
        wordText,
      });
      clearWordLongPress();
    }, WORD_LONG_PRESS_MS);
  };

  const handleWordPointerMove = (e: React.PointerEvent) => {
    const wlp = wordLongPressRef.current;
    if (wlp.timer && wlp.wordIndex !== null) {
      const dx = e.clientX - wlp.startX;
      const dy = e.clientY - wlp.startY;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        clearWordLongPress();
      }
    }
  };

  const handleWordPointerUp = () => {
    clearWordLongPress();
  };

  const handleWordPointerCancel = () => {
    clearWordLongPress();
  };

  const handleWordContextMenu = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("[data-word-index]");
    if (!target) return;
    const idxStr = target.getAttribute("data-word-index");
    if (idxStr === null) return;
    e.preventDefault();
    e.stopPropagation();
    const wordIndex = parseInt(idxStr, 10);
    const wordText = target.getAttribute("data-word-text") || (stream.words[wordIndex]?.text ?? "");
    setWordMenu({
      x: e.clientX,
      y: e.clientY,
      wordIndex,
      wordText,
    });
  };

  const onViewportClick = () => {
    // If a swipe or long-press was active or menu is open, do not toggle playback
    if (swipedRef.current || wordLongPressRef.current.triggered || wordMenu !== null) {
      swipedRef.current = false;
      wordLongPressRef.current.triggered = false;
      return;
    }
    toggle();
  };

  const handleOpenJump = () => {
    setJumpInputVal(String((frame?.index ?? clockRef.current?.index ?? 0) + 1));
    setJumpDialogOpen(true);
  };

  const handleJumpSubmit = (raw: string) => {
    setJumpDialogOpen(false);
    const cleaned = raw.trim();
    if (!cleaned) return;
    const num = parseInt(cleaned, 10);
    if (isNaN(num)) return;
    // 1-based word number to 0-based index:
    // If < 1, moves to first (0). If > length, moves to latest (length - 1).
    const targetIndex = Math.max(0, Math.min(num - 1, stream.words.length - 1));
    seekTo(targetIndex);
  };

  const handleInteractionSubmit = async (response: InteractionResponse) => {
    const current = pendingInteraction;
    if (!current || response.interactionId !== current.id || interactionBusy) return;
    setInteractionBusy(true);
    setInteractionError(null);
    try {
      await onInteractionSubmitRef.current?.(response);
      resolvedInteractionIdsRef.current.add(current.id);
      onInteractionResolvedRef.current?.(current.id);
      const next = interactionAtBoundary(current.boundary);
      if (next) {
        setPendingInteraction(next);
      } else {
        setPendingInteraction(null);
        if (resumeAfterInteractionRef.current) {
          const clock = clockRef.current;
          if (clock && !clock.running) {
            clock.resume();
            setRunning(clock.running);
          }
        }
      }
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setInteractionBusy(false);
    }
  };

  if (!frame) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: themeStyle.bg, color: themeStyle.fg, fontFamily, overflow: "hidden" }}>
      {/* Top area: Nav tree + Reading viewport */}
      <div style={{ flex: 1, display: "flex", minHeight: 0, overflow: "hidden" }}>
        {/* Navigation tree — left sidebar, collapsible: hidden while running */}
        {showNav && !running && (
          <div style={{ display: "flex", height: "100%", flexShrink: 0 }}>
            {!navCollapsed && (
              <NavTreeView
                stream={stream}
                currentIndex={frame.index}
                onSeek={seekTo}
                maxDepth={navMaxDepth}
                theme={theme}
              />
            )}
            {/* Collapse / Expand toggle rail */}
            <button
              onClick={onToggleNav}
              aria-label={navCollapsed ? "Expand navigation sidebar" : "Collapse navigation sidebar"}
              title={navCollapsed ? "Expand navigation" : "Collapse navigation"}
              style={{
                width: isMobile ? 36 : 28,
                height: isMobile ? 48 : 36,
                alignSelf: "flex-start",
                marginTop: 8,
                background: `${themeStyle.panel}99`,
                backdropFilter: "blur(8px)",
                WebkitBackdropFilter: "blur(8px)",
                border: `1px solid ${themeStyle.border}66`,
                borderLeft: "none",
                borderRadius: "0 8px 8px 0",
                color: themeStyle.fg,
                cursor: "pointer",
                fontSize: isMobile ? 18 : 15,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                boxShadow: "0 2px 8px rgba(0,0,0,0.08)",
                zIndex: 10,
              }}
            >
              {navCollapsed ? "▸" : "◂"}
            </button>
          </div>
        )}

        {/* Reader viewport column */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
          {viewMode === "traditional" ? (
            /* Traditional e-reader scrollable view with infinite scrolling, tap-to-resume, and long-press word context menu */
            <div
              ref={traditionalContainerRef}
              className="glass-scroll"
              onClick={onViewportClick}
              onScroll={(e) => {
                clearWordLongPress();
                onTraditionalScroll(e);
              }}
              onContextMenu={handleWordContextMenu}
              onPointerDown={handleWordPointerDown}
              onPointerMove={handleWordPointerMove}
              onPointerUp={handleWordPointerUp}
              onPointerCancel={handleWordPointerCancel}
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "36px 24px 60px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                background: themeStyle.bg,
                color: themeStyle.fg,
                boxSizing: "border-box",
                cursor: "pointer",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                touchAction: "pan-y",
                overscrollBehaviorX: "none",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  maxWidth: "68ch",
                  marginBottom: 20,
                  paddingBottom: 10,
                  borderBottom: `1px solid ${themeStyle.border}88`,
                }}
              >
                <span style={{ fontSize: 13, color: themeStyle.muted }}>
                  📖 Traditional View (Tap to play · Long-press word for options)
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setViewMode("rsvp");
                  }}
                  style={{
                    background: `${themeStyle.panel}ee`,
                    border: `1px solid ${themeStyle.border}`,
                    color: themeStyle.fg,
                    borderRadius: 8,
                    padding: "4px 12px",
                    fontSize: 12,
                    cursor: "pointer",
                    fontWeight: 600,
                  }}
                >
                  ⚡ Return to RSVP
                </button>
              </div>

              <div
                style={{
                  width: "100%",
                  maxWidth: "68ch",
                  fontSize,
                  lineHeight: 1.85,
                  wordBreak: "normal",
                  overflowWrap: "normal",
                }}
              >
                {traditionalRange.start > 0 && (
                  <div style={{ textAlign: "center", padding: "12px 0", color: themeStyle.muted, fontSize: 12 }}>
                    ··· Scrolling to earlier text ···
                  </div>
                )}
                {traditionalWords.map((w) =>
                  w.index === frame.index ? (
                    <span key={w.index}>
                      <span
                        ref={traditionalCurrentWordRef}
                        data-word-index={w.index}
                        data-word-text={w.text}
                        style={{
                          color: themeStyle.highlightFg,
                          background: themeStyle.highlight,
                          padding: "2px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                          display: "inline-block",
                        }}
                      >
                        {w.text}
                      </span>
                      {" "}
                    </span>
                  ) : (
                    <span key={w.index}>
                      <span
                        data-word-index={w.index}
                        data-word-text={w.text}
                        style={{
                          color: themeStyle.fg,
                          display: "inline-block",
                          borderRadius: 3,
                          padding: "0 1px",
                        }}
                      >
                        {w.text}
                      </span>
                      {" "}
                    </span>
                  )
                )}
                {traditionalRange.end < stream.words.length && (
                  <div style={{ textAlign: "center", padding: "12px 0", color: themeStyle.muted, fontSize: 12 }}>
                    ··· Scroll for more ···
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* RSVP centered reading viewport */
            <div
              ref={scrollRef}
              onClick={onViewportClick}
              onPointerDown={onSwipeStart}
              onPointerMove={onSwipeMove}
              onPointerUp={onSwipeEnd}
              onPointerCancel={onSwipeCancel}
              style={{
                flex: 1,
                overflow: "hidden",
                position: "relative",
                boxSizing: "border-box",
                cursor: "pointer",
                touchAction: "none", // let us handle horizontal swipes
              }}
            >
              {/* Drag wrapper: carries the swipe offset + settle transition.
                  Kept separate from the <p> so the centering transform below has
                  NO transition — otherwise the centering useLayoutEffect would
                  measure mid-animation and the word would never settle centered. */}
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  transform: `translateX(${dragX}px)`,
                  transition: dragging ? "none" : "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
                  pointerEvents: "none",
                }}
              >
                <p
                  style={{
                    fontSize,
                    lineHeight: 1.8,
                    margin: 0,
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    width: "70ch",
                    maxWidth: "80%",
                    transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                    overflowWrap: "normal",
                    wordBreak: "normal",
                  }}
                >
                  {chunkWords.map((w) =>
                    w.index === frame.index ? (
                      <span
                        key={w.index}
                        ref={currentWordRef}
                        style={{
                          color: themeStyle.highlightFg,
                          background: themeStyle.highlight,
                          padding: "2px 6px",
                          borderRadius: 4,
                        }}
                      >
                        {w.text}
                      </span>
                    ) : (
                      <span key={w.index} style={{ color: themeStyle.muted }}>{w.text} </span>
                    )
                  )}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom controls drawer — collapsible, and disappears completely when playing */}
      <div
        style={{
          borderTop: running ? "none" : `1px solid ${themeStyle.border}`,
          background: themeStyle.panel,
          flexShrink: 0,
          width: "100%",
          boxSizing: "border-box",
          maxHeight: running ? 0 : (controlsOpen ? 240 : 48),
          opacity: running ? 0 : 1,
          overflow: "hidden",
          transition: "all 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
          pointerEvents: running ? "none" : "auto",
        }}
      >
        {/* Minimize / expand toggle handle with prominent touch targets on mobile */}
        <button
          onClick={() => setControlsOpen((o) => !o)}
          aria-expanded={controlsOpen}
          aria-label={controlsOpen ? "Minimize bottom controls" : "Expand bottom controls"}
          title={controlsOpen ? "Minimize controls" : "Expand controls"}
          style={{
            width: "100%",
            padding: isMobile ? "8px 16px" : "5px 12px",
            minHeight: isMobile ? 38 : 28,
            background: "transparent",
            border: "none",
            color: themeStyle.muted,
            fontSize: isMobile ? 13 : 12,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
          }}
        >
          <span style={{ fontSize: isMobile ? 12 : 11, fontWeight: 600 }}>
            {controlsOpen ? "Hide Controls" : "Show Controls"}
          </span>
          <span style={{ fontSize: isMobile ? 14 : 11, fontWeight: 700 }}>{controlsOpen ? "▾" : "▴"}</span>
        </button>

        {controlsOpen && (
          <div style={{ padding: isMobile ? "0 16px 12px" : "6px 16px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
            {isMobile ? (
              <>
                {/* Mobile transport buttons */}
                <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "center" }}>
                  <button
                    onClick={() => seek(-1)}
                    aria-label="Previous word"
                    style={{ fontSize: 22, padding: "8px 16px", minWidth: 56 }}
                  >
                    ◀
                  </button>
                  <button
                    onClick={toggle}
                    aria-label={running ? "Pause" : "Play"}
                    style={{ fontSize: 22, padding: "8px 20px", minWidth: 72 }}
                  >
                    {running ? "⏸" : "▶"}
                  </button>
                  <button
                    onClick={() => seek(1)}
                    aria-label="Next word"
                    style={{ fontSize: 22, padding: "8px 16px", minWidth: 56 }}
                  >
                    ▶
                  </button>
                </div>
                {/* Full-width scrub bar */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                  <SeekBar
                    value={frame.index}
                    max={stream.words.length - 1}
                    onSeek={seekTo}
                    maxWidth="100%"
                    colors={{
                      track: themeStyle.border,
                      fill: themeStyle.highlight,
                      thumb: themeStyle.highlightFg,
                      thumbBorder: themeStyle.highlight,
                    }}
                  />
                </div>
                {/* Word count percentage placed AFTER scrubber, clickable to jump */}
                <div style={{ textAlign: "center" }}>
                  <button
                    onClick={handleOpenJump}
                    title="Click to jump to word number"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: themeStyle.muted,
                      fontSize: 12,
                      cursor: "pointer",
                      padding: "2px 8px",
                      borderRadius: 4,
                      textDecoration: "underline",
                      textDecorationStyle: "dotted",
                    }}
                  >
                    word {frame.index + 1} / {stream.words.length} ({Math.round(progress * 100)}%)
                  </button>
                </div>
              </>
            ) : (
              /* Desktop layout: transport buttons, full scrubber, then word count percentage AFTER scrubber */
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  alignItems: "center",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              >
                <button onClick={toggle} style={{ minWidth: 70 }}>{running ? "Pause" : "Play"}</button>
                <button onClick={() => seek(-1)}>◀</button>
                <button onClick={() => seek(1)}>▶</button>
                <SeekBar
                  value={frame.index}
                  max={stream.words.length - 1}
                  onSeek={seekTo}
                  maxWidth="100%"
                  colors={{
                    track: themeStyle.border,
                    fill: themeStyle.highlight,
                    thumb: themeStyle.highlightFg,
                    thumbBorder: themeStyle.highlight,
                  }}
                />
                {/* Word count percentage placed AFTER scrubber, clickable to jump */}
                <button
                  onClick={handleOpenJump}
                  title="Click to jump to word number"
                  style={{
                    background: "transparent",
                    border: `1px solid transparent`,
                    color: themeStyle.muted,
                    fontSize: 13,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    padding: "4px 8px",
                    borderRadius: 6,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.border = `1px solid ${themeStyle.border}`;
                    e.currentTarget.style.color = themeStyle.fg;
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.border = "1px solid transparent";
                    e.currentTarget.style.color = themeStyle.muted;
                  }}
                >
                  <span>word {frame.index + 1} / {stream.words.length} ({Math.round(progress * 100)}%)</span>
                  <span style={{ fontSize: 10 }}>✎</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Jump to Word Number Modal / Input Dialog */}
      {jumpDialogOpen && (
        <div
          onClick={() => setJumpDialogOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 2000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.45)",
            backdropFilter: "blur(6px)",
            WebkitBackdropFilter: "blur(6px)",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: isMobile ? "min(90vw, 320px)" : "360px",
              borderRadius: 16,
              border: `1px solid ${themeStyle.border}`,
              background: `${themeStyle.panel}f2`,
              backdropFilter: "blur(20px)",
              WebkitBackdropFilter: "blur(20px)",
              padding: 20,
              color: themeStyle.fg,
              boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
              fontFamily,
            }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 16 }}>Jump to Word</h3>
            <p style={{ margin: "0 0 16px", color: themeStyle.muted, fontSize: 13 }}>
              Enter a word number between 1 and {stream.words.length.toLocaleString()}:
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleJumpSubmit(jumpInputVal);
              }}
            >
              <input
                type="number"
                min={1}
                max={stream.words.length}
                autoFocus
                inputMode="numeric"
                pattern="[0-9]*"
                value={jumpInputVal}
                onChange={(e) => setJumpInputVal(e.target.value)}
                placeholder={`1 - ${stream.words.length}`}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${themeStyle.border}`,
                  background: themeStyle.bg,
                  color: themeStyle.fg,
                  fontSize: 16,
                  outline: "none",
                  marginBottom: 16,
                }}
              />
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={() => setJumpDialogOpen(false)}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: `1px solid ${themeStyle.border}`,
                    background: themeStyle.panel,
                    color: themeStyle.fg,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={{
                    padding: "8px 16px",
                    borderRadius: 8,
                    border: "none",
                    background: themeStyle.highlight,
                    color: themeStyle.highlightFg,
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  Jump
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <InteractionOverlay
        interaction={pendingInteraction}
        theme={theme}
        busy={interactionBusy}
        error={interactionError}
        onSubmit={handleInteractionSubmit}
      />

      {/* Traditional view word context menu */}
      <WordContextMenu
        state={wordMenu}
        onClose={() => setWordMenu(null)}
        onSetPosition={(idx) => {
          jumpTo(idx);
        }}
        onResumeFromHere={(idx) => {
          jumpTo(idx);
          setViewMode("rsvp");
          const clock = clockRef.current;
          if (clock && !clock.running) {
            resumeAfterInteractionRef.current = true;
            clock.resume();
            setRunning(clock.running);
          }
        }}
        theme={theme}
      />
    </div>
  );
}

// Seekable progress bar: click or drag anywhere on the track to scrub
// through the word stream. The scrubber drag pauses playback (the Clock
// stops on seek) so the user can fine-tune a position before resuming.
function SeekBar({
  value,
  max,
  onSeek,
  maxWidth = 320,
  colors,
}: {
  value: number;
  max: number;
  onSeek: (index: number) => void;
  maxWidth?: string | number;
  colors: { track: string; fill: string; thumb: string; thumbBorder: string };
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const pct = max > 0 ? (value / max) * 100 : 0;

  // Convert a pointer x to a word index within the track.
  const indexFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const rel = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return Math.round(rel * max);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    // Capture so moves/up outside the bar still track.
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    onSeek(indexFromClientX(e.clientX));
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    onSeek(indexFromClientX(e.clientX));
  };
  const endDrag = () => {
    draggingRef.current = false;
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label="Progress"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          onSeek(Math.max(0, value - 1));
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          onSeek(Math.min(max, value + 1));
        } else if (e.key === "Home") {
          e.preventDefault();
          onSeek(0);
        } else if (e.key === "End") {
          e.preventDefault();
          onSeek(max);
        }
      }}
      style={{
        flex: 1,
        maxWidth,
        height: 16,
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        touchAction: "none", // vertical pan shouldn't scroll page
        outline: "none",
      }}
    >
      {/* Track */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: 6,
          borderRadius: 3,
          background: colors.track,
        }}
      >
        {/* Fill */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${pct}%`,
            borderRadius: 3,
            background: colors.fill,
          }}
        />
        {/* Thumb */}
        <div
          style={{
            position: "absolute",
            top: "50%",
            left: `${pct}%`,
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: colors.thumb,
            border: `2px solid ${colors.thumbBorder}`,
            transform: "translate(-50%, -50%)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          }}
        />
      </div>
    </div>
  );
}
