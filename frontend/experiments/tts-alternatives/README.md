# Small TTS alternatives: Kitten Nano and Piper

Isolated feasibility experiment for the offline read-along PWA. It does not change
production voices, settings, or the Kokoro implementation. No speech recognition
or retranscription is used.

## Run

From the repository root, using Python 3.12:

```bash
python3 -m venv /tmp/speedreader-tts-alternatives
/tmp/speedreader-tts-alternatives/bin/pip install -r frontend/experiments/tts-alternatives/requirements.txt
/tmp/speedreader-tts-alternatives/bin/python frontend/experiments/tts-alternatives/experiment.py
/tmp/speedreader-tts-alternatives/bin/python frontend/experiments/tts-alternatives/audit_alignment.py
/tmp/speedreader-tts-alternatives/bin/python -m unittest discover -s frontend/experiments/tts-alternatives -p 'test_*.py'
```

Downloads are pinned to Hugging Face commits; `assets-manifest.json` records and
checks file SHA-256 digests. Models and generated audio stay in ignored `assets/`
and `output/` directories. The runner also fetches a pinned Kitten source file,
loading only its vocabulary/tokenization definitions, avoiding the full Python
package's torch/spacy dependencies. Source identity is recorded in results.

Open the listening page while Vite is running:

**http://localhost:5250/experiments/tts-alternatives/output/index.html**

Alternatively, run `python3 -m http.server 5252 --directory
frontend/experiments/tts-alternatives/output` and open http://localhost:5252.
Serve over HTTP so the annotation viewer can fetch JSON. Native clips show word
highlights and hover timestamps. Compressed clips deliberately do not show guessed
word highlights. Audio quality and alignment onset accuracy need listening review.

Defaults: same 23-word passage, two CPU threads, pacing 1×/2×, compression 1×/2×,
one first call plus three timed repeats at each pacing. Synthesis is reused for
compression comparisons. `output/results.csv`, `results.json`, individual WAVs,
and annotation JSON are generated. A small checked-in `baseline.json` records the
completed run without committing audio. Each pacing result is checkpointed in
results.json, but rerunning executes the requested cases again (no resume mode).

Example custom short passage:

```bash
/tmp/speedreader-tts-alternatives/bin/python frontend/experiments/tts-alternatives/experiment.py \
  --models kitten-fp32 piper --text-file /tmp/passage.txt \
  --pacing 1 1.5 2 --compression 1 2 --threads 2 --repeats 3
```

Inputs are limited to 1,000 characters. Text normalization is intentionally not
added: unsupported symbols fail visibly, and uncertain original-word ownership
is reported as unavailable. This is not a full-book chunker.

## What works

| Engine | Native pacing | Native timing | Experimental source-word mapping |
|---|---|---|---|
| Kitten Nano FP32 / INT8 | `speed = pacing × voice speed prior` (Bella prior 0.8) | Export already has `duration`; each frame is 600 samples at 24 kHz | Phonemize the phrase, verify each whitespace group against that source word, ignoring only stress-marker differences; map exact tokenizer offsets |
| Piper Lessac Low | `length_scale = configured length_scale / pacing` | Official patch exposes `Ceil` duration tensor; 256 samples/frame at 16 kHz for this voice | Same conservative ownership check, then map phonemes and their inserted padding IDs |

Both assert the sum of native token sample counts equals the full waveform sample
count on every inference. This verifies sample geometry, **not** precise audible
word onsets. The hop sizes are specific to these pinned exports, not universal.

`alignment-audit.json` records extra normalization/context cases. Numbers,
contractions, and context-dependent pronunciation can fail ownership verification;
we return phoneme timing without inventing original-word timestamps. A production
adapter would need a normalization-aware provenance path. Kitten's basic tokenizer
also rejects an unsupported hyphen in one audit case rather than silently dropping
it as upstream's permissive cleaner would.

