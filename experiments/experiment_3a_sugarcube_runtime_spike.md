# Experiment 3a — SugarCube Runtime Host Spike

## Decision this spike must make

Determine whether Speedreader can reliably:

1. execute a published story's bundled SugarCube 2 runtime in an offscreen iframe;
2. observe stable rendered passage output;
3. drive story controls through DOM events;
4. save, destroy, recreate, and restore the runtime; and
5. do all four in the browser/PWA and Tauri webviews.

The spike is successful if those boundaries work. It does not need to implement library persistence, production UI, a complete DOM projector, or every SugarCube control.

Timebox the spike to roughly two engineering days. If a blocking platform problem remains after the timebox, record it and make a go/conditional-go/no-go decision rather than expanding the spike into the production feature.

## Working hypothesis

A published Twine story is a complete HTML application containing both `<tw-storydata>` and its story-format runtime. SugarCube exposes a rendered passage DOM and documented lifecycle events such as `:storyready`, `:passagedisplay`, and `:passageend`. Its save APIs can serialize the active story state. See the [Twine HTML output specification](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-htmloutput-spec.md) and [SugarCube documentation](https://www.motoslave.net/sugarcube/2/docs/).

The expected host design is:

```text
stored published HTML
  -> same-origin offscreen iframe
  -> bundled SugarCube starts normally
  -> host reads #passages .passage
  -> host assigns action IDs to live controls
  -> spike activates controls with DOM events
  -> SugarCube renders/mutates the next state
  -> host records a new stable snapshot
```

The iframe separates SugarCube's document, IDs, styles, and globals from React. It is not intended to prevent imported code from reaching the host application.

## Known repository constraint

The current policies block this experiment:

- `frontend/index.html` sets `frame-src 'none'`.
- `frontend/src-tauri/tauri.conf.json` sets `frame-src 'none'` in both development and production.
- Tauri production also sets `script-src 'self'`, while a compiled SugarCube story normally contains inline code and may use evaluated JavaScript.

The spike must identify the smallest reliable policy change rather than assuming `iframe.srcdoc` will work.

Test these loading strategies in order:

1. **Same-origin Blob URL — preferred.** Create a `Blob` from the published HTML, load it through `URL.createObjectURL()`, and allow `frame-src blob:` in the parent. Determine whether the child document may execute its own inline/evaluated runtime without loosening the parent application's `script-src`.
2. **`srcdoc`.** Test whether the child inherits the parent CSP and therefore requires application-wide `unsafe-inline`/`unsafe-eval`.
3. **Dedicated Tauri/web route.** If Blob behavior differs across webviews, test a separate runtime document URL or webview whose policy is independent of the main application.

Revoke Blob URLs during teardown. Record browser console CSP violations for each strategy.

## Questions to investigate

### P0 — Blocking questions

#### 1. Can the bundled runtime start?

- Does the compiled story execute from Blob URL and/or `srcdoc`?
- Are inline scripts, `eval`, workers, or dynamic styles blocked?
- Does SugarCube require a meaningful document URL, origin storage, or base URL?
- Does an offscreen iframe behave differently from a visible iframe?
- Does the story reach a stable `Engine.isIdle()` state with an active passage?

Required evidence: a diagnostic record containing runtime version, current passage, `State.turns`, active DOM selector, startup duration, and console errors.

#### 2. What is the reliable readiness and render signal?

- Can the host attach early enough to observe `:storyready`?
- If the handler attaches after iframe `load`, is the initial active passage already stable?
- Which event is best for projection: `:passagedisplay`, `:passageend`, an idle-state check, or a debounced combination?
- What event order is observed during initial startup, navigation, restore, and same-passage mutation?
- Do event property shapes differ around SugarCube 2.37, where several details moved under `event.detail`?

Required evidence: an ordered event trace with timestamps and snapshot hashes.

#### 3. Can Speedreader drive real story actions?

- Can a normal `[[link]]`, setter link, and `<<button>>` be activated with `.click()`?
- Can text, checkbox, radio, and select controls be driven by setting their DOM property and dispatching `input`/`change`?
- Do jQuery handlers, custom macros, and Story JavaScript receive those synthetic events normally?
- Which controls require a full pointer/mouse event sequence rather than `.click()`?
- How are stale controls detected after SugarCube replaces the passage DOM?

Required evidence: action logs showing the control, dispatched events, resulting variables, resulting passage/DOM, and settle time.

#### 4. Can state be saved and restored independently of the iframe?

- Does `Save.base64.save()` return a stable usable payload in the host environment?
- Can `Save.base64.load()` run after startup, followed by `Engine.show()`, and restore passage, variables, and history?
- Do older runtimes work through feature-detected `Save.serialize()` / `Save.deserialize()`?
- Does a newly generated Blob URL affect story identity or save compatibility?
- What happens to a pending text field or same-passage DOM mutation that has not created a SugarCube history moment?
- Does restore trigger enough events to rebuild the active native interactions?

Required evidence: destroy the iframe completely, create a new one from the same HTML, load the save, and compare passage, variables, history position, rendered snapshot, and controls.

#### 5. Does the approach work in each required runtime?

Test at minimum:

- Chromium through `npm run dev`;
- the production Vite build served locally;
- Tauri development;
- one packaged or production-policy Tauri run;
- Safari/WebKit if PWA or Apple targets are in the immediate release scope.

Do not infer production behavior from Tauri development: the repository has different `devCsp` and production `csp` values.

### P1 — Compatibility-shaping questions

#### 6. Can rendered DOM be projected deterministically?

- Which subtree consistently represents only the active passage?
- How should hidden, `aria-hidden`, script, style, SVG, canvas, and UI-only nodes be excluded?
- Does normalized `textContent` preserve adequate paragraph/list boundaries?
- Can controls receive stable IDs derived from turn, passage, DOM path, and control semantics?
- Does projecting the same stable DOM twice yield the same snapshot and action IDs?

The spike only needs a diagnostic projection: ordered text blocks plus a control inventory. It does not need to create final `WordStream` objects.

#### 7. How should DOM stability be detected?

- How many mutation batches occur after `:passagedisplay` and `:passageend`?
- Are microtask + animation-frame settling sufficient?
- Do `<<timed>>`, `<<type>>`, transitions, or Story JavaScript continue mutating later?
- Can the host use “no relevant mutations for N ms while Engine is idle” without adding noticeable latency?
- Which mutations can be ignored, such as class/style-only changes?

Record the mutation count, last relevant mutation time, and final snapshot hash for each action.

#### 8. What happens without passage navigation?

Investigate:

- `<<linkappend>>`;
- `<<linkreplace>>`;
- `<<cycle>>` or listbox changes;
- checkbox/radio state;
- a custom widget that replaces existing prose;
- a timer that reveals content.

Classify each as append-only, interaction-only, destructive rewrite, or not representable by the current stream model. The output is a compatibility table, not a production fix.

#### 9. How does SugarCube history interact with the cached stream?

- What DOM/events result from `Engine.backward()`, `Engine.forward()`, and `Engine.goTo()`?
- Can passage/turn identity distinguish a revisit from history navigation?
- Does going back require truncating the derived stream, creating a new playthrough branch, or simply moving the reading position?

History editing may remain out of scope, but the spike should show whether it can be detected reliably.

### P2 — Useful follow-ups

- Behavior of dialogs, save UI, StoryCaption controls, and custom `StoryInterface` markup.
- External images/audio and relative asset URLs when the story is loaded from a Blob URL.
- Stories that open popups, navigate `window.top`, reload, or call fullscreen APIs.
- CPU behavior for timers while the iframe is offscreen.
- Multiple runtime hosts open simultaneously.
- Earliest SugarCube 2 version worth supporting.

These do not block the initial go decision unless a real target story depends on them.

## Spike fixture

Create one small authored Twee story and compile it into published SugarCube HTML. Check in the authored source, compiled fixture, SugarCube version, build command, and required license notice.

The fixture should contain:

- `StoryInit` setting `$name`, `$score`, and `$visits`;
- Story JavaScript registering one simple custom macro;
- a Start passage with ordinary prose and two passage links;
- a setter link that changes `$score` before navigation;
- conditional and printed text in the destination passage;
- `<<textbox>>`, checkbox/radio, select/listbox, and submit button controls;
- `<<linkappend>>` and `<<linkreplace>>` examples;
- a custom widget that changes the DOM;
- a short `<<timed>>` or `<<type>>` example;
- a passage that revisits an earlier passage;
- an ending passage;
- enough state to verify save/restore and history navigation.

If the current stable SugarCube fixture succeeds, compile the same source against the oldest runtime the feature intends to support. SugarCube 2.31 is a useful investigation baseline because `:storyready` exists there, while legacy serialization is still available for versions without the newer base64 API.

## Harness

Add a disposable browser harness under:

```text
frontend/experiments/sugarcube-runtime-spike/
  index.html
  main.ts
  fixture.twee
  fixture-current.html
  fixture-legacy.html        optional after current succeeds
  results.md
```

The harness should provide:

- runtime strategy selector: Blob URL, `srcdoc`, or dedicated route;
- visible/offscreen iframe toggle;
- load, teardown, save, restore, backward, and forward buttons;
- active passage DOM preview;
- projected text-block and control inventory;
- buttons for activating each discovered control;
- event and mutation timeline;
- snapshot hash and duplicate counter;
- runtime/API/version capability report;
- exportable JSON diagnostics.

For Tauri, expose the same harness behind a temporary query flag such as `?sugarcube-spike=1` so it runs in the exact application webview and CSP. Keep it out of normal navigation and remove the hook after the spike unless it becomes a maintained conformance tool.

Do not put IndexedDB, `LibraryStore`, or the real reader UI into the spike. Use an in-memory save string and diagnostic projection so failures remain attributable to the runtime boundary.

## Execution plan

### Phase A — Fixture and loader

1. Build the current-version published fixture.
2. Add the harness and basic iframe lifecycle.
3. Try Blob, `srcdoc`, and—only if needed—dedicated-route loading.
4. Record the minimal web and Tauri CSP changes.
5. Prove teardown removes the iframe, observers, event handlers, timers owned by the host, and Blob URL.

Stop condition: if the runtime cannot reach a stable first passage in Chromium and Tauri production policy, document the platform failure before continuing.

### Phase B — Lifecycle and action bridge

1. Capture startup and passage event sequences.
2. Add debounced mutation observation.
3. Inventory links/buttons/inputs.
4. Activate each control through DOM APIs.
5. Record resulting variables, passage, DOM, and event timing.

Stop condition: if ordinary navigation and form controls cannot be activated without macro-specific logic, reassess the runtime-bridge design.

### Phase C — Save/restore

1. Progress several turns and modify variables/inputs.
2. Produce an opaque SugarCube save.
3. Destroy the host completely.
4. Recreate it from the same HTML.
5. Load the save after startup and render the restored state.
6. Compare the before/after diagnostic record.
7. Repeat at a pending-control boundary and after a same-passage mutation.

Stop condition: if passage variables/history cannot survive host recreation, production integration should not begin.

### Phase D — Platform and edge matrix

1. Repeat the golden path in browser dev, browser production, Tauri dev, and Tauri production.
2. Exercise append, replace, timer, custom widget, revisit, and history cases.
3. Run the legacy runtime fixture if it is within the desired support range.
4. Fill the compatibility and decision tables in `results.md`.

## Measurements

Record these for each environment and loading strategy:

| Measurement | Purpose |
|---|---|
| Startup-to-ready milliseconds | Detect unusable host overhead or readiness races |
| Ready event observed | Decide event versus post-load polling |
| Passage event order | Choose the projection hook |
| Relevant mutations per action | Choose a settling strategy |
| Action-to-stable-snapshot milliseconds | Estimate reader interaction latency |
| Snapshot hash before/after duplicate events | Validate deduplication |
| Save size and save/load duration | Validate persistence practicality |
| Restored passage/turn/variables/history | Validate semantic restore |
| Active controls before/after restore | Validate bridge reconstruction |
| CSP/runtime errors | Choose the host loading policy |
| Frames/listeners remaining after teardown | Detect lifecycle leaks |

Absolute performance targets are secondary in this spike. Correctness and repeatability are the decision criteria.

## Go/no-go criteria

### Go

Proceed with the runtime-based ingestion engine when all are true:

- a published story reaches a stable first passage in browser and Tauri production conditions;
- the host can read the active passage DOM and produce deterministic diagnostic snapshots;
- ordinary links/buttons and basic form controls can be driven through DOM events;
- lifecycle plus mutation observation detects passage and same-passage changes without duplicates;
- an opaque save restores passage, variables, history, and current controls after full iframe destruction;
- teardown does not leave an active runtime host;
- the required CSP/configuration change is understood and documented.

### Conditional go

Proceed with explicit v1 limitations when core navigation/save works but:

- destructive same-passage rewrites cannot map to the append-only stream;
- timers or typewriter effects have ambiguous stability;
- older SugarCube versions require a narrower support floor;
- complex custom controls need direct-runtime display or a future generic interaction type;
- one non-primary platform needs follow-up work.

Each limitation must have a recognizable runtime condition and user-facing failure mode.

### No-go

Do not start production integration if any is true:

- the runtime cannot start reliably under a viable browser/Tauri loading policy;
- the host cannot obtain stable rendered output;
- activating controls requires reimplementing SugarCube macro semantics;
- saves cannot restore after complete runtime recreation;
- events and mutations cannot be deduplicated enough to prevent repeated prose/actions;
- runtime teardown is unreliable and leaves persistent activity after closing the story.

## Deliverables

The spike is complete when it produces:

1. the authored and compiled test fixture;
2. the disposable runtime harness;
3. a JSON diagnostic export from each required environment;
4. `results.md` containing the CSP findings, event traces, action matrix, save/restore comparison, DOM-mutation classification, platform matrix, and known failures;
5. a go/conditional-go/no-go decision;
6. a short list of production contract changes supported by evidence from the spike.

Do not count production ingestion code as a spike deliverable. If the result is “go,” implementation starts with the source-storage and reader-state boundary described in `experiment_3_sugarcube_ingestion.md`.
