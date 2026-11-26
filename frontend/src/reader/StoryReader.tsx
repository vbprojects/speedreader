import { useEffect, useRef, useState } from "react";
import type { LibraryStore } from "../library/store";
import type { Theme } from "../settings/types";
import { TextInputInteraction } from "../interactions/TextInputInteraction";
import { ContinueInteraction } from "../interactions/ContinueInteraction";
import { readStory, restore, respond, start, checkpoint, type Story } from "../ingestion/sugarcube/runtime";

type Session = ReturnType<typeof restore> & { story: Story; hash: string; title: string }

export function StoryReader({ library, bookId, theme, onBack }: {
  library: LibraryStore; bookId: string; theme: Theme; onBack: () => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sourceInfo, setSourceInfo] = useState<Pick<Session, "story" | "hash" | "title"> | null>(null);
  const savedRevision = useRef<string | null>(null);
  const lock = useRef(false);
  useEffect(() => {
    let active = true;
    async function load() {
      const [source, state] = await Promise.all([library.getSugarCubeSource(bookId), library.getReaderState(bookId)]);
      if (!source) throw new Error("Story source is missing. Import the HTML file again.");
      const story = readStory(source);
      if (!active) return;
      savedRevision.current = typeof state?.formatState?.revision === "string" ? state.formatState.revision : null;
      setSourceInfo({ story, hash: source.sourceHash, title: source.story.title });
      const loaded = restore(story, source.sourceHash, state?.formatState);
      if (active) setSession({ ...loaded, story, hash: source.sourceHash, title: source.story.title });
    }
    void load().catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [library, bookId]);

  async function act(id: string, answer?: string) {
    if (!session || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const action = session.turn.parts.find(part => typeof part !== "string" && part.id === id);
      const turn = respond(session.story, session.turn, id, answer);
      const events = action && typeof action !== "string" && action.target ? [] : [...session.events, { id, answer }];
      const revision = crypto.randomUUID();
      await library.saveStoryTurn(bookId, checkpoint(session.hash, turn, events, revision), session.revision);
      savedRevision.current = revision;
      setSession({ ...session, turn, events, revision });
    } catch (cause) { setError(String(cause)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <main style={{ maxWidth: "48rem", margin: "auto", padding: "1rem" }}>
    <button onClick={onBack} disabled={busy}>← Library</button>
    <button disabled={busy || !sourceInfo} onClick={async () => {
      if (!sourceInfo || lock.current || !window.confirm("Restart this story and clear its saved progress?")) return;
      lock.current = true;
      setBusy(true);
      try {
        const turn = start(sourceInfo.story);
        const revision = crypto.randomUUID();
        await library.saveStoryTurn(bookId, checkpoint(sourceInfo.hash, turn, [], revision), savedRevision.current);
        savedRevision.current = revision;
        setSession({ ...sourceInfo, turn, events: [], revision });
        setError("");
      } catch (cause) { setError(String(cause)); }
      finally { lock.current = false; setBusy(false); }
    }}>Restart story</button>
    {error && <p role="alert">{error}</p>}
    {session ? <>
      <h1>{session.title}</h1><h2>{session.turn.passage}</h2>
      <article style={{ whiteSpace: "pre-wrap" }}>{session.turn.parts.map((part, i) => typeof part === "string" ? part :
        part.kind === "text-input"
          ? <TextInputInteraction key={session.turn.passage + ":" + i} inline theme={theme} interaction={part} busy={busy} onSubmit={response => act(part.id, response.value)} />
          : <ContinueInteraction key={session.turn.passage + ":" + i} inline theme={theme} interaction={part} busy={busy} onSubmit={() => act(part.id)} />
      )}</article>
    </> : !error && <p role="status">Loading story…</p>}
  </main>;
}
