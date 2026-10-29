// Prova a PWA no Chrome com janela, no display real, com o dunst como
// daemon de notificação. O relatório redigido fica em data/validate-pwa/,
// que o git ignora. Screenshots que sustentam um passo real são copiados
// para docs/ e para /opt/cursor/artifacts/.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data', 'validate-pwa');
const port = 8788;
const base = `http://127.0.0.1:${port}`;
const origin = base;
const manifestId = `${origin}/`;

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  command: 'npm run validate:pwa',
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
  chrome: null,
  display: null,
  dunst: null,
  install: null,
  subscription: null,
  scenarios: {},
  click: null,
  chromeQuit: null,
  problems: [],
  notes: [],
};
const children = [];
let browserHandle = null;
let busPid = null;
let monitorLog = '';
const consoleLines = [];

try {
  report.chrome = execFileSync('google-chrome', ['--version'], { encoding: 'utf8' }).trim();
} catch (err) {
  report.chrome = `indisponível: ${err.message}`;
}

const xvfb = ensureDisplay();
if (xvfb) children.push(xvfb);
await sleep(300);
report.display = process.env.DISPLAY || null;

try {
  startBus();
  startDunst();
  startMonitor();
  await sleep(400);
  report.dunst = await preflightDunst();
} catch (err) {
  report.dunst = { ok: false, error: err.stack || err.message };
  report.problems.push('O dunst não ficou pronto. A notificação do sistema pode não aparecer.');
}

const server = startServer();
children.push(server.child);

try {
  await waitForHealth(server.child);
  report.browser = await runBrowser();
} catch (err) {
  report.browser = { error: err.stack || err.message };
  report.problems.push('A prova no Chrome não terminou.');
  progress(`falha: ${err.message}`);
} finally {
  await stopAll();
}

report.notificationBus = notificationExcerpt();
report.finishedAt = new Date().toISOString();
const redacted = redact(report);
const redactedPath = path.join(dataDir, 'redacted.json');
fs.writeFileSync(redactedPath, `${JSON.stringify(redacted, null, 2)}\n`);
assertNoSecrets(redactedPath);
console.log(JSON.stringify({
  startedAt: redacted.startedAt,
  finishedAt: redacted.finishedAt,
  problems: redacted.problems,
  notes: redacted.notes,
  dunst: redacted.dunst,
  install: summarizeInstall(redacted.install),
  subscription: redacted.subscription ? {
    permission: redacted.subscription.permission,
    endpointMasked: redacted.subscription.endpointMasked,
    error: redacted.subscription.error || null,
  } : null,
  scenarios: Object.fromEntries(Object.entries(redacted.scenarios || {}).map(([key, value]) => [key, {
    statusCode: value?.observed?.response?.statusCode ?? value?.result?.statusCode ?? null,
    receipt: Boolean(value?.receipt),
    visible: value?.visible || null,
    error: value?.error || null,
  }])),
  click: redacted.click ? {
    tested: redacted.click.tested,
    method: redacted.click.method,
    action: redacted.click.record?.action || null,
    focused: redacted.click.record?.focused || false,
    opened: redacted.click.record?.opened || false,
    displayModes: redacted.click.displayModes || null,
  } : null,
  chromeQuit: redacted.chromeQuit,
  screenshots: redacted.screenshots || null,
}, null, 2));

function summarizeInstall(install) {
  if (!install) return null;
  return {
    beforeinstallprompt: install.beforeinstallprompt,
    dialog: install.dialog?.accepted ?? null,
    dialogVia: install.dialog?.via || null,
    method: install.method || null,
    standalone: install.standalone || null,
    internalsMention: install.internalsMention || null,
    error: install.error || null,
  };
}

function progress(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFileSync(path.join(dataDir, 'progress.log'), line);
  process.stderr.write(line);
}

function ensureDisplay() {
  if (process.env.DISPLAY) return null;
  const child = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24', '-ac'], { stdio: 'ignore' });
  process.env.DISPLAY = ':99';
  return child;
}

function startBus() {
  const raw = execFileSync('dbus-launch', ['--sh-syntax'], { encoding: 'utf8' });
  const address = raw.match(/DBUS_SESSION_BUS_ADDRESS='([^']+)'/);
  const pid = raw.match(/DBUS_SESSION_BUS_PID=(\d+)/);
  if (!address) throw new Error(`dbus-launch não devolveu endereço: ${raw}`);
  process.env.DBUS_SESSION_BUS_ADDRESS = address[1];
  busPid = pid ? Number(pid[1]) : null;
  progress(`dbus ${address[1]}`);
}

