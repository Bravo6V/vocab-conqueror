// 词海征服 Service Worker — 离线缓存
const CACHE_NAME = "vocab-conqueror-v6";

// 核心资源（首次安装时预缓存，保证离线也能打开）
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./apple-touch-icon.png",
];

// 安装：预缓存核心资源
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(CORE_ASSETS).catch(function () {});
    })
  );
  self.skipWaiting();
});

// 激活：清理旧缓存
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// 请求拦截：
// 同源核心资源 → 联网优先（拿到最新并刷新缓存），失败才回退缓存 → 兼顾「实时更新」与「离线可用」
// 跨域资源 → 缓存优先，省流量
self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    event.respondWith(caches.match(event.request).then(function (c) {
      return c || fetch(event.request);
    }));
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(function (resp) {
        if (resp && resp.status === 200 && resp.type === "basic") {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
        }
        return resp;
      })
      .catch(function () {
        // 断网：回退到缓存（离线照样能用）
        return caches.match(event.request).then(function (cached) {
          return cached || new Response("离线且无缓存", { status: 503 });
        });
      })
  );
});
