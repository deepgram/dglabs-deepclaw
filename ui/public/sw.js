const CACHE_VERSION = "deepclaw-v1";
const SHELL_ASSETS = ["./", "./manifest.json", "./favicon.svg", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET, WebSocket, RPC, and API requests
  if (
    event.request.method !== "GET" ||
    url.protocol === "ws:" ||
    url.protocol === "wss:" ||
    url.pathname.includes("/rpc")
  ) {
    return;
  }

  // Static assets: cache-first
  if (/\.(js|css|otf|svg|png|ico|woff2?)$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(
        (cached) =>
          cached ||
          fetch(event.request).then((response) => {
            if (response.ok) {
              const clone = response.clone();
              void caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
            }
            return response;
          }),
      ),
    );
    return;
  }

  // Navigation: network-first with cache fallback
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          void caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }
});
