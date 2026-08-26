// src/ReaderApp.tsx
// Root coordinator: owns the LibraryStore (IndexedDB-backed), the global
// SettingsStore, and the current reader session. Handles import, open
// (cached rehydrate), reader-state persistence (debounced + flushed), and
// removal. Renders either the LibraryView or the ReaderScreen.

import { useCallback, useEffect, useRef, useState } from "react";
import { createDb } from "./db";
import type { Book } from "./db";
import { BlueskyJetstreamFormat, IngestionEngine, EpubParser, PdfJsParser, pickFileBrowser } from "./ingestion";
import { LibraryStore } from "./library";
import { LibraryView } from "./library/LibraryView";
import { ReaderScreen } from "./reader";
import { SettingsStore, mergeSettings } from "./settings";
import type { GlobalSettings, ReaderSettings } from "./settings";
import type { InteractionRecord } from "./interactions/types";

export default function ReaderApp() {
  // ---- Stores (created once) ----
  const [settingsStore] = useState(() => new SettingsStore());
  const [library] = useState(() => new LibraryStore(
    createDb("indexeddb"),
    new IngestionEngine(
      [new EpubParser(), new PdfJsParser()],
      [() => new BlueskyJetstreamFormat()],
    ),
  ));

  // ---- Global settings ----
  const [global, setGlobal] = useState<GlobalSettings>(() => settingsStore.global);
  useEffect(() => settingsStore.subscribe(() => setGlobal(settingsStore.global)), [settingsStore]);

  // ---- Library state ----
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});

  // ---- Reader session ----
  const [openBookId, setOpenBookId] = useState<string | null>(null);
  const [openStream, setOpenStream] = useState<import("./epub/types").WordStream | null>(null);
  const [readerSettings, setReaderSettings] = useState<GlobalSettings | null>(null);
  const [initialIndex, setInitialIndex] = useState(0);
  const [completedInteractionIds, setCompletedInteractionIds] = useState<string[]>([]);
  const [interactionRecords, setInteractionRecords] = useState<InteractionRecord[]>([]);

  // Debounced position persistence.
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPosition = useRef<number>(0);
  const latestSettings = useRef<ReaderSettings>({});
  const latestCompletedInteractionIds = useRef<string[]>([]);
  const latestInteractionRecords = useRef<InteractionRecord[]>([]);
  // Serialize IndexedDB writes so an older async transaction cannot finish
  // after and overwrite a newer reader position/settings snapshot.
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  const enqueueReaderState = useCallback(
    (
      bookId: string,
      position: number,
      settings: ReaderSettings,
      completedIds: string[] = latestCompletedInteractionIds.current
    ): Promise<void> => {
      const snapshot = {
        bookId,
        position,
        lastOpenedAt: Date.now(),
      settings: { ...settings },
      completedInteractionIds: [...completedIds],
      interactionRecords: [...latestInteractionRecords.current],
      };
      saveQueue.current = saveQueue.current
        .catch(() => undefined)
        .then(() => library.saveReaderState(snapshot));
      return saveQueue.current;
    },
    [library]
  );

  const refreshBooks = useCallback(async () => {
    try {
      const list = await library.getBooks();
      setBooks(list);
      // Load saved positions for progress display.
      const pos: Record<string, number> = {};
      for (const b of list) {
        const st = await library.getReaderState(b.id);
        if (st) pos[b.id] = st.position;
      }
      setPositions(pos);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [library]);

  // Load the library on mount.
  useEffect(() => {
    void (async () => {
      try {
        await library.ensureBuiltInBooks();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      await refreshBooks();
    })();
  }, [refreshBooks]);

  // ---- Import ----
  const handleImport = useCallback(async () => {
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const file = await pickFileBrowser(".epub,.pdf");
      if (!file) return;
      const result = await library.importFile(file);
      await refreshBooks();
      // Non-fatal parser warnings need an explicit user acknowledgement in the
      // library before opening. Simple imports continue straight to the reader.
      if (!result.existed && result.book.ingestionWarnings?.length) {
        setNotice(result.book.ingestionWarnings.join(" "));
      } else if (!result.existed) {
        await openBook(result.book.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [library, refreshBooks]);

  // ---- Open a book (cached rehydrate) ----
  const openBook = useCallback(
    async (bookId: string) => {
      setError(null);
      try {
        const opened = await library.openBook(bookId);
        if (!opened) {
          setError("Book stream not found. Please re-import it.");
          return;
        }
        // Hydrate reader state (position + per-book settings).
        const state = await library.getReaderState(bookId);
        const effective = mergeSettings(global, state?.settings);
        setReaderSettings(effective);
        setInitialIndex(state?.position ?? 0);
        latestPosition.current = state?.position ?? 0;
        latestSettings.current = state?.settings ?? {};
        const completed = state?.completedInteractionIds ?? [];
        latestCompletedInteractionIds.current = [...completed];
        setCompletedInteractionIds([...completed]);
        const records = state?.interactionRecords ?? [];
        latestInteractionRecords.current = [...records];
        setInteractionRecords([...records]);
        setOpenStream(opened.stream);
        setOpenBookId(bookId);
        // Update lastOpenedAt.
        await enqueueReaderState(bookId, state?.position ?? 0, state?.settings ?? {});
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [enqueueReaderState, library, global]
  );

  // A live format owns its connection only while its library book is open.
  useEffect(() => {
    if (!openBookId) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    void library.startStreamingBook(
      openBookId,
      (stream) => {
        if (!disposed) setOpenStream(stream);
      },
      (streamError) => {
        if (!disposed) setError(streamError.message);
      },
    ).then((cleanup) => {
      if (disposed) cleanup();
      else stop = cleanup;
    }).catch((streamError: unknown) => {
      if (!disposed) setError(streamError instanceof Error ? streamError.message : String(streamError));
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [library, openBookId]);

  // ---- Reader position change (debounced persist) ----
  const handlePositionChange = useCallback(
    (index: number) => {
      latestPosition.current = index;
      if (positionTimer.current) clearTimeout(positionTimer.current);
      const bookId = openBookId;
      if (!bookId) return;
      positionTimer.current = setTimeout(() => {
        positionTimer.current = null;
        void enqueueReaderState(bookId, latestPosition.current, latestSettings.current);
      }, 500);
    },
    [enqueueReaderState, openBookId]
  );

  // ---- Reader interaction completion ----
  const handleInteractionResolved = useCallback(
    (interactionId: string) => {
      const next = Array.from(new Set([...latestCompletedInteractionIds.current, interactionId]));
      latestCompletedInteractionIds.current = next;
      setCompletedInteractionIds(next);
      if (openBookId) {
        void enqueueReaderState(openBookId, latestPosition.current, latestSettings.current, next);
      }
    },
    [enqueueReaderState, openBookId]
  );

  const handleInteractionCommitted = useCallback(
    (record: InteractionRecord) => {
      const next = [...latestInteractionRecords.current.filter((item) => item.interactionId !== record.interactionId), record];
      latestInteractionRecords.current = next;
      setInteractionRecords(next);
      const completed = Array.from(new Set([...latestCompletedInteractionIds.current, record.interactionId]));
      latestCompletedInteractionIds.current = completed;
      setCompletedInteractionIds(completed);
      if (openBookId) void enqueueReaderState(openBookId, latestPosition.current, latestSettings.current);
    },
    [enqueueReaderState, openBookId]
  );

  // ---- Reader settings change ----
  const handleSettingsChange = useCallback(
    (patch: ReaderSettings) => {
      if (!openBookId) return;
      const next = { ...latestSettings.current, ...patch };
      latestSettings.current = next;
      setReaderSettings((prev) => (prev ? mergeSettings(prev, patch) : prev));
      void enqueueReaderState(openBookId, latestPosition.current, next);
    },
    [enqueueReaderState, openBookId]
  );

  const handleSettingsReset = useCallback(() => {
    if (!openBookId) return;
    latestSettings.current = {};
    setReaderSettings(global);
    void enqueueReaderState(openBookId, latestPosition.current, {});
  }, [enqueueReaderState, openBookId, global]);

  // ---- Flush latest state on exit / visibility change / pagehide ----
  const flushState = useCallback((): Promise<void> => {
    if (positionTimer.current) {
      clearTimeout(positionTimer.current);
      positionTimer.current = null;
    }
    if (!openBookId) return Promise.resolve();
    return enqueueReaderState(openBookId, latestPosition.current, latestSettings.current);
  }, [enqueueReaderState, openBookId]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushState();
    };
    const onPageHide = () => flushState();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flushState]);

  // ---- Back to library ----
  const handleBack = useCallback(async () => {
    await flushState();
    setOpenBookId(null);
    setOpenStream(null);
    setReaderSettings(null);
    await refreshBooks();
  }, [flushState, refreshBooks]);

  // ---- Remove a book ----
  const handleRemove = useCallback(
    async (bookId: string) => {
      setError(null);
      try {
        await library.removeBook(bookId);
        await refreshBooks();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [library, refreshBooks]
  );

  const handleRestart = useCallback(
    async (bookId: string) => {
      setError(null);
      try {
        await library.resetReaderState(bookId);
        const book = books.find((candidate) => candidate.id === bookId);
        setNotice(book?.format === "bluesky-jetstream"
          ? "Bluesky Jetstream history was cleared."
          : "Actions was restarted. Its interactive prompts are ready again.");
        await refreshBooks();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [books, library, refreshBooks]
  );

  // ---- Render ----
  if (openStream && openBookId && readerSettings) {
    return (
      <ReaderScreen
        stream={openStream}
        title={books.find((b) => b.id === openBookId)?.title ?? "Book"}
        settings={readerSettings}
        initialIndex={initialIndex}
        onBack={handleBack}
        onPositionChange={handlePositionChange}
        onSettingsChange={handleSettingsChange}
        onSettingsReset={handleSettingsReset}
        initialCompletedInteractionIds={completedInteractionIds}
        onInteractionResolved={handleInteractionResolved}
        initialInteractionRecords={interactionRecords}
        onInteractionCommitted={handleInteractionCommitted}
      />
    );
  }

  return (
    <LibraryView
      books={books}
      loading={loading}
      importing={importing}
      error={error}
      notice={notice}
      theme={global.theme}
      settings={global}
      onUpdateSettings={(patch) => settingsStore.updateGlobal(patch)}
      onImport={handleImport}
      onOpen={openBook}
      onRemove={handleRemove}
      onRestart={handleRestart}
      positions={positions}
    />
  );
}
