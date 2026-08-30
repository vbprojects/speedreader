import { useEffect, useState } from "react";
import {
  LLM_CREDENTIAL_ID,
  MIN_VAULT_PASSPHRASE_LENGTH,
  normalizeOpenAIBaseUrl,
  type CredentialMetadata,
  type CredentialVault,
  type OpenAICompatibleConnection,
} from "../ingestion/openai-compatible";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

export function LlmConnectionDialog({
  open,
  theme,
  vault,
  initialBaseUrl,
  initialModel,
  onConnect,
  onCancel,
}: {
  open: boolean;
  theme: Theme;
  vault: CredentialVault;
  initialBaseUrl?: string;
  initialModel?: string;
  onConnect: (connection: OpenAICompatibleConnection) => void;
  onCancel: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initialModel ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const [saved, setSaved] = useState<CredentialMetadata | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingVault, setLoadingVault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = themeTokens(theme);

  useEffect(() => {
    setBaseUrl(initialBaseUrl ?? "");
    setApiKey("");
    setModel(initialModel ?? "");
    setPassphrase("");
    setRemember(false);
    setSaved(null);
    setBusy(false);
    setError(null);
    if (!open) return;
    let active = true;
    setLoadingVault(true);
    void vault.metadata(LLM_CREDENTIAL_ID).then((metadata) => {
      if (!active || !metadata) return;
      setSaved(metadata);
      setBaseUrl(initialBaseUrl ?? metadata.baseUrl);
      setModel(initialModel ?? metadata.model ?? "");
      setRemember(true);
    }).catch((vaultError: unknown) => {
      if (active) setError(vaultError instanceof Error ? vaultError.message : String(vaultError));
    }).finally(() => {
      if (active) setLoadingVault(false);
    });
    return () => { active = false; };
  }, [initialBaseUrl, initialModel, open, vault]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, open, onCancel]);

  if (!open) return null;
  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 9,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.fg,
    fontFamily: "inherit",
    fontSize: 16,
  };

  const submit = async () => {
    if (busy || loadingVault) return;
    setError(null);
    setBusy(true);
    try {
      const endpoint = normalizeOpenAIBaseUrl(baseUrl);
      let resolvedKey = apiKey.trim();
      if (!resolvedKey && saved) {
        if (!passphrase) throw new Error("Enter the vault passphrase to unlock the saved API key.");
        resolvedKey = (await vault.unlock(LLM_CREDENTIAL_ID, passphrase)).apiKey ?? "";
      }
      if (!resolvedKey) throw new Error("An API key is required.");
      const connection: OpenAICompatibleConnection = {
        baseUrl: endpoint,
        apiKey: resolvedKey,
        model: model.trim() || undefined,
      };
      if (remember) {
        if (passphrase.length < MIN_VAULT_PASSPHRASE_LENGTH) {
          throw new Error(`Use a vault passphrase of at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters.`);
        }
        await vault.save(LLM_CREDENTIAL_ID, connection, passphrase);
      } else if (saved) {
        await vault.delete(LLM_CREDENTIAL_ID);
      }
      onConnect(connection);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  };

  const forgetSavedKey = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await vault.delete(LLM_CREDENTIAL_ID);
      setSaved(null);
      setApiKey("");
      setPassphrase("");
      setRemember(false);
    } catch (vaultError) {
      setError(vaultError instanceof Error ? vaultError.message : String(vaultError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div onClick={() => { if (!busy) onCancel(); }} style={{ position: "fixed", inset: 0, zIndex: 3000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(6px)" }}>
      <form
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        onClick={(event) => event.stopPropagation()}
        style={{ width: "min(440px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", padding: 22, borderRadius: 16, border: `1px solid ${t.border}`, background: t.panel, color: t.fg, boxShadow: "0 12px 44px rgba(0,0,0,0.3)", fontFamily: "system-ui" }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Connect LLM Chat</h2>
        <p style={{ margin: "0 0 18px", color: t.muted, fontSize: 14, lineHeight: 1.5 }}>
          Enter an OpenAI-compatible endpoint and key. You can paste either a base URL or the full <code>/chat/completions</code> URL. The endpoint must allow browser CORS.
          {saved ? " Unlock the encrypted key saved on this device, or enter a replacement key." : " The key stays in memory unless you opt into encrypted storage."}
        </p>
        <label style={{ display: "grid", gap: 6, marginBottom: 14, fontSize: 13 }}>
          Endpoint
          <input autoFocus type="url" inputMode="url" placeholder="https://openrouter.ai/api/v1" value={baseUrl} disabled={busy || loadingVault} onChange={(event) => setBaseUrl(event.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 6, marginBottom: 14, fontSize: 13 }}>
          API key {saved && <span style={{ color: t.muted }}>(leave blank to use the saved key)</span>}
          <input type="password" autoComplete="new-password" placeholder={saved ? "Saved encrypted key" : "API key"} value={apiKey} disabled={busy || loadingVault} onChange={(event) => setApiKey(event.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 6, marginBottom: 14, fontSize: 13 }}>
          Model <span style={{ color: t.muted }}>(optional; OpenRouter uses your default, others use /models)</span>
          <input placeholder="Model ID" value={model} disabled={busy || loadingVault} onChange={(event) => setModel(event.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12, fontSize: 13 }}>
          <input type="checkbox" checked={remember} disabled={busy || loadingVault} onChange={(event) => setRemember(event.target.checked)} />
          Remember the API key encrypted on this device
        </label>
        {(remember || saved) && (
          <label style={{ display: "grid", gap: 6, marginBottom: 10, fontSize: 13 }}>
            Vault passphrase
            <input type="password" autoComplete="new-password" placeholder={saved ? "Unlock saved key" : `At least ${MIN_VAULT_PASSPHRASE_LENGTH} characters`} value={passphrase} disabled={busy || loadingVault} onChange={(event) => setPassphrase(event.target.value)} style={inputStyle} />
            <span style={{ color: t.muted, lineHeight: 1.4 }}>The passphrase is never saved and cannot be recovered.</span>
          </label>
        )}
        {saved && (
          <button type="button" disabled={busy} onClick={() => { void forgetSavedKey(); }} style={{ border: 0, padding: "4px 0", background: "transparent", color: "#e5484d", cursor: busy ? "wait" : "pointer", fontSize: 13 }}>
            Forget saved key
          </button>
        )}
        {error && <div role="alert" style={{ margin: "10px 0", color: "#e5484d", fontSize: 13 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          <button type="button" disabled={busy} onClick={onCancel} style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.panel, color: t.fg }}>Cancel</button>
          <button type="submit" disabled={busy || loadingVault} style={{ padding: "9px 14px", borderRadius: 8, border: 0, background: t.highlight, color: t.highlightFg, fontWeight: 650 }}>{busy ? "Working…" : "Connect"}</button>
        </div>
      </form>
    </div>
  );
}
