/** Optional Safari API: spoken audio should use media playback routing. */
export function requestPlaybackSession(target: { audioSession?: { type: string } }): void {
  try { if (target.audioSession) target.audioSession.type = "playback"; }
  catch { /* Unsupported implementations must not prevent playback. */ }
}

/** Some WebKit versions leave resume() pending indefinitely. */
export async function awaitAudioStartup(startup: Promise<unknown>, describe: () => string, timeout = 8000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([startup, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Audio startup timed out (${describe()}). Try opening Speedreader in a Safari tab and press Play again.`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}
