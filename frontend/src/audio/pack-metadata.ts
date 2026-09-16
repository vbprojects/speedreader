import type { PackMetadata, VoicePack } from "./pack-store";

/** Optional pack migrations are independent of the book library. */
export class IndexedPackMetadata implements PackMetadata {
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("speedreader-audio-packs", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("packs", { keyPath: "id" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close older tabs to update voice storage"));
    });
  }
  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await this.database();
    return new Promise((resolve, reject) => {
      const tx = database.transaction("packs", mode);
      const request = action(tx.objectStore("packs"));
      tx.oncomplete = () => { database.close(); resolve(request.result); };
      tx.onabort = () => { database.close(); reject(tx.error ?? request.error); };
    });
  }
  list(): Promise<VoicePack[]> { return this.transaction("readonly", store => store.getAll()); }
  async put(pack: VoicePack): Promise<void> { await this.transaction("readwrite", store => store.put(pack)); }
  async remove(id: string): Promise<void> { await this.transaction("readwrite", store => store.delete(id)); }
}

/** Hold throughout downloads/probe/commit to avoid cross-tab removal races. */
export async function withPackLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!navigator.locks) throw new Error("This browser cannot safely manage offline voice packs");
  return navigator.locks.request("speedreader-audio-packs", { signal }, action);
}
