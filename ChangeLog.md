# ChangeLog

A running log of setup, findings, and decisions for the speedreader project.

---

## 2026-08-25 — Native reader gesture boundaries

- **Traditional/native reader mode**: Removed RSVP horizontal swipe scrubbing from the scrollable reader. It now uses normal vertical browser scrolling only.
- **Vertical entry gesture**: A paused vertical swipe from RSVP enters native reading with the current word centered, followed by a small, capped directional nudge. Subsequent gestures scroll normally, so the entry gesture cannot carry the reader far away from the current position.
- **Display experiment**: Added pure coverage for the capped entry-scroll calculation.

---

## 2026-08-25 — Tolerant PDF.js multi-column imports

- **`PdfJsParser`**: Multi-column PDFs with a native text layer now proceed through PDF.js extraction instead of being rejected. Their reading order can be inaccurate, so the parser records a non-fatal warning. Image-only PDFs and unsupported text directions remain blocked because they cannot yield reliable local text.
- **Library import UI**: The warning is shown immediately after import and persists as a “Check layout” badge on the book tile.
- **PDF ingestion experiment**: Added coverage for the tolerated multi-column policy.

---

## 2026-08-25 — Register PDF.js ingestion in the app

- **`ReaderApp.tsx`**: Registered `PdfJsParser` alongside `EpubParser` in the application’s `IngestionEngine`. PDF files selected from the library can now reach the conservative PDF.js ingestion path rather than failing with “No parser registered”.

---

## 2026-08-24 — Dynamic word streams & InteractiveFormat architecture

- **`epub/types.ts` & `ingestion/types.ts`**:
  - Expanded `StreamMeta` with streaming lifecycle flags (`isComplete?: boolean`, `totalWordsExpected?: number`).
- **`ingestion/interactive.ts` (new)**:
  - Added `InteractiveFormat` contract for asynchronous, interactive, or background streams (e.g. PDF page-by-page OCR, LLM interactive generation).
  - Added `appendToWordStream()` helper to merge incoming word chunks, reindex global monotonic indices, and update TOC/chapter entries incrementally.
- **`db/` & `library/store.ts`**:
  - Added `appendStreamWords()` and `appendWords()` for incremental stream persistence in IndexedDB.
  - Added polymorphic `formatState` property to `Book` and `ReaderState` so interactive format subclasses can save and restore their processing cursors (e.g., current page, token checkpoints) independently of the reader's word position.
- **`display/clock.ts` & `pacing/engine.ts`**:
  - Added `appendDurations()` to `SelfCorrectingClock` and `durationsForChunk()` to `PacingEngine` for seamless live RSVP continuation as words arrive in the background.
- **`experiments/test-dynamic-stream.mts` (new)**:
  - Added comprehensive simulation and verification suite for background chunk ingestion, dynamic clock extension, and resumption state persistence.
- Verified: `npx tsc --noEmit`, `npm run build`, and all test suites pass.

---

## 2026-08-24 — Clean fullscreen reading mode & UI polish

- **Default collapsed left sidebar**: The navigation tree starts collapsed by default when opening a book, providing an immediate full-width reading view.
- **Enlarged touch targets on mobile**:
  - Increased the sidebar toggle rail size ($36\text{px} \times 48\text{px}$) with an elevated glassmorphic handle and larger chevron icon.
  - Increased the bottom control bar collapse/expand handle touch height ($38\text{px}$) and typography on mobile.
- **Distraction-free auto-hide while playing**:
  - When playback starts, the top title bar, left navigation drawer, and bottom controls smoothly hide (animated opacity and height transitions with `pointer-events: none`).
  - When the reader is paused (via screen tap, seek, or keypress), all drawers, headers, and expansion controls reappear instantly.
- Verified: `npx tsc --noEmit`, `npm run build`, and all test suites pass.

---

## 2026-08-24 — Fix word spacing in traditional view

- **`display/SpeedReader.tsx`**: Fixed missing inter-word whitespace in the traditional e-reader view caused by HTML whitespace collapsing between `inline-block` spans. Added explicit inter-word space nodes between rendered word spans.
- Verified: `npx tsc --noEmit`, `npm run build`, and all experiment test suites pass.

---

## 2026-08-24 — Settings panel latest changelog display

