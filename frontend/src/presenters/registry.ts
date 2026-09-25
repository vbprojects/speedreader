import { standardPresentations } from "./standard";
import type { WordStream } from "../epub/types";
import type { ReaderEngineEvent } from "../engine-events/types";
import { validateInteractions } from "../interactions/validation";
import { validatePresentations } from "../presentation/validation";
import { validateEngineTriggers } from "../engine-events/validation";
import { epubBlocks, validateBlocks } from "./blocks";
import { STANDARD, type Presenter, type PresenterSelection, type PresenterSession, type RangeLayout } from "./types";

export interface PresentedStream { stream: WordStream; layouts: RangeLayout[]; }
export function sourceCapabilities(format: string): string[] {
  return format === "epub" ? ["epub"] : format === "bluesky-jetstream" ? ["posts"] : [];
}
export class PresenterRegistry {
  private plugins = new Map<string, Presenter>();
  register(plugin: Presenter): void {
    if (!/^[a-z][a-z0-9-]*$/.test(plugin.manifest.id) || this.plugins.has(plugin.manifest.id)) throw Error("Invalid or duplicate presenter");
    this.plugins.set(plugin.manifest.id, plugin);
  }
  compatible(capabilities: string[]) {
    return [...this.plugins.values()].filter(plugin => plugin.manifest.capabilities.every(cap => capabilities.includes(cap))).map(plugin => plugin.manifest);
  }
  open(selection: PresenterSelection, capabilities: string[]): PresenterPipeline {
    const ids = [...(selection.layout === "standard" ? [] : [selection.layout]), ...selection.behaviors];
    if (new Set(ids).size !== ids.length) throw Error("Duplicate presenter selection");
    const sessions: { id: string; role: string; session: PresenterSession }[] = [];
    try {
      for (const id of ids) {
        const plugin = this.plugins.get(id);
        if (!plugin || !plugin.manifest.capabilities.every(cap => capabilities.includes(cap)) ||
          plugin.manifest.role !== (id === selection.layout ? "layout" : "behavior")) throw Error("Reading experience is unavailable for this source");
        sessions.push({ id, role: plugin.manifest.role, session: plugin.open() });
      }
      return new PresenterPipeline(sessions);
    } catch (error) { sessions.forEach(entry => entry.session.dispose()); throw error; }
  }
}
export class PresenterPipeline {
  private abort?: AbortController;
  private disposed = false;
  private owners = new Map<string, { session: PresenterSession; localId: string }>();
  constructor(private sessions: { id: string; role: string; session: PresenterSession }[]) {}
  async update(canonical: WordStream): Promise<PresentedStream> {
    if (this.disposed) throw new DOMException("Presenter session disposed", "AbortError");
    this.abort?.abort();
    const abort = new AbortController(); this.abort = abort;
    const owners = new Map<string, { session: PresenterSession; localId: string }>();
    const layouts: RangeLayout[] = [];
    const interactions = [...(canonical.interactions ?? [])], presentations = standardPresentations(canonical), triggers = [...(canonical.triggers ?? [])];
    for (const entry of this.sessions) {
      const output = await entry.session.update(canonical, abort.signal);
      if (abort.signal.aborted || this.disposed) throw new DOMException("Presenter update cancelled", "AbortError");
      const own = <T extends { id: string }>(value: T): T => {
        const id = `presenter:${entry.id}:${value.id}`;
        if (owners.has(id) || [...interactions, ...presentations, ...triggers].some(item => item.id === id)) throw Error("Duplicate presenter item");
        owners.set(id, { session: entry.session, localId: value.id });
        return { ...value, id };
      };
      if (entry.role !== "layout" && output.layouts?.length) throw Error("Only a layout presenter can supply ranges");
      layouts.push(...validateBlocks(output.layouts ?? [], canonical.words.length).map(block => ({ ...own(block), owner: entry.id })));
      interactions.push(...validateInteractions(output.interactions ?? [], canonical.words.length).map(own));
      presentations.push(...validatePresentations(output.presentations ?? [], canonical.words.length).map(own));
      triggers.push(...validateEngineTriggers(output.triggers ?? [], canonical.words.length).map(own));
    }
    if (abort.signal.aborted || this.disposed) throw new DOMException("Presenter update cancelled", "AbortError");
    this.owners = owners;
    const hidden = new Set(layouts.flatMap(block => block.presentationIds ?? []));
    return { stream: { ...canonical,
      interactions: interactions.length === (canonical.interactions?.length ?? 0) ? canonical.interactions : interactions.sort((a,b) => a.boundary-b.boundary),
      presentations: presentations.filter(p => !hidden.has(p.id)).sort((a,b) => a.boundary-b.boundary),
      triggers: triggers.length === (canonical.triggers?.length ?? 0) ? canonical.triggers : triggers.sort((a,b) => a.boundary-b.boundary) }, layouts };
  }
  async handleEvent(event: ReaderEngineEvent): Promise<boolean> {
    if (this.disposed) return false;
    const id = event.kind === "trigger" ? event.triggerId : event.interactionId;
    const owner = this.owners.get(id);
    if (!owner) return false;
    const local = event.kind === "trigger" ? { ...event, triggerId: owner.localId } :
      { ...event, interactionId: owner.localId, response: { ...event.response, interactionId: owner.localId } };
    await owner.session.handleEvent?.(local);
    if (this.disposed) throw new DOMException("Presenter event cancelled", "AbortError");
    return true;
  }
  dispose() { if (this.disposed) return; this.disposed = true; this.abort?.abort(); this.owners.clear(); this.sessions.forEach(entry => entry.session.dispose()); }
}
export const presenters = new PresenterRegistry();
presenters.register({ manifest: { id: "book-layout", version: 1, label: "Book layout", role: "layout", capabilities: ["epub"] },
  open: () => ({ update: stream => ({ layouts: epubBlocks(stream) }), dispose() {} }) });
presenters.register({ manifest: { id: "post-cards", version: 1, label: "Post cards", role: "layout", capabilities: ["posts"] },
  open: () => ({ update: stream => ({ layouts: (stream.blocks ?? []).filter(block => block.kind === "post") }), dispose() {} }) });
export { STANDARD };
