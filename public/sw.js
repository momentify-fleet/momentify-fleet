// Service Worker — Momentify Fleet Driver PWA
const CACHE = 'mf-driver-v1';
const ASSETS = ['/hp', '/manifest.json'];

// Install — cache assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activate — hapus cache lama
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — network first, fallback cache
self.addEventListener('fetch', e => {
  if (e.request.url.includes('socket.io')) return; // jangan cache socket.io
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// Background sync — kirim GPS yang tertunda
self.addEventListener('sync', e => {
  if (e.tag === 'sync-gps') {
    console.log('[SW] Background sync GPS');
  }
});

// Push notification
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'Momentify Fleet', {
      body: data.body || 'Ada notifikasi baru',
      icon: '/manifest.json',
      badge: '/manifest.json',
      vibrate: [200, 100, 200]
    })
  );
});
