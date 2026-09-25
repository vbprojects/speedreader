import type { WordStream } from "../epub/types";
import type { ReaderInteraction } from "../interactions/types";
import type { EngineTrigger, ReaderEngineEvent } from "../engine-events/types";
import type { HtmlPresentation } from "../presentation/types";

export interface SemanticBlock {
  id: string;
  sourceRef: string;
  kind: "heading" | "paragraph" | "post";
  start: number;
  end: number;
  level?: number;
  author?: string;
  authorBoundary?: number;
  reposter?: string;
  timestamp?: string;
  url?: string;
  /** Legacy chrome suppressed only when this block receives a card. */
  presentationIds?: string[];
}
export interface RangeLayout extends SemanticBlock { owner: string; }
export interface PresenterSelection { layout: string; behaviors: string[]; }
export const STANDARD: PresenterSelection = { layout: "standard", behaviors: [] };
export interface PresenterManifest {
  id: string;
  version: number;
  label: string;
  role: "layout" | "behavior";
  capabilities: string[];
}
export interface PresenterOutput {
  layouts?: SemanticBlock[];
  interactions?: ReaderInteraction[];
  presentations?: HtmlPresentation[];
  triggers?: EngineTrigger[];
}
export interface PresenterSession {
  update(stream: WordStream, signal: AbortSignal): PresenterOutput | Promise<PresenterOutput>;
  handleEvent?(event: ReaderEngineEvent): void | Promise<void>;
  dispose(): void;
}
export interface Presenter {
  manifest: PresenterManifest;
  open(): PresenterSession;
}
