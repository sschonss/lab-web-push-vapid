import { createECDH, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ece = require('http_ece');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data', 'validate');
const port = 8787;
const mockPort = 8799;
const base = `http://127.0.0.1:${port}`;
const report = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
  chrome: null,
  display: null,
  mock: null,
  browser: null,
  problems: [],
};

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const children = [];
let browserHandle = null;

try {
  report.chrome = execFileSync('google-chrome', ['--version'], { encoding: 'utf8' }).trim();
} catch (err) {
  report.chrome = `indisponível: ${err.message}`;
}

const xvfb = ensureDisplay();
if (xvfb) children.push(xvfb);
await sleep(400);
report.display = process.env.DISPLAY || null;

const cert = makeCertificate();
const mock = await startMock(cert);
const server = startServer();
children.push(server.child);
await waitForHealth(server.child);

try {
  try {
    report.mock = await runMockProof(mock);
  } catch (err) {
    report.mock = { ok: false, error: err.stack || err.message };
    report.problems.push('A prova com o push service simulado falhou.');
  }
  try {
    report.browser = await runBrowserProof();
  } catch (err) {
    report.browser = { attempted: true, error: err.stack || err.message };
    report.problems.push('A prova no Chrome falhou antes de terminar.');
  }
} finally {
  await stopAll(mock);
}

const redacted = redact(report);
const redactedPath = path.join(dataDir, 'redacted.json');
fs.writeFileSync(redactedPath, `${JSON.stringify(redacted, null, 2)}\n`);
assertNoSecrets(redactedPath);
console.log(JSON.stringify(redacted, null, 2));

if (report.mock?.ok !== true) process.exitCode = 1;

function ensureDisplay() {
  if (process.env.DISPLAY) return null;
  const child = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-ac'], { stdio: 'ignore' });
  process.env.DISPLAY = ':99';
  return child;
}

function makeCertificate() {
  const dir = path.join(dataDir, 'certs');
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', key, '-out', cert,
    '-days', '1', '-nodes',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { key, cert };
}

function startMock(cert) {
  const received = [];
  let mode = 'created';
  const server = https.createServer(
    { key: fs.readFileSync(cert.key), cert: fs.readFileSync(cert.cert) },
    (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        received.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          bodyBase64: body.toString('base64'),
        });
        if (mode === 'created') {
          res.writeHead(201, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('');
        } else {
          res.writeHead(410, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Gone');
        }
      });
    },
  );
  return new Promise((resolve) => {
    server.listen(mockPort, '127.0.0.1', () => {
      resolve({
        server,
        received,
        setMode(next) { mode = next; },
      });
    });
  });
}

function startServer() {
  const env = { ...process.env };
  delete env.VAPID_PUBLIC_KEY;
  delete env.VAPID_PRIVATE_KEY;
  delete env.SEND_TOKEN;
  env.HOST = '127.0.0.1';
  env.PORT = String(port);
  env.DATA_DIR = dataDir;
  env.LAB_ALLOW_INSECURE_LOCAL_PUSH = '1';
  env.VAPID_SUBJECT = 'mailto:webpush-lab@luizschons.com';
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  child.on('exit', (code) => {
    if (code) console.error(logs);
  });
  return { child, logs: () => logs };
}

