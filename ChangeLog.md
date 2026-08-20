# ChangeLog

A running log of setup, findings, and decisions for the speedreader project.

---

## 2026-08-18 — Tauri + React scaffold & headless EPUB parsing

### Environment setup (WSL)

- Linux **node v18.19.1** (`/usr/bin/node`, apt). Linux `npm` was missing.
- Installed a **user-local npm 9.9.4** at `~/.local` (symlinks `~/.local/bin/npm`, `~/.local/bin/npx`) — the apt `npm` needed sudo.
- **Gotcha**: the Windows fnm node/npm (`/mnt/c/Users/Varun/AppData/.../fnm/...`) is on PATH and **breaks npm in WSL** (Windows path resolution → `ERR_INVALID_URL`).
- Usable PATH prefix:
  ```bash
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  ```
- **Rust 1.97.1** + cargo, **tauri-cli 2.11.4** (`~/.cargo/bin`).
- Tauri Linux deps verified: `webkit2gtk-4.1`, `gtk3`, `javascriptcoregtk-4.1`, `libsoup-3.0`, `gdk-pixbuf`.

### Project scaffold (`frontend/`)

- Tauri v2 + React 19 + TypeScript + Vite, created via `npm create tauri-app@latest frontend -- --template react-ts`.
- Pins for Node 18:
  - **Vite 5** (Vite 7 requires Node ≥ 20.19).
  - **jsdom 24** (jsdom 30 requires Node ≥ 20).
- Deps added: `epubjs` (0.3.93), `jszip` (working fixture/build), `jsom/wasm`/`tsx` (dev), `@tauri-apps/api` v2.
- Both `npm run build` and `cargo check` (in `src-tauri`) pass.

### EPUB exploration module (`frontend/src/epub/`)

- `types.ts` — flexible `Word` model from the plan:
  ```ts
  interface Word { text: string; index: number; metadata: Metadata[]; }
  interface Metadata { attribute: string; value: string | number; }
  ```
- `explore.ts` — `openBook()`, `exploreEpub()` (metadata/spine/TOC/per-chapter text via epubjs), `toWordStream()` (→ flat word stream + chapter index).
- `EpubExplorer.tsx` — React UI (file picker) rendering the structure. `App.tsx` mounts it.

### Headless parsing loop (no GUI needed)

```bash
cd frontend
npx tsx experiments/explore-epub.mts <path.epub>
# real book:
npx tsx experiments/explore-epub.mts ../epubs/prideandprejudice.epub
# toy fixture:
npx tsx experiments/explore-epub.mts experiments/fixtures/toy.epub
```

- `experiments/dom-shim.mts` — jsdom shim so epubjs can run in Node (sets `window`, `document`, `navigator`, `XMLHttpRequest`, `window.URL.createObjectURL/revokeObjectURL` stubs).
- `experiments/fixture-epub.mts` + `experiments/fixtures/toy.epub` — a minimal valid EPUB2/3 built with jszip for fast isolated tests.

### epubjs API gotchas (recorded for future work)

- `ePub(ArrayBuffer)` with **no** `encoding` option → auto-detects `BINARY`, unzips in-memory, **no network**. Do **not** set `{ encoding: "base64" }` (misclassifies raw bytes → XHR/ECONNREFUSED).
- Spine sections are exposed at runtime via `book.spine.spineItems` (not in public type defs — cast/interface).
- `section.load(book.load.bind(book))` returns the **`<html>` element**, not a `Document` — read `html.textContent` directly; `doc.body` is `undefined`.
- epubjs is CJS; `ePub` may be the constructor or under `.default` — normalized via a `EpubBook` interface.

### Verified on a real EPUB — Pride and Prejudice (Gutenberg #1342)

- Parse ~360–400ms.
- **Metadata**: title, creator (Jane Austen), language, Gutenberg id, pubdate, rights.
- **Spine**: 9 items in reading order (cover wrapper, pg-header, 6 content chunks, pg-footer, cover image).
- **Navigation/TOC**: 61 entries.
- **Word stream**: 130,087 words, avg length 4.64, 9 spine-level chapters.
- **Key finding**: **chapters ≠ spine files**. Gutenberg EPUBs pack many chapters per spine item. So `chapterId = spine index` is the wrong granularity; real chapter navigation must parse the **TOC/nav** and map chapter anchors (`href#fragment`) to word ranges. This feeds open question #13 (structural metadata scheme).

### Files created this session

```
experiments/experiment_1_epubformat.md   # experiment write-up
frontend/experiments/explore-epub.mts    # headless parse runner
frontend/experiments/dom-shim.mts        # jsdom browser shim
frontend/experiments/fixture-epub.mts    # toy epub builder (jszip)
frontend/experiments/fixtures/toy.epub   # generated fixture
frontend/src/epub/types.ts               # flexible Word model
frontend/src/epub/explore.ts             # epubjs exploration
frontend/src/epub/EpubExplorer.tsx       # React UI
frontend/src/App.tsx                     # mounts EpubExplorer
```

