/* HomeBoard service worker.
   App shell is cached so it opens instantly and works offline.
   API calls always go to the network — task data must never be stale. */

const VERSION = 'homeboard-v4';
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

/* ───────── push: a task was put on your plate ─────────
   The browser wakes this worker for a push even when no HomeBoard tab is open,
   so the notification arrives with the app closed. */

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { msg = { title: 'HomeBoard', body: event.data?.text() || '' }; }
  const data = msg.data || {};
  const title = msg.title || 'HomeBoard';
  const options = {
    body: msg.body || 'You have a new task.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.taskId ? `task:${data.taskId}` : undefined,
    renotify: Boolean(data.taskId),
    requireInteraction: data.priority === 'high',
    vibrate: [200, 100, 200],
    data,
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Any open tab refreshes so the new task is already on screen.
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    tabs.forEach((c) => c.postMessage({ type: 'hb-push', data }));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const taskId = event.notification.data?.taskId;
  const target = new URL(taskId ? `/?task=${encodeURIComponent(taskId)}` : '/', self.location.origin).href;

  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of tabs) {
      if (new URL(c.url).origin === self.location.origin) {
        c.postMessage({ type: 'hb-open-task', taskId });
        try { await c.focus(); } catch { /* already in front */ }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

/* The browser rotated the subscription — hand the new one to the server. */
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    tabs.forEach((c) => c.postMessage({ type: 'hb-resubscribe' }));
  })());
});
