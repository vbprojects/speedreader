# Offline Kokoro read-aloud implementation specification

Status: planned; no runtime implementation in this change.

## Product contract

Read aloud is an optional mode. When enabled, audio owns reader progression.
Kokoro is the only TTS model. Text, synthesis, alignment, and audio processing
remain local after installation. No cloud or system-speech fallback is permitted.

Users choose voice, relative speech speed, and independent pitch. There is no
target WPM or feedback loop attempting to hit a WPM. An optional observed WPM
display measures original displayed words over speech playback time; buffering
and explicit pauses are excluded.

The existing visual pacing settings remain saved. In audio mode their controls
are inactive and explain "Timing follows speech." Disable audio to restore them.

Initial scope: English, RSVP, context and read-along views, saved text, and
already available text from live sources. New live-source content still needs a
connection. Preserve pause-on-background; background narration, audiobook export,
voice cloning and additional TTS models are outside this release.

## Current integration points

The inspected tree matches main at cb283456fb39d8af82d4ff68e5c59e3678c6543e.

- frontend/src/display/clock.ts: silent SelfCorrectingClock and interaction gates.
- frontend/src/display/types.ts: current Clock mixes transport and duration arrays.
- frontend/src/display/SpeedReader.tsx: clock ownership, navigation, triggers,
  live stream extension, rendering and pause-on-background.
- frontend/src/reader/ReaderScreen.tsx: effective settings and pacing creation.
- frontend/src/settings/types.ts: defaults and per-book overrides.
- frontend/src/ReaderApp.tsx: position persistence and source coordination.
- frontend/vite.config.ts: PWA precaching and base-path handling.

Extract shared transport operations from duration-specific operations. Keep the
silent controller's behavior intact; add an audio controller rather than feeding
speech durations to a second independent timer. Both controllers use shared
interaction and engine-trigger delivery logic.

## Controls and defaults

| Control | Default | Behavior |
| --- | --- | --- |
| Read aloud | Off | Persist through existing global/per-book settings inheritance |
| Voice | af_heart | Choose from installed English Kokoro voice embeddings |
| Speech speed | 1x | Relative duration adjustment; proposed 0.5–4x subject to validation |
| Pitch | 0 semitones | Independent adjustment; proposed -6 to +6 subject to validation |
| Preview | User action | Short local sample with current settings |
| Downloads | None | Install, inspect, repair and remove packs |
| Observed WPM | Read-only | Never feeds back into synthesis |

Use accessible numeric inputs and step buttons. Do not announce every word to
screen readers. Announce loading/error states without continuous live-region
noise. Opening a book never autoplays audio.

First activation offers a download with actual total bytes. The states are
not-installed, downloading, verifying, installed and repair-needed. Installation
completion does not itself start playback; the user presses Play.

## Model and runtime

Pin Kokoro 82M v1.0, tokenizer, phonemizer, voice embeddings, ONNX Runtime and DSP
assets to immutable versions. Record attribution and each dependency's license.

Candidate packs:
- Compact: q8/WASM; upstream weights approximately 92.4 MB.
- Accelerated: fp32/WebGPU; upstream weights approximately 326 MB.

These are weight sizes, not final pack size or peak memory. Duration-enabled
exports may differ. Recommend Compact initially, and offer Accelerated only with
capability checks and explicit download size. Never download both automatically.

An accelerated pack can fall back only to a validated runtime using installed
assets. Test fp32/WASM before advertising it as a fallback. Offline failure must
not initiate an undisclosed download of another precision.

Use a dedicated synthesis worker and one active inference session. WASM must
work without cross-origin isolation; enable multiple threads only when supported.
Do not use ONNX Runtime's WASM proxy-worker flag for WebGPU. Lazy-load synthesis
and preserve the small initial app download.

## Alignment feasibility gate

Kokoro computes predicted phoneme-token durations. Its Python ONNX wrapper
returns waveform and duration, but the current JavaScript wrapper extracts only
waveform. Inspect the selected graph outputs first. If necessary, create a
reproducible export with duration output and verify numerical/audio parity.

