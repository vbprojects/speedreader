# Foreign Library gateway

The PWA uses this Cloudflare Worker only for final Project Gutenberg EPUB downloads whose responses do not permit browser CORS. Catalog search and item resolution still go directly from the browser to Gutenberg.

The Worker is not a general proxy. It accepts only unauthenticated `GET` requests from configured Speedreader origins, only targets exact `https://www.gutenberg.org/ebooks/{id}.epub...` acquisition URLs, validates Gutenberg's redirect, requires an EPUB content type and declared size, rejects files above 128 MiB, strips upstream headers, disables storage, and streams the response.

## Deploy

1. Create or use a Cloudflare Workers Free account.
2. Create a restricted API token with **Account / Workers Scripts / Edit** permission and copy the account ID.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets in this repository.
4. Run the **Deploy Foreign Library gateway** workflow, or merge a gateway change to `main`.
5. Copy the deployed Worker URL, append `/v1/gutenberg`, and save the complete URL as the repository Actions variable `FOREIGN_LIBRARY_GATEWAY_URL`.
6. Re-run **Deploy PWA to GitHub Pages** so Vite embeds that public endpoint.

The endpoint should resemble:

```text
https://speedreader-foreign-library-gateway.<workers-subdomain>.workers.dev/v1/gutenberg
```

Check deployment health at `/health`. No application secret is sent to the Worker, and the gateway URL is intentionally a public build-time setting.

Without `FOREIGN_LIBRARY_GATEWAY_URL`, Speedreader attempts the original Gutenberg URL and offers a Safari download/file-picker fallback if browser CORS blocks it.
