import { test } from "node:test";
import { equal, deepStrictEqual, rejects, throws } from "node:assert/strict";
import { OpenBooksForeignLibrary, openBooksBaseUrl } from "./openbooks";
import { ForeignLibraryRegistry } from "./registry";
import { ConstrainedForeignLibraryHost } from "./transport";

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: { type: number; payload: unknown }[] = [];
  closed = false;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function fixture() {
  const socket = new Socket();
  const plugin = new OpenBooksForeignLibrary({ id: "test", name: "My books", baseUrl: "https://books.example/sub/" });
  const registry = new ForeignLibraryRegistry(() => ({
    request: async () => { throw Error("HTTP or gateway must never be used"); },
    openWebSocket: url => { equal(url, "wss://books.example/sub/ws"); return socket as unknown as WebSocket; },
  }));
  registry.register(plugin);
  return { socket, registry, plugin };
}
test("OpenBooks normalizes subpaths and rejects unsafe configuration", () => {
  equal(openBooksBaseUrl(" https://books.example/sub "), "https://books.example/sub/");
  for (const url of ["http://books.example", "https://user:pass@books.example", "https://books.example/?token=x", "https://books.example/#x"]) {
    throws(() => openBooksBaseUrl(url));
  }
  const { plugin } = fixture();
  const host = new ConstrainedForeignLibraryHost(plugin.manifest);
  throws(() => host.openWebSocket("wss://elsewhere.example/ws"));
  throws(() => host.openWebSocket("wss://books.example/sub/ws?token=x"));
});
test("OpenBooks searches directly, releases connection and produces only a manual plan", async () => {
  const { socket, registry, plugin } = fixture();
  const session = await registry.open(plugin.manifest.id);
  const pending = session.search!({ query: "test book" });
  socket.onopen!();
  socket.message({ type: 1, appearance: 1 });
  socket.message({ type: 2, appearance: 1, books: [
    { title: "Test book", author: "Someone", format: "epub", full: "https://evil.example/file" },
    { title: "Unsupported", format: "exe" },
  ] });
  const page = await pending;
  equal(page.items.length, 1);
  equal(socket.closed, true);
  deepStrictEqual(socket.sent, [{ type: 1, payload: {} }, { type: 2, payload: { query: "test book" } }]);
  const plan = await session.planImport(page.items[0].ref, "epub");
  equal(plan.kind, "download");
  if (plan.kind !== "download") throw Error("wrong plan");
  equal(plan.acquisition, "manual");
  equal(plan.request.url, "https://books.example/sub/");
  await rejects(session.resolve({ libraryId: "wrong.library", itemId: page.items[0].ref.itemId }));
  await rejects(session.search!({ query: "again" }), /ten seconds/);
  await session.dispose();
});
test("OpenBooks cancellation, malformed responses and disposal close connections", async () => {
  for (const action of ["abort", "malformed", "dispose", "rate-limit"]) {
    const { socket, registry, plugin } = fixture();
    const session = await registry.open(plugin.manifest.id);
    const controller = new AbortController();
    const pending = session.search!({ query: "test", signal: controller.signal });
    if (action === "abort") controller.abort();
    if (action === "malformed") socket.onmessage!({ data: "{" });
    if (action === "dispose") await session.dispose();
    if (action === "rate-limit") socket.message({ type: 4, title: "Slow down" });
    await rejects(pending);
    equal(socket.closed, true);
    equal(socket.onmessage, null);
  }
});
