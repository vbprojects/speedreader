import { test } from "node:test";
import assert from "node:assert/strict";
import { PreparationSession, type Prepared } from "./preparation-session";
import type { AudioRevision } from "./protocol";

const revision: AudioRevision = { sessionId: "book-a", contentRevision: 0, synthesisRevision: 0, dspRevision: 0 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("Pause during preparation cannot be overridden by completion; gates are rechecked", async () => {
  const session = new PreparationSession<string>(revision);
  const producer = deferred<Prepared<string>>();
  session.play();
  const pending = session.prepare(() => producer.promise);
  session.pause();
  producer.resolve({ revision, value: "pcm" });
  await pending;
  assert.equal(session.snapshot.hasReady, true);
  assert.equal(session.takeReady(() => true), null);
  session.play();
  assert.equal(session.takeReady(() => false), null);
  assert.equal(session.takeReady(() => true)?.value, "pcm");
  assert.equal(session.takeReady(() => true), null);
});

test("uncancellable stale results are discarded for every revision and same-position seeks", async () => {
  for (const next of [revision, { ...revision, sessionId: "book-b" },
    { ...revision, contentRevision: 1 }, { ...revision, synthesisRevision: 1 }, { ...revision, dspRevision: 1 }]) {
    const session = new PreparationSession<string>(revision);
    const producer = deferred<Prepared<string>>();
    let signal!: AbortSignal;
    session.play();
    const pending = session.prepare((_, s) => { signal = s; return producer.promise; });
    session.invalidate(next);
    assert.equal(signal.aborted, true);
    await assert.rejects(session.prepare(() => producer.promise), /still running/);
    producer.resolve({ revision, value: "stale" });
    await pending;
    assert.equal(session.snapshot.hasReady, false);
    assert.equal(session.snapshot.playIntent, false);
    await session.prepare(async r => ({ revision: r, value: "fresh" }));
    session.play();
    assert.equal(session.takeReady(() => true)?.value, "fresh");
  }
});

test("producer errors and mismatched identity never schedule audio; disposal is final", async () => {
  const session = new PreparationSession<string>(revision);
  await session.prepare(async () => { throw new Error("failed"); });
  assert.ok(session.snapshot.error instanceof Error);
  await session.prepare(async () => ({ revision: { ...revision, sessionId: "wrong" }, value: "bad" }));
  assert.equal(session.snapshot.hasReady, false);
  session.dispose();
  session.play();
  assert.equal(session.snapshot.playIntent, false);
  await assert.rejects(session.prepare(async r => ({ revision: r, value: "bad" })), /disposed/);
});
