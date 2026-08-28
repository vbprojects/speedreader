import { equal, rejects } from "node:assert/strict";
import { test } from "node:test";
import {
  EncryptedCredentialVault,
  type CredentialRecordStore,
  type EncryptedCredentialRecord,
  LLM_CREDENTIAL_ID,
  PBKDF2_ITERATIONS,
} from "./credential-vault";

class MemoryStore implements CredentialRecordStore {
  record: EncryptedCredentialRecord | null = null;
  async get(id: string) { return this.record?.id === id ? structuredClone(this.record) : null; }
  async put(record: EncryptedCredentialRecord) { this.record = structuredClone(record); }
  async delete(id: string) { if (this.record?.id === id) this.record = null; }
}

test("credential vault encrypts, unlocks, and forgets an API key", async () => {
  equal(PBKDF2_ITERATIONS, 600_000);
  const store = new MemoryStore();
  const vault = new EncryptedCredentialVault(store, globalThis.crypto, 100_000, () => 123);
  await vault.save(LLM_CREDENTIAL_ID, {
    baseUrl: "https://provider.example/v1",
    model: "model-a",
    apiKey: "provider-secret",
  }, "a sufficiently long passphrase");

  const serialized = JSON.stringify(store.record);
  equal(serialized.includes("provider-secret"), false);
  equal(store.record?.kdf.iterations, 100_000);
  equal(store.record?.ciphertext === store.record?.salt, false);
  equal((await vault.metadata(LLM_CREDENTIAL_ID))?.baseUrl, "https://provider.example/v1");
  equal((await vault.unlock(LLM_CREDENTIAL_ID, "a sufficiently long passphrase")).apiKey, "provider-secret");
  await rejects(() => vault.unlock(LLM_CREDENTIAL_ID, "wrong passphrase"), /Unable to unlock/);

  await vault.delete(LLM_CREDENTIAL_ID);
  equal(await vault.metadata(LLM_CREDENTIAL_ID), null);
});

test("authenticated metadata cannot be altered without invalidating the key", async () => {
  const store = new MemoryStore();
  const vault = new EncryptedCredentialVault(store, globalThis.crypto, 100_000);
  await vault.save(LLM_CREDENTIAL_ID, {
    baseUrl: "https://provider.example/v1",
    apiKey: "provider-secret",
  }, "a sufficiently long passphrase");
  store.record = { ...store.record!, baseUrl: "https://attacker.example/v1" };
  await rejects(() => vault.unlock(LLM_CREDENTIAL_ID, "a sufficiently long passphrase"), /Unable to unlock/);
});
