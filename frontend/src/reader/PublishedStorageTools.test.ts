import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { LIMIT, StoryRevisionConflict, type Snapshot } from "../ingestion/sugarcube/storage-protocol";
import { PublishedStorageTools, type PublishedStorageToolsProps } from "./PublishedStorageTools";
import { SAVE_FILE_KIND, RECOVERY_LIMIT } from "./storage-recovery";
import type { StorageManagerLike } from "./storage-status";

const sourceHash = "a".repeat(64);
const blank = (): Snapshot => ({ local: [], session: [] });
type Replacement = { snapshot: Snapshot; expected: string | null };

async function mount(overrides: Partial<PublishedStorageToolsProps> = {}, storage: StorageManagerLike | undefined = undefined) {
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://reader.example/" });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.window.navigator, "storage", { configurable: true, value: storage });
  let confirms = 0, imported = 0;
  const replacements: Replacement[] = [];
  const downloads: Blob[] = [];
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => { downloads.push(blob as Blob); return `blob:export-${downloads.length}`; };
  URL.revokeObjectURL = () => {};
  dom.window.HTMLAnchorElement.prototype.click = () => {};
  dom.window.confirm = () => { confirms++; return false; };
  const root = createRoot(dom.window.document.getElementById("root")!);
  const props: PublishedStorageToolsProps = {
    sourceHash, getStored: async () => ({ revision: "revision-before-preview", snapshot: blank() }),
    replaceStored: async (snapshot, expected) => { replacements.push({ snapshot, expected }); },
    getBudget: async () => ({ usedBytes: 0, limitBytes: 100 * 1024 * 1024, unaccountedStories: 0 }),
    onImported: () => { imported++; }, ...overrides,
  };
  await act(async () => { root.render(createElement(PublishedStorageTools, props)); });
  const document = dom.window.document;
  const button = (label: string) => {
    const found = [...document.querySelectorAll("button")].find(element => element.textContent === label);
    assert.ok(found, `Missing button: ${label}`); return found;
  };
  return {
    dom, document, replacements, downloads, button,
    get imported() { return imported; }, get confirms() { return confirms; },
    setConfirmation(value: boolean) { dom.window.confirm = () => { confirms++; return value; }; },
    async click(label: string) { await act(async () => { button(label).click(); }); },
    async open() {
      await act(async () => {
        const details = document.querySelector("details")!; details.open = true;
        details.dispatchEvent(new dom.window.Event("toggle"));
      });
    },
    async selectFile(file: Pick<File, "size" | "text">) {
      await act(async () => {
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
        Object.defineProperty(input, "files", { configurable: true, value: [file] });
        input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });
    },
    async unmount() { await act(async () => { root.unmount(); }); },
    async cleanup() {
      await act(async () => { root.unmount(); });
      dom.window.close(); URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test("actual recovery component paginates, never renders values, and requires explicit selection and confirmation", async () => {
  const snapshot: Snapshot = { local: [["k".repeat(LIMIT.key + 1), "private-save-value"], ...Array.from({ length: 40 }, (_, i): [string, string] => [`key-${i}`, `value-${i}`])], session: [] };
  const view = await mount({ getStored: async () => ({ revision: "original-revision", snapshot }) });
  try {
    await view.click("Review saved data");
    assert.equal(view.document.querySelectorAll('input[type="checkbox"]').length, 40);
    assert.equal(view.button("Replace published saves").disabled, true);
    assert.equal(view.document.body.textContent!.includes("private-save-value"), false);
    assert.equal(view.replacements.length, 0);
    await view.click("Next entries");
    assert.equal(view.document.querySelectorAll('input[type="checkbox"]').length, 1);
    await view.click("Previous entries");
    await act(async () => { view.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    assert.equal(view.button("Replace published saves").disabled, false);
    await view.click("Replace published saves"); // Confirmation defaults to Cancel.
    assert.equal(view.confirms, 1); assert.equal(view.replacements.length, 0);
    assert.ok(view.document.querySelector('[aria-label="Recovery preview"]'));
    view.setConfirmation(true); await view.click("Replace published saves");
    assert.equal(view.replacements.length, 1); assert.equal(view.imported, 1);
    assert.equal(view.replacements[0].expected, "original-revision");
    assert.deepEqual(view.replacements[0].snapshot, { local: snapshot.local.slice(1), session: [] });
    assert.equal(snapshot.local.length, 41);
  } finally { await view.cleanup(); }
});

test("actual component retains a stale preview on CAS rejection without retrying or overwriting", async () => {
  let attempts = 0;
  const view = await mount({
    getStored: async () => ({ revision: "reviewed-revision", snapshot: { local: [["slot", "reviewed"]], session: [] } }),
    replaceStored: async (_snapshot, expected) => { attempts++; assert.equal(expected, "reviewed-revision"); throw new StoryRevisionConflict(); },
  });
  try {
    await view.click("Review saved data"); view.setConfirmation(true);
    await view.click("Replace published saves");
    assert.equal(attempts, 1); assert.equal(view.imported, 0);
    assert.match(view.document.querySelector('[role="alert"]')!.textContent!, /another session/);
    assert.ok(view.document.querySelector('[aria-label="Recovery preview"]'));
    await view.click("Cancel recovery"); assert.equal(attempts, 1);
  } finally { await view.cleanup(); }
});

test("import component rejects excessive file size before text and rejects the wrong story before loading a revision", async () => {
  let reads = 0, inspections = 0;
  const view = await mount({ getStored: async () => { inspections++; return { revision: null, snapshot: blank() }; } });
  try {
    await view.selectFile({ size: RECOVERY_LIMIT.fileBytes + 1, text: async () => { reads++; return "{}"; } });
    assert.equal(reads, 0); assert.equal(inspections, 0);
    assert.match(view.document.querySelector('[role="alert"]')!.textContent!, /not been read/);
    const wrong = JSON.stringify({ kind: SAVE_FILE_KIND, version: 1, sourceHash: "b".repeat(64), snapshot: blank() });
    await view.selectFile(new Blob([wrong]));
    assert.equal(inspections, 0); assert.equal(view.replacements.length, 0);
    assert.match(view.document.querySelector('[role="alert"]')!.textContent!, /different story/);
  } finally { await view.cleanup(); }
});

test("compatible import is previewed in full and cancelling leaves stored data untouched", async () => {
  const view = await mount();
  try {
    const imported: Snapshot = { local: [["slot", "save\udfff"]], session: [["history", "current"]] };
    await view.selectFile(new Blob([JSON.stringify({ kind: SAVE_FILE_KIND, version: 1, sourceHash, snapshot: imported })]));
    assert.ok(view.document.querySelector('[aria-label="Recovery preview"]'));
    assert.match(view.document.body.textContent!, /2 entries selected/);
    assert.equal(view.replacements.length, 0); assert.equal(view.confirms, 0);
    await view.click("Cancel recovery");
    assert.equal(view.replacements.length, 0); assert.equal(view.imported, 0);
  } finally { await view.cleanup(); }
});

test("persistent-storage permission is requested only by its button and denial preserves saves", async () => {
  let permissionRequests = 0;
  const view = await mount({}, {
    estimate: async () => ({ usage: 1024, quota: 2048 }), persisted: async () => false,
    persist: async () => { permissionRequests++; return false; },
  });
  try {
    await view.open(); assert.equal(permissionRequests, 0);
    assert.match(view.document.body.textContent!, /estimates; a save may still fail/);
    await view.click("Refresh storage"); assert.equal(permissionRequests, 0);
    await view.click("Protect offline saves"); assert.equal(permissionRequests, 1);
    assert.match(view.document.body.textContent!, /did not grant persistent storage/);
    assert.equal(view.replacements.length, 0);
  } finally { await view.cleanup(); }
});

test("session export is opt-in, downloads live conflict data, and never replaces stored state", async () => {
  let exports = 0;
  const snapshot: Snapshot = { local: [["slot", "unsaved-session"]], session: [] };
  const view = await mount({ getLive: async () => { exports++; return snapshot; } });
  try {
    assert.equal(exports, 0); assert.equal(view.downloads.length, 0);
    await view.click("Export this session");
    assert.equal(exports, 1); assert.equal(view.downloads.length, 1);
    assert.deepEqual(JSON.parse(await view.downloads[0].text()).snapshot, snapshot);
    assert.equal(view.replacements.length, 0);
  } finally { await view.cleanup(); }
});

test("unmounting while saved export is pending prevents a late download on another story", async () => {
  let finish!: (value: { revision: string | null; snapshot: unknown }) => void;
  const pending = new Promise<{ revision: string | null; snapshot: unknown }>(resolve => { finish = resolve; });
  const view = await mount({ getStored: () => pending });
  try {
    await view.click("Export saved data");
    await view.unmount();
    await act(async () => { finish({ revision: null, snapshot: blank() }); });
    assert.equal(view.downloads.length, 0); assert.equal(view.replacements.length, 0);
  } finally { await view.cleanup(); }
});
