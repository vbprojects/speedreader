import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerSW } from "virtual:pwa-register";

// Register the service worker so the app works fully offline (PWA).
// Skipped inside the Tauri webview (no service worker needed there).
if (!("__TAURI_INTERNALS__" in window)) {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // Aggressively update: immediately reload to activate the new version
      updateSW(true);
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

  // Automatically reload when a new service worker takes control
  let refreshing = false;
  navigator.serviceWorker?.addEventListener("controllerchange", () => {
    if (!refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
