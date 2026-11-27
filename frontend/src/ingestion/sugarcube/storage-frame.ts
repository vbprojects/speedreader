// Dependency-free, compiled into the opaque frame alongside storage-protocol.ts.
// Type-only import erased by transpileModule. The classic wrapper injects p.
import type * as Protocol from "./storage-protocol";

export type BridgeClock = {
  now(): number;
  setTimeout(fn: () => void, delay: number): number;
  clearTimeout(id: number): void;
};

export function createStorageBridge(
  p: typeof Protocol,
  port: MessagePort,
  initial: Protocol.Snapshot,
  epoch: string,
  injectedClock?: BridgeClock,
) {
  if (!p.validToken(epoch)) throw new p.StoryProtocolError();
  // Keep independent arrays: callers cannot mutate the acknowledged baseline.
  let base = p.parseSnapshot(initial);
  const local = new p.BoundedArea(base.local), session = new p.BoundedArea(base.session);
  const clock = injectedClock ?? {
    now: performance.now.bind(performance),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
  };
  const post = port.postMessage.bind(port), closePort = port.close.bind(port);
  const send = (payload: Protocol.FramePayload) => post(p.envelope(epoch, payload));
  const snapshot = (): Protocol.Snapshot => ({ local: local.snapshot(), session: session.snapshot() });
  let flight: { seq: number; next: Protocol.Snapshot } | undefined;
  let seq = 0, timer: number | undefined, weight = 0, dirtySince: number | undefined;
  let lastSent = -Infinity, lastUrgent = -Infinity;
  let closing: "exit" | "restart" | undefined, reported = false, paused = false, disposed = false;
  const clearTimer = () => { if (timer !== undefined) clock.clearTimeout(timer); timer = undefined; };

  function schedule() {
    if (flight || reported || paused || disposed || !weight || timer !== undefined) return;
    // A fixed deadline from the first mutation avoids indefinite debounce under
    // sustained input. Large values expedite only within the same 4 Hz budget.
    const now = clock.now();
    const due = Math.max(lastSent + 250, weight >= 256 * 1024 ? now : (dirtySince ?? now) + 75);
    timer = clock.setTimeout(() => { timer = undefined; pump("normal"); }, Math.max(0, due - now));
  }
  function pump(mode: "normal" | "urgent" | "terminal") {
    clearTimer();
    if (flight || reported || paused || disposed) return;
    if (!weight && closing !== "exit") return;
    const now = clock.now();
    const urgentCredit = mode === "urgent" && now - lastUrgent >= 1000;
    if (mode !== "terminal" && now < lastSent + 250 && !urgentCredit) { schedule(); return; }
    const next = snapshot(), delta = p.diff(base, next);
    weight = 0; dirtySince = undefined;
    if (!p.hasChanges(delta)) {
      if (closing === "exit") { reported = true; send({ type: "drained", reason: "exit", seq }); }
      return;
    }
    if (seq >= Number.MAX_SAFE_INTEGER - 1) { paused = true; send({ type: "error", message: "Storage sequence exhausted. Reopen this story." }); return; }
    flight = { seq: ++seq, next };
    lastSent = now;
    if (urgentCredit) lastUrgent = now;
    // At most current Maps + one target + one acknowledged baseline; no journal
    // of intermediate writes, and no ordinary send until this target is ACKed.
    send({ type: "delta", seq, delta: p.encodeDelta(base, next) });
  }
  function changed(n: number) {
    if (!n) return;
    const expedite = weight < 256 * 1024 && weight + n >= 256 * 1024;
    weight = Math.min(256 * 1024, weight + n);
    dirtySince ??= clock.now();
    if (expedite) clearTimer();
    schedule();
  }
  function freeze() {
    if (closing || reported || disposed) return;
    closing = "exit"; pump("terminal");
  }
  function restart() {
    if (reported || disposed) return;
    // SugarCube calls location.reload() immediately after this event. Send the
    // terminal delta synchronously, even if the ordinary credit is occupied.
    // If paused, the parent may retain this candidate for conflict export but
    // must not persist/relaunch it without resolving the failed commit.
    closing = "restart"; reported = true; clearTimer();
    const next = snapshot();
    send({ type: "restart", baseSeq: flight?.seq ?? seq, delta: p.encodeDelta(flight?.next ?? base, next) });
  }
  function checkWritable() {
    if (closing || disposed || paused) throw new DOMException(paused ? "Story saving is paused" : "Story is closing", "InvalidStateError");
  }
  port.onmessage = (event: MessageEvent<unknown>) => {
    if (event.ports.length) { for (const transferred of event.ports) transferred.close(); return; }
    const { data } = event;
    let message: Protocol.ParentMessage;
    try { message = p.parseParentMessage(data, epoch); } catch { return; }
    if (disposed) return;
    if (message.type === "ack") {
      if (!flight || message.seq !== flight.seq) return;
      base = flight.next; flight = undefined;
      if (closing === "exit") pump("terminal"); else schedule();
    } else if (message.type === "drain") freeze();
    else if (message.type === "flush") pump("urgent");
    else if (message.type === "pause") { paused = true; clearTimer(); }
    else if (message.type === "resume") {
      paused = false;
      if (closing === "exit") pump("terminal"); else schedule();
    } else if (message.type === "export") {
      // This bounded snapshot includes dirty and unacknowledged values. It is a
      // recovery candidate, never an assertion that those values reached disk.
      send({ type: "exported", requestId: message.requestId, snapshot: snapshot() });
    }
  };

  function domString(value: unknown): string {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a Symbol to a DOMString");
    return String(value);
  }
  function required(args: IArguments, count: number) {
    if (args.length < count) throw new TypeError(`Storage requires ${count} argument(s)`);
  }
  /* eslint-disable prefer-rest-params -- Preserve Storage method arity and distinguish missing from explicitly undefined arguments. */
  function storage(values: InstanceType<typeof p.BoundedArea>): Storage {
    const api: Storage = {
      get length() { return values.size; },
      key(index: number) {
        required(arguments, 1);
        // Web IDL unsigned long: truncation, modulo 2^32, NaN/Infinity => 0.
        // Unary + also rejects BigInt/Symbol, unlike Number(...).
        return values.keys()[(+index) >>> 0] ?? null;
      },
      getItem(key: string) { required(arguments, 1); return values.get(domString(key)) ?? null; },
      setItem(key: string, value: string) {
        required(arguments, 2); checkWritable();
        changed(values.set(domString(key), domString(value)));
      },
      removeItem(key: string) { required(arguments, 1); checkWritable(); changed(values.remove(domString(key))); },
      clear() { checkWritable(); changed(values.clear()); },
    };
    return new Proxy(api, {
      get(target, key, receiver) {
        if (typeof key === "string" && !(key in target)) return values.get(key);
        return Reflect.get(target, key, receiver);
      },
      has(target, key) { return key in target || (typeof key === "string" && values.has(key)); },
      set(target, key, value) {
        if (typeof key === "symbol") return Reflect.set(target, key, value);
        api.setItem(key, value); return true;
      },
      defineProperty(target, key, descriptor) {
        if (typeof key === "symbol") return Reflect.defineProperty(target, key, descriptor);
        if ("get" in descriptor || "set" in descriptor || descriptor.configurable === false || descriptor.enumerable === false || descriptor.writable === false) return false;
        api.setItem(key, descriptor.value); return true;
      },
      deleteProperty(target, key) {
        if (typeof key === "symbol") return Reflect.deleteProperty(target, key);
        api.removeItem(key); return true;
      },
      ownKeys(target) { return [...values.keys().filter(key => !(key in target)), ...Object.getOwnPropertySymbols(target)]; },
      getOwnPropertyDescriptor(target, key) {
        if (typeof key === "symbol") return Reflect.getOwnPropertyDescriptor(target, key);
        if (!(key in target) && values.has(key)) return { configurable: true, enumerable: true, writable: true, value: values.get(key) };
      },
      // A non-extensible Proxy target would invalidate named-property traps.
      preventExtensions() { return false; },
    });
  }
  /* eslint-enable prefer-rest-params */
  function dispose() {
    disposed = true; clearTimer(); port.onmessage = null; closePort();
  }
  return { local: storage(local), session: storage(session), flush: () => pump("urgent"), restart, dispose };
}
