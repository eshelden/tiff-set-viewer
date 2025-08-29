// sw.js — cache-first for /images/*/thumbs/*.jpg
const SW_VERSION = 'v1.0.0';
const RUNTIME_CACHE = 'thumbs-cache-' + SW_VERSION;

// Simple URL matcher for thumbs
function isThumb(req) {
  try {
    const u = new URL(req.url);
    return u.pathname.includes('/images/') && u.pathname.includes('/thumbs/') && u.pathname.endsWith('.jpg');
  } catch (e) {
    return false;
  }
}

// Optional: network-first for sets.json (keeps list fresh, caches fallback)
function isSetsJSON(req) {
  try {
    const u = new URL(req.url);
    return u.pathname.endsWith('/data/sets.json');
  } catch (e) {
    return false;
  }
}

self.addEventListener('install', (event) => {
  // Skip waiting so updates apply promptly
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Clean up old caches
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => {
      if (!n.endsWith(SW_VERSION)) return caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (isThumb(request)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      const cached = await cache.match(request, { ignoreVary: true, ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(request);
        // Clone and store only successful responses
        if (res && res.ok) cache.put(request, res.clone());
        return res;
      } catch (e) {
        // As a last resort, just fail through
        return fetch(request);
      }
    })());
    return;
  }

  if (isSetsJSON(request)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      try {
        const fresh = await fetch(request, { cache: 'no-store' });
        if (fresh && fresh.ok) cache.put(request, fresh.clone());
        return fresh;
      } catch (e) {
        const fallback = await cache.match(request);
        if (fallback) return fallback;
        throw e;
      }
    })());
    return;
  }
});