- **`settings/changelog.ts`**: Added parser utility to dynamically extract the latest changelog entry (title, release date, and detailed bullet points) from `ChangeLog.md`.
- **`settings/SettingsPanel.tsx`**: Added a collapsible "View Latest Changelog" button and glassmorphic card display inside the settings panel.
- Verified: `npx tsc --noEmit`, `npm run build`, and all test suites pass.

---

## 2026-08-24 — Traditional view word long-press & context menu

- **`display/WordContextMenu.tsx`**: Created a themed glassmorphic context menu for words in traditional view offering **"Set Position Here"** (updates reading playhead while remaining in traditional view) and **"Jump & Resume RSVP"** (updates position and immediately resumes RSVP speedreading).
- **`display/SpeedReader.tsx`**:
  - Implemented event-delegated pointer tracking with a $400\text{ms}$ long-press detection and $>8\text{px}$ movement cancellation to prevent scroll conflicts.
  - Added desktop right-click (`onContextMenu`) support for words in traditional view.
  - Added haptic feedback (`navigator.vibrate`) upon long-press activation on supported mobile devices.
  - Suppressed tap-to-resume click triggers when invoking or interacting with the context menu.
- Verified: `npx tsc --noEmit`, `npm run build`, and all test suites pass.

---

## 2026-08-24 — Infinite scrolling in traditional view & tap-to-resume RSVP

- **`display/SpeedReader.tsx`**:
  - Implemented bidirectional infinite scrolling in traditional e-reader mode (`traditionalRange` with dynamic loading at top and bottom thresholds while preserving scroll offset).
  - Tapping/clicking anywhere in the traditional view canvas immediately starts playback and transitions seamlessly back to centered RSVP mode from the current word position.
- Verified: `npx tsc --noEmit`, `npm run build`, and all test suites pass.

---

## 2026-08-24 — Paused traditional e-reader view mode

- **`display/types.ts`**: Added `ReaderViewMode = "rsvp" | "traditional"`.
- **`display/SpeedReader.tsx`**:
  - Implemented vertical swipe gesture detection (swiping up/down with $|\Delta y| \ge 1.2 \cdot |\Delta x|$ and $\ge 36\text{px}$) when playback is paused to switch into traditional e-reader scrollable view.
  - Traditional view displays the stable chunk block with full surrounding context in normal vertical scrollable document flow, with the current word highlighted and auto-scrolled to center.
  - Transitions are presentation-only: they do not affect or reset the pacing engine, clock position, or saved reading progress.
  - Toggling play or clicking "Return to RSVP" immediately switches back to centered RSVP mode and continues playback from the exact same word index.
- Verified: `npx tsc --noEmit`, `npm run build`, and all experiment test suites pass.

---

## 2026-08-24 — Smooth swipe scrubbing reimplementation

- **`display/SpeedReader.tsx`**:
  - Reimplemented the swipe gesture handler with explicit pointer capture and horizontal/vertical direction locking.
  - Eliminated unbounded visual dragging and centering jitter by decoupling the preview updates from `clock.seek()`.
  - Added RAF-throttled preview frames (`previewIndex()`) during drag so words update at screen refresh rate without restarting clocks or firing high-frequency persistence writes.
  - Applied bounded logarithmic elastic pull ($\le 48\text{px}$) during swipe so words remain visible and centered on screen.
  - Applied smoothed release momentum and committed a single `jumpTo()` at release while remaining paused at the destination.
  - Fixed click-to-play bubbling interference by cleanly suppressing tap toggles whenever a swipe gesture was locked or active.
- Verified: `npx tsc --noEmit`, `npm run build`, and all experiment test suites pass.

---

## 2026-08-24 — Aggressive PWA Service Worker updates

- **`vite.config.ts`**: Enabled `workbox.skipWaiting = true` and `workbox.clientsClaim = true` so newly installed service workers immediately bypass the waiting phase and claim all active client tabs.
- **`src/main.tsx`**:
  - `onNeedRefresh`: Immediately calls `updateSW(true)` to trigger an automatic refresh when an update is available.
  - Periodic update check: polls `registration.update()` every 30 minutes.
  - Active check on tab focus: invokes `registration.update()` on `window.onfocus` and `visibilitychange` (when tab becomes visible).
  - Listens for `navigator.serviceWorker.oncontrollerchange` to reload the window immediately once the new worker takes control.
- **`src/vite-env.d.ts`**: Updated module type declaration for `virtual:pwa-register` options and return signature.
- Verified: `npx tsc --noEmit`, `npm run build` (verified `self.skipWaiting()` and `e.clientsClaim()` in `dist/sw.js`), and all experiment test suites pass.

