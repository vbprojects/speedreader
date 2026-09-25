import { AudioPanel } from "./AudioPanel";
import { useAudioEngine, audioPreviewEnabled } from "./use-audio-engine";
import type { GlobalSettings, ReaderSettings } from "../settings/types";

/** Global speech preferences use the same controls and download flow as readers. */
export default function VoiceDownloads({ settings, onChange }: {
  settings: GlobalSettings; onChange(patch: ReaderSettings): void;
}) {
  const engine = useAudioEngine(settings.readAloudVoice);
  return audioPreviewEnabled() ? <AudioPanel settings={settings} onChange={onChange} theme={settings.theme}
    store={engine.store} metadata={engine.metadata} release={engine.release}
    getEngine={engine.getEngine} backend={engine.backend} backendWarning={engine.backendWarning} selectBackend={engine.selectBackend}
    pauseReader={() => {}} mainRunning={false} observedWpm={null} state="Ready" /> : null;
}
