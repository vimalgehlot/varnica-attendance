// ============================================================
// VARNICA JEWELS — Service Worker v2.0
// Developer: Vimal Gehlot
// ============================================================

const CACHE_NAME = 'varnica-attendance-v2';

// Files to cache for offline use
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://unpkg.com/face-api.js@0.22.2/dist/face-api.min.js'
];

// External domains that should NEVER be cached/intercepted
const BYPASS_DOMAINS = [
  'script.google.com',
  'script.googleusercontent.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ============================================================
// INSTALL — Cache static assets
// ============================================================
self.addEventListener('install', event => {
  console.log('[SW] Installing Varnica SW v2...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(['./', './index.html', './manifest.json'])
        .catch(e => console.log('[SW] Cache error (non-fatal):', e));
    })
  );
  self.skipWaiting();
});

// ============================================================
// ACTIVATE — Clean old caches
// ============================================================
self.addEventListener('activate', event => {
  console.log('[SW] Activating Varnica SW v2...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      )
    )
  );
  self.clients.claim();
});

// ============================================================
// FETCH — Smart routing
// ============================================================
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // 1. Always bypass external/API domains (no cache, no intercept)
  const shouldBypass = BYPASS_DOMAINS.some(domain => url.includes(domain));
  if (shouldBypass) {
    // Passthrough — let browser handle directly
    return;
  }

  // 2. For same-origin requests — cache-first strategy
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Return cached version
        return cached;
      }
      // Not in cache — fetch from network
      return fetch(event.request).then(response => {
        // Cache valid responses for static assets
        if (
          response &&
          response.status === 200 &&
          response.type === 'basic' &&
          (url.includes('.html') || url.includes('.json') || url.includes('.js') || url.includes('.css') || url.includes('.png') || url.includes('.jpg'))
        ) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      }).catch(() => {
        // Offline fallback — return cached index.html
        if (event.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
