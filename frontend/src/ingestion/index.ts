// src/ingestion/index.ts
// Public surface of the ingestion module.

export { IngestionEngine } from "./engine";
export { EpubParser } from "./epub-parser";
export { pickFileBrowser, fileFromBrowserFile, extensionOf } from "./file-source";
export * from "./types";
export * from "./normalize";
