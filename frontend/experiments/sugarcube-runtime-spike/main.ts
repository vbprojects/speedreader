import fixtureHtml from "./fixture-current.html?raw";
import fixtureUrl from "./fixture-current.html?url";

type Strategy = "url" | "blob" | "srcdoc";

interface EarlyEvent {
  type: string;
  at: number;
  passage?: string;
}

interface SpikeWindow extends Window {
  SugarCube?: {
    Engine: {
      backward(): boolean;
      forward(): boolean;
      isIdle(): boolean;
      show(): unknown;
    };
    Save: {
      base64?: {
        save(metadata?: unknown): string;
        load(save: string): Promise<unknown>;
      };
      serialize?(metadata?: unknown): string | null;
      deserialize?(save: string): unknown;
    };
    State: {
      passage: string;
      turns: number;
      variables: Record<string, unknown>;
    };
    session?: {
      clear(): void;
    };
    version: { toString(): string; long(): string };
  };
  spikeStoryScriptRan?: boolean;
  __speedreaderSpikeEvents?: EarlyEvent[];
  __speedreaderSpikeErrors?: string[];
}

interface ActionDescriptor {
  id: string;
  kind: string;
  label: string;
  element: HTMLElement;
}

const strategy = document.querySelector<HTMLSelectElement>("#strategy")!;
const status = document.querySelector<HTMLElement>("#status")!;
const runtimeOutput = document.querySelector<HTMLElement>("#runtime")!;
const projectionOutput = document.querySelector<HTMLElement>("#projection")!;
const actionsOutput = document.querySelector<HTMLElement>("#actions")!;
const timelineOutput = document.querySelector<HTMLElement>("#timeline")!;
const frameSlot = document.querySelector<HTMLElement>("#frame-slot")!;

let frame: HTMLIFrameElement | null = null;
let frameUrl: string | null = null;
let mutationObserver: MutationObserver | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let currentActions = new Map<string, ActionDescriptor>();
let savedState: { api: "base64" | "legacy"; value: string } | null = null;
let frameVisible = false;
let loadStartedAt = 0;
let runtimeReadyInMs: number | null = null;
let lastSnapshotHash = "";
let duplicateSnapshots = 0;
let loadAttempt = 0;
const timeline: Array<Record<string, unknown>> = [];

function setStatus(message: string, state: "idle" | "loading" | "ready" | "error" = "idle") {
  status.textContent = message;
  status.dataset.state = state;
}

function log(type: string, detail: Record<string, unknown> = {}) {
  timeline.push({ atMs: Math.round(performance.now()), type, ...detail });
  timelineOutput.textContent = JSON.stringify(timeline.slice(-80), null, 2);
}

function instrumentStory(html: string): string {
  const bootstrap = `<script>
window.__speedreaderSpikeEvents = [];
window.__speedreaderSpikeErrors = [];
window.__speedreaderNativeListenerInstalled = true;
[":storyready", ":passageinit", ":passagestart", ":passagerender", ":passagedisplay", ":passageend", ":historyupdate", ":typingstart", ":typingcomplete"].forEach(function (type) {
  document.addEventListener(type, function (event) {
    var detail = event.detail || {};
    var passage = detail.passage && (detail.passage.name || detail.passage.title);
    window.__speedreaderSpikeEvents.push({ type: type, at: performance.now(), passage: passage });
  });
});
window.addEventListener("error", function (event) {
  window.__speedreaderSpikeErrors.push(String(event.message || event.error || "runtime error"));
});
window.addEventListener("unhandledrejection", function (event) {
  window.__speedreaderSpikeErrors.push(String(event.reason || "unhandled rejection"));
});
<\/script>`;
  return html.replace(/<head(\s[^>]*)?>/i, (match) => match + bootstrap);
}

function getRuntimeWindow(): SpikeWindow {
  if (!frame?.contentWindow) throw new Error("Runtime iframe is not loaded");
  return frame.contentWindow as SpikeWindow;
}

function activePassage(): HTMLElement | null {
  return frame?.contentDocument?.querySelector<HTMLElement>("#passages .passage:last-child") ?? null;
}

function visibleText(node: HTMLElement): string {
  const excluded = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "CANVAS", "AUDIO", "VIDEO"]);
  const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode(candidate) {
      const parent = candidate.parentElement;
      if (!parent || excluded.has(parent.tagName) || parent.closest("[hidden], [aria-hidden='true'], script, style, noscript, svg, canvas, audio, video")) {
        return NodeFilter.FILTER_REJECT;
      }
      return candidate.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const pieces: string[] = [];
  while (walker.nextNode()) pieces.push(walker.currentNode.textContent?.replace(/\s+/g, " ").trim() ?? "");
  return pieces.filter(Boolean).join(" ");
}

