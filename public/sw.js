// Shows background push notifications sent by the road-safety server.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch { /* ignore malformed payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Animal alert', {
      body: data.body || '',
      tag: `belt-${data.beltId || 'x'}`,
      renotify: true,
      data: { url: data.mapLink || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow('/');
  })());
});
