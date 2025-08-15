const CACHE = 'smoke-v3'; // <— новая версия кэша!

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(['./', './index.html', './style.css', './app.js', './manifest.webmanifest']);

  })());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))); // <— чистим старое
    await self.clients.claim();
  })());
});

async function broadcast(msg){
  const cs = await clients.matchAll({ type:'window', includeUncontrolled:true });
  cs.forEach(c => c.postMessage(msg));
}

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? JSON.parse(event.data.text()) : {}; } catch {}
  const title = data.title || 'Уведомление';
  const options = { body: data.body || '', data, requireInteraction: true };

  event.waitUntil((async () => {
    await broadcast({ type:'sw-log', phase:'push', data, time:new Date().toISOString() });
    if (Notification.permission === 'granted') {
      await self.registration.showNotification(title, options);
    } else {
      await broadcast({ type:'sw-log', phase:'push-skip', reason:'no-permission' });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    await broadcast({ type:'sw-log', phase:'click', at:new Date().toISOString() });
    const all = await clients.matchAll({ type:'window', includeUncontrolled:true });
    if (all.length > 0) all[0].focus(); else clients.openWindow('./');
  })());
});
