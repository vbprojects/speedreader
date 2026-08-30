// src/ReaderApp.tsx
// Root coordinator: owns the LibraryStore (IndexedDB-backed), the global
// SettingsStore, and the current reader session. Handles import, open
// (cached rehydrate), reader-state persistence (debounced + flushed), and
// removal. Renders either the LibraryView or the ReaderScreen.

import { useCallback, useEffect, useRef, useState } from "react";
import { createDb } from "./db";
import type { Book } from "./db";
import { BlueskyJetstreamFormat, EncryptedCredentialVault, IngestionEngine, EpubParser, OPENAI_COMPATIBLE_FORMAT, OpenAICompatibleFormat, PdfJsParser, pickFileBrowser } from "./ingestion";
import type { OpenAICompatibleConnection } from "./ingestion";
import { LibraryStore } from "./library";
import { LibraryView } from "./library/LibraryView";
import { LlmConnectionDialog } from "./library/LlmConnectionDialog";
import { ReaderScreen } from "./reader";
import { SettingsStore, mergeSettings } from "./settings";
import type { GlobalSettings, ReaderSettings } from "./settings";
import type { InteractionRecord } from "./interactions/types";
import type { ReaderEngineEvent } from "./engine-events/types";
import {
  ConstrainedForeignLibraryHost,
  ForeignImportCoordinator,
  ForeignLibraryError,
  ForeignLibraryRegistry,
  GutenbergForeignLibrary,
  type ForeignDownloadPlan,
  type ForeignImportPlan,
} from "./foreign-libraries";
import { ForeignLibraryDialog } from "./library/ForeignLibraryDialog";

