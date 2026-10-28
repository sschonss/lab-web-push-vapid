import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installWireLog } from './wire-log.js';
import { decodeVapidAuthorization, maskEndpoint } from './vapid-jwt.js';

const wire = installWireLog(https);
const webpush = (await import('web-push')).default;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

loadDotEnv(path.join(root, '.env'));

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const subject = process.env.VAPID_SUBJECT || 'mailto:webpush-lab@luizschons.com';
const allowInsecureLocalPush = process.env.LAB_ALLOW_INSECURE_LOCAL_PUSH === '1';

fs.mkdirSync(dataDir, { recursive: true });

const keys = loadOrCreateKeys(dataDir);
const sendToken = loadOrCreateToken(dataDir);
webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

const insecureAgent = new https.Agent({ rejectUnauthorized: false });
const receipts = [];
const clicks = [];
const subscriptionChanges = [];
const swLogs = [];

const server = createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    const status = Number(err.status) || 500;
    sendJson(res, status, { error: err.message || 'erro interno' });
  }
});

server.listen(port, host, () => {
  const info = { host, port };
  fs.writeFileSync(path.join(dataDir, 'server.json'), JSON.stringify(info, null, 2));
  console.log('');
  console.log('Lab Web Push com VAPID');
  console.log(`  página:   http://${host}:${port}`);
  console.log(`  assunto:  ${subject}`);
  console.log(`  chaves:   ${path.join(dataDir, 'vapid.json')} (a privada fica só aqui)`);
  console.log(`  token:    ${sendToken}`);
  console.log('');
  console.log('Com a aba fechada, dispare um envio em outro terminal:');
  console.log('  npm run send');
  console.log('');
});

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${host}:${port}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/vapid-public-key') {
    sendJson(res, 200, { publicKey: keys.publicKey });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/subscribe') {
    const body = await readJson(req);
    const subscription = normalizeSubscription(body);
    const total = upsertSubscription(subscription, req.headers['user-agent'] || '');
    sendJson(res, 200, { ok: true, total, endpoint: maskEndpoint(subscription.endpoint) });
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/subscribe') {
    const body = await readJson(req);
    if (typeof body.endpoint !== 'string' || body.endpoint.length === 0) {
      throw httpError(400, 'Falta o endpoint da inscrição.');
    }
    const removed = removeSubscription(body.endpoint);
    sendJson(res, 200, { ok: true, removed, total: readSubscriptions().length });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/send') {
    if (!authorized(req)) {
      throw httpError(401, 'Token ausente ou errado. Ele aparece no terminal do npm start.');
    }
    const body = await readJson(req);
    const result = await sendToAll(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/lab/session') {
    assertLoopback(req);
    sendJson(res, 200, { token: sendToken });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/lab/evidence') {
    assertLoopback(req);
    sendJson(res, 200, evidence());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/lab/reset-log') {
    assertLoopback(req);
    wire.clear();
    receipts.length = 0;
    clicks.length = 0;
    subscriptionChanges.length = 0;
    swLogs.length = 0;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/lab/push-received') {
    const body = await readJson(req);
    receipts.push({
      at: typeof body.at === 'string' ? body.at : new Date().toISOString(),
      raw: typeof body.raw === 'string' ? body.raw.slice(0, 4000) : '',
      title: typeof body.title === 'string' ? body.title.slice(0, 200) : '',
      body: typeof body.body === 'string' ? body.body.slice(0, 1000) : '',
      url: typeof body.url === 'string' ? body.url.slice(0, 300) : '',
    });
    if (receipts.length > 50) receipts.shift();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/lab/notification-click') {
    const body = await readJson(req);
    clicks.push({
      at: typeof body.at === 'string' ? body.at : new Date().toISOString(),
      url: typeof body.url === 'string' ? body.url.slice(0, 300) : '',
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/lab/subscription-change') {
    const body = await readJson(req);
    subscriptionChanges.push({
      at: new Date().toISOString(),
      oldEndpoint: typeof body.oldEndpoint === 'string' ? maskEndpoint(body.oldEndpoint) : null,
      hasOldSubscription: Boolean(body.hasOldSubscription),
      hasNewSubscription: Boolean(body.hasNewSubscription),
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/lab/sw-log') {
    const body = await readJson(req);
    swLogs.push({
      at: new Date().toISOString(),
      message: typeof body.message === 'string' ? body.message.slice(0, 500) : '',
    });
    if (swLogs.length > 50) swLogs.shift();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(url.pathname, res);
    return;
  }

  throw httpError(404, 'Rota não encontrada.');
}

async function sendToAll(body) {
  const title = cleanText(body.title, 120) || 'Lab Web Push';
  const text = cleanText(body.body, 280) || 'Mensagem do laboratório.';
  const targetUrl = typeof body.url === 'string' && body.url.startsWith('/')
    ? body.url.slice(0, 200)
    : '/';
  const plaintext = JSON.stringify({ title, body: text, url: targetUrl });
  const subscriptions = readSubscriptions();
  const results = [];
  let removed = 0;

  for (const subscription of subscriptions) {
    const before = wire.count();
    const options = {
      TTL: 3600,
      urgency: 'high',
      topic: 'lab',
    };
    const agent = agentFor(subscription.endpoint);
    if (agent) options.agent = agent;

    wire.setContext({ plaintext, endpoint: subscription.endpoint });
    try {
      const response = await webpush.sendNotification(subscription, plaintext, options);
      if (wire.count() === before) {
        throw httpError(502, 'O envio não gerou um pedido HTTP observável.');
      }
      wire.annotateLast({ removed: false, reportedStatus: response.statusCode });
      results.push({
        endpoint: maskEndpoint(subscription.endpoint),
        statusCode: response.statusCode,
        removed: false,
      });
    } catch (err) {
      if (err.status === 502) throw err;
      const statusCode = Number(err.statusCode) || 0;
      const gone = statusCode === 404 || statusCode === 410;
      if (gone) {
        removeSubscription(subscription.endpoint);
        removed += 1;
      }
      if (wire.count() > before) {
        wire.annotateLast({
          removed: gone,
          reportedStatus: statusCode,
          errorBody: typeof err.body === 'string' ? err.body.slice(0, 500) : err.message,
        });
      }
      results.push({
        endpoint: maskEndpoint(subscription.endpoint),
        statusCode,
        removed: gone,
        error: typeof err.body === 'string' && err.body.length > 0 ? err.body.slice(0, 300) : err.message,
      });
    } finally {
      wire.clearContext();
    }
  }

  return {
    sent: results.length,
    removed,
    plaintext,
    results,
  };
}

function agentFor(endpoint) {
  if (!allowInsecureLocalPush) return undefined;
  const url = new URL(endpoint);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return insecureAgent;
  return undefined;
}

function evidence() {
  return {
    subject,
    subscriptionCount: readSubscriptions().length,
    subscriptions: readSubscriptions().map((item) => ({
      endpoint: item.endpoint,
      endpointMasked: maskEndpoint(item.endpoint),
      expirationTime: item.expirationTime ?? null,
      createdAt: item.createdAt,
      userAgent: item.userAgent,
      p256dhBytes: Buffer.from(item.keys.p256dh, 'base64url').length,
      authBytes: Buffer.from(item.keys.auth, 'base64url').length,
    })),
    sends: wire.all().map((entry) => decorateSend(entry)),
    receipts: receipts.slice(),
    clicks: clicks.slice(),
    subscriptionChanges: subscriptionChanges.slice(),
    swLogs: swLogs.slice(),
  };
}

function decorateSend(entry) {
  const headers = entry.headers || {};
  const authorization = headerValue(headers, 'authorization');
  const body = entry.bodyBase64 ? Buffer.from(entry.bodyBase64, 'base64') : Buffer.alloc(0);
  const plain = typeof entry.plaintext === 'string' ? Buffer.from(entry.plaintext, 'utf8') : null;
  const jwt = decodeVapidAuthorization(authorization);
  const responseBody = entry.response?.bodyBase64
    ? Buffer.from(entry.response.bodyBase64, 'base64')
    : Buffer.alloc(0);

  return {
    startedAt: entry.startedAt,
    completedAt: entry.completedAt ?? null,
    endpoint: entry.endpoint,
    endpointMasked: entry.endpoint ? maskEndpoint(entry.endpoint) : null,
    method: entry.method,
    hostname: entry.hostname,
    port: entry.port,
    path: entry.path,
    headers,
    bodyBase64: entry.bodyBase64,
    bodyBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    plaintext: entry.plaintext,
    plaintextFoundInBody: plain ? body.includes(plain) : null,
    removed: Boolean(entry.removed),
    reportedStatus: entry.reportedStatus ?? null,
    errorBody: entry.errorBody ?? null,
    transportError: entry.error,
    jwt: jwt
      ? {
          ok: jwt.ok,
          error: jwt.error,
          header: jwt.header,
          payload: jwt.payload,
          signatureValid: jwt.signatureValid,
          publicKeyMatches: jwt.publicKey ? jwt.publicKey === keys.publicKey : false,
          token: jwt.token,
          publicKey: jwt.publicKey,
        }
      : null,
    response: entry.response
      ? {
          statusCode: entry.response.statusCode,
          headers: entry.response.headers,
          bodyText: entry.response.bodyText,
          bodyBytes: responseBody.length,
        }
      : null,
  };
}

function headerValue(headers, name) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

function serveStatic(pathname, res) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '');
  const full = path.resolve(publicDir, requested);
  const relative = path.relative(publicDir, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(403, 'Caminho recusado.');
  }
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    throw httpError(404, 'Arquivo não encontrado.');
  }
  const ext = path.extname(full);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };
  res.writeHead(200, {
    'content-type': types[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

function normalizeSubscription(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'JSON da inscrição inválido.');
  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
    throw httpError(400, 'A inscrição precisa de endpoint, keys.p256dh e keys.auth.');
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw httpError(400, 'Endpoint não é uma URL.');
  }
  if (url.protocol !== 'https:') {
    throw httpError(400, 'O endpoint do push service precisa ser https.');
  }
  let publicBytes;
  let authBytes;
  try {
    publicBytes = Buffer.from(p256dh, 'base64url');
    authBytes = Buffer.from(auth, 'base64url');
  } catch {
    throw httpError(400, 'As chaves da inscrição não estão em base64url.');
  }
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw httpError(400, 'p256dh precisa ser um ponto P-256 não comprimido (65 bytes).');
  }
  if (authBytes.length < 16) {
    throw httpError(400, 'auth precisa ter pelo menos 16 bytes.');
  }
  return {
    endpoint,
    expirationTime: body.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

function subscriptionsFile() {
  return path.join(dataDir, 'subscriptions.json');
}

function readSubscriptions() {
  const file = subscriptionsFile();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSubscriptions(list) {
  const file = subscriptionsFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, file);
}

function upsertSubscription(subscription, userAgent) {
  const list = readSubscriptions().filter((item) => item.endpoint !== subscription.endpoint);
  list.push({
    ...subscription,
    createdAt: new Date().toISOString(),
    userAgent: String(userAgent).slice(0, 300),
  });
  writeSubscriptions(list);
  return list.length;
}

function removeSubscription(endpoint) {
  const list = readSubscriptions();
  const next = list.filter((item) => item.endpoint !== endpoint);
  writeSubscriptions(next);
  return next.length !== list.length;
}

function loadOrCreateKeys(dir) {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY.trim(),
      privateKey: process.env.VAPID_PRIVATE_KEY.trim(),
      created: false,
    };
  }
  const file = path.join(dir, 'vapid.json');
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { publicKey: saved.publicKey, privateKey: saved.privateKey, created: false };
  }
  const generated = webpush.generateVAPIDKeys();
  fs.writeFileSync(file, `${JSON.stringify(generated, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // alguns sistemas de arquivo ignoram chmod
  }
  return { ...generated, created: true };
}

function loadOrCreateToken(dir) {
  if (process.env.SEND_TOKEN && process.env.SEND_TOKEN.trim()) return process.env.SEND_TOKEN.trim();
  const file = path.join(dir, 'send-token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = randomBytes(24).toString('hex');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function authorized(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const got = Buffer.from(match[1].trim());
  const expected = Buffer.from(sendToken);
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

function assertLoopback(req) {
  const address = req.socket.remoteAddress || '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!loopback) throw httpError(403, 'Esta rota só responde no próprio computador.');
}

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

async function readJson(req) {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw httpError(400, 'JSON inválido.');
  }
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError(413, 'Corpo grande demais.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
