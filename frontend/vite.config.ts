import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    VitePWA({
      // Auto-update the service worker when a new build is deployed.
      registerType: "autoUpdate",
      // Don't run the service worker in dev (avoids stale-cache confusion
      // during Tauri dev; the SW is only for the built/production app).
      devOptions: { enabled: false },
      // We call registerSW() ourselves in main.tsx (inside the Tauri
      // webview guard), so don't let the plugin auto-inject a second
      // registration script into index.html.
      injectRegister: false,
      manifest: {
        name: "Speedreader",
        short_name: "Speedreader",
        description: "A cross-platform ebook speedreader that flashes words at your pace.",
        lang: "en",
        // Relative paths so the manifest works under any base path
        // (GitHub Pages subpath /speedreader/ or Tauri root "/").
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#2563eb",
        icons: [
          { src: "pwa-32.png", sizes: "32x32", type: "image/png" },
          { src: "pwa-128.png", sizes: "128x128", type: "image/png" },
          { src: "pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // Precache all built assets so the app works fully offline.
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // Keep this relative to the service-worker scope. The precache key is
        // `index.html` both at root and under the GitHub Pages base path;
        // binding `/index.html` fails with Workbox's non-precached-url error.
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
        // Aggressive update: activate new SW immediately and claim all client tabs
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // Allow ngrok public URLs to reach the preview server (for PWA testing).
  preview: {
    port: 4173,
    allowedHosts: [".ngrok-free.app"],
  },
  // Base path for the built assets. GitHub Pages serves the repo at a
  // subpath (/speedreader/), so use that for Pages builds. Tauri loads the
  // frontend from the local bundle (root), so it uses the default "/".
  base: process.env.SPEEDREADER_BASE_PATH || "/",
}));
