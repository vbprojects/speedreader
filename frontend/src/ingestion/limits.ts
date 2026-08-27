/** Resource limits for content that crosses an untrusted ingestion boundary. */
export const INGESTION_LIMITS = Object.freeze({
  maxFileBytes: 128 * 1024 * 1024,
  maxEpubEntries: 10_000,
  maxEpubEntryBytes: 64 * 1024 * 1024,
  maxEpubExpandedBytes: 512 * 1024 * 1024,
  maxEpubCompressionRatio: 200,
  maxEpubSpineItems: 10_000,
  maxEpubTocEntries: 20_000,
  maxEpubDomNodes: 2_000_000,
  maxEpubWords: 2_000_000,
  maxEpubCharacters: 128 * 1024 * 1024,
  maxEpubCoverBytes: 16 * 1024 * 1024,
  maxPdfPages: 5_000,
  maxPdfTextItemsPerPage: 100_000,
  maxPdfTotalTextItems: 2_000_000,
  maxPdfTextCharactersPerPage: 8 * 1024 * 1024,
  maxPdfWords: 2_000_000,
  maxPdfImagePixels: 16_000_000,
});

export class IngestionResourceLimitError extends Error {
  constructor(resource: string, limit: number) {
    super(`${resource} exceeds the supported limit (${limit.toLocaleString()})`);
    this.name = "IngestionResourceLimitError";
  }
}

export function assertIngestionLimit(value: number, limit: number, resource: string): void {
  if (!Number.isFinite(value) || value < 0 || value > limit) {
    throw new IngestionResourceLimitError(resource, limit);
  }
}

export function assertFileSize(bytes: number): void {
  assertIngestionLimit(bytes, INGESTION_LIMITS.maxFileBytes, "File size");
}
