// Service worker do laboratório. Além do push, ele guarda a casca do
// aplicativo (app shell) para o Chrome tratar o site como PWA instalável.
// A presença de um handler de `fetch` é um dos critérios de instalação.

const CACHE = 'lab-shell-v3';
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url.pathname) || url.pathname === '/sw.js') return;
  event.respondWith(networkThenCache(request));
});

self.addEventListener('push', (event) => {
  const raw = event.data ? event.data.text() : '';
  const payload = readPayload(raw);
  console.log(`push-payload:${raw}`);

  event.waitUntil((async () => {
    try {
      await fetch('/lab/push-received', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          raw,
          title: payload.title,
          body: payload.body,
          url: payload.url,
          at: new Date().toISOString(),
        }),
      });
    } catch (err) {
      console.log(`push-log-failed:${err instanceof Error ? err.message : 'erro'}`);
    }

    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'lab-web-push',
      requireInteraction: true,
      data: { url: payload.url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  console.log(`notificationclick:${url}`);

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let action = 'none';
    let focused = false;
    let opened = false;

    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ('navigate' in client) {
        try {
          await client.navigate(url);
        } catch {
          // a janela continua sendo focada mesmo se a navegação falhar
        }
      }
      await client.focus();
      client.postMessage({ type: 'notificationclick', url, action: 'focus' });
      action = 'focus';
      focused = true;
      break;
    }

    if (!focused) {
      const created = await self.clients.openWindow(url);
      opened = Boolean(created);
      action = opened ? 'openWindow' : 'openWindow-failed';
      if (created) created.postMessage({ type: 'notificationclick', url, action });
    }

    try {
      await fetch('/lab/notification-click', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          at: new Date().toISOString(),
          action,
          focused,
          opened,
          clientCount: windows.length,
        }),
      });
    } catch (err) {
      console.log(`notificationclick-log-failed:${err instanceof Error ? err.message : 'erro'}`);
    }
  })());
});

// O MDN marca este evento como disponibilidade limitada (não é Baseline).
// O lab só registra se ele disparar. A limpeza da inscrição morta fica
// no servidor, quando o push service responde 404 ou 410.
self.addEventListener('pushsubscriptionchange', (event) => {
  const oldEndpoint = event.oldSubscription ? event.oldSubscription.endpoint : null;
  event.waitUntil((async () => {
    await fetch('/lab/subscription-change', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        oldEndpoint,
        hasOldSubscription: Boolean(event.oldSubscription),
        hasNewSubscription: Boolean(event.newSubscription),
      }),
    });
  })());
});

function isApi(pathname) {
  return pathname.startsWith('/lab/')
    || pathname === '/send'
    || pathname === '/subscribe'
    || pathname === '/vapid-public-key'
    || pathname === '/health';
}

async function networkThenCache(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put(request, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Sem rede e sem cópia guardada.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}

function readPayload(raw) {
  const fallback = {
    title: 'Lab Web Push',
    body: raw || 'Notificação sem texto.',
    url: '/',
  };
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return {
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : fallback.title,
      body: typeof parsed.body === 'string' ? parsed.body : raw,
      url: typeof parsed.url === 'string' && parsed.url.startsWith('/') ? parsed.url : '/',
    };
  } catch {
    return { ...fallback, body: raw };
  }
}
