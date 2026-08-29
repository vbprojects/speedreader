import { assertFileSize } from "../limits";
import {
  InvalidSugarCubeStoryError,
  SUGARCUBE_EXECUTABLE_WARNING,
  SUGARCUBE_RUNTIME_FORMAT,
  SUGARCUBE_SOURCE_SCHEMA_VERSION,
  type DetectedSugarCubeSource,
  type HtmlDocumentParser,
  type SugarCubeSourceInput,
  type SugarCubeStoryMetadata,
} from "./types";

const MAX_METADATA_LENGTH = 4_096;

function parseInBrowser(html: string): Document {
  if (typeof DOMParser === "undefined") {
    throw new Error("SugarCube detection requires a browser DOM parser");
  }
  return new DOMParser().parseFromString(html, "text/html");
}

function boundedAttribute(element: Element, name: string, required = false): string | undefined {
  const value = element.getAttribute(name)?.trim();
  if (!value) {
    if (required) throw new InvalidSugarCubeStoryError(`SugarCube story data is missing ${name}`);
    return undefined;
  }
  if (value.length > MAX_METADATA_LENGTH) {
    throw new InvalidSugarCubeStoryError(`SugarCube story data ${name} is too long`);
  }
  return value;
}

function extractMetadata(storyData: Element): SugarCubeStoryMetadata {
  return {
    title: boundedAttribute(storyData, "name", true)!,
    ifid: boundedAttribute(storyData, "ifid", true)!,
    startNode: boundedAttribute(storyData, "startnode", true)!,
    formatVersion: boundedAttribute(storyData, "format-version"),
  };
}

function isHtmlCandidate(extension: string, mimeType?: string): boolean {
  return extension.toLowerCase() === "html" || extension.toLowerCase() === "htm" || mimeType?.toLowerCase() === "text/html";
}

/** Inspect decoded published HTML. Returns null for non-SugarCube documents. */
export function detectSugarCubeDocument(
  html: string,
  parseHtml: HtmlDocumentParser = parseInBrowser,
): SugarCubeStoryMetadata | null {
  const document = parseHtml(html);
  const storyData = document.querySelector("tw-storydata");
  if (!storyData) return null;
  if (storyData.getAttribute("format")?.trim().toLowerCase() !== "sugarcube") return null;
  if (!document.querySelector("script#script-sugarcube")) {
    throw new InvalidSugarCubeStoryError("Published SugarCube HTML is missing its bundled runtime");
  }
  return extractMetadata(storyData);
}

/** Decode and validate a published SugarCube 2 HTML file without executing it. */
export function detectSugarCubeSource({
  file,
  sourceHash,
  parseHtml = parseInBrowser,
}: SugarCubeSourceInput): DetectedSugarCubeSource | null {
  assertFileSize(file.data.byteLength);
  if (!isHtmlCandidate(file.extension, file.mimeType)) return null;
  if (!/^[a-f0-9]{64}$/i.test(sourceHash)) {
    throw new InvalidSugarCubeStoryError("SugarCube source hash must be a SHA-256 hex digest");
  }

  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
  } catch {
    throw new InvalidSugarCubeStoryError("Published SugarCube HTML must be valid UTF-8");
  }
  const story = detectSugarCubeDocument(html, parseHtml);
  if (!story) return null;

  return {
    source: {
      bookId: sourceHash.toLowerCase(),
      format: SUGARCUBE_RUNTIME_FORMAT,
      schemaVersion: SUGARCUBE_SOURCE_SCHEMA_VERSION,
      mimeType: "text/html",
      html,
      sourceHash: sourceHash.toLowerCase(),
      story,
    },
    warning: SUGARCUBE_EXECUTABLE_WARNING,
  };
}
