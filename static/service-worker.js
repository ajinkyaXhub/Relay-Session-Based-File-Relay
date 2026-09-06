const CACHE_NAME = 'relay-transfer-v2';
const STATIC_ASSETS = [
  '/static/css/style.css',
  '/static/js/app.js',
  '/static/manifest.json',
  '/static/icon-192.png',
  '/static/icon-512.png',
  '/static/offline.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // For API, upload, download, and QR routes, always use network without caching
  if (
    req.method !== 'GET' ||
    req.url.includes('/upload') ||
    req.url.includes('/download') ||
    req.url.includes('/qr.png') ||
    req.url.includes('/files') ||
    req.url.includes('/end') ||
    req.url.includes('/extend')
  ) {
    return;
  }

  // Network-first with offline fallback for navigation requests
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => {
        return caches.match('/static/offline.html');
      })
    );
    return;
  }

  // Cache-first with network fallback for static assets
  event.respondWith(
    caches.match(req).then((cachedResponse) => {
      return cachedResponse || fetch(req).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && req.url.includes('/static/')) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, responseClone));
        }
        return networkResponse;
      });
    }).catch(() => {
      // If offline and asset not in cache
      return new Response('', { status: 408, statusText: 'Request timed out' });
    })
  );
});
