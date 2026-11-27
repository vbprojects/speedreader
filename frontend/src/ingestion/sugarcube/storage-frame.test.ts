import assert from "node:assert/strict";
import { test } from "node:test";
import * as p from "./storage-protocol";
import { createStorageBridge, type BridgeClock } from "./storage-frame";

const epoch = "test-epoch-00000000000001";
const requestId = "test-request-000000000001";

function fakeBridge(initial = p.empty()) {
  const sent: p.FrameMessage[] = [], times: number[] = [];
  const timers = new Map<number, { at: number; fn: () => void }>();
  let now = 0, id = 0, closed = false;
  const clock: BridgeClock = {
    now: () => now,
    setTimeout(fn, delay) { timers.set(++id, { at: now + delay, fn }); return id; },
    clearTimeout(n) { timers.delete(n); },
  };
  const port = {
    postMessage(data: p.FrameMessage) { sent.push(structuredClone(data)); times.push(now); },
    close() { closed = true; },
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  };
  const bridge = createStorageBridge(p, port as unknown as MessagePort, initial, epoch, clock);
  const receive = (data: unknown, ports: MessagePort[] = []) => port.onmessage?.({ data, ports } as unknown as MessageEvent<unknown>);
  const deliver = (payload: p.ParentPayload) => receive(p.envelope(epoch, payload));
  function advance(ms: number) {
    const target = now + ms;
    let count = 0;
    while (true) {
      const first = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      if (++count > 1000) throw new Error("timer loop");
      timers.delete(first[0]); now = first[1].at; first[1].fn();
    }
    now = target;
  }
  return { sent, times, bridge, receive, deliver, advance, pendingTimers: () => timers.size, isClosed: () => closed };
}

test("one in-flight batch coalesces 10,000 writes and drains only after every commit ACK", () => {
  const { bridge, sent, deliver, receive, advance } = fakeBridge();
  bridge.local.setItem("slot", "first"); bridge.session.setItem("history", "one");
  advance(74); assert.equal(sent.length, 0); advance(1); assert.equal(sent.length, 1);
  for (let i = 0; i < 10000; i++) bridge.local.setItem("slot", String(i));
  bridge.session.clear(); advance(5000); assert.equal(sent.length, 1);
  deliver({ type: "ack", seq: 99 });
  receive({ type: "ack", seq: 1 });
  receive(p.envelope("stale-epoch-0000000000001", { type: "ack", seq: 1 }));
  assert.equal(sent.length, 1);
  deliver({ type: "drain" }); assert.equal(sent.length, 1);
  assert.throws(() => bridge.local.setItem("slot", "late"), { name: "InvalidStateError" });
  deliver({ type: "ack", seq: 1 });
  assert.deepEqual(sent[1], p.envelope(epoch, { type: "delta", seq: 2, delta: { local: { put: [["slot", "9999"]], remove: [] }, session: { put: [], remove: ["history"] } } }));
  assert.equal(sent.length, 2);
  deliver({ type: "ack", seq: 2 });
  assert.deepEqual(sent[2], p.envelope(epoch, { type: "drained", reason: "exit", seq: 2 }));
  deliver({ type: "drain" }); deliver({ type: "ack", seq: 2 });
  assert.equal(sent.length, 3);
});

test("continuous small edits have a fixed deadline instead of an endlessly reset debounce", () => {
  const { bridge, sent, times, deliver, advance } = fakeBridge();
  for (let i = 0; i < 8; i++) { bridge.local.setItem("s", String(i)); advance(i === 7 ? 5 : 10); }
  assert.equal(sent.length, 1); assert.deepEqual(times, [75]);
  assert.deepEqual((sent[0] as Extract<p.FrameMessage, { type: "delta" }>).delta.local.put, [["s", "7"]]);
  deliver({ type: "ack", seq: 1 });
  bridge.local.setItem("s", "later"); advance(249); assert.equal(sent.length, 1);
  advance(1); assert.deepEqual(times, [75, 325]);
});

test("large mutations respect 4 Hz even when every commit is acknowledged immediately", () => {
  const { bridge, sent, times, deliver, advance } = fakeBridge();
  let acknowledged = 0;
  const prefix = "x".repeat(150000);
  for (let i = 0; i <= 100; i++) {
    bridge.local.setItem("slot", prefix + i);
    advance(0);
    if (sent.length > acknowledged) { acknowledged = sent.length; deliver({ type: "ack", seq: acknowledged }); }
    if (i < 100) advance(10);
    if (sent.length > acknowledged) { acknowledged = sent.length; deliver({ type: "ack", seq: acknowledged }); }
  }
  assert.deepEqual(times, [0, 250, 500, 750, 1000]);
  assert.equal(sent.length, 5);
  assert.ok(sent.slice(1).every(m => m.type === "delta" && m.delta.local.patches?.length === 1));
});

test("repeated visibility flushes get at most one extra credit per second", () => {
  const { bridge, sent, times, deliver, advance } = fakeBridge();
  bridge.local.setItem("slot", "x".repeat(150000)); advance(0);
  deliver({ type: "ack", seq: 1 }); advance(1);
  bridge.local.setItem("slot", "urgent"); bridge.flush();
  assert.deepEqual(times, [0, 1]); deliver({ type: "ack", seq: 2 });
  for (let i = 0; i < 20; i++) {
    bridge.local.setItem("slot", "next" + i); bridge.flush(); advance(1);
  }
  assert.equal(sent.length, 2); advance(229); assert.equal(sent.length, 2);
  advance(1); assert.deepEqual(times, [0, 1, 251]);
});

