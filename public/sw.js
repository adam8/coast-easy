/* global self, caches */
const cacheName = 'coast-easy-shell-v50';
const assets = new Map([
  ['/', /text\/html/i],
  ['/app.js', /javascript/i],
  ['/report-cache.js', /javascript/i],
  ['/demo.js', /javascript/i],
  ['/icons.js', /javascript/i],
  ['/style.css', /text\/css/i],
  ['/sailings.css', /text\/css/i],
  ['/sailings.js', /javascript/i],
  ['/sailings-view.js', /javascript/i],
  ['/sailings-schedule.json', /json/i],
  ['/manifest.webmanifest', /json|octet-stream/i],
  ['/icons/coast-easy-192.png', /image\/png|octet-stream/i],
  ['/icons/coast-easy-512.png', /image\/png|octet-stream/i],
  ['/icons/coast-easy-maskable.png', /image\/png|octet-stream/i],
  ['/icons/apple-touch-icon.png', /image\/png|octet-stream/i],
  ['/fonts/dm-sans.ttf', /font|octet-stream/i],
  ['/fonts/manrope.ttf', /font|octet-stream/i],
  ['/bootstrap.json', /json/i],
  ['/geography.json', /json/i],
  ['/basemap.json', /json/i],
  ['/salish-map.js', /javascript/i],
  ['/coast.json', /json/i],
  ['/vendor/maplibre.js', /javascript/i],
  ['/vendor/maplibre.css', /text\/css/i],
  ['/vendor/pmtiles.js', /javascript/i],
]);

async function isAppAsset(path, response) {
  if (!response.ok || !assets.get(path).test(response.headers.get('Content-Type') ?? '')) return false;
  if (path !== '/') return true;
  const html = await response.clone().text();
  return html.includes('id="map"') && html.includes('id="fleet-list"');
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    await Promise.all([...assets.keys()].map(async (path) => {
      const response = await fetch(path, { cache: 'reload' });
      if (!await isAppAsset(path, response)) throw new Error('Offline asset unavailable: ' + path);
      await cache.put(path, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('coast-easy-shell-') && key !== cacheName)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

async function respond(request, path) {
  const cache = await caches.open(cacheName).catch(() => null);
  if (self.navigator.onLine !== false) {
    try {
      const response = await fetch(request, { signal: AbortSignal.timeout(3500) });
      if (response.status < 500) {
        if (cache && await isAppAsset(path, response)) {
          await cache.put(path, response.clone()).catch(() => {});
        }
        return response;
      }
    } catch {
      // Cached resources remain usable if the network drops or stops responding.
    }
  }

  const saved = await cache?.match(path).catch(() => null);
  if (!saved) return Response.error();
  const headers = new Headers(saved.headers);
  headers.set('X-Coast-Easy-Offline', '1');
  return new Response(saved.body, { status: saved.status, statusText: saved.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'GET' && url.origin === self.location.origin && assets.has(url.pathname)) {
    event.respondWith(respond(event.request, url.pathname));
  }
});
