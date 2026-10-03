// Run against Vite with staged, hash-verified experiment assets. Requires Playwright.
// NODE_PATH can point to an external Playwright install; no app dependency is added.
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url = "http://localhost:5250", executablePath] = process.argv.slice(2);
const root = fileURLToPath(new URL("./assets/", import.meta.url));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", error => console.error("PAGE ERROR", error.message));
  await page.route("https://**/*", async route => {
    const name = new URL(route.request().url()).pathname.split("/").pop();
    if (["kitten_tts_nano_v0_8.onnx", "voices.npz", "en-us.txt"].includes(name)) {
      await route.fulfill({ body: await readFile(root + (route.request().url().includes("7a1db645") ? "kitten-fp32/" : "kitten-int8/") + name), contentType: "application/octet-stream" });
    } else await route.continue();
  });
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { KokoroEngine } = await import("/src/audio/kokoro-engine.ts");
    const { packForVoice, downloadPackAsset } = await import("/src/audio/voice-pack.ts");
    const { PackStore, CachedAssets } = await import("/src/audio/pack-store.ts");
    const { IndexedPackMetadata } = await import("/src/audio/pack-metadata.ts");
    const { DEFAULT_AUDIO_SETTINGS } = await import("/src/audio/settings.ts");
    const metadata = new IndexedPackMetadata();
    const store = new PackStore(new CachedAssets(), metadata, downloadPackAsset);
    const voice = "kitten_nano_int8_bella", pack = packForVoice(voice);
    const revision = { sessionId: "kitten-smoke", contentRevision: 0, synthesisRevision: 0, dspRevision: 0 };
    const settings = { ...DEFAULT_AUDIO_SETTINGS, readAloudVoice: voice };
    const source = text => text.split(" ").map((text, index) => ({ text, index, metadata: [] }));
    await store.install(pack, async resolve => {
      const engine = new KokoroEngine(voice);
      try { await engine.initialize(resolve, "wasm"); await engine.prepare(source("Ready."), settings, revision, 1); }
      finally { engine.dispose(); }
    });
    const rows = [];
    const engine = new KokoroEngine(voice);
    try {
      await engine.initialize(asset => store.resolve(asset), "wasm");
      for (const [pacing, compression] of [[1, 1], [1, 2], [2, 1]]) {
        const words = source("Hello world. Read along with the kitten voice.");
        const result = await engine.prepare(words, { ...settings, kokoroPacing: pacing, speechCompression: compression }, revision, words.length);
        if (!result.pcm.length || result.pcm.some(sample => !Number.isFinite(sample)) || result.words.length !== words.length ||
            result.words.some(word => word.startSample < 0 || word.endSample > result.pcm.length)) throw Error("Invalid Kitten PCM or word geometry");
        rows.push({ provider: engine.provider, pacing, compression, samples: result.pcm.length,
          sampleRate: result.sampleRate, words: result.words.length, nativeCacheHit: result.nativeCacheHit,
          inferenceMilliseconds: result.synthesisMilliseconds });
      }
      const words = source("One two three four five.");
      const gated = await engine.prepare(words, settings, revision, 2);
      if (gated.endWordExclusive !== 2 || gated.words.length !== 2) throw Error("Crossed interaction boundary");
      const blank = await engine.prepare(source("😀 你好"), settings, revision, 2);
      if (blank.pcm.length || blank.words.some(word => word.startSample !== word.endSample)) throw Error("Blank speech inferred audio");
      // Every chunk must account for complete source words after IPA/token expansion.
      const long = source("antidisestablishmentarianism ".repeat(24).trim());
      let cursor = 0;
      while (cursor < long.length) {
        const chunk = await engine.prepare(long.slice(cursor), settings, revision, long.length);
        if (chunk.identity.startWord !== cursor || chunk.endWordExclusive <= cursor) throw Error("Lost chunk ownership");
        cursor = chunk.endWordExclusive;
      }
      const aborted = new AbortController(); aborted.abort();
      try { await engine.prepare(words, settings, revision, words.length, aborted.signal); throw Error("Abort ignored"); }
      catch (error) { if (error.name !== "AbortError") throw error; }
    } finally { engine.dispose(); }
    const gpu = new KokoroEngine(voice);
    try { await gpu.initialize(asset => store.resolve(asset), "webgpu"); throw Error("INT8 accepted WebGPU"); }
    catch (error) { if (!error.message.includes("requires CPU")) throw error; }
    finally { gpu.dispose(); }
    // Model/NPZ ownership is shared between speakers. Removing one retains the other.
    const jasper = packForVoice("kitten_nano_int8_jasper");
    await store.install(jasper, async resolve => {
      const engine = new KokoroEngine("kitten_nano_int8_jasper");
      try {
        await engine.initialize(resolve, "wasm");
        await engine.prepare(source("Ready."), { ...settings, readAloudVoice: "kitten_nano_int8_jasper" }, revision, 1);
      } finally { engine.dispose(); }
    });
    await store.remove(jasper.id);
    await store.verify(pack);
    const fp32Voice = "kitten_nano_fp32_bella", fp32 = packForVoice(fp32Voice);
    await store.install(fp32, async resolve => {
      const engine = new KokoroEngine(fp32Voice);
      try {
        await engine.initialize(resolve, "wasm");
        const words = source("Read along with Kitten.");
        const result = await engine.prepare(words, { ...settings, readAloudVoice: fp32Voice }, revision, words.length);
        if (!result.pcm.length || result.words.length !== words.length) throw Error("Invalid FP32 synthesis");
        rows.push({ provider: engine.provider, precision: "fp32", pacing: 1, compression: 1,
          samples: result.pcm.length, sampleRate: result.sampleRate, words: result.words.length,
          inferenceMilliseconds: result.synthesisMilliseconds });
      } finally { engine.dispose(); }
    });
    await store.remove(fp32.id);
    await store.verify(pack);
    return rows;
  });
  assert.equal(result[1].nativeCacheHit, true);
  assert.ok(result[1].samples < result[0].samples);
  assert.ok(result[2].samples < result[0].samples);
  console.log(JSON.stringify({ rows: result }, null, 2));
  await page.getByRole("button", { name: "Read a sample", exact: true }).click();
  await page.getByRole("button", { name: "Start reading", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Speech model", { exact: true }).selectOption("kitten");
  await page.getByRole("button", { name: "Repair voice", exact: true }).waitFor();
  await page.getByLabel("KittenTTS voice", { exact: true }).selectOption("Jasper");
  await page.getByRole("button", { name: "Install voice", exact: true }).waitFor();
  await page.getByLabel("KittenTTS quality", { exact: true }).selectOption("fp32");
  await page.getByLabel("KittenTTS quality", { exact: true }).selectOption("int8");
  await page.getByLabel("KittenTTS voice", { exact: true }).selectOption("Bella");
  await page.getByRole("button", { name: "Repair voice", exact: true }).waitFor();
  await page.getByRole("button", { name: "Repair voice", exact: true }).click();
  await page.getByText("English voice is installed for offline use.", { exact: true }).waitFor({ timeout: 120_000 });
  assert.equal(await page.getByRole("checkbox", { name: "Enable read aloud", exact: true }).isEnabled(), true);
  await page.getByLabel("Speech model", { exact: true }).selectOption("piper");
  await page.getByLabel("Speech model", { exact: true }).selectOption("kitten");
  await page.getByRole("button", { name: "Repair voice", exact: true }).waitFor();
  // A production preview can load all app/worker files from the PWA cache while offline.
  // Vite needs its uncached development modules; block only external dependencies here.
  await page.route("https://**/*", route => route.abort());
  await page.getByRole("button", { name: "Preview voice", exact: true }).click();
  await page.getByText("Playing voice preview.", { exact: true }).waitFor({ timeout: 120_000 });
  console.log("PASS: real INT8/FP32 synthesis, pacing/compression, word bounds, interaction gates, cancellation, shared packs, settings and local preview");
} finally { await browser.close(); }
