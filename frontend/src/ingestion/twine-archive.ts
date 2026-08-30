import JSZip from "jszip";
import { assertFileSize, assertIngestionLimit, INGESTION_LIMITS } from "./limits";
import type { FileInfo } from "./types";

type ZipEntryWithSizes = JSZip.JSZipObject & {
  unsafeOriginalName?: string;
  _data?: { compressedSize?: number; uncompressedSize?: number };
};

export class InvalidTwineArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTwineArchiveError";
  }
}

export interface TwineArchiveAsset {
  path: string;
  mimeType: string;
  data: ArrayBuffer;
}

export interface ExtractedTwinePackage {
  file: FileInfo;
  assets: TwineArchiveAsset[];
}

function isZipCandidate(file: FileInfo): boolean {
  const type = file.mimeType?.split(";", 1)[0].trim().toLowerCase();
  if (type === "text/html") return false;
  return file.extension.toLowerCase() === "zip" || type === "application/zip" || type === "application/x-zip-compressed";
}

function safeEntryName(entry: ZipEntryWithSizes): string {
  const original = entry.unsafeOriginalName ?? entry.name;
  if (!original || original.startsWith("/") || original.includes("\\") || original.includes("\0")
    || original.split("/").some((part) => part === "..")) {
    throw new InvalidTwineArchiveError("The Twine archive contains an unsafe file path.");
  }
  return entry.name;
}

function candidateScore(name: string): number {
  const lower = name.toLowerCase();
  if (lower === "index.html" || lower === "index.htm") return 0;
  if (/(?:^|\/)index\.html?$/u.test(lower)) return 1;
  return 2 + name.split("/").length;
}

function looksLikePublishedSugarCube(html: string): boolean {
  return /<tw-storydata\b[^>]*\bformat\s*=\s*["']SugarCube["']/iu.test(html)
    && /<script\b[^>]*\bid\s*=\s*["']script-sugarcube["']/iu.test(html);
}

function assetMimeType(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return ({
    css: "text/css",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    png: "image/png",
    svg: "image/svg+xml",
    webm: "video/webm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Extract one unambiguous SugarCube document and retain its bounded package assets. */
export async function extractTwinePackage(file: FileInfo): Promise<ExtractedTwinePackage | null> {
  if (!isZipCandidate(file)) return null;
  assertFileSize(file.data.byteLength);
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(file.data);
  } catch {
    throw new InvalidTwineArchiveError("The selected file is not a valid ZIP archive.");
  }
  const entries = Object.values(archive.files).filter((entry) => !entry.dir) as ZipEntryWithSizes[];
  assertIngestionLimit(entries.length, INGESTION_LIMITS.maxEpubEntries, "Twine archive entries");
  let expandedBytes = 0;
  const candidates: Array<{ entry: ZipEntryWithSizes; name: string; score: number }> = [];
  for (const entry of entries) {
    const name = safeEntryName(entry);
    const compressed = Number(entry._data?.compressedSize);
    const expanded = Number(entry._data?.uncompressedSize);
    if (!Number.isSafeInteger(compressed) || compressed < 0 || !Number.isSafeInteger(expanded) || expanded < 0) {
      throw new InvalidTwineArchiveError(`The Twine archive entry ${name} has invalid size metadata.`);
    }
    assertIngestionLimit(expanded, INGESTION_LIMITS.maxEpubEntryBytes, `Twine archive entry ${name}`);
    expandedBytes += expanded;
    assertIngestionLimit(expandedBytes, INGESTION_LIMITS.maxEpubExpandedBytes, "Twine archive expanded size");
    if (expanded > 0 && (compressed === 0 || expanded / compressed > INGESTION_LIMITS.maxEpubCompressionRatio)) {
      throw new InvalidTwineArchiveError(`The Twine archive entry ${name} has an unsafe compression ratio.`);
    }
    if (/\.html?$/iu.test(name)) candidates.push({ entry, name, score: candidateScore(name) });
  }
  if (candidates.length === 0) throw new InvalidTwineArchiveError("The ZIP archive does not contain an HTML story.");
  candidates.sort((left, right) => left.score - right.score || left.name.localeCompare(right.name));
  const valid: Array<{ entry: ZipEntryWithSizes; file: FileInfo; score: number }> = [];
  for (const candidate of candidates) {
    let bytes: Uint8Array;
    let html: string;
    try {
      bytes = await candidate.entry.async("uint8array");
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    if (!looksLikePublishedSugarCube(html)) continue;
    const parts = candidate.name.split("/");
    const name = parts[parts.length - 1] || "story.html";
    valid.push({
      entry: candidate.entry,
      score: candidate.score,
      file: { name, extension: name.toLowerCase().endsWith(".htm") ? "htm" : "html", mimeType: "text/html", data: exactArrayBuffer(bytes) },
    });
  }
  if (valid.length === 0) throw new InvalidTwineArchiveError("The ZIP archive does not contain a published SugarCube story.");
  if (valid.length > 1 && valid[0].score === valid[1].score) {
    throw new InvalidTwineArchiveError("The ZIP archive contains multiple possible SugarCube stories. Import the intended HTML file directly.");
  }
  const selected = valid[0];
  let assetBytes = 0;
  const assets: TwineArchiveAsset[] = [];
  for (const entry of entries) {
    if (entry === selected.entry || entry.name.startsWith("__MACOSX/") || /(?:^|\/)\.DS_Store$/u.test(entry.name)) continue;
    const expanded = Number(entry._data?.uncompressedSize);
    assetBytes += expanded;
    assertIngestionLimit(assetBytes, INGESTION_LIMITS.maxFileBytes, "Twine archive stored assets");
    const bytes = await entry.async("uint8array");
    assets.push({ path: entry.name, mimeType: assetMimeType(entry.name), data: exactArrayBuffer(bytes) });
  }
  return { file: selected.file, assets };
}
