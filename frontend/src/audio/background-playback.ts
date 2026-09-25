export interface BackgroundPlaybackOptions {
  hidden(): boolean;
  shouldContinue(): boolean;
  pauseAndRelease(): void;
  returned(): void;
}
/** Hiding is distinct from navigating away; returning never autoplays. */
export function bindBackgroundPlayback(
  page: EventTarget, windowTarget: EventTarget, options: BackgroundPlaybackOptions,
): () => void {
  let wasHidden = options.hidden();
  const visibility = () => {
    if (options.hidden()) {
      wasHidden = true;
      if (!options.shouldContinue()) options.pauseAndRelease();
    } else if (wasHidden) { wasHidden = false; options.returned(); }
  };
  const exit = () => options.pauseAndRelease();
  page.addEventListener("visibilitychange", visibility);
  windowTarget.addEventListener("pagehide", exit);
  if (wasHidden && !options.shouldContinue()) options.pauseAndRelease();
  return () => {
    page.removeEventListener("visibilitychange", visibility);
    windowTarget.removeEventListener("pagehide", exit);
  };
}

export function bindSpeechMediaSession(
  session: MediaSession,
  actions: { play(): void; pause(): void },
): () => void {
  const bound: MediaSessionAction[] = [];
  for (const [action, handler] of [["play", actions.play], ["pause", actions.pause], ["stop", actions.pause]] as const) {
    try { session.setActionHandler(action, handler); bound.push(action); } catch { /* Optional platform action. */ }
  }
  return () => {
    for (const action of bound) session.setActionHandler(action, null);
    session.playbackState = "none";
    session.metadata = null;
  };
}
