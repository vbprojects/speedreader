# iOS termination acceptance

Status: **not executed on iOS** in this delivery. The included Linux Chromium
SIGKILL report and desktop WebKit acceptance report cover different environments.
A desktop WebKit pass is not evidence of iOS process-kill durability.

## Prepare a dedicated fixture

From the patched checkout's `frontend` directory:

```sh
node experiments/published-storage-resilience/build.mjs
```

Serve `experiments/published-storage-resilience/dist` on a dedicated HTTPS test
origin accessible from the device. The harness registers its own service worker
and uses the separate `speedreader-crash-fixture` database. Do not deploy it over
the application's origin or service-worker scope. It imports the production
protocol, bridge, parent controller and storage implementation; none of its
transaction-holding instrumentation is present in the application build.

Open the fixture on an iPhone/iPad, let it cache, reload once, then disable network
access and verify it still opens. Repeat in Safari and as a separately installed
Home Screen web app. For a WKWebView/Tauri iOS distribution, load this fixture in
a dedicated test build using the same persistent data store as that distribution.
Do not use a private/ephemeral browser data store for a persistence claim.

## Kill at each boundary

For each trial, select **Prepare baseline**, verify that both `local.slot` and
`session.history` show `before`, then select one boundary button. Wait until the
phase display matches the selected boundary. Terminate the actual test app process
and relaunch it with the same profile/origin; do not navigate back, reload, or close
the page as the termination step. On a physical device use an actual force quit
of the selected Safari/test-app process, and record the exact action. For a
simulator or debug test app, use the platform's process termination mechanism and
record the process/bundle identifier. Include a separate OS memory-pressure/jetsam
trial where that tooling is available; a user force quit is not a jetsam test.

| Visible boundary | Instrumentation | Expected after relaunch |
| --- | --- | --- |
| `before-submit` | Controller has a delta, but database call has not started | Both values `before` |
| `during-transaction` | Real row writes have been staged; a test-only IDB request chain prevents commit | Both values `before` |
| `committed-before-ack` | Production commit completed; test wrapper withholds completion from controller | Both values `after` |
| `after-ack` | The bridge received the controller's acknowledgement | Both values `after` |

The transaction hold expires after 60 seconds to prevent an accidentally abandoned
fixture consuming resources indefinitely. If `hold-expired-repeat-test` appears,
discard that trial and prepare again.

Run at least ten trials per boundary per target configuration, including the
oldest supported OS/device and a low-free-space device. Repeat foreground and
background transitions and offline relaunch. Record browser/app and OS build,
hardware, free space, persistence permission state, boundary, kill method,
recovered values/revision, and any crash/OS logs in the template below. Do not put
real story content into public test artifacts.

After the fixture matrix, run the production acceptance flow with representative
large saves: passage navigation, named slot save/load, restart while a save is
pending, immediate Library navigation, explicit storage-quota failure, and two
sessions competing for one story. Confirm the recovery export can be imported
and that denied persistence permission leaves existing saves unchanged.

## Interpret the result correctly

An uninstrumented kill **before acknowledgement** may recover either the old
transaction or the completed new transaction: a commit can succeed before its ACK
reaches the frame. A partial combination of the two areas is always a failure.
The four held boundaries above make each fixture expectation deterministic.
After a received ACK, the complete new state must reopen under the tested storage
conditions. Even strict IndexedDB durability is not a promise against storage
hardware failure, cleared site data, device loss, or every OS/browser eviction.
The application deliberately does not depend on `pagehide` or `beforeunload`
completing asynchronous work.

Desktop reproduction (requires a real Chromium executable and Python Playwright):

```sh
python experiments/published-storage-resilience/process_kill.py \
  --chromium /path/to/chromium --iterations 3 --output process-kill-results.json
```
