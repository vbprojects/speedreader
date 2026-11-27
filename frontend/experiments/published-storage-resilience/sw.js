// Dedicated test origin only. Not the application's service worker.
const CACHE = "speedreader-crash-fixture-v1";
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(["./", "harness.js", "manifest.webmanifest"]))));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(hit => hit || fetch(event.request))));