function actionKind(element: HTMLElement): string {
  if (element.tagName === "INPUT") return `input:${(element as HTMLInputElement).type || "text"}`;
  if (element.tagName === "TEXTAREA") return "textarea";
  if (element.tagName === "SELECT") return "select";
  if (element.tagName === "BUTTON") return "button";
  if (element.tagName === "A") return "link";
  return element.tagName.toLowerCase();
}

function actionLabel(element: HTMLElement): string {
  if (element.tagName === "INPUT") {
    const input = element as HTMLInputElement;
    if (["text", "number", "password", "email", "search", "url"].includes(input.type)) {
      return input.getAttribute("aria-label") || input.placeholder || input.value || input.name || "Text input";
    }
  }
  if (element.tagName === "SELECT") return element.getAttribute("aria-label") || (element as HTMLSelectElement).name || "Selection";
  return element.getAttribute("aria-label") || element.textContent?.replace(/\s+/g, " ").trim() || (element as HTMLInputElement).value || element.title || element.tagName;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function drainEarlyEvents(win: SpikeWindow) {
  const events = win.__speedreaderSpikeEvents?.splice(0) ?? [];
  for (const event of events) log("sugarcube-event", event as unknown as Record<string, unknown>);
}

function renderActionList(actions: ActionDescriptor[]) {
  actionsOutput.replaceChildren();
  if (actions.length === 0) {
    actionsOutput.textContent = "No live controls in the active passage.";
    return;
  }
  for (const action of actions) {
    const row = document.createElement("div");
    row.className = "action";
    const label = document.createElement("code");
    label.textContent = `${action.id} · ${action.kind} · ${action.label}`;
    const activate = document.createElement("button");
    activate.type = "button";
    activate.textContent = "Activate";
    activate.addEventListener("click", () => activateAction(action.id));
    row.append(label, activate);
    actionsOutput.append(row);
  }
}

function inspectRuntime(reason = "manual") {
  if (!frame?.contentWindow) return;
  const win = getRuntimeWindow();
  drainEarlyEvents(win);
  const sugarCube = win.SugarCube;
  const passage = activePassage();
  const text = passage ? visibleText(passage) : "";
  const passageName = sugarCube?.State.passage || passage?.dataset.passage || passage?.id || "unknown";
  const turn = sugarCube?.State.turns ?? -1;
  const controls = passage ? Array.from(passage.querySelectorAll<HTMLElement>("a, button, input, textarea, select")) : [];
  const actions = controls.map((element, index) => {
    const descriptor: ActionDescriptor = {
      id: `turn-${turn}:${passageName}:control-${index}`,
      kind: actionKind(element),
      label: actionLabel(element),
      element,
    };
    if (element.dataset.speedreaderActionId !== descriptor.id) element.dataset.speedreaderActionId = descriptor.id;
    return descriptor;
  });
  currentActions = new Map(actions.map((action) => [action.id, action]));
  const snapshotMaterial = JSON.stringify({ passageName, turn, text, actions: actions.map(({ id, kind, label }) => ({ id, kind, label })) });
  const snapshotHash = hashString(snapshotMaterial);
  if (snapshotHash === lastSnapshotHash) duplicateSnapshots += 1;
  lastSnapshotHash = snapshotHash;

  const variables = sugarCube?.State.variables ?? {};
  runtimeOutput.textContent = JSON.stringify({
    strategy: strategy.value,
    loaded: Boolean(sugarCube),
    version: sugarCube?.version.long?.() ?? sugarCube?.version.toString?.() ?? null,
    readyInMs: runtimeReadyInMs,
    engineIdle: sugarCube?.Engine.isIdle?.() ?? null,
    passage: passageName,
    turn,
    storyScriptRan: win.spikeStoryScriptRan === true,
    variables,
    saveApi: sugarCube?.Save.base64?.save ? "base64" : sugarCube?.Save.serialize ? "legacy" : "missing",
    snapshotHash,
    duplicateSnapshots,
    earlyErrors: win.__speedreaderSpikeErrors ?? [],
  }, null, 2);
  projectionOutput.textContent = text || "No projected passage text.";
  renderActionList(actions);
  log("snapshot", { reason, passage: passageName, turn, snapshotHash, controls: actions.length, textLength: text.length });
  setStatus(sugarCube && passage ? `Ready · ${passageName}` : "Runtime incomplete", sugarCube && passage ? "ready" : "error");
}

function attachMutationObserver() {
  mutationObserver?.disconnect();
  const root = frame?.contentDocument?.querySelector("#passages");
  if (!root) return;
  mutationObserver = new MutationObserver((records) => {
    const relevant = records.filter((record) => record.type === "childList" || record.type === "characterData" || (record.type === "attributes" && !["class", "style", "data-speedreader-action-id"].includes(record.attributeName ?? "")));
    if (relevant.length === 0) return;
    log("mutation-batch", { count: records.length, relevant: relevant.length });
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => inspectRuntime("mutation-settled"), 80);
  });
  mutationObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
}

