// 판다산다 서비스 워커: 채팅 웹 푸시 알림만 처리 (캐시는 하지 않음)
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  var url = d.url || '/chat';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    // 그 채팅방을 지금 보고 있으면 알림을 띄우지 않음
    var watching = list.some(function (c) { return c.visibilityState === 'visible' && new URL(c.url).pathname === url; });
    if (watching) return;
    return self.registration.showNotification(d.title || '판다산다', {
      body: d.body || '새 메시지가 왔어요',
      tag: d.tag || 'chat',
      renotify: true,
      icon: '/%EC%9D%B4%EB%AF%B8%EC%A7%80/app/icon-192.png',
      badge: '/%EC%9D%B4%EB%AF%B8%EC%A7%80/app/icon-192.png',
      data: { url: url }
    });
  }));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/chat';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (new URL(list[i].url).origin === self.location.origin && 'focus' in list[i]) {
        return list[i].navigate(url).then(function (c) { return c && c.focus(); });
      }
    }
    return self.clients.openWindow(url);
  }));
});
