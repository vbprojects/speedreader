import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { JetstreamClient, type JetstreamSocket } from "./client";
import { asRepost, asTextPost, decodeJetstreamEvent, hasEnglishLanguageTag, jetstreamEventKey } from "./decode";
import { formatJetstreamPost, stripWebUrls } from "./formatter";
import { hasSensitiveSelfLabel } from "./sensitive-filter";
import { BlueskyJetstreamFormat } from "./format";
import type { JetstreamEnricher } from "./enrichment";

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
      record: { $type: "app.bsky.feed.post", text: "Hello   <b>world</b>", langs: ["en"] },
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
  const repost = decodeJetstreamEvent(JSON.stringify(post({
    collection: "app.bsky.feed.repost",
    record: { $type: "app.bsky.feed.repost", subject: { uri: "at://did:plc:original/app.bsky.feed.post/1", cid: "original-cid" } },
  })))!;
  equal(asRepost(repost)?.commit.record.subject.uri, "at://did:plc:original/app.bsky.feed.post/1");
  equal(decodeJetstreamEvent("not json"), null);
  ok(decodeJetstreamEvent(JSON.stringify({ did: "did:plc:x", time_us: 2, kind: "identity", identity: { handle: "x.test" } })));
  ok(decodeJetstreamEvent(JSON.stringify({ did: "did:plc:x", time_us: 3, kind: "account", account: { active: true } })));
});

test("formatter emits only visible post text without identity or URLs", () => {
  const event = asTextPost(decodeJetstreamEvent(JSON.stringify(post({
    record: { $type: "app.bsky.feed.post", text: "Read https://example.com/a?q=1 then www.example.org now", langs: ["en"] },
  })))!)!;
  deepStrictEqual(formatJetstreamPost(event).map((word) => word.text), ["Read", "then", "now"]);
  ok(formatJetstreamPost(event).every((word) => word.formatting === undefined));
  equal(stripWebUrls("https://example.com www.example.org"), "");
  const urlOnly = asTextPost(decodeJetstreamEvent(JSON.stringify(post({
    record: { $type: "app.bsky.feed.post", text: "https://example.com", langs: ["en"] },
  })))!)!;
  deepStrictEqual(formatJetstreamPost(urlOnly), []);
});

test("English filtering uses explicit BCP-47 post language tags", () => {
  const tagged = (langs: unknown) => asTextPost(decodeJetstreamEvent(JSON.stringify(post({
    record: { $type: "app.bsky.feed.post", text: "hello", ...(langs === undefined ? {} : { langs }) },
  })))!)!;
  equal(hasEnglishLanguageTag(tagged(["en"])), true);
  equal(hasEnglishLanguageTag(tagged(["en-US"])), true);
  equal(hasEnglishLanguageTag(tagged(["EN-gb"])), true);
  equal(hasEnglishLanguageTag(tagged(["fr", "de"])), false);
  equal(hasEnglishLanguageTag(tagged(undefined)), false);
  equal(hasEnglishLanguageTag(tagged("en")), false);
});

