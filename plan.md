# Speedreader — Implementation Plan

## Overview

A cross-platform ebook speed reader built with JavaScript (Node.js backend + web frontend). Users open an ebook (starting with EPUB and PDF), and the app flashes words sequentially at a configurable speed (e.g., 600 WPM), highlighting the current word while showing surrounding context.

The core idea is **separation of concerns**: each stage of the pipeline is an independent component with a well-defined interface, so new formats and display modes can be added without touching the rest of the system.

---

## Architecture

### High-Level Pipeline

```
                        ┌──────────────────────────────────────────────┐
                        │                  Library                      │
                        │  hosts / launches multiple Reader instances  │
                        └──────────────────────────────────────────────┘
                                      │
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
        [Reader A]              [Reader B]              [Reader C]
        (book 1)                (book 2)                (book 3)
              │                       │                       │
              └───────────┬───────────┴───────────┬───────────┘
                          ▼                       ▼
              [Ingestion → Word Stream]   [Pacing Engine → Display]
                          │
                          ▼
              [Local SQLite DB]
              (metadata, position, bookmarks, cached stream)
```

### Component Breakdown

#### 1. Ingestion Component
- **Responsibility**: Accept an uploaded file or interactive input, parse/generate content, and emit a normalized stream of words regardless of source format.
- **Interface**:
  - Deterministic/batch parsers: `ingest(file) → Promise<WordStream>` (e.g. EPUB, plain text).
  - Interactive/asynchronous sources: `InteractiveFormat<TInput, TState>` (e.g. background PDF OCR, LLM interactive generation).
- **Stream model — flat, tagged words (Option B)**:
  - The stream is a **single flat, ordered array of `Word` objects** — homogeneous, streamable, and cacheable.
  - Every `Word` carries **structural metadata** inline. The `Word` shape is **format-agnostic and intentionally flexible** — it does not hard-code any specific ebook structure, so different formats (EPUB, PDF, dynamic content) can express their own hierarchy without the model being tied to one format:
    ```ts
    interface Word {
      text: string;        // the word itself
      index: number;       // 0-based global position
      metadata: Metadata[]; // ordered list of structural attributes
    }

    interface Metadata {
      attribute: string;   // e.g. "chapterId", "sectionId", "paragraphId", "page"
      value: string | number;
    }

    interface StreamMeta {
      totalWords: number;
      avgWordLength: number;
      isDeterministic: boolean;     // true for EPUB, false for OCR / dynamic formats
      isComplete?: boolean;         // true when full book/stream is finished
      totalWordsExpected?: number;  // estimated/known total during background streaming
      chapterAttribute: string;
    }

    interface WordStream {
      words: Word[];
      chapterIndex: ChapterEntry[];
      meta: StreamMeta;
    }
    ```
  - **The list of metadata and its order determine the hierarchy.** The array is ordered **most-important → least-important** (top of the navigation tree → leaf). For example, `[{ chapterId: 1 }, { sectionId: 1 }]` means "chapter 1, section 1" — the navigation tree renders `chapterId` as the top level and `sectionId` nested under it. This enables **dynamic hierarchical navigation** derived from whatever attributes a format provides.
  - **Navigation tree depth = metadata array length.** The first attribute is the root level of the tree; each subsequent attribute is one level deeper.

- **Dynamic Word Streams & The `InteractiveFormat` Abstraction**:
  - For formats that cannot be ingested in a single synchronous/deterministic batch (e.g. background page-by-page PDF OCR, on-demand VLM extraction, or generative text), ingestion is modeled as an **`InteractiveFormat<TInput, TState>`**:
    ```ts
    interface StreamChunk<TState = Record<string, unknown>> {
      words: Word[];
      chapterUpdates?: ChapterEntry[];
      state: TState;
      isComplete: boolean;
      totalWordsExpected?: number;
    }

    interface InteractiveFormat<TInput = unknown, TState = Record<string, unknown>> {
      readonly format: string;
      readonly isDeterministic: boolean;

      init(input: TInput, savedState?: TState): Promise<{
        initialState: TState;
        title?: string;
        author?: string;
      }>;

      startStreaming(
        startIndex: number,
        onChunk: (chunk: StreamChunk<TState>) => void,
        onError: (err: Error) => void
      ): () => void; // returns cleanup/abort function

      getState(): TState;
    }
    ```
  - **Stream Decoupling**: Words emitted by an interactive source are merged into the persistent `WordStream` via `appendToWordStream()` and committed to IndexedDB incrementally.
  - **State Separation**: The reading position (`position`) is tracked by global word index in the persistent stream, while format-specific progress (e.g., `{ currentPage: 14, totalPages: 100 }` or `{ sessionToken: "..." }`) is stored as an opaque `formatState` in `ReaderState` and `Book`. When reopening a book, accumulated words rehydrate instantly offline, and the interactive subclass resumes processing from `formatState`.

