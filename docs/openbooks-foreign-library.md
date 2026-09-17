## Prototype status (2026-09-16)

Implemented the initial connector in Foreign Libraries:

- Add/remove a named HTTPS OpenBooks server; configuration stays in local storage.
- Direct WSS CONNECT/search with configured subpath support, a ten-second cooldown,
  cancellation, a one-minute timeout and bounded responses.
- EPUB/PDF results use manual handoff only. The search socket closes when results
  arrive, before the user opens the server website. Speedreader stays open.
- Download on the server website, then choose the downloaded file in Speedreader
  to use the existing import preview.
- No DOWNLOAD commands, HTTP book requests or Cloudflare gateway fallback.

**Setup:** Library → Foreign Libraries → Add OpenBooks server. Enter the HTTPS
base URL (including its deployment subpath), save, select the server and search.
The server must accept direct browser WSS connections from Speedreader.
If it reports another connected client, close its existing website tab before
searching; you do not need to close Speedreader.

Protocol fixtures target upstream commit
`ad12382c4c00349fa596c45db053d6ed5f56dad5`. Live deployed HTTPS/WSS compatibility,
Safari behavior and mobile return-to-app flows remain unverified. This is a
prototype, not completion of every milestone below. Pending selections currently
survive the website handoff while Speedreader remains open, but not a reload.
Cross-tab connection coordination and persisted pending selections remain future
work. Each OpenBooks server may impose additional search limits.

---

# OpenBooks foreign-library connector — implementation plan

Status: planned; no connector implementation or live IRC requests yet.

## Scope and decisions

Add an optional OpenBooks source configured with a user-owned server URL.
Search results appear in Foreign Libraries. **Downloads are manual by design**:
open the user's OpenBooks website, download there, then select the local file
for Speedreader's existing import preview.

No search, IRC command, download, book content, or server credential goes through
Speedreader's Cloudflare Worker. No Worker routes or server-side proxy are added.
No central OpenBooks instance, public server directory, bulk crawling, automatic
downloads, or automatic import are provided. This separation describes traffic
ownership; it does not establish copyright permission for any particular book.

## User flow

1. Foreign Libraries → Add source → OpenBooks.
2. Enter a display name and HTTPS server URL, including any deployment subpath,
   for example `https://books.example.org/openbooks/`. Save locally.
3. Press Connect to open that server's WebSocket and start its IRC session.
   Saving settings alone does not connect. Show Connecting / Ready / Failed.
4. Enter a query and press Search. No search-as-you-type. Display the server's
   results with filename, format, and available metadata. Treat metadata as
   untrusted text; do not infer missing author/title/license with certainty.
5. Select a supported result → **Download on OpenBooks**. Show the filename and
   original search query, with a Copy query action.
6. Disconnect Speedreader's search session before handing off to OpenBooks.
   Present an explicit **Open server** link, in a separate tab, after disconnect.
   Open the configured base URL, not an invented search or download deep link.
   Explain that the user may need to repeat the search in OpenBooks.
7. User searches/downloads in OpenBooks itself, then returns and presses
   **Choose downloaded file** in Speedreader.
8. Use the existing import preview, duplicate detection, format validation and
   ingestion limits. The chosen file's contents/metadata determine what is
   imported; a matching filename does not prove it is the selected search item.

Retain the selected result and handoff locally across closing the modal or a
page refresh. Reconnection is explicit when returning to search; do not compete
with a still-open OpenBooks tab for the server's connection.

## Upstream findings and compatibility boundary

Inspected upstream commit `ad12382c4c00349fa596c45db053d6ed5f56dad5`:

- `server/routes.go`: `/ws`, `/servers`, `/stats`, and `/library` routes; the
  library routes are protected by the server's user/session middleware.
- `server/messages.go`: WebSocket JSON envelopes use `type` and `payload`.
  Message types are STATUS=0, CONNECT=1, SEARCH=2, DOWNLOAD=3, RATELIMIT=4.
  SEARCH payload is `{query: string}`; responses contain `books` and `errors`.
- The inspected server permits only one active client. Handoff must release our
  connection before the OpenBooks UI can connect.
- The inspected WebSocket origin check accepts origins, but reverse proxies and
  other versions may restrict them. WebSocket access is separate from HTTP CORS.
- The server uses an `OpenBooks` HttpOnly, SameSite=Strict session cookie;
  automatic cross-site library downloads would be problematic. Manual top-level
  browsing avoids requiring Speedreader to read that cookie or fetch book bytes.
- Browser downloads can be disabled by server configuration. In that case the
  user needs access to the server's saved files; do not promise an in-browser
  download that the instance does not provide.
- No stable REST search API or supported search deep-link contract was verified.
  Isolate the observed protocol in a versioned adapter and validate fixtures
  against a supported upstream release before implementation is considered ready.

Manual mode never sends the DOWNLOAD command from Speedreader and never fetches
`/library`, `/stats`, or `/servers`. It opens only the configured server site.

Sources:
- https://github.com/evan-buss/openbooks/tree/ad12382c4c00349fa596c45db053d6ed5f56dad5/server
- https://evan-buss.github.io/openbooks/irc-notes/
- https://evan-buss.github.io/openbooks/developers/architecture/

OpenBooks documents a ten-second minimum search interval and approved-client
version restrictions. Preserve the server's own network identity and restrictions;
do not spoof versions or bypass restrictions. Verify supported release behavior
rather than assuming all OpenBooks deployments use the inspected branch.

## Architecture and repository changes

### Configured sources

