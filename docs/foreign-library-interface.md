# Foreign Library Interface v2

Foreign Libraries let Speedreader discover and acquire content from external catalogs and services. A library describes remote items and returns an import plan; it does not parse books, construct `WordStream` objects, access application storage, or receive raw credential values.

The normative TypeScript contract is [`frontend/src/foreign-libraries/types.ts`](../frontend/src/foreign-libraries/types.ts). This document defines the lifecycle and security rules around that contract.

## Compatibility and packaging

- Every manifest uses the exact API identifier `speedreader.foreign-library/v2`.
- Breaking contract changes require a new API identifier. Compatible plugin changes increment the manifest's semantic `version`.
- v2 plugins are trusted modules bundled with Speedreader and registered at startup.
- Inputs and outputs are deliberately serializable, apart from `AbortSignal`, so a later API can execute third-party plugins in workers without changing catalog or import semantics.

### Migrating from v1

Version 2 adds required manifest `outputs` and required offer `outputType` fields so the application can describe and filter a library before opening plugin code. A v1 adapter migrates by declaring each format it can produce and assigning every offer to one declaration; session and import-plan behavior is otherwise unchanged.

## Manifest

Each plugin exposes one immutable `ForeignLibraryManifest` and an asynchronous `open(host)` method. Manifest IDs are stable, namespaced, lowercase identifiers such as `org.gutenberg.catalog`.

| Field | Requirement |
|---|---|
| `apiVersion` | Exact supported Foreign Library API version |
| `id` | Globally unique, stable plugin identity |
| `version` | Semantic plugin implementation version |
| `name`, `description`, `homepage` | User-facing source information |
| `capabilities` | Operations the opened session actually implements |
| `outputs` | Stable output types, labels, delivery modes, MIME types, and extensions |
| `permissions.networkOrigins` | Exact HTTPS origins the host may contact |
| `permissions.manualDownloadOrigins` | Exact HTTPS origins the UI may open for user-directed downloads |
| `permissions.credentials` | Named credential slots; never credential values |
| `permissions.rateLimit` | Host-enforced concurrency/spacing ceiling |
| `permissions.maxResponseBytes` | Per-response ceiling, also capped by ingestion limits |

Supported v2 capabilities are `catalog.search`, `catalog.browse`, `item.resolve`, and `item.acquire`. Every plugin must resolve and acquire items; search and browse are optional but must match the methods exposed by its session.

Every plugin declares at least one output. Built-in filter types are `epub`, `html`, `pdf`, `json`, and `sugarcube`; future formats use a namespaced `x-*` identifier. `delivery` declares whether an output is downloaded, interactive, or both. Optional `mediaTypes` and `extensions` constrain the offers a plugin may return. These declarations populate the library browser before plugin code is opened, so users can filter sources without granting network or credential access.

## Session lifecycle

`open(host)` creates an isolated `ForeignLibrarySession`. The host validates the declared capabilities before returning it to application code.

1. `search` or `browse` returns a page of lightweight `ForeignItem` records.
2. `resolve` returns current metadata and concrete acquisition offers for one stable `ForeignItemRef`.
3. `planImport` converts a selected offer into either a download or interactive plan.
4. The application validates and executes that plan.
5. `dispose` releases caches, subscriptions, and other session resources.

Pages may include opaque cursors. Plugins must not encode credentials or other secrets in cursors, item metadata, URLs, errors, or logs.

## Item and offer contract

An item has a stable `(libraryId, itemId, revision?)` reference, a content kind, display metadata, provenance URLs/licensing, and zero or more offers. An offer states what the user is selecting without containing executable behavior.

| Offer field | Meaning |
|---|---|
| `outputType` | One output type declared by the plugin manifest |
| `importKind` | `download` for bytes or `interactive` for an existing interactive format |
| `mediaType`, `extension`, `byteLength` | Format hints shown before import |
| `priority` | Plugin preference; lower values are preferred |
| `risk` | `ordinary-content`, `remote-service`, or `executable-content` disclosure |

All returned item metadata must be JSON-safe and bounded. The registry rejects duplicate offer IDs, invalid references, unsupported kinds, non-JSON data, output attributed to another plugin, and offers whose output type, delivery mode, MIME type, or extension exceeds the manifest declaration.

## Import plans

### Download

A `ForeignDownloadPlan` contains an acquisition mode, request, parser-facing filename information, optional SHA-256 integrity value, and provenance. `host` acquisition (the default) downloads bytes under network permissions. `manual` acquisition never sends the request through the host: the UI opens an exact `manualDownloadOrigins` URL and imports only the file the user subsequently selects. Its optional `manualAction` distinguishes a direct file URL from a source listing where the user chooses a release. The coordinator verifies any supplied checksum and produces an ordinary `FileInfo`. From that point the existing `IngestionEngine` owns format detection, limits, sanitization, and parsing.

