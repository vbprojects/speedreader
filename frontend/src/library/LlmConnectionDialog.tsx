import { useEffect, useState } from "react";
import { normalizeOpenAIBaseUrl, type OpenAICompatibleConnection } from "../ingestion/openai-compatible";
import type { Theme } from "../settings/types";
import { themeTokens } from "../settings/themes";

export function LlmConnectionDialog({
  open,
  theme,
  onConnect,
  onCancel,
}: {
  open: boolean;
  theme: Theme;
  onConnect: (connection: OpenAICompatibleConnection) => void;
  onCancel: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const t = themeTokens(theme);

  useEffect(() => {
    setBaseUrl("");
    setApiKey("");
    setModel("");
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 9,
    border: `1px solid ${t.border}`,
    background: t.bg,
    color: t.fg,
    font: "inherit",
  };

  const submit = () => {
    let endpoint: string;
    try {
      endpoint = normalizeOpenAIBaseUrl(baseUrl);
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : String(validationError));
      return;
    }
    if (!apiKey.trim()) {
      setError("An API key is required.");
      return;
    }
    onConnect({ baseUrl: endpoint, apiKey: apiKey.trim(), model: model.trim() || undefined });
  };

  return (
    <div onClick={onCancel} style={{ position: "fixed", inset: 0, zIndex: 3000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(6px)" }}>
      <form
        onSubmit={(event) => { event.preventDefault(); submit(); }}
        onClick={(event) => event.stopPropagation()}
        style={{ width: "min(440px, 100%)", padding: 22, borderRadius: 16, border: `1px solid ${t.border}`, background: t.panel, color: t.fg, boxShadow: "0 12px 44px rgba(0,0,0,0.3)", fontFamily: "system-ui" }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 20 }}>Connect LLM Chat</h2>
        <p style={{ margin: "0 0 18px", color: t.muted, fontSize: 14, lineHeight: 1.5 }}>
          Enter an OpenAI-compatible endpoint and key. The endpoint must allow browser CORS. The key stays in memory and is not saved to the library or reader history.
        </p>
        <label style={{ display: "grid", gap: 6, marginBottom: 14, fontSize: 13 }}>
          Endpoint
          <input autoFocus type="url" inputMode="url" placeholder="https://provider.example/v1" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 6, marginBottom: 14, fontSize: 13 }}>
          API key
          <input type="password" autoComplete="new-password" placeholder="API key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} style={inputStyle} />
        </label>
        <label style={{ display: "grid", gap: 6, marginBottom: 10, fontSize: 13 }}>
          Model <span style={{ color: t.muted }}>(optional; discovered from /models)</span>
          <input placeholder="Model ID" value={model} onChange={(event) => setModel(event.target.value)} style={inputStyle} />
        </label>
        {error && <div role="alert" style={{ margin: "10px 0", color: "#e5484d", fontSize: 13 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 18 }}>
          <button type="button" onClick={onCancel} style={{ padding: "9px 14px", borderRadius: 8, border: `1px solid ${t.border}`, background: t.panel, color: t.fg }}>Cancel</button>
          <button type="submit" style={{ padding: "9px 14px", borderRadius: 8, border: 0, background: t.highlight, color: t.highlightFg, fontWeight: 650 }}>Connect</button>
        </div>
      </form>
    </div>
  );
}