function waitForRuntime(timeoutMs = 8_000): Promise<void> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        const win = getRuntimeWindow();
        if (win.SugarCube?.Engine.isIdle?.() && activePassage()) return resolve();
      } catch {
        // Navigation may temporarily make the child document unavailable.
      }
      if (performance.now() - started > timeoutMs) return reject(new Error("SugarCube did not reach an idle passage before timeout"));
      setTimeout(check, 40);
    };
    check();
  });
}

async function loadRuntime(selected: Strategy = strategy.value as Strategy, clearStorySession = false) {
  if (clearStorySession) {
    try {
      getRuntimeWindow().SugarCube?.session?.clear();
    } catch {
      // A failed/partial iframe may not expose the SugarCube session wrapper.
    }
  }
  teardownRuntime(false);
  const attempt = ++loadAttempt;
  timeline.length = 0;
  lastSnapshotHash = "";
  duplicateSnapshots = 0;
  runtimeReadyInMs = null;
  loadStartedAt = performance.now();
  setStatus("Loading SugarCube…", "loading");
  log("load-start", { strategy: selected });
  if (clearStorySession) log("story-session-cleared");

  const nextFrame = document.createElement("iframe");
  nextFrame.id = "runtime-frame";
  nextFrame.title = "SugarCube runtime fixture";
  nextFrame.dataset.visible = String(frameVisible);
  frame = nextFrame;
  frameSlot.append(nextFrame);

  const loadPromise = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      nextFrame.removeEventListener("load", onLoad);
      nextFrame.removeEventListener("error", onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Runtime iframe failed to load"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Runtime iframe did not finish navigation before timeout"));
    }, 8_000);
    nextFrame.addEventListener("load", onLoad, { once: true });
    nextFrame.addEventListener("error", onError, { once: true });
  });
  const instrumented = instrumentStory(fixtureHtml);
  if (selected === "url") {
    nextFrame.src = fixtureUrl;
  } else if (selected === "blob") {
    frameUrl = URL.createObjectURL(new Blob([instrumented], { type: "text/html" }));
    nextFrame.src = frameUrl;
  } else {
    nextFrame.srcdoc = instrumented;
  }

  try {
    await loadPromise;
    if (attempt !== loadAttempt) return false;
    log("iframe-load");
    await waitForRuntime(Math.max(1, 8_000 - (performance.now() - loadStartedAt)));
    if (attempt !== loadAttempt) return false;
    runtimeReadyInMs = Math.round(performance.now() - loadStartedAt);
    log("runtime-idle");
    attachMutationObserver();
    inspectRuntime("initial-ready");
    return true;
  } catch (error) {
    if (attempt !== loadAttempt) return false;
    const message = error instanceof Error ? error.message : String(error);
    log("load-error", { message });
    setStatus(message, "error");
    inspectRuntime("load-error");
    return false;
  }
}