- **Format parsers & sources**:
  - **EPUB**: unzip container, parse `content.opf` for spine/reading order, extract XHTML chapters, strip markup, split into words. Derived from TOC/nav (`isDeterministic: true`).
  - **PDF (Local & OCR/VLM)**: Implemented as an `InteractiveFormat` with background page extraction and incremental word append (`isDeterministic: false`).
  - Future: interactive LLM generators, MOBI, TXT, HTML, DOCX.

#### 2. Cache / Persistence Layer
- **Responsibility**: Store the normalized word stream so re-opening a book doesn't require re-parsing.
- **Options**:
  - Backend: store parsed stream as JSON in a local database (SQLite) or on disk keyed by file hash.
  - Frontend: cache in IndexedDB for offline use.
- **Key**: hash of the source file + parser version, so parser changes invalidate the cache.

#### 3. Pacing Engine
- **Responsibility**: Decide how long each word is displayed, given a target speed (WPM). The pacing model is a **pluggable abstraction** — not one fixed algorithm.
- **Core abstraction**: a **pacing backend** is any function that maps a word to a duration.
  - `type PacingFn = (word: Word, ctx: PacingContext) => number` → milliseconds.
  - `PacingContext` carries the target WPM, a `PacingProfile`, stream statistics `{ avgWordLength, totalWords, ... }`, and **`neighbors: { prev?: Word, next?: Word }`** so backends can detect sentence/paragraph boundaries (e.g., `word.paragraphId !== next.paragraphId`) without needing the whole stream.
  - The engine only knows how to **call** a pacing function and manage the clock; it doesn't hard-code any algorithm.
  - **Dynamic Stream Support**:
    - `PacingEngine.durationsForChunk(chunkWords, previousWord, stats)` allows incremental calculation of word display durations as new word chunks arrive in the background.
    - `SelfCorrectingClock.appendDurations(newDurations)` extends the clock's sequence live during playback, resuming seamlessly if playback paused waiting for new words.
- **Pluggable backends** (all implement `PacingFn`):
  - **Naive (Fixed WPM)**: `base = (60 / WPM) * 1000` (ms), plus fixed pauses at sentence/paragraph boundaries.
  - **Bayesian Adaptive (Shifted Poisson–Gamma Model)**: Models excess character length $Y_t = L_t - 1 \ge 0$ as a Poisson distribution with Gamma prior ($\alpha_0 = 50, \beta_0 = 10 \implies \hat{\mu}_0 = 6.0$). Employs exponential forgetting discounting ($\gamma \in [0.90, 0.999]$, default $0.98 \approx 50$ words) to dynamically scale display time:
    $$T_t = \left(\frac{60000}{W \cdot \hat{\mu}_t}\right) \cdot L_t$$
    ensuring overall reading throughput converges strictly to target $W$ WPM while accommodating local complexity.
  - Future: syllable-splitting, frequency/difficulty-based, ML-driven.
- **Selection**: a `selectBackend(name, options)` factory picks a backend and optional `PacingProfile` at runtime.

#### 4. Display Component
- **Responsibility**: Render the current word and surrounding context, driven by the pacing engine's clock.
- **Features**:
  - **Centered RSVP Focal Point (Optimal Recognition Point / ORP)**: Highlights the single focal letter (ORP) in an inverted contrast badge inside the active word pill, and aligns the layout transform to pin that exact character element to the viewport center. This keeps the user's eye anchored to a single fixation point across words of varying lengths.
  - **Traditional E-Reader View (Paused)**: Vertical swipe gesture (up/down) while paused switches into a scrollable, traditional reading layout with bidirectional infinite scrolling and long-press word context menu. Tapping unpauses and instantly transitions back to RSVP mode.
  - **Clock**: A **self-correcting timer** using `performance.now()` to compensate for `setInterval`/`setTimeout` drift. Supports `appendDurations()` for dynamically growing streams.
  - **Controls**: Full-width collapsible bottom drawer with seekbar scrubber, word count percentage indicator, direct "Jump to Word Number" dialog, and auto-hide while playing.