function startDunst() {
  const config = path.join(dataDir, 'dunstrc');
  fs.writeFileSync(config, `[global]
    monitor = 0
    follow = none
    width = 420
    height = (0, 220)
    origin = top-right
    offset = 16x48
    notification_limit = 4
    transparency = 0
    frame_width = 3
    frame_color = "#f3efe6"
    separator_color = frame
    font = Monospace 13
    format = "<b>%s</b>\\n%b"
    alignment = left
    word_wrap = yes
    stack_duplicates = false
    show_indicators = yes
    icon_position = left
    min_icon_size = 48
    max_icon_size = 64
    sticky_history = yes
    history_length = 20
    timeout = 0
    corner_radius = 10
    mouse_left_click = do_action, close_current
    mouse_middle_click = close_current
    mouse_right_click = close_all
[urgency_low]
    background = "#143d32"
    foreground = "#f3efe6"
    timeout = 0
[urgency_normal]
    background = "#143d32"
    foreground = "#f3efe6"
    timeout = 0
[urgency_critical]
    background = "#8f3d1b"
    foreground = "#f3efe6"
    timeout = 0
`);
  const child = spawn('dunst', ['-config', config], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  child.on('exit', () => {
    fs.writeFileSync(path.join(dataDir, 'dunst.log'), log);
  });
  children.push(child);
}

function startMonitor() {
  const child = spawn('dbus-monitor', ['--session', "interface='org.freedesktop.Notifications'"], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { monitorLog += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { monitorLog += chunk.toString('utf8'); });
  children.push(child);
}

async function preflightDunst() {
  const reply = execFileSync('gdbus', [
    'call', '--session',
    '--dest', 'org.freedesktop.Notifications',
    '--object-path', '/org/freedesktop/Notifications',
    '--method', 'org.freedesktop.Notifications.Notify',
    'lab-preflight', '0', '',
    'Preflight dunst',
    'Daemon no display, antes do Chrome.',
    '[]', '{}', '0',
  ], { env: process.env, encoding: 'utf8' });
  await sleep(700);
  const state = dunstState();
  const shot = state.box ? shotWindow(state.box.id, 'dunst-preflight.png') : shotRoot('dunst-preflight-root.png');
  execFileSync('dunstctl', ['close-all'], { env: process.env, stdio: 'ignore' });
  await sleep(200);
  return {
    ok: state.displayed >= 1 && Boolean(state.box && state.box.height > 20),
    reply: reply.trim(),
    displayed: state.displayed,
    box: state.box,
    screenshot: shot,
    note: 'Notificação sintética, só para ver se o dunst desenha. Não é um Web Push.',
  };
}

function dunstState() {
  let displayed = 0;
  try {
    displayed = Number(execFileSync('dunstctl', ['count', 'displayed'], {
      env: process.env,
      encoding: 'utf8',
    }).trim());
  } catch {
    displayed = 0;
  }
  const boxes = listWindows().filter((item) => item.className === 'Dunst' && item.height > 20);
  return { displayed, box: boxes[0] || null, windows: listWindows() };
}

function listWindows() {
  let tree = '';
  try {
    tree = execFileSync('xwininfo', ['-root', '-tree'], { env: process.env, encoding: 'utf8' });
  } catch (err) {
    return [{ error: err.message }];
  }
  const windows = [];
  for (const line of tree.split('\n')) {
    const match = line.match(/^\s+(0x[0-9a-f]+)\s+"([^"]*)":\s+\("([^"]*)"\s+"([^"]*)"\)\s+(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    if (!match) continue;
    windows.push({
      id: match[1],
      name: match[2],
      className: match[4],
      width: Number(match[5]),
      height: Number(match[6]),
      x: Number(match[7]),
      y: Number(match[8]),
    });
  }
  return windows;
}

function shotRoot(name) {
  const dest = path.join(dataDir, name);
  try {
    execFileSync('import', ['-window', 'root', dest], { env: process.env, stdio: 'ignore' });
    return dest;
  } catch (err) {
    progress(`screenshot raiz falhou: ${err.message}`);
    return null;
  }
}

function shotWindow(id, name) {
  const dest = path.join(dataDir, name);
  try {
    execFileSync('import', ['-window', id, dest], { env: process.env, stdio: 'ignore' });
    return dest;
  } catch (err) {
    progress(`screenshot ${id} falhou: ${err.message}`);
    return shotRoot(name);
  }
}

function cropAround(source, box, name, pad = 48) {
  if (!source || !box || !fs.existsSync(source)) return null;
  const dest = path.join(dataDir, name);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const width = box.width + pad * 2;
  const height = box.height + pad * 2;
  try {
    execFileSync('convert', [
      source, '-crop', `${width}x${height}+${x}+${y}`, '+repage', '-strip', dest,
    ], { env: process.env, stdio: 'ignore' });
    return dest;
  } catch (err) {
    progress(`crop falhou: ${err.message}`);
    return null;
  }
}

function findBlueButtons(pngPath) {
  if (!pngPath || !fs.existsSync(pngPath)) return [];
  const raw = `${pngPath}.raw`;
  let size = '';
  try {
    size = execFileSync('identify', ['-format', '%w %h', pngPath], { encoding: 'utf8' }).trim();
    execFileSync('convert', [pngPath, '-depth', '8', `RGB:${raw}`], { stdio: 'ignore' });
  } catch (err) {
    progress(`identify falhou: ${err.message}`);
    return [];
  }
  const [width, height] = size.split(' ').map(Number);
  const script = `
import struct, sys
w, h = map(int, sys.argv[1:3])
data = open(sys.argv[3], 'rb').read()
if len(data) < w * h * 3:
    print('[]')
    raise SystemExit
mask = bytearray(w * h)
for i in range(w * h):
    r, g, b = data[i * 3], data[i * 3 + 1], data[i * 3 + 2]
    if b > 140 and b > r + 30 and b > g + 15:
        mask[i] = 1
seen = bytearray(w * h)
boxes = []
for i, on in enumerate(mask):
    if not on or seen[i]:
        continue
    q = [i]
    seen[i] = 1
    minx = maxx = i % w
    miny = maxy = i // w
    count = 0
    while q:
        cur = q.pop()
        count += 1
        x, y = cur % w, cur // w
        if x < minx: minx = x
        if x > maxx: maxx = x
        if y < miny: miny = y
        if y > maxy: maxy = y
        for nxt in (cur - 1, cur + 1, cur - w, cur + w):
            if nxt < 0 or nxt >= w * h or seen[nxt] or not mask[nxt]:
                continue
            if abs((nxt % w) - x) > 1:
                continue
            seen[nxt] = 1
            q.append(nxt)
    bw, bh = maxx - minx + 1, maxy - miny + 1
    if count > 400 and 50 <= bw <= 320 and 24 <= bh <= 80 and miny > 80:
        boxes.append({
            'x': minx + bw // 2,
            'y': miny + bh // 2,
            'w': bw,
            'h': bh,
            'area': count,
        })
boxes.sort(key=lambda item: item['area'], reverse=True)
print(__import__('json').dumps(boxes[:6]))
`;
  const py = path.join(dataDir, 'find-blue.py');
  fs.writeFileSync(py, script);
  try {
    const out = execFileSync('python3', [py, String(width), String(height), raw], { encoding: 'utf8' });
    fs.rmSync(raw, { force: true });
    return JSON.parse(out);
  } catch (err) {
    progress(`busca do botão falhou: ${err.message}`);
    return [];
  }
}

function startServer() {
  const env = { ...process.env };
  delete env.VAPID_PUBLIC_KEY;
  delete env.VAPID_PRIVATE_KEY;
  delete env.SEND_TOKEN;
  env.HOST = '127.0.0.1';
  env.PORT = String(port);
  env.DATA_DIR = dataDir;
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
    fs.writeFileSync(path.join(dataDir, 'server.log'), logs);
    if (code) progress(`servidor encerrou com ${code}`);
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

async function runBrowser() {
  const { chromium } = await import('playwright');
  const profile = path.join(dataDir, 'chrome-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const context = await launchChrome(chromium, profile);
  browserHandle = context;
  wireConsole(context);
  const page = context.pages()[0] || await context.newPage();
  wirePage(page);

  report.install = await proveInstall(context, page);
  const appPage = report.install.standalonePage || page;
  delete report.install.standalonePage;
  report.subscription = await proveSubscribe(appPage);
  if (report.subscription.subscribed) {
    const probe = await sendAndWatch({
      title: 'PWA em primeiro plano',
      body: 'O aplicativo está aberto e em primeiro plano.',
      timeoutMs: 35000,
    });
    if (probe.observed?.response?.statusCode === 410 || probe.result?.statusCode === 410) {
      progress('FCM devolveu 410 na inscrição nova; tentando inscrever outra vez');
      report.subscription.firstAttempt = {
        endpointMasked: report.subscription.endpointMasked,
        statusCode: 410,
        observed: probe.observed,
      };
      report.subscription.retry = await proveSubscribe(appPage, { fresh: true });
      if (!report.subscription.retry.subscribed) report.subscription.subscribed = false;
    } else {
      report.scenarios.foreground = { ...probe, displayMode: await displayMode(appPage).catch(() => null), label: 'primeiro plano', real: probe.receipt != null };
      if (probe.visible?.box) {
        report.scenarios.foreground.notificationShot = cropAround(shotRoot('notif-foreground-root.png'), probe.visible.box, 'notif-foreground.png', 36);
      }
    }
  }
  if (!report.subscription.subscribed) {
    report.problems.push('Sem inscrição não há push para os cenários da PWA.');
    report.screenshots = publishWhatWeHave();
    return { launched: true };
  }

  if (!report.scenarios.foreground) report.scenarios.foreground = await scenarioForeground(appPage);
  report.scenarios.minimized = await scenarioMinimized(appPage);
  report.scenarios.windowClosed = await scenarioWindowClosed(context, appPage);
  report.click = report.scenarios.windowClosed?.click || { tested: false, note: 'O cenário da janela fechada não chegou ao clique.' };

  await context.close();
  browserHandle = null;
  report.chromeQuit = await scenarioChromeQuit(chromium, profile);
  report.screenshots = publishWhatWeHave();
  return { launched: true, userAgent: report.subscription.userAgent || null };
}

async function launchChrome(chromium, profile) {
  progress('abrindo Chrome');
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    permissions: ['notifications'],
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-session-crashed-bubble',
      '--window-size=1100,820',
      '--window-position=40,40',
      '--bypass-app-banner-engagement-checks',
      '--disable-translate',
      '--disable-features=Translate,TranslateUI',
      '--enable-features=NativeNotifications,SystemNotifications',
    ],
  });
  await context.grantPermissions(['notifications'], { origin });
  return context;
}

