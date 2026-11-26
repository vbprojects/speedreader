import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { LibraryStore } from "../library/store";
import { protectReaderSession } from "../pwa-update";

type Entries = [string, string][];
interface StorageSnapshot { local: Entries; session: Entries }

function isEntries(value: unknown): value is Entries {
  return Array.isArray(value) && value.every(item => Array.isArray(item) && item.length === 2
    && typeof item[0] === "string" && typeof item[1] === "string");
}
function snapshot(value: unknown): StorageSnapshot {
  if (!value || typeof value !== "object" || !("local" in value) || !("session" in value)
    || !isEntries(value.local) || !isEntries(value.session)) throw new Error("Invalid SugarCube storage snapshot.");
  return { local: value.local, session: value.session };
}

export function PublishedStory({ bookId, library, onBack }: { bookId: string; library: LibraryStore; onBack: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const retry = useRef<() => void>(() => {});
  useEffect(() => protectReaderSession(), []);
  useEffect(() => {
    let active = true;
    let frame: HTMLIFrameElement | undefined;
    let port: MessagePort | undefined;
    let revision: string | null = null;
    let pending: StorageSnapshot | undefined;
    let writing = false;
    let latest: StorageSnapshot = { local: [], session: [] };
    let connect: ((event: MessageEvent) => void) | undefined;
    let timeout: number | undefined;

    async function flush() {
      if (writing || !pending) return;
      writing = true;
      setSaving(true);
      try {
        while (pending) {
          const data = pending;
          pending = undefined;
          const next = crypto.randomUUID();
          try {
            await library.saveStoryTurn(bookId, { revision: next, published: { version: 1, sourceHash: bookId, ...data } }, revision);
          } catch (cause) { pending ??= data; throw cause; }
          revision = next;
        }
        if (active) setError("");
      } catch (cause) { if (active) setError("Could not save story progress. " + String(cause)); }
      finally { writing = false; if (active) setSaving(false); }
    }
    retry.current = () => { void flush(); };

    async function launch() {
      const [source, state] = await Promise.all([library.getSugarCubeSource(bookId), library.getReaderState(bookId)]);
      if (!active) return;
      if (!source) throw new Error("Story source is missing.");
      const saved = state?.formatState?.published;
      if (saved !== undefined) {
        if (!saved || typeof saved !== "object" || !("version" in saved) || saved.version !== 1
          || !("sourceHash" in saved) || saved.sourceHash !== source.sourceHash) throw new Error("Incompatible published story save.");
        latest = snapshot(saved);
      }
      revision = typeof state?.formatState?.revision === "string" ? state.formatState.revision : null;
      frame = document.createElement("iframe");
      frame.title = source.story.title;
      const url = import.meta.env.PROD && "__TAURI_INTERNALS__" in window
        ? convertFileSrc("host", "story-runtime")
        : import.meta.env.BASE_URL + "sugarcube-host.html";
      const host = new URL(url, document.baseURI);
      const origin = host.origin === "null" ? host.protocol + "//" + host.host : host.origin;
      frame.allow = "autoplay; fullscreen";
      frame.style.cssText = "width:100%;height:100%;border:0;background:white";
      connect = event => {
        if (!active || event.source !== frame?.contentWindow || event.origin !== origin || event.data !== "speedreader:story-host") return;
        port?.close();
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = ({ data }) => {
          if (!active || !data || typeof data !== "object") return;
          if (data.type === "started") { clearTimeout(timeout); return; }
          if (data.type === "error") { clearTimeout(timeout); setError(String(data.message)); return; }
          if (data.type !== "save" && data.type !== "restart") return;
          try {
            pending = latest = snapshot(data);
            void flush();
            if (data.type === "restart" && frame) frame.src = url;
          } catch (cause) { setError(String(cause)); }
        };
        frame?.contentWindow?.postMessage({ html: source.html, assets: source.assets ?? [], entryPath: source.entryPath, ...latest }, origin, [channel.port2]);
      };
      window.addEventListener("message", connect);
      frame.src = url;
      mount.current?.appendChild(frame);
      timeout = window.setTimeout(() => setError("The published runtime did not start. Check this browser’s frame and script policies."), 15000);
    }
    void launch().catch(cause => { if (active) setError(String(cause)); });
    return () => {
      active = false;
      clearTimeout(timeout);
      if (connect) window.removeEventListener("message", connect);
      port?.close();
      frame?.remove();
    };
  }, [library, bookId]);
  return <main style={{ height: "100dvh", display: "flex", flexDirection: "column" }}>
    <header><button disabled={saving} onClick={() => {
      if (!error.startsWith("Could not save") || window.confirm("Leave without saving the latest story progress?")) onBack();
    }}>← Library</button>
      {saving && <span role="status">Saving…</span>}</header>
    {error && <p role="alert">{error} {error.startsWith("Could not save") && <button onClick={() => retry.current()}>Retry save</button>}</p>}
    <div ref={mount} style={{ flex: 1, minHeight: 0 }} />
  </main>;
}