async function waitForHealth(child) {
  const started = Date.now();
  while (Date.now() - started < 10000) {
    if (child.exitCode != null) throw new Error(`servidor encerrou com ${child.exitCode}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // ainda subindo
    }
    await sleep(200);
  }
  throw new Error('o servidor não respondeu /health');
}

async function runMockProof(mock) {
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  const p256dh = curve.getPublicKey().toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  const endpoint = `https://127.0.0.1:${mockPort}/push/${randomBytes(16).toString('hex')}`;

  const subscribed = await postJson('/subscribe', {
    endpoint,
    keys: { p256dh, auth },
  });
  if (!subscribed.ok) throw new Error(`subscribe do mock falhou: ${subscribed.text}`);

  const sent = await postSend({
    title: 'Prova local',
    body: 'O push service simulado vê só o ciphertext.',
    url: '/prova-local',
  });
  const evidence = await getJson('/lab/evidence');
  const send = evidence.sends.at(-1);
  const seen = mock.received.at(-1);
  const wireBody = Buffer.from(send.bodyBase64, 'base64');
  const seenBody = Buffer.from(seen.bodyBase64, 'base64');
  let decrypted = null;
  let decryptError = null;
  try {
    decrypted = ece.decrypt(wireBody, {
      version: 'aes128gcm',
      privateKey: curve,
      authSecret: auth,
    }).toString('utf8');
  } catch (err) {
    decryptError = err.message;
  }

  mock.setMode('gone');
  const gone = await postSend({
    title: 'Inscrição morta',
    body: 'Isto não deve permanecer guardado.',
    url: '/expirada',
  });
  const after = await getJson('/lab/evidence');
  const stillThere = after.subscriptions.some((item) => item.endpoint === endpoint);

  const headers = seen.headers;
  const authorization = headers.authorization || '';
  return {
    ok: sent.status === 200
      && seen
      && headers['content-encoding'] === 'aes128gcm'
      && authorization.startsWith('vapid t=')
      && send.jwt?.signatureValid === true
      && send.jwt?.payload?.aud === `https://127.0.0.1:${mockPort}`
      && send.jwt?.payload?.sub === 'mailto:webpush-lab@luizschons.com'
      && headers.ttl === '3600'
      && headers.urgency === 'high'
      && send.plaintextFoundInBody === false
      && decrypted === send.plaintext
      && wireBody.equals(seenBody)
      && gone.json?.results?.[0]?.statusCode === 410
      && gone.json?.results?.[0]?.removed === true
      && stillThere === false,
    kind: 'push service HTTPS local, no papel do FCM. O pedido cru foi lido por este processo, não pela Google.',
    subscribeStatus: subscribed.status,
    firstStatus: seen ? 201 : null,
    firstResponseBody: '',
    request: {
      method: seen?.method,
      path: seen?.url,
      headers,
      bodyBase64: seen?.bodyBase64,
      bodyBytes: seenBody.length,
    },
    serverSawSameBody: wireBody.equals(seenBody),
    plaintext: send?.plaintext,
    plaintextFoundInBody: send?.plaintextFoundInBody,
    decrypted,
    decryptError,
    jwt: send?.jwt,
    wireSha256: send?.sha256,
    second: {
      httpStatus: gone.status,
      pushStatus: gone.json?.results?.[0]?.statusCode ?? null,
      removed: gone.json?.results?.[0]?.removed ?? null,
      error: gone.json?.results?.[0]?.error ?? null,
      subscriptionStillStored: stillThere,
      responseBody: after.sends.at(-1)?.response?.bodyText ?? null,
    },
  };
}

async function runBrowserProof() {
  const notes = [];
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { attempted: false, error: `playwright não carregou: ${err.message}` };
  }

  const chromeArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1100,820',
  ];
  // O contexto padrão do Playwright é anônimo. O Chrome 156 recusa a Push API
  // nesse modo (crbug.com/41124656) com "Registration failed - permission denied".
  const profile = path.join(dataDir, 'chrome-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  let context;
  let resultHeadless = false;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1100, height: 820 },
      permissions: ['notifications'],
      args: chromeArgs,
    });
  } catch (err) {
    notes.push(`Chrome com janela falhou: ${err.message}`);
    try {
      context = await chromium.launchPersistentContext(profile, {
        headless: true,
        channel: 'chrome',
        permissions: ['notifications'],
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run'],
      });
      resultHeadless = true;
      notes.push('Seguimos em Chrome headless, ainda com perfil persistente.');
    } catch (err2) {
      return { attempted: true, launched: false, error: err2.message, notes };
    }
  }
  browserHandle = context;
  notes.push('Perfil persistente, não anônimo: o Chrome não cria inscrição push em janela anônima.');

  const consoleLines = [];
  await context.grantPermissions(['notifications'], { origin: base });
  context.on('serviceworker', (worker) => {
    worker.on('console', (msg) => consoleLines.push(`SW ${msg.type()}: ${msg.text()}`));
  });

  const page = context.pages()[0] || await context.newPage();
  page.on('console', (msg) => consoleLines.push(`PAGE ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`PAGEERROR ${err.message}`));

  const result = {
    attempted: true,
    launched: true,
    headless: resultHeadless,
    permission: null,
    subscribed: false,
    endpoint: null,
    userAgent: null,
    openTab: null,
    closedTab: null,
    notificationClick: null,
    expired: null,
    notes,
    consoleLines: [],
  };

  try {
    await postJson('/lab/reset-log', {});
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#enable:not([disabled])', { timeout: 10000 });
    await page.click('#enable');
    await page.waitForSelector('#sub[data-state="subscribed"]', { timeout: 45000 });
    await page.waitForSelector('#send:not([disabled])', { timeout: 5000 });
    result.subscribed = true;
    result.endpoint = await page.getAttribute('#sub', 'data-endpoint');
    result.permission = await page.evaluate(() => Notification.permission);
    result.userAgent = await page.evaluate(() => navigator.userAgent);

    await postJson('/lab/reset-log', {});
    await page.click('#send');
    await page.waitForFunction(() => {
      const status = document.querySelector('#status');
      return Boolean(status && /respondeu|não havia/i.test(status.textContent || ''));
    }, { timeout: 30000 });
    result.openTab = await describeDelivery('aba aberta');
    if (result.openTab.send?.response?.statusCode === 201) {
      result.openTab.receiptVisible = await waitForReceipt(page, 'Disparo com a página ainda aberta.', 40000);
    } else {
      result.openTab.receiptVisible = null;
      notes.push('O primeiro envio não teve 201. Não esperei o service worker.');
    }
    await page.screenshot({ path: path.join(dataDir, 'subscribed.png'), fullPage: true });

    await postJson('/lab/reset-log', {});
    await page.close();
    result.closedTab = { serviceWorkersAfterClose: context.serviceWorkers().length };
    const closed = await postSend({
      title: 'Prova no Chrome',
      body: 'Disparo com a aba fechada.',
      url: '/',
    });
    result.closedTab.send = summarizeSend(closed, await getJson('/lab/evidence'));
    if (result.closedTab.send?.result?.statusCode === 201) {
      result.closedTab.serviceWorkerRaw = await waitForEvidenceRaw('Disparo com a aba fechada.', 40000);
    } else {
      result.closedTab.serviceWorkerRaw = null;
    }
    result.closedTab.serviceWorkersLater = context.serviceWorkers().length;

    result.notificationClick = await tryClickNotification(context);

    const again = await context.newPage();
    again.on('console', (msg) => consoleLines.push(`PAGE ${msg.type()}: ${msg.text()}`));
    await again.goto(base, { waitUntil: 'domcontentloaded' });
    await again.waitForSelector('#revoke:not([disabled])', { timeout: 10000 });
    await again.click('#revoke');
    await again.waitForSelector('#sub[data-state="revoked"]', { timeout: 10000 });
    result.expired = await sendExpiredAttempt('O push service deve recusar.');
    if (result.expired.result?.statusCode !== 404 && result.expired.result?.statusCode !== 410) {
      await sleep(70000);
      result.expiredLater = await sendExpiredAttempt('Tentativa cerca de um minuto após o unsubscribe.');
    }
  } catch (err) {
    result.error = err.message;
    notes.push(err.stack || err.message);
    try {
      result.statusText = await page.locator('#status').innerText();
    } catch {
      result.statusText = null;
    }
    try {
      await page.screenshot({ path: path.join(dataDir, 'failure.png'), fullPage: true });
    } catch {
      // a página pode já ter fechado
    }
  } finally {
    result.consoleLines = consoleLines.slice(-40);
    await context.close();
    browserHandle = null;
  }
  return result;
}

async function sendExpiredAttempt(note) {
  const http = await postSend({
    title: 'Inscrição cancelada',
    body: note,
    url: '/',
  });
  const evidence = await getJson('/lab/evidence');
  return {
    ...summarizeSend(http, evidence),
    subscriptionCount: evidence.subscriptionCount,
    subscriptionChanges: evidence.subscriptionChanges,
  };
}

async function describeDelivery(label) {
  const evidence = await getJson('/lab/evidence');
  const send = evidence.sends.at(-1) || null;
  return {
    label,
    send: send ? publicSend(send) : null,
    receipt: evidence.receipts.at(-1) || null,
  };
}

function summarizeSend(http, evidence) {
  const send = evidence.sends.at(-1) || null;
  return {
    appStatus: http.status,
    result: http.json?.results?.[0] ?? null,
    observed: send ? publicSend(send) : null,
  };
}

function publicSend(send) {
  return {
    endpoint: send.endpoint,
    endpointMasked: send.endpointMasked,
    hostname: send.hostname,
    path: send.path,
    headers: send.headers,
    bodyBase64: send.bodyBase64,
    bodyBytes: send.bodyBytes,
    sha256: send.sha256,
    plaintext: send.plaintext,
    plaintextFoundInBody: send.plaintextFoundInBody,
    removed: send.removed,
    jwt: send.jwt,
    response: send.response,
    transportError: send.transportError,
  };
}

async function waitForReceipt(page, needle, timeoutMs) {
  try {
    await page.waitForFunction((expected) => {
      const node = document.querySelector('#receipt-text');
      return Boolean(node && node.textContent.includes(expected));
    }, needle, { timeout: timeoutMs });
    return await page.locator('#receipt-text').innerText();
  } catch {
    return null;
  }
}

async function waitForEvidenceRaw(needle, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const evidence = await getJson('/lab/evidence');
    const found = evidence.receipts.find((item) => item.raw.includes(needle));
    if (found) return found.raw;
    const logged = evidence.swLogs.find((item) => item.message.includes(needle));
    if (logged) return logged.message;
    await sleep(1000);
  }
  return null;
}

async function tryClickNotification(context) {
  const attempt = {
    tested: false,
    method: null,
    clicksRecorded: 0,
    pagesAfter: 0,
    windows: [],
    note: '',
  };
  const evidenceBefore = await getJson('/lab/evidence');
  attempt.clicksRecorded = evidenceBefore.clicks.length;

  let notes = [];
  try {
    const worker = context.serviceWorkers()[0];
    if (worker) {
      notes = await worker.evaluate(async () => {
        const list = await self.registration.getNotifications();
        return list.map((item) => ({ title: item.title, body: item.body, tag: item.tag }));
      });
    }
  } catch (err) {
    attempt.note += `getNotifications falhou: ${err.message}. `;
  }
  attempt.notificationsInServiceWorker = notes;

  let ids = [];
  try {
    const output = execFileSync('xdotool', ['search', '--name', 'Prova no Chrome'], {
      encoding: 'utf8',
      env: process.env,
    }).trim();
    ids = output.split('\n').filter(Boolean);
  } catch {
    ids = [];
  }
  attempt.windows = ids;
  if (ids.length === 0) {
    attempt.tested = false;
    attempt.note += 'Nenhuma janela com o título da notificação apareceu no Xvfb. O clique visível não foi exercido.';
    return attempt;
  }

  attempt.tested = true;
  attempt.method = 'xdotool';
  try {
    execFileSync('xdotool', ['windowactivate', '--sync', ids[0], 'click', '1'], { env: process.env });
    await sleep(1500);
  } catch (err) {
    attempt.note += `xdotool não clicou: ${err.message}`;
    return attempt;
  }
  const after = await getJson('/lab/evidence');
  attempt.clicksRecorded = after.clicks.length;
  attempt.pagesAfter = context.pages().length;
  return attempt;
}

async function postSend(payload) {
  const token = fs.readFileSync(path.join(dataDir, 'send-token'), 'utf8').trim();
  const response = await fetch(`${base}/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: response.status, text, json };
}

