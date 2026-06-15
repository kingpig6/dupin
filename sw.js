const CACHE = 'dupin-v7';
const ASSETS = ['/dupin/', '/dupin/index.html', '/dupin/app.js?v=7', '/dupin/manifest.json', '/dupin/icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting(); // 新版立即就緒，不等舊分頁關閉
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()) // 立即接管所有分頁
  );
});

// 網路優先，並繞過 HTTP 快取（確保抓到最新檔案），失敗才用快取
self.addEventListener('fetch', e => {
  if (e.request.url.includes('script.google.com')) return; // API 不快取
  e.respondWith(
    fetch(e.request, { cache: 'no-store' })
      .then(res => {
        // 更新快取
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
