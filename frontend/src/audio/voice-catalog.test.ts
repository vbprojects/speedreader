import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_VOICE, PIPER_VOICES, piperVoice } from "./voice-catalog";
import { audioSettingsPatch, DEFAULT_AUDIO_SETTINGS } from "./settings";

test("Piper defaults and catalog variants survive preference validation", () => {
  assert.equal(DEFAULT_AUDIO_SETTINGS.readAloudVoice, DEFAULT_VOICE);
  assert.equal(piperVoice(DEFAULT_VOICE)?.quality, "low");
  for (const voice of PIPER_VOICES) {
    assert.deepEqual(audioSettingsPatch({ readAloudVoice: voice.id }), { readAloudVoice: voice.id });
  }
  assert.deepEqual(audioSettingsPatch({ readAloudVoice: "piper_en_US-lessac-x_low" }), {});
  assert.deepEqual(audioSettingsPatch({ readAloudVoice: "af_heart" }), { readAloudVoice: "af_heart" });
});

test("catalog pins distinct real voice variants and integrity metadata", () => {
  assert.equal(new Set(PIPER_VOICES.map(v => v.id)).size, PIPER_VOICES.length);
  assert.deepEqual(PIPER_VOICES.filter(v => v.name === "lessac").map(v => v.quality).sort(), ["high", "low", "medium"]);
  for (const voice of PIPER_VOICES) {
    assert.match(voice.modelSha256, /^[a-f0-9]{64}$/);
    assert.match(voice.configSha256, /^[a-f0-9]{64}$/);
    assert.ok(voice.modelBytes > 0 && voice.configBytes > 0);
    assert.ok(voice.path.endsWith(`${voice.language}-${voice.name}-${voice.quality}.onnx`));
    assert.equal(voice.sampleRate, voice.quality === "low" ? 16000 : 22050);
  }
});

test("Kitten voices and precisions are explicitly allowed and use pinned assets", async () => {
  const { KITTEN_VOICES, kittenVoice, voiceLabel } = await import("./voice-catalog");
  assert.equal(KITTEN_VOICES.length, 16);
  assert.equal(new Set(KITTEN_VOICES.map(voice => voice.id)).size, 16);
  for (const voice of KITTEN_VOICES) {
    assert.deepEqual(audioSettingsPatch({ readAloudVoice: voice.id }), { readAloudVoice: voice.id });
    assert.match(voiceLabel(voice.id), new RegExp(`KittenTTS.*${voice.name}.*${voice.variant.label}`));
    for (const asset of [voice.variant.model, voice.variant.voice]) {
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.match(asset.url, /\/resolve\/[a-f0-9]{40}\//);
      assert.ok(asset.bytes > 0);
    }
  }
  assert.equal(kittenVoice("kitten_nano_int8_hugo")?.speedPrior, .9);
  assert.deepEqual(audioSettingsPatch({ readAloudVoice: "kitten_nano_int8_unknown" }), {});
  assert.deepEqual(audioSettingsPatch({ readAloudVoice: "kitten_nano_unknown_bella" }), {});
});
