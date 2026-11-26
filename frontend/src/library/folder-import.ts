import { fileFromBrowserFile } from "../ingestion/file-source";
import { assertFileSize, assertIngestionLimit, INGESTION_LIMITS } from "../ingestion/limits";
import { detectSugarCubeDocument } from "../ingestion/sugarcube";
import { assetMimeType, type TwineArchiveAsset } from "../ingestion/twine-archive";
import { sha256 } from "./hash";
import type { LibraryStore } from "./store";

const relativePath = (file: File) => file.webkitRelativePath.split("/").slice(1).join("/") || file.name;

/** Read shared package assets once, and only if the folder contains a game. */
export function folderImporter(library: LibraryStore, files: File[]) {
  const companions = files.filter(file => !/\.html?$/i.test(file.name));
  async function readAssets() {
    assertIngestionLimit(companions.length, INGESTION_LIMITS.maxEpubEntries, "Story folder entries");
    assertFileSize(companions.reduce((bytes, file) => bytes + file.size, 0));
    const assets: TwineArchiveAsset[] = [];
    const hashes: string[][] = [];
    for (const file of companions) {
      const path = relativePath(file);
      const data = await file.arrayBuffer();
      const mimeType = file.type || assetMimeType(path);
      assets.push({ path, data, mimeType });
      hashes.push([path, mimeType, await sha256(data)]);
    }
    hashes.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return { assets, hashes };
  }
  let shared: ReturnType<typeof readAssets> | undefined;
  return async (file: File) => {
    const info = await fileFromBrowserFile(file);
    if (!companions.length || !detectSugarCubeDocument(new TextDecoder().decode(info.data))) return library.importFile(info);
    const { assets, hashes } = await (shared ??= readAssets());
    const entryPath = relativePath(file);
    const manifest = JSON.stringify([entryPath, await sha256(info.data), hashes]);
    const id = await sha256(new TextEncoder().encode(manifest).buffer);
    return library.importSugarCubeSource(info, undefined, id, assets, entryPath);
  };
}