function wireConsole(context) {
  context.on('serviceworker', (worker) => {
    worker.on('console', (msg) => consoleLines.push(`SW ${msg.type()}: ${msg.text()}`));
  });
  context.on('page', (page) => wirePage(page));
}

function wirePage(page) {
  page.on('console', (msg) => consoleLines.push(`PAGE ${msg.type()}: ${msg.text()}`));
  page.on('pageerror', (err) => consoleLines.push(`PAGEERROR ${err.message}`));
}

async function proveInstall(context, page) {
  const install = {
    beforeinstallprompt: false,
    dialog: null,
    method: null,
    standalone: false,
    standalonePage: null,
    displayMode: null,
    internalsMention: false,
    profileHits: [],
    installabilityErrors: null,
    manifest: null,
    windows: [],
  };
  progress('abrindo a página');
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  try {
    await settleInstallOffer(page);
    install.beforeinstallprompt = true;
  } catch (err) {
    install.error = `beforeinstallprompt não ficou estável: ${err.message}`;
  }
  await page.bringToFront();
  await sleep(400);
  progress(`janela antes do diálogo: ${chromeWindowName()}`);
  install.installabilityErrors = await cdp(page, 'Page.getInstallabilityErrors');
  install.manifest = await cdp(page, 'Page.getAppManifest');
  const offer = path.join(dataDir, 'oferta-instalacao.png');
  await page.screenshot({ path: offer, fullPage: true }).catch(() => {});
  install.offerScreenshot = fs.existsSync(offer) ? offer : null;
  install.stateBefore = await text(page, '#install-state');

  if (install.beforeinstallprompt) {
    install.dialog = await acceptInstallDialog(page);
    install.stateAfter = await text(page, '#install-state');
    if (install.dialog.accepted) install.method = install.dialog.via;
  }

  if (!/aceita|confirmou/i.test(install.stateAfter || '')) {
    progress('diálogo não confirmou; tentando PWA.install pelo CDP');
    try { execFileSync('xdotool', ['key', 'Escape'], { env: process.env, stdio: 'ignore' }); } catch { /* sem diálogo */ }
    await sleep(400);
    const cdpInstall = await cdp(page, 'PWA.install', { manifestId });
    install.cdpInstall = cdpInstall;
    progress(`PWA.install: ${cdpInstall.ok ? 'ok' : cdpInstall.error}`);
    if (cdpInstall.ok) {
      install.method = install.method || 'cdp:PWA.install';
      await sleep(800);
      install.stateAfterCdp = await text(page, '#install-state');
    }
  }

  const launched = await openInstalledApp(context, page);
  install.launch = launched.attempt;
  install.standalonePage = launched.page;
  install.originalDisplayMode = await displayMode(page).catch(() => null);
  if (!install.standalonePage && install.originalDisplayMode === 'standalone') {
    install.standalonePage = page;
  }
  if (launched.page) {
    install.displayMode = await displayMode(launched.page);
    install.standalone = install.displayMode === 'standalone';
    const win = windowForTitle(/Web Push|Lab: Web Push/);
    install.windows = listWindows().filter((item) => /Web Push|Lab:|Google Chrome|Chrome/i.test(`${item.name} ${item.className}`)).slice(0, 12);
    if (win) install.standaloneShot = shotWindow(win.id, 'pwa-janela.png');
    const inner = path.join(dataDir, 'pwa-pagina.png');
    await launched.page.screenshot({ path: inner, fullPage: true }).catch(() => {});
    install.pageShot = fs.existsSync(inner) ? inner : null;
  }

  const internals = await readInternals(context);
  install.internalsMention = internals.mention;
  install.internalsExcerpt = internals.excerpt;
  install.profileHits = profileAppHits(path.join(dataDir, 'chrome-profile'));
  if (install.standalone) progress('display-mode standalone confirmado');
  else progress(`instalação sem standalone (${install.method || 'sem método'})`);
  return install;
}