- **Interface**: `render(wordIndex, stream, config)`.

#### 5. Library Component (Host)
- **Responsibility**: The top-level container that owns the collection of books and **hosts multiple Reader instances** — one per book.
- **Features**:
  - Grid/list of books showing cover, title, author, and reading progress.
  - **Add book** action (file upload) that routes through ingestion.
  - **Launch** action that instantiates (or rehydrates) a Reader for a given book id.
  - Search/filter and sort (by title, author, recently added, in-progress).
  - Empty state prompting the user to add their first book.
- **Interface**: `getBooks() → Book[]`, `addBook(file) → Book`, `openReader(bookId) → Reader`.
- **Note**: The Library is the parent; Readers are its children. It can keep several Readers alive (e.g., tabs) or spawn/destroy them on demand.

##### Import & persistence flow (decision)

- **Book identity**: `bookId = SHA-256(fileBytes)` via `crypto.subtle`. Deterministic — re-importing the same file **dedupes** instead of duplicating. `parserVersion` is stored with each book so a parser change triggers re-ingest.
- **Metadata extraction**: the `Parser` interface gains an optional `getBookInfo(file) → { title, author, cover? }`. `EpubParser` implements it via `book.loaded.metadata` (title, creator) + `book.loaded.cover` (cover art); fallback is the filename.
- **Cover extraction**: EPUB cover art is resolved via epubjs (`loaded.cover` → `archive.getBlob`), stored as a browser-safe `Blob`. Books without a usable cover render a deterministic styled **title card**; a **title footer** is shown on every library tile.
- **Storage — IndexedDB (first `db` adapter)**:
  - **Why IndexedDB, not localStorage**: localStorage has a ~5MB limit; a 130k-word stream is ~1.5–2MB JSON, so multiple books exceed it. IndexedDB handles large blobs, is async, and uses structured clone.
  - DB `speedreader`, object stores:
    - `books` (keyPath `id`) — metadata: title, author, format, addedAt, wordCount, chapterCount, parserVersion, cover, `formatState?`.
    - `streams` (keyPath `bookId`) — the full `WordStream` (words + chapterIndex + meta).
    - `readerStates` (keyPath `bookId`) — durable per-book reader state: `{ position, lastOpenedAt, settings, formatState? }`.
  - Global settings stay in localStorage (small, synchronous — needed at startup). Per-book settings + positions live in IndexedDB keyed by the stable book id.
- **Import flow**: pick file → `engine.ingest(file)` → `WordStream` → `parser.getBookInfo(file)` → title/author/cover → `bookId = SHA-256(bytes)` → `libraryStore.importFile` persists book + stream → library refreshes.
- **Incremental stream append flow**: For interactive/dynamic sources (`InteractiveFormat`), background chunks call `libraryStore.appendWords(bookId, newWords, options)` $\to$ `db.appendStreamWords()` updates the accumulated word stream and book wordCount in IndexedDB, while storing format checkpoint metadata in `formatState`.
- **Launch & resume flow**: click book → `libraryStore.openBook(bookId)` → **cached** = instant rehydrate from IndexedDB (no re-parse); if the source is an `InteractiveFormat`, it initializes with `savedState = readerState.formatState` to continue background processing from where it left off.
- **Reader state lifecycle**: position + per-book settings are persisted to IndexedDB **debounced** (500ms) while reading, **plus flushed** on reader exit, `visibilitychange` (hidden), and `pagehide`. Reopening a book hydrates the saved position (playback starts **paused** at that index) and effective per-book settings.
- **Removal**: right-click (desktop) or long-press (touch) on a tile opens a themed context menu with a single **"Remove from library"** action. Confirmation is required; confirmed removal cascades through book + stream + reader state in one IndexedDB transaction.
- **Deferred**: storing source file bytes (enables automatic re-ingest on parser change), chunked/lazy disk slicing, bookmarks, cover editing.

#### 6. Reader Component (One per Book)
- **Responsibility**: A single, self-contained reader for one book. Owns the word stream, pacing engine, display, and reading state.
- **Lifecycle**:
  - **Init**: `new Reader(bookId)` — loads cached state from SQLite (position, bookmarks, settings) and the cached word stream, so it's ready almost instantly.
  - **Reinit**: If the stream isn't cached, run ingestion first, then persist. Reopening the same book rehydrates from cache rather than re-parsing.
