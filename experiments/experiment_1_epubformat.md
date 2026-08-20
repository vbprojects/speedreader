# Experiment 1 — EPUB Format

**Stack**: Tauri + React
**Goal**: Determine the **best way to do EPUB metadata parsing** — i.e., how to map EPUB structure into our flexible `Word.metadata` array so we can build dynamic hierarchical navigation.

---

## The flexible `Word` model

The `Word` shape is intentionally **format-agnostic** — it does not hard-code any ebook structure:

```ts
interface Word {
  text: string;
  index: number;
  metadata: Metadata[];   // ordered list of structural attributes
}

interface Metadata {
  attribute: string;      // e.g. "chapterId", "sectionId", "paragraphId", "page"
  value: string | number;
}
```

**The list of metadata and its order determine the hierarchy.** For example:

```ts
// "chapter 1, section 1"
metadata: [
  { attribute: "chapterId", value: 1 },
  { attribute: "sectionId", value: 1 },
]
```

This lets each format express its own structure without the model being tied to EPUB (or PDF, or dynamic content). The experiment's job is to figure out what metadata EPUB should emit.

---

## What an EPUB actually is

An EPUB is a **ZIP archive** with a specific internal layout. The two relevant specs:

- **OPF** (Open Packaging Format) — the manifest/spine metadata.
- **XHTML** — the actual chapter content.

### Minimal structure

```
book.epub
├── mimetype                      # MUST be first, uncompressed, exactly "application/epub+zip"
├── META-INF/
│   └── container.xml             # points to the OPF file
└── OEBPS/                        # arbitrary content dir (path is whatever container.xml says)
    ├── content.opf               # the OPF: metadata + manifest + spine
    ├── toc.ncx                   # (EPUB2) navigation
    ├── nav.xhtml                 # (EPUB3) navigation
    ├── chapter1.xhtml
    ├── chapter2.xhtml
    └── styles.css
```

### `container.xml`

```xml
<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
```

This is the **entry point** — it tells us where the OPF lives.

### `content.opf` (the OPF)

Three key sections:

```xml
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata>
    <dc:title>My Book</dc:title>
    <dc:creator>Jane Doe</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>

  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>

  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
```

