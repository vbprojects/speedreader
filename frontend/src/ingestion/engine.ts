// src/ingestion/engine.ts
// IngestionEngine — dispatches a FileInfo to the first Parser that can handle
// it, producing a flat WordStream. Format-agnostic; parsers are pluggable.

import type { FileInfo, Parser, WordStream } from "./types";
import type { InteractiveFormat } from "./interactive";
import { UnsupportedFormatError } from "./types";

export class IngestionEngine {
  private parsers: Parser[] = [];
  private interactiveFactories = new Map<string, () => InteractiveFormat<unknown, Record<string, unknown>>>();

  constructor(
    parsers: Parser[] = [],
    interactiveFactories: Array<() => InteractiveFormat<unknown, Record<string, unknown>>> = [],
  ) {
    this.parsers = [...parsers];
    for (const factory of interactiveFactories) this.registerInteractive(factory);
  }

  /** Register a factory for a stateful live/dynamic format. */
  registerInteractive(factory: () => InteractiveFormat<unknown, Record<string, unknown>>): void {
    const instance = factory();
    this.interactiveFactories.set(instance.format, factory);
  }

  /** Create a fresh live format session, or null for a static book. */
  interactiveFormatFor(format: string): InteractiveFormat<unknown, Record<string, unknown>> | null {
    return this.interactiveFactories.get(format)?.() ?? null;
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

  /** The parser that would handle a file, or null if none. */
  parserFor(file: FileInfo): Parser | null {
    return this.parsers.find((p) => p.canParse(file)) ?? null;
  }

  /** Parse a file into a flat WordStream using the first matching parser. */
  async ingest(file: FileInfo): Promise<WordStream> {
    const parser = this.parserFor(file);
    if (!parser) throw new UnsupportedFormatError(file);
    return parser.parse(file);
  }
}