- **State persisted to SQLite**: `currentPosition`, `bookmarks`, `pacingProfile`, `lastOpenedAt`.
- **Persistence strategy**: `saveState` is **debounced** (e.g., every few words / seconds) to keep writes cheap, **plus flushed on `visibilitychange`/`beforeunload`** so progress is not lost if the app is closed or crashes between debounce intervals.
- **Interface**: `init()`, `play()`, `pause()`, `seek(index)`, `addBookmark()`, `getState()`, `destroy()`.
- **Note**: Each book has exactly one Reader; the Library can reinitialize it at any time from the cache.

#### 7. Local SQLite Database
- **Responsibility**: Single local store for everything needed to rehydrate a Reader quickly.
- **Tables**:
  - `books` — `{ id, title, author, coverImage, format, addedAt }`.
  - `reader_state` — `{ bookId, currentPosition, pacingProfile, lastOpenedAt }`.
  - `bookmarks` — `{ id, bookId, wordIndex, note, createdAt }`.
  - `word_streams` — cached stream per book, stored as **fixed-size chunks** (e.g., N words per row, ordered by chunk number) instead of one giant blob. This supports incremental writes, lazy loading, and avoids multi-MB blob read/write per open/close.
  - `chapter_index` — derived TOC: `{ chapterId, title, startIndex, endIndex }` per book. For EPUB, chapters come from the **TOC/nav** (mapped to word ranges via anchors); formats without a TOC fall back to spine/files as chapters. **Stored alongside the stream**; for lazy/partial streams it is built/extended incrementally as chunks are materialized, and is authoritative (the stream derives from it for navigation, not the other way around). The navigation tree is rendered from the metadata array order (first attribute = root level).
- **Note**: Because state lives in SQLite, opening a book restores position and bookmarks instantly without re-parsing.

##### The `db` abstraction — one interface, many adapters

SQLite is inherently cross-platform, but **where the database file lives** determines the deployment model. Rather than hard-coding one storage backend, we define a single **`db` interface** implemented by multiple **adapters**. Both the backend and the browser use the same abstraction, so storage can be swapped or even combined without touching Reader/Library code.

**Interface** (all async):
- `getBook(id)`, `getBooks()`, `addBook(book)`, `updateBook(id, patch)`
- `getState(bookId)`, `saveState(bookId, state)`
- `getBookmarks(bookId)`, `addBookmark(bookmark)`, `removeBookmark(id)`
- `getStream(bookId, range?: { from: number; to: number })` — fetch the whole stream or a slice (for lazy navigation).
- `saveStream(bookId, stream)` — persist or replace the stream in full.
- `appendStreamWords(bookId, words, options?)` — append a batch of words incrementally to an ongoing or growing stream.
- `getStreamMeta(bookId)` — `{ totalWords, avgWordLength, isComplete, isDeterministic }` so the Reader knows whether the stream is partial/lazy.
- `getChapters(bookId)`, `saveChapters(bookId, chapters)`
**Adapters**:
| Adapter | Where it runs | Notes |
|---------|---------------|-------|
| **Server SQLite** | Node backend (`better-sqlite3`) | For a hosted deployment; enables multi-device sync; requires a server. |
| **Browser WASM** | `sql.js` / SQLite WASM in the browser | Fully offline; data tied to that browser/device. |
| **Browser IndexedDB** | Native IndexedDB in the browser | Alternative client store, good for large cached streams (blobs). |
| **Native desktop** | `better-sqlite3` in Electron/Tauri | True local file DB for a packaged desktop app. |

**Selection & composition**:
- The app chooses an adapter at startup via a factory, e.g. `createDb('server' | 'wasm' | 'indexeddb' | 'desktop')`.
- The **backend** uses the same interface (server adapter) as the browser (WASM/IndexedDB adapter), so a Reader on the client can be backed by the client DB, the server DB, or both.
- Because all adapters expose the same interface, the cross-platform/client-only question stays an **implementation detail**, not an architectural fork.

**Recommendation**: Start with the **browser IndexedDB or WASM adapter** for offline-first simplicity, and keep the **server SQLite adapter** available so a future backend deployment shares the same code path. **Status**: the **IndexedDB adapter is the first one built** (used by the Library for books + streams); WASM/desktop/server adapters come later.

