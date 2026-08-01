/* Cache the app shell so the PWA opens offline; always go to the network for
   signal data, because a stale signal is worse than no signal. */

const SHELL = 'signals-shell-v1';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.pathname.includes('/api/')) {
    event.respondWith(fetch(request).catch(() => new Response(
      JSON.stringify({ error: 'offline' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )));
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((resp) => {
      const copy = resp.clone();
      caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
      return resp;
    }))
  );
});
