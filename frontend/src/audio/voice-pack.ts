import { PIPER_ROOT, PIPER_VOICES, isPiperVoice } from "./voice-catalog";
export { voiceLabel } from "./voice-catalog";
import wasmUrl from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url";
import { assetDigest, downloadAsset, type PackAsset, type VoicePack } from "./pack-store";
import { exposeNativeDurations, exposePiperDurations } from "./duration-export";
const root = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/";
export const COMPACT_SOURCE: PackAsset = { role: "model", url: root + "onnx/model_quantized.onnx",
  bytes: 92361116, sha256: "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478", license: "Apache-2.0" };
export const HEART_PACK: VoicePack = {
  id: "kokoro-en-af-heart", version: "1", runtimeRevision: "ort-web-1.30.0-headtts-c08f4ca8-dsp-2.1.1",
  assets: [
    { ...COMPACT_SOURCE, bytes: 92361171, sha256: "51468a82bdf31825b5fa7e51b0c7e8be7058504523aba9164efc953897358a95" },
    { role: "voice", url: root + "voices/af_heart.bin", bytes: 522240,
      sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b", license: "Apache-2.0" },
    { role: "phonemizer", url: "https://raw.githubusercontent.com/met4citizen/HeadTTS/c08f4ca8b3253b3e908e501486a1e068e606be5c/dictionaries/en-us.txt",
      bytes: 2792055, sha256: "5edf7f0e8e8c49fdf5fa1d27481980d9a83edf2c9a89de5898a1a88eb215cd2e", license: "CMUdict BSD-style (notice embedded in dictionary)" },
    { role: "runtime", url: wasmUrl, bytes: 26781914,
      sha256: "39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da", license: "MIT" },
  ],
};
export async function downloadPackAsset(asset: PackAsset, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (asset.sha256 === PIPER_PACK.assets[0].sha256) {
    const source = await downloadAsset(PIPER_SOURCE, signal);
    if (await assetDigest(source) !== PIPER_SOURCE.sha256) throw new Error("Piper model integrity failure");
    return exposePiperDurations(source);
  }
  if (asset.role !== "model" || asset.url.startsWith(PIPER_ROOT)) return downloadAsset(asset, signal);
  const source = await downloadAsset(COMPACT_SOURCE, signal);
  if (await assetDigest(source) !== COMPACT_SOURCE.sha256) throw new Error("Original model integrity failure");
  return exposeNativeDurations(source);
}

const piperRoot = "https://huggingface.co/rhasspy/piper-voices/resolve/1162a9173d0ce503555aed757976b7a9912eae4c/en/en_US/lessac/low/";
export const PIPER_SOURCE: PackAsset = { role: "model", url: piperRoot + "en_US-lessac-low.onnx",
  bytes: 63201294, sha256: "f7d01dde371555732c4c314111ac79672b1a5ce2fc19266ab42178fd8df7f375", license: "Lessac voice; see model card and dataset terms" };
export const PIPER_PACK: VoicePack = {
  id: "piper-en-lessac-low", version: "1", runtimeRevision: "ort-web-1.30.0-headtts-piper-bridge-1-dsp-2.1.1",
  assets: [
    { ...PIPER_SOURCE, bytes: 63201340, sha256: "181816267f8cecabb2362bcd3417c94ee43edc807ad031610099dc621232813f" },
    { role: "voice", url: piperRoot + "en_US-lessac-low.onnx.json", bytes: 4882,
      sha256: "45754dfdebb3b8661c3fc564713772deec6e064feeb5b4e9594857dc7305193a", license: PIPER_SOURCE.license },
    HEART_PACK.assets[2], HEART_PACK.assets[3],
  ],
};
const catalogPacks = new Map(PIPER_VOICES.map(voice => [voice.id, {
  id: `piper-${voice.id}`, version: "1", runtimeRevision: PIPER_PACK.runtimeRevision,
  assets: [
    { role: "model" as const, url: PIPER_ROOT + voice.path, bytes: voice.modelBytes, sha256: voice.modelSha256, license: voice.modelCard },
    { role: "voice" as const, url: PIPER_ROOT + voice.path + ".json", bytes: voice.configBytes, sha256: voice.configSha256, license: voice.modelCard },
    HEART_PACK.assets[2], HEART_PACK.assets[3],
  ],
}]));
export function packForVoice(voice: string): VoicePack {
  if (voice === "piper_lessac") return PIPER_PACK; // Preserve existing offline installs.
  if (isPiperVoice(voice)) return catalogPacks.get(voice)!;
  if (voice === "af_heart") return HEART_PACK;
  throw new Error("Unknown voice pack");
}
