import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { LibraryStore } from "../library/store";
import { protectReaderSession } from "../pwa-update";
import { LegacyStorageError, PROTOCOL_VERSION, type Snapshot } from "../ingestion/sugarcube/storage-protocol";
import { createPublishedSession, type PublishedSession, type PublishedSessionStatus } from "./published-session";
import { PublishedStorageTools } from "./PublishedStorageTools";
import { acquireStoryAdvisory, type StoryAdvisoryStatus } from "./story-session";

const initialStatus: PublishedSessionStatus = { saving: false, error: "", retryable: false, blocked: false };

export function PublishedStory({ bookId, library, onBack }: { bookId: string; library: LibraryStore; onBack: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(initialStatus);
  const [leaving, setLeaving] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const [sourceHash, setSourceHash] = useState<string>();
  const [advisory, setAdvisory] = useState<StoryAdvisoryStatus>();
  const [occupied, setOccupied] = useState(false);
  const [concurrentBook, setConcurrentBook] = useState<string>();
  const allowConcurrent = concurrentBook === bookId;
  const [generation, setGeneration] = useState(0);
  const [connected, setConnected] = useState(false);
  const session = useRef<PublishedSession | undefined>(undefined);
  const back = useRef<() => void>(() => {});
  const onBackRef = useRef(onBack);
  useEffect(() => { onBackRef.current = onBack; }, [onBack]);
  useEffect(() => protectReaderSession(), []);
  useEffect(() => {
    let active = true;
    let frame: HTMLIFrameElement | undefined, port: MessagePort | undefined;
    let connect: ((event: MessageEvent) => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let currentStatus = initialStatus;
    setStatus(initialStatus); setLeaving(false); setRecovery(false); setConnected(false); setOccupied(false); setSourceHash(undefined);
    function changed(next: PublishedSessionStatus) {
      currentStatus = next;
      if (next.error) clearTimeout(timeout);
      if (active) { setStatus(next); if (frame) frame.inert = next.blocked; }
    }
    const lock = acquireStoryAdvisory(bookId, state => { if (active) setAdvisory(state); });
    back.current = () => {
      if (currentStatus.error) {
        if (window.confirm("Leave without waiting for the latest progress? Export this session first if you want to keep unsaved changes. A transaction already submitted may still finish.")) onBackRef.current();
      } else if (!session.current) onBackRef.current();
      else if (session.current.drain()) setLeaving(true);
    };
    function visibility() { if (document.visibilityState === "hidden") session.current?.flush(); }
    function pagehide() { session.current?.flush(); }
    document.addEventListener("visibilitychange", visibility); window.addEventListener("pagehide", pagehide);
    async function launch() {
      const source = await library.getSugarCubeSource(bookId);
      if (!active) return;
      if (!source) throw new Error("Story source is missing.");
      setSourceHash(source.sourceHash);
      if (await lock.ready === "occupied" && !allowConcurrent) { if (active) setOccupied(true); return; }
      if (!active) return;
      let saved = await library.loadPublishedStorage(bookId, source.sourceHash);
      if (!active) return;
      frame = document.createElement("iframe"); frame.title = source.story.title;
      const url = import.meta.env.PROD && "__TAURI_INTERNALS__" in window
        ? convertFileSrc("host", "story-runtime") : import.meta.env.BASE_URL + "sugarcube-host.html";
      const host = new URL(url, document.baseURI);
      const origin = host.origin === "null" ? host.protocol + "//" + host.host : host.origin;
      frame.allow = "autoplay; fullscreen";
      frame.style.cssText = "width:100%;height:100%;border:0;background:white";
      function startTimeout() {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
          session.current?.dispose(); session.current = undefined; port?.close();
          if (active) { setConnected(false); changed({ saving: false, error: "The published runtime did not start. Check this browser’s frame and script policies.", retryable: false, blocked: true }); }
        }, 15000);
      }
      connect = event => {
        if (!active || port || event.source !== frame?.contentWindow || event.origin !== origin || event.data !== "speedreader:story-host" || event.ports.length) return;
        const channel = new MessageChannel(), thisPort = channel.port1, epoch = crypto.randomUUID();
        port = thisPort;
        const writer = createPublishedSession({
          epoch, sourceHash: source.sourceHash, initial: saved,
          commit: batch => library.commitPublishedStorage(bookId, batch),
          send: message => thisPort.postMessage(message), close: () => thisPort.close(), changed,
          started: () => { clearTimeout(timeout); if (active) setConnected(true); },
          drained: () => { if (active) onBackRef.current(); },
          restarted: latest => {
            if (!active || thisPort !== port) return;
            saved = latest; writer.dispose(); session.current = undefined; port = undefined;
            setConnected(false); if (frame) { frame.inert = false; startTimeout(); frame.src = url; }
          },
        });
        session.current = writer;
        thisPort.onmessage = event => {
          if (!active || thisPort !== port) return;
          if (event.ports.length) { writer.dispose(); changed({ saving: false, retryable: false, blocked: true, error: "Unexpected port in story message." }); return; }
          writer.receive(event.data);
        };
        thisPort.onmessageerror = () => { writer.dispose(); changed({ saving: false, retryable: false, blocked: true, error: "Story message could not be decoded." }); };
        frame?.contentWindow?.postMessage({ v: PROTOCOL_VERSION, epoch, html: source.html, assets: source.assets ?? [], entryPath: source.entryPath, ...saved.snapshot }, origin, [channel.port2]);
      };
      window.addEventListener("message", connect);
      frame.src = url; mount.current?.appendChild(frame); startTimeout();
    }
    void launch().catch(cause => {
      if (active) {
        setRecovery(cause instanceof LegacyStorageError);
        changed({ saving: false, error: cause instanceof Error ? cause.message : "Could not open this story.", retryable: false, blocked: true });
      }
    });
    return () => {
      active = false; clearTimeout(timeout);
      document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide);
      if (connect) window.removeEventListener("message", connect);
      session.current?.dispose(); session.current = undefined; port?.close(); frame?.remove(); lock.stop();
    };
  }, [library, bookId, generation, allowConcurrent]);

  async function replaceStored(snapshot: Snapshot, expected: string | null) {
    if (!sourceHash) throw new Error("Story source is missing.");
    const writer = session.current;
    await writer?.suspend();
    try {
      await library.replacePublishedStorage(bookId, { sourceHash, expected, revision: crypto.randomUUID(), snapshot });
      // Stop the old producer before the next effect starts. A queued old-port
      // message can never overwrite the explicitly imported replacement.
      writer?.dispose(); if (session.current === writer) session.current = undefined;
    } catch (cause) { writer?.resume(); throw cause; }
  }
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <header><button onClick={() => back.current()}>← Library</button>{" "}
      {(status.saving || leaving) && <span role="status">{leaving ? "Finishing saves…" : "Saving…"}</span>}</header>
    {occupied && <section role="alert" style={{ padding: ".75rem" }}>
      <p>This story is open in another tab. Close it there, then reopen here to use the latest save.</p>
      <button onClick={() => setGeneration(value => value + 1)}>Check again</button>{" "}
      <button onClick={() => setConcurrentBook(bookId)}>Continue in this tab</button>
      <p>Continuing keeps both sessions separate. A conflicting save pauses this session and offers export; it does not replace the other tab’s progress.</p>
    </section>}
    {!occupied && advisory?.state === "occupied" && <p role="status">Another tab may be reading this story. If saves conflict, export this session before reopening.</p>}
    {status.error && <p role="alert">{status.error}{" "}
      {status.retryable && <button onClick={() => session.current?.retry()}>Retry save</button>}{" "}
      <button onClick={() => {
        if (window.confirm("Reopen the last saved state? Export this session first to keep any unsaved changes.")) setGeneration(value => value + 1);
      }}>Reopen saved story</button>
    </p>}
    {recovery && <p>Open Save storage and recovery to export the original, select entries that fit, or import a compatible backup. The original save is retained until you confirm replacement.</p>}
    {sourceHash && <PublishedStorageTools key={`${bookId}:${sourceHash}:${generation}`} sourceHash={sourceHash}
      getStored={() => library.inspectPublishedRecovery(bookId, sourceHash)}
      getLive={connected ? () => session.current?.exportLive() ?? Promise.reject(new Error("The session has closed.")) : undefined}
      getBudget={() => library.getPublishedStorageUsage()} replaceStored={replaceStored}
      onImported={() => setGeneration(value => value + 1)} />}
    <div ref={mount} style={{ flex: 1, minHeight: 0 }} />
  </main>;
}
