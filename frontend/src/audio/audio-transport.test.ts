import { test } from "node:test";
import assert from "node:assert/strict";
import { AudioTransport, type AudioSink, type AudioMeasurements } from "./audio-transport";
import type { SpeechProducer, PreparedSpeech } from "./kokoro-engine";
import type { AudioRevision } from "./protocol";
import { DEFAULT_AUDIO_SETTINGS } from "./settings";
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function harness() {
  const words = Array.from({ length: 4 }, (_, index) => ({ index, text: `word${index}.`, metadata: [] }));
  let complete = true, boundary = 4, enqueues = 0, playing = false;
  let cursor: (value: { sample: number; remaining: number; underrun: boolean }) => void = () => {};
  const ticks: number[] = [], requests: { start: number; resolve(value: PreparedSpeech): void }[] = [];
  const states: string[] = [];
  const measurements: AudioMeasurements[] = [];
  const sink: AudioSink = { sampleRate: 24000, async play() { playing = true; }, pause() { playing = false; },
    reset() { playing = false; }, enqueue() { enqueues++; }, async dispose() { playing = false; } };
  const engine: SpeechProducer = { provider: "fake", initializationMilliseconds: 0,
    prepare(source: readonly (typeof words)[number][], _settings: unknown, revision: AudioRevision) {
    return new Promise<PreparedSpeech>(resolve => requests.push({ start: source[0].index, resolve: result => resolve({ ...result,
      identity: { ...result.identity, ...revision } }) }));
  } };
  const transport = new AudioTransport({ words: () => words, complete: () => complete, settings: () => DEFAULT_AUDIO_SETTINGS,
    allowedEnd: () => boundary, engine: async () => engine, canStart: index => index !== boundary,
    canAdvance: (_from, to) => to !== boundary || boundary === words.length, onBlocked: () => states.push("blocked"),
    onTick: index => ticks.push(index), onEnd: () => states.push("end"), onStatus: state => states.push(state),
    onMeasurements: value => measurements.push(value),
    outputFactory: callback => { cursor = callback; return sink; } });
  const resolve = (index: number, start: number, end: number, silent = false) => requests[index].resolve({
    identity: { sessionId: "test", contentRevision: 0, synthesisRevision: 0, dspRevision: 0, requestId: String(index), chunkId: String(start),
      startWord: start, endWordExclusive: end, allowedEndWordExclusive: boundary },
    pcm: new Float32Array(silent ? 0 : (end - start) * 100), sampleRate: 24000, words: words.slice(start, end).map(word => ({
      wordIndex: word.index, startSample: silent ? 0 : (word.index - start) * 100, endSample: silent ? 0 : (word.index - start + 1) * 100 })),
    landmarks: [], alignment: "identity", endWordExclusive: end, synthesisMilliseconds: 1,
  });
  return { transport, requests, resolve, ticks, states, measurements, cursor: (sample: number, remaining: number) => cursor({ sample, remaining, underrun: remaining === 0 }),
    setBoundary: (value: number) => { boundary = value; }, setComplete: (value: boolean) => { complete = value; },
    get enqueues() { return enqueues; }, get playing() { return playing; } };
}
test("pause during inference never autoplays a completed result", async () => {
  const h = harness(); h.transport.resume(); await settle();
  assert.equal(h.requests.length, 1); h.transport.pause(); h.resolve(0, 0, 2); await settle();
  assert.equal(h.enqueues, 0); assert.equal(h.playing, false);
  h.transport.resume(); await settle(); assert.equal(h.enqueues, 1);
  h.transport.destroy();
});