async function settleInstallOffer(page) {
  let stable = 0;
  let last = '';
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const state = await page.evaluate(() => ({
        href: location.href,
        controlled: Boolean(navigator.serviceWorker.controller),
        offered: Boolean(document.querySelector('#install') && !document.querySelector('#install').hidden),
      }));
      const key = `${state.href}|${state.controlled}|${state.offered}`;
      if (state.controlled && state.offered && key === last) {
        stable += 1;
        if (stable >= 3) return;
      } else {
        stable = 0;
      }
      last = key;
    } catch {
      stable = 0;
      last = '';
    }
    await sleep(400);
  }
  throw new Error('a página recarregou ou o Chrome não ofereceu a instalação');
}

function chromeWindowName() {
  const win = listWindows()
    .filter((item) => item.className === 'Google-chrome' && item.width > 400)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  return win ? win.name : '(nenhuma)';
}

async function acceptInstallDialog(page) {
  const attempt = { accepted: false, via: null, blueButtons: [], key: null };
  progress('clicando em Instalar aplicativo');
  await page.bringToFront();
  await page.click('#install');
  await sleep(900);
  const rootShot = shotRoot('install-dialog-root.png');
  attempt.rootShot = rootShot;
  attempt.windows = listWindows().slice(0, 30);
  attempt.blueButtons = findBlueButtons(rootShot);
  // Neste Chrome o foco inicial do diálogo é Cancel, que é o botão azul.
  // Return sozinho recusa. O Install fica à direita.
  const rightmost = [...attempt.blueButtons].sort((a, b) => b.x - a.x)[0];
  if (rightmost && attempt.blueButtons.length > 1) {
    const x = rightmost.x;
    const y = rightmost.y;
    progress(`clique no botão da direita ${x},${y}`);
    try {
      execFileSync('xdotool', ['mousemove', '--sync', String(x), String(y), 'click', '1'], {
        env: process.env,
        stdio: 'ignore',
      });
      attempt.key = `clique ${x},${y}`;
    } catch (err) {
      attempt.clickError = err.message;
    }
    await sleep(800);
    if (await installAccepted(page)) {
      attempt.accepted = true;
      attempt.via = `xdotool clique no botão à direita, ${x},${y}`;
      return attempt;
    }
  }
  try {
    execFileSync('xdotool', ['key', 'Tab', 'Return'], { env: process.env, stdio: 'ignore' });
    attempt.key = 'Tab Return';
  } catch (err) {
    attempt.key = err.message;
  }
  await sleep(800);
  if (await installAccepted(page)) {
    attempt.accepted = true;
    attempt.via = 'xdotool Tab e Return, saindo do Cancel';
    return attempt;
  }
  attempt.accepted = await installAccepted(page);
  return attempt;
}

async function installAccepted(page) {
  const state = await text(page, '#install-state');
  return /aceita|confirmou/i.test(state);
}

