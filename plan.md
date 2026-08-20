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
- **Responsibility**: Accept an uploaded file, parse it, and emit a single normalized stream of words regardless of source format.
- **Interface**: `ingest(file) → WordStream`
  - `WordStream` is an ordered, indexable sequence of words.
  - Each word carries **flexible structural metadata** (see Option B below): `{ text, index, metadata: Metadata[] }` where the ordered metadata list determines the hierarchy.
- **Format parsers** (pluggable):
  - **EPUB**: unzip container, parse `content.opf` for spine/reading order, extract XHTML chapters, strip markup, split into words. **Chapters are derived from the TOC/nav, not the spine files** (see open question #13) — spine files act as physical locators.
  - **PDF**: extract text per page (via a library like `pdf-parse` or `pdfjs-dist`), preserve page boundaries as structural markers.
  - Future: MOBI, TXT, HTML, DOCX.
- **Output**: a canonical, format-agnostic stream. This is the single source of truth for everything downstream.
- **Stream model — flat, tagged words (Option B)**:
  - The stream is a **single flat, ordered array of `Word` objects** — homogeneous, streamable, and cacheable as one blob.
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
    ```
  - **The list of metadata and its order determine the hierarchy.** The array is ordered **most-important → least-important** (top of the navigation tree → leaf). For example, `[{ chapterId: 1 }, { sectionId: 1 }]` means "chapter 1, section 1" — the navigation tree renders `chapterId` as the top level and `sectionId` nested under it. This enables **dynamic hierarchical navigation** derived from whatever attributes a format provides, and does **not** enforce an ebook structure on other formats.
  - **Navigation tree depth = metadata array length.** The first attribute is the root level of the tree; each subsequent attribute is one level deeper. Attributes later in the array are finer-grained (e.g., paragraph < section < chapter).
  - Because the hierarchy is data-driven, navigation (chapter jumps, TOC, progress) is built by scanning the metadata, not by assuming fixed fields. The `chapter_index` table is derived from whichever attribute is designated as the "chapter" level per format.
  - **Note**: this interface is a starting point and **can change** — the exact metadata scheme is an open design question (see open question #13) to be settled empirically during ingestion work.
- **Determinism scope**: determinism (same bytes → same stream) applies to the **local, self-contained parsers** (EPUB, plain-text PDF). Formats that depend on **external services or on-demand extraction** (scanned PDFs, dynamic content) are explicitly **non-deterministic** — their streams are marked `isDeterministic: false` and are cached for performance but not treated as reproducible.

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
  - **Lazy-stream bootstrapping**: `avgWordLength`/`totalWords` are computed from the currently materialized portion of the stream; for lazy streams the engine starts with a running estimate and refines it as more of the stream loads.
- **Pluggable backends** (all implement `PacingFn`):
  - **Default length-based**: `base = 60 / WPM`, scaled by character count (e.g., `* (1 + (len - 4) * 0.02)`), plus fixed pauses at sentence/paragraph boundaries.
  - **Syllable splitting**: estimate reading time from phoneme/syllable counts rather than raw length.
  - **Bayesian conjugate model**: models per-character time as a distribution and updates its posterior as words stream in — so pacing adapts to the book's average word length and difficulty over time.
  - Future: frequency/difficulty-based, ML-driven, etc.
- **Selection**: a `selectBackend(name)` factory picks a backend and optional `PacingProfile` at startup; users can tune profile aggressiveness.
- **Interface**: `engine.getDuration(backend, word, ctx) → ms`, `backend.name`.
- **Open question**: tokenizer/punctuation pauses are shared concerns — should they live in a base backend or be composed as decorators around the core timing function?

#### 4. Display Component
- **Responsibility**: Render the current word and surrounding context, driven by the pacing engine's clock.
- **Features**:
  - **Current word** highlighted (color/style change) — the focal point.
  - **Surrounding words** shown before/after (adaptive + configurable window, see open question #3).
  - **Clock**: a **self-correcting timer** using `performance.now()` to measure elapsed time and schedule the next tick, compensating for `setInterval`/`setTimeout` drift. A Web Worker can drive the clock so it keeps accurate time even when the tab is backgrounded.
  - **Controls**: play/pause, seek, speed adjustment, jump to chapter.
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

- **Book identity**: `bookId = hash(fileBytes)` (SHA-256 via `crypto.subtle`). Deterministic — re-importing the same file **dedupes** instead of duplicating. `parserVersion` is stored with each book so a parser change triggers re-ingest.
- **Metadata extraction**: the `Parser` interface gains an optional `getBookInfo(file) → { title, author }`. `EpubParser` implements it via `book.loaded.metadata` (title, creator); fallback is the filename.
- **Storage — IndexedDB (first `db` adapter)**:
  - **Why IndexedDB, not localStorage**: localStorage has a ~5MB limit; a 130k-word stream is ~1.5–2MB JSON, so multiple books exceed it. IndexedDB handles large blobs, is async, and uses structured clone.
  - DB `speedreader`, object stores:
    - `books` (keyPath `id`) — metadata: title, author, format, addedAt, wordCount, chapterCount.
    - `streams` (keyPath `bookId`) — the full `WordStream` (words + chapterIndex + meta).
  - Settings stay in localStorage (small). This is the foundation of the `db` abstraction (IndexedDB adapter).
- **Import flow**: pick file → `engine.ingest(file)` → `WordStream` → `parser.getBookInfo(file)` → title/author → `bookId = hash(bytes)` → `libraryStore.addBook(book, stream)` → library refreshes.
- **Launch flow**: click book → `libraryStore.getStream(bookId)` → **cached** = instant rehydrate (no re-parse); **missing** (parser version bump) = prompt re-import (storing source bytes deferred) → mount `SpeedReader`.
- **Deferred**: storing source file bytes (enables automatic re-ingest on parser change), cover images, per-book progress display (M5).

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
- `saveStreamChunk(bookId, chunkIndex, words)` / `appendStreamChunk(bookId, words)` — store the stream incrementally as fixed-size chunks.
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
├── server/                 # Node.js backend
│   ├── index.js            # Express app
│   ├── routes/books.js
│   └── cache/              # SQLite / disk cache
├── src/                    # Shared / frontend code
│   ├── db/
│   │   ├── index.js        # factory: createDb(type)
│   │   ├── server-sqlite.js  # better-sqlite3 adapter (backend)
│   │   ├── wasm-sqlite.js    # sql.js adapter (browser)
│   │   ├── indexeddb.js      # IndexedDB adapter (browser)
│   │   └── schema.js         # shared table/object-store schema
│   ├── ingestion/
│   │   ├── index.js        # dispatcher
│   │   ├── epub.js
│   │   ├── pdf.js
│   │   └── normalize.js    # → WordStream
│   ├── pacing/
│   │   ├── engine.js       # calls PacingFn, manages clock
│   │   ├── select.js       # selectBackend(name) factory
│   │   ├── length.js       # default length-based backend
│   │   ├── syllables.js    # syllable-splitting backend
│   │   └── bayesian.js     # Bayesian conjugate model backend
│   ├── display/
│   │   ├── renderer.js     # word + context rendering
│   │   └── clock.js        # timer loop
│   ├── settings/
│   │   ├── types.js        # GlobalSettings, ReaderSettings, merge
│   │   ├── store.js        # SettingsStore (global + per-reader, persisted)
│   │   └── SettingsPanel.jsx # reusable settings form
│   ├── library/
│   │   ├── types.js        # Book metadata
│   │   ├── store.js        # LibraryStore (IndexedDB: books + streams)
│   │   └── LibraryView.jsx # grid/list UI + import + launch
│   ├── db/
│   │   ├── index.js        # factory: createDb(type)
│   │   ├── indexeddb.js    # IndexedDB adapter (browser) — first adapter
│   │   ├── wasm-sqlite.js  # sql.js adapter (browser, later)
│   │   ├── server-sqlite.js  # better-sqlite3 adapter (backend, later)
│   │   └── schema.js       # shared table/object-store schema
│   ├── reader/
│   │   ├── reader.js       # one Reader per book (init/reinit from SQLite)
│   │   └── view.js         # reader UI (word flash, controls)
│   ├── platform/
│   │   ├── detect.js       # OS/platform detection
│   │   └── tokens.js       # per-platform design tokens (fonts, colors, spacing)
│   └── ui/
│       ├── app.js            # root: library hosts reader views
│       └── components/       # controls, settings
├── public/                 # static assets
├── src-tauri/              # Tauri shell + Rust commands (desktop + mobile)
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

7. **PDF specifics**
   - PDFs are page-based and often have multi-column layouts. Do we extract text in reading order, or just page order? How to handle scanned/image-only PDFs (OCR needed)?
   - **Decision direction**: complex PDF extraction (multi-column reading order, scanned/image-only documents) may rely on **external services** — e.g., **MarkItDown** or **VLM-based text extraction** (vision-language-model OCR + layout). This is a **future endeavor** and is handled entirely **inside the Ingestion component** — the parser for PDFs is a facade that can call a local extractor *or* a remote service, both producing the same flat `WordStream`. The rest of the app (Reader, Display, Library) is unaware.
   - **Concern — pricing / membership**: external extraction services may cost money. Plan for a **pricing model or memberships** (e.g., free tier covers EPUB and plain-text PDFs; premium tier unlocks ML/OCR extraction). Core functionality — **EPUB and normal text-based books** — must remain fully free and local. Long-term: consider a graceful degradation path where scanned PDFs show a clear upgrade prompt instead of failing.

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

1. **M1 — Core pipeline**: Ingestion (EPUB) → normalized stream → basic pacing → simple word-flash display. ✅ *mostly done — ingestion, pacing, display, settings wired.*
2. **M2 — Library**: Book metadata store + library view that lists books and launches the reader. **In progress** — IndexedDB store (books + streams), import flow with hash-based dedupe, launch flow with cached rehydrate.
3. **M3 — PDF support**: Add PDF parser; unify output with EPUB.
4. **M4 — Context window + highlighting**: Surrounding words, configurable window, styling. ✅ *done — adaptive + configurable window, themes.*
5. **M5 — Caching & persistence**: Cache streams, save reading position, resume from library.
6. **M6 — Polish**: Settings UI, keyboard controls, accessibility, packaging.