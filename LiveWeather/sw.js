/* SkyPulse service worker: offline app shell, network-first cyclone feed, live weather APIs untouched. */
const VERSION = 'skypulse-v5';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'icons.js', 'sun.js', 'fx.js', 'hazards.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // cyclone/warning feed: fresh when online, last copy when offline
  if (url.origin === location.origin && url.pathname.endsWith('/data/tropical.json')) {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put('data/tropical.json', copy)); return r; })
      .catch(() => caches.match('data/tropical.json')));
    return;
  }
  // own files: network-first (always fresh after a deploy), cached copy when offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return r; })
      .catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // version-pinned CDN libraries: cache-first; weather APIs and map tiles go straight to the network
  if (!SHELL.includes(req.url)) return;
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); return r; })));
});
