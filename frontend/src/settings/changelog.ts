// src/settings/changelog.ts
// Utility to extract the latest entry from ChangeLog.md bundled as raw text.

import rawChangeLog from "../../../ChangeLog.md?raw";

export interface ChangeLogEntry {
  date: string;
  title: string;
  body: string;
}

export function getLatestChangeLog(): ChangeLogEntry | null {
  try {
    const parts = rawChangeLog.split(/\n---\n+/);
    // Index 0 is header "# ChangeLog ...", index 1 is first (latest) entry
    const latestRaw = parts.find((p) => p.trim().startsWith("## "));
    if (!latestRaw) return null;

    const trimmed = latestRaw.trim();
    const lines = trimmed.split("\n");
    const headerLine = lines[0] ?? "";
    const body = lines.slice(1).join("\n").trim();

    // Format: "## YYYY-MM-DD — Title"
    const match = headerLine.match(/^##\s+([\d-]+)\s+—\s+(.*)$/);
    if (match) {
      return {
        date: match[1],
        title: match[2],
        body,
      };
    }

    return {
      date: "",
      title: headerLine.replace(/^##\s+/, ""),
      body,
    };
  } catch {
    return null;
  }
}
