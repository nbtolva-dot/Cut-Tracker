// Lets the app open instantly and work offline after the first load.
const CACHE = "cut-tracker-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const save = (req, res) => {
  if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // Your own files: try the network first so updates show up, fall back to cache offline.
    e.respondWith(fetch(req).then((res) => save(req, res)).catch(() => caches.match(req, { ignoreSearch: true })));
  } else if (url.hostname === "esm.sh") {
    // Pinned library versions never change, so the cached copy is always fine.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => save(req, res))));
  }
});