Kitten's upstream wrapper removes the last 5,000 samples. We retain the full raw
waveform so duration geometry remains inspectable and no endings are silently
cut. This can affect perceived trailing silence, WPM, and comparisons against the
upstream wrapper. Piper is synthesized as one phrase with sentence phonemes joined
by spaces, avoiding extra per-sentence wrapper overhead.

## Waveform compression

FFmpeg `atempo` provides pitch-preserving post-compression. Actual output sample
counts determine WPM; native inference is not rerun for each compression value.
FFmpeg does not return a source-to-output sample map, so compressed JSON keeps
`nativeWords` for reference but leaves `outputWords` empty. Dividing timestamps by
the speed multiplier would only be an approximation, not exact word alignment.
Our production SoundTouch mapping could be reused in a future browser adapter.

## Reading the measurements

- `warmMedianSeconds`: median native inference time; preprocessing is separate.
- `productionPlaybackRatio`: (warm inference + text preparation + compression)
  divided by output duration. Below 1 means this measured configuration produces
  audio faster than playback. It excludes initialization, downloads, WAV writing,
  and playback-device scheduling.
- `firstInferenceSeconds` is the first call at each pacing, not necessarily a cold
  model load. `initSeconds` records adapter construction separately.
- Piper has stochastic duration prediction; output durations can vary across runs.
- Small sample counts, one passage, native CPU only. These results do not establish
  browser WASM/WebGPU speed, mobile memory behavior, or audio quality.
- Compression processing includes subprocess startup. The downloaded FFmpeg binary
  is supplied by the pinned imageio-ffmpeg package.

## Sources and integration constraints

