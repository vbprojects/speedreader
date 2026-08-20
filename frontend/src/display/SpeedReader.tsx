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
import type { PacingEngine } from "../pacing/engine";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";
import { NavTreeView } from "../navigation";
import { SelfCorrectingClock } from "./clock";
import { buildFrame } from "./renderer";
import type { DisplayConfig, DisplayFrame } from "./types";

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
}

const DEFAULT_CONFIG: DisplayConfig = {
  wpm: 600,
};

/** Size of the stable text chunk rendered around the current word. */
const CHUNK_SIZE = 400;
/** When the current word gets within this distance of a chunk edge, re-chunk. */
const CHUNK_REFRESH_MARGIN = 100;

export function SpeedReader({ stream, pacing, config, fontFamily = "system-ui", fontSize = 28, theme = "light", showNav = true, navMaxDepth, navCollapsed, onToggleNav }: SpeedReaderProps) {
  const cfg: DisplayConfig = { ...DEFAULT_CONFIG, ...config };
  const themeStyle = themeTokens(theme);

  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [chunkStart, setChunkStart] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");
  const clockRef = useRef<SelfCorrectingClock | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const currentWordRef = useRef<HTMLSpanElement | null>(null);
  // Swipe gesture tracking (horizontal seek).
  const swipeStartRef = useRef<{
    x: number;
    y: number;
    t: number;
    index: number;
    lastX: number;
    lastT: number;
  } | null>(null);
  // Set true when a swipe consumed the gesture, so the following click
  // (which fires after pointerup) doesn't also toggle play/pause.
  const swipedRef = useRef(false);
  // Horizontal drag offset applied while swiping so the text follows the
  // finger; animates back to 0 on release for a smooth settle.
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Keep the latest config in a ref so the clock's onTick always reads the
  // current context window (avoids a stale closure when settings change).
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // The stable chunk of words rendered around the current position. Only
  // re-chunks when the current word nears the chunk edge — between refreshes
  // the text is static, so nothing reflows or shifts while reading.
  const chunkWords = useMemo(() => {
    const start = Math.max(0, Math.min(chunkStart, stream.words.length - 1));
    const end = Math.min(stream.words.length, start + CHUNK_SIZE);
    return stream.words.slice(start, end);
  }, [stream, chunkStart]);

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

  // Create the clock once.
  useEffect(() => {
    const clock = new SelfCorrectingClock({
      durations,
      onTick: (index) => {
        setFrame(buildFrame(stream.words, index, cfgRef.current));
        setProgress(stream.words.length ? index / stream.words.length : 0);
      },
      onEnd: () => setRunning(false),
    });
    clockRef.current = clock;
    // Show the first word immediately.
    setFrame(buildFrame(stream.words, 0, cfgRef.current));
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
    const clock = clockRef.current!;
    if (clock.running) {
      clock.pause();
      setRunning(false);
    } else {
      clock.resume();
      setRunning(true);
    }
  };

  const seek = (delta: number) => {
    const clock = clockRef.current!;
    const next = Math.max(0, Math.min(clock.index + delta, stream.words.length - 1));
    jumpTo(next);
  };

  /** Jump to an absolute index: update frame AND chunk in one render so the
      current word is always in the visible chunk (no flash / empty center). */
  const jumpTo = (index: number) => {
    const clock = clockRef.current!;
    if (!clock) return;
    clock.seek(index);
    const f = buildFrame(stream.words, index, cfg);
    const start = Math.max(0, index - Math.floor(CHUNK_SIZE / 2));
    setChunkStart(start);
    setFrame(f);
    setProgress(stream.words.length ? index / stream.words.length : 0);
  };

  const seekTo = (index: number) => {
    jumpTo(Math.max(0, Math.min(index, stream.words.length - 1)));
  };

  // Swipe left/right to scrub. While dragging, the current word changes live
// (like scrubbing); the number of words moved per pixel scales with the
// drag velocity so a fast flick jumps further than a slow drag.
const SWIPE_THRESHOLD = 40; // px of horizontal travel to trigger a seek
const PX_PER_WORD = 24; // slow-drag: ~1 word per 24px
const VELOCITY_BOOST = 0.06; // extra words per px/s of velocity

const onSwipeStart = (e: React.PointerEvent) => {
  const clock = clockRef.current;
  swipeStartRef.current = {
    x: e.clientX,
    y: e.clientY,
    t: Date.now(),
    index: clock ? clock.index : 0,
    lastX: e.clientX,
    lastT: Date.now(),
  };
  setDragging(true);
};
const onSwipeMove = (e: React.PointerEvent) => {
  const start = swipeStartRef.current;
  if (!start) return;
  const now = Date.now();
  const dx = e.clientX - start.x;
  // Text follows the finger horizontally.
  setDragX(dx);

  // Instantaneous velocity (px/s) from the last move event.
  const dt = Math.max(1, now - start.lastT);
  const velocity = ((e.clientX - start.lastX) / dt) * 1000;
  start.lastX = e.clientX;
  start.lastT = now;

  // Words to move: distance-based + velocity boost. Negative dx (swipe
  // left) → forward.
  const words = -dx / PX_PER_WORD - velocity * VELOCITY_BOOST;
  const target = Math.round(start.index + words);
  const clamped = Math.max(0, Math.min(target, stream.words.length - 1));
  if (clamped !== (clockRef.current?.index ?? -1)) {
    jumpTo(clamped);
  }
};
const onSwipeEnd = (e: React.PointerEvent) => {
  const start = swipeStartRef.current;
  swipeStartRef.current = null;
  setDragging(false);
  setDragX(0);
  if (!start) return;
  const dx = e.clientX - start.x;
  const dy = e.clientY - start.y;
  // A real swipe (dominant horizontal travel) suppresses the trailing click.
  if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) >= Math.abs(dy) * 1.5) {
    swipedRef.current = true;
  }
};

  const onViewportClick = () => {
    // If a swipe just happened, ignore the trailing click.
    if (swipedRef.current) {
      swipedRef.current = false;
      return;
    }
    toggle();
  };

  if (!frame) return null;

  return (
    <div style={{ display: "flex", height: "100%", background: themeStyle.bg, color: themeStyle.fg, fontFamily, overflow: "hidden" }}>
      {/* Navigation tree — left sidebar, collapsible */}
      {showNav && (
        <div style={{ display: "flex", height: "100%" }}>
          {!navCollapsed && (
            <NavTreeView
              stream={stream}
              currentIndex={frame.index}
              onSeek={seekTo}
              maxDepth={navMaxDepth}
              theme={theme}
            />
          )}
          {/* Collapse toggle rail */}
          <button
            onClick={onToggleNav}
            title={navCollapsed ? "Expand navigation" : "Collapse navigation"}
            style={{
              width: 22,
              alignSelf: "flex-start",
              marginTop: 8,
              background: "transparent",
              border: "none",
              color: themeStyle.muted,
              cursor: "pointer",
              fontSize: 14,
              padding: "4px 0",
            }}
          >
            {navCollapsed ? "▸" : "◂"}
          </button>
        </div>
      )}

      {/* Reader column: pinned text block + controls */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* The reading viewport. The paragraph is TRANSLATED so the current
            word sits at the exact center of this viewport — a fixed focal
            point, so the reader's eye never moves. Context flows around it.
            Clicking anywhere toggles play/pause. */}
        <div
          ref={scrollRef}
          onClick={onViewportClick}
          onPointerDown={onSwipeStart}
          onPointerMove={onSwipeMove}
          onPointerUp={onSwipeEnd}
          onPointerCancel={() => {
            swipeStartRef.current = null;
            setDragging(false);
            setDragX(0);
          }}
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
              transition: dragging ? "none" : "transform 0.25s ease-out",
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

        {/* Controls — inline row on desktop, collapsible bottom drawer on mobile */}
        {isMobile ? (
          <div
            style={{
              borderTop: `1px solid ${themeStyle.border}`,
              background: themeStyle.panel,
            }}
          >
            {/* Drawer handle / toggle */}
            <button
              onClick={() => setDrawerOpen((o) => !o)}
              aria-expanded={drawerOpen}
              style={{
                width: "100%",
                padding: "8px 0",
                background: "transparent",
                border: "none",
                color: themeStyle.muted,
                fontSize: 13,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <span>{running ? "Pause" : "Play"}</span>
              <span style={{ fontSize: 10 }}>{drawerOpen ? "▾" : "▴"}</span>
            </button>
            {drawerOpen && (
              <div style={{ padding: "0 16px 12px", display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Transport buttons */}
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
                <SeekBar
                  value={frame.index}
                  max={stream.words.length - 1}
                  onSeek={seekTo}
                  colors={{
                    track: themeStyle.border,
                    fill: themeStyle.highlight,
                    thumb: themeStyle.highlightFg,
                    thumbBorder: themeStyle.highlight,
                  }}
                />
                <div style={{ color: themeStyle.muted, fontSize: 12, textAlign: "center" }}>
                  word {frame.index + 1} / {stream.words.length} ({Math.round(progress * 100)}%)
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            style={{
              padding: "10px 16px",
              borderTop: `1px solid ${themeStyle.border}`,
              display: "flex",
              gap: 12,
              alignItems: "center",
            }}
          >
            <button onClick={toggle}>{running ? "Pause" : "Play"}</button>
            <button onClick={() => seek(-1)}>◀</button>
            <button onClick={() => seek(1)}>▶</button>
            <span style={{ color: themeStyle.muted, fontSize: 13 }}>
              word {frame.index + 1} / {stream.words.length} ({Math.round(progress * 100)}%)
            </span>
            <SeekBar
              value={frame.index}
              max={stream.words.length - 1}
              onSeek={seekTo}
              colors={{
                track: themeStyle.border,
                fill: themeStyle.highlight,
                thumb: themeStyle.highlightFg,
                thumbBorder: themeStyle.highlight,
              }}
            />
          </div>
        )}
      </div>
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
  colors,
}: {
  value: number;
  max: number;
  onSeek: (index: number) => void;
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
        maxWidth: 320,
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
