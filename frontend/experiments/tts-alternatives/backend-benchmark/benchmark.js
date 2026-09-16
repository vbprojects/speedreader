import { OnnxClient } from '/src/audio/onnx-client.ts';
import { packForVoice, downloadPackAsset } from '/src/audio/voice-pack.ts';
import { exposePiperDurations } from '/src/audio/duration-export.ts';
import { EnglishPhonemizer, phonemizeChunk } from '/src/audio/phonemizer.ts';
import { piperInput } from '/src/audio/piper-input.ts';
import vocabulary from '/src/audio/vendor/kokoro-vocabulary.json';
import { assetDigest } from '/src/audio/pack-store.ts';

export async function benchmark(report = () => {}, repeats = 3, options = {}) {
  const adapter = await navigator.gpu?.requestAdapter();
  const info = adapter?.info;
  const gpu = info ? Object.fromEntries(['vendor', 'architecture', 'device', 'description', 'isFallbackAdapter'].map(k => [k, info[k]])) : null;
  const software = gpu && /swiftshader|llvmpipe|software/i.test(JSON.stringify(gpu));
  const result = { startedAt: new Date().toISOString(), userAgent: navigator.userAgent, gpu, softwareGpu: Boolean(software), repeats,
    text: 'This is a short sentence. Read along with Piper.', pacing: 1, compression: 1,
    method: 'Single inference worker, WASM one thread; first inference excluded from warm median; no synthesis cache or DSP; same source text; model-default noise.', rows: [] };
  report(result);
  const assets = new Map();
  async function resolve(asset) {
    if (!assets.has(asset.sha256)) {
      const bytes = await downloadPackAsset(asset);
      if (bytes.byteLength !== asset.bytes || await assetDigest(bytes) !== asset.sha256) throw Error('Asset integrity failure');
      assets.set(asset.sha256, bytes);
    }
    return assets.get(asset.sha256).slice(0);
  }
  const words = result.text.split(' ').map((text, index) => ({text, index, metadata: []}));
  for (const provider of (options.providers ?? ['wasm', 'webgpu'])) {
    for (const [quality, voice] of [['low','piper_lessac'],['medium','piper_en_US-lessac-medium'],['high','piper_en_US-lessac-high']]) {
      if (options.qualities && !options.qualities.includes(quality)) continue;
      const row = {provider, quality, voice, runs: []};
      result.rows.push(row); report(result);
      if (provider === 'webgpu' && !adapter) {row.error='No WebGPU adapter'; report(result); continue;}
      const pack = packForVoice(voice);
      row.runtimeRevision = pack.runtimeRevision;
      row.modelSha256 = pack.assets[0].sha256;
      let client, wasmUrl;
      try {
        const dictionary = await resolve(pack.assets[2]);
        const english = phonemizeChunk(new EnglishPhonemizer(new TextDecoder().decode(dictionary), vocabulary), words);
        const configBytes = await resolve(pack.assets[1]);
        const config = JSON.parse(new TextDecoder().decode(configBytes));
        const phrase = piperInput(english, config);
        let model = await resolve(pack.assets[0]);
        if (voice !== 'piper_lessac') model = exposePiperDurations(model);
        wasmUrl = URL.createObjectURL(new Blob([await resolve(pack.assets[3])], {type:'application/wasm'}));
        client = new OnnxClient();
        const init = await client.initialize(model, configBytes, wasmUrl, provider, 'piper');
        row.initializationMs = init.milliseconds;
        for (let i=0; i<=repeats; i++) {
          const start = performance.now();
          const response = await client.synthesize({voice, pacing:1, phonemeIds:phrase.ids, wordTokens:phrase.words,
            identity:{sessionId:'benchmark', contentRevision:0, synthesisRevision:0, dspRevision:0, requestId:String(i), chunkId:'0', startWord:0,endWordExclusive:words.length,allowedEndWordExclusive:words.length}});
          const seconds = response.pcm.length/config.audio.sample_rate;
          const timing = {inferenceMs:response.milliseconds, roundTripMs:performance.now()-start, audioSeconds:seconds,
            realTimeFactor:response.milliseconds/1000/seconds, tokens:phrase.ids.length};
          if (i===0) row.firstRun=timing; else row.runs.push(timing);
          report(result);
        }
      } catch(error) {row.error=String(error);}
      finally {client?.dispose(); if(wasmUrl) URL.revokeObjectURL(wasmUrl);}
      if (row.runs.length) {
        const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
        row.medianInferenceMs = median(row.runs.map(r=>r.inferenceMs));
        row.medianRealTimeFactor = median(row.runs.map(r=>r.realTimeFactor));
        const low = result.rows.find(r=>r.provider===provider && r.quality==='low');
        if (low?.medianInferenceMs) row.relativeToLow = row.medianInferenceMs / low.medianInferenceMs;
      }
      report(result);
    }
  }
  adapter?.destroy?.();
  return result;
}
