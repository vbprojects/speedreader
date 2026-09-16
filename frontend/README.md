# Speedreader frontend

The architectural overview, subsystem boundaries, and extension guidance live in the repository-level [README](../README.md).

This directory contains the React/Vite/PWA application and the optional Tauri shell.

Requires Node.js 22.14 or newer. Run these commands from `frontend/`:

```bash
npm install
npm run dev
```

The development server runs at `http://localhost:1420`.

Run the complete verification path with:

```bash
npm run check
```

Focused workflows:

```bash
npm test
npm run test:watch
npm run typecheck
npm run experiment:surprisal
npm run tauri dev
```