---

## 2026-08-24 — Glassmorphism styling, library search bar & settings button

- **Glassmorphic library UI (`LibraryView.tsx`)**:
  - Replaced flat material styling with frosted glassmorphism: translucent theme surfaces (`backdrop-filter: blur(...)`, border highlights, ambient radial gradients).
  - Hover effects on cards with smooth transforms, elevated shadows, and theme accent borders.
  - Decorative ambient glass badge on generated title cards.
- **Search bar**:
  - Added a search input in the sticky glass header to filter library books by title or author in real time.
  - Clear button and "No matching books" feedback state.
- **Global Settings in Library**:
  - Wired the global Settings button (`⚙️`) into the library header and connected `SettingsModal` through `ReaderApp.tsx`, enabling theme and typography adjustments directly from the library view.
- Verified: `npx tsc --noEmit`, `npm run build`, and all test suites pass.

---

## 2026-08-24 — Configurable Bayesian gamma discounting

- **`settings/types.ts`**: Added `bayesianGamma: number` to `GlobalSettings` and `DEFAULT_GLOBAL_SETTINGS` (default `0.98`).
- **`settings/SettingsPanel.tsx`**: Added a slider control for `bayesianGamma` (range `0.90`–`0.999`, step `0.005`) that dynamically appears when the Bayesian pacing model is selected, showing both the decimal value and the approximate effective word window ($N_{\text{eff}} \approx \frac{1}{1-\gamma}$).
- **`pacing/bayesian.ts` & `pacing/select.ts`**: Updated `createBayesianPacingFn` to honor context/option-level gamma overrides during runtime updates.
- **`reader/ReaderScreen.tsx`**: Wired `settings.bayesianGamma` directly into the `PacingEngine` instantiation.
- **`experiments/test-bayesian-pacing.mts`**: Added unit verification for fast ($\gamma = 0.90$) vs. slow ($\gamma = 0.995$) adaptation rates.
- Verified: `npx tsc --noEmit`, `npm run build`, and all experiment test suites pass.

---

## 2026-08-23 — Full-width collapsible bottom drawer & jump-to-word UX

- **Full-width bottom drawer**: Reorganized `SpeedReader.tsx` layout into a vertical flex container. The collapsible bottom drawer is now a full-width bottom bar (spanning 100% of the viewport width when the left navigation drawer is collapsed).
- **Collapsible on both desktop and mobile**: Added an interactive toggle handle to minimize / expand the bottom controls across all screen sizes.
- **Scrubber jumping fix**: Fixed horizontal layout jumping by moving the word count percentage label to sit **after** the `SeekBar` scrubber rather than before it.
- **Jump to word number dialog**:
  - Clicking the word count label (`word X / Y (Z%)`) opens an interactive "Jump to Word" dialog/modal.
  - On mobile devices, utilizes numeric keyboard inputs (`inputMode="numeric"`, `pattern="[0-9]*"`).
  - Handles bounds checking gracefully (values $\le 1$ jump to the beginning, values $\ge \text{total}$ jump to the end).
- Verified: `npx tsc --noEmit`, `npm run build`, and all test suites pass.

---

## 2026-08-23 — Added Bayesian conjugate adaptive pacing model

- **`pacing/bayesian.ts`** — implemented online Bayesian parameter estimation with exponential memory discounting (Shifted Poisson–Gamma model).
  - Prior: $\lambda \sim \text{Gamma}(\alpha_0 = 50, \beta_0 = 10) \implies \hat{\mu}_0 = 6.0\text{ chars/word}$.
  - Discount factor: $\gamma = 0.98$ ($\approx 50$-word effective window).
  - Online step: computes local $\hat{\mu}_t = 1 + \frac{\alpha_{t-1}}{\beta_{t-1}}$, assigns base duration $T_t = \frac{60000}{W \cdot \hat{\mu}_t} \cdot L_t$ (ms) plus boundary pauses, then updates $\alpha_t = \gamma \alpha_{t-1} + (L_t - 1)$ and $\beta_t = \gamma \beta_{t-1} + 1$.
