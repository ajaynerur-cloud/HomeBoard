/* HomeBoard service worker.
   App shell is cached so it opens instantly and works offline.
   API calls always go to the network — task data must never be stale. */

const VERSION = 'homeboard-v3';
const SHELL = [
  '/', '/index.html', '/app.css', '/app.js', '/qr.js', '/config.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-32.png', '/icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // never cache task data

  // Navigations: serve the cached shell first, then refresh it in the
  // background. This is what stops a sleeping server's holding page from ever
  // becoming the app you see — the shell is already on the device, and it wakes
  // the API itself behind our own waking screen.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then((hit) => {
        const network = fetch(request)
          .then((res) => {
            // Only replace the shell with a real app response, never with a
            // gateway error or someone else's holding page.
            const type = res.headers.get('content-type') || '';
            if (res.ok && type.includes('text/html')) {
              caches.open(VERSION).then((c) => c.put('/index.html', res.clone()));
            }
            return res;
          })
          .catch(() => hit);
        return hit || network;
      })
    );
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
