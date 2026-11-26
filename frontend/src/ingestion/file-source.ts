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

function pickBrowserFiles(options: { accept?: string; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options.directory) {
      input.webkitdirectory = true;
      input.multiple = true;
    } else if (options.accept) {
      input.accept = options.accept;
    }

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
      resolve(Array.from(input.files ?? []));
    };
    input.oncancel = () => {
      cleanup();
      resolve([]);
    };
    input.onerror = () => {
      cleanup();
      reject(new Error("File picker failed"));
    };

    document.body.appendChild(input);
    input.click();
  });
}

export async function pickFileBrowser(accept = ".epub,.pdf,.txt,.html,.htm,.zip"): Promise<FileInfo | null> {
  const [file] = await pickBrowserFiles({ accept });
  return file ? fileFromBrowserFile(file) : null;
}

export function pickFolderBrowser(): Promise<File[]> {
  return pickBrowserFiles({ directory: true });
}
