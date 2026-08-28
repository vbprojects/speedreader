# SugarCube runtime spike results

Status: in progress

Last updated: 2026-08-28

## Provisional decision

**Conditional go for the runtime bridge in Chromium using a dedicated same-origin document URL.**

The official bundled SugarCube 2.37.3 runtime starts, renders authored macros and Story JavaScript, exposes its public state/save/history APIs, accepts generic DOM-driven actions, and can be projected from an offscreen iframe. A save also restores after the old iframe and its SugarCube session are both removed.

This is not a cross-platform go yet. Blob URL and `srcdoc` loading failed under the spike policy, and the Tauri development and production-policy runs are still outstanding. Native SugarCube saves also do not preserve DOM-only changes or story-variable changes made after the current history moment was created.

## Tested build

| Item | Value |
|---|---|
| Runtime | SugarCube 2.37.3+10338 |
| Runtime release archive SHA-256 | `da00a8c15ec4e88a9e231a3ff6c516c57055f84231bb999f869ed34ade353dab` |
| Compiled fixture SHA-256 | `a36770f26d141beac8fedf868675ee6149767e1a349db445f134a31ea1469d34` |
| Authored fixture SHA-256 | `51b413e6cd9f369418b087d6b873f0918793186bd5e9db642c6416b49a54eaa7` |
| Compiled fixture size | 612,861 bytes |
| Browser environment | Codex in-app Chromium against Vite development and production-preview servers |

The runtime and license provenance are recorded in `UPSTREAM.md` and `SUGARCUBE_LICENSE.txt`.

## Loader and CSP matrix

| Strategy | Result | Evidence | Interpretation |
|---|---|---|---|
| Dedicated same-origin URL | Pass | iframe `load`; `Engine.isIdle() === true`; active passage found; Story JavaScript and custom macro ran; development startup-to-ready observed between 185 ms and 256 ms | Preferred loader for the next phase |
| Same-origin Blob URL | Fail | No iframe `load` or `error` event within 8 seconds even though the spike document allows `frame-src blob:` | Needs a reproduction outside the Codex browser and console/network diagnostics; do not choose it yet |
| `iframe.srcdoc` | Fail | iframe loaded in about 23 ms, but SugarCube never appeared and readiness timed out at 8 seconds | Consistent with the child inheriting the parent's `script-src 'self'`, which blocks the published story's inline runtime |

The successful URL case is the important CSP result. The parent document uses `script-src 'self'` without `unsafe-inline` or `unsafe-eval`. The separately navigated child document still runs the published inline SugarCube bundle because it does not inherit the parent's document policy. The parent therefore needs permission to frame the runtime URL, while the main React document need not execute imported story code itself.

The harness imports the published fixture with Vite's `?url` suffix. That causes production builds to emit the complete story as a separately navigable hashed `.html` asset instead of folding it only into the host JavaScript. A production Vite build served through `vite preview` reached Start/turn 1 in 128 ms; after navigation, a controlled destroy/session-clear/recreate restored Forest/turn 2 in 108 ms. The setter link, custom widget, lifecycle trace, projection, and save bridge all behaved the same as in development.

The repository currently prevents that arrangement:

- `frontend/index.html` has `frame-src 'none'`.
- Tauri `csp` and `devCsp` both have `frame-src 'none'`.

The next platform test should change only `frame-src` to `'self'` for the dedicated runtime route and verify that Tauri does not inject the main document's script policy into the child response.

## Lifecycle trace

SugarCube lifecycle events must be observed through its jQuery event channel. A native `document.addEventListener()` listener saw `:storyready` and some history activity but missed the passage lifecycle. Registering `jQuery(document).on(...)` from Story JavaScript produced the complete trace.

Initial/resumed passage order observed on 2.37.3:

```text
:historyupdate
:passageinit
:passagestart
:passagerender
:passagedisplay
:passageend
:storyready
```

Ordinary navigation order observed:

```text
:passageinit
:historyupdate
:passagestart
:passagerender
:passagedisplay
:passageend
```

The whole sequence completed within roughly 2 ms in the small fixture. A `MutationObserver` still remains necessary: `<<timed 100ms>>` modified the passage about 100 ms after `:passageend`, changing the projection hash from `183a85b8` to `760809e3` in one later relevant mutation batch.

Recommended production signal: use `:passageend` as the immediate semantic signal, then publish snapshots only after `Engine.isIdle()` and a short relevant-mutation quiet period. Keep the observer active for later same-passage changes.

## Action bridge matrix

| Fixture behavior | Host operation | Result |
|---|---|---|
| Ordinary/setter passage link | `HTMLElement.click()` | Pass; destination rendered and `$score` changed before navigation |
| Custom macro | Render normally in bundled runtime | Pass; custom badge/widget appeared in projected DOM |
| Textbox | Set `.value`, dispatch `input` and `change` | Pass; `$name` became `Codex Reader` |
| Checkbox | `.click()` | Pass; `$agreed` became `true` |
| Radio | `.click()` | Pass; `$route` became `south` |
| Listbox | Change selected index, dispatch `input` and `change` | Pass; `$mood` became `curious` |
| `<<linkappend>>` | `.click()` | Pass; prose appended, action disappeared, turn remained unchanged |
| `<<linkreplace>>` | `.click()` | Pass; control was replaced by prose, turn remained unchanged |
| `<<cycle>>` | `.click()` | Pass; label and `$mood` changed from `curious` to `bold`, turn remained unchanged |
| `<<timed 100ms>>` | No host action | Pass; later mutation produced a new projected snapshot |