test("reports chunk wait separately when synthesis finishes after playback drains", async () => {
  const h = harness(); h.transport.resume(); await settle();
  h.resolve(0, 0, 2); await settle(); h.cursor(200, 0);
  assert.equal(h.transport.snapshot.state, "buffering");
  h.resolve(1, 2, 4); await settle();
  assert.equal(h.transport.snapshot.state, "playing");
  const report = h.measurements[h.measurements.length - 1];
  assert.ok(report.lastChunkWaitMilliseconds! >= 0);
  assert.equal(h.measurements.length, 3); // two preparations and one handoff
  h.transport.destroy();
});
test("seek discards old inference and remains paused", async () => {
  const h = harness(); h.transport.resume(); await settle();
  h.transport.seek(2); h.resolve(0, 0, 2); await settle();
  assert.equal(h.enqueues, 0); assert.equal(h.transport.index, 2); assert.equal(h.transport.running, false);
  h.transport.resume(); await settle(); assert.equal(h.requests[1].start, 2);
  h.transport.destroy();
});
test("audio cursor delivers all skipped word boundaries, then stops at interaction", async () => {
  const h = harness(); h.setBoundary(3); h.transport.resume(); await settle();
  h.resolve(0, 0, 3); await settle(); h.cursor(299, 1);
  assert.deepEqual(h.ticks, [1, 2]); h.cursor(300, 0);
  assert.equal(h.transport.running, false); assert.ok(h.states.includes("blocked"));
  assert.equal(h.requests.length, 1); h.transport.destroy();
});
test("pause during live-tail buffering survives later append notification", async () => {
  const h = harness(); h.setComplete(false); h.transport.resume(); await settle();
  h.resolve(0, 0, 4); await settle(); h.cursor(400, 0);
  assert.equal(h.transport.running, true); h.transport.pause(); h.transport.appended(); await settle();
  assert.equal(h.transport.running, false); assert.equal(h.enqueues, 1); h.transport.destroy();
});
test("pause inside a chunk before a future interaction can resume unfinished speech", async () => {
  const h = harness(); h.setBoundary(3); h.transport.resume(); await settle();
  h.resolve(0, 0, 3); await settle(); h.cursor(100, 200);
  h.transport.pause(); h.transport.resume(); await settle();
  assert.equal(h.transport.running, true); assert.equal(h.enqueues, 1);
  h.transport.destroy();
});
test("settings invalidate prepared work without interrupting the current chunk", async () => {
  const h = harness(); h.transport.resume(); await settle(); h.resolve(0, 0, 2); await settle();
  assert.equal(h.requests.length, 2);
  h.transport.settingsChanged(); h.resolve(1, 2, 4); await settle();
  assert.equal(h.enqueues, 1); assert.equal(h.requests[2].start, 2);
  h.resolve(2, 2, 4); await settle(); h.cursor(200, 0); await settle();
  assert.equal(h.enqueues, 2); h.transport.destroy();
});
test("an empty cursor message before PCM arrives never skips a chunk", async () => {
  const h = harness(); h.transport.resume(); await settle();
  h.resolve(0, 0, 2); await settle();
  h.cursor(0, 0); // reset acknowledged before transferred PCM reaches the worklet
  assert.equal(h.transport.index, 0);
  h.cursor(100, 100); assert.equal(h.transport.index, 1);
  h.transport.destroy();
});

test("subscribers see the consumed word and disposal releases buffered state", async () => {
  const h = harness();
  let snapshot = h.transport.snapshot;
  h.transport.subscribe(value => { snapshot = value; });
  h.transport.resume(); await settle(); h.resolve(0, 0, 2); await settle();
  h.cursor(100, 100);
  assert.equal(snapshot.index, 1);
  assert.equal(snapshot.consumedSamples, 100);
  assert.equal(snapshot.playIntent, true);
  h.transport.destroy();
  assert.equal(snapshot.disposed, true);
  assert.equal(snapshot.playIntent, false);
  assert.equal(snapshot.bufferedSeconds, 0);
  assert.equal(snapshot.state, "paused");
});

test("unspoken chunks advance through boundaries without enqueuing audio", async () => {
  const h = harness(); h.transport.resume(); await settle();
  h.resolve(0, 0, 2, true); await settle();
  assert.equal(h.enqueues, 0);
  assert.deepEqual(h.ticks, [1, 2]);
  assert.equal(h.requests[1].start, 2);
  h.resolve(1, 2, 4, true); await settle();
  assert.equal(h.transport.snapshot.state, "ended");
  assert.equal(h.transport.index, 4);
  assert.equal(h.measurements.length, 0);
  h.transport.destroy();
});
test("unspoken chunks stop at interactions and do not autoplay after pause", async () => {
  const h = harness(); h.setBoundary(2); h.transport.resume(); await settle();
  h.transport.pause(); h.resolve(0, 0, 2, true); await settle();
  assert.deepEqual(h.ticks, []);
  h.transport.resume(); await settle();
  assert.ok(h.states.includes("blocked"));
  assert.equal(h.enqueues, 0); assert.equal(h.requests.length, 1);
  h.transport.destroy();
});