- **`pacing/select.ts` & `pacing/index.ts`** — registered `bayesian` alongside `naive` in the backend registry.
- **`settings/` & `reader/`** — added `pacingModel: "naive" | "bayesian"` to settings and UI dropdown in `SettingsPanel.tsx`, wired into `ReaderScreen.tsx`.
- **`experiments/test-bayesian-pacing.mts`** — synthetic and full-book test suite verifying math, discounting, resets, and throughput stability on *Pride and Prejudice*.
- Verified: `npx tsc --noEmit`, `npm run build`, and all experiment test suites pass.

---

## 2026-08-23 — PWA library import, cover tiles, and durable reader state

- **PWA-first library**: replaced the single-open-book flow with an IndexedDB-backed library. Books persist across reloads and offline reopen.
- **`db/` module (new)** — `types.ts` defines the async `Db` interface (`getBook`/`getBooks`/`addBook`/`updateBook`/`deleteBook`, `getStream`/`saveStream`, `getReaderState`/`saveReaderState`/`deleteReaderState`, `deleteBookCascade`). `indexeddb.ts` is the first adapter (versioned DB `speedreader`, stores `books`/`streams`/`readerStates`). `index.ts` is the `createDb()` factory.
- **`library/` module (new)** — `hash.ts` (SHA-256 book id via `crypto.subtle`), `types.ts` (`Book`, `ImportResult`, `OpenableBook`), `store.ts` (`LibraryStore`: import with dedupe, list, open-by-id cached rehydrate, reader-state get/save, cascade remove). `LibraryView.tsx` renders the grid, empty/loading/error states, cover tiles, title footer, and progress badge.
- **Cover extraction** — `Parser.getBookInfo(file) → { title, author, cover? }` added to `ingestion/types.ts`; `EpubParser.getBookInfo` reads title/creator from package metadata and cover art via `book.loaded.cover` → `archive.getBlob`. Books without a usable cover render a deterministic styled **title card**; a **title footer** shows on every tile.
- **Remove-only context menu** — `ContextMenu.tsx` (right-click on desktop, ~500ms long-press on touch, cancels on movement/release/cancel) + `ConfirmDialog.tsx` (confirmation required). Confirmed removal cascades through book + stream + reader state in one IndexedDB transaction.
- **Reader rehydration** — `ReaderApp.tsx` is now the coordinator: loads the library on mount, imports (opens fresh imports immediately), opens cached streams, hydrates saved position + per-book settings, and persists position **debounced (500ms)** plus flushed on reader exit / `visibilitychange` (hidden) / `pagehide`. Playback opens **paused** at the saved index.
- **Settings split** — `settings/store.ts` now holds **global** settings only (localStorage, synchronous for startup). Per-book settings + positions moved to IndexedDB keyed by the SHA-256 book id (replacing the old synthetic `book-…` id and the `speedreader.positions.v1` localStorage key).
- **Decisions**: PWA-first/offline-first is the target; Tauri remains a compatible shell with no native-specific work. EPUB is the only import format for now. Old synthetic localStorage positions can't be safely mapped to SHA-256 ids, so they're not migrated.
- Verified: `npx tsc --noEmit` + `npm run build` pass (PWA v1.3.0, 15 precached entries).

---

## 2026-08-23 — Fixed reader position resets

- **`display/SpeedReader.tsx`** — seeds each newly created `SelfCorrectingClock` with the current/restored index. Previously, a paused clock retained its internal default index of `0`, so changing WPM or another pacing setting could display the saved word briefly but resume from the beginning.
- **`ReaderApp.tsx`** — serializes IndexedDB reader-state writes, clears pending debounce timers when leaving a reader, and awaits the final state flush before returning to the library. This prevents an older asynchronous write from overwriting a newer position.
- **`experiments/test-display.mts`** — added a regression check for restoring and resuming from a non-zero paused index.
- Verified: display regression test, `npx tsc --noEmit`, and `npm run build` pass. The PWA build continues to generate the service worker and precache entries.

---

## 2026-08-21 — Reader state persistence (resume position)

- Books now **resume where you left off**: reopening an EPUB jumps to the saved word index.
- **`settings/types.ts`** — added `ReaderPosition { index, updatedAt }` + `ReaderStateMap`.
- **`settings/store.ts`** — `SettingsStore` now persists per-book positions under a **separate** localStorage key (`speedreader.positions.v1`): `getPosition` / `setPosition` / `clearPosition` / `allPositions`.
- **`display/SpeedReader.tsx`** — new props `initialIndex` (clock starts there instead of 0) and `onPositionChange` (fired on tick + seek/scrub/nav-tree jumps).
- **`ReaderApp.tsx`** — passes `initialIndex` from the store on open; saves via `onPositionChange` on every index change.
- **Decisions**: positions stored separately from settings; playback starts **paused** at the saved position (user taps play); position kept when returning to library.
- Verified: `tsc --noEmit` + `npm run build` pass.

