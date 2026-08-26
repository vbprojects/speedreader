import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { JetstreamClient, type JetstreamSocket } from "./client";
import { asTextPost, decodeJetstreamEvent, jetstreamEventKey } from "./decode";
import { formatJetstreamPost } from "./formatter";
import { hasSensitiveSelfLabel } from "./sensitive-filter";
import { BlueskyJetstreamFormat } from "./format";

function post(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    did: "did:plc:reader",
    time_us: 1725911162329308,
    cursor: 12345,
    kind: "commit",
    commit: {
      rev: "rev1",
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "post1",
      cid: "cid1",
      record: { $type: "app.bsky.feed.post", text: "Hello   <b>world</b>" },
      ...overrides,
    },
  };
}

test("Jetstream decoder accepts text creates and rejects unrelated variants", () => {
  const event = decodeJetstreamEvent(JSON.stringify(post()));
  ok(event);
  const textPost = asTextPost(event);
  ok(textPost);
  equal(jetstreamEventKey(textPost), "did:plc:reader/app.bsky.feed.post/post1/cid1");
  equal(asTextPost(decodeJetstreamEvent(JSON.stringify(post({ operation: "update" })))!), null);
  equal(asTextPost(decodeJetstreamEvent(JSON.stringify(post({ operation: "delete", record: undefined })))!), null);
  equal(asTextPost(decodeJetstreamEvent(JSON.stringify(post({ collection: "app.bsky.feed.like" })))!), null);
  equal(decodeJetstreamEvent("not json"), null);
  ok(decodeJetstreamEvent(JSON.stringify({ did: "did:plc:x", time_us: 2, kind: "identity", identity: { handle: "x.test" } })));
  ok(decodeJetstreamEvent(JSON.stringify({ did: "did:plc:x", time_us: 3, kind: "account", account: { active: true } })));
});

test("formatter emits only DID, separator, and literal normalized text", () => {
  const event = asTextPost(decodeJetstreamEvent(JSON.stringify(post()))!)!;
  deepStrictEqual(formatJetstreamPost(event).map((word) => word.text), ["did:plc:reader", ":", "Hello", "<b>world</b>"]);
});

test("sensitive filter handles known, absent, unknown, and malformed self-labels", () => {
  const eventWithLabels = (labels: unknown) => asTextPost(decodeJetstreamEvent(JSON.stringify(post({
    record: { $type: "app.bsky.feed.post", text: "hello", ...(labels === undefined ? {} : { labels }) },
  })))!)!;
  equal(hasSensitiveSelfLabel(eventWithLabels(undefined)), false);
  equal(hasSensitiveSelfLabel(eventWithLabels({ values: [{ val: "porn" }] })), true);
  equal(hasSensitiveSelfLabel(eventWithLabels({ values: [{ val: "topic-tag" }] })), false);
  equal(hasSensitiveSelfLabel(eventWithLabels({ nope: [] })), true);
});

test("client requests JSON posts and advances its resume cursor", () => {
  const urls: string[] = [];
  const sockets: JetstreamSocket[] = [];
  const events: number[] = [];
  const factory = (url: string): JetstreamSocket => {
    urls.push(url);
    const socket: JetstreamSocket = { onopen: null, onmessage: null, onerror: null, onclose: null, close() {} };
    sockets.push(socket);
    return socket;
  };
  const client = new JetstreamClient({ endpoints: ["wss://example.test/subscribe"], cursor: 99, socketFactory: factory, onEvent: (event) => events.push(event.cursor ?? 0), onError: () => undefined });
  client.start();
  match(urls[0], /wantedCollections=app\.bsky\.feed\.post/);
  match(urls[0], /cursor=99/);
  sockets[0].onmessage?.({ data: JSON.stringify(post()) });
  deepStrictEqual(events, [12345]);
  client.dispose();
});

test("live format batches plain posts, filters sensitive posts, and persists the last cursor", async () => {
  let socket: JetstreamSocket | null = null;
  const format = new BlueskyJetstreamFormat(() => {
    socket = { onopen: null, onmessage: null, onerror: null, onclose: null, close() {} };
    return socket;
  });
  await format.init({ hideSelfLabeledSensitivePosts: true });
  const chunks: Array<{ words: string[]; cursor?: number }> = [];
  const stop = format.startStreaming(0, (chunk) => {
    chunks.push({ words: chunk.words.map((word) => word.text), cursor: chunk.state.cursor });
  }, () => undefined);
  const normal = post();
  const sensitive = post({
    rkey: "post2",
    cid: "cid2",
    record: { $type: "app.bsky.feed.post", text: "hidden", labels: { values: [{ val: "sexual" }] } },
  });
  (sensitive as { cursor: number }).cursor = 12346;
  ok(socket);
  (socket as JetstreamSocket).onmessage?.({ data: JSON.stringify(normal) });
  (socket as JetstreamSocket).onmessage?.({ data: JSON.stringify(sensitive) });
  await new Promise((resolve) => setTimeout(resolve, 320));
  stop();
  equal(chunks.length, 1);
  deepStrictEqual(chunks[0].words, ["did:plc:reader", ":", "Hello", "<b>world</b>"]);
  equal(chunks[0].cursor, 12346);
});