test("sensitive filter handles known, absent, unknown, and malformed self-labels", () => {
  const eventWithLabels = (labels: unknown) => asTextPost(decodeJetstreamEvent(JSON.stringify(post({
    record: { $type: "app.bsky.feed.post", text: "hello", langs: ["en"], ...(labels === undefined ? {} : { labels }) },
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
  match(urls[0], /wantedCollections=app\.bsky\.feed\.repost/);
  match(urls[0], /cursor=99/);
  sockets[0].onmessage?.({ data: JSON.stringify(post()) });
  deepStrictEqual(events, [12345]);
  client.dispose();
});

test("live format batches plain posts, filters sensitive posts, and persists the last cursor", async () => {
  let socket: JetstreamSocket | null = null;
  const quotedUri = "at://did:plc:quoted/app.bsky.feed.post/quoted";
  const repostedUri = "at://did:plc:original/app.bsky.feed.post/original";
  const enricher: JetstreamEnricher = {
    async actor(did) {
      return { did, handle: did === "did:plc:reposter" ? "reposter.test" : "reader.test" };
    },
    async post(uri) {
      if (uri === quotedUri) return { uri, author: { did: "did:plc:quoted", handle: "quoted.test" }, text: "Quoted words", langs: ["en"] };
      if (uri === repostedUri) return { uri, author: { did: "did:plc:original", handle: "original.test" }, text: "Original repost", langs: ["en"] };
      return null;
    },
  };
  const format = new BlueskyJetstreamFormat(() => {
    socket = { onopen: null, onmessage: null, onerror: null, onclose: null, close() {} };
    return socket;
  }, enricher);
  await format.init({ hideSelfLabeledSensitivePosts: true });
  const chunks: Array<{
    words: string[];
    presentations: Array<{ boundary: number; html: string }>;
    cursor?: number;
  }> = [];
  const stop = format.startStreaming(0, (chunk) => {
    chunks.push({
      words: chunk.words.map((word) => word.text),
      presentations: (chunk.presentations ?? []).map((presentation) => ({
        boundary: presentation.boundary,
        html: presentation.html,
      })),
      cursor: chunk.state.cursor,
    });
  }, () => undefined);
  const normal = post();
  const sensitive = post({
    rkey: "post2",
    cid: "cid2",
    record: { $type: "app.bsky.feed.post", text: "hidden", langs: ["en"], labels: { values: [{ val: "sexual" }] } },
  });
  (sensitive as { cursor: number }).cursor = 12346;
  const nonEnglish = post({
    rkey: "post3",
    cid: "cid3",
    record: { $type: "app.bsky.feed.post", text: "bonjour", langs: ["fr"] },
  });
  (nonEnglish as { cursor: number }).cursor = 12347;
  const secondNormal = post({
    rkey: "post4",
    cid: "cid4",
    record: {
      $type: "app.bsky.feed.post",
      text: "Second post",
      langs: ["en"],
      embed: { $type: "app.bsky.embed.record", record: { uri: quotedUri, cid: "quoted-cid" } },
    },
  });
  (secondNormal as { cursor: number }).cursor = 12348;
  const repost = {
    did: "did:plc:reposter",
    time_us: 1725911162329310,
    cursor: 12349,
    kind: "commit",
    commit: {
      rev: "rev-repost",
      operation: "create",
      collection: "app.bsky.feed.repost",
      rkey: "repost1",
      cid: "repost-cid",
      record: { $type: "app.bsky.feed.repost", subject: { uri: repostedUri, cid: "original-cid" } },
    },
  };
  ok(socket);
  (socket as JetstreamSocket).onmessage?.({ data: JSON.stringify(normal) });
  (socket as JetstreamSocket).onmessage?.({ data: JSON.stringify(sensitive) });
  (socket as JetstreamSocket).onmessage?.({ data: JSON.stringify(nonEnglish) });
  (socket as JetstreamSocket).onmessage?.({ data: JSON.stringify(secondNormal) });
  (socket as JetstreamSocket).onmessage?.({ data: JSON.stringify(repost) });
  await new Promise((resolve) => setTimeout(resolve, 320));
  stop();
  equal(chunks.length, 1);
  deepStrictEqual(chunks[0].words, ["Hello", "<b>world</b>", "Quoted", "words", "Second", "post", "Original", "repost"]);
  deepStrictEqual(chunks[0].presentations, [
    { boundary: 0, html: "<p><strong>@reader.test</strong></p>" },
    { boundary: 2, html: "<br><hr><br>" },
    { boundary: 2, html: "<p><strong>@quoted.test</strong> · quoted</p>" },
    { boundary: 4, html: "<br>" },
    { boundary: 4, html: "<p><strong>@reader.test</strong></p>" },
    { boundary: 6, html: "<br><hr><br>" },
    { boundary: 6, html: "<p><strong>@reposter.test</strong> reposted</p>" },
    { boundary: 6, html: "<p><strong>@original.test</strong></p>" },
    { boundary: 8, html: "<br><hr><br>" },
  ]);
  equal(chunks[0].cursor, 12349);
});
