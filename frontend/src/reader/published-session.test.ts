import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublishedSession, type PublishedSessionStatus } from "./published-session";
import { empty, envelope, diff, StoryRevisionConflict, type Snapshot, type PublishedCommit, type FramePayload, type ParentMessage } from "../ingestion/sugarcube/storage-protocol";
const epoch = "00000000-0000-4000-8000-000000000001";
const next = (value: string): Snapshot => ({ local: [["slot", value]], session: [] });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred() {
  let resolve!: () => void, reject!: (cause: unknown) => void;
  const promise = new Promise<void>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function setup(commit: (batch: PublishedCommit) => Promise<void>, timeoutMs?: number) {
  const sent: ParentMessage[] = [], statuses: PublishedSessionStatus[] = [], restarted: Snapshot[] = [];
  let closed = 0, drained = 0, count = 1;
  const session = createPublishedSession({ epoch, sourceHash: "source", initial: { revision: "base", snapshot: empty() }, commit, timeoutMs,
    send: message => sent.push(message), close: () => { closed++; }, changed: state => statuses.push(state),
    started: () => {}, drained: () => { drained++; }, restarted: saved => { restarted.push(saved.snapshot); },
    id: () => `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`,
  });
  return { session, sent, statuses, restarted, get closed() { return closed; }, get drained() { return drained; },
    receive: (value: FramePayload) => session.receive(envelope(epoch, value)) };
}

test("ACK follows transaction completion", async () => {
  const gate = deferred(), commits: PublishedCommit[] = [];
  const h = setup(async batch => { commits.push(batch); await gate.promise; });
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) });
  await tick(); assert.equal(commits.length, 1); assert.equal(h.sent.some(m => m.type === "ack"), false);
  gate.resolve(); await tick();
  assert.deepEqual(h.sent.filter(m => m.type === "ack"), [envelope(epoch, { type: "ack", seq: 1 })]); h.session.dispose();
});

test("restart retains one terminal batch behind an in-flight commit", async () => {
  const gates = [deferred(), deferred()], commits: PublishedCommit[] = [];
  const h = setup(async batch => { const i = commits.length; commits.push(batch); await gates[i].promise; });
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) });
  h.receive({ type: "restart", baseSeq: 1, delta: diff(next("A"), next("B")) });
  await tick(); assert.equal(commits.length, 1); assert.equal(h.restarted.length, 0);
  gates[0].resolve(); await tick(); assert.equal(commits.length, 2);
  assert.equal(commits[1].expected, commits[0].revision); assert.deepEqual(commits[1].next, next("B"));
  gates[1].resolve(); await tick(); assert.deepEqual(h.restarted, [next("B")]);
  assert.equal(h.sent.some(m => m.type === "ack"), false); h.session.dispose();
});

test("retry preserves the operation identity after an uncertain acknowledgement", async () => {
  const commits: PublishedCommit[] = [];
  const h = setup(async batch => { commits.push(batch); if (commits.length === 1) throw new DOMException("disk full", "QuotaExceededError"); });
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) }); await tick();
  assert.equal(h.sent.some(m => m.type === "ack"), false); assert.equal(h.statuses[h.statuses.length - 1].retryable, true);
  h.session.retry(); await tick(); assert.equal(commits.length, 2); assert.equal(commits[0], commits[1]);
  assert.equal(h.sent.filter(m => m.type === "ack").length, 1); h.session.dispose();
});

test("conflicting session pauses, cannot retry a stale write, and exports live state", async () => {
  let commits = 0; const h = setup(async () => { commits++; throw new StoryRevisionConflict(); });
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) }); await tick();
  assert.equal(h.closed, 0); assert.equal(h.statuses[h.statuses.length - 1].retryable, false);
  h.session.retry(); await tick(); assert.equal(commits, 1);
  const result = h.session.exportLive(), request = h.sent[h.sent.length - 1];
  assert.equal(request.type, "export"); if (request.type !== "export") throw new Error("Missing export request");
  h.receive({ type: "exported", requestId: request.requestId, snapshot: next("newer-in-memory") });
  assert.deepEqual(await result, next("newer-in-memory")); h.session.dispose();
});

test("restart after conflict is retained for export and never persisted", async () => {
  let commits = 0; const h = setup(async () => { commits++; throw new StoryRevisionConflict(); });
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) }); await tick();
  h.receive({ type: "restart", baseSeq: 1, delta: diff(next("A"), next("B")) }); await tick();
  assert.deepEqual(await h.session.exportLive(), next("B")); assert.equal(commits, 1); assert.equal(h.restarted.length, 0); h.session.dispose();
});

test("recovery suspension awaits the active write and prevents a later commit", async () => {
  const gate = deferred(), commits: PublishedCommit[] = [];
  const h = setup(async batch => { commits.push(batch); await gate.promise; });
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) }); await tick();
  let settled = false; const suspended = h.session.suspend().then(() => { settled = true; });
  await tick(); assert.equal(settled, false); gate.resolve(); await suspended;
  h.receive({ type: "delta", seq: 2, delta: diff(next("A"), next("B")) }); await tick();
  assert.equal(commits.length, 1); h.session.dispose(); await tick(); assert.equal(commits.length, 1);
});

test("protocol violations close the channel before database work", async () => {
  const bad = [
    { ...envelope(epoch, { type: "delta", seq: 1, delta: diff(empty(), next("A")) }), epoch: "00000000-0000-4000-8000-000000000099" },
    { ...envelope(epoch, { type: "started" }), unexpected: "payload" },
    envelope(epoch, { type: "delta", seq: 2, delta: diff(empty(), next("A")) }),
    envelope(epoch, { type: "delta", seq: 1, delta: diff(empty(), next("x".repeat(3 * 1024 * 1024))) }),
  ];
  for (const message of bad) {
    let writes = 0; const h = setup(async () => { writes++; });
    h.session.receive(message); await tick(); assert.equal(h.closed, 1); assert.equal(writes, 0); h.session.dispose();
  }
});

test("Library waits for drain; disposal cannot ACK a late commit", async () => {
  const h = setup(async () => {});
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) }); await tick();
  assert.equal(h.session.drain(), true); assert.equal(h.drained, 0);
  h.receive({ type: "drained", reason: "exit", seq: 1 }); assert.equal(h.drained, 1); h.session.dispose();
  const gate = deferred(), late = setup(() => gate.promise);
  late.receive({ type: "delta", seq: 1, delta: diff(empty(), next("A")) }); await tick();
  late.session.dispose(); gate.resolve(); await tick(); assert.equal(late.sent.some(m => m.type === "ack"), false);
});

test("a delayed export reply after mobile suspension does not close a healthy session", async () => {
  const h = setup(async () => {}, 5);
  const pending = h.session.exportLive(), request = h.sent[h.sent.length - 1];
  if (request.type !== "export") throw new Error("Missing export request");
  await assert.rejects(pending, /timed out/);
  h.receive({ type: "exported", requestId: request.requestId, snapshot: empty() });
  assert.equal(h.closed, 0);
  h.receive({ type: "delta", seq: 1, delta: diff(empty(), next("after-resume")) }); await tick();
  assert.equal(h.sent.some(message => message.type === "ack"), true); h.session.dispose();
});
