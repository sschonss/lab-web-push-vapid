const enableButton = document.querySelector('#enable');
const sendButton = document.querySelector('#send');
const revokeButton = document.querySelector('#revoke');
const forgetButton = document.querySelector('#forget');
const statusNode = document.querySelector('#status');
const subNode = document.querySelector('#sub');
const receiptNode = document.querySelector('#receipt');
const receiptText = document.querySelector('#receipt-text');
const wireNode = document.querySelector('#wire');
const countNode = document.querySelector('#count');

const OPEN_BODY = 'Disparo com a página ainda aberta.';
const state = { endpoint: null };

boot().catch((err) => setStatus(err.message || 'Não foi possível preparar a página.', 'error'));

enableButton.addEventListener('click', () => {
  subscribe().catch((err) => {
    enableButton.disabled = false;
    setStatus(err.message || 'Falha ao inscrever.', 'error');
  });
});

sendButton.addEventListener('click', () => {
  sendNow().catch((err) => {
    sendButton.disabled = false;
    setStatus(err.message || 'Falha ao disparar.', 'error');
  });
});

revokeButton.addEventListener('click', () => {
  revokeInBrowser().catch((err) => setStatus(err.message || 'Falha ao cancelar no navegador.', 'error'));
});

forgetButton.addEventListener('click', () => {
  forgetOnServer().catch((err) => setStatus(err.message || 'Falha ao apagar no servidor.', 'error'));
});

navigator.serviceWorker?.addEventListener('message', (event) => {
  if (event.data?.type === 'push' && typeof event.data.raw === 'string') {
    showReceipt(event.data.raw);
  }
});

async function boot() {
  if (!window.isSecureContext) {
    throw new Error('Web Push exige HTTPS. localhost e 127.0.0.1 são a exceção.');
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error('Este navegador não expõe service worker e PushManager.');
  }

  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await postSubscription(existing);
    showSubscription(existing);
    setStatus('Este navegador já estava inscrito. A inscrição foi reenviada ao servidor.', 'ok');
  } else if (Notification.permission === 'denied') {
    setStatus('A permissão foi negada. O site não pode pedir de novo: mude isso nas configurações do navegador.', 'error');
  } else {
    setStatus('Pronto para inscrever. A permissão só é pedida no clique.', 'idle');
  }
  enableButton.disabled = false;
  refreshEvidence();
  window.setInterval(refreshEvidence, 2000);
}

async function subscribe() {
  enableButton.disabled = true;
  setStatus('Pedindo permissão e falando com o push service do navegador…', 'idle');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    enableButton.disabled = false;
    setStatus('Permissão não concedida. Sem ela o navegador não cria a inscrição.', 'error');
    return;
  }

  const registration = await navigator.serviceWorker.ready;
  const keyResponse = await fetch('/vapid-public-key');
  if (!keyResponse.ok) throw new Error('O servidor não entregou a chave pública VAPID.');
  const { publicKey } = await keyResponse.json();

  let subscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro desconhecido';
    throw new Error(`O navegador recusou a inscrição: ${message}`);
  }

  await postSubscription(subscription);
  showSubscription(subscription);
  setStatus('Inscrição criada. Pode fechar a aba e disparar o envio pelo terminal.', 'ok');
  enableButton.disabled = false;
}

async function postSubscription(subscription) {
  const response = await fetch('/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'O servidor recusou a inscrição.');
  }
}

async function sendNow() {
  sendButton.disabled = true;
  const session = await fetch('/lab/session');
  if (!session.ok) throw new Error('Não consegui ler o token local do servidor.');
  const { token } = await session.json();
  const response = await fetch('/send', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: 'Lab Web Push',
      body: OPEN_BODY,
      url: '/',
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'O envio falhou.');
  const first = data.results?.[0];
  setStatus(
    first
      ? `Envio pedido. O push service respondeu ${first.statusCode}.`
      : 'Não havia inscrição guardada no servidor.',
    first ? 'ok' : 'error',
  );
  sendButton.disabled = false;
  refreshEvidence();
}

