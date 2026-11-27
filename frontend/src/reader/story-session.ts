/** Advisory coordination only. IndexedDB revisions remain the write authority. */
export type AdvisoryState = "held" | "occupied" | "unknown";
export interface StoryAdvisoryStatus {
  state: AdvisoryState;
  mechanism: "web-locks" | "broadcast" | "unavailable";
  otherSessions: number;
}
interface AdvisoryChannel {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}
export interface StoryAdvisoryEnvironment {
  id(): string;
  now(): number;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  channel?: (name: string) => AdvisoryChannel;
  requestLock?: (name: string, callback: (available: boolean) => Promise<void>) => Promise<unknown>;
}

function browserEnvironment(): StoryAdvisoryEnvironment {
  let locks: LockManager | undefined;
  try { locks = typeof navigator === "undefined" ? undefined : navigator.locks; } catch { /* No locks on this origin. */ }
  return {
    id: () => crypto.randomUUID(), now: () => performance.now(),
    setInterval: (callback, ms) => window.setInterval(callback, ms),
    clearInterval: handle => window.clearInterval(handle as number),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
    clearTimeout: handle => window.clearTimeout(handle as number),
    channel: typeof BroadcastChannel === "function" ? name => new BroadcastChannel(name) : undefined,
    requestLock: locks ? (name, callback) => locks!.request(name, { mode: "exclusive", ifAvailable: true }, lock => callback(lock !== null)) : undefined,
  };
}

export function acquireStoryAdvisory(bookId: string, onStatus: (status: StoryAdvisoryStatus) => void, env = browserEnvironment()) {
  if (!bookId || bookId.length > 256) throw new Error("Invalid story identity for session coordination.");
  let stopped = false, channel: AdvisoryChannel | undefined, interval: unknown, handshake: unknown;
  let release: (() => void) | undefined, lockState: AdvisoryState = "unknown", lockWorking = false;
  let readyResolved = false;
  let settle!: (state: AdvisoryState) => void;
  const ready = new Promise<AdvisoryState>(resolve => { settle = resolve; });
  const id = env.id();
  if (!id || id.length > 128) throw new Error("Invalid session identity for session coordination.");
  const peers = new Map<string, number>();
  const resolveReady = (state: AdvisoryState) => { if (!readyResolved) { readyResolved = true; settle(state); } };
  function report() {
    if (stopped) return;
    const state = lockWorking ? lockState : peers.size ? "occupied" : "unknown";
    onStatus({ state, mechanism: lockWorking ? "web-locks" : channel ? "broadcast" : "unavailable", otherSessions: peers.size });
  }
  const send = (type: "hello" | "presence" | "bye") => {
    try { channel?.postMessage({ protocol: "speedreader-session", version: 1, type, id }); } catch { /* Hints must not break saves. */ }
  };
  function fallback() {
    if (stopped) { resolveReady("unknown"); return; }
    lockWorking = false; report();
    // Hints have no exclusivity guarantee, even after a quiet handshake window.
    if (channel) handshake = env.setTimeout(() => {
      handshake = undefined; resolveReady(peers.size ? "occupied" : "unknown");
    }, 200);
    else resolveReady("unknown");
  }
  try {
    channel = env.channel?.(`speedreader:published:${bookId}`);
    if (channel) {
      channel.onmessage = ({ data }) => {
        if (stopped || !data || typeof data !== "object" || Array.isArray(data)) return;
        const message = data as Record<string, unknown>;
        if (message.protocol !== "speedreader-session" || message.version !== 1 || typeof message.id !== "string" || message.id.length < 1 || message.id.length > 128 || message.id === id) return;
        if (message.type === "bye") peers.delete(message.id);
        else if (message.type === "hello" || message.type === "presence") {
          // Bound hostile same-origin hints; no payload or story data is relayed.
          if (peers.has(message.id) || peers.size < 32) peers.set(message.id, env.now());
          if (message.type === "hello") send("presence");
        } else return;
        report();
      };
      send("hello");
      interval = env.setInterval(() => {
        const now = env.now();
        for (const [peer, lastSeen] of peers) if (now - lastSeen > 20000 || now < lastSeen) peers.delete(peer);
        send("presence"); report();
      }, 5000);
    }
  } catch {
    if (interval !== undefined) env.clearInterval(interval);
    try { channel?.close(); } catch { /* Optional coordination is unavailable. */ }
    channel = undefined;
  }
  if (env.requestLock) {
    try {
      void env.requestLock(`speedreader:published:${bookId}`, async available => {
        if (stopped) { resolveReady("unknown"); return; }
        lockWorking = true; lockState = available ? "held" : "occupied";
        report(); resolveReady(lockState);
        if (available) await new Promise<void>(resolve => { release = resolve; });
      }).catch(fallback);
    } catch { fallback(); }
  } else fallback();
  return {
    ready,
    stop() {
      if (stopped) return;
      send("bye"); stopped = true;
      if (interval !== undefined) env.clearInterval(interval);
      if (handshake !== undefined) env.clearTimeout(handshake);
      if (channel) { channel.onmessage = null; channel.close(); }
      release?.(); peers.clear(); resolveReady("unknown");
    },
  };
}
