import {
  applyDelta, decodeDelta, envelope, hasChanges, parseFrameMessage, StoryRevisionConflict,
  type LoadedPublished, type ParentPayload, type PublishedCommit, type Snapshot,
} from "../ingestion/sugarcube/storage-protocol";

export interface PublishedSessionStatus {
  saving: boolean;
  error: string;
  retryable: boolean;
  blocked: boolean;
}
export interface PublishedSessionOptions {
  epoch: string;
  sourceHash: string;
  initial: LoadedPublished;
  commit: (batch: PublishedCommit) => Promise<void>;
  send: (message: ReturnType<typeof envelope<ParentPayload>>) => void;
  close: () => void;
  changed: (status: PublishedSessionStatus) => void;
  started: () => void;
  drained: () => void;
  restarted: (saved: LoadedPublished) => void;
  id?: () => string;
  timeoutMs?: number;
}

/** One writer credit, plus one terminal restart batch. The database is the
 * authority: only transaction completion advances the baseline or sends ACK. */
export function createPublishedSession(options: PublishedSessionOptions) {
  type Batch = PublishedCommit & { seq: number };
  const id = options.id ?? (() => crypto.randomUUID());
  let latest = options.initial, seq = 0, pending: Batch | undefined, restartFinal: Batch | undefined;
  let writing: Promise<void> | undefined;
  let disposed = false, broken = false, conflicted = false, suspended = false;
  let exiting = false, restarting = false, didStart = false, error = "";
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const expiredExports = new Set<string>();
  let exportRequest: { id: string; resolve: (snapshot: Snapshot) => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const send = (message: ParentPayload) => { if (!disposed && !broken) options.send(envelope(options.epoch, message)); };
  const changed = () => {
    if (!disposed) options.changed({ saving: !!writing, error, retryable: !!error && !!pending && !writing && !conflicted && !broken,
      blocked: !!error || suspended || exiting || restarting || broken });
  };
  function fail(cause: unknown, protocol = false) {
    error = cause instanceof Error ? cause.message : "Could not save story progress.";
    conflicted ||= cause instanceof StoryRevisionConflict;
    if (protocol) {
      broken = true; options.close();
      if (exportRequest) { clearTimeout(exportRequest.timer); exportRequest.reject(new Error(error)); exportRequest = undefined; }
    } else send({ type: "pause" });
    changed();
  }
  function finishRestart() {
    if (disposed || broken || conflicted || error || suspended || !restarting || writing || pending) return;
    restarting = false;
    clearTimeout(drainTimer);
    if (exiting) options.drained(); else options.restarted(latest);
  }
  function flush() {
    if (disposed || broken || conflicted || suspended || writing || !pending) return;
    const batch = pending;
    error = "";
    // Promise.resolve starts the call after writing is assigned, even for a
    // synchronous test adapter. Retry preserves this exact operation UUID.
    writing = Promise.resolve().then(() => options.commit(batch)).then(() => {
      latest = { revision: batch.revision, snapshot: batch.next }; seq = batch.seq;
      pending = restartFinal; restartFinal = undefined;
      if (!disposed && !broken && !restarting) send({ type: "ack", seq });
    }).catch(cause => fail(cause)).finally(() => {
      writing = undefined; changed();
      if (!disposed && !error && !broken && !conflicted) {
        if (pending) flush();
        else if (restarting) finishRestart();
        else if (!suspended) send({ type: "resume" });
      }
    });
    changed();
  }
  function receive(input: unknown) {
    if (disposed || broken) return;
    try {
      const data = parseFrameMessage(input, options.epoch);
      if (data.type === "exported") {
        // Mobile suspension may delay a valid reply beyond the UI timeout.
        // Keep only bounded request IDs, never an unbounded queue of snapshots.
        if (expiredExports.delete(data.requestId)) return;
        if (!exportRequest || data.requestId !== exportRequest.id) throw new Error("Unexpected session export.");
        clearTimeout(exportRequest.timer); exportRequest.resolve(data.snapshot); exportRequest = undefined; return;
      }
      if (data.type === "started") {
        if (didStart) throw new Error("Repeated runtime startup message.");
        didStart = true; options.started(); return;
      }
      if (data.type === "error") { fail(new Error(data.message), true); return; }
      if (data.type === "drained") {
        if (writing || pending || restarting || data.seq !== seq || !exiting || error) throw new Error("Invalid storage drain.");
        clearTimeout(drainTimer); options.drained(); return;
      }
      if (data.type === "restart") {
        if (restarting || data.baseSeq !== (pending?.seq ?? seq)) throw new Error("Invalid restart sequence.");
        const before = pending?.next ?? latest.snapshot;
        const delta = decodeDelta(before, data.delta), next = applyDelta(before, delta);
        restarting = true;
        if (hasChanges(delta)) {
          const final = { seq: data.baseSeq + 1, expected: pending?.revision ?? latest.revision, revision: id(), sourceHash: options.sourceHash, delta, next };
          if (pending) restartFinal = final; else pending = final;
        }
        changed(); if (pending && !error) flush(); else finishRestart(); return;
      }
      if (conflicted) throw new Error("Storage mutation after revision conflict.");
      if (restarting || pending || data.seq !== seq + 1) throw new Error("Out-of-order storage batch.");
      const delta = decodeDelta(latest.snapshot, data.delta);
      if (!hasChanges(delta)) throw new Error("Empty storage batch.");
      const next = applyDelta(latest.snapshot, delta);
      pending = { seq: data.seq, expected: latest.revision, revision: id(), sourceHash: options.sourceHash, delta, next };
      if (!error) flush();
    } catch (cause) { fail(cause, true); }
  }
  return {
    receive,
    flush() { send({ type: "flush" }); },
    retry() { flush(); },
    drain() {
      if (disposed || broken || conflicted || error || exiting) return false;
      exiting = true; changed();
      if (!restarting) send({ type: "drain" });
      drainTimer = setTimeout(() => {
        fail(new Error("The story has not finished saving. Retry if offered, export this session, or leave without waiting."));
      }, options.timeoutMs ?? 10000);
      finishRestart(); return true;
    },
    async suspend() {
      suspended = true; send({ type: "pause" }); changed();
      // Prevent any further commit from starting before an explicit recovery
      // replacement; await an already submitted transaction rather than abort it.
      await writing;
    },
    resume() {
      suspended = false; changed();
      if (!error && !conflicted && !broken) {
        if (pending) flush(); else if (restarting) finishRestart(); else send({ type: "resume" });
      }
    },
    exportLive(): Promise<Snapshot> {
      if (disposed || broken) return Promise.reject(new Error("This session is no longer connected. Export its saved data instead."));
      // SugarCube reloads immediately after restart. The parent already holds
      // that terminal state, even if the new document has replaced the port.
      if (restarting) return Promise.resolve(restartFinal?.next ?? pending?.next ?? latest.snapshot);
      if (exportRequest) return Promise.reject(new Error("A session export is already in progress."));
      if (expiredExports.size >= 4) return Promise.reject(new Error("The story has not answered previous export requests. Reopen it or export saved data."));
      return new Promise((resolve, reject) => {
        const requestId = id();
        const timer = setTimeout(() => {
          expiredExports.add(requestId);
          exportRequest = undefined; reject(new Error("Session export timed out. Saved data is still available."));
        }, options.timeoutMs ?? 10000);
        exportRequest = { id: requestId, resolve, reject, timer }; send({ type: "export", requestId });
      });
    },
    dispose() {
      disposed = true; clearTimeout(drainTimer); options.close();
      if (exportRequest) { clearTimeout(exportRequest.timer); exportRequest.reject(new Error("Session closed during export.")); exportRequest = undefined; }
    },
  };
}
export type PublishedSession = ReturnType<typeof createPublishedSession>;
