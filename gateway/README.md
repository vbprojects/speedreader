# Foreign Library gateway

The PWA uses this Cloudflare Worker for final Project Gutenberg EPUB downloads, bounded catalog metadata requests that browser CORS would otherwise block, and supported IF Archive Twine releases. Project Gutenberg catalog requests remain direct. arXiv PDFs and Twine releases hosted outside IF Archive remain user-directed downloads from their source pages.

The Worker is not a general proxy. It accepts only unauthenticated `GET` requests from configured Speedreader origins and exposes three routes:

- `/v1/gutenberg` accepts exact `https://www.gutenberg.org/ebooks/{id}.epub...` acquisition URLs, validates the same-book redirect, requires EPUB content and a declared size, rejects files above 128 MiB, and streams the response.
- `/v1/catalog` accepts only documented IFDB Twine search/detail queries and arXiv Atom queries capped at 25 results. IFDB responses carry a short client/edge cache lifetime. The route rejects redirects, unexpected content types, and metadata above 2 MiB before returning buffered JSON or XML.
- `/v1/twine` accepts an opaque IFDB resolver request containing a validated TUID and offer index/mode. It re-resolves the offer from IFDB, permits only IF Archive game paths and its unboxing service, can search the Archive by exact TUID, follows at most four revalidated redirects, requires HTML/ZIP content with a declared size, and streams at most 128 MiB. External IFDB links are rejected rather than proxied.

All routes strip upstream headers and disable storage. Twine acquisition does not reflect the resolved external URL to the caller. IFDB and IF Archive requests use a fixed non-browser user agent.

## Deploy

1. Create or use a Cloudflare Workers Free account.
2. Create a restricted API token with **Account / Workers Scripts / Edit** permission and copy the account ID.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets in this repository.
4. Run the **Deploy Foreign Library gateway** workflow, or merge a gateway change to `main`.
5. Copy the deployed Worker URL, append `/v1`, and save the complete URL as the repository Actions variable `FOREIGN_LIBRARY_GATEWAY_URL`.
6. Re-run **Deploy PWA to GitHub Pages** so Vite embeds that public endpoint.

The endpoint should resemble:

```text
https://speedreader-foreign-library-gateway.<workers-subdomain>.workers.dev/v1
```

Check deployment health at `/health`. No application secret is sent to the Worker, and the gateway URL is intentionally a public build-time setting.

Without `FOREIGN_LIBRARY_GATEWAY_URL`, Gutenberg retains its direct/manual fallback, but IFDB and arXiv catalog search can fail where their APIs do not permit browser CORS.
