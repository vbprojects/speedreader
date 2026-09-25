import { loadOpenBooksSources, OpenBooksForeignLibrary } from "./foreign-libraries/openbooks";
// src/ReaderApp.tsx
// Root coordinator: owns the LibraryStore (IndexedDB-backed), the global
// SettingsStore, and the current reader session. Handles import, open
// (cached rehydrate), reader-state persistence (debounced + flushed), and
// removal. Renders either the LibraryView or the ReaderScreen.

import { useCallback, useEffect, useRef, useState } from "react";
import { createDb } from "./db";
import type { Book, ReaderState } from "./db";
import { TextParser, HtmlTextParser, textFile, SAMPLE_TEXT } from "./ingestion/text";
import { ImportDialog } from "./library/ImportDialog";
import type { ImportResult } from "./library/types";
import { lastReadBook } from "./library/reading-info";
import { useOnline } from "./library/connectivity";
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
  ArxivForeignLibrary,
  ForeignImportCoordinator,
  ForeignLibraryError,
  ForeignLibraryRegistry,
  GutenbergForeignLibrary,
  OpenRouterForeignLibrary,
  TwineForeignLibrary,
  type ForeignDownloadPlan,
  type ForeignImportPlan,
} from "./foreign-libraries";
import { ForeignLibraryDialog } from "./library/ForeignLibraryDialog";

