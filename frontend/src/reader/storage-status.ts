/** Browser estimates describe the whole origin; the app budget is separate. */
export interface StorageStatus {
  usage?: number;
  quota?: number;
  remaining?: number;
  persistence: "granted" | "not-granted" | "unsupported" | "unknown";
  estimateAvailable: boolean;
  canRequestPersistence: boolean;
  problem?: string;
}

export interface StorageManagerLike {
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

const finiteBytes = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function currentStorage(): StorageManagerLike | undefined {
  try { return typeof navigator === "undefined" ? undefined : navigator.storage; }
  catch { return undefined; }
}

export async function readStorageStatus(manager = currentStorage()): Promise<StorageStatus> {
  const result: StorageStatus = {
    persistence: manager?.persisted ? "unknown" : "unsupported",
    estimateAvailable: false,
    canRequestPersistence: typeof manager?.persist === "function",
  };
  // A rejected estimate must not suppress a separately available persistence state.
  const checks = await Promise.allSettled([
    Promise.resolve().then(() => manager?.estimate?.()),
    Promise.resolve().then(() => manager?.persisted?.()),
  ]);
  const estimate = checks[0];
  if (estimate.status === "fulfilled" && estimate.value) {
    const { usage, quota } = estimate.value;
    if (finiteBytes(usage)) result.usage = usage;
    if (finiteBytes(quota)) result.quota = quota;
    if (finiteBytes(usage) && finiteBytes(quota)) result.remaining = Math.max(0, quota - usage);
    result.estimateAvailable = finiteBytes(usage) || finiteBytes(quota);
  } else if (estimate.status === "rejected") result.problem = "Storage estimates are unavailable in this browser session.";
  const persisted = checks[1];
  if (persisted.status === "fulfilled" && typeof persisted.value === "boolean") {
    result.persistence = persisted.value ? "granted" : "not-granted";
  } else if (persisted.status === "rejected") result.problem = "The browser could not report its storage protection state.";
  return result;
}

/** Call only from a user gesture; ordinary status reads never request permission. */
export async function requestStoragePersistence(manager = currentStorage()): Promise<StorageStatus> {
  if (!manager?.persist) return readStorageStatus(manager);
  try {
    const granted = await manager.persist();
    return { ...await readStorageStatus(manager), persistence: granted ? "granted" : "not-granted" };
  } catch {
    return { ...await readStorageStatus(manager), problem: "The browser could not enable persistent storage." };
  }
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "Unavailable";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}
