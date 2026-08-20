// src/ingestion/file-source.ts
// File-source adapter: turns a picked file into a FileInfo (bytes).
// Works in the browser (input element) and is extensible for Tauri
// (plugin-dialog + plugin-fs) later — both produce an ArrayBuffer.

import type { FileInfo } from "./types";

/** Detect the extension from a filename. */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

/** Convert a browser File into a FileInfo. */
export async function fileFromBrowserFile(file: File): Promise<FileInfo> {
  const data = await file.arrayBuffer();
  return {
    name: file.name,
    extension: extensionOf(file.name),
    mimeType: file.type || undefined,
    data,
  };
}

/** Open a native file picker (browser fallback) and return a FileInfo. */
export function pickFileBrowser(accept = ".epub"): Promise<FileInfo | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      fileFromBrowserFile(file).then(resolve, reject);
    };
    input.onerror = () => reject(new Error("File picker failed"));
    input.click();
  });
}