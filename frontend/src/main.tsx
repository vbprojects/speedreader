import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { registerSW } from "virtual:pwa-register";

// Register the service worker so the app works fully offline (PWA).
// Skipped inside the Tauri webview (no service worker needed there).
if (!("__TAURI_INTERNALS__" in window)) {
  registerSW({ immediate: true });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