export default function ReaderApp() {
  const online = useOnline();
  const [streamAttempt, setStreamAttempt] = useState(0);
  // ---- Stores (created once) ----
  const [settingsStore] = useState(() => new SettingsStore());
  const [credentialVault] = useState(() => new EncryptedCredentialVault());
  const [foreignRegistry] = useState(() => {
    const gatewayUrl = import.meta.env.VITE_FOREIGN_LIBRARY_GATEWAY_URL?.trim() || undefined;
    const registry = new ForeignLibraryRegistry(
      (manifest) => new ConstrainedForeignLibraryHost(manifest, globalThis.fetch, undefined, gatewayUrl),
    );
    for (const source of loadOpenBooksSources()) registry.register(new OpenBooksForeignLibrary(source));
    registry.register(new GutenbergForeignLibrary());
    registry.register(new TwineForeignLibrary());
    registry.register(new ArxivForeignLibrary());
    registry.register(new OpenRouterForeignLibrary());
    return registry;
  });
  const [foreignCoordinator] = useState(() => new ForeignImportCoordinator(foreignRegistry));
  const [library] = useState(() => new LibraryStore(
    createDb("indexeddb"),
    new IngestionEngine(
      [new EpubParser(), new PdfJsParser(), new TextParser(), new HtmlTextParser()],
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
  const [readerStates, setReaderStates] = useState<Record<string, ReaderState>>({});
  const [removedBooks, setRemovedBooks] = useState<Book[]>([]);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [pasting, setPasting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const importLock = useRef(false);

  // ---- Reader session ----
  const [openBookId, setOpenBookId] = useState<string | null>(null);
  const [openStream, setOpenStream] = useState<import("./epub/types").WordStream | null>(null);
  const [readerSettings, setReaderSettings] = useState<GlobalSettings | null>(null);
  const [initialIndex, setInitialIndex] = useState(0);
  const [completedInteractionIds, setCompletedInteractionIds] = useState<string[]>([]);
  const [interactionRecords, setInteractionRecords] = useState<InteractionRecord[]>([]);
  const [deliveredTriggerIds, setDeliveredTriggerIds] = useState<string[]>([]);

  const reportSaveError = useCallback((cause: unknown) => {
    setError(`Could not save your place: ${cause instanceof Error ? cause.message : String(cause)}. Free some device storage and try again.`);
  }, []);

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
      setRemovedBooks(await library.getRemovedBooks());
      // Load saved positions for progress display.
      const pos: Record<string, number> = {};
      const states: Record<string, ReaderState> = {};
      for (const b of list) {
        const st = await library.getReaderState(b.id);
        if (st) { pos[b.id] = st.position; states[b.id] = st; }
      }
      setPositions(pos);
      setReaderStates(states);
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

  const showImport = useCallback(async (result: ImportResult) => {
    await refreshBooks();
    setPasting(false);
    setPreview(result);
    setPreviewVersion((version) => version + 1);
    setImportStatus(null);
  }, [refreshBooks]);

  // ---- Import ----
  const handleImport = useCallback(async () => {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setImportStatus("Preparing import…");
    setError(null);
    setNotice(null);
    try {
      const file = await pickFileBrowser();
      if (!file) return;
      setImportStatus("Extracting and saving text…");
      const result = await library.importFile(file);
      await showImport(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      importLock.current = false;
      setImporting(false);
      setImportStatus(null);
    }
  }, [library, showImport]);

  const handleForeignImport = useCallback(async (plan: ForeignImportPlan) => {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setImportStatus("Preparing import…");
    setError(null);
    setNotice(null);
    try {
      if (plan.kind === "interactive") {
        const result = await library.importForeignInteractive(plan);
        await refreshBooks();
        if (result.existed) setNotice(`“${result.book.title}” is already in your library.`);
        setPendingLlmBookId(result.book.id);
        return;
      }
      setImportStatus("Downloading content…");
      const acquired = await foreignCoordinator.acquire(plan);
      setImportStatus("Extracting and saving text…");
      const result = await library.importForeignFile(acquired.file, acquired.provenance);
      await showImport(result);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
      throw importError;
    } finally {
      importLock.current = false;
      setImporting(false);
      setImportStatus(null);
    }
  }, [foreignCoordinator, library, refreshBooks, showImport]);

  const handleForeignManualImport = useCallback(async (plan: ForeignDownloadPlan): Promise<boolean> => {
    foreignRegistry.validatePlan(plan);
    if (importLock.current) return false;
    importLock.current = true;
    setImporting(true);
    setImportStatus("Choose your downloaded file…");
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
      await showImport(result);
      return true;
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
      throw importError;
    } finally {
      importLock.current = false;
      setImporting(false);
      setImportStatus(null);
    }
  }, [foreignRegistry, library, showImport]);

  const handleTextImport = useCallback(async (text: string, title: string) => {
    if (importLock.current) return;
    importLock.current = true;
    setImporting(true);
    setError(null);
    setNotice(null);
    setImportStatus("Saving text…");
    try { await showImport(await library.importFile(textFile(text, title))); }
    finally { importLock.current = false; setImporting(false); setImportStatus(null); }
  }, [library, showImport]);

  // ---- Open a book (cached rehydrate) ----
  const openBook = useCallback(
    async (bookId: string) => {
      if (openingRef.current) return;
      openingRef.current = true;
      setOpening(true);
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
      } finally {
        openingRef.current = false;
        setOpening(false);
      }
    },
    [enqueueReaderState, library, global]
  );

  const activeSourceFormat = books.find(book => book.id === openBookId)?.format;

  // A live format owns its connection only while its library book is open.
  useEffect(() => {
    if (!openBookId || !online) return;
    let disposed = false;
    let stop: (() => void) | null = null;
    if (activeSourceFormat === OPENAI_COMPATIBLE_FORMAT && !llmConnection.current) return;
    const formatInput = activeSourceFormat === OPENAI_COMPATIBLE_FORMAT && llmConnection.current
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
  }, [activeSourceFormat, enqueueReaderState, library, openBookId, online, streamAttempt]);

  const handleEngineEvent = useCallback(async (event: ReaderEngineEvent) => {
    const bookId = openBookId;
    if (!bookId) return;
    const format = books.find((book) => book.id === bookId)?.format;
    if (event.kind === "interaction-response" && (format === OPENAI_COMPATIBLE_FORMAT || format === "bluesky-jetstream") && !online) {
      throw new Error("Reconnect before requesting new content. Your saved text is still available.");
    }
    if (format === OPENAI_COMPATIBLE_FORMAT && !llmConnection.current) {
      throw new Error("Return to the library and connect this chat before sending a message.");
    }
    if (event.kind === "trigger" && latestDeliveredTriggerIds.current.includes(event.triggerId)) return;
    if (!latestPendingEngineEvents.current.some((pending) => pending.eventId === event.eventId)) {
      latestPendingEngineEvents.current = [...latestPendingEngineEvents.current, event];
      await enqueueReaderState(bookId, latestPosition.current, latestSettings.current);
    }
    if (!online && (format === OPENAI_COMPATIBLE_FORMAT || format === "bluesky-jetstream")) {
      throw new Error("New content will load when you reconnect.");
    }
    await library.handleReaderEngineEvent(bookId, event);
    latestPendingEngineEvents.current = latestPendingEngineEvents.current.filter((pending) => pending.eventId !== event.eventId);
    if (event.kind === "trigger") {
      latestDeliveredTriggerIds.current = Array.from(new Set([...latestDeliveredTriggerIds.current, event.triggerId]));
      setDeliveredTriggerIds([...latestDeliveredTriggerIds.current]);
    }
    await enqueueReaderState(bookId, latestPosition.current, latestSettings.current);
  }, [enqueueReaderState, library, openBookId, books, online]);

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
        void enqueueReaderState(bookId, latestPosition.current, latestSettings.current).catch(reportSaveError);
      }, 500);
    },
    [enqueueReaderState, openBookId, reportSaveError]
  );

  // ---- Reader interaction completion ----
  const handleInteractionResolved = useCallback(
    (interactionId: string) => {
      const next = Array.from(new Set([...latestCompletedInteractionIds.current, interactionId]));
      latestCompletedInteractionIds.current = next;
      setCompletedInteractionIds(next);
      if (openBookId) {
        void enqueueReaderState(openBookId, latestPosition.current, latestSettings.current, next).catch(reportSaveError);
      }
    },
    [enqueueReaderState, openBookId, reportSaveError]
  );

  const handleInteractionCommitted = useCallback(
    (record: InteractionRecord) => {
      const next = [...latestInteractionRecords.current.filter((item) => item.interactionId !== record.interactionId), record];
      latestInteractionRecords.current = next;
      setInteractionRecords(next);
      const completed = Array.from(new Set([...latestCompletedInteractionIds.current, record.interactionId]));
      latestCompletedInteractionIds.current = completed;
      setCompletedInteractionIds(completed);
      if (openBookId) void enqueueReaderState(openBookId, latestPosition.current, latestSettings.current).catch(reportSaveError);
    },
    [enqueueReaderState, openBookId, reportSaveError]
  );

  // ---- Reader settings change ----
  const handleSettingsChange = useCallback(
    (patch: ReaderSettings) => {
      if (!openBookId) return;
      const next = { ...latestSettings.current, ...patch };
      latestSettings.current = next;
      setReaderSettings((prev) => (prev ? mergeSettings(prev, patch) : prev));
      void enqueueReaderState(openBookId, latestPosition.current, next).catch(reportSaveError);
    },
    [enqueueReaderState, openBookId, reportSaveError]
  );

  const handleSettingsReset = useCallback(() => {
    if (!openBookId) return;
    latestSettings.current = {};
    setReaderSettings(global);
    void enqueueReaderState(openBookId, latestPosition.current, {}).catch(reportSaveError);
  }, [enqueueReaderState, openBookId, global, reportSaveError]);

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
      if (document.visibilityState === "hidden") void flushState().catch(reportSaveError);
    };
    const onPageHide = () => { void flushState().catch(reportSaveError); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [flushState, reportSaveError]);

  // ---- Back to library ----
  const handleBack = useCallback(async () => {
    try { await flushState(); } catch (cause) { reportSaveError(cause); return; }
    setOpenBookId(null);
    setOpenStream(null);
    setReaderSettings(null);
    llmConnection.current = null;
    await refreshBooks();
  }, [flushState, refreshBooks, reportSaveError]);

  const handleLibraryOpen = useCallback((bookId: string) => {
    const book = books.find((candidate) => candidate.id === bookId);
    if (book?.format === OPENAI_COMPATIBLE_FORMAT && online) {
      setPendingLlmBookId(bookId);
      return;
    }
    void openBook(bookId);
  }, [books, openBook, online]);

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
        await library.trashBook(bookId);
        setNotice("Book removed. Undo below, or restore it later from Removed books.");
        await refreshBooks();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [library, refreshBooks]
  );

  const handleRestore = async (bookId: string) => {
    try { await library.restoreBook(bookId); setNotice("Book restored with its saved progress."); await refreshBooks(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const handleDelete = async (bookId: string) => {
    try { await library.removeBook(bookId); await refreshBooks(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

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
        key={openBookId}
        presenterSelection={books.find(book => book.id === openBookId)?.presenterSelection}
        onPresenterSelection={selection => {
          saveQueue.current = saveQueue.current.catch(() => undefined).then(async () => {
            await library.setPresenterSelection(openBookId, selection);
            setBooks(previous => previous.map(book => book.id === openBookId ? { ...book, presenterSelection: selection } : book));
          });
          void saveQueue.current.catch(error => setError(`Could not save reading experience: ${error instanceof Error ? error.message : String(error)}. Select it again to retry.`));
        }}
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
        onPresenterEventDelivered={async event => {
          if (event.kind !== "trigger") return;
          latestDeliveredTriggerIds.current = Array.from(new Set([...latestDeliveredTriggerIds.current, event.triggerId]));
          setDeliveredTriggerIds([...latestDeliveredTriggerIds.current]);
          await enqueueReaderState(openBookId, latestPosition.current, latestSettings.current);
        }}
        onEngineEvent={handleEngineEvent}
        onInteractionSubmit={handleInteractionEngineSubmit}
        liveError={error}
        offline={!online}
        sourceFormat={books.find((book) => book.id === openBookId)?.format}
        onRetry={() => {
          setError(null);
          if (books.find((book) => book.id === openBookId)?.format === OPENAI_COMPATIBLE_FORMAT && !llmConnection.current) {
            void handleBack();
          } else setStreamAttempt((attempt) => attempt + 1);
        }}
        onPause={() => { void flushState().then(() => setError((previous) => previous?.startsWith("Could not save your place:") ? null : previous)).catch(reportSaveError); }}
      />
    );
  }

  const continueBook = lastReadBook(books, readerStates);
  const pendingLlmConfig = books.find((book) => book.id === pendingLlmBookId)?.interactiveConfig;
  const pendingLlmBaseUrl = typeof pendingLlmConfig?.baseUrl === "string"
    ? pendingLlmConfig.baseUrl
    : undefined;
  const pendingLlmModel = typeof pendingLlmConfig?.model === "string"
    ? pendingLlmConfig.model
    : undefined;

  return (
    <>
      <LibraryView
      books={books}
      loading={loading}
      importing={importing || opening}
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
      online={online}
      status={opening ? "Opening book…" : importStatus}
      onPaste={() => { setPreview(null); setPasting(true); }}
      onSample={() => { void handleTextImport(SAMPLE_TEXT, "A moment to read").catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }}
      continueBook={continueBook}
      continueState={readerStates[continueBook?.id ?? ""]}
      removedBooks={removedBooks}
      onRestore={(bookId) => void handleRestore(bookId)}
      onDelete={(bookId) => void handleDelete(bookId)}
      />
      {(preview || pasting) && <ImportDialog
        key={preview ? `${preview.book.id}:${previewVersion}` : "paste"}
        result={preview ?? undefined} theme={global.theme} wpm={global.wpm} busy={importing}
        onClose={() => { setPreview(null); setPasting(false); }}
        onRead={(bookId) => { setPreview(null); handleLibraryOpen(bookId); }}
        onSaveText={handleTextImport}
        onChooseFile={() => { setPreview(null); void handleImport(); }}
      />}
      <LlmConnectionDialog
        open={pendingLlmBookId !== null}
        theme={global.theme}
        vault={credentialVault}
        initialBaseUrl={pendingLlmBaseUrl}
        initialModel={pendingLlmModel}
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
