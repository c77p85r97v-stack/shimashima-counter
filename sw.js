// シマシマカウンター Service Worker（圏外対応）
// 全ファイルを事前キャッシュ。VERSION を上げると新しいキャッシュを作り、アプリ側に「更新」を表示する。
const VERSION = 'v4.1.1';
const CACHE = 'shimashima-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'engine.js', 'worker.js', 'manifest.json', 'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
  // 初回は即有効化。更新時は利用者が「更新する」を押すまで待つ（作業中に入れ替わらないように）
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('shimashima-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // キャッシュ優先（圏外でも即起動）。ページ遷移は index.html を返す
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const hit = await c.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await c.match('index.html') : null);
    if (hit) return hit;
    try { return await fetch(req); } catch (err) { return new Response('offline', { status: 503 }); }
  })());
});
