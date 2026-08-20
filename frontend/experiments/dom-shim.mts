// dom-shim.mts
// Bootstraps a minimal browser-like global environment (jsdom) so that
// browser-oriented libraries like epubjs can run under Node (tsx).
//
// Import this FIRST before importing anything that pulls in epubjs.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

// Assign the DOM globals only if not already present (don't clobber Node's
// real `window` if one exists).
const g = globalThis as any;
if (!g.window) g.window = dom.window;
if (!g.document) g.document = dom.window.document;
if (!g.navigator) g.navigator = dom.window.navigator;

// Common browser globals used by epubjs / XML parsing.
for (const key of ["Node", "Element", "HTMLElement", "Document", "XMLSerializer", "DOMParser", "Range", "getComputedStyle"]) {
  if (!g[key] && dom.window[key]) g[key] = dom.window[key];
}

// EPUB resources are fetched via XHR; jsdom provides one, but epubjs needs it
// on the global object. jsdom's XHR only works with http(s)/fetch-compatible
// URLs, which is fine once we supply a custom request method.
if (!g.XMLHttpRequest) g.XMLHttpRequest = dom.window.XMLHttpRequest;

// Node's URL lacks createObjectURL/revokeObjectURL (browser-only). jsdom's
// blob URLs need them for loading binary resources. Provide in-memory stubs
// so epubjs doesn't crash (we don't render binary media in exploration).
// epubjs reads `window.URL` specifically, so patch both the global and window.
function installObjectUrlPatch(url: typeof URL) {
  if (typeof url.createObjectURL !== "function") {
    const objectUrls = new Map<string, Blob>();
    (url as any).createObjectURL = (blob: Blob) => {
      const u = `blob:nodejs-${(objectUrls.size + 1).toString(36)}`;
      objectUrls.set(u, blob);
      return u;
    };
    (url as any).revokeObjectURL = (u: string) => {
      objectUrls.delete(u);
    };
  }
}
installObjectUrlPatch(URL);
if (dom.window.URL && dom.window.URL !== URL) installObjectUrlPatch(dom.window.URL);

g.Range = dom.window.Range;

export const window = dom.window;