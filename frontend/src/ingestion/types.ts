// src/ingestion/types.ts
// Contracts for the ingestion pipeline: FileInfo, Parser, and the engine.
// Re-exports the shared Word/WordStream/Metadata/ChapterEntry types.

export type {
  Word,
  WordStream,
  Metadata,
  ChapterEntry,
} from "../epub/types";

import type { WordStream } from "../epub/types";

/** A file as consumed by the ingestion engine — platform-agnostic (bytes). */
export interface FileInfo {
  name: string;
  extension: string;
  mimeType?: string;
  /** Raw file bytes, already loaded (by Tauri, browser, or Node). */
  data: ArrayBuffer;
}

/**
 * A format parser. Implementations are deterministic functions of the file
 * bytes → a flat, tagged WordStream. The engine dispatches to these.
 */
export interface Parser {
  /** Format identifier, e.g. "epub" | "pdf" | "txt". */
  readonly format: string;
  /** Whether this parser can handle the given file (sniff by ext/mime). */
  canParse(file: FileInfo): boolean;
  /** Parse the file into a flat, tagged WordStream. */
  parse(file: FileInfo): Promise<WordStream>;
}

/** Thrown when no registered parser can handle a file. */
export class UnsupportedFormatError extends Error {
  constructor(public readonly file: FileInfo) {
    super(`No parser registered for "${file.name}" (${file.extension})`);
    this.name = "UnsupportedFormatError";
  }
}