- [Kitten source and speed/style convention](https://github.com/KittenML/KittenTTS/blob/be5758500b731b8fc674acc62ea480d3022b7ebe/kittentts/onnx_model.py).
  Kitten is Apache-2.0; no source license notices are removed from cached files.
- [Piper alignment documentation](https://github.com/OHF-Voice/piper1-gpl/blob/251fdb9d33f69a5607e0b3432d999c49c4272b45/docs/ALIGNMENTS.md).
  The installed Piper package is 1.8.0, GPL-3.0. Its phonemizer and the chosen voice
  have their own distribution terms; `assets/piper/MODEL_CARD` links the Lessac
  dataset license. This experiment is not a decision to bundle those dependencies
  into the PWA.

Next gate: listen to the WAV comparisons, then benchmark a browser adapter with
native-duration export and original-word provenance. Native speed controls and
post-compression are available for both, so we can retain two independent controls.

## Experimental PWA integration

The reader and global voice-download menu now offer **Speech model → Piper ·
Lessac Low**, alongside Kokoro. Install the Piper pack, enable Read aloud, and
press Play. Both WASM and WebGPU can be selected independently; start with WASM.
Pacing adjusts Piper's native length scale and compression uses the existing
SoundTouch worker, including its source/output timing map.

Unlike the Python experiment, the browser currently uses the existing HeadTTS
English dictionary/normalizer with a compact-phoneme-to-IPA conversion. It retains
word provenance through normalization, but is not pronunciation-equivalent to
Piper's eSpeak frontend. Listen before judging voice quality from the Python
samples alone. The browser does not use the Kokoro WPM fit for Piper.

A repeatable browser smoke test (Playwright 1.63.0, Chromium required):

```bash
python browser_piper.py --url http://localhost:5250 --chromium /path/to/chromium
```

Run this from the experiment directory after staging the models with `download.py`
and the Kokoro pronunciation dictionary as described in `../kokoro/README.md`.
The script substitutes local files for remote downloads; inference uses real
models. Its GPU run enables Chromium's software adapter, not a hardware benchmark.

## Piper voice catalog

The browser defaults to **Lessac Low** for new preferences. Existing saved voices
are preserved. Global settings downloads and the reader use the same model,
voice, and quality selectors. The pinned catalog contains 23 US-English
single-speaker variants. Only published combinations are selectable; **Extra
low is unavailable for English in this revision**. Multispeaker models and
non-US pronunciation adapters are not included.

Regenerate source/config SHA-256 hashes, sizes, and model-card links with:

```sh
python frontend/experiments/tts-alternatives/catalog.py
```

New catalog packs cache the verified original ONNX graph and expose its native
`/Ceil_output_0` durations at initialization. Existing Lessac Low installations
retain their pack identity and patched graph. Every installation must pass a real
synthesis probe before being marked installed. The shared dictionary/runtime
remain reference-counted by the pack store. Lessac Low, Medium, and High were
checked with browser CPU/WASM synthesis at native and 2× compressed playback;
other catalog entries have verified upstream metadata but are not individually
listening-tested. The current timing adapter checks the 256-samples-per-frame
geometry and fails explicitly if a model differs.

## Native pacing → WPM experiment

After installing `requirements.txt` and downloading the existing experiment assets:

```sh
/tmp/speedreader-tts-alternatives/bin/python frontend/experiments/tts-alternatives/piper_pacing.py
```

Optional: `--text-file short-passage.txt --repeats 10 --threads 2`.
Outputs are in `output-pacing/`: a standalone SVG/PNG chart, HTML viewer, CSV,
and JSON including input token durations and run configuration. Runs are
incrementally saved; the script reruns the sweep when restarted.

The first sweep uses Lessac Low, nine pacing values from 0.5× to 4×, five
repeats each, and two conditions (90 runs total). Compression stays at 1×.
Production noise uses the model's defaults; zero noise isolates duration
quantization. Job order is shuffled with seed 2026; model random noise is not
seeded, so production results vary on rerun. One warmup is excluded. The text
has 23 whitespace-delimited words; WPM includes silence and punctuation pauses.
This uses reference eSpeak on native CPU ONNX, so it is not a calibration for
the browser's English pronunciation adapter or other voices.

Initial production-noise means (± run-to-run SD): 1× **220 ± 7 WPM**, 2×
**292 ± 4 WPM**, 4× **319 ± 1 WPM**. Pacing is clearly sublinear on this
passage. The actual graph computes token frames as
`ceil(exp(predicted_log_duration) * mask * length_scale / pacing)`.
Rounding positive token durations up to whole frames creates a floor; increasing
pacing eventually stops shortening most tokens. The zero-noise control also
levels off (about 325 WPM at 4×). This is a passage-specific ceiling, not a
universal Piper limit. Post-compression can increase the rendered WPM further.
No speech recognition or retranscription is used.

The compact first-sweep summary is retained in `piper-pacing-baseline.json`.
`browser-catalog-report.json` records the three-tier CPU smoke results.
To repeat the browser check, stage the pinned Lessac low/medium/high `.onnx`
and `.onnx.json` assets under `assets/catalog/`, start Vite, and run:

```sh
python browser_catalog.py --url http://localhost:5250 --chromium /path/to/chrome
```

This requires Python Playwright; it uses local assets to avoid network-dependent
browser downloads while retaining production integrity checks and inference.

### Repeat across quality tiers

```sh
/tmp/speedreader-tts-alternatives/bin/python frontend/experiments/tts-alternatives/piper_quality_pacing.py
```

Runs the same 23-word passage and nine pacing values for Lessac Low, Medium,
and High: five repeats in each of the default-noise and zero-noise conditions
(**270 measured syntheses**, plus a warmup per model). Compression stays at 1×.
Each model/config is downloaded if missing and verified against the pinned
catalog SHA-256. Extra low cannot be included because no English version is
published in this catalog. Holding the voice name fixed avoids changing speaker
identity, but these are separately trained models, so differences cannot be
attributed solely to the quality tier.

`output-quality-pacing/index.html` compares the tiers in two panels, with no
linear reference line. Raw CSV/JSON, per-tier results, SVG/PNG plots, and model
hashes are saved alongside it. Error bars are standard deviations across runs.
Use `--text-file`, `--threads`, or `--repeats` to change the common conditions.
The wrapper reruns all tiers; each tier saves completed runs incrementally.
For one tier: `piper_pacing.py --quality medium --output output-pacing-medium`.
The native CPU timing excludes phonemization and browser DSP; the experiment
uses eSpeak rather than the PWA's pronunciation adapter. Stochastic production
runs are not seeded and can differ from the earlier Low-only baseline.

First completed comparison (mean WPM, default noise):

| Lessac tier | 1× pacing | 2× pacing | 4× pacing |
| --- | ---: | ---: | ---: |
| Low | 220.2 | 287.6 | 319.9 |
| Medium | 217.5 | 336.8 | 417.7 |
| High | 224.8 | 340.0 | 429.8 |

All 270 runs passed native token-duration/waveform geometry checks. Medium and
High retain more pacing range on this passage; a single Low-derived WPM curve
would underpredict their rates. Low has 256-sample frames at 16 kHz (16 ms),
while Medium/High use 256 samples at 22.05 kHz (about 11.61 ms), giving them a
shorter frame-duration floor as well as different trained duration predictions.
These are measured speaking rates, not synthesis throughput or intelligibility
scores. Compact provenance and summary: `piper-quality-pacing-baseline.json`.

## CPU/WASM versus WebGPU timing, Low baseline

Open the development server's
`/experiments/tts-alternatives/backend-benchmark/index.html` and press **Run
benchmark**. It downloads verified Low/Medium/High Lessac assets, records GPU
adapter identity, and measures a fresh worker session for each quality/backend.
Pacing and compression are 1×. The same nine-word source passage is phonemized
through the PWA adapter. Initialization and first inference are reported
separately from three warm repetitions. This calls the inference worker directly,
so no synthesis-cache hits or DSP time contaminate the comparison. WASM uses the
production one-thread setting. Cases run sequentially in fixed order; repeat the
benchmark to assess thermal/order effects and other device variability.

`relativeToLow = medianInferenceMs / Low.medianInferenceMs` **within each backend**;
2× means twice as much time, not twice the speed. Real-time factor is also saved
because model-default stochastic durations and quality tiers can produce
unequal audio lengths. Comparing both latency and time/audio-duration avoids
confusing speaking speed with generation speed. This measures backend execution;
WebGPU may execute unsupported operations on the CPU.

The headless runner uses staged assets from `assets/catalog/` and the existing
local dictionary fixture:

```sh
python benchmark_backends.py --url http://localhost:5251 --chromium /path/to/chrome
python plot_backends.py output-backends/results.json
```

The runner requires Playwright, and plotting uses the experiment requirements.
Incremental JSON records completed repetitions if interrupted; restarting runs
all cases again. The interactive page downloads JSON for the same plotting tool.
The current container exposes **SwiftShader software WebGPU**, not a physical
GPU, so its WebGPU numbers cannot establish hardware acceleration or predict
your GPU's speed. Run the page in your normal browser for a hardware comparison.

Completed container baseline (three warm inferences per case):

| Tier | CPU/WASM median | Relative to Low | Software WebGPU median | Relative to Low |
| --- | ---: | ---: | ---: | ---: |
| Low | 0.431 s | 1.00× | 7.639 s | 1.00× |
| Medium | 0.558 s | 1.30× | 9.496 s | 1.24× |
| High | 4.906 s | 11.40× | 71.931 s | 9.42× |

GPU adapter: Google SwiftShader, fallback adapter. These are **not physical GPU
measurements**. High WebGPU was recovered in a separate fresh browser session
after a Vite reload interrupted its initial case; the saved baseline records
that provenance. CPU median synthesis/audio ratios were 0.148/0.184/1.613 for
Low/Medium/High. On this machine, High CPU synthesis was slower than playback.
Do not generalize these short-passage results to all devices, voices, or pacing.
Full raw baseline: `piper-backend-baseline.json`; comparison plot and summaries:
`output-backends/relative-timing.png` and `output-backends/summary.csv`.
