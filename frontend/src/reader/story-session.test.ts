import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireStoryAdvisory, type StoryAdvisoryEnvironment, type StoryAdvisoryStatus } from "./story-session";

const last = <T>(items: T[]): T => items[items.length - 1]!;

function fakeOrigin() {
  let time = 0, nextTimer = 0;
  const timers = new Map<number, { callback: () => void; at: number; every?: number }>();
  const channels = new Map<string, Set<FakeChannel>>();
  const locks = new Set<string>();
  const pending: (() => void)[] = [];
  const sent: unknown[] = [];
  class FakeChannel {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    constructor(readonly name: string) {
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name)!.add(this);
    }
    postMessage(data: unknown) {
      sent.push(data);
      for (const other of channels.get(this.name) ?? []) if (other !== this) {
        pending.push(() => other.onmessage?.(new MessageEvent("message", { data: structuredClone(data) })));
      }
    }
    close() { channels.get(this.name)?.delete(this); }
  }
  const flush = () => { while (pending.length) pending.shift()!(); };
  const environment = (id: string, useLocks = false, useBroadcast = true): StoryAdvisoryEnvironment => ({
    id: () => id, now: () => time,
    setInterval(callback, ms) { const n = ++nextTimer; timers.set(n, { callback, at: time + ms, every: ms }); return n; },
    clearInterval(handle) { timers.delete(handle as number); },
    setTimeout(callback, ms) { const n = ++nextTimer; timers.set(n, { callback, at: time + ms }); return n; },
    clearTimeout(handle) { timers.delete(handle as number); },
    channel: useBroadcast ? name => new FakeChannel(name) : undefined,
    requestLock: useLocks ? async (name, callback) => {
      if (locks.has(name)) return callback(false);
      locks.add(name);
      try { await callback(true); } finally { locks.delete(name); }
    } : undefined,
  });
  return {
    environment, flush, sent, locks, timers,
    channels: () => [...channels.values()].reduce((n, set) => n + set.size, 0),
    advance(ms: number) {
      time += ms;
      for (const [n, timer] of [...timers]) if (timer.at <= time) {
        if (timer.every) timer.at = time + timer.every; else timers.delete(n);
        timer.callback();
      }
      flush();
    },
    inject(book: string, data: unknown) {
      for (const channel of channels.get(`speedreader:published:${book}`) ?? []) channel.onmessage?.(new MessageEvent("message", { data }));
    },
  };
}

test("Web Locks advisory is held until cleanup; another session is blocked without stealing", async () => {
  const origin = fakeOrigin(), states: StoryAdvisoryStatus[] = [];
  const first = acquireStoryAdvisory("story", status => states.push(status), origin.environment("first", true));
  assert.equal(await first.ready, "held");
  const second = acquireStoryAdvisory("story", status => states.push(status), origin.environment("second", true));
  assert.equal(await second.ready, "occupied");
  assert.equal(origin.locks.size, 1);
  first.stop(); await Promise.resolve(); await Promise.resolve();
  assert.equal(origin.locks.size, 0);
  const reopened = acquireStoryAdvisory("story", status => states.push(status), origin.environment("reopened", true));
  assert.equal(await reopened.ready, "held");
  assert.ok(states.every(status => status.mechanism === "web-locks"));
  second.stop(); reopened.stop(); await Promise.resolve();
  assert.equal(origin.timers.size, 0); assert.equal(origin.channels(), 0);
});

test("fallback detects simultaneous sessions and releases hints on close without claiming exclusivity", async () => {
  const origin = fakeOrigin(), firstStates: StoryAdvisoryStatus[] = [], secondStates: StoryAdvisoryStatus[] = [];
  const first = acquireStoryAdvisory("story", status => firstStates.push(status), origin.environment("first"));
  const second = acquireStoryAdvisory("story", status => secondStates.push(status), origin.environment("second"));
  origin.flush(); origin.advance(200);
  assert.equal(await first.ready, "occupied"); assert.equal(await second.ready, "occupied");
  assert.equal(last(firstStates).otherSessions, 1);
  second.stop(); origin.flush();
  assert.equal(last(firstStates).state, "unknown");
  assert.ok([...firstStates, ...secondStates].every(status => status.state !== "held"));
  first.stop(); assert.equal(origin.channels(), 0); assert.equal(origin.timers.size, 0);
});