#### 8. Frontend (Web App)
- **Responsibility**: UI shell — file picker, library view, reader views, settings panel.
- **Tech**: plain JS or a lightweight framework (React/Vue) + bundler (Vite).
- **Cross-platform packaging**: **Tauri** covers everything — desktop (Windows/macOS/Linux) **and** mobile (iOS/Android), sharing one web codebase.
  - Uses the OS-native webview (WebView2 / WKWebView / WebKitGTK / WKWebView on iOS) and exposes native capabilities (file dialogs, menus, notifications) via Rust commands.
- **Native look, no consistent UI**: We do **not** aim for a uniform visual style. Instead, a `platform` module detects the OS and injects **platform-specific design tokens** (fonts, colors, spacing, control styles) so each platform's chrome feels native. The word-flash display itself stays consistent (it's just text), but menus, dialogs, settings, and buttons adapt per platform.
- **Settings system — global + per-reader**:
  - **Global settings** apply to the whole app / library view (theme, default font, default WPM, default context window, pauses).
  - **Per-reader (local) settings** override global for an individual reader instance, keyed by book id. Each reader can have its own font, theme, context window, WPM, and pauses.
  - **Merge semantics**: effective settings = global, overlaid with per-reader overrides (deep-merged for nested objects like `contextWindow`).
  - **Persistence**: stored client-side (localStorage for now; the `db` abstraction later) — offline-first.
  - **Settings panel** is available in both the library view (edits global) and the reader view (edits per-reader, with a "reset to global" action).
  - **Controllable properties**: theme (light/dark/high-contrast), font family, font size, context window length (before/after), adaptive window toggle, WPM, sentence pause, paragraph pause.
- **Note**: The Library view is the root; opening a book mounts a Reader view as a child.