function dispatchInput(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function activateAction(id: string) {
  const action = currentActions.get(id);
  if (!action || !action.element.isConnected) {
    setStatus("Selected runtime action is stale", "error");
    log("stale-action", { id });
    return;
  }
  const element = action.element;
  log("action", { id, kind: action.kind, label: action.label });
  if (element.tagName === "INPUT" && ["text", "number", "email", "search", "url", "password"].includes((element as HTMLInputElement).type)) {
    const input = element as HTMLInputElement;
    input.value = input.type === "number" ? "42" : "Codex Reader";
    dispatchInput(input);
  } else if (element.tagName === "TEXTAREA") {
    const textarea = element as HTMLTextAreaElement;
    textarea.value = "Codex Reader";
    dispatchInput(textarea);
  } else if (element.tagName === "SELECT") {
    const select = element as HTMLSelectElement;
    select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
    dispatchInput(select);
  } else {
    element.click();
  }
  setTimeout(() => inspectRuntime("action+0"), 0);
  setTimeout(() => inspectRuntime("action+120"), 120);
  setTimeout(() => inspectRuntime("action+400"), 400);
}

function saveRuntime() {
  try {
    const saveApi = getRuntimeWindow().SugarCube?.Save;
    if (saveApi?.base64?.save) savedState = { api: "base64", value: saveApi.base64.save({ spike: true }) };
    else if (saveApi?.serialize) {
      const value = saveApi.serialize({ spike: true });
      if (!value) throw new Error("Legacy Save.serialize() returned no value");
      savedState = { api: "legacy", value };
    } else throw new Error("No supported SugarCube save API was found");
    log("save", { api: savedState.api, bytes: savedState.value.length });
    setStatus(`Saved ${savedState.value.length.toLocaleString()} characters`, "ready");
    inspectRuntime("saved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("save-error", { message });
    setStatus(message, "error");
  }
}

async function restoreRuntime() {
  if (!savedState) {
    setStatus("Save the runtime first", "error");
    return;
  }
  const state = savedState;
  try {
    log("restore-start", { api: state.api, bytes: state.value.length });
    const loaded = await loadRuntime(strategy.value as Strategy, true);
    if (!loaded) throw new Error("Runtime recreation failed");
    const sugarCube = getRuntimeWindow().SugarCube;
    if (!sugarCube) throw new Error("SugarCube API missing after recreation");
    if (state.api === "base64" && sugarCube.Save.base64?.load) await sugarCube.Save.base64.load(state.value);
    else if (state.api === "legacy" && sugarCube.Save.deserialize) sugarCube.Save.deserialize(state.value);
    else throw new Error(`Saved API ${state.api} is unavailable after recreation`);
    sugarCube.Engine.show();
    await new Promise((resolve) => setTimeout(resolve, 200));
    attachMutationObserver();
    inspectRuntime("restored");
    log("restore-complete", { passage: sugarCube.State.passage, turn: sugarCube.State.turns });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("restore-error", { message });
    setStatus(message, "error");
  }
}

function teardownRuntime(updateStatus = true) {
  loadAttempt += 1;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
  mutationObserver?.disconnect();
  mutationObserver = null;
  currentActions.clear();
  frame?.remove();
  frame = null;
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = null;
  if (updateStatus) {
    setStatus("Runtime removed", "idle");
    runtimeOutput.textContent = "Not loaded.";
    projectionOutput.textContent = "Not loaded.";
    actionsOutput.textContent = "Not loaded.";
    log("teardown");
  }
}

function exportDiagnostics() {
  let runtime: unknown = runtimeOutput.textContent;
  try {
    runtime = JSON.parse(runtimeOutput.textContent || "null");
  } catch {
    // Keep the human-readable diagnostic when no runtime is loaded.
  }
  const diagnostic = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    strategy: strategy.value,
    status: status.textContent,
    runtime,
    projection: projectionOutput.textContent,
    actions: Array.from(currentActions.values(), ({ id, kind, label }) => ({ id, kind, label })),
    timeline,
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostic, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `sugarcube-spike-${Date.now()}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

document.querySelector("#load")!.addEventListener("click", () => void loadRuntime());
document.querySelector("#teardown")!.addEventListener("click", () => teardownRuntime());
document.querySelector("#save")!.addEventListener("click", saveRuntime);
document.querySelector("#restore")!.addEventListener("click", () => void restoreRuntime());
document.querySelector("#back")!.addEventListener("click", () => {
  const result = getRuntimeWindow().SugarCube?.Engine.backward();
  log("history-back", { result });
  setTimeout(() => inspectRuntime("history-back"), 160);
});
document.querySelector("#forward")!.addEventListener("click", () => {
  const result = getRuntimeWindow().SugarCube?.Engine.forward();
  log("history-forward", { result });
  setTimeout(() => inspectRuntime("history-forward"), 160);
});
document.querySelector("#visibility")!.addEventListener("click", (event) => {
  frameVisible = !frameVisible;
  if (frame) frame.dataset.visible = String(frameVisible);
  (event.currentTarget as HTMLButtonElement).textContent = frameVisible ? "Hide iframe" : "Show iframe";
});
document.querySelector("#diagnostics")!.addEventListener("click", () => inspectRuntime("manual"));
document.querySelector("#export")!.addEventListener("click", exportDiagnostics);

window.addEventListener("beforeunload", () => teardownRuntime(false));
void loadRuntime("url");
