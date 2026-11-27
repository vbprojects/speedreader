// Test-only entry point. This file is never imported by the application.
import * as protocol from "../../src/ingestion/sugarcube/storage-protocol";
import { createStorageBridge } from "../../src/ingestion/sugarcube/storage-frame";
import { createPublishedSession } from "../../src/reader/published-session";
import { loadPublished, commitPublished, replacePublished, STORE_PUBLISHED, STORE_PUBLISHED_USAGE, STORE_PUBLISHED_BUDGET } from "../../src/db/published-storage";

type Mode = "before-submit" | "during-transaction" | "committed-before-ack" | "after-ack";
const bookId = "crash-fixture", sourceHash = "c".repeat(64), stateStore = "readerStates";
let phase = "opening", attempt: protocol.PublishedCommit | undefined;
let writer: ReturnType<typeof createPublishedSession> | undefined, bridge: ReturnType<typeof createStorageBridge> | undefined;
const never = () => new Promise<void>(() => {});
const text = (id: string, value: string) => { document.getElementById(id)!.textContent = value; };
function setPhase(value: string) { phase = value; text("phase", value); }
const db = await new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open("speedreader-crash-fixture", 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    db.createObjectStore(stateStore, { keyPath: "bookId" });
    db.createObjectStore("interactiveSources", { keyPath: "bookId" });
    db.createObjectStore(STORE_PUBLISHED, { keyPath: ["bookId", "area", "key"] });
    db.createObjectStore(STORE_PUBLISHED_USAGE, { keyPath: "bookId" });
    db.createObjectStore(STORE_PUBLISHED_BUDGET, { keyPath: "id" });
    request.transaction!.objectStore(stateStore).put({ bookId, position: 7, lastOpenedAt: 0, settings: {}, formatState: { passage: "native-preserved" } });
    request.transaction!.objectStore("interactiveSources").put({ bookId, sourceHash });
  };
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
const snapshot = (value: string): protocol.Snapshot => ({ local: [["slot", value]], session: [["history", value]] });
async function read() {
  const saved = await loadPublished(db, stateStore, bookId, sourceHash);
  text("saved", JSON.stringify(saved)); return saved;
}
async function prepare() {
  writer?.dispose(); bridge?.dispose();
  const current = await loadPublished(db, stateStore, bookId, sourceHash);
  await replacePublished(db, stateStore, bookId, { sourceHash, expected: current.revision, revision: crypto.randomUUID(), snapshot: snapshot("before") });
  attempt = undefined; await read(); setPhase("prepared");
}
function holdTransaction() {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
    const request = key === undefined ? original.call(this, value) : original.call(this, value, key);
    if (this.name === STORE_PUBLISHED && (value as { value?: string }).value === "after") {
      IDBObjectStore.prototype.put = original;
      const store = this;
      request.onsuccess = () => {
        setPhase("during-transaction");
        // Test-only request chain keeps the actual production transaction open
        // after its real row writes. A process kill must roll back the whole tx.
        const until = performance.now() + 60000;
        const keepAlive = () => {
          if (performance.now() > until) { setPhase("hold-expired-repeat-test"); return; }
          const pending = store.get([bookId, "local", "__hold__"]);
          pending.onsuccess = keepAlive;
        };
        keepAlive();
      };
    }
    return request;
  };
}
async function run(mode: Mode) {
  if (!["before-submit", "during-transaction", "committed-before-ack", "after-ack"].includes(mode)) throw new Error("Unknown mode");
  const initial = await loadPublished(db, stateStore, bookId, sourceHash);
  if (initial.snapshot.local[0]?.[1] !== "before") throw new Error("Prepare a fresh baseline before each kill.");
  const channel = new MessageChannel(), epoch = crypto.randomUUID();
  writer = createPublishedSession({ epoch, sourceHash, initial,
    commit: async batch => {
      attempt = batch;
      if (mode === "before-submit") { setPhase(mode); await never(); }
      if (mode === "during-transaction") holdTransaction();
      await commitPublished(db, stateStore, bookId, batch);
      if (mode === "committed-before-ack") { setPhase(mode); await never(); }
    },
    send: message => channel.port1.postMessage(message), close: () => channel.port1.close(),
    changed: status => { if (status.error) setPhase("error: " + status.error); },
    started: () => {}, drained: () => {}, restarted: () => {},
  });
  channel.port1.onmessage = event => writer!.receive(event.data);
  bridge = createStorageBridge(protocol, channel.port2, initial.snapshot, epoch);
  const onmessage = channel.port2.onmessage!;
  channel.port2.onmessage = event => {
    onmessage.call(channel.port2, event);
    if (event.data?.type === "ack") setPhase("after-ack");
  };
  bridge.local.setItem("slot", "after"); bridge.session.setItem("history", "after"); bridge.flush();
}
const api = { ready: false, get phase() { return phase; }, get attempt() { return attempt; }, prepare, run, read,
  replay: (batch: protocol.PublishedCommit) => commitPublished(db, stateStore, bookId, batch) };
Object.assign(window, { crashHarness: api });
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-mode]")) button.onclick = () => {
  void run(button.dataset.mode as Mode).catch(cause => setPhase(String(cause)));
};
document.getElementById("prepare")!.onclick = () => { void prepare().catch(cause => setPhase(String(cause))); };
document.getElementById("read")!.onclick = () => { void read().catch(cause => setPhase(String(cause))); };
await read(); setPhase("ready"); api.ready = true;
if ("serviceWorker" in navigator) {
  await navigator.serviceWorker.register("sw.js"); await navigator.serviceWorker.ready;
  text("offline", "Harness cached. Reload once before testing offline.");
}