async function openInstalledApp(context, page) {
  const attempt = [];
  const before = new Set(context.pages());
  let launched = await cdp(page, 'PWA.launch', { manifestId });
  attempt.push({ method: 'PWA.launch', launched });
  let created = await waitForNewPage(context, before, 4000);
  if (!created) {
    const opened = await cdp(page, 'PWA.openCurrentPageInApp', { manifestId });
    attempt.push({ method: 'PWA.openCurrentPageInApp', opened });
    created = await waitForNewPage(context, before, 4000);
  }
  if (!created) {
    const apps = await context.newPage();
    wirePage(apps);
    let appsText = '';
    try {
      await apps.goto('chrome://apps', { waitUntil: 'domcontentloaded', timeout: 8000 });
      await sleep(800);
      appsText = await apps.locator('body').innerText({ timeout: 3000 }).catch(() => '');
      const shot = path.join(dataDir, 'chrome-apps.png');
      await apps.screenshot({ path: shot, fullPage: true }).catch(() => {});
      const beforeApps = new Set(context.pages());
      const hit = apps.getByText(/Web Push|Lab Web Push/i).first();
      if (await hit.count()) {
        await hit.click({ timeout: 3000 }).catch(() => {});
        created = await waitForNewPage(context, beforeApps, 4000);
      }
    } catch (err) {
      appsText = err.message;
    }
    attempt.push({ method: 'chrome://apps', text: appsText.slice(0, 500) });
    if (!created) await apps.close().catch(() => {});
  }
  if (created) {
    try {
      await created.waitForLoadState('domcontentloaded', { timeout: 8000 });
    } catch {
      // a janela pode já estar pronta
    }
  }
  return { attempt, page: created };
}

async function waitForNewPage(context, before, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const fresh = context.pages().filter((item) => !before.has(item) && !item.isClosed());
    const app = fresh.find((item) => {
      try { return item.url().startsWith(origin); } catch { return false; }
    });
    if (app) return app;
    await sleep(200);
  }
  return null;
}

async function readInternals(context) {
  const page = await context.newPage();
  wirePage(page);
  try {
    await page.goto('chrome://web-app-internals', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await sleep(500);
    const body = await page.locator('body').innerText({ timeout: 4000 });
    const shot = path.join(dataDir, 'web-app-internals.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const mention = /Lab Web Push|127\.0\.0\.1:8788/.test(body);
    return {
      mention,
      excerpt: body.split('\n').filter((line) => /Lab Web Push|8788|install|standalone|manifest/i.test(line)).slice(0, 40),
    };
  } catch (err) {
    return { mention: false, excerpt: [err.message] };
  } finally {
    await page.close().catch(() => {});
  }
}

function profileAppHits(profile) {
  const hits = [];
  const needles = ['Lab Web Push com VAPID', 'manifest.webmanifest'];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (/Cache|Code Cache|GPUCache|Service Worker|Session Storage|Local Storage/.test(entry.name)) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!/Preferences|web_app|manifest/i.test(entry.name)) continue;
      if (entry.name.endsWith('.png')) continue;
      let text = '';
      try {
        const stat = fs.statSync(full);
        if (stat.size > 2_000_000) continue;
        text = fs.readFileSync(full, 'utf8');
      } catch { continue; }
      if (needles.some((needle) => text.includes(needle))) {
        hits.push(path.relative(profile, full));
      }
    }
  };
  walk(profile, 0);
  return hits.slice(0, 20);
}

async function proveSubscribe(page, options = {}) {
  const result = { subscribed: false, permission: null, endpointMasked: null, userAgent: null, fresh: Boolean(options.fresh) };
  progress(options.fresh ? 'inscrevendo de novo' : 'inscrevendo');
  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await waitForPage(page, () => {
      const button = document.querySelector('#enable');
      return Boolean(button && !button.disabled);
    }, 15000);
    if (options.fresh) {
      await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const current = await registration.pushManager.getSubscription();
        if (current) await current.unsubscribe();
      });
    }
    await page.click('#enable');
    await waitForPage(page, () => document.querySelector('#sub')?.dataset.state === 'subscribed', 45000);
    result.subscribed = true;
    result.permission = await page.evaluate(() => Notification.permission);
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    result.displayMode = await displayMode(page);
    const endpoint = await page.getAttribute('#sub', 'data-endpoint');
    result.endpointMasked = endpoint ? maskUrl(endpoint) : null;
    result.p256dhText = await page.locator('[data-field="p256dh"]').innerText();
    result.authText = await page.locator('[data-field="auth"]').innerText();
    const shot = path.join(dataDir, 'inscrita.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    result.screenshot = fs.existsSync(shot) ? shot : null;
  } catch (err) {
    result.error = err.message;
    result.statusText = await text(page, '#status');
    result.console = consoleLines.slice(-30);
    try {
      await page.screenshot({ path: path.join(dataDir, 'subscribe-falha.png'), fullPage: true });
    } catch {
      // sem página
    }
  }
  return result;
}

async function scenarioForeground(page) {
  progress('cenário primeiro plano');
  const sent = await sendAndWatch({
    title: 'PWA em primeiro plano',
    body: 'O aplicativo está aberto e em primeiro plano.',
    timeoutMs: 35000,
  });
  sent.displayMode = await displayMode(page).catch(() => null);
  sent.label = 'primeiro plano';
  sent.real = sent.receipt != null;
  if (sent.visible?.box) {
    sent.notificationShot = cropAround(shotRoot('notif-foreground-root.png'), sent.visible.box, 'notif-foreground.png', 36);
  }
  return sent;
}

