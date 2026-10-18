const CACHE = "linedist2-v1";
const ASSETS = [
  "./", "./index.html", "./app.css", "./manifest.json",
  "./js/main.js", "./js/segments.js", "./js/store.js", "./js/player.js", "./js/timeline.js", "./js/studio.js",
  "./icon-180.png", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first with a 2.5s limit, falling back to the cached copy when offline or slow.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const fresh = fetch(e.request).then(res => {
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    });
    if (!hit) return fresh;
    const slow = new Promise(resolve => setTimeout(() => resolve(hit), 2500));
    return Promise.race([fresh.catch(() => hit), slow]);
  })());
});
