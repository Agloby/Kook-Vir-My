// Kook vir Jou service worker.
// Caches only the static app shell (HTML, manifest, icons, offline page).
// It deliberately never caches cross-origin requests — Supabase API responses
// (user data), Google APIs and Open Food Facts always go to the network.
const CACHE = 'kvj-shell-v7';
const SHELL = [
  './',
  './index.html',
  './pepesto-helpers.js',
  './recipe-helpers.js',
  './offline.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return; // never touch API traffic

  // Navigations: network first (so deploys land immediately), cached shell as fallback,
  // offline page as the last resort.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return resp;
        })
        .catch(() => caches.match('./index.html').then(hit => hit || caches.match('./offline.html')))
    );
    return;
  }

  // Static shell assets: cache first.
  event.respondWith(
    caches.match(event.request).then(hit => hit || fetch(event.request).then(resp => {
      if (resp.ok && SHELL.some(p => url.pathname.endsWith(p.replace('./', '/')))) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(event.request, copy));
      }
      return resp;
    }))
  );
});