async function scenarioMinimized(page) {
  progress('cenário minimizado');
  await page.bringToFront().catch(() => {});
  await sleep(400);
  const win = windowForTitle(/Web Push|Lab:|Google Chrome/)
    || listWindows().filter((item) => item.className === 'Google-chrome' && item.width > 400)[0];
  const scenario = { label: 'minimizado', minimized: false };
  if (!win) {
    scenario.error = 'Não achei a janela do lab para minimizar.';
    scenario.real = false;
    return scenario;
  }
  try {
    execFileSync('xdotool', ['windowminimize', win.id], { env: process.env, stdio: 'ignore' });
    scenario.minimized = true;
    scenario.window = { id: win.id, name: win.name, className: win.className };
  } catch (err) {
    scenario.error = err.message;
    scenario.real = false;
    return scenario;
  }
  await sleep(500);
  const sent = await sendAndWatch({
    title: 'PWA minimizado',
    body: 'A janela do aplicativo foi minimizada.',
    timeoutMs: 35000,
  });
  Object.assign(scenario, sent);
  scenario.real = sent.receipt != null;
  if (sent.visible?.box) {
    scenario.notificationShot = cropAround(shotRoot('notif-min-root.png'), sent.visible.box, 'notif-min.png', 36);
  }
  try {
    execFileSync('xdotool', ['windowactivate', win.id], { env: process.env, stdio: 'ignore' });
  } catch {
    // a janela pode ter sido substituída
  }
  return scenario;
}

async function scenarioWindowClosed(context, appPage) {
  progress('cenário janela fechada');
  const scenario = { label: 'janela do aplicativo fechada, processo do Chrome aberto' };
  const keeper = await context.newPage();
  wirePage(keeper);
  await keeper.goto('about:blank');
  for (const open of context.pages()) {
    if (open === keeper || open.isClosed()) continue;
    let url = '';
    try { url = open.url(); } catch { url = ''; }
    if (url.startsWith(origin) || url === 'about:blank' && open !== keeper) {
      if (url.startsWith(origin)) await open.close().catch(() => {});
    }
  }
  if (!appPage.isClosed() && appPage !== keeper) await appPage.close().catch(() => {});
  scenario.pagesLeft = context.pages().map((item) => {
    try { return item.url(); } catch { return 'fechada'; }
  });
  scenario.serviceWorkers = context.serviceWorkers().length;
  const sent = await sendAndWatch({
    title: 'PWA com a janela fechada',
    body: 'A janela foi fechada. O Chrome segue aberto.',
    timeoutMs: 35000,
  });
  Object.assign(scenario, sent);
  scenario.real = sent.receipt != null;
  if (sent.visible?.box) {
    scenario.notificationShot = cropAround(shotRoot('notif-fechada-root.png'), sent.visible.box, 'notif-fechada.png', 36);
  }
  scenario.click = await clickNotification(context, 'PWA com a janela fechada');
  scenario.pagesAfter = await describePages(context);
  return scenario;
}

async function clickNotification(context, title) {
  const clicksBefore = (await getJson('/lab/evidence')).clicks.length;
  const click = {
    tested: false,
    method: null,
    record: null,
    displayModes: [],
    note: '',
  };
  const state = dunstState();
  click.visibleBefore = state;
  if (!(state.displayed >= 1 && state.box && state.box.height > 20)) {
    click.note = 'Não havia notificação desenhada pelo dunst para clicar.';
    const named = windowForTitle(new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    click.namedWindow = named || null;
    if (!named) return click;
  }
  click.tested = true;
  const beforePages = context.pages().length;
  try {
    execFileSync('dunstctl', ['action'], { env: process.env, stdio: 'ignore' });
    click.method = 'dunstctl action';
  } catch (err) {
    click.note += `dunstctl action falhou: ${err.message}. `;
  }
  let record = await waitForClick(clicksBefore, 5000);
  if (!record && state.box) {
    const x = Math.floor(state.box.width / 2);
    const y = Math.floor(state.box.height / 2);
    try {
      execFileSync('xdotool', [
        'mousemove', '--window', state.box.id, '--sync', String(x), String(y), 'click', '1',
      ], { env: process.env, stdio: 'ignore' });
      click.method = 'xdotool clique na janela Dunst';
    } catch (err) {
      click.note += `xdotool falhou: ${err.message}. `;
    }
    record = await waitForClick(clicksBefore, 5000);
  }
  click.record = record;
  await sleep(1200);
  click.pagesAfterCount = context.pages().length;
  click.openedPage = context.pages().length > beforePages;
  click.displayModes = await describePages(context);
  const app = context.pages().find((item) => {
    try { return item.url().startsWith(origin); } catch { return false; }
  });
  if (app) {
    const shot = path.join(dataDir, 'foco-pagina.png');
    await app.screenshot({ path: shot, fullPage: true }).catch(() => {});
    click.pageShot = fs.existsSync(shot) ? shot : null;
    const win = windowForTitle(/Web Push|Lab: Web Push/);
    if (win) click.windowShot = shotWindow(win.id, 'foco-janela.png');
    click.window = win || null;
  }
  if (!record) click.note += 'A notificação estava visível, mas o servidor não registrou notificationclick.';
  return click;
}

async function waitForClick(previous, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const evidence = await getJson('/lab/evidence');
    if (evidence.clicks.length > previous) return evidence.clicks.at(-1);
    await sleep(300);
  }
  return null;
}

