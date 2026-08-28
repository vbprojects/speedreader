import type { OpenAICompatibleConnection } from "./types";

export const LLM_CREDENTIAL_ID = "openai-compatible:default";
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_VAULT_PASSPHRASE_LENGTH = 12;
const MIN_PBKDF2_ITERATIONS = 100_000;
const DB_NAME = "speedreader-credentials";
const DB_VERSION = 1;
const STORE_CREDENTIALS = "encryptedCredentials";

export interface EncryptedCredentialRecord {
  id: string;
  schemaVersion: 1;
  baseUrl: string;
  model?: string;
  salt: string;
  iv: string;
  ciphertext: string;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number };
  cipher: { name: "AES-GCM"; length: 256 };
  createdAt: number;
  updatedAt: number;
}

export interface CredentialMetadata {
  id: string;
  baseUrl: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialRecordStore {
  get(id: string): Promise<EncryptedCredentialRecord | null>;
  put(record: EncryptedCredentialRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface CredentialVault {
  metadata(id: string): Promise<CredentialMetadata | null>;
  save(id: string, connection: OpenAICompatibleConnection, passphrase: string): Promise<void>;
  unlock(id: string, passphrase: string): Promise<OpenAICompatibleConnection>;
  delete(id: string): Promise<void>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string, maxBytes: number): Uint8Array {
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error("Encrypted credential record is too large.");
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Encrypted credential record is malformed.");
  }
  if (binary.length > maxBytes) throw new Error("Encrypted credential record is too large.");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function additionalData(record: Pick<EncryptedCredentialRecord, "id" | "schemaVersion" | "baseUrl" | "model">): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    id: record.id,
    schemaVersion: record.schemaVersion,
    baseUrl: record.baseUrl,
    model: record.model ?? "",
  }));
}

async function deriveKey(
  subtle: SubtleCrypto,
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const material = await subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function validateRecord(record: EncryptedCredentialRecord): void {
  if (
    record.schemaVersion !== 1 ||
    record.kdf?.name !== "PBKDF2" ||
    record.kdf.hash !== "SHA-256" ||
    !Number.isInteger(record.kdf.iterations) ||
    record.kdf.iterations < MIN_PBKDF2_ITERATIONS ||
    record.kdf.iterations > 2_000_000 ||
    record.cipher?.name !== "AES-GCM" ||
    record.cipher.length !== 256 ||
    typeof record.baseUrl !== "string" ||
    record.baseUrl.length > 2048 ||
    (record.model !== undefined && (typeof record.model !== "string" || record.model.length > 512))
  ) {
    throw new Error("Encrypted credential record is unsupported or malformed.");
  }
}

export class IndexedDbCredentialRecordStore implements CredentialRecordStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_CREDENTIALS)) {
          request.result.createObjectStore(STORE_CREDENTIALS, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Unable to open the credential vault."));
      request.onblocked = () => reject(new Error("Credential vault upgrade is blocked by another app window."));
    });
    return this.dbPromise;
  }

  async get(id: string): Promise<EncryptedCredentialRecord | null> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_CREDENTIALS, "readonly").objectStore(STORE_CREDENTIALS).get(id);
      request.onsuccess = () => resolve((request.result as EncryptedCredentialRecord | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error("Unable to read the encrypted credential."));
    });
  }

  async put(record: EncryptedCredentialRecord): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_CREDENTIALS, "readwrite");
      transaction.objectStore(STORE_CREDENTIALS).put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save the encrypted credential."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Saving the encrypted credential was aborted."));
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_CREDENTIALS, "readwrite");
      transaction.objectStore(STORE_CREDENTIALS).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Unable to forget the encrypted credential."));
      transaction.onabort = () => reject(transaction.error ?? new Error("Forgetting the encrypted credential was aborted."));
    });
  }
}

export class EncryptedCredentialVault implements CredentialVault {
  constructor(
    private readonly store: CredentialRecordStore = new IndexedDbCredentialRecordStore(),
    private readonly cryptoImpl: Crypto = globalThis.crypto,
    private readonly iterations = PBKDF2_ITERATIONS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) {
      throw new Error(`PBKDF2 requires at least ${MIN_PBKDF2_ITERATIONS.toLocaleString()} iterations.`);
    }
  }

  async metadata(id: string): Promise<CredentialMetadata | null> {
    const record = await this.store.get(id);
    if (!record) return null;
    validateRecord(record);
    return {
      id: record.id,
      baseUrl: record.baseUrl,
      model: record.model,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  async save(id: string, connection: OpenAICompatibleConnection, passphrase: string): Promise<void> {
    if (id.length === 0 || id.length > 256) throw new Error("The credential identifier is invalid.");
    if (passphrase.length < MIN_VAULT_PASSPHRASE_LENGTH) {
      throw new Error(`Use a vault passphrase of at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters.`);
    }
    if (passphrase.length > 1024) throw new Error("The vault passphrase is too large.");
    if (!connection.apiKey?.trim()) throw new Error("An API key is required.");
    if (connection.apiKey.length > 16_384) throw new Error("The API key is too large.");
    if (connection.baseUrl.length === 0 || connection.baseUrl.length > 2048) throw new Error("The endpoint is invalid.");
    if (connection.model && connection.model.length > 512) throw new Error("The model identifier is too large.");
    const existing = await this.store.get(id);
    if (existing) validateRecord(existing);
    const salt = this.cryptoImpl.getRandomValues(new Uint8Array(16));
    const iv = this.cryptoImpl.getRandomValues(new Uint8Array(12));
    const timestamp = this.now();
    const recordBase = {
      id,
      schemaVersion: 1 as const,
      baseUrl: connection.baseUrl,
      model: connection.model,
    };
    const key = await deriveKey(this.cryptoImpl.subtle, passphrase, salt, this.iterations);
    const plaintext = new TextEncoder().encode(JSON.stringify({ apiKey: connection.apiKey }));
    const ciphertext = await this.cryptoImpl.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: additionalData(recordBase), tagLength: 128 },
      key,
      plaintext,
    );
    await this.store.put({
      ...recordBase,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: this.iterations },
      cipher: { name: "AES-GCM", length: 256 },
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }

  async unlock(id: string, passphrase: string): Promise<OpenAICompatibleConnection> {
    if (passphrase.length > 1024) throw new Error("Unable to unlock the saved API key. Check the vault passphrase.");
    const record = await this.store.get(id);
    if (!record) throw new Error("No encrypted API key is saved on this device.");
    try {
      validateRecord(record);
      const salt = base64ToBytes(record.salt, 16);
      const iv = base64ToBytes(record.iv, 12);
      if (salt.length !== 16 || iv.length !== 12) throw new Error("Invalid cryptographic parameters.");
      const ciphertext = base64ToBytes(record.ciphertext, 20_000);
      const key = await deriveKey(this.cryptoImpl.subtle, passphrase, salt, record.kdf.iterations);
      const plaintext = await this.cryptoImpl.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(record), tagLength: 128 },
        key,
        ciphertext,
      );
      const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as { apiKey?: unknown };
      if (typeof decoded.apiKey !== "string" || !decoded.apiKey || decoded.apiKey.length > 16_384) {
        throw new Error("Invalid decrypted API key.");
      }
      return { baseUrl: record.baseUrl, model: record.model, apiKey: decoded.apiKey };
    } catch {
      throw new Error("Unable to unlock the saved API key. Check the vault passphrase.");
    }
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }
}