---

## 2026-08-21 — Security hardening (Dependabot, CodeQL, least-privilege)

- **`.github/dependabot.yml`** — weekly updates for npm (`/frontend`), Cargo (`/frontend/src-tauri`), and GitHub Actions (`/`), each with `dependencies` labels and `chore(deps)` commit prefixes.
- **`.github/workflows/codeql.yml`** — CodeQL static analysis for `javascript-typescript` + `rust`, run on push/PR to `main`, weekly (Mon 06:00 UTC), and manual dispatch. `security-events: write` on the analyze job; `contents: read` at workflow level.
- **Least-privilege permissions** — added `permissions: contents: read` to `build-android.yml` and `build-ios.yml` (they only build + upload artifacts). `build-desktop.yml` already had `contents: write` (needed for releases); `deploy-pages.yml` already had `pages: write` + `id-token: write`.
- **Token push protection** — this is a **repo setting**, not a file: enable in **Settings → Code security and analysis → Secret scanning → Push protection** (free for public repos). Blocks commits containing known secrets (API keys, tokens) before they land.

---

## 2026-08-21 — GitHub Pages deploy for the PWA

- Added `.github/workflows/deploy-pages.yml` — builds the frontend and deploys `dist/` to **GitHub Pages** on every push to `main` (and manual dispatch). Uses `actions/upload-pages-artifact@v3` + `actions/deploy-pages@v4`, with `permissions: pages: write, id-token: write` and a `github-pages` environment.
- **Base path handling**: GitHub Pages serves the repo at a subpath (`/speedreader/`), so `vite.config.ts` now sets `base: process.env.GITHUB_ACTIONS ? "/speedreader/" : "/"` — Pages builds get the subpath, Tauri builds keep root.
- **Relative PWA paths**: manifest `start_url`/`scope`/icons and the `apple-touch-icon` link are now **relative** (`./`, `pwa-*.png`) so they resolve under any base path. The manifest `<link>` is injected by `vite-plugin-pwa` (removed the manual duplicate).
- **iOS standalone file-picker fix**: `pickFileBrowser` now appends the hidden `<input>` to `document.body` before `.click()` — a detached input's click is silently ignored in iOS home-screen (standalone) PWAs, so the EPUB picker never opened after install. Attaching it fixes loading books in the installed app.
- Verified: `tsc --noEmit` OK; `GITHUB_ACTIONS=true npm run build` emits `/speedreader/`-prefixed assets + `sw.js`; workflow YAML valid.
- **To activate**: enable Pages in repo Settings → Pages → Source "GitHub Actions", then push to `main`. Site at `https://vbprojects.github.io/speedreader/`.

---

## 2026-08-21 — Node 22 upgrade + standard vite-plugin-pwa

- **Upgraded to Node 22.23.2** via nvm (`nvm install 22`, `nvm alias default 22`; auto-loads in `.bashrc`). User-local, no sudo — avoids the Windows fnm path trap.
- **CI bumped to `node-version: 22`** in all three workflows (`build-desktop.yml`, `build-android.yml`, `build-ios.yml`).
- **Replaced the hand-rolled SW with `vite-plugin-pwa@1.3.0`** (now that Node 22 supports it):
  - `vite.config.ts` — `VitePWA` plugin: `registerType: "autoUpdate"`, `devOptions: { enabled: false }`, `injectRegister: false` (we call `registerSW()` ourselves), full manifest, workbox precache (`globPatterns`, `navigateFallback: /index.html`, `cleanupOutdatedCaches`).
  - `src/main.tsx` — `registerSW({ immediate: true })` from `virtual:pwa-register`, guarded by `!("__TAURI_INTERNALS__" in window)` (no SW inside Tauri webview).
  - `src/vite-env.d.ts` — `virtual:pwa-register` module declaration.
  - Deleted `public/sw-custom.js` + `public/manifest.webmanifest` (plugin generates both).
  - Build now emits `dist/sw.js` + `dist/workbox-*.js`, precaches **13 entries (586.94 KiB)**.