Add a versioned local configured-source store with opaque stable source IDs.
Store `{id, kind: 'openbooks', name, baseUrl}`. Preserve URL subpaths; reject
embedded usernames/passwords, query strings and fragments. HTTPS/WSS only for
v1, consistent with the current FLI transport and manual-download validators.
Plain HTTP localhost/LAN support is deferred, not enabled by loosening global
validation. A local server can be used through a user-managed HTTPS endpoint.

Register `openbooks:<source-id>` dynamically in the registry with search,
resolve and acquire capabilities. No catalog browse capability. Each source gets
its own allowed network and manual-download origin. Editing/removing a source
closes its session and invalidates its results; do not reuse results with a new
server URL. Remember source identity separately from human-readable names.

### WebSocket transport boundary

The current `ForeignLibraryHost` provides HTTP requests only. Add a host-owned
WebSocket session capability with explicit manifest permissions and an injectable
socket factory for tests. Plugins must not bypass host validation with arbitrary
`new WebSocket` calls. The host derives/validates the exact WSS endpoint under
that source's configured base path. There is no gateway fallback.

The page CSP currently permits WSS only for Bluesky. Supporting arbitrary
user-configured servers requires `connect-src wss:` in the browser policy;
compensate with exact configured-endpoint validation in the host. Audit production,
preview, and packaged-app policies separately; do not claim native support based
solely on the GitHub Pages test.

Keep a single session per configured source. Serialize operations because the
observed protocol has no request IDs. Bind results to a session generation;
after a timeout/cancel, close that session so late responses cannot satisfy a
new query. Set bounded connect/search timeouts and cap JSON message bytes and
result count before parsing/mapping where the browser permits. Native WebSocket
buffers full messages, so this does not guarantee a pre-allocation memory cap.

Explicit Search only; one pending search and at least ten seconds between sends.
Honor server rate-limit/status messages. Show queue status without inventing
percentage progress. On disconnect or rejection, show a useful error and explicit
retry; never automatically replay a search. Abort/dispose closes timers, pending
promises and sockets. Use a same-origin cross-tab lock where available to avoid
our own tabs opening competing sessions; the server remains authoritative.

### Plugin and manual import

Implement `OpenBooksForeignLibrary` as a configured plugin, with protocol parsing
in a separate module. Cache validated search records for `resolve`; an expired
record requires a new user-directed search rather than silently issuing one.
Use deterministic IDs scoped to the configured source and full returned result
identity, not just a filename. Do not expose raw IRC command execution.

Start with EPUB and PDF offers. Unsupported formats may be described in results
but must not offer import or imply automatic conversion. Extend formats only
when the existing ingestion pipeline supports them.

`planImport` returns an existing `ForeignDownloadPlan` with:

- `acquisition: 'manual'`
- `manualAction: 'source-page'`
- GET URL equal to the configured OpenBooks base URL
- no gateway field, credentials, request body, or generated download endpoint
- selected result provenance plus a clear manual-selection/unverified-match note

Reuse `manualForeignDownload` and the existing file-picker/import-preview flow.
Retain its origin checks. Keep server session credentials out of file provenance
and book exports; license stays unknown unless reliable rights metadata exists.

### UI

Use the existing Foreign Libraries styling. Add configured-source management,
connection status, explicit search, cooldown, and the two-step manual handoff.
Explain “Downloaded files are selected from your device; Speedreader does not
proxy downloads.” The user's server host should remain visible during handoff.
Render all server descriptions, status messages and filenames as plain text.

## Authentication and deployment limits

V1 targets a user-managed server that accepts the browser WebSocket connection.
Do not request credentials in a URL or silently send existing app credentials.
A reverse proxy requiring custom Authorization headers cannot be assumed to work
with browser WebSocket; browser authentication/third-party-cookie restrictions
must be tested per deployment. Show unsupported-auth or connection guidance
rather than adding a shared proxy. Do not weaken the user's server access policy.

If a stock server cannot be searched from the browser, preserve **Open server →
Choose downloaded file** as a manual-only mode. In that mode show that integrated
search is unavailable, rather than representing a launcher as a searchable catalog.

## Implementation phases and acceptance criteria

1. **Compatibility spike:** fixture-based protocol client plus a local test server;
   confirm CONNECT/search/status/error shapes, timeout behavior, base paths and
   single-client handoff against a supported OpenBooks version. Use controlled
   fixtures or authorized content for any end-to-end test; no bulk IRC searches.
2. **Configured source and transport:** local store, dynamic registration,
   validated WebSocket host, CSP changes, cancellation and session isolation.
3. **Catalog UI and manual handoff:** supported offers, retained selection,
   disconnect-before-open, file picker, import preview and provenance.
4. **Validation and documentation:** setup guide with compatible deployment
   requirements, changelog, desktop/mobile browser checks and regression suite.

Required checks:

- Root/subpath URLs work; URL credentials, wrong protocols, unexpected endpoints,
  unsafe returned URLs and cross-source item IDs are rejected.
- Searches respect cooldown; malformed/oversized messages, disconnects, partial
  results, cancellation and late responses cannot corrupt another query.
- Handoff frees the one-client session. Cancelled/failed handoff retains selection.
- No DOWNLOAD command is sent; no HTTP book request or shared gateway request is
  made. Set a fake configured Cloudflare gateway and fail the test on any access.
- Manual plans open only the configured server; no popup is launched outside a
  direct user gesture. Filename mismatch prompts review rather than proving identity.
- Valid EPUB/PDF files import through normal preview/deduplication; invalid or
  oversized files fail without losing the pending selection.
- Production-style HTTPS cross-origin browser tests verify WSS, opening the
  source site, return-to-app and file selection. Test Safari as well as Chromium.

Done means search + manual handoff + import works with a documented compatible
user-owned OpenBooks instance, with zero traffic through our Cloudflare gateway.
