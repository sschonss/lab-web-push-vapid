// Service worker do laboratório. O navegador acorda este arquivo para o
// evento `push` mesmo quando nenhuma aba do site está aberta.

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
      data: { url: payload.url },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    try {
      await fetch('/lab/notification-click', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, at: new Date().toISOString() }),
      });
    } catch {
      // o clique ainda tenta abrir a janela
    }

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      if ('navigate' in client) await client.navigate(url);
      return;
    }
    await self.clients.openWindow(url);
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
