# Published SugarCube save resilience

This change bounds the emulated storage and the frame/parent protocol, persists
changed keys atomically, and adds recovery controls for failed or conflicting
sessions. It preserves the published runtime's opaque-origin sandbox and opaque
UTF-16 save strings.

## Defaults and persistence contract

| Scope | Limit |
| --- | ---: |
| Local storage per story | 5 MiB logical |
| Session storage per story | 5 MiB logical |
| Keys per area | 1,024 |
| Key length | 2,048 UTF-16 code units |
| Entry accounting | `64 + 2 * (key.length + value.length)` |
| Published saves across the origin | 128 MiB logical |
| Mobile recovery file / decoded state | 64 MiB each |

A failed `setItem` throws `QuotaExceededError` before changing the prior value or
key ordering. The origin budget includes legacy saves and never automatically
evicts them. This logical budget covers published saves; imported sources,
assets, caches and other data still consume browser storage separately. The UI
shows browser estimates and requests persistence only after a user click.

Schema version 4 adds `publishedStorage`, `publishedUsage` and `publishedBudget`.
Changed rows, ordering metadata, shared revision and accounting commit in one
transaction. Source identity, expected revision, quota and delta consistency are
checked inside that transaction. Unchanged keys are not rewritten; full bounded
baseline reads remain deliberate independent validation. Generic reader-state
updates preserve an unchanged published manifest and cannot bypass revision
fencing. Reset/cascade removes the associated rows and accounting atomically.

The bridge coalesces mutations from a fixed 75 ms deadline, with a 250 ms minimum
ordinary send interval and one ordinary batch awaiting acknowledgement. It keeps
bounded current/acknowledged/in-flight state, not an operation journal. Visibility
flushes have a limited urgent bypass. Library navigation drains saves; SugarCube
restart sends one final delta synchronously before its immediate reload.

The parent acknowledges only completed transactions and retries uncertain writes
with the same operation UUID. A competing revision pauses the session instead of
silently overwriting or merging another session's save. Advisory Web Locks and
bounded BroadcastChannel hints improve the normal experience but do not replace
database CAS. Conflicting sessions can export their current in-memory candidate.

`strict` IndexedDB durability is requested where supported. Async unload is not
part of the durability guarantee, and permission grants are not backups against
device loss or cleared site data.

## Large values

`results/storage-profile.json` and `.md` record the original Linux profile using
synthetic large states and the pinned fixture's LZString routine. The fixture and
codec are unchanged by the subsequent library-import UI update.

Only values of at least 16,384 code units are considered for exact prefix/suffix
patches, and only when the patch saves at least 25% and 1 KiB. Other values use
full replacement. The parent validates expanded sizes before reconstruction.
Database values remain complete strings: this reduces transport payload, not the
bytes written for a changed IndexedDB value. There is no persistent patch chain
or runtime gzip dependency. The profile is not a mobile benchmark.

Reproduce from `frontend`:

```sh
node --import tsx experiments/sugarcube-runtime-spike/storage-profile.mts \
  experiments/sugarcube-runtime-spike/fixture-current.html \
  experiments/published-storage-resilience/results/storage-profile.json
```

## Recovery

The Save storage and recovery panel distinguishes committed-data export from
current-session export. Imports validate the source hash and bounds before
preview. Replacement requires explicit selection/confirmation, freezes the old
producer, waits for an already submitted transaction, and compares the preview's
revision before writing. Stale previews and cancelled imports do not overwrite
saves. Oversized originals remain intact.

Larger exported JSON can be inspected on a desktop:

```sh
node --import tsx experiments/published-storage-resilience/recover-save.mts \
  --input original.json --source-hash EXPECTED_SHA256 --list
node --import tsx experiments/published-storage-resilience/recover-save.mts \
  --input original.json --source-hash EXPECTED_SHA256 \
  --output selected.json --keep local:0 --keep session:2
```

The CLI requires an existing export/profile extraction; it cannot read a mobile
browser's IndexedDB directly. It prints keys/sizes without values, preserves
original ordering and strings, and never overwrites an output file. Input is
bounded to 128 MiB by default, explicitly configurable up to 512 MiB. The chosen
output must fit runtime quotas and is imported through the normal confirmation
flow. A v2 manifest alone has no save values.

## Validation and reproduction

`results/validation.json` records checks on the PR base, including all 331 project
tests. Browser reports use synthetic fixture saves, not personal story data.

From `frontend`:

```sh
npm ci
npm run check
python experiments/sugarcube-runtime-spike/browser_acceptance.py \
  --chromium /path/to/chromium
python experiments/sugarcube-runtime-spike/browser_acceptance.py --browser webkit
python experiments/sugarcube-runtime-spike/concurrent_recovery_acceptance.py \
  --chromium /path/to/chromium
node experiments/published-storage-resilience/build.mjs
python experiments/published-storage-resilience/process_kill.py \
  --chromium /path/to/chromium --iterations 3 --output process-kill-results.json
SPEEDREADER_BASE_PATH=/speedreader/ npm run build
```

Browser tests require Python Playwright and its browser dependencies. Run the
root-path browser checks before the Pages base-path build changes `dist`.

The crash harness uses a separate fixture database on a dedicated test origin.
It exercises actual process kills before submission, during a held transaction,
after commit but before ACK, and after received ACK. Committed retries must be
idempotent and both storage areas must recover consistently. See the process-kill
report for the twelve executed desktop Chromium trials.

**Actual iOS termination is unexecuted.** Follow [DEVICE_TESTS.md](DEVICE_TESTS.md)
and record results in `ios-results.template.json` for physical Safari, Home Screen
PWA and applicable WKWebView deployments. Desktop WebKit and Chromium SIGKILL
results do not establish iOS or jetsam durability. Firefox and Tauri-specific
production acceptance were not executed either.

The existing Pages workflow runs on main pushes/manual dispatch, not PR events;
these reports describe local execution. No CI/deployment policy is changed.

## Resource boundary

The sandbox preserves origin isolation. Parent validation happens after browser
structured clone, so application limits do not prevent arbitrary script CPU or
memory exhaustion before validation. Several bounded copies can coexist; oldest
supported mobile devices still need memory/energy profiling. Very large inherited
monolithic saves require their original export/profile and desktop recovery.