export default function ReaderApp() {
  // ---- Stores (created once) ----
  const [settingsStore] = useState(() => new SettingsStore());
  const [credentialVault] = useState(() => new EncryptedCredentialVault());
  const [foreignRegistry] = useState(() => {
    const gatewayUrl = import.meta.env.VITE_FOREIGN_LIBRARY_GATEWAY_URL?.trim() || undefined;
    const registry = new ForeignLibraryRegistry(
      (manifest) => new ConstrainedForeignLibraryHost(manifest, globalThis.fetch, undefined, gatewayUrl),
    );
    registry.register(new GutenbergForeignLibrary());
    return registry;
  });
  const [foreignCoordinator] = useState(() => new ForeignImportCoordinator(foreignRegistry));
  const [library] = useState(() => new LibraryStore(
    createDb("indexeddb"),
    new IngestionEngine(
      [new EpubParser(), new PdfJsParser()],
      [
        () => new BlueskyJetstreamFormat(),
        () => new OpenAICompatibleFormat(),
      ],
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
  const [pendingLlmBookId, setPendingLlmBookId] = useState<string | null>(null);
  const [foreignLibraryOpen, setForeignLibraryOpen] = useState(false);

  // ---- Reader session ----
  const [openBookId, setOpenBookId] = useState<string | null>(null);
  const [openStream, setOpenStream] = useState<import("./epub/types").WordStream | null>(null);
  const [readerSettings, setReaderSettings] = useState<GlobalSettings | null>(null);
  const [initialIndex, setInitialIndex] = useState(0);
  const [completedInteractionIds, setCompletedInteractionIds] = useState<string[]>([]);
  const [interactionRecords, setInteractionRecords] = useState<InteractionRecord[]>([]);
  const [deliveredTriggerIds, setDeliveredTriggerIds] = useState<string[]>([]);

  // Debounced position persistence.
  const positionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestPosition = useRef<number>(0);
  const latestSettings = useRef<ReaderSettings>({});
  const latestCompletedInteractionIds = useRef<string[]>([]);
  const latestInteractionRecords = useRef<InteractionRecord[]>([]);
  const latestDeliveredTriggerIds = useRef<string[]>([]);
  const latestPendingEngineEvents = useRef<ReaderEngineEvent[]>([]);
  const llmConnection = useRef<OpenAICompatibleConnection | null>(null);
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
      deliveredTriggerIds: [...latestDeliveredTriggerIds.current],
      pendingEngineEvents: [...latestPendingEngineEvents.current],
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
      const file = await pickFileBrowser();
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

  const handleForeignImport = useCallback(async (plan: ForeignImportPlan) => {
    if (plan.kind !== "download") {
      throw new ForeignLibraryError("unsupported", "Interactive Foreign Library imports are not enabled in this implementation slice.");
    }
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const acquired = await foreignCoordinator.acquire(plan);
      const result = await library.importForeignFile(acquired.file, acquired.provenance);
      await refreshBooks();
      if (!result.existed && result.book.ingestionWarnings?.length) {
        setNotice(result.book.ingestionWarnings.join(" "));
      } else if (!result.existed) {
        await openBook(result.book.id);
      } else {
        setNotice(`“${result.book.title}” is already in your library.`);
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
      throw importError;
    } finally {
      setImporting(false);
    }
  }, [foreignCoordinator, library, refreshBooks]);

  const handleForeignManualImport = useCallback(async (plan: ForeignDownloadPlan): Promise<boolean> => {
    foreignRegistry.validatePlan(plan);
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      const file = await pickFileBrowser(`.${plan.file.extension}`);
      if (!file) return false;
      if (file.extension.toLowerCase() !== plan.file.extension.toLowerCase()) {
        throw new ForeignLibraryError("invalid-request", `Choose the downloaded .${plan.file.extension} file.`);
      }
      const result = await library.importForeignFile(file, {
        ...plan.provenance,
        acquiredAt: new Date().toISOString(),
      });
      await refreshBooks();
      if (!result.existed && result.book.ingestionWarnings?.length) {
        setNotice(result.book.ingestionWarnings.join(" "));
      } else if (!result.existed) {
        await openBook(result.book.id);
      } else {
        setNotice(`“${result.book.title}” is already in your library.`);
      }
      return true;
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
      throw importError;
    } finally {
      setImporting(false);
    }
  }, [foreignRegistry, library, refreshBooks]);

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
        const delivered = state?.deliveredTriggerIds ?? [];
        latestDeliveredTriggerIds.current = [...delivered];
        setDeliveredTriggerIds([...delivered]);
        latestPendingEngineEvents.current = [...(state?.pendingEngineEvents ?? [])];
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
    const book = books.find((candidate) => candidate.id === openBookId);
    const formatInput = book?.format === OPENAI_COMPATIBLE_FORMAT && llmConnection.current
      ? { connection: llmConnection.current }
      : undefined;
    void library.startStreamingBook(
      openBookId,
      (stream) => {
        if (!disposed) setOpenStream(stream);
      },
      (streamError) => {
        if (!disposed) setError(streamError.message);
      },
      latestPosition.current,
      formatInput,
    ).then((cleanup) => {
      if (disposed) cleanup();
      else {
        stop = cleanup;
        for (const event of latestPendingEngineEvents.current) {
          void library.handleReaderEngineEvent(openBookId, event).then(() => {
            latestPendingEngineEvents.current = latestPendingEngineEvents.current.filter((pending) => pending.eventId !== event.eventId);
            if (event.kind === "trigger") {
              latestDeliveredTriggerIds.current = Array.from(new Set([...latestDeliveredTriggerIds.current, event.triggerId]));
              setDeliveredTriggerIds([...latestDeliveredTriggerIds.current]);
            }
            return enqueueReaderState(openBookId, latestPosition.current, latestSettings.current);
          }).catch((eventError: unknown) => setError(eventError instanceof Error ? eventError.message : String(eventError)));
        }
      }
    }).catch((streamError: unknown) => {
      if (!disposed) setError(streamError instanceof Error ? streamError.message : String(streamError));
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [books, enqueueReaderState, library, openBookId]);

  const handleEngineEvent = useCallback(async (event: ReaderEngineEvent) => {
    const bookId = openBookId;
    if (!bookId) return;
    if (event.kind === "trigger" && latestDeliveredTriggerIds.current.includes(event.triggerId)) return;
    if (!latestPendingEngineEvents.current.some((pending) => pending.eventId === event.eventId)) {
      latestPendingEngineEvents.current = [...latestPendingEngineEvents.current, event];
      await enqueueReaderState(bookId, latestPosition.current, latestSettings.current);
    }
    await library.handleReaderEngineEvent(bookId, event);
    latestPendingEngineEvents.current = latestPendingEngineEvents.current.filter((pending) => pending.eventId !== event.eventId);
    if (event.kind === "trigger") {
      latestDeliveredTriggerIds.current = Array.from(new Set([...latestDeliveredTriggerIds.current, event.triggerId]));
      setDeliveredTriggerIds([...latestDeliveredTriggerIds.current]);
    }
    await enqueueReaderState(bookId, latestPosition.current, latestSettings.current);
  }, [enqueueReaderState, library, openBookId]);

  const handleInteractionEngineSubmit = useCallback(async (response: import("./interactions/types").InteractionResponse) => {
    const interaction = openStream?.interactions?.find((candidate) => candidate.id === response.interactionId);
    if (!interaction) return;
    await handleEngineEvent({
      schemaVersion: 1,
      eventId: `${response.interactionId}:${Date.now()}`,
      kind: "interaction-response",
      interactionId: response.interactionId,
      response,
      boundary: interaction.boundary,
      position: latestPosition.current,
    });
  }, [handleEngineEvent, openStream]);

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
    llmConnection.current = null;
    await refreshBooks();
  }, [flushState, refreshBooks]);

  const handleLibraryOpen = useCallback((bookId: string) => {
    const book = books.find((candidate) => candidate.id === bookId);
    if (book?.format === OPENAI_COMPATIBLE_FORMAT) {
      setPendingLlmBookId(bookId);
      return;
    }
    void openBook(bookId);
  }, [books, openBook]);

  const handleLlmConnect = useCallback((connection: OpenAICompatibleConnection) => {
    const bookId = pendingLlmBookId;
    if (!bookId) return;
    llmConnection.current = connection;
    setPendingLlmBookId(null);
    void openBook(bookId);
  }, [openBook, pendingLlmBookId]);

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
          : book?.format === "openai-compatible-llm"
            ? "The LLM conversation was cleared."
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
        initialDeliveredTriggerIds={deliveredTriggerIds}
        onEngineEvent={handleEngineEvent}
        onInteractionSubmit={handleInteractionEngineSubmit}
        liveError={error}
      />
    );
  }

  return (
    <>
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
      onBrowseForeign={() => setForeignLibraryOpen(true)}
      onOpen={handleLibraryOpen}
      onRemove={handleRemove}
      onRestart={handleRestart}
      positions={positions}
      />
      <LlmConnectionDialog
        open={pendingLlmBookId !== null}
        theme={global.theme}
        vault={credentialVault}
        onConnect={handleLlmConnect}
        onCancel={() => setPendingLlmBookId(null)}
      />
      <ForeignLibraryDialog
        open={foreignLibraryOpen}
        theme={global.theme}
        registry={foreignRegistry}
        onImport={handleForeignImport}
        onImportManual={handleForeignManualImport}
        onClose={() => setForeignLibraryOpen(false)}
      />
    </>
  );
}
