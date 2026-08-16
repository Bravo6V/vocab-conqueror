// 词海征服 Service Worker — 离线缓存
const CACHE_NAME = "vocab-conqueror-v3";
const ASSETS = [
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
      return cache.addAll(ASSETS).catch(function () {});
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

// 请求拦截：缓存优先，网络兜底（stale-while-revalidate）
self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) {
        // 有缓存就先用，后台静默更新
        fetch(event.request)
          .then(function (resp) {
            if (resp && resp.status === 200) {
              caches.open(CACHE_NAME).then(function (cache) {
                cache.put(event.request, resp.clone());
              });
            }
          })
          .catch(function () {});
        return cached;
      }
      // 没缓存就走网络，成功后存入缓存
      return fetch(event.request)
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
          // 网络也失败，返回离线提示
          return new Response("离线且无缓存", { status: 503 });
        });
    })
  );
});
