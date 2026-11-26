import type { ContinueInteraction, TextInputInteraction } from "../../interactions/types";
import type { StoredSugarCubeSource } from "./types";

import { elementAction } from "./element-actions";
import { value, type Variables } from "./expression";

type Action = (ContinueInteraction | TextInputInteraction) & {
  target?: string;
  setter?: string;
  variable?: string;
  reveal?: string;
  retainLabel?: boolean;
};
export type Part = string | Action;
export interface Turn {
  passage: string;
  entryVariables: Variables;
  variables: Variables;
  parts: Part[];
  nextId: number;
}
export interface Story {
  first: string;
  passages: Map<string, string>;
}

export function readStory(source: StoredSugarCubeSource): Story {
  const doc = new DOMParser().parseFromString(source.html, "text/html");
  const passages = new Map<string, string>();
  let first = "";
  for (const element of doc.querySelectorAll("tw-storydata > tw-passagedata")) {
    const name = element.getAttribute("name");
    if (!name || passages.has(name)) throw new Error("Missing or duplicate passage name.");
    passages.set(name, element.textContent ?? "");
    if (element.getAttribute("pid") === source.story.startNode) first = name;
  }
  if (!first) throw new Error("Story start passage is missing.");
  return { first, passages };
}

function assign(source: string, variables: Variables) {
  const statements = /\s*(\$\w+)\s*(to\b|\+=|-=|=)\s*("[^"]*"|'[^']*'|[^,;]+?)\s*(?:[,;]|$)/gy;
  let offset = 0;
  while (offset < source.trimEnd().length) {
    const match = statements.exec(source);
    if (!match) throw new Error("Unsupported assignment: " + source.slice(offset));
    const [, name, operator, rhs] = match;
    const result = value(rhs, variables);
    const previous = variables[name];
    if (operator === "+=" && (typeof result === "string" || typeof previous === "string")) variables[name] = String(previous ?? "") + result;
    else if (operator === "+=" || operator === "-=") variables[name] = Number(previous ?? 0) + (operator === "+=" ? 1 : -1) * Number(result);
    else variables[name] = result;
    offset = statements.lastIndex;
  }
}

function render(source: string, turn: Turn): Part[] {
  const parts: Part[] = [];
  const branches: { active: boolean; matched: boolean }[] = [];
  const visible = () => branches.every(branch => branch.active);
  const prose = (raw: string) => {
    if (raw && visible()) parts.push(raw.replace(/\$\w+/g, name => String(turn.variables[name] ?? "")));
  };
  const tokens = /<<(?<control>linkappend|linkreplace|link|button)\s+"(?<label>[^"]*)"(?:\s+"(?<destination>[^"]+)")?\s*>>(?<body>[\s\S]*?)<<\/\k<control>>>|<<(?<macro>[\s\S]+?)>>|\[\[(?<link>[^\]]+)(?:\]\[(?<setter>[^\]]+))?\]\]|<(?<tag>[a-z][\w.-]*-[\w.-]+)\b[^>]*>[\s\S]*?<\/\k<tag>>/gi;
  let offset = 0;
  for (const match of source.matchAll(tokens)) {
    prose(source.slice(offset, match.index));
    offset = match.index! + match[0].length;
    const { control, label, destination, body, macro, link, setter, tag } = match.groups!;
    const base = { schemaVersion: 1 as const, boundary: 0, id: String(turn.nextId++) };
    if (macro?.startsWith("if ")) {
      const active = visible() && Boolean(value(macro.slice(3), turn.variables));
      branches.push({ active, matched: active });
    } else if (macro?.startsWith("elseif ")) {
      const branch = branches.pop();
      if (!branch) throw new Error("Unexpected elseif");
      const active = visible() && !branch.matched && Boolean(value(macro.slice(7), turn.variables));
      branches.push({ active, matched: active || branch.matched });
    } else if (macro === "else" || macro === "/if" || macro === "endif") {
      if (!branches.length) throw new Error("Unexpected " + macro);
      if (macro === "else") {
        const branch = branches[branches.length - 1];
        branch.active = !branch.matched;
        branch.matched = true;
      }
      else branches.pop();
    } else if (!visible()) continue;
    else if (control) {
      parts.push({ ...base, kind: "continue", label, target: destination, reveal: body, retainLabel: control === "linkappend" });
    }
    else if (link) {
      const [a, b] = link.split(/->|<-|\|/);
      const reversed = link.includes("<-");
      parts.push({ ...base, kind: "continue", label: (reversed ? b : a).trim(), target: (reversed ? a : b ?? a).trim(), setter });
    } else if (tag) {
      parts.push({ ...base, ...elementAction(match[0]) });
    } else if (macro.startsWith("set ")) assign(macro.slice(4), turn.variables);
    else if (/^(=|print )/.test(macro)) parts.push(String(value(macro.replace(/^(=|print )/, ""), turn.variables)));
    else {
      const input = /^textbox\s+"(\$\w+)"\s+"([^"]*)"(?:\s+"([^"]+)")?(?:\s+autofocus)?$/.exec(macro);
      if (!input) throw new Error("Unsupported SugarCube macro: " + macro);
      turn.variables[input[1]] = input[2];
      parts.push({ ...base, kind: "text-input", variable: input[1], defaultValue: input[2], label: input[1].slice(1), target: input[3] });
    }
  }
  if (branches.length) throw new Error("Unclosed SugarCube conditional.");
  prose(source.slice(offset));
  return parts;
}