test("heartbeat expiry handles a vanished session and a returning suspended session", async () => {
  const origin = fakeOrigin(), states: StoryAdvisoryStatus[] = [];
  const handle = acquireStoryAdvisory("story", status => states.push(status), origin.environment("local"));
  const presence = { protocol: "speedreader-session", version: 1, type: "presence", id: "other" };
  origin.inject("story", presence); origin.advance(200);
  assert.equal(await handle.ready, "occupied");
  origin.advance(21000);
  assert.equal(last(states).state, "unknown");
  origin.inject("story", presence);
  assert.equal(last(states).state, "occupied");
  handle.stop();
});

test("advisory messages validate identity and type and bound the peer set", async () => {
  const origin = fakeOrigin(), states: StoryAdvisoryStatus[] = [];
  const handle = acquireStoryAdvisory("story", status => states.push(status), origin.environment("local"));
  const valid = { protocol: "speedreader-session", version: 1, type: "presence", id: "other" };
  for (const message of [null, [], {}, { ...valid, version: 2 }, { ...valid, id: "" }, { ...valid, id: "x".repeat(129) }, { ...valid, id: "local" }, { ...valid, type: "save" }]) origin.inject("story", message);
  assert.equal(last(states).otherSessions, 0);
  for (let i = 0; i < 100; i++) origin.inject("story", { ...valid, id: String(i) });
  assert.equal(last(states).otherSessions, 32);
  origin.advance(200); assert.equal(await handle.ready, "occupied");
  assert.ok(origin.sent.every(value => {
    const keys = Object.keys(value as object).sort();
    return keys.join() === "id,protocol,type,version";
  }));
  handle.stop();
});

test("different stories use separate advisory namespaces", async () => {
  const origin = fakeOrigin();
  const a = acquireStoryAdvisory("one", () => {}, origin.environment("a", true));
  const b = acquireStoryAdvisory("two", () => {}, origin.environment("b", true));
  assert.equal(await a.ready, "held"); assert.equal(await b.ready, "held");
  a.stop(); b.stop();
});

test("missing or denied APIs yield unknown rather than a false lock", async () => {
  const origin = fakeOrigin(), states: StoryAdvisoryStatus[] = [];
  const unavailable = acquireStoryAdvisory("story", state => states.push(state), origin.environment("a", false, false));
  assert.equal(await unavailable.ready, "unknown");
  assert.equal(last(states).mechanism, "unavailable"); unavailable.stop();
  const denied = acquireStoryAdvisory("story", state => states.push(state), { ...origin.environment("b"), requestLock: async () => { throw new Error("denied"); } });
  await Promise.resolve(); origin.advance(200);
  assert.equal(await denied.ready, "unknown"); assert.equal(last(states).mechanism, "broadcast"); denied.stop();
});

test("stopping before a delayed lock grant releases it and suppresses late status updates", async () => {
  const origin = fakeOrigin(), states: StoryAdvisoryStatus[] = [];
  let callback: ((available: boolean) => Promise<void>) | undefined;
  const handle = acquireStoryAdvisory("story", status => states.push(status), {
    ...origin.environment("local", false, false),
    requestLock: (_name, acquire) => { callback = acquire; return Promise.resolve(); },
  });
  handle.stop(); handle.stop();
  assert.equal(await handle.ready, "unknown");
  await callback!(true);
  assert.deepEqual(states, []);
});

test("a stopped fallback clears its handshake and bounds local identifiers", async () => {
  const origin = fakeOrigin();
  const handle = acquireStoryAdvisory("story", () => {}, origin.environment("local"));
  handle.stop(); assert.equal(await handle.ready, "unknown");
  assert.equal(origin.timers.size, 0);
  assert.throws(() => acquireStoryAdvisory("x".repeat(257), () => {}, origin.environment("local")), /story identity/);
  assert.throws(() => acquireStoryAdvisory("story", () => {}, origin.environment("x".repeat(129))), /session identity/);
});