async function scenarioChromeQuit(chromium, profile) {
  progress('cenário Chrome fechado');
  const scenario = { label: 'processo do Chrome encerrado' };
  await sleep(1000);
  scenario.chromeStillRunning = chromeProcesses();
  if (scenario.chromeStillRunning.length > 0) {
    scenario.note = 'Ainda havia processo do Chrome deste perfil. O cenário de processo encerrado não vale.';
    scenario.tested = false;
    return scenario;
  }
  scenario.tested = true;
  const sent = await sendAndWatch({
    title: 'PWA com o Chrome fechado',
    body: 'O processo do Chrome foi encerrado antes deste envio.',
    timeoutMs: 15000,
  });
  scenario.whileClosed = {
    statusCode: sent.observed?.response?.statusCode ?? sent.result?.statusCode ?? null,
    receipt: sent.receipt,
    visible: sent.visible,
    observed: sent.observed,
    result: sent.result,
  };
  scenario.realDeliveryWhileClosed = Boolean(sent.receipt);
  progress('reabrindo o Chrome para ver se o push ficou guardado');
  let context = null;
  try {
    context = await launchChrome(chromium, profile);
    browserHandle = context;
    wireConsole(context);
    const page = context.pages()[0] || await context.newPage();
    wirePage(page);
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const resumed = await sendWatchOnly({
      body: 'O processo do Chrome foi encerrado antes deste envio.',
      timeoutMs: 25000,
    });
    scenario.afterReopen = resumed;
    scenario.receiptAfterReopen = Boolean(resumed.receipt);
    if (resumed.visible?.box) {
      scenario.notificationShot = cropAround(shotRoot('notif-reopen-root.png'), resumed.visible.box, 'notif-reopen.png', 36);
    }
  } catch (err) {
    scenario.reopenError = err.message;
  } finally {
    if (context) await context.close().catch(() => {});
    browserHandle = null;
  }
  return scenario;
}

function chromeProcesses() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line.includes('validate-pwa/chrome-profile') || line.includes(path.join('data', 'validate-pwa', 'chrome-profile'))).slice(0, 8);
  } catch {
    return [];
  }
}

async function sendAndWatch({ title, body, timeoutMs }) {
  await postJson('/lab/reset-log', {});
  try { execFileSync('dunstctl', ['close-all'], { env: process.env, stdio: 'ignore' }); } catch { /* sem notificação */ }
  await sleep(200);
  const http = await postSend({ title, body, url: '/' });
  const watched = await sendWatchOnly({ body, timeoutMs, stopEarly: true });
  const evidence = await getJson('/lab/evidence');
  const send = evidence.sends.at(-1) || null;
  return {
    httpStatus: http.status,
    result: http.json?.results?.[0] ?? null,
    observed: send ? publicSend(send) : null,
    receipt: watched.receipt,
    visible: watched.visible,
    swConsole: consoleLines.filter((line) => line.includes(body) || line.includes('notificationclick') || line.includes('push-payload')).slice(-8),
  };
}

async function sendWatchOnly({ body, timeoutMs, stopEarly = false }) {
  const started = Date.now();
  let receipt = null;
  let visible = null;
  while (Date.now() - started < timeoutMs) {
    const evidence = await getJson('/lab/evidence');
    receipt = evidence.receipts.find((item) => item.raw?.includes(body)) || null;
    const state = dunstState();
    const busHas = monitorLog.includes(body);
    visible = {
      displayed: state.displayed,
      box: state.box,
      busHasBody: busHas,
    };
    const status = evidence.sends.at(-1)?.response?.statusCode;
    if (receipt && state.displayed >= 1 && state.box?.height > 20) break;
    if (receipt && busHas && state.displayed >= 1) break;
    if (stopEarly && status && status !== 201 && Date.now() - started > 2500 && !receipt) break;
    await sleep(800);
  }
  return { receipt, visible };
}

async function describePages(context) {
  const pages = [];
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    try {
      pages.push(await page.evaluate(() => ({
        href: location.href,
        title: document.title,
        mode: window.matchMedia('(display-mode: standalone)').matches
          ? 'standalone'
          : window.matchMedia('(display-mode: minimal-ui)').matches
            ? 'minimal-ui'
            : window.matchMedia('(display-mode: browser)').matches
              ? 'browser'
              : 'other',
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        click: document.querySelector('#click-text')?.textContent || null,
      })));
    } catch (err) {
      pages.push({ error: err.message });
    }
  }
  return pages;
}

async function displayMode(page) {
  return page.evaluate(() => {
    if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
    if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'minimal-ui';
    if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen';
    if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return 'window-controls-overlay';
    return 'browser';
  });
}

async function cdp(page, method, params = {}) {
  let session = null;
  try {
    session = await page.context().newCDPSession(page);
    if (method.startsWith('Page.')) await session.send('Page.enable').catch(() => {});
    const result = await session.send(method, params);
    return { ok: true, result: trimCdp(method, result) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (session) await session.detach().catch(() => {});
  }
}

function trimCdp(method, result) {
  if (method === 'Page.getAppManifest') {
    return {
      url: result.url,
      errors: result.errors || [],
      dataBytes: typeof result.data === 'string' ? result.data.length : 0,
      hasName: typeof result.data === 'string' && result.data.includes('Lab Web Push'),
    };
  }
  return result;
}

async function waitForPage(page, fn, timeoutMs) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      if (await page.evaluate(fn)) return;
    } catch (err) {
      last = err.message;
    }
    await sleep(250);
  }
  throw new Error(last || 'tempo esgotado');
}

async function text(page, selector) {
  try {
    return await page.locator(selector).innerText({ timeout: 1000 });
  } catch {
    return '';
  }
}

function windowForTitle(pattern) {
  const windows = listWindows().filter((item) => pattern.test(item.name) && item.width > 200 && item.height > 200);
  return windows.find((item) => !/Google Chrome/.test(item.name)) || windows[0] || null;
}

function publishWhatWeHave() {
  const published = {};
  const install = report.install || {};
  if (install.beforeinstallprompt && install.offerScreenshot) {
    published.offer = publish(install.offerScreenshot, 'pwa-oferta-instalacao.png');
  }
  if (install.standalone && (install.standaloneShot || install.pageShot)) {
    published.installed = publish(install.standaloneShot || install.pageShot, 'pwa-instalada.png');
  }
  const notification = report.scenarios.windowClosed?.notificationShot
    || report.scenarios.minimized?.notificationShot
    || report.scenarios.foreground?.notificationShot
    || null;
  if (notification) published.notification = publish(notification, 'pwa-notificacao.png');
  const click = report.click || report.scenarios.windowClosed?.click;
  if (click?.record && (click.windowShot || click.pageShot)) {
    published.focused = publish(click.windowShot || click.pageShot, 'pwa-foco-apos-clique.png');
  }
  if (install.dialog?.rootShot && install.dialog.accepted) {
    published.dialog = publish(install.dialog.rootShot, 'pwa-dialogo-instalar.png');
  }
  return published;
}