The bridge did not need macro-specific behavior. It retained live element references, rejected disconnected elements as stale, and rebuilt action descriptors after every passage or relevant mutation.

Cross-realm detail: runtime elements cannot be classified with parent-realm `instanceof HTMLInputElement`. The harness uses `tagName` and child-element properties instead.

## Projection and identity

The active subtree `#passages .passage:last-child` consistently represented the current passage in the fixture. The diagnostic projector excludes script/style/media/hidden content, normalizes text whitespace, and inventories `a`, `button`, `input`, `textarea`, and `select` elements.

Action IDs currently use:

```text
turn-{State.turns}:{State.passage}:control-{DOM order}
```

That is sufficient for the spike but not a durable production identity. A destructive same-passage rewrite renumbers later controls. Production should treat action IDs as capabilities scoped to one snapshot hash, reject stale hashes, and regenerate the action list after every accepted action.

The diagnostic duplicate counter rose because the harness intentionally samples at action +0/+120/+400 ms in addition to mutation settling. The hashes were identical for the redundant samples. Production should hash and suppress identical publications instead of treating each lifecycle callback as new prose.

## Save, session, and history results

The 2.37.3 `Save.base64.save()` API produced a 436-character payload in the first four-turn run.

Controlled recreation test:

1. Save a five-turn playthrough.
2. Clear `SugarCube.session` so automatic session recovery cannot mask the result.
3. Remove the iframe and observer.
4. Create a new iframe from the same fixture URL.
5. Observe a fresh Start passage at turn 1.
6. Call `Save.base64.load(payload)` and then `Engine.show()`.
7. Observe the saved Start passage at turn 5, with its variables, controls, and history restored.

The same procedure restored an eight-turn save directly from fresh Start/turn 1 to Mutations/turn 8. `Engine.backward()` and `Engine.forward()` both returned `true`, rendered the expected passages, emitted lifecycle events, and were detected by the projector.

SugarCube automatically persists a playthrough session to session storage when it creates a history moment. Recreating the same-origin iframe without clearing `SugarCube.session` resumed the old passage before the explicit save was loaded. If Speedreader owns persistence, it must deliberately clear or namespace this session behavior; otherwise iframe recreation is not a clean lifecycle boundary and stories with colliding save IDs may interfere.

### Important restore limitation

SugarCube history moments are created only by passage navigation. The spike changed `$mood` from `curious` to `bold` with `<<cycle>>`, saved on the same turn, cleared the native session, recreated the runtime, and loaded the save. The restored passage/turn/history were correct, but `$mood` and the cycle label returned to `curious`. `<<linkappend>>`/`<<linkreplace>>` DOM changes also returned to their passage-entry form.

This matches SugarCube's history model: the serialized save contains history moments, while no new moment is created for in-passage interaction. The production contract must choose one of these behaviors:

1. document that reopening resumes the most recent passage-entry state;
2. capture a separate Speedreader interaction journal and replay generic actions after loading the SugarCube save; or
3. use a carefully validated SugarCube-specific checkpoint technique, if one exists, without creating author-visible extra turns or rerunning passage side effects.

Option 2 is the strongest current candidate, but it needs another spike case for non-idempotent actions and timers before adoption.

## Teardown

The harness disconnects its mutation observer, clears its settle timer and action map, removes the iframe, and revokes Blob URLs. Manual teardown left zero runtime iframes in the document and changed all diagnostic panels to `Not loaded`.

The child runtime's timers disappear with the document. A longer CPU/listener leak test remains outstanding.

## Remaining blocking work

- Run the dedicated URL strategy in Tauri development after a narrowly scoped `frame-src 'self'` change.
- Run a built/production-policy Tauri bundle; do not infer it from `devCsp`.
- Reproduce the Blob failure in ordinary Chrome and capture CSP/network console output.
- Decide whether Safari/WebKit is in the first release matrix.
- Investigate exact mid-passage checkpoint semantics and interaction replay.
- Add a second runtime version if the supported floor is older than 2.37.

## Evidence-backed production direction so far

Use a dedicated runtime document URL rather than `srcdoc`. Keep the imported story in its own document, allow the parent to frame only that route, attach lifecycle listeners using the runtime's jQuery event system, retain a debounced mutation observer, and address actions through snapshot-scoped live DOM capabilities. Treat SugarCube's Base64 save as the authoritative turn-history payload, with a separately designed policy for same-passage interaction state.

Official references:

- [SugarCube 2 documentation](https://www.motoslave.net/sugarcube/2/docs/)
- [SugarCube state, sessions, and saving guide](https://www.motoslave.net/sugarcube/2/docs/#guide-tips-state-sessions-and-saving)
- [Twine 2 HTML output specification](https://github.com/iftechfoundation/twine-specs/blob/master/twine-2-htmloutput-spec.md)