async function postJson(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text };
}

async function getJson(pathname) {
  const response = await fetch(`${base}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} respondeu ${response.status}`);
  return response.json();
}

function redact(input) {
  const keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'vapid.json'), 'utf8'));
  const clone = JSON.parse(JSON.stringify(input));
  walk(clone, keys);
  return clone;
}

function walk(value, keys) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = scrub(value[index], keys);
      else walk(value[index], keys);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'headers' && item && typeof item === 'object') {
      value[key] = redactHeaders(item, keys);
      continue;
    }
    if (key === 'jwt' && item && typeof item === 'object') {
      value[key] = redactJwt(item, keys);
      continue;
    }
    if ((key === 'endpoint' || key === 'path' || key === 'url') && typeof item === 'string') {
      value[key] = maskUrl(item);
      continue;
    }
    if (key === 'bodyBase64' && typeof item === 'string') continue;
    if (typeof item === 'string') {
      value[key] = scrub(item, keys);
      continue;
    }
    walk(item, keys);
  }
}

function redactHeaders(headers, keys) {
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') {
      next[name] = maskAuthorization(String(value), keys);
    } else if (typeof value === 'string') {
      next[name] = scrub(value, keys);
    } else {
      next[name] = value;
    }
  }
  return next;
}

function redactJwt(jwt, keys) {
  if (!jwt || jwt.ok === false) return jwt;
  return {
    ok: jwt.ok,
    header: jwt.header,
    payload: jwt.payload,
    signatureValid: jwt.signatureValid,
    publicKeyMatches: jwt.publicKeyMatches,
    tokenMasked: maskSecret(jwt.token),
    publicKeyMasked: maskSecret(jwt.publicKey),
    publicKeyBytes: jwt.publicKey ? Buffer.from(jwt.publicKey, 'base64url').length : null,
  };
}

