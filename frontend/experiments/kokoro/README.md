# Kokoro alignment feasibility probe

This is the first implementation slice of [the read-aloud plan](../../../docs/kokoro-offline-audio.md).
It is a development experiment; the reader does not load a model or expose audio controls.

## Python speech + word timestamps prototype

### Streamlit speed controls

After installing the CPU PyTorch wheel as shown below:

```sh
/tmp/speedreader-kokoro-prototype/bin/pip install -r frontend/experiments/kokoro/ui-requirements.txt
/tmp/speedreader-kokoro-prototype/bin/streamlit run frontend/experiments/kokoro/streamlit_app.py --server.address 127.0.0.1
```

Open http://localhost:8501. Two sliders independently control Kokoro phoneme
pacing (0.5–4x) and pitch-preserving time compression (0.5–4x). Press **Generate
speech** to apply them. Changing compression alone reuses cached synthesis;
the UI labels previously generated audio when settings change. Compare the
original synthesis, download the processed WAV, or inspect original annotations.

Compression uses the FFmpeg binary supplied by `imageio-ffmpeg`. Chained `atempo`
stages stay at or below 2x, avoiding the documented sample-skipping behavior of
larger individual factors ([FFmpeg documentation](https://ffmpeg.org/ffmpeg-filters.html#atempo)).
This is an experimental DSP choice, not a production quality decision. Original
timestamps are clearly labeled and are not presented as aligned to processed audio.
Synthesis caches hold at most eight passages; processed audio caches hold sixteen.

UI and DSP checks (including a real synthesis and a 440 Hz pitch check):

```sh
/tmp/speedreader-kokoro-prototype/bin/python -m unittest discover -s frontend/experiments/kokoro -p test_streamlit_ui.py
```

### Command-line setup

Run from the repository root with Python 3.12 (the tested version):

```sh
python -m venv /tmp/speedreader-kokoro-prototype
/tmp/speedreader-kokoro-prototype/bin/pip install torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu
/tmp/speedreader-kokoro-prototype/bin/pip install -r frontend/experiments/kokoro/prototype-requirements.txt
/tmp/speedreader-kokoro-prototype/bin/python frontend/experiments/kokoro/prototype.py
```

The first run downloads the pinned original Python Kokoro v1.0 weights, config,
and `af_heart` voice to the Hugging Face cache. This uses PyTorch, not the inspected
ONNX graph. Text-to-phoneme conversion and inference are local. No transcription
or forced-alignment model is used. Installation includes Misaki's English text
processing dependencies, including the spaCy language package and eSpeak NG.

Open `output/index.html` in a browser to play the audio with word highlighting.
Click any timed word to seek to its estimated start. Generated files are ignored
by git:

- `output/speech.wav`: 24 kHz speech.
- `output/annotations.json`: original words, tokenizer spans, phoneme strings,
  model token IDs/positions, and predicted duration frames.
- `output/index.html`: audio player and word timing table.

Use `--text-file path.txt` for another short passage, `--speed 1.5` for another
relative speed, and `--output path` to keep separate results. After downloading
assets, `--offline` restricts Hugging Face loading to its cache. Missing language
packages produce an error rather than an implicit installation.

The experimental speed input accepts 0.5–4x. A direct Kokoro `--speed 4` run
produced 3.60 seconds of audio for this example (versus 8.05 seconds at 1x),
with mapping/bounds checks passing. This setting does not guarantee fourfold
compression. Listen to `output-4x/index.html` to assess its quality.

### What maps to what

Original words are zero-based whitespace-delimited source spans. For each word,
the JSON includes Python character offsets and JavaScript-compatible UTF-16
offsets. Misaki token text is matched sequentially against that unchanged source.
Phoneme symbols then retain their tokenizer index and original `wordIndices`.
Boundary tokens and inter-token spaces have no source-word owner.

For example, the sample's original word **3**, `$25`, is tokenized into `$` and
`25`. The latter's phonemes are `twˈɛnti fˈIv dˈɑləɹz` (twenty-five dollars).
All of those phoneme model tokens map to original word **3**, whose measured
prototype interval at 1x is **1.3625–2.3750 seconds**.

Word timestamps come directly from Kokoro's `KPipeline.join_timestamps`, aggregated
over each word's tokenizer pieces. `modelTokens[].rawStartSeconds/rawEndSeconds`
are **unadjusted model frame coordinates**, using the upstream 40 Hz convention;
they are not corrected audible phoneme onsets. Word timing applies upstream's
boundary offset and space handling, so these two timelines intentionally differ.
Symbols include stress marks and punctuation, not just standalone linguistic
phonemes. No character-length timing estimates are used.

The prototype rejects source rewrites, missing phonemes for alphanumeric tokens,
unknown model symbols, invalid timestamps and passages exceeding 510 phoneme
characters. A tokenizer unit spanning multiple original words is marked
`ambiguous`, with no invented individual word timestamps. This prototype does
not implement production chunking or all reader ingestion tokenization rules.

### Recorded run

[`prototype-results.json`](prototype-results.json) records two cached-asset CPU
runs, each with 19 words, 134 model tokens and no ambiguous word mappings:

| Relative speed | Audio duration | Synthesis time |
| --- | --- | --- |
| 1x | 8.05 s | 2.30 s |
| 1.5x | 5.15 s | 1.56 s |

Source coverage, token count, monotonic word timing and audio bounds passed.
These are single-run measurements with four PyTorch threads, not device
benchmarks. Audible onset accuracy still needs listening validation.

Mapping regression tests run without model dependencies:

```sh
python -m unittest discover -s frontend/experiments/kokoro -p test_prototype.py
```

## Reproduce graph inspection

Use Python 3.10+ and a disposable environment outside the repository:

```sh
python -m venv /tmp/speedreader-kokoro-venv
/tmp/speedreader-kokoro-venv/bin/pip install -r frontend/experiments/kokoro/requirements.txt
/tmp/speedreader-kokoro-venv/bin/python frontend/experiments/kokoro/inspect_graph.py \
  /tmp/speedreader-kokoro-q8.onnx --download \
  --output /tmp/kokoro-graph-report.json
```

Run from the repository root. `--download` explicitly fetches one 92,361,116-byte
Compact candidate, only if the destination is absent. An existing file is always
size/hash checked; a corrupt file produces an error rather than being overwritten.
Omit `--download` to run entirely from the local model. The report is deterministic
for the pinned model and inspector. Heavy assets stay outside the app and its PWA
precache. This downloader is an experiment, not the production pack installer.

## Evidence recorded 2026-09-15

[`graph-report.json`](graph-report.json) records inspection of the model pinned in
[`model.json`](model.json), after SHA-256 verification and ONNX structural checking.
The graph has `input_ids`, `style`, and `speed` inputs and **only `waveform` as an
output**. Internal Round/CumSum nodes are recorded as inspection starting points;
their presence does not establish valid timestamps.

The initial network blocker is resolved in this workspace. Python inference and
source mapping have now run successfully as described above. Listening accuracy,
browser/device benchmarks, DSP processing and offline installed browser playback
remain unvalidated. The release alignment gate remains **unvalidated**.

## Mapping foundation

`src/audio/alignment.ts` preserves original word indices and UTF-16 source spans
for whole-phrase processing. It projects explicit word-to-token ranges through
model durations with a caller-supplied frame size and decoder offset, rejecting
missing/reordered mappings, overlap, invalid durations and out-of-audio word bounds.
Unspoken words require explicit empty ranges. Expansions can occupy multiple tokens
while retaining one source index. It never assigns time using word/character length.

The tests use synthetic provenance and geometry. They verify the projection contract,
**not** English normalization, phonemization or Kokoro audible timing. Nothing calls
this helper in the reader yet.

## Next work

1. Trace the exact duration tensor and produce a pinned, reproducible duration-enabled
   export. Compare its waveform with this baseline using identical inputs.
2. Select/pin normalization and phonemization assets that preserve whole-phrase
   provenance, including expansions, abbreviations and Unicode. Reject unsupported
   or ambiguous mappings rather than guessing. Enforce the real token limit.
3. Derive frame/sample geometry and decoder offsets from that export. Measure word
   onsets at multiple speech speeds and record acceptance bounds.
4. Benchmark independent pitch/speed DSP, including latency, padding and chunk seams,
   on desktop/mobile. Only then choose production runtime and pack contents.

## Attribution

- Kokoro 82M v1.0: hexgrad; this ONNX conversion: onnx-community. The pinned model
  card declares Apache-2.0; its immutable URL is in `model.json`.
- ONNX 1.17.0: ONNX contributors, Apache-2.0.
- NumPy 2.2.6: NumPy developers, BSD-3-Clause (bundled components have additional
  notices in the installed distribution).
- Protobuf 5.29.5: Google, BSD-3-Clause.

The synthesis prototype additionally uses Kokoro and Misaki (Apache-2.0), PyTorch
(BSD-style), Transformers (Apache-2.0), spaCy and its English model (MIT),
SoundFile (BSD-3-Clause, with libsndfile LGPL notices) and eSpeak NG (GPL-3.0-or-later).
These are development tools only. Browser runtime, phonemizer, voices and DSP
licenses/assets still need their own reviewed pack inventory.

## Full-speech WPM surface experiment

```sh
python -m venv ~/.cache/speedreader-kokoro-venv
~/.cache/speedreader-kokoro-venv/bin/pip install torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu
~/.cache/speedreader-kokoro-venv/bin/pip install -r frontend/experiments/kokoro/benchmark-requirements.txt
~/.cache/speedreader-kokoro-venv/bin/python frontend/experiments/kokoro/benchmark_surface.py --parallel
```

This samples ten random positions using a seeded Latin hypercube over both
0.5–4x slider ranges. Unlike the short-passage prototype, it phonemizes the full
`arsenalofdemocracy.md` paragraph by paragraph and splits into 68 bounded chunks.
It checks source-text coverage (ignoring whitespace), chunk token identity, and
phoneme vocabulary/limits before synthesis. Every position uses identical chunks,
voice and source. There is no silent truncation.

WPM = 4,023 original whitespace-delimited tokens × 60 / processed WAV seconds.
This convention includes standalone punctuation tokens. Model-generated silence
is included; compute time is excluded. No extra inter-chunk silence is inserted.
Compression is applied once to the concatenated whole-speech WAV. This measures
throughput, not intelligibility or word-onset accuracy.

`output-surface/` contains resumable per-position JSON, full original/processed
WAVs, CSV results, a static `surface.png`, and a standalone interactive
`surface.html`. The triangular surface linearly interpolates the ten measurements
only within their convex hull; it is not a validated predictive model and does
not extrapolate to unsampled corners. Red points are actual measurements.
The report also records the fraction of model tokens at the one-frame minimum,
which helps investigate saturation at high Kokoro pacing settings.

Completed points are reused on rerun only if the source hash, model revision,
sampling seed and positions match. Move the output directory to start a fresh run.

Recovery: the benchmark now saves each chunk as PCM plus hash-verified metadata.
An interruption resumes at the first missing/corrupt chunk. Two workers claim
unfinished points with file locks and release temporary decoder buffers between
chunks; the model runs with two CPU threads per worker. The environment above
lives outside `/tmp` so workspace restarts do not discard it. Completed point
JSON files are the authoritative progress record; the aggregate CSV/plots are
regenerated when the batch completes.

### Polynomial trend fit

```sh
~/.cache/speedreader-kokoro-venv/bin/python frontend/experiments/kokoro/fit_trend.py
```

This reads completed point JSON directly, so it can run during a batch. It fits
`WPM(p, c) ≈ c × f(p)` using original, pre-compression WPM to estimate `f`.
Linear, quadratic and cubic polynomials are compared by leave-one-out prediction
error, rather than choosing by training fit alone. The separate compression
check compares measured processed WPM against `c × original WPM`.

Outputs: `polynomial-fit.json` (coefficients in ascending power order and errors),
`polynomial-fit.png`, and `polynomial-surface.html`. The curves are empirical for
this speech and voice. They must not be extrapolated; a fitted polynomial can
turn downward even though the observed pacing response is monotonic/saturating.
The surface assumes multiplicative compression between the measured positions.

The benchmark bounds CPU kernel caches to 64 entries before importing PyTorch
and releases temporary buffers between chunks. The cache capacity is a resource
control, not a change to the timing model. See the
[oneDNN cache documentation](https://uxlfoundation.github.io/oneDNN/v3.0/dev_guide_primitive_cache.html).

### Bounded rational quadratic

```sh
~/.cache/speedreader-kokoro-venv/bin/pip install -r frontend/experiments/kokoro/benchmark-requirements.txt
~/.cache/speedreader-kokoro-venv/bin/python frontend/experiments/kokoro/fit_rational.py
```

A two-parameter monotonic alternative is
`WPM(p,c) = c × M p² / (K² + p²)`, with positive `M` and `K`.
It starts at zero, reaches half the asymptote at `p=K`, and approaches `M`
without overshooting or turning downward. The ten-point fit is:

- `M = 437.9469 WPM`, `K = 1.173302`, `K² = 1.376638`.
- Pre-compression training RMSE: 6.28 WPM; leave-one-out RMSE: 8.56 WPM.
- Ordinary quadratic leave-one-out RMSE: 8.23 WPM, with three rather than two parameters.
- Combined WPM leave-one-out RMSE after applying each compression setting: 16.11 WPM.

The rational form trades a small amount of empirical fit for a monotonic finite
limit. **438 WPM is a fitted asymptote, not an experimentally established maximum.**
Only pacing 0.712–3.685x was measured. The dashed extension in `rational-fit.png`
is explicitly extrapolation. `rational-surface.html` shows the combined fitted
surface over the measured input ranges; `rational-fit.json` records coefficients,
errors, measured values and held-out predictions.

## Duration-enabled ONNX and browser probe

`export_durations.py` exposes `/encoder/Gather_output_0`, the integer durations
consumed by the graph's cumulative alignment. It verifies the original pinned
SHA-256, checks the graph, and runs original/export waveform equality at pacing
0.5, 1, 1.5 and 4. The export does not change weights or inference operations.
`duration-export.json` records hashes, versions and measurements. All four outputs
were bit-identical to the original graph. Duration sums exactly matched waveform
length at 600 samples/frame. These are geometry checks, not audible-onset validation.

```sh
python export_durations.py --model /path/model_quantized.onnx \
  --voice /path/af_heart.bin --output /path/model_durations.onnx \
  --report duration-export.json
```

For the browser probe, place `model_durations.onnx` and `af_heart.bin` in
`output-browser/`, run the frontend Vite server, then open
`/experiments/kokoro/browser-probe.html`. It uses the dedicated synthesis worker
and the frozen original-word fixture in `alignment-fixture.json`. No phonemizer
or transcript recognizer runs in this probe. It deliberately does not claim to
support arbitrary text yet.

`browser-wasm-report.json` records a headless Chromium run on this Linux host,
using ORT Web 1.22.0, one WASM thread, no cross-origin isolation. Initialization
was 1.17 s. At pacing 1, generation took 13.22 s for 7.975 s of PCM. Token duration
differences against Python ORT were at most one frame; every browser output
satisfied its own duration/sample geometry. This host did not expose a WebGPU
adapter, so GPU performance and parity remain unmeasured. Do not extrapolate
these CPU numbers to a GPU or phone.

The PWA now uses the pinned HeadTTS English dictionary/rules through a provenance
wrapper. The wrapper expands titles and currency (`Dr.` → “doctor”, `$25` →
“25 dollars”), preserves final one-letter source words, rejects unsupported
notations/scripts, and splits at original-word boundaries before the model limit.
It does not reproduce all of Misaki's contextual pronunciation behavior. No
speech recognition or retranscription is involved.

## Production PWA acceptance

The experimental application path is available at `?kokoro=1`. Install Heart from
**Read aloud**, enable the mode and press Play. Both tempo controls work offline;
voice preview uses a separate output and preserves the book position. The equation
is labeled as a Python experiment estimate; observed WPM uses consumed speech
samples and excludes buffering and explicit pauses.

Run the browser checks from the repository root with a production server already
running (do not point this test at the Vite development server):

```sh
python -m pip install -r frontend/experiments/kokoro/browser-requirements.txt
python -m playwright install chromium
npm --prefix frontend run build
python -m http.server 4174 --directory frontend/dist
# In another terminal:
python frontend/experiments/kokoro/browser_acceptance.py \
  --url 'http://localhost:4174/?kokoro=1' \
  --text-file frontend/experiments/kokoro/arsenalofdemocracy.md \
  --pacing 1.5 --compression 2.4 --soak-seconds 1800 \
  --report frontend/experiments/kokoro/browser-production-soak.json
```

The test installs and probes the pack, exits through the application's awaited
save path, blocks networking, reloads under the service worker and checks all
three presentations, pause, sentence navigation and both controls. The sustained
run fails on a synthesis error or 90 seconds without word progression. By default it uses
the browser's normal autoplay policy. `--autoplay-unrestricted` is an explicit
headless Chromium workaround for a stalled audio clock observed even with a plain
oscillator on this host. The report discloses that override; such a run does not
validate autoplay policy. Run a separate normal-policy smoke check. `--chromium` optionally selects an existing
Chromium binary. `--browser firefox` exercises Firefox after
`python -m playwright install firefox`; its persistent-storage prompt is granted
by the harness and disclosed in the report. For Pages, build with `SPEEDREADER_BASE_PATH=/speedreader/` and
serve the build under that directory, then supply the corresponding URL.

`--local-assets-url` optionally substitutes identical pinned model/voice/dictionary
bytes during installation. Reports disclose this fixture substitution: it tests
integrity, local inference and offline storage, but does not test CDN availability.
Production application code contains no such download override.

Memory reports cover **main-thread JavaScript heap only**, excluding synthesis and
DSP workers, WASM memory and native audio buffers. Headless tests do not establish
audibility, word-onset accuracy, device output latency or WebGPU performance.
The feature remains development-gated pending the device/listening matrix in
[the implementation specification](../../../docs/kokoro-offline-audio.md).

To exhaustively check source ownership for every window of 1–24 words in the
speech using the staged dictionary, run from `frontend/`:

```sh
npx tsx experiments/kokoro/check-phrases.mts
```


### Additional browser evidence

- `browser-update-report.json`: a real waiting service worker remained inactive
  while another tab held a reader open. Reader exit allowed activation; all four
  immutable pack assets survived, and the updated app synthesized offline.
  `browser_update_acceptance.py` reproduces this with two production builds and a
  disposable deployment directory.
- `phrase-ownership-report.json`: all 96,276 windows of 1–24 source words in the
  4,023-word speech retain their original word indices.
- `browser-webgpu-software-report.json`: Chromium with
  `--enable-unsafe-webgpu` exposed Google's **SwiftShader software fallback**.
  The duration-enabled graph initialized and ran at four pacing values, with
  valid native duration/sample geometry. Differences from CPU durations reached
  25 frames, so this is **not numerical or audible parity**. These software GPU
  timings do not predict hardware GPU throughput. The same probe page can be
  used on a physical WebGPU device without that flag.

For headless audio testing, provide a working audio backend. A private PulseAudio
null sink can be selected with `PULSE_SERVER=unix:/path/to/socket`; Chromium also
needs `--unmute-audio` to remove Playwright's mute flag. Reports disclose the
virtual server and autoplay override independently. A null sink exercises clocks
and playback scheduling; it does not validate audible output.

The Chromium and Firefox Pages reports both passed their normal-autoplay
90-second offline runs using the virtual audio backend. The earlier stopped-clock
failures therefore remain environment observations, not evidence that those
browsers are unsupported. The 30-minute full-speech report separately discloses
its unrestricted-autoplay workaround. Main-thread heap measurements do not cover
the full browser process; physical devices and listening remain release gates.

`browser-preview-controls.json` also verifies that a local offline preview leaves
book position unchanged. Firefox's initially pending persistence permission
exposed an installer bug: the app now requests persistence as best effort and
continues installation, with cancellation supported while waiting for a pack lock.

`browser_benchmark.py` measures initialization, first inference and repeated
identical-pace inference in one worker. The recorded WASM run initialized in
1.04 s; first inference took 14.24 s and three warm runs had a 13.95 s median for
7.975 s of native audio. All four sample counts matched. Another WASM soak was
running on this host, so these are not isolated-device performance results.
Run `--provider webgpu` on a physical GPU; `--software-gpu` explicitly opts into
Chromium's software-adapter test flag. A few repeats do not establish p95 latency.

### Thirty-minute full-speech result

`browser-production-soak.json` passed 1,800 seconds offline at Kokoro pacing 1.5x
and compression 2.4x. It reached the end of the 4,023-word Arsenal of Democracy
text and restarted, finishing at word 244. Final-window observed speech was
approximately 625 WPM, excluding buffering; this is not wall-clock throughput.
Peak sampled main-thread heap was 72.3 MB. Installation used pinned local download
fixtures and this run used the disclosed unrestricted-autoplay workaround.
It does not certify audible alignment or bounded worker/WASM/native memory.
