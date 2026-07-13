const CACHE_VERSION = 'safety-lens-shell-v1';
const APP_SHELL = ['/', '/index.html', '/hazards.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    if (url.pathname === '/hazards.json') {
      return (await cache.match(request)) ?? fetch(request);
    }
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      return (await cache.match(request))
        ?? (request.mode === 'navigate' ? await cache.match('/') : undefined)
        ?? Promise.reject(error);
    }
  })());
});
