// ============================================================
// VARNICA JEWELS — Service Worker v3.0 (iOS Safe)
// ============================================================
const CACHE_NAME = 'varnica-v11';

// Only cache the app shell — NOT models or API calls
const CACHE_FILES = ['./', './index.html', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(CACHE_FILES).catch(err => console.log('Cache warn:', err)))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // NEVER intercept these — let browser handle directly
  const bypass = [
    'script.google.com',
    'googleusercontent.com',
    'googleapis.com',
    'unpkg.com',
    'jsdelivr.net',
    'cdnjs.cloudflare.com',
    'raw.githubusercontent.com',
    'github.io/varnica-attendance/models',  // face models
    'fonts.g'
  ];
  if (bypass.some(b => url.includes(b))) return; // passthrough

  // For app files — cache first
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          caches.open(CACHE_NAME).then(c => c.put(e.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
