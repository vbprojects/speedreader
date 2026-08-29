// src/ingestion/file-source.ts
// File-source adapter: turns a picked file into a FileInfo (bytes).
// Works in the browser (input element) and is extensible for Tauri
// (plugin-dialog + plugin-fs) later — both produce an ArrayBuffer.

import type { FileInfo } from "./types";
import { assertFileSize } from "./limits";

/** Detect the extension from a filename. */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

/** Convert a browser File into a FileInfo. */
export async function fileFromBrowserFile(file: File): Promise<FileInfo> {
  assertFileSize(file.size);
  const data = await file.arrayBuffer();
  return {
    name: file.name,
    extension: extensionOf(file.name),
    mimeType: file.type || undefined,
    data,
  };
}

/** Open a native file picker (browser fallback) and return a FileInfo. */
export function pickFileBrowser(accept = ".epub,.pdf,.html,.htm"): Promise<FileInfo | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;

    // Keep the input in the DOM (visually hidden) — on iOS standalone
    // (home-screen PWA), a detached input's .click() silently does nothing;
    // an attached input opens the picker reliably.
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.opacity = "0";

    const cleanup = () => {
      document.body.removeChild(input);
    };

    input.onchange = () => {
      cleanup();
      const file = input.files?.[0];
      if (!file) return resolve(null);
      fileFromBrowserFile(file).then(resolve, reject);
    };
    input.oncancel = () => {
      cleanup();
      resolve(null);
    };
    input.onerror = () => {
      cleanup();
      reject(new Error("File picker failed"));
    };

    document.body.appendChild(input);
    input.click();
  });
}
