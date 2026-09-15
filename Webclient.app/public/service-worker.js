/* Kent Rehberi shell cache only. Dynamic API and GIS traffic is intentionally excluded. */
const CACHE_NAME = 'kent-rehberi-static-v2';
const STATIC_PREFIXES = ['/static/', '/images/', '/fonts/'];

const isSameOrigin = (url) => url.origin === self.location.origin;
const isStaticAsset = (url) => isSameOrigin(url) && STATIC_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
const isNavigation = (request) => request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(new URL('./index.html', self.location).toString());
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (!isSameOrigin(url)) return;

  if (isNavigation(event.request)) {
    event.respondWith((async () => {
      try {
        return await fetch(event.request);
      } catch (error) {
        return caches.match(new URL('./index.html', self.location).toString());
      }
    })());
    return;
  }

  if (!isStaticAsset(url)) return;

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    const network = fetch(event.request).then((response) => {
      if (response.ok) {
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone())));
      }
      return response;
    }).catch(() => cached);
    return cached || network;
  })());
});
