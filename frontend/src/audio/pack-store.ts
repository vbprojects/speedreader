/** Immutable asset packs live outside Workbox's application cache. */
export interface PackAsset {
  sha256: string;
  bytes: number;
  url: string;
  role: "model" | "voice" | "phonemizer" | "runtime" | "dsp" | "tokenizer";
  license: string;
}
export interface VoicePack {
  id: string;
  version: string;
  runtimeRevision: string;
  assets: readonly PackAsset[];
  /** Retained across upgrades for older sessions; removed with the pack. */
  retiredAssets?: readonly PackAsset[];
}
export interface PackMetadata {
  list(): Promise<VoicePack[]>;
  put(pack: VoicePack): Promise<void>;
  remove(id: string): Promise<void>;
}
export interface AssetStorage {
  read(hash: string): Promise<ArrayBuffer | undefined>;
  write(hash: string, bytes: ArrayBuffer): Promise<void>;
  remove(hash: string): Promise<void>;
}
export async function assetDigest(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}
function validate(pack: VoicePack): void {
  if (!pack.id || !pack.version || !pack.runtimeRevision || !pack.assets.length) throw new Error("Incomplete pack manifest");
  for (const asset of pack.assets) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !asset.license) {
      throw new Error("Invalid immutable asset manifest");
    }
  }
}

/** Caller supplies a real local synthesis probe. Installation commits only afterwards.
 * Serialize mutations across tabs using navigator.locks at the browser adapter.
 */
export class PackStore {
  constructor(private assets: AssetStorage, private metadata: PackMetadata,
    private download: (asset: PackAsset, signal?: AbortSignal) => Promise<ArrayBuffer>) {}

  async resolve(asset: PackAsset): Promise<ArrayBuffer> {
    const bytes = await this.assets.read(asset.sha256);
    if (!bytes || bytes.byteLength !== asset.bytes || await assetDigest(bytes) !== asset.sha256) {
      throw new Error(`Voice pack needs repair: ${asset.role}`);
    }
    return bytes;
  }

  async verify(pack: VoicePack): Promise<void> {
    validate(pack);
    for (const asset of pack.assets) await this.resolve(asset);
  }

  async install(pack: VoicePack, probe: (resolve: (asset: PackAsset) => Promise<ArrayBuffer>) => Promise<void>,
    signal?: AbortSignal, progress?: (completed: number, total: number) => void): Promise<void> {
    validate(pack);
    let completed = 0;
    const total = pack.assets.reduce((n, a) => n + a.bytes, 0);
    for (const asset of pack.assets) {
      signal?.throwIfAborted();
      let valid = false;
      try { await this.resolve(asset); valid = true; } catch { /* Reuse only verified bytes. */ }
      if (!valid) {
        const bytes = await this.download(asset, signal);
        signal?.throwIfAborted();
        if (bytes.byteLength !== asset.bytes || await assetDigest(bytes) !== asset.sha256) throw new Error(`Integrity failure: ${asset.role}`);
        await this.assets.write(asset.sha256, bytes);
      }
      completed += asset.bytes;
      progress?.(completed, total);
    }
    await probe(asset => this.resolve(asset));
    signal?.throwIfAborted();
    // Replacing metadata leaves the prior usable version intact until this point.
    const previous = (await this.metadata.list()).find(installed => installed.id === pack.id);
    const current = new Set(pack.assets.map(asset => asset.sha256));
    const retired = new Map([...(previous?.retiredAssets ?? []), ...(previous?.assets ?? [])]
      .filter(asset => !current.has(asset.sha256)).map(asset => [asset.sha256, asset]));
    await this.metadata.put(structuredClone({ ...pack, retiredAssets: [...retired.values()] }));
  }

  async remove(id: string, incomplete?: VoicePack): Promise<void> {
    const installed = await this.metadata.list();
    if (incomplete) validate(incomplete);
    const target = installed.find(pack => pack.id === id) ?? (incomplete?.id === id ? incomplete : undefined);
    if (!target) return;
    await this.metadata.remove(id);
    const retained = new Set(installed.filter(pack => pack.id !== id).flatMap(pack =>
      [...pack.assets, ...(pack.retiredAssets ?? [])].map(a => a.sha256)));
    const removable = new Set([...target.assets, ...(target.retiredAssets ?? []),
      ...(incomplete?.id === id ? incomplete.assets : [])].map(asset => asset.sha256));
    for (const hash of removable) if (!retained.has(hash)) await this.assets.remove(hash);
  }
}

export class CachedAssets implements AssetStorage {
  private key(hash: string): string { return new URL(`__kokoro_assets__/${hash}`, location.origin).href; }
  private cache() { return caches.open("speedreader-kokoro-immutable-v1"); }
  async read(hash: string) { return (await (await this.cache()).match(this.key(hash)))?.arrayBuffer(); }
  async write(hash: string, bytes: ArrayBuffer) { await (await this.cache()).put(this.key(hash), new Response(bytes)); }
  async remove(hash: string) { await (await this.cache()).delete(this.key(hash)); }
}

/** Enforce advertised size during transfer, before allocating a model-sized buffer. */
export async function downloadAsset(asset: PackAsset, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(asset.url, { signal, cache: "no-store" });
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`);
  const reader = response.body.getReader();
  const bytes = new Uint8Array(asset.bytes);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length) throw new Error("Asset exceeds manifest size");
      bytes.set(value, offset);
      offset += value.length;
    }
    if (offset !== bytes.length) throw new Error("Incomplete asset download");
    return bytes.buffer;
  } finally { await reader.cancel(); }
}