#### 9. Backend (Node.js) — *optional / sync layer*
- **Status**: **Optional.** The app is offline-first (open question #1); the backend exists only to enable optional features: cross-device sync, serverless-powered extraction (PDF/OCR), and dynamic content generation.
- **Responsibility**: When present, serve the app, handle file uploads, run remote ingestion/extraction, and own a server-side database via the **server `db` adapter** (e.g., `better-sqlite3`).
- **Key point**: The backend talks to storage through the **same `db` interface** as the browser — it just uses the server adapter. This keeps one code path for all storage logic and lets the client and server caches be used interchangeably (e.g., try client cache first, fall back to server).
- **API** (all optional, only used when a backend is configured):
  - `GET /api/books` — list library (metadata for all books).
  - `POST /api/books` — upload file, returns book id + parsed stream.
  - `GET /api/books/:id` — metadata.
  - `GET /api/books/:id/stream` — fetch cached word stream.
  - `GET /api/books/:id/state` — reader state (position, bookmarks).
  - `PUT /api/books/:id/state` — persist position/bookmarks.
- **Note**: Everything core (EPUB ingestion, pacing, display, library) works without this backend.

---

## Proposed Project Structure

```
speedreader/
├── package.json
├── server/                 # Node.js backend (optional, not yet built)
│   ├── index.js            # Express app
│   ├── routes/books.js
│   └── cache/              # SQLite / disk cache
├── frontend/               # Vite + React + TypeScript (PWA-first)
│   ├── src/
│   │   ├── db/
│   │   │   ├── index.ts        # factory: createDb(type)
│   │   │   ├── indexeddb.ts    # IndexedDB adapter (browser) — first adapter
│   │   │   ├── wasm-sqlite.ts  # sql.js adapter (browser, later)
│   │   │   ├── server-sqlite.ts  # better-sqlite3 adapter (backend, later)
│   │   │   └── types.ts        # shared Db interface + Book/ReaderState
│   │   ├── ingestion/
│   │   │   ├── index.ts        # dispatcher
│   │   │   ├── engine.ts       # IngestionEngine (parser selection)
│   │   │   ├── epub-parser.ts  # EpubParser (TOC→stream + getBookInfo/cover)
│   │   │   ├── pdf.ts          # (later)
│   │   │   ├── normalize.ts    # → WordStream
│   │   │   └── file-source.ts  # browser/iOS file picker
│   │   ├── pacing/
│   │   │   ├── engine.ts       # calls PacingFn, manages clock
│   │   │   ├── select.ts       # selectBackend(name) factory
│   │   │   ├── naive.ts        # default length-based backend
│   │   │   ├── syllables.ts    # (later)
│   │   │   └── bayesian.ts     # (later)
│   │   ├── display/
│   │   │   ├── renderer.ts     # word + context rendering
│   │   │   ├── clock.ts        # self-correcting timer loop
│   │   │   └── SpeedReader.tsx # reading view
│   │   ├── settings/
│   │   │   ├── types.ts        # GlobalSettings, ReaderSettings, merge
│   │   │   ├── store.ts        # SettingsStore (global, localStorage)
│   │   │   ├── SettingsPanel.tsx
│   │   │   └── SettingsModal.tsx
│   │   ├── library/
│   │   │   ├── types.ts        # Book metadata + import result
│   │   │   ├── store.ts        # LibraryStore (IndexedDB: books + streams + state)
│   │   │   ├── hash.ts         # SHA-256 book id
│   │   │   ├── LibraryView.tsx # grid UI + import + launch + remove
│   │   │   ├── ContextMenu.tsx # themed remove-only context menu
│   │   │   └── ConfirmDialog.tsx
│   │   ├── reader/
│   │   │   ├── ReaderScreen.tsx # one reader per book (rehydrated)
│   │   │   └── index.ts
│   │   ├── navigation/
│   │   │   ├── tree.ts         # buildNavTree from word metadata
│   │   │   └── NavTreeView.tsx
│   │   ├── epub/
│   │   │   ├── types.ts        # Word/WordStream/Metadata
│   │   │   └── explore.ts      # epubjs loading surface
│   │   ├── ReaderApp.tsx       # root coordinator (library ↔ reader)
│   │   ├── App.tsx
│   │   └── main.tsx            # PWA SW registration
│   ├── experiments/            # headless conformance tests + fixtures
│   └── src-tauri/              # Tauri shell (compatible, not expanded)
└── tests/
```

---

## Open Questions

1. **Backend vs. fully client-side parsing**
   - **Decision**: **offline-first** — ingestion and reading run fully on the client; no required backend.
   - **Capability via serverless**: optional **serverless** services (edge functions) can be layered on for further capabilities — e.g., the external PDF/OCR extraction (see open question #7), cloud sync, or remote dynamic content generation.
   - Architecture stays client-first: everything essential works offline; serverless adds optional, non-core features.

2. **Pacing backends**
   - **Decision**: pacing uses a pluggable abstraction — any `PacingFn(word, ctx) → ms`. Backends include length-based, syllable-splitting, and a Bayesian conjugate model. Open question: where do shared punctuation/sentence pauses live (base backend vs. decorators)?

3. **Context window**
   - **Decision**: **adaptive and configurable**.
   - Default: a **localized window** around the current word (e.g., 3 left / 3 right).
   - **Adaptive**: the window can shrink as WPM rises (reduce distraction at high speed) and expand at low speed, where the window size responds to speed/WPM.
   - **Configurable**: the user can override the window (and adaptivity) in settings; the value is persisted per book in `pacingProfile`/settings.

4. **Word stream granularity**
   - **Decision**: **Option B — flat, tagged word stream.** A single ordered array of `Word`s, each with inline `paragraphId`/`sectionId`/`chapterId`/`page`. Navigation (e.g., chapter jumps, progress) uses **binary search** over the sorted `index`, and a derived `chapter_index` table (built by one linear scan) holds `{ chapterId, title, startIndex, endIndex }`. Open question: how granular should the paragraph/section level be for EPUB (one spine doc per section vs. per heading)?

5. **Cache strategy / DB location**
   - **Decision**: storage lives **on the client**, behind the swappable `db` interface (see §7) — IndexedDB/WASM in browser, native desktop, etc.
   - **Adapter swaps yield the same data**: because the `db` interface is the single contract and the logical storage contract is identical across adapters, switching adapters (or re-fetching) produces identical data/behavior. The parser is a deterministic function of the source bytes, so cached output is stable and interchangeable across adapters.
   - **Parser determinism**: the parser is **deterministic** — same file bytes in, same `WordStream` + `chapter_index` out (no randomness, no wall-clock/time dependence).
   - **Cache invalidation**: keyed by `hash(sourceFile) + parserVersion`. Because the parser is deterministic, a mismatch in either triggers a re-parse and cache refresh.

6. **Cross-platform packaging**
   - **Decision**: **Tauri only** (desktop + mobile) with Tauri 2.x native mobile support. No consistent UI — platform-adaptive design tokens per OS. Remaining question: how much of the chrome should use native widgets (via Tauri's native APIs/capabilities) vs. styled HTML?

7. **PDF specifics & Interactive Ingestion**
   - PDFs are page-based and often have multi-column layouts or require OCR.
   - **Architecture via `InteractiveFormat`**: PDF extraction (local text extraction, VLM/MarkItDown OCR) is implemented as an `InteractiveFormat`. Ingestion proceeds asynchronously in the background on a page-by-page basis, emitting `StreamChunk` objects containing words, page numbers, and incremental chapter updates.
   - **Live Reading & Resume**: Users can begin speedreading immediate pages as soon as they are processed without waiting for the full PDF to finish. The accumulated stream is persisted incrementally in IndexedDB alongside the PDF's current page processing cursor in `formatState`, ensuring instant offline resume.
   - **Pricing / membership**: External extraction services can be modularly configured behind this same `InteractiveFormat` interface. Core EPUB and local parsers remain local and free.

8. **Progress & persistence**
   - **Decision**: Yes — reading position is saved **per book, client-side** so users can resume.
   - Stored via the `db` abstraction in the **`reader_state` table** (`currentPosition`, `pacingProfile`, `lastOpenedAt`), so it works across the IndexedDB/WASM/desktop adapters and is fully offline-first.
   - Resume UX: the Library shows per-book progress; opening a book rehydrates the Reader to its saved `currentPosition`. `currentPosition` is written back **debounced** (see open question #12) so it's cheap to persist while reading.

9. **Accessibility**
   - **Decision**: **all three included**.
   - **Font size**: adjustable (and respected for the word-flash display) — exposed via the settings system (global + per-reader).
   - **Color contrast**: theme/contrast controls (dark/light, high-contrast) so the highlighted word remains legible — exposed via the settings system.
   - **Keyboard controls**: full keyboard navigation for the reader (play/pause, seek, speed, context window, and reading app shortcuts), plus focus/ARIA or proper semantics for a webview-based app.
   - Where feasible, drive from/respect OS accessibility settings (e.g., system font size, reduced motion).

10. **Testing**
    - **Decision**: **Smoke tests + unit tests** for the pacing engine and ingestion.
    - **Pacing engine**: deterministic unit tests — inject a fixed `PacingFn`/profile and known words, assert exact durations and that backend selection/pauses behave correctly.
    - **Ingestion**: unit tests with **fixture files** (small `.epub`/`.txt` fixtures) asserting the produced flat `WordStream` and `chapter_index`; smoke tests that run the full ingest → stream → pace → display path end-to-end.
    - Run in a Node test runner; keep fixtures under `tests/fixtures/`.

11. **Library ↔ Reader relationship**
    - **Decision direction**: storage/retrieval of Readers should be **fast enough that the spawn-vs-keep-alive tradeoff is not a concern** — rehydration from the `db` cache is cheap, so Readers can be spawned/destroyed on demand without worrying about losing state.
    - Additionally, we **may persist Readers themselves** — not just per-book position/bookmarks, but the full Reader instance/session — so an in-progress reader can be torn down and restored exactly. This leans toward keeping `reader_state` rich and ensuring `saveState` is cheap.
    - Metadata per book (cover, author, progress): extract what's cheaply available (author/title from EPUB metadata, cover image, progress = `currentPosition / totalWords`).

12. **Reader rehydration**
    - **Decision**: generally **cache the stream from ingestion** so a Reader rehydrates quickly — the full `WordStream` is the default; it's loaded from `word_streams` on init and re-parsing is skipped.
    - **Dynamic / lazy navigation**: in some circumstances the whole structure must **not** be loaded at once:
      - **PDF with on-demand OCR** — extract/OCR only the needed portion instead of the whole file up front.
      - **Dynamic content** — e.g., a generated story may wait on an external source to produce output lazily.
    - This implies a **lazy/streamed access path**: the Reader must be able to work with a partially materialized stream (fetch a random slice via the `db` interface / adapter, and expand on demand) rather than assuming the full array is always resident.
    - **`reader_state` sync**: keep writes **debounced** while reading (see open question #8) so persisting position is cheap.

13. **Structural metadata scheme (was: "Structural ID scheme for EPUB")**
    - The `Word` model uses a **flexible `metadata: Metadata[]` array** (ordered list of `{ attribute, value }`) rather than fixed fields, so the hierarchy is data-driven and format-agnostic. This does not enforce an ebook structure on other formats.
    - **Decision (informed by Experiment 1 — Pride and Prejudice)**: the EPUB metadata scheme is, **in hierarchy order (most-important first — this order drives the navigation tree)**:
      1. `chapterId` — index into the **TOC/nav** (the real chapter unit). Primary navigation level (tree root).
      2. `sectionId` — heading-delimited block within a chapter (h1–h6 boundaries). Second level.
      3. `paragraphId` — block-level text container (`p`, `li`, `div`, ...) within a section. Third level.
      4. `spineId` — physical spine file index (locator only, **not** part of the navigation tree).
    - **Rationale**: Experiment 1 showed **chapters ≠ spine files** — Gutenberg EPUBs pack many TOC chapters per spine file (9 spine files → 61 chapters). So `chapterId` must come from the TOC, and `spineId` is a physical locator, not the hierarchy.
    - **`chapter_index`** is built from the TOC: `{ chapterId, title, startIndex, endIndex }`, where `startIndex` is computed by mapping each TOC anchor (`href#fragment`) to a word index in the flat stream.
    - **Fallbacks**: EPUBs without a usable TOC fall back to spine files as chapters. Nested TOC (subitems) is flattened to one level for M1.
    - **Status**: **adopted as the working scheme**; still to be validated against more real EPUBs (varied publishers, EPUB2 ncx).

14. **Stream chunk size**
    - The `word_streams` table stores the stream as fixed-size chunks. What's the right chunk size? Trade-off: too small → many rows/queries; too large → slow incremental writes and poor lazy-loading granularity. Candidate: ~500–1000 words per chunk (a few KB of JSON each).
    - **Status**: **deferred — premature optimization.** We'll pick a concrete chunk size only once we have a working candidate stream and can benchmark. For M1, store the stream simply (even as one blob) and introduce chunking when lazy loading actually needs it.

15. **DB schema versioning & migrations**
    - If the `Word` shape or table schema changes after M1, we need a migration path.
    - **Decision**: **schema-version strategy works.** Store a `schemaVersion` in the DB; on open, if version < current, run a migration (or re-ingest if the stream shape changed). No migrations needed for M1, but the hook should exist.

16. **Adapter equivalence testing**
    - To guarantee "adapter swaps yield the same data", we need a conformance test suite that runs the same operations against every adapter and asserts identical results. This is especially important for `sql.js` vs. IndexedDB, which have different ordering/limit semantics.
    - **Decision**: **agreed — add to the testing suite and plan.** A conformance suite runs the same operations against every adapter and asserts identical results. Build it early (before M3) to catch adapter drift.

17. **Mobile memory ceiling**
    - Tauri mobile webviews on low-end devices may struggle with large in-memory `WordStream` arrays. Mitigation: rely on the chunked/lazy loading path (never materialize the whole stream on mobile), use typed arrays for numeric fields, and offload the clock to a Web Worker.
    - **Status**: **deferred — premature optimization.** Deal with this later, once mobile is actually targeted and we have real device measurements. The chunked/lazy path already exists as the foundation; no extra work now.

18. **Per-platform token maintenance**
    - "No consistent UI" means maintaining separate design tokens per platform. Strategy: define tokens as a single source of truth (one JS module per platform, derived from a shared base) rather than scattered CSS.
    - **Decision**: **not a focus for the MVP.** We cannot ensure consistent visual styling across platforms, and that's acceptable. For the MVP, use a single shared visual style; per-platform design tokens are a later polish item (M6+).

---

## Suggested Milestones

1. **M1 — Core pipeline**: Ingestion (EPUB) → normalized stream → basic pacing → simple word-flash display. ✅ *done — ingestion, pacing, display, settings wired.*
2. **M2 — Library**: Book metadata store + library view that lists books and launches the reader. ✅ *done — IndexedDB store (books + streams + reader state), import flow with SHA-256 dedupe, launch flow with cached rehydrate, cover tiles + title footer, remove-only context menu (right-click / long-press).*
3. **M3 — PDF support**: Add PDF parser; unify output with EPUB. *Not started.*
4. **M4 — Context window + highlighting**: Surrounding words, configurable window, styling. ✅ *done — adaptive + configurable window, themes.*
5. **M5 — Caching & persistence**: Cache streams, save reading position, resume from library. ✅ *done — IndexedDB-backed library + reader state (position + per-book settings), debounced writes + flush on exit/visibilitychange/pagehide.*
6. **M6 — Polish**: Settings UI, keyboard controls, accessibility, packaging. *Partial — settings UI + keyboard controls done; packaging deferred.*

### Deployment note (PWA-first)

The app is currently deployed as a **PWA** (offline-first, installable). Tauri remains a compatible shell (the same web codebase), but no native-specific persistence or dialog work is included yet. The `db` abstraction keeps the door open for a Tauri/desktop adapter later without changing Library/Reader code.