test("restart posts one terminal batch synchronously before SugarCube's immediate reload", () => {
  const { bridge, sent, deliver } = fakeBridge();
  bridge.local.setItem("a", "1"); bridge.local["b"] = "2";
  delete bridge.local["a"]; bridge.flush();
  bridge.session.setItem("last", "reset"); bridge.restart();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], p.envelope(epoch, { type: "restart", baseSeq: 1, delta: { local: { put: [], remove: [] }, session: { put: [["last", "reset"]], remove: [] } } }));
  assert.throws(() => bridge.session.clear(), { name: "InvalidStateError" });
  deliver({ type: "ack", seq: 1 }); bridge.restart(); assert.equal(sent.length, 2);
});

test("pause freezes edits but retains dirty state and accepts bounded conflict exports", () => {
  const { bridge, sent, deliver, advance } = fakeBridge();
  bridge.local.setItem("slot", "in flight"); advance(75);
  bridge.local.setItem("slot", "unsaved current"); bridge.session.setItem("history", "latest");
  deliver({ type: "pause" });
  assert.throws(() => bridge.local.setItem("slot", "lost"), { name: "InvalidStateError" });
  assert.throws(() => bridge.session.clear(), { name: "InvalidStateError" });
  deliver({ type: "ack", seq: 1 }); advance(1000); assert.equal(sent.length, 1);
  deliver({ type: "export", requestId });
  assert.deepEqual(sent[1], p.envelope(epoch, { type: "exported", requestId, snapshot: { local: [["slot", "unsaved current"]], session: [["history", "latest"]] } }));
  assert.deepEqual(p.parseFrameMessage(sent[1], epoch), sent[1]);
  deliver({ type: "resume" }); advance(0); assert.equal(sent[2].type, "delta");
});

test("paused restart hands parent a candidate for export without claiming an ACK", () => {
  const { bridge, sent, deliver } = fakeBridge();
  bridge.local.setItem("s", "first"); bridge.flush();
  bridge.local.setItem("s", "candidate"); deliver({ type: "pause" }); bridge.restart();
  assert.deepEqual(sent[1], p.envelope(epoch, { type: "restart", baseSeq: 1, delta: { local: { put: [["s", "candidate"]], remove: [] }, session: { put: [], remove: [] } } }));
  assert.equal(sent.some(m => m.type === "drained"), false);
});

test("parent controls are independently checked and stale epochs cannot pause or drain", () => {
  const { bridge, sent, receive, advance } = fakeBridge();
  for (const type of ["pause", "drain", "flush", "resume", "export"] as const) {
    receive({ v: 1, epoch, type, requestId });
    receive({ v: 2, epoch: "stale-epoch-0000000000001", type, requestId });
    receive({ v: 2, epoch, type, extra: {} });
  }
  let transferredClosed = false;
  receive(p.envelope(epoch, { type: "pause" }), [{ close() { transferredClosed = true; } } as MessagePort]);
  assert.equal(transferredClosed, true);
  bridge.local.setItem("valid", "still writable"); advance(75);
  assert.equal(sent.length, 1); assert.equal(sent[0].type, "delta");
});

test("Storage is synchronous, coerces Web IDL arguments, and named writes cannot bypass quota", () => {
  const { bridge } = fakeBridge(); const s = bridge.local;
  s.setItem("a", "1"); s["b"] = 2;
  assert.deepEqual(Object.keys(s), ["a", "b"]);
  assert.equal(s.length, 2); assert.equal(s.getItem("b"), "2");
  assert.equal("a" in s, true); assert.equal("absent" in s, false);
  assert.equal(s.key(1.9), "b"); assert.equal(s.key(2 ** 32), "a"); assert.equal(s.key(-1), null);
  assert.equal(s.key(undefined as unknown as number), "a");
  assert.throws(() => (s.key as () => string | null)(), TypeError);
  assert.throws(() => (s.getItem as () => string | null)(), TypeError);
  assert.throws(() => (s.setItem as (key: string) => void)("missing value"), TypeError);
  assert.throws(() => s.setItem(Symbol() as unknown as string, "v"), TypeError);
  assert.throws(() => s.key(1n as unknown as number), TypeError);
  Object.defineProperty(s, "defined", { value: "v" });
  assert.equal(s.getItem("defined"), "v");
  assert.throws(() => Object.defineProperty(s, "accessor", { get() { return "v"; } }), TypeError);
  assert.throws(() => Object.defineProperty(s, "too-large", { value: "x".repeat(p.LIMIT.area) }), { name: "QuotaExceededError" });
  assert.equal(s.getItem("too-large"), null);
  s.setItem("__proto__", "stored"); s.setItem("getItem", "stored method");
  assert.equal(s.getItem("__proto__"), "stored"); assert.equal(typeof s.getItem, "function");
  delete s["a"]; assert.equal(s.getItem("a"), null); assert.equal(Reflect.preventExtensions(s), false);
});

test("dispose clears scheduled sends and initial arrays cannot mutate the live baseline", () => {
  const initial: p.Snapshot = { local: [["a", "original"]], session: [] };
  const { bridge, sent, advance, pendingTimers, isClosed } = fakeBridge(initial);
  initial.local[0][1] = "external mutation"; assert.equal(bridge.local.getItem("a"), "original");
  bridge.local.setItem("b", "pending"); assert.equal(pendingTimers(), 1);
  bridge.dispose(); assert.equal(pendingTimers(), 0); assert.equal(isClosed(), true);
  advance(1000); assert.equal(sent.length, 0);
  assert.throws(() => bridge.local.setItem("a", "late"), { name: "InvalidStateError" });
});
