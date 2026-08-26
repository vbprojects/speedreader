import type { JetstreamCommit, JetstreamEvent, JetstreamPostEvent } from "./types";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function decodeJetstreamEvent(raw: string): JetstreamEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const value = record(parsed);
  if (!value || typeof value.did !== "string" || !Number.isFinite(value.time_us)) return null;
  if (value.cursor !== undefined && !Number.isFinite(value.cursor)) return null;
  const base = {
    did: value.did,
    time_us: value.time_us as number,
    ...(value.cursor !== undefined ? { cursor: value.cursor as number } : {}),
  };
  if (value.kind === "identity") {
    const identity = record(value.identity);
    return identity ? { ...base, kind: "identity", identity } : null;
  }
  if (value.kind === "account") {
    const account = record(value.account);
    return account ? { ...base, kind: "account", account } : null;
  }
  if (value.kind !== "commit") return null;
  const commitValue = record(value.commit);
  if (!commitValue || typeof commitValue.rev !== "string" || typeof commitValue.collection !== "string" || typeof commitValue.rkey !== "string") return null;
  if (commitValue.operation !== "create" && commitValue.operation !== "update" && commitValue.operation !== "delete") return null;
  const commit: JetstreamCommit = {
    rev: commitValue.rev,
    operation: commitValue.operation,
    collection: commitValue.collection,
    rkey: commitValue.rkey,
    ...(typeof commitValue.cid === "string" ? { cid: commitValue.cid } : {}),
    ...(record(commitValue.record) ? { record: record(commitValue.record)! } : {}),
  };
  return { ...base, kind: "commit", commit };
}

export function asTextPost(event: JetstreamEvent): JetstreamPostEvent | null {
  if (event.kind !== "commit" || !event.commit) return null;
  const { commit } = event;
  if (commit.operation !== "create" || commit.collection !== "app.bsky.feed.post" || !commit.record) return null;
  if (commit.record.$type !== "app.bsky.feed.post" || typeof commit.record.text !== "string" || commit.record.text.trim().length === 0) return null;
  return event as JetstreamPostEvent;
}

/** Jetstream preserves the post record's author-supplied BCP-47 language tags. */
export function hasEnglishLanguageTag(event: JetstreamPostEvent): boolean {
  const { langs } = event.commit.record;
  return Array.isArray(langs) && langs.some((lang) =>
    typeof lang === "string" && /^en(?:-|$)/i.test(lang.trim())
  );
}

export function jetstreamEventKey(event: JetstreamPostEvent): string {
  const commit = event.commit;
  return [event.did, commit.collection, commit.rkey, commit.cid ?? commit.rev].join("/");
}
