// Cache-first service worker. Bump VERSION when shipping changes; old caches
// are removed on activate.
const VERSION = "line-dist-v2-1";
const ASSETS = [
  "./", "./index.html", "./style.css", "./manifest.webmanifest",
  "./js/app.js", "./js/timeline.js", "./js/clock.js", "./js/db.js", "./js/analysis-worker.js",
  "./icon-180.png", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("line-dist-v2-") && k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// serve from cache; refresh the cache in the background
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || !e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      const refresh = fetch(e.request).then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => hit);
      return hit || refresh;
    })
  );
});