- **`metadata`** → title, author, language, modified date. (Feeds the Library's `books` table.)
- **`manifest`** → maps `id` → file path + media type.
- **`spine`** → the **reading order** — an ordered list of `itemref`s. This is the canonical chapter order.

> **Key insight**: the **spine** defines reading order, not the filesystem or the manifest. We must read the spine, not just glob the XHTML files.

---

## Mapping EPUB → our `Word` model

Proposed mapping (to be validated — see open question #13). The exact metadata scheme is the **core question of this experiment**:

| `Metadata.attribute` | Source |
|----------------------|--------|
| `chapterId` | spine item index (position in `<spine>`) |
| `sectionId` | heading block index within the chapter |
| `paragraphId` | DOM paragraph index within the section |
| `page` | n/a for EPUB (no fixed pages) |

The **order** of these attributes in `metadata[]` defines the hierarchy (chapter → section → paragraph).

### Reading order algorithm

1. Unzip the EPUB.
2. Read `META-INF/container.xml` → find OPF path.
3. Parse OPF → metadata, manifest, spine.
4. For each spine item in order:
   a. Load the XHTML file.
   b. Strip markup, preserving structure (headings, paragraphs).
   c. Split text into words, tagging each with the current chapter/section/paragraph IDs.
5. Emit a flat `Word[]` array + build `chapter_index`.

---

## Parsing concerns / gotchas

- **`mimetype` must be first & uncompressed** — some unzip libs reorder; verify we read it correctly or ignore it.
- **EPUB2 vs EPUB3** — navigation differs (`toc.ncx` vs `nav.xhtml`). For M1 we only need the **spine** for reading order, so this mostly doesn't matter yet.
- **XHTML is not always well-formed** — some EPUBs have sloppy HTML. Use a tolerant HTML parser (e.g., `htmlparser2` / `parse5`), not a strict XML parser.
- **Nested block elements** — `<div>` inside `<p>`, lists, tables. Need a rule for what counts as a "paragraph."
- **CSS-driven reading order** — some books use CSS columns/flexbox that reorder visual reading vs. DOM order. Rare; ignore for M1.
- **Images / non-text content** — skip for M1 (no alt-text extraction yet).
- **Encrypted / DRM EPUBs** — out of scope; detect and reject gracefully.

---

## Tooling options (Tauri + React)

| Concern | Option | Notes |
|---------|--------|-------|
| Unzip | `fflate` / `jszip` | `fflate` is fast & small; works in browser + Node |
| HTML parsing | `htmlparser2` / `parse5` | Tolerant, streaming, works everywhere |
| XML parsing (OPF) | `fast-xml-parser` / `@xmldom/xmldom` | For `container.xml` + OPF |
| Where parsing runs | **Client-side** (in the webview) | Offline-first decision; no backend needed |

All of these run in the Tauri webview, so ingestion stays fully client-side.

---

## Acceptance criteria for this experiment

- [x] Parse a real `.epub` and produce a flat `Word[]` array. — **Done.** Pride and Prejudice → 130,087 words.
- [x] `chapter_index` matches the spine order. — **Done, spine-level.** 9 entries matching the 9-item spine. ⚠️ *Not chapter-level* — see findings: Gutenberg EPUBs pack many TOC chapters per spine file.
- [x] Metadata (title/author) extracted correctly. — **Done.** Title "Pride and Prejudice", creator "Jane Austen", language `en`, Gutenberg id, pubdate, rights.
- [ ] Deterministic: same file → same output (run twice, diff). — **Not yet run.** Parse borrows no wall-clock/randomness, but the two-run diff test hasn't been executed.
- [ ] Handles a malformed/sloppy XHTML file without crashing. — **Not yet tested.** Need a malformed fixture.
- [x] Fixture EPUBs added under `tests/fixtures/`. — **Done, partial.** A toy fixture exists at `frontend/experiments/fixtures/toy.epub` (generated via jszip). Should be mirrored into `tests/fixtures/` per the plan's convention.

---

## Results — Experiment 1

### What works

- **Headless parsing loop** over a real EPUB via `epubjs` + jsdom in **~400ms**: metadata, spine, TOC/navigation, and per-spine-item word text.
- **Flat word stream** produced (Option B): `totalWords`, `avgWordLength`, and a spine-level `chapterIndex`. Uses the flexible `Word.metadata[]` model.
- **Metadata extraction** works cleanly through `epubjs`'s `loaded.metadata`.

### Measured on Pride and Prejudice (Gutenberg #1342)

| Metric | Value |
|--------|-------|
| Parse time | ~400 ms |
| Spine items | 9 |
| TOC/nav entries | 61 |
| Total words | 130,887 |
| Avg word length | 4.64 |
| Chapters (spine-level) | 9 |

### Key findings

1. **Chapters ≠ spine files.** Gutenberg EPUBs put many chapters inside a single spine item (9 spine files → 61 chapters). `chapterId = spine index` is the **wrong granularity** for navigation. Real chapter navigation must map the **TOC/nav anchors** (`href#fragment`) to word ranges inside the spine content.
2. **Metadata mapping is straightforward** — `chapterId` (spine), ordering by spine is reliable; section/paragraph need the structural-attributes experiment from open question #13.
3. **epubjs makes exploration easy** but is DOM-dependent; headless use requires the jsdom shim (see `experiments/dom-shim.mts`).

### Recommendations / next steps

- Map TOC chapter anchors → word ranges (the blocker for real navigation). This informs the canonical `chapterId` metadata scheme.
- Add the malformed-XHTML fixture and run the determinism (two-run) check to close the remaining acceptance criteria.
- Mirror the fixture EPUB into `tests/fixtures/`.
- Decide with open question #13: should `chapterId` be the TOC chapter or the spine file? (Finding 1 suggests a separate, more granular chapter level is needed.)

---

## Verified on a real EPUB (Pride and Prejudice, Gutenberg #1342)

Headless parse via `epubjs` + jsdom, in ~400ms:

- **Metadata**: title, creator (Jane Austen), language, identifier, pubdate, rights.
- **Spine**: 9 items in reading order (cover wrapper, pg-header, 6 content chunks, pg-footer, cover image).
- **Navigation/TOC**: 61 entries — chapter titles within the same XHTML file.
- **Word stream**: 130,087 words, avg length 4.64, 9 chapters (spine-level).

### Key parsing finding: chapters ≠ spine files

Gutenberg EPUBs put **many chapters inside a single spine item**. The spine has only 9 items, but the TOC has 61 chapters. So `chapterId = spine index` is **not** the right granularity — real chapter navigation requires parsing the **TOC/nav** and mapping chapter anchors to word ranges. This is exactly what open question #13 (structural metadata scheme) needs to resolve.

### How to run the headless parse

```bash
cd frontend
npx tsx experiments/explore-epub.mts ../epubs/prideandprejudice.epub
# or the toy fixture:
npx tsx experiments/explore-epub.mts experiments/fixtures/toy.epub
```

Requires the jsdom shim (`dom-shim.mts`) so `epubjs` gets `window`, `document`, `XMLHttpRequest`, and `URL.createObjectURL`.

---

## Experiment 1b — TOC-based word stream (spec conformance)

**Goal**: verify epubjs can emit a `WordStream` matching the spec — TOC-derived chapters, ordered metadata `[chapterId, sectionId, paragraphId, spineId]`, and a TOC-mapped `chapter_index`.

**Runner**: `frontend/experiments/toc-stream.mts`

### Results

| Metric | Pride and Prejudice | Toy fixture |
|--------|--------------------:|------------:|
| TOC entries | 63 | 2 |
| TOC anchors resolved | **63/63** | **2/2** |
| Chapters (from TOC) | 63 | 2 |
| Total words | 130,436 | 54 |
| Spec conformance | **PASS** | **PASS** |

### How it works

1. **Flatten TOC** (subitems → one level for M1).
2. **Walk each spine section's DOM** — emit words tagged with `sectionId` (heading h1–h6 boundaries), `paragraphId` (block elements `p`/`li`/`div`/...), `spineId` (physical file). Record element `id` → local word index anchors.
3. **Map TOC anchors** (`href#fragment`) → global word index via the section anchors + section start offsets.
4. **Build `chapter_index`** — sort TOC entries by start index; each chapter's `endIndex` = next chapter's start − 1.
5. **Assign `chapterId`** to every word by sweeping the chapter ranges.
6. **Validate** metadata order = `[chapterId, sectionId, paragraphId, spineId]`.

### Findings

- **All 63 TOC anchors resolved** to word indices — the `href#fragment` → word mapping works on a real Gutenberg EPUB.
- **Metadata order conforms** to the spec: `[chapterId, sectionId, paragraphId, spineId]` — the hierarchy-importance order that drives the navigation tree.
- **Chapter boundaries land on real words** (e.g., ch1 starts at "Chapter", ch2 at "I").
- **Word count differs slightly** from the naive `textContent.split` (130,436 vs 130,087) because the DOM walk skips `nav`/`script`/`style` and splits per text node — the walk is more accurate.
- **Section/paragraph ids are per-spine-file** (reset each spine item). For Gutenberg EPUBs where chapters span spine files, `sectionId` restarts per file — acceptable for M1, but a future refinement could carry section ids across spine boundaries.

### Caveats / next steps

- `chapterId` assignment uses a sweep over sorted chapter ranges; TOC order is assumed to be reading order (true for this book, verify on others).
- Fallback when a TOC anchor's fragment is missing → section start (works, but coarse).
- Nested TOC flattened for M1; a real tree could preserve subitems as `sectionId`-level structure.

---

## Open questions to resolve during this experiment

1. What exactly is a "section" vs a "paragraph" in real EPUBs? (open question #13)
2. What is the **canonical metadata scheme** EPUB should emit into `Word.metadata[]`? Which attribute is the "chapter" level for `chapter_index`?
3. How do we handle `<div>`-wrapped paragraphs and lists?
4. Do we need to preserve any inline formatting (bold/italic) for pacing? (Probably not for M1.)
5. What's the smallest set of fixture EPUBs that covers the common cases?