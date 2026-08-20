// src/ingestion/engine.ts
// IngestionEngine — dispatches a FileInfo to the first Parser that can handle
// it, producing a flat WordStream. Format-agnostic; parsers are pluggable.

import type { FileInfo, Parser, WordStream } from "./types";
import { UnsupportedFormatError } from "./types";

export class IngestionEngine {
  private parsers: Parser[] = [];

  constructor(parsers: Parser[] = []) {
    this.parsers = [...parsers];
  }

  /** Register a parser (or replace one with the same format). */
  register(parser: Parser): void {
    const idx = this.parsers.findIndex((p) => p.format === parser.format);
    if (idx >= 0) this.parsers[idx] = parser;
    else this.parsers.push(parser);
  }

  /** List registered formats. */
  get formats(): string[] {
    return this.parsers.map((p) => p.format);
  }

  /** Parse a file into a flat WordStream using the first matching parser. */
  async ingest(file: FileInfo): Promise<WordStream> {
    const parser = this.parsers.find((p) => p.canParse(file));
    if (!parser) throw new UnsupportedFormatError(file);
    return parser.parse(file);
  }
}