function publish(source, name) {
  const docsPath = path.join(root, 'docs', name);
  const artDir = '/opt/cursor/artifacts';
  fs.mkdirSync(artDir, { recursive: true });
  const artPath = path.join(artDir, name);
  try {
    execFileSync('convert', [source, '-resize', '1400x>', '-strip', docsPath], { stdio: 'ignore' });
  } catch {
    fs.copyFileSync(source, docsPath);
  }
  fs.copyFileSync(docsPath, artPath);
  return { docs: `docs/${name}`, bytes: fs.statSync(docsPath).size };
}

function notificationExcerpt() {
  const lines = monitorLog.split('\n');
  const kept = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/Notify|ActionInvoked|NotificationClosed|Preflight|PWA |primeiro plano|minimizada|janela fechada|Chrome fechado/.test(lines[index])) continue;
    kept.push(lines.slice(index, index + 3).join(' | ').slice(0, 400));
    if (kept.length >= 40) break;
  }
  return kept;
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
  const textBody = await response.text();
  let json = null;
  try { json = JSON.parse(textBody); } catch { json = null; }
  return { status: response.status, json };
}

async function postJson(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${pathname} respondeu ${response.status}`);
}

async function getJson(pathname) {
  const response = await fetch(`${base}${pathname}`);
  if (!response.ok) throw new Error(`${pathname} respondeu ${response.status}`);
  return response.json();
}

function publicSend(send) {
  return {
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

function redact(input) {
  const keysPath = path.join(dataDir, 'vapid.json');
  const keys = fs.existsSync(keysPath) ? JSON.parse(fs.readFileSync(keysPath, 'utf8')) : {};
  const tokenPath = path.join(dataDir, 'send-token');
  const token = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, 'utf8').trim() : '';
  const clone = JSON.parse(JSON.stringify(input));
  walk(clone, keys, token);
  return clone;
}

function walk(value, keys, token) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] === 'string') value[index] = scrub(value[index], keys, token);
      else walk(value[index], keys, token);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'headers' && item && typeof item === 'object') {
      value[key] = redactHeaders(item, keys, token);
      continue;
    }
    if (key === 'jwt' && item && typeof item === 'object') {
      value[key] = redactJwt(item);
      continue;
    }
    if ((key === 'endpoint' || key === 'path' || key === 'url') && typeof item === 'string') {
      value[key] = maskUrl(item);
      continue;
    }
    if (key === 'bodyBase64' && typeof item === 'string') continue;
    if (typeof item === 'string') {
      value[key] = scrub(item, keys, token);
      continue;
    }
    walk(item, keys, token);
  }
}

function redactHeaders(headers, keys, token) {
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') next[name] = maskAuthorization(String(value));
    else if (typeof value === 'string') next[name] = scrub(value, keys, token);
    else next[name] = value;
  }
  return next;
}

function redactJwt(jwt) {
  if (!jwt || jwt.ok === false) return jwt;
  return {
    ok: jwt.ok,
    header: jwt.header,
    payload: jwt.payload,
    signatureValid: jwt.signatureValid,
    publicKeyMatches: jwt.publicKeyMatches,
    tokenMasked: maskSecret(jwt.token, 12, 6),
    publicKeyMasked: maskSecret(jwt.publicKey, 6, 4),
    publicKeyBytes: jwt.publicKey ? Buffer.from(jwt.publicKey, 'base64url').length : null,
  };
}

function maskAuthorization(value) {
  const match = value.match(/^vapid t=([^,\s]+),\s*k=(.+)$/);
  if (!match) return maskSecret(value, 12, 4);
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
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return maskPath(value);
  }
}

function maskPath(value) {
  return String(value).replace(/([A-Za-z0-9_-]{16,})/g, (token) => `${token.slice(0, 4)}…${token.slice(-4)}`);
}

function scrub(value, keys, token) {
  let next = value;
  if (keys.privateKey) next = next.split(keys.privateKey).join('[chave-privada-removida]');
  if (keys.publicKey) next = next.split(keys.publicKey).join('[chave-publica-removida]');
  if (token) next = next.split(token).join('[token-removido]');
  next = next.replace(/fcm\/send\/[A-Za-z0-9_-]{12,}/g, (match) => {
    const id = match.slice('fcm/send/'.length);
    return `fcm/send/${id.slice(0, 4)}…${id.slice(-4)}`;
  });
  next = next.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, (jwt) => maskSecret(jwt, 12, 6));
  return next;
}

function assertNoSecrets(file) {
  const keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'vapid.json'), 'utf8'));
  const token = fs.readFileSync(path.join(dataDir, 'send-token'), 'utf8').trim();
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes(keys.privateKey) || text.includes(keys.publicKey) || text.includes(token)) {
    throw new Error('o relatório redigido ainda contém segredo');
  }
}

async function stopAll() {
  if (browserHandle) await browserHandle.close().catch(() => {});
  for (const child of children) {
    if (child.exitCode == null && child.killed !== true) child.kill('SIGTERM');
  }
  if (busPid) {
    try { process.kill(busPid, 'SIGTERM'); } catch { /* já saiu */ }
  }
  await sleep(300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
