import type { FileInfo } from "../types";

export const SUGARCUBE_RUNTIME_FORMAT = "sugarcube-2-runtime" as const;
export const SUGARCUBE_SOURCE_SCHEMA_VERSION = 1 as const;

export const SUGARCUBE_EXECUTABLE_WARNING =
  "SugarCube stories are executable applications. Only import files you trust; story scripts run with the permissions available to this application view.";

export interface SugarCubeStoryMetadata {
  title: string;
  ifid: string;
  startNode: string;
  formatVersion?: string;
}

export interface StoredSugarCubeSource {
  bookId: string;
  format: typeof SUGARCUBE_RUNTIME_FORMAT;
  schemaVersion: typeof SUGARCUBE_SOURCE_SCHEMA_VERSION;
  mimeType: "text/html";
  /** Decoded published story document, including its bundled SugarCube runtime. */
  html: string;
  /** SHA-256 of the original imported bytes. */
  sourceHash: string;
  story: SugarCubeStoryMetadata;
}

/** Format-owned state stored in ReaderState.formatState, never on Book. */
export interface SugarCubeReaderState extends Record<string, unknown> {
  schemaVersion: 1;
  sourceHash: string;
  saveApi: "base64" | "legacy-serialize";
  /** Opaque payload returned by the story's bundled SugarCube runtime. */
  save: string;
  lastSnapshotId?: string;
  lastTurn?: number;
}

export interface DetectedSugarCubeSource {
  source: StoredSugarCubeSource;
  warning: typeof SUGARCUBE_EXECUTABLE_WARNING;
}

export type HtmlDocumentParser = (html: string) => Document;

export interface SugarCubeSourceInput {
  file: FileInfo;
  sourceHash: string;
  parseHtml?: HtmlDocumentParser;
}

export class InvalidSugarCubeStoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSugarCubeStoryError";
  }
}
