import { loadSpeechBackend, saveSpeechBackend } from "./backend-preference";
import { DEFAULT_VOICE } from "./voice-catalog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KokoroEngine } from "./kokoro-engine";
import { CachedAssets, PackStore } from "./pack-store";
import { IndexedPackMetadata } from "./pack-metadata";
import { downloadPackAsset, packForVoice } from "./voice-pack";
export function useAudioEngine(voice = DEFAULT_VOICE) {
  const pack = packForVoice(voice);
  const metadata = useMemo(() => new IndexedPackMetadata(), []);
  const store = useMemo(() => new PackStore(new CachedAssets(), metadata, downloadPackAsset), [metadata]);
  const pending = useRef<Promise<KokoroEngine> | null>(null);
  const engine = useRef<KokoroEngine | null>(null);
  const generation = useRef(0);
  const [backend, setBackend] = useState(loadSpeechBackend);
  const preferred = useRef(backend);
  const [backendWarning, setBackendWarning] = useState("");
  const release = useCallback(() => {
    generation.current++; engine.current?.dispose(); engine.current = null; pending.current = null;
  }, []);
  useEffect(() => { release(); return release; }, [release, voice]);
  const getEngine = useCallback(() => {
    if (!pending.current) {
      const version = generation.current;
      const next = new KokoroEngine(voice); engine.current = next;
      pending.current = (async () => {
        const installed = (await metadata.list()).find(installed => installed.id === pack.id);
        if (!installed || installed.version !== pack.version || installed.runtimeRevision !== pack.runtimeRevision) {
          throw new Error("Install or repair the English voice before playing");
        }
        await next.initialize(asset => store.resolve(asset), preferred.current);
        if (version !== generation.current) { next.dispose(); throw new Error("Reader session changed"); }
        return next;
      })().catch(error => {
        next.dispose(); if (version === generation.current) { pending.current = null; engine.current = null; }
        throw error;
      });
    }
    return pending.current;
  }, [metadata, store, voice, pack]);
  const selectBackend = useCallback((value: "wasm" | "webgpu") => {
    try { saveSpeechBackend(value); setBackendWarning(""); }
    catch { setBackendWarning("This backend is selected for now, but could not be saved in this browser."); }
    preferred.current = value; setBackend(value); release();
  }, [release]);
  return { store, metadata, getEngine, release, backend, backendWarning, selectBackend };
}
export function audioPreviewEnabled(): boolean {
  // Experimental controls are visible in all builds; playback remains opt-in.
  return true;
}