## 2026-08-20 — Engine modules, reading-view display & settings UI polish

### Ingestion pipeline (`frontend/src/ingestion/`)

- `types.ts` — `Parser` interface (structural typing, no abstract classes), `FileInfo`, `UnsupportedFormatError`.
- `engine.ts` — `IngestionEngine` dispatcher (registers parsers, picks by extension).
- `epub-parser.ts` — `EpubParser` implements `Parser`; extracts TOC + spine, maps chapters to word ranges, assigns `chapterId`/`sectionId`/`paragraphId`/`spineId` metadata order.
- `cleanChapterTitle` heuristic — Gutenberg epigraph noise in chapter titles: uses the last matching `/^(chapter|ch\.?)\s+[0-9ivxlcdm]+\.?$/i` line, else the TOC label.
- `normalize.ts` — `buildChapterIndex`, `assignChapterIds`, `computeMeta` (word count, avg length, chapter list).
- `file-source.ts` — `pickFileBrowser`/`fileFromBrowserFile`/`extensionOf`.
- **Verified**: P&P 130,436 words, 63 chapters, metadata order `[chapterId, sectionId, paragraphId, spineId]` PASS (headless `tsx` tests in `experiments/test-ingestion.mts`).

### Pacing engine (`frontend/src/pacing/`)

- `types.ts` — pluggable `PacingFn` (`(ctx) => durationMs per word`), `PacingProfile`, `PacingBackend`.
- `naive.ts` — `naiveBackend`: `base = 60/wpm*1000` + 150ms sentence pause + 200ms paragraph pause.
- `engine.ts` — `PacingEngine.duration/durations`; `select.ts` — backend registry/selection.
- **Verified**: 600wpm → 100ms base (experiments/test-pacing.mts).

### Settings system (`frontend/src/settings/`)

- `types.ts` — 4 themes (`light`/`dark`/`sepia`/`high-contrast`), `GlobalSettings`, per-reader `ReaderSettings` overrides, `mergeSettings`.
- `themes.ts` — `themeTokens` as single source of truth (`bg/fg/muted/highlight/highlightFg/panel/border/hover/active/activeFg`).
- `store.ts` — `SettingsStore` with `localStorage` persistence + subscribe; global vs per-book (`book-…`) overrides.
- `SettingsPanel.tsx` / `SettingsModal.tsx` — reusable form + glassmorphism modal (blurred overlay, click-outside + Escape close), mounted in both library and reader views.

### Navigation (`frontend/src/navigation/`)

- `tree.ts` — `buildNavTree` from word metadata (dynamic depth), `findNodePath` (auto-follow active chapter).
- `NavTreeView.tsx` — collapsible left sidebar, click-to-seek, starts collapsed.

### Display: reading-view (`frontend/src/display/SpeedReader.tsx`)

- **Abandoned Pretext/canvas** (canvas can't wrap; DOM measurement mismatch) → DOM-only reading view.
- Wrapped text block with the **current word highlighted inline** (pill), pinned to **exact viewport center** via `translate` with accumulated offset state.
- `useLayoutEffect` for offset measurement → no "shadow" highlight flash.
- **Stable chunks** (400 words, refresh margin 100): no reflow/jitter while reading.
- `SelfCorrectingClock` (`clock.ts`) — `performance.now()` drift-compensated ticks, pause/resume/seek.
- `SpeedReader` root `height: 100vh` **fixed** — it now fills its parent (`height: 100%`); `ReaderApp` switched to a `100vh` flex column (top bar `flexShrink: 0`, reader `flex: 1; minHeight: 0`). Killed the **permanent page scrollbar** caused by `calc(100vh - 42px)` + inner `100vh` overflow.

### Polish (glassmorphism + controls)

- Settings card background is now **theme-aware** (`{t.panel}e6`, ~90% alpha) instead of fixed translucent white — fonts were unreadable on some themes.
- New global `.glass-scroll` class: thin (6px), translucent rounded thumbs, transparent track; applied to the settings modal and nav tree (`scrollbar-width: thin` for Firefox; single definition in `App.css`).
- `SettingsPanel` native controls restyled with `appearance: none` + custom SVG chevron, theme `panel`/`fg`/`border` backgrounds — **no more stark white select boxes** in any theme; sliders/checkbox use `accentColor: theme.highlight`.
- **Seekable progress bar**: static bar → `SeekBar` component (click + drag + capture, `touch-action: none`, keyboard `←`/`→`/`Home``/``End`, `role="slider"`). Works over the full word stream.
- Scrub → **synchronous re-chunk**: new `jumpTo()` updates frame + chunkStart + progress in one batched render so the highlighted word is always visible/centered immediately after seeking (no empty-center flash).

### Experiment artifacts (kept in `frontend/experiments/`)

- `test-ingestion.mts`, `test-pacing.mts`, `test-display.mts`, `test-navtree.mts`, `test-pretext.mts` — headless module conformance checks.