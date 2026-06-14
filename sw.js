const CACHE = 'dupin-v2';
const ASSETS = ['/dupin/', '/dupin/index.html', '/dupin/app.js', '/dupin/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
});

// 網路優先，失敗才用快取（資料頁）
self.addEventListener('fetch', e => {
  if (e.request.url.includes('script.google.com')) return; // API 不快取
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