async function revokeInBrowser() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    setStatus('Não há inscrição neste navegador.', 'error');
    return;
  }
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  state.endpoint = endpoint;
  subNode.dataset.state = 'revoked';
  setStatus(
    'O navegador cancelou a inscrição no push service. O servidor ainda a tem guardada. Dispare um envio: a resposta deve ser 404 ou 410, e o servidor apaga o registro.',
    'ok',
  );
  sendButton.disabled = false;
  revokeButton.disabled = true;
}

async function forgetOnServer() {
  if (!state.endpoint) throw new Error('Não há endpoint para apagar.');
  const response = await fetch('/subscribe', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: state.endpoint }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Não apaguei a inscrição.');
  setStatus(
    data.removed
      ? 'Inscrição apagada do servidor, sem esperar 410.'
      : 'O servidor já não tinha essa inscrição.',
    'ok',
  );
  refreshEvidence();
}

function showSubscription(subscription) {
  const json = subscription.toJSON();
  state.endpoint = json.endpoint;
  const masked = maskEndpoint(json.endpoint);
  subNode.hidden = false;
  subNode.dataset.state = 'subscribed';
  subNode.dataset.endpoint = json.endpoint;
  subNode.querySelector('[data-field="origin"]').textContent = masked.origin;
  subNode.querySelector('[data-field="endpoint"]').textContent = masked.masked;
  subNode.querySelector('[data-field="p256dh"]').textContent = `${base64UrlBytes(json.keys.p256dh)} bytes`;
  subNode.querySelector('[data-field="auth"]').textContent = `${base64UrlBytes(json.keys.auth)} bytes`;
  sendButton.disabled = false;
  revokeButton.disabled = false;
  forgetButton.disabled = false;
}

async function refreshEvidence() {
  const response = await fetch('/lab/evidence');
  if (!response.ok) return;
  const data = await response.json();
  countNode.textContent = String(data.subscriptionCount);

  const receipt = data.receipts.at(-1);
  if (receipt?.raw) showReceipt(receipt.raw);

  const send = data.sends.at(-1);
  if (!send) {
    wireNode.textContent = 'Ainda não houve envio nesta execução do servidor.';
    return;
  }
  const claims = send.jwt?.payload;
  const lines = [
    `POST ${send.endpointMasked || '(endpoint mascarado)'}`,
    `status: ${send.response?.statusCode ?? send.reportedStatus ?? '—'}`,
    `Content-Encoding: ${headerOf(send, 'content-encoding') || '—'}`,
    `TTL: ${headerOf(send, 'ttl') || '—'}`,
    `Urgency: ${headerOf(send, 'urgency') || '—'}`,
    `Topic: ${headerOf(send, 'topic') || '—'}`,
    `bytes cifrados: ${send.bodyBytes}`,
    `plaintext encontrado dentro do ciphertext: ${send.plaintextFoundInBody ? 'sim' : 'não'}`,
    `inscrição apagada: ${send.removed ? 'sim' : 'não'}`,
  ];
  if (claims) {
    lines.push(`JWT aud: ${claims.aud}`);
    lines.push(`JWT exp: ${claims.exp}`);
    lines.push(`JWT sub: ${claims.sub}`);
    lines.push(`assinatura ES256 confere: ${send.jwt.signatureValid ? 'sim' : 'não'}`);
  }
  wireNode.textContent = lines.join('\n');
}

function showReceipt(raw) {
  receiptNode.hidden = false;
  receiptText.textContent = raw;
  receiptText.dataset.raw = raw;
}

function setStatus(message, kind) {
  statusNode.textContent = message;
  statusNode.dataset.kind = kind;
}

function headerOf(send, name) {
  const headers = send.headers || {};
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

function maskEndpoint(endpoint) {
  const url = new URL(endpoint);
  const parts = url.pathname.split('/');
  const last = parts.pop() || '';
  const maskedLast = last.length <= 8 ? '…' : `${last.slice(0, 4)}…${last.slice(-4)}`;
  return {
    origin: url.origin,
    masked: `${url.origin}${parts.join('/')}/${maskedLast}`,
  };
}

function base64UrlBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return atob(padded + pad).length;
}

function urlBase64ToUint8Array(base64Url) {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const raw = atob(padded + pad);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