Downloaded content keeps Speedreader's content-addressed SHA-256 book identity, so the same bytes deduplicate with a local file import. `Book.foreignSource` records catalog provenance separately from content identity.

### Interactive

A `ForeignInteractivePlan` names an interactive format already registered with the application, supplies public JSON configuration, and maps format credential bindings to declared manifest credential slots. This supports model providers and other remote streams while preserving the existing format/runtime owner—for example, the OpenAI-compatible runtime remains responsible for the LLM chat flow.

Interactive plans never contain secrets. Speedreader validates the declared slot bindings before execution and stores only allowlisted public configuration on an ordinary library item. Credential values remain in the existing credential flow and encrypted vault; they are not written to books, reader state, streams, provenance, logs, or tests. Re-importing the same provider item resolves to the same deterministic local item and reports it as a duplicate.

Speedreader currently executes the registered `openai-compatible-llm` interactive format. Adding another interactive format requires an explicit executor and public-configuration validator in the application; a foreign plugin cannot introduce executable behavior merely by naming a new format.

## Host security requirements

- Only exact declared HTTPS origins are reachable; embedded URL credentials are rejected.
- Fetches omit ambient browser credentials.
- Plugins cannot set `Authorization`, `Cookie`, `Origin`, `Referer`, proxy authorization, or host headers.
- Credential values are injected by the host into a declared bearer or custom-header placement. Credentialed requests cannot redirect.
- Timeouts, cancellation, rate spacing, declared content lengths, streamed byte counts, and the application's global file-size ceiling are enforced outside plugin code.
- Final redirect origins are revalidated before response bytes are returned.
- A deployment must provide a first-party gateway when a catalog does not permit browser CORS. Gateways remain subject to the same origin, credential, size, and provenance rules. A plugin selects the allowlisted `gutenberg` or `catalog` route; the host owns the configured gateway base URL and the Worker independently validates every target.
- Manual acquisitions must be unauthenticated HTTPS GETs to a manifest-declared origin. They are never fetched by the Worker and never gain access to ambient browser credentials.

Plugins must treat remote responses as untrusted. The registry validates plugin output again before any result reaches storage or reader code.

## Bundled adapters

The bundled adapters are:

- `org.gutenberg.catalog` searches Project Gutenberg's OPDS feed, resolves EPUB editions, prefers EPUB3 with images, and preserves license and canonical-source metadata. Its final EPUB acquisition may use the allowlisted Worker; search and resolution remain direct. If the gateway is absent or unavailable, the selector offers a manual browser download followed by a constrained file picker.
- `org.ifdb.twine` uses [IFDB's official JSON search API](https://ifdb.org/api/search) with its required Twine system constraint. Opening the source uses a small bundled featured shelf and makes no request; explicit searches make one throttled, session-cached API request. Item inspection makes no detail request. Acquisition always opens the canonical IFDB listing so IFDB retains the user visit, then the user selects a downloaded HTML release for SugarCube detection without executing story scripts.
- `org.arxiv.catalog` uses the [arXiv Atom API](https://info.arxiv.org/help/api/) with a single connection and a three-second request interval. PDF acquisition is manual from `arxiv.org`; the Worker handles metadata only and never stores or serves papers, following the [arXiv API terms](https://info.arxiv.org/help/api/tou.html).
- `ai.openrouter.models` uses [OpenRouter's model catalog API](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) to browse popular text-output models and search by provider or model name. Selecting a model creates a reusable LLM Chat item containing only OpenRouter's public API base URL and model ID. The API key is requested by the existing connection dialog and may be stored only in Speedreader's encrypted credential vault.

The generic selector presents registered sources as a filterable list. Selecting a source opens a library-style catalog with semantic item icons, a persistent search bar, a featured collection, result counts, and cursor pagination. Featured collections are source-defined: popular downloads for Gutenberg, ranked Twine works from IFDB, recent AI papers from arXiv, and popular text-output models from OpenRouter. Additional adapters register with the same registry and expose `catalog.browse` and/or `catalog.search` rather than adding source-specific UI.

Model-provider adapters use interactive plans and declared credential slots rather than embedding request logic or keys in books. A catalog endpoint that permits browser CORS, such as OpenRouter's current model endpoint, can be queried directly under the host's origin and response-size constraints; it does not require a Worker route.
