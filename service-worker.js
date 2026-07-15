// ═══════════════════════════════════════════════════════════════
//  VOGA-MOPA DCWIS — Service Worker
//  Purpose: (1) make the dashboard installable as a PWA,
//           (2) let app.js fire native OS notifications via
//               registration.showNotification() while this tab/app
//               is open (foreground or backgrounded), with NO
//               push server / backend involved.
//
//  IMPORTANT: This SW must never cache or intercept live data
//  requests (AWOS /data, /cloud, METAR register proxy). Only the
//  static app-shell files below are cached. Bump CACHE_NAME when
//  shipping a new shell version to force clients to refresh.
// ═══════════════════════════════════════════════════════════════
const CACHE_NAME = 'dcwis-shell-v1';
const SHELL_PATHS = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_PATHS))
      .catch(() => {}) // never block install on a caching hiccup
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isShellFile = isSameOrigin && SHELL_PATHS.includes(url.pathname);

  // Anything that isn't one of our own static shell files — live weather
  // data, satellite/cloud data, METAR register, Google Fonts, jsDelivr
  // CDN scripts — is left completely alone. No respondWith means the
  // browser handles it exactly as if this service worker didn't exist.
  if (!isShellFile) return;

  // Stale-while-revalidate for the shell: instant load from cache,
  // silently refreshed from network in the background for next time.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// Clicking a native notification focuses the existing tab, or opens one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