function maskAuthorization(value, keys) {
  const match = value.match(/^vapid t=([^,\s]+),\s*k=(.+)$/);
  if (!match) return scrub(value, keys);
  return `vapid t=${maskSecret(match[1], 12, 6)}, k=${maskSecret(match[2], 6, 4)}`;
}

function maskSecret(value, head = 8, tail = 4) {
  if (!value || value.length <= head + tail + 1) return '…';
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function maskUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    url.pathname = maskPath(url.pathname);
    return url.toString();
  } catch {
    return maskPath(value);
  }
}

function maskPath(value) {
  const parts = String(value).split('/');
  const last = parts.at(-1) ?? '';
  if (last.length > 12) {
    parts[parts.length - 1] = `${last.slice(0, 4)}…${last.slice(-4)}`;
  }
  return parts.join('/');
}

function scrub(value, keys) {
  let next = value;
  if (keys.privateKey) next = next.split(keys.privateKey).join('[chave-privada-removida]');
  if (keys.publicKey) next = next.split(keys.publicKey).join('[chave-publica-removida]');
  return next;
}

function assertNoSecrets(file) {
  const keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'vapid.json'), 'utf8'));
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(keys.privateKey) || text.includes(keys.publicKey)) {
    throw new Error('o relatório redigido ainda contém uma chave VAPID');
  }
}

async function stopAll(mock) {
  if (browserHandle) {
    await browserHandle.close().catch(() => {});
  }
  await new Promise((resolve) => mock.server.close(resolve));
  for (const child of children) {
    if (child.exitCode == null && !child.killed) child.kill('SIGTERM');
  }
  await sleep(200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