- **Gotchas (recorded)**:
  - `npm install` from the repo root (`~/speedreader`) created a stray root `package.json`/`node_modules` (the tool ran there first) — removed the root install and reinstalled in `frontend/`.
  - The current terminal session kept an old PATH (still showing v18); **new terminals** get v22 from nvm.
- Verified on Node 22: `tsc --noEmit` OK, `npm run build` OK (PWA v1.3.0, generateSW mode), `cargo check` OK.

---

## 2026-08-21 — Offline-capable PWA

- Made the frontend an **installable, offline-first PWA** so users don't need internet — served-as-website or wrapped in Tauri.
- **Hand-rolled the SW** (no `vite-plugin-pwa`): 
  - `public/sw-custom.js` — custom service worker (install caches shell: `/`, `/index.html`, `/manifest.webmanifest`, icon; fetch = stale-while-revalidate, cache-first with network fallback; navigation → cached index.html for offline SPA).
  - `public/manifest.webmanifest` — app manifest (name "Speedreader", standalone display, theme `#2563eb`, icons 32/128/512 + maskable).
  - Icons copied from `src-tauri/icons/` → `public/pwa-{32,128,512}.png`.
  - `index.html` — added `theme-color` meta, `<link rel="manifest">`, apple-touch-icon; title → "Speedreader".
  - `src/main.tsx` — registers `/sw-custom.js` on load, **skipped inside Tauri webview** (`"__TAURI_INTERNALS__" in window`), so the native app isn't affected.
- **Gotcha (recorded)**: `vite-plugin-pwa` v1.3.0 and v0.20.x both fail on **Node 18**:
  - v1.3.0: `crypto is not defined` (its `serialize-javascript` dep needs newer Node).
  - v0.20.1: `Dynamic require of "workbox-build" is not supported` (plugin's ESM shim can't `require` workbox-build on Node 18).
  - Workaround: **skip the plugin entirely** — write a small SW + manifest by hand. Everything the plugin does (precache, manifest, registration) is ~50 lines.
- `tsc --noEmit`, `npm run build`, and `cargo check` all pass. `dist/` now contains `sw-custom.js`, `manifest.webmanifest`, `pwa-*.png`.

---

## 2026-08-20 — GitHub Actions CI for desktop + mobile

- Added three GitHub Actions workflows under `.github/workflows/`:
  - **`build-desktop.yml`** — matrix over `windows-latest`, `macos-latest`, `ubuntu-latest`; uses `tauri-apps/tauri-action@v0` to build + attach release artifacts (auto-creates GitHub Releases on `v*` tags). Ubuntu installs `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`.
  - **`build-android.yml`** — `ubuntu-latest`; Rust targets `aarch64/armv7/i686/x86_64-linux-android`, Java 17 (temurin), Android SDK via `android-actions/setup-android@v3`; runs `tauri android init` then `tauri android build --apk`, uploads the universal APK as an artifact.
  - **`build-ios.yml`** — `macos-latest`; Rust targets `aarch64-apple-ios` (+ sim); runs `tauri ios init` then `tauri ios build --no-sign` (unsigned simulator build), uploads the `.app` as an artifact.
