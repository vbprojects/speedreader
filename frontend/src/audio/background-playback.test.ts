import { test } from "node:test";
import assert from "node:assert/strict";
import { bindBackgroundPlayback, bindSpeechMediaSession } from "./background-playback";
import { audioSettingsPatch, DEFAULT_AUDIO_SETTINGS } from "./settings";
import { mergeSettings, DEFAULT_GLOBAL_SETTINGS } from "../settings/types";

test("background preference defaults on and respects persisted per-title overrides", () => {
  assert.equal(DEFAULT_AUDIO_SETTINGS.readAloudInBackground, true);
  assert.deepEqual(audioSettingsPatch({ readAloudInBackground: "true" }), {});
  const saved = JSON.parse(JSON.stringify({ readAloudInBackground: false }));
  assert.equal(mergeSettings(DEFAULT_GLOBAL_SETTINGS, saved).readAloudInBackground, false);
});
test("active opted-in audio survives hiding; returning does not issue Play; navigation still releases", () => {
  const page = new EventTarget(), windowTarget = new EventTarget();
  let hidden = false, pauses = 0, returned = 0;
  const cleanup = bindBackgroundPlayback(page, windowTarget, {
    hidden: () => hidden, shouldContinue: () => true,
    pauseAndRelease: () => { pauses++; }, returned: () => { returned++; },
  });
  hidden = true; page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(pauses, 0);
  hidden = false; page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(returned, 1);
  windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(pauses, 1);
  cleanup(); windowTarget.dispatchEvent(new Event("pagehide"));
  assert.equal(pauses, 1);
});
test("visual reading, paused audio and opted-out audio release while hidden", () => {
  for (const initiallyHidden of [false, true]) {
    const page = new EventTarget(), windowTarget = new EventTarget();
    let hidden = initiallyHidden, pauses = 0;
    const cleanup = bindBackgroundPlayback(page, windowTarget, {
      hidden: () => hidden, shouldContinue: () => false,
      pauseAndRelease: () => { pauses++; }, returned() {},
    });
    if (!initiallyHidden) { hidden = true; page.dispatchEvent(new Event("visibilitychange")); }
    assert.equal(pauses, 1);
    cleanup();
  }
});
test("media controls route playback and detach on reader exit, tolerating unsupported actions", () => {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
  let plays = 0, pauses = 0;
  const session = { playbackState: "playing", metadata: {},
    setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
      if (action === "stop") throw Error("unsupported");
      handlers.set(action, handler);
    } } as MediaSession;
  const cleanup = bindSpeechMediaSession(session, { play: () => { plays++; }, pause: () => { pauses++; } });
  handlers.get("play")!({ action: "play" }); handlers.get("pause")!({ action: "pause" });
  assert.equal(plays, 1); assert.equal(pauses, 1);
  cleanup();
  assert.equal(handlers.get("play"), null); assert.equal(handlers.get("pause"), null);
  assert.equal(session.playbackState, "none"); assert.equal(session.metadata, null);
});
