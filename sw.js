const CACHE = 'dupin-v18';
const ASSETS = ['/dupin/', '/dupin/index.html', '/dupin/app.js?v=18', '/dupin/manifest.json', '/dupin/icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 網路優先，並繞過 HTTP 快取（確保抓到最新檔案），失敗才用快取
self.addEventListener('fetch', e => {
  const url = e.request.url;
  // 不攔截第三方請求（Google API、CDN 等）
  if (!url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
