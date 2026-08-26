export const JETSTREAM_FORMAT = "bluesky-jetstream";

export const JETSTREAM_ENDPOINTS = [
  "wss://jetstream2.us-west.bsky.network/subscribe",
  "wss://jetstream1.us-west.bsky.network/subscribe",
  "wss://jetstream2.us-east.bsky.network/subscribe",
  "wss://jetstream1.us-east.bsky.network/subscribe",
] as const;

export interface JetstreamCommit {
  rev: string;
  operation: "create" | "update" | "delete";
  collection: string;
  rkey: string;
  cid?: string;
  record?: Record<string, unknown>;
}

export interface JetstreamEvent {
  did: string;
  time_us: number;
  cursor?: number;
  kind: "commit" | "identity" | "account";
  commit?: JetstreamCommit;
  identity?: Record<string, unknown>;
  account?: Record<string, unknown>;
}

export interface JetstreamPostEvent extends JetstreamEvent {
  kind: "commit";
  commit: JetstreamCommit & {
    operation: "create";
    collection: "app.bsky.feed.post";
    record: Record<string, unknown> & { $type: "app.bsky.feed.post"; text: string };
  };
}

export interface JetstreamState extends Record<string, unknown> {
  schemaVersion: 1;
  cursor?: number;
  cursorKind?: "sequence" | "time-us";
  lastTimeUs?: number;
  recentEventKeys: string[];
  acceptedPostCount: number;
}

export interface JetstreamInput {
  endpoints?: string[];
  hideSelfLabeledSensitivePosts?: boolean;
}
