# Speedreader

A fast, offline-first, cross-platform ebook speed reader built with React, TypeScript, and Vite (packaged as a Progressive Web App and Tauri desktop/mobile app).

Speedreader presents sequential words at configurable reading speeds (e.g., 600 WPM), keeping the current word pinned and highlighted at the exact center of the screen while rendering flowing context around it.

---

## ✨ Features

- **Sequential Word Flashing & Centered Focal Point**: Words are highlighted in real time and automatically kept centered in the viewport to minimize eye movement.
- **Pluggable Pacing Engines**:
  - **Naive (Fixed WPM)**: Displays words at a steady pace based on target WPM with sentence/paragraph pauses.
  - **Bayesian Adaptive (Shifted Poisson–Gamma Model)**: Dynamically scales word display times based on character length and local difficulty using online Bayesian parameter estimation with exponential forgetting (user-configurable $\gamma \in [0.90, 0.999]$, corresponding to an effective memory window $N_{\text{eff}} \approx \frac{1}{1 - \gamma}$).
- **Offline-First Library (IndexedDB)**:
  - Import EPUB and simple native-text PDF files directly into a local library.
  - PDFs with OCR, columns, or complex layouts are reserved for the future Marker/Docling ingestion service.
  - Extracts and displays book cover art (with deterministic styled fallback cards for books without covers).
  - Deduplicates books deterministically via SHA-256 file content hashing.
  - Tile context menu for managing and removing books (right-click or long-press on touch).
- **Persistent Reading State**:
  - Reading positions, custom WPM, and book-specific settings persist automatically in IndexedDB.
  - Reopening a book resumes seamlessly at the exact word where you left off.
- **Navigation & Scrubber Controls**:
  - Full-stream seekable progress bar with fine-tuning scrubbing.
  - Direct "Jump to Word Number" modal on desktop and mobile.
  - Collapsible Table of Contents / navigation tree derived from EPUB metadata.
  - Always-minimizable bottom drawer that expands to 100% width when the side drawer is collapsed.
- **Customizable Themes & Typography**:
  - Themes: Light, Dark, Sepia, and High Contrast.
  - Adjustable fonts, font sizes, WPM (100–2000), sentence pauses, and paragraph pauses.
- **PWA & Desktop Support**:
  - Installable as a Progressive Web App (PWA) with full offline caching via Service Worker.
  - Desktop / mobile executable packaging via Tauri v2.

---

## 🛠 Tech Stack

- **Frontend**: React 19, TypeScript, Vite 5
- **Parsing / Ingestion**: `epubjs`, `jszip`
- **Storage**: IndexedDB (`speedreader` DB) + `localStorage` for synchronous app configuration
- **PWA**: `vite-plugin-pwa` with Workbox offline precaching
- **Native Packaging**: Tauri v2 (Rust)

---

## 🚀 Getting Started

### Prerequisites

- Node.js $\ge 20$ (Node 22 recommended)
- npm $\ge 9$
- *(Optional for desktop app)* Rust toolchain & Tauri prerequisites

### Installation & Development

```bash
# Navigate to the frontend directory
cd frontend

# Install dependencies
npm install

# Start the development server
npm run dev
```

Visit `http://localhost:1420` in your browser.

### Building for Production

```bash
cd frontend

# Type-check and build the web / PWA production bundle
npm run build

# Preview the production build
npm run preview
```

The output bundle will be located in `frontend/dist/`.

### Running with Tauri

```bash
cd frontend
npm run tauri dev
```

---

## 🧪 Experiments & Testing

Headless TypeScript test scripts are located under `frontend/experiments/`:

```bash
cd frontend

# Run pacing engine tests (Naive & Bayesian)
npx tsx experiments/test-pacing.mts
npx tsx experiments/test-bayesian-pacing.mts

# Run library store and persistence tests
npx tsx experiments/test-library.mts

# Run display renderer & clock tests
npx tsx experiments/test-display.mts

# Run EPUB ingestion tests
npx tsx experiments/test-ingestion.mts
npx tsx experiments/test-pdf-ingestion.mts
```

---

## 📖 Architecture Overview

```
[Uploaded EPUB / File]
          │
          ▼
   [Ingestion Engine]
          │  (TOC mapping, DOM traversal, metadata tags)
          ▼
    [Word Stream]  ──►  [IndexedDB Cache] (Stores Books, Streams, & Positions)
          │
          ▼
   [Pacing Engine]  (Naive or Bayesian Poisson–Gamma model)
          │
          ▼
  [Self-Correcting Clock]  (Drift-compensated performance.now() timer)
          │
          ▼
   [SpeedReader UI]  (Centered highlight display, navigation, & scrubber)
```

For design decisions, component contracts, and roadmap milestones, refer to [plan.md](./plan.md) and [ChangeLog.md](./ChangeLog.md).
