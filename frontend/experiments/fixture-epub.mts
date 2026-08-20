// fixture-epub.mts
// Builds a minimal valid EPUB (EPUB3, single-file-format) in memory using
// jszip, and can also write it to disk for inspection.
//
// Used by explore-epub.mts.

import JSZip from "jszip";

const MIMETYPE = "application/epub+zip";

/**
 * Build a tiny toy EPUB with two XHTML chapters and a nav doc.
 * Returns the raw bytes (Uint8Array). Optionally writes to `outPath`.
 */
export async function buildFixtureEpub(outPath?: string): Promise<Uint8Array> {
  const zip = new JSZip();

  // 1. mimetype — must be first & uncompressed.
  zip.file("mimetype", MIMETYPE, { compression: "STORE" });

  // 2. container.xml — points to the OPF.
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`
  );

  // 3. OPF
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test-0001</dc:identifier>
    <dc:title>Toy Book</dc:title>
    <dc:creator>Fixture Author</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`
  );

  // 4. Nav doc
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="chapter1.xhtml">The Beginning</a></li>
        <li><a href="chapter2.xhtml">The End</a></li>
      </ol>
    </nav>
  </body>
</html>`
  );

  // 5. Chapters
  zip.file(
    "OEBPS/chapter1.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter 1</title></head>
  <body>
    <h1>The Beginning</h1>
    <p>Once upon a time, there was a quick brown fox.</p>
    <p>The fox jumped over the lazy dog, and then it kept on running.</p>
  </body>
</html>`
  );

  zip.file(
    "OEBPS/chapter2.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>Chapter 2</title></head>
  <body>
    <h1>The End</h1>
    <p>And so the story came to a close, with a very long word that goes on and on and on for quite some length to test pacing.</p>
  </body>
</html>`
  );

  const blob = await zip.generateAsync({
    type: "uint8array",
    mimeType: MIMETYPE,
    compression: "DEFLATE",
  });

  if (outPath) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir("experiments/fixtures", { recursive: true });
    await writeFile(outPath, blob);
  }

  return blob;
}