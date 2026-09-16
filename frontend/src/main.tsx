import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyWaitingUpdate, deferAppUpdate, onNewController } from "./pwa-update";
import { registerSW } from "virtual:pwa-register";

// A production worker left behind on the development origin can continue to
// intercept Vite navigations even though the PWA plugin is disabled in dev.
// Remove only workers registered for this origin before running the app.
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      if (new URL(registration.scope).origin === window.location.origin) {
        void registration.unregister();
      }
    }
  });
}

// Register the service worker so the app works fully offline (PWA).
// Skipped in development and inside the Tauri webview.
if (import.meta.env.PROD && !("__TAURI_INTERNALS__" in window)) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      deferAppUpdate(() => updateSW(false));
    },
    onRegistered(registration) {
      if (registration) {
        // Check for SW updates periodically every 30 minutes
        setInterval(() => {
          registration.update().catch(() => undefined);
        }, 30 * 60 * 1000);

        // Also check for updates when window/tab regains focus or visibility
        window.addEventListener("focus", () => {
          registration.update().catch(() => undefined);
        });
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            registration.update().catch(() => undefined);
          }
        });
      }
    },
  });

  // Recheck after another tab leaves its reader. Active readers hold a shared lease.
  setInterval(() => { void applyWaitingUpdate(); }, 5000);
  navigator.serviceWorker?.addEventListener("controllerchange", onNewController);
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