function enter(story: Story, passage: string, variables: Variables): Turn {
  const body = story.passages.get(passage);
  if (body === undefined) throw new Error("Missing passage: " + passage);
  const turn: Turn = { passage, entryVariables: { ...variables }, variables, parts: [], nextId: 0 };
  turn.parts = render(body, turn);
  return turn;
}

export function start(story: Story): Turn {
  const variables: Variables = {};
  if (story.passages.has("StoryInit")) enter(story, "StoryInit", variables);
  return enter(story, story.first, variables);
}

export function respond(story: Story, current: Turn, id: string, answer?: string): Turn {
  const turn = structuredClone(current);
  const index = turn.parts.findIndex(part => typeof part !== "string" && part.id === id);
  const action = turn.parts[index];
  if (!action || typeof action === "string") throw new Error("Unknown story action.");
  if (action.variable) turn.variables[action.variable] = answer ?? "";
  if (action.setter) assign(action.setter, turn.variables);
  const replacement = action.reveal === undefined ? [answer ?? ""] : render(action.reveal, turn);
  if (action.target) return enter(story, action.target, turn.variables);
  if (action.retainLabel) replacement.unshift(action.label ?? "");
  turn.parts.splice(index, 1, ...replacement);
  return turn;
}

export interface StoryEvent { id: string; answer?: string }
export function checkpoint(sourceHash: string, turn: Turn, events: StoryEvent[], revision: string) {
  return { schemaVersion: 1, sourceHash, passage: turn.passage, variables: turn.entryVariables, events, revision };
}

export function restore(story: Story, sourceHash: string, saved?: Record<string, unknown>) {
  if (!saved) return { turn: start(story), events: [] as StoryEvent[], revision: null };
  const { passage, variables, events, revision } = saved;
  if (saved.schemaVersion !== 1 || saved.sourceHash !== sourceHash || typeof passage !== "string"
    || !variables || typeof variables !== "object" || Array.isArray(variables) || !Array.isArray(events)
    || typeof revision !== "string") throw new Error("Incompatible story save. Restart the book to begin again.");
  const entry: Variables = {};
  for (const [name, item] of Object.entries(variables)) {
    if (!/^\$\w+$/.test(name) || !["boolean", "number", "string"].includes(typeof item)) throw new Error("Invalid saved variable.");
    entry[name] = item;
  }
  let turn = enter(story, passage, entry);
  const restored: StoryEvent[] = [];
  for (const event of events) {
    if (!event || typeof event.id !== "string" || (event.answer !== undefined && typeof event.answer !== "string")) throw new Error("Invalid saved action.");
    turn = respond(story, turn, event.id, event.answer);
    restored.push({ id: event.id, answer: event.answer });
  }
  return { turn, events: restored, revision };
}
