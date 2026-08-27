import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { fileFromBrowserFile } from "./file-source";
import { validateEpubArchive } from "./epub-parser";
import { INGESTION_LIMITS, IngestionResourceLimitError, assertFileSize } from "./limits";

test("file limits reject before browser bytes are allocated", async () => {
  let allocated = false;
  const file = {
    name: "oversized.epub",
    type: "application/epub+zip",
    size: INGESTION_LIMITS.maxFileBytes + 1,
    async arrayBuffer() {
      allocated = true;
      return new ArrayBuffer(0);
    },
  } as File;
  await rejects(fileFromBrowserFile(file), IngestionResourceLimitError);
  equal(allocated, false);
  assertFileSize(INGESTION_LIMITS.maxFileBytes);
});

test("EPUB preflight accepts ordinary archives and rejects extreme expansion ratios", async () => {
  const ordinary = new JSZip();
  ordinary.file("mimetype", "application/epub+zip", { compression: "STORE" });
  ordinary.file("chapter.xhtml", "<p>Hello reader</p>");
  await validateEpubArchive(await ordinary.generateAsync({ type: "arraybuffer", compression: "DEFLATE" }));

  const bomb = new JSZip();
  bomb.file("chapter.xhtml", "A".repeat(1024 * 1024));
  const bombBytes = await bomb.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  await rejects(validateEpubArchive(bombBytes), /unsafe compression ratio/);
});
