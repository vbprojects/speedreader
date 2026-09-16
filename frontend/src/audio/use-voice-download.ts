import { DEFAULT_VOICE } from "./voice-catalog";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_AUDIO_SETTINGS } from "./settings";
import type { PackMetadata, PackStore } from "./pack-store";
import { withPackLock } from "./pack-metadata";
import { packForVoice } from "./voice-pack";
import { KokoroEngine } from "./kokoro-engine";

export function useVoiceDownload(store: PackStore, metadata: PackMetadata, beforeMutation: () => void, voice = DEFAULT_VOICE) {
  const pack = packForVoice(voice);
  const packBytes = pack.assets.reduce((total, asset) => total + asset.bytes, 0);
  const packSize = `${(packBytes / 1_000_000).toFixed(1)} MB`;
  const installation = useRef<AbortController | null>(null);
  const probeEngine = useRef<KokoroEngine | null>(null);
  useEffect(() => () => { installation.current?.abort(); probeEngine.current?.dispose(); }, []);
  const [installedId, setInstalledId] = useState<string | null>(null);
  const installed = installedId === pack.id;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { let active = true; void metadata.list().then(packs => {
    if (active) setInstalledId(packs.some(installed => installed.id === pack.id && installed.version === pack.version) ? pack.id : null);
  }).catch(error => { if (active) setMessage(String(error)); }); return () => { active = false; }; }, [metadata, pack]);
  const install = async () => {
    beforeMutation();
    const abort = new AbortController(); installation.current = abort;
    setBusy(true); setMessage("Preparing voice download…");
    try {
      // Persistence is best effort. Some browsers leave a permission prompt
      // pending indefinitely; it must not block downloading or cancellation.
      void navigator.storage?.persist().catch(() => undefined);
      await withPackLock(() => store.install(pack, async resolve => {
        setMessage("Verifying local speech synthesis…");
        const engine = new KokoroEngine(voice); probeEngine.current = engine;
        try {
          await engine.initialize(resolve, "wasm");
          await engine.prepare([{ text: "Ready.", index: 0, metadata: [] }], { ...DEFAULT_AUDIO_SETTINGS, readAloudVoice: voice },
            { sessionId: "install-probe", contentRevision: 0, synthesisRevision: 0, dspRevision: 0 }, 1);
        } finally { engine.dispose(); probeEngine.current = null; }
      }, abort.signal, (completed, total) => setMessage(`Installing ${Math.round(100 * completed / total)}%`)), abort.signal);
      setInstalledId(pack.id); setMessage("English voice is installed for offline use.");
    } catch (error) { setMessage(error instanceof DOMException && error.name === "QuotaExceededError"
      ? `Not enough storage for the ${packSize} voice pack. Remove a voice or discard partial files, then retry.`
      : error instanceof Error ? error.message : String(error)); }
    finally { installation.current = null; setBusy(false); }
  };
  const remove = async () => {
    beforeMutation(); setBusy(true);
    try { await withPackLock(() => store.remove(pack.id, pack)); setInstalledId(null); setMessage("Voice removed."); }
    catch (error) { setMessage(String(error)); } finally { setBusy(false); }
  };
  return { installed, busy, message, setMessage, packBytes, packSize, install, remove,
    cancel: () => { installation.current?.abort(); probeEngine.current?.dispose(); } };
}
