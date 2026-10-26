/* SkyPulse service worker: offline app shell (all libraries are self-hosted), network-first cyclone feed.
 * Weather APIs and map tiles are never cached here; the app keeps its own short-lived weather cache. */
const VERSION = 'skypulse-v12';
const SHELL = [
  './', 'index.html', 'styles.css', 'guard.js', 'app.js', 'icons.js', 'settings.js', 'cache.js', 'sun.js', 'fx.js', 'pulse.js', 'sky.js', 'hazards.js', 'storms.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon.svg',
  'vendor/chartjs/chart.umd.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/inter/inter-latin-wght-normal.woff2', 'vendor/inter/inter-latin-ext-wght-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

/** keep a copy of good same-origin responses only (never errors, redirects or opaque bodies) */
const keep = (key, r) => { if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); } return r; };

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;            // weather APIs and map tiles go straight to the network
  // cyclone/warning feed: fresh when online, last copy when offline
  if (url.pathname.endsWith('/data/tropical.json')) {
    e.respondWith(fetch(req).then((r) => keep('data/tropical.json', r)).catch(() => caches.match('data/tropical.json')));
    return;
  }
  // own files: network-first (always fresh after a deploy), cached copy when offline
  e.respondWith(fetch(req).then((r) => keep(req, r)).catch(() => caches.match(req, { ignoreSearch: true })));
});
