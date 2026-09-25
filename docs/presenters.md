# Presenters: selectable reading experiences

## Using the feature

Open a title, then **Settings → Reading experience**. The default is **Standard**.

- **Book layout** is available for EPUBs. It renders source headings and paragraphs in Read along and Context.
- **Post cards** is available for Bluesky feeds. New structured posts get attribution, timestamps when available, and source links.
- RSVP keeps its single-word display. Changing experience pauses reading and preserves the current word; press Play to resume.
- Selection is saved per title/feed, separately from global settings and ingestion state. If a presenter fails or is unavailable, the reader shows Standard and offers a recovery button.

Previously cached EPUBs use available paragraph metadata without guessing headings. Previously cached Bluesky posts keep their old HTML presentation. Neither requires re-import.

## Pipeline and invariants

Source → ingestion → canonical WordStream → presenter session → reader.

WordStream.blocks contains non-overlapping semantic ranges [start, end), stable IDs and source references. EPUB ingestion extracts heading levels and paragraph ranges from its bounded DOM walk. Bluesky ingestion keeps complete post ranges together, including quote/repost content. Append processing validates local ranges and offsets them exactly once.

Presenters never replace or re-tokenize canonical words. RangeFlow wraps the same visible word spans the reader already uses, including clipped viewport windows. Attribution is display chrome, not spoken text. Links are HTTPS-only and all user text renders as escaped React text. Existing HTML presentations still use the existing sanitization path.

The registry in frontend/src/presenters/registry.ts supports one layout and ordered behavior presenters. A plugin supplies:

- A manifest: stable ID, version, label, role and required capabilities.
- open(): a fresh session.
- update(canonical, signal): owned layouts, interactions, HTML presentations and/or triggers.
- Optional handleEvent(event) plus dispose().

Update output is a complete replacement for that presenter's previous output, not an append. The pipeline always composes from canonical content. IDs become presenter:<plugin-id>:<local-id>; event delivery translates IDs back to local IDs. Unknown events continue through the source engine. Presenter actions and completion records use the reader's existing interaction machinery.

Update cancellation, generation checks and disposal prevent late output from being applied to another selection/title. Implementations must honor the abort signal before any external side effects. A failed update disposes the pipeline and falls back to Standard.

Bluesky author/separator chrome is now derived in the presentation layer. Post cards replace that equivalent chrome, while retaining quote content. Legacy HTML remains readable. Presenter selection does not restart a live connection or change feed demand/backpressure.

## Storage and migration

IndexedDB version 3 adds sourceFiles, keyed by the existing content hash/book ID. Newly imported EPUBs retain original bytes and file metadata before import is reported successful. The derived book still records its parser version.

Duplicate EPUB imports may backfill missing originals without reparsing an existing stream or resetting progress. Original-write failure rejects import. If a later stage fails, retained bytes remain recoverable by retrying the import. There is no automatic re-parsing or parser-selection wizard.

Soft removal retains originals and presenter selection. Permanent deletion removes them with the book, stream and reader state. Existing databases/books remain readable without originals or semantic blocks.

## Validation

Automated tests cover EPUB extraction and nesting, legacy fallback, range validation/offsets, safe card rendering, canonical word identity, action ownership, cancellation/disposal, database upgrades, source retention/backfill, storage failure, and deletion.

Chromium browser checks cover per-title selection, retained position on reopen, EPUB heading semantics, mobile layouts without horizontal overflow, offline cached post cards, and unavailable-presenter recovery. Physical Safari/iOS testing remains outstanding.

## Next extension: chapter review

No AI requests, quiz UI or generated-content cache ship in this release. A fixture behavior presenter verifies chapter-end interactions and event ownership.

A future opt-in chapter-review presenter will use the configured model provider, prepare ahead of chapter endings, cache questions by content/presenter/configuration revision, and store answers independently. It must disclose external text sharing and provide explicit retry/skip behavior.
