// src/ingestion/index.ts
// Public surface of the ingestion module.

export { IngestionEngine } from "./engine";
export { EpubParser } from "./epub-parser";
export { pickFileBrowser, fileFromBrowserFile, extensionOf } from "./file-source";
export { appendToWordStream } from "./interactive";
export type { StreamChunk, InteractiveFormat, RespondableInteractiveFormat } from "./interactive";
export type { InteractionResponse, ReaderInteraction } from "../interactions/types";
export * from "./types";
export * from "./normalize";
export { PdfJsParser, PdfAdvancedLayoutError } from "./pdf";
export * from "./pdf";
export * from "./jetstream";
export * from "./openai-compatible";
