import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitAudioStartup, requestPlaybackSession } from "./audio-startup";

test("requests media playback and tolerates missing or rejecting session APIs", () => {
  const target = { audioSession: { type: "auto" } };
  requestPlaybackSession(target);
  assert.equal(target.audioSession.type, "playback");
  assert.doesNotThrow(() => requestPlaybackSession({}));
  assert.doesNotThrow(() => requestPlaybackSession({ get audioSession(): never { throw Error("unsupported"); } }));
});
test("audio startup resolves normally and preserves errors", async () => {
  await awaitAudioStartup(Promise.resolve(), () => "running", 20);
  await assert.rejects(awaitAudioStartup(Promise.reject(Error("denied")), () => "suspended", 20), /denied/);
});
test("stalled resume reports device state instead of waiting forever", async () => {
  await assert.rejects(awaitAudioStartup(new Promise(() => {}), () => "interrupted", 5), /timed out \(interrupted\)/);
});