- **Notes / gotchas**:
  - The mobile projects (`src-tauri/gen/android`, `src-tauri/gen/apple`) are **not committed** — they're generated on the runner via `tauri android init` / `tauri ios init`. (Tauri's default `.gitignore` excludes them.)
  - iOS **is possible** on GitHub Actions (macOS runners), but a real signed/App-Store build needs Apple signing secrets (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`). The workflow here does an unsigned simulator build; wire up signing when you have a paid Apple Developer account.
  - Android APK is unsigned by default; signing requires a keystore secret for Play Store distribution.
  - All workflows trigger on `push`/`PR` to `main`, `v*` tags, and manual `workflow_dispatch`.
- Node pinned to 18 (matches local env); Rust `stable` via `dtolnay/rust-toolchain`; `swatinem/rust-cache` scoped to `frontend/src-tauri`.

### CI fixes (from first runner runs)

- **`setup-node` npm cache error** (`Some specified paths were not resolved`): the `cache: npm` option tried to cache `~/.npm` before npm had run, so the path didn't exist and the job failed. Removed `cache: npm` / `cache-dependency-path` from all three workflows.
- **`npm ci` EUSAGE error**: `package-lock.json` was **ignored by git** (both `frontend/.gitignore` and root `.gitignore` had `package-lock.json` under "npm, yarn and bun lock files"). Since it wasn't committed, `npm ci` had no lockfile. **Fix**: removed `package-lock.json` from both `.gitignore` files (kept `yarn.lock`/`bun.lockb` ignored) and committed the lockfile — required for reproducible `npm ci` builds in CI.

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

## 2026-08-20 — Removed dead context-window settings

- The **context window** (`contextWindow.before/after`) and **adaptive window** (`adaptiveWindow`) settings did nothing: `SpeedReader` renders a stable 400-word chunk (`chunkWords`) and only uses `frame.index` — `frame.before`/`frame.after`/`frame.current` were never rendered. The settings were pure dead weight in the UI.
- **Removed** from `settings/types.ts` (`GlobalSettings`, `DEFAULT_GLOBAL_SETTINGS`, `mergeSettings`), `SettingsPanel.tsx` (the two "Context before/after" sliders + "Adaptive window" checkbox), `display/types.ts` (`ContextWindow`, `DisplayConfig.window`/`adaptiveWindow`), `renderer.ts` (`adaptiveWindow()` + before/after slicing — `buildFrame` now returns just `{ current, index }`), `display/index.ts` export, `SpeedReader.tsx` (`DEFAULT_CONFIG` + config merge), and `ReaderApp.tsx` (config now `{ wpm }`).
- Updated `experiments/test-display.mts` to the simplified renderer. Build + test pass.

## Tips & gotchas (from UI polish + GitHub setup chats)

### Glassmorphism & theming

- **Never use a fixed translucent white background on a glass card** (`rgba(255,255,255,0.12)`) — it makes theme `fg` text unreadable on light themes and washes out dark themes. Use the theme's own panel color with an alpha suffix instead: `` `${t.panel}e6` `` (6-digit hex + 2 alpha digits = valid 8-digit hex). Keeps the blur while guaranteeing contrast on every theme.
- **Scrollbar styling**: style `::-webkit-scrollbar` (width 6px, transparent track, translucent rounded thumb) **plus** `scrollbar-width: thin; scrollbar-color: …` for Firefox. Define it **once globally** (e.g. `App.css` `.glass-scroll` class) — an inline `<style>` inside a modal only applies while the modal is open, so other surfaces (nav tree) won't get it.
- **Native form controls are stark by default** (white selects/checkboxes). Kill it with `appearance: none` + theme `panel`/`fg`/`border` background + a custom chevron via inline SVG data-URI (`encodeURIComponent` around the SVG, stroke = `t.muted`). Sliders/checkbox: `accentColor: t.highlight` tints them per theme (blue/red/yellow).
- **`<option>` elements also need theme backgrounds** (`backgroundColor: t.panel, color: t.fg`) or the dropdown popup flashes white on dark themes.

### Layout / scrollbar overflow

- **Nested `100vh` inside `calc(100vh - Npx)` always overflows** → permanent page scrollbar (the inner element is Npx taller than the viewport). Fix: make the app a `height: 100vh` flex column with `overflow: hidden`, top bar `flexShrink: 0`, content `flex: 1; minHeight: 0`. No pixel math, no scrollbar regardless of bar height/zoom.
- `minHeight: 100vh` (library view) is safe — it only grows if content is taller.

### Seekable scrubber

- **Pointer capture** (`setPointerCapture`) on pointerdown lets a drag continue outside the bar; `touch-action: none` prevents page scroll while scrubbing on touch.
- Make it a real control: `role="slider"`, `aria-valuemin/max/now`, `tabIndex={0}`, arrow keys + Home/End.
- **Seek must update frame + chunk + progress in ONE batched render** (`jumpTo()` helper). If only `frame` updates and `chunkStart` waits for the re-chunk `useEffect`, there's a one-frame gap where the current word isn't in the rendered chunk → no highlight, no centering (empty-center flash).
- `SelfCorrectingClock.seek()` stops the clock — scrubbing pauses playback, which is good UX (drop the playhead, then Play).

### GitHub repo creation

- Folder wasn't a git repo; `gh` CLI was installed. One-shot flow:
  ```bash
  git init -b main
  git add . && git commit -m "Initial commit: Tauri + React speedreader"
  gh repo create speedreader --public --source . --remote origin --push
  ```
- `--source .` uses the current folder, `--remote origin` wires the remote, `--push` pushes in one shot. Use `--private` for a private repo; run `gh auth login` first if unauthenticated.