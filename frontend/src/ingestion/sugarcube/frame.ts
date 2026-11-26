// Standalone classic script in the opaque-origin story document. No app imports.
(() => {
  if (window === parent) return;
  const host = new URL(document.baseURI);
  const native = host.protocol === "story-runtime:" || host.hostname === "story-runtime.localhost";
  const hostOrigin = host.origin === "null" ? host.protocol + "//" + host.host : host.origin;
  const appOrigins = native ? ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"] : [hostOrigin];
  if (location.href !== "about:srcdoc") {
    // The trusted outer document can be served from the app's offline cache.
    // Only its opaque-origin child ever receives or executes the imported HTML.
    const child = document.createElement("iframe");
    child.title = "Published story";
    child.setAttribute("sandbox", "allow-scripts allow-downloads allow-forms allow-modals allow-presentation allow-popups");
    child.allow = "autoplay; fullscreen";
    child.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
    const script = document.currentScript?.textContent;
    if (!script) return;
    window.addEventListener("message", event => {
      if (event.source === child.contentWindow && event.origin === "null" && event.data === "speedreader:story-host") {
        parent.postMessage("speedreader:story-host", native ? "*" : hostOrigin);
      } else if (event.source === parent && appOrigins.includes(event.origin) && event.ports.length === 1) {
        child.contentWindow?.postMessage(event.data, "*", [event.ports[0]]);
      }
    });
    child.srcdoc = "<!doctype html><title>Story</title><body><script>" + script + "<" + "/script>";
    document.body.replaceChildren(child);
    return;
  }
  if (self.origin !== "null") return;
  type Entries = [string, string][];
  interface Launch {
    html: string;
    local: Entries;
    session: Entries;
    assets: { path: string; mimeType: string; data: ArrayBuffer }[];
    entryPath?: string;
  }

  function boot(event: MessageEvent<Launch>) {
    if (event.source !== parent || event.origin !== hostOrigin || !event.ports[0]) return;
    window.removeEventListener("message", boot);
    const port = event.ports[0];
    const launch = event.data;
    const local = new Map(launch.local);
    const session = new Map(launch.session);
    let scheduled = false;
    function changed() {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        port.postMessage({ type: "save", local: [...local], session: [...session] });
      });
    }

    // SugarCube probes both Web Storage objects during startup. Keep its own
    // serialized session, settings, autosaves and slots verbatim for each book.
    function storage(values: Map<string, string>): Storage {
      const api: Storage = {
        get length() { return values.size; },
        key(index: number) { return [...values.keys()][index] ?? null; },
        getItem(key: string) { return values.get(String(key)) ?? null; },
        setItem(key: string, value: string) { values.set(String(key), String(value)); changed(); },
        removeItem(key: string) { if (values.delete(String(key))) changed(); },
        clear() { values.clear(); changed(); },
      };
      return new Proxy(api, {
        get(target, key) {
          if (typeof key === "string" && !(key in target)) return values.get(key);
          return Reflect.get(target, key);
        },
        set(_, key, value) { api.setItem(String(key), String(value)); return true; },
        deleteProperty(_, key) { api.removeItem(String(key)); return true; },
        ownKeys() { return [...values.keys()]; },
        getOwnPropertyDescriptor(_, key) {
          if (typeof key === "string" && values.has(key)) return { configurable: true, enumerable: true, writable: true, value: values.get(key) };
        },
      });
    }
    try {
      Object.defineProperty(window, "localStorage", { value: storage(local) });
      Object.defineProperty(window, "sessionStorage", { value: storage(session) });
      // Open before installing story listeners: document.open removes listeners
      // from the old document and window. The private message port survives.
      document.open();
      const packageRoot = "https://story.invalid/";
      const entry = new URL(launch.entryPath || "story.html", packageRoot);
      const assets = new Map<string, string>();
      for (const asset of launch.assets) {
        const url = new URL(asset.path, packageRoot);
        assets.set(url.href, URL.createObjectURL(new Blob([asset.data], { type: asset.mimeType })));
      }
      function resource(path: string, base = entry.href) {
        try {
          const url = new URL(path, base);
          // Libraries may already have absolutized a relative path against the frame.
          const hostDirectory = new URL(".", host.href).href;
          const key = url.href.startsWith(hostDirectory) ? new URL(url.href.slice(hostDirectory.length), base) : url;
          const fragment = key.hash;
          key.search = "";
          key.hash = "";
          const blob = assets.get(key.href);
          return blob ? blob + fragment : path;
        } catch { return path; }
      }
      function css(text: string, base: string) {
        return text.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_, quote: string, path: string) =>
          "url(" + quote + resource(path, base) + quote + ")");
      }
      // Resolve files referenced by a packaged stylesheet against that stylesheet.
      for (const asset of launch.assets.filter(asset => asset.mimeType === "text/css")) {
        const url = new URL(asset.path, packageRoot).href;
        const text = css(new TextDecoder().decode(asset.data), url);
        assets.set(url, URL.createObjectURL(new Blob([text], { type: "text/css" })));
      }
      function resolveElement(element: Element) {
        for (const name of ["src", "href", "poster", "data", "style"]) {
          const original = element.getAttribute(name);
          if (!original) continue;
          const resolved = name === "style" ? css(original, entry.href) : resource(original);
          if (resolved !== original) element.setAttribute(name, resolved);
        }
      }
      let html = launch.html;
      if (assets.size) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        doc.querySelectorAll("[src],[href],[poster],[data],[style]").forEach(resolveElement);
        for (const style of doc.querySelectorAll("style")) style.textContent = css(style.textContent ?? "", entry.href);
        html = "<!doctype html>" + doc.documentElement.outerHTML;
        const observer = new MutationObserver(records => {
          for (const record of records) {
            if (record.type === "attributes" && record.target instanceof Element) resolveElement(record.target);
            for (const node of record.addedNodes) if (node instanceof Element) {
              resolveElement(node);
              node.querySelectorAll("[src],[href],[poster],[data],[style]").forEach(resolveElement);
            }
          }
        });
        observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href", "poster", "data", "style"] });
        // Detached script and media elements may start loading before an observer runs.
        for (const [prototype, property] of [
          [HTMLScriptElement.prototype, "src"], [HTMLLinkElement.prototype, "href"],
          [HTMLImageElement.prototype, "src"], [HTMLMediaElement.prototype, "src"],
          [HTMLVideoElement.prototype, "poster"], [HTMLSourceElement.prototype, "src"],
          [HTMLTrackElement.prototype, "src"],
        ] as const) {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
          if (!descriptor?.set || !descriptor.configurable) continue;
          Object.defineProperty(prototype, property, { ...descriptor,
            set(this: Element, path: string) { descriptor.set!.call(this, resource(String(path))); },
          });
        }
        const originalFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          if (input instanceof Request) {
            const resolved = resource(input.url);
            return originalFetch(resolved === input.url ? input : new Request(resolved, input), init);
          }
          return originalFetch(resource(String(input)), init);
        };
        const open = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...options: [boolean?, string?, string?]) {
          Reflect.apply(open, this, [method, resource(String(url)), ...options]);
        };
      }
      document.addEventListener("click", event => {
        const target = event.target instanceof Element ? event.target.closest("[data-passage]") : null;
        if (!target?.localName.includes("-") || event.defaultPrevented || customElements.get(target.localName)) return;
        const engine = (window as Window & { SugarCube?: { Engine: { play(passage: string): void } } }).SugarCube?.Engine;
        const passage = target.getAttribute("data-passage");
        if (engine && passage) { event.preventDefault(); engine.play(passage); }
      });
      document.write(html);
      document.close();
      const startup = window.setInterval(() => {
        if ("SugarCube" in window) {
          clearInterval(startup);
          // Reloading a written srcdoc is browser-dependent. Restart the trusted
          // host after SugarCube resets its session, retaining its named slots.
          const runtime = window as Window & { jQuery?: (doc: Document) => { on(name: string, fn: () => void): void } };
          runtime.jQuery?.(document).on(":enginerestart", () => {
            port.postMessage({ type: "restart", local: [...local], session: [...session] });
          });
          port.postMessage({ type: "started" });
        }
      }, 50);
    } catch (error) { port.postMessage({ type: "error", message: String(error) }); }
  }
  window.addEventListener("message", boot);
  parent.postMessage("speedreader:story-host", hostOrigin);
})();