Preserve a reversible mapping:
original word indices -> normalized spoken spans -> phoneme tokens -> samples.

Requirements:
- Keep phrase context during normalization and phonemization.
- Track expansions such as $25 and abbreviations back to the original token.
- Handle contractions, punctuation, hyphens, Unicode and unspoken symbols.
- Account for boundary tokens, silence and decoder offsets.
- Derive frame-to-sample conversion from the exact model/export.
- Validate monotonic boundaries and audio bounds.
- Validate audible alignment at multiple speeds, not just matching total length.

Model-derived durations are not automatically exact word timestamps. Do not use
uniform per-word or character-length estimates as the shipped RSVP alignment.
No separate forced-alignment model is included. If this gate fails, the feature
remains draft and unavailable, with the failure recorded.

## Text chunking

Build clauses/short sentences from the existing wordstream, preserving source
indices, punctuation, paragraphs, interaction boundaries and content revision.
Respect the actual phoneme-token limit before inference; never silently truncate.

For growing sources, commit complete clauses, then flush the final fragment on
source completion. Do not repeatedly regenerate a clause as tokens arrive.
Chunk building must not execute ingestion actions or cross unresolved choices.

Generate one short chunk to start, then maintain approximately ten seconds of
playable audio, bounded by both queue length and a memory ceiling. Tune on mobile.
Keep a bounded in-memory cache for rewind. Persistent generated audio is not
needed for offline use; the installed model regenerates saved text.

## Audio transport and processing

The audio controller owns:
- play/pause/seek and user play intent;
- synthesis queue and revisions;
- sample cursor and word mapping;
- buffering, interaction, end and error states;
- resource disposal.

Use Web Audio and an AudioWorklet for PCM scheduling. Select a maintained,
license-compatible DSP implementation through a small benchmark for independent
pitch and speed. Do not implement pitch by playback-rate changes alone.

Use Kokoro speed within a validated range; if required, combine with
pitch-preserving time compression for higher relative speeds. There is no WPM
calibration. Duration-preserving pitch processing must account for latency and
padding. Test chunk seams and sample-rate conversion (model output is 24 kHz).

The progress cursor counts speech samples consumed, not silent underrun samples.
Track source-to-output sample mapping after DSP and compensate for output latency
where measurable. UI animation reads this cursor; UI timers never own progression.

If a rendered frame crosses several word boundaries, deliver all intervening
nonblocking triggers in order. Enforce blocking boundaries before queuing audio,
so main-thread delays cannot speak beyond a pending interaction.

Separate user play intent from actual playback:
paused, preparing, playing, buffering, waiting-for-interaction, ended, error.
Resuming after buffer recovery must not override a user's intervening Pause.

## Reader transitions

| Event | Required behavior |
| --- | --- |
| Enable during silent playback | Stop silent clock at current word; prepare and continue audio |
| Disable during audio playback | Stop audio; restore silent pacing at current word |
| Pause/resume | Keep current chunk sample offset |
| Seek/sentence navigation | Cancel old queue; move and remain paused |
| Presentation switch | Keep transport and sample position |
| Voice/speed change | Apply at next chunk boundary; regenerate only future chunks |
| Pitch change | Smooth transition with unchanged logical word timeline |
| Content edit | Invalidate affected chunks and alignments |
| Interaction | Pause at boundary; obey existing resolution/resume semantics |
| Leave reader/change book | Stop, cancel, save and release resources |
| Background/lock screen | Pause and save |
| Reopen | Restore word/settings; wait for Play |

All worker requests carry a session ID, content revision and settings revision.
Discard stale responses even when an inference cannot be interrupted.
Recheck interaction state before scheduling completed work.

On resume after reload, restart the saved word. When seeking inside a sentence,
synthesize sufficient preceding context if needed, then start at its validated
word boundary. Do not replay preceding context audibly without user action.

## Offline storage and updates

Use Cache Storage for immutable downloadable assets and IndexedDB for manifests
and installation metadata. Shared weights are stored once; voice removal must not
remove files referenced by another installed voice.

A manifest contains pack ID/version, runtime compatibility, asset URLs, hashes,
sizes and roles. Validate every required asset and run local synthesis before
committing installed status. Retry incomplete downloads; reuse verified files.

Cache all model, tokenizer, phonemizer, runtime JS/WASM, worker and DSP assets.
Pin local resolution; installed playback must not require CDN/version requests.
Do not rely on incidental HTTP cache or a successful online inference.

Request persistent storage, handle quota errors and check asset presence on use.
An installed flag alone is not proof that files survived browser eviction.

PWA work:
- Current precache glob omits wasm; explicitly handle required WASM.
- Keep optional heavy assets separate from mandatory app precache.
- Preserve voice packs during ordinary service-worker cache cleanup.
- Preserve compatible runtime assets across app updates.
- Stage replacement packs and commit only after validation.
- Never delete the usable old version before a replacement is complete.
- Test both root paths and the /speedreader/ Pages base.
- Coordinate active playback with service-worker updates; do not mix revisions.
- Do not use the service worker as a long-lived synthesis worker.

## Failure behavior

Download failure: retain verified files and offer retry.
Quota failure: show required space and removal options.
Evicted/corrupt pack: offer Repair; keep silent reader usable.
GPU failure: use validated installed WASM path or pause with explanation.
Slow inference: buffer at the current word; do not silently reduce speed.
Suspended audio context: explicit Resume audio.
Synthesis/alignment failure: pause affected passage; Retry or Disable audio.
Unsupported language: explain initial English support.
No failure may silently skip text or send it to a remote service.

## Implementation stages

1. Feasibility: pinned duration-enabled Kokoro, word mapping, speed/pitch DSP,
   desktop/mobile evidence. This is a prerequisite for shipping audio mode.
2. Pack management: manifest, installer, integrity, offline resolution,
   persistence, repair/removal and update compatibility.
3. Transport: shared controller interface, silent-controller regression coverage,
   audio cursor, queue, cancellation and buffering.
4. Integration: toggle/settings, all views, seeking, growing streams and gates.
5. Release: production offline tests, cross-device performance, listening and
   alignment checks, documentation and CI.

## Verification and release gates

Automated tests:
- Original-word mapping for numbers, punctuation, contractions and Unicode.
- Token-limit splitting without lost/duplicated text.
- Duration/sample conversion, DSP offsets and bounded monotonic alignment.
- Stale results after seek, edit, voice change and book switch.
- Pause during buffering does not resume when inference finishes.
- No queued speech beyond an unresolved action.
- Trigger delivery despite skipped render frames.
- Interrupted installation, integrity failure, quota failure and shared removal.
- Ordinary app update preserves installed compatible packs.
- Silent reader behavior, persistence and navigation regressions.

Production-browser tests:
- Install, close, disable all networking, reopen and synthesize saved text.
- Repeat offline with pitch, speed, seek and every reader view.
- Verify no runtime/voice asset network dependency after installation.
- Repeat under Pages subpath.
- Background, resume, audio-context interruption and GPU failure.
- Thirty-minute session without cumulative alignment drift or unbounded memory.

Device matrix: desktop Chrome/Edge, Android Chrome, iPhone Safari/PWA and Firefox
WASM. Report first-audio latency, sustained generation time, peak memory where
available, underruns and manual listening/alignment results.

Include a fixed passage at approximately 600 observed WPM using relative speed.
Record which devices sustain it. This is a benchmark, never a target-WPM control.
Set quantitative word-onset acceptance bounds after the feasibility measurement;
record the chosen bounds before marking the feature ready for review.

## Current execution blocker

The implementation workspace could access GitHub through the connector, but
direct GitHub fetch and npm registry access timed out. Kokoro and ONNX Runtime
were not installed locally. Consequently no synthesis, alignment, pitch or
offline-runtime claim has been validated by this PR. This specification records
the agreed scope; it is not a functioning audio feature.

## References

- https://github.com/hexgrad/kokoro/blob/main/kokoro/model.py
- https://github.com/hexgrad/kokoro/blob/main/kokoro.js/src/kokoro.js
- https://github.com/hexgrad/kokoro/blob/main/kokoro.js/README.md
- https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/onnx
- https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
- https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
