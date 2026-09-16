/** Shared reader lease prevents a service-worker update from replacing an active
 * reader in this or another tab. Ordinary tab closure also releases Web Locks.
 */
const LOCK = "speedreader-app-reader-session";
let readers = 0;
let waitingUpdate: (() => Promise<void>) | null = null;
let activating = false;
let reloadRequested = false;
export function protectReaderSession(): () => void {
  readers++;
  let release: (() => void) | null = null;
  let released = false;
  if (navigator.locks) void navigator.locks.request(LOCK, { mode: "shared" }, async () => {
    if (released) return;
    await new Promise<void>(resolve => { release = resolve; });
  });
  return () => {
    if (released) return;
    released = true; readers--; release?.();
    void applyWaitingUpdate();
  };
}
export function deferAppUpdate(update: () => Promise<void>): void {
  waitingUpdate = update; void applyWaitingUpdate();
}
export async function applyWaitingUpdate(): Promise<void> {
  if (readers || activating || !navigator.locks || (!waitingUpdate && !reloadRequested)) return;
  await navigator.locks.request(LOCK, { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock || readers || activating) return;
    activating = true;
    try {
      if (waitingUpdate) {
        const update = waitingUpdate;
        await update();
        if (waitingUpdate === update) waitingUpdate = null;
      }
      if (reloadRequested) location.reload();
    } catch (error) {
      // Keep the pending update for a later safe boundary/network recovery.
      console.warn("Application update deferred after activation failed", error);
    } finally { activating = false; }
  });
}
export function onNewController(): void { reloadRequested = true; void applyWaitingUpdate(); }
