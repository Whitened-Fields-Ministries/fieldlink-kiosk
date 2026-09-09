// FieldLink Kiosk — Electron shell around the FieldLink kiosk web page.
//
// Responsibilities:
//   • Find the kiosk URL (which carries this display's API key) in config.json.
//   • Show the kiosk full-screen and keep it healthy: reload after crashes,
//     survive the network being down at boot, recover from maintenance pages.
//   • Notice when the key has been deleted/disabled on the server and show a
//     recovery screen instead of a stale or broken page.
//   • Let an admin re-link the display without touching files: type a pairing
//     code from FieldLink Admin (or paste the kiosk URL) on the recovery screen.
//
// Config resolution — the most recently modified of these wins:
//   %ProgramData%\FieldLinkKiosk\config.json   written by INSTALL.bat and by the
//                                              recovery screen; survives upgrades
//   <folder of FieldLinkKiosk.exe>\config.json  legacy location (INSTALL.bat <= 1.0)
//   %APPDATA%\<app>\config.json                 fallback when ProgramData is read-only
//   ./config.json                               development only (npm start)
//
// Keyboard (a keyboard must be plugged into the kiosk PC):
//   Ctrl+Shift+K  open the settings / recovery screen
//   Ctrl+Shift+R  reload the kiosk page
//   Ctrl+Shift+Q  quit the app

const { app, BrowserWindow, globalShortcut, ipcMain, net, powerSaveBlocker } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

const APP_VERSION        = app.getVersion();
const DEFAULT_SERVER     = 'https://fieldlinkmissions.com';
const HEALTH_INTERVAL_MS = 30 * 1000;          // steady-state key/server check
const RETRY_STEPS_MS     = [5000, 10000, 20000, 30000]; // backoff while offline
const REQUEST_TIMEOUT_MS = 15 * 1000;
const KEY_RE             = /^fl_kiosk_[0-9a-f]{16,}$/i;
const CODE_RE            = /^[A-Z0-9]{8}$/;    // pairing code, dashes/spaces stripped

// Videos in missionary updates should play without a click on a lobby TV.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── Logging ──────────────────────────────────────────────────────────────────
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(logPath(), line + '\n'); } catch {}
}
function logPath() { return path.join(app.getPath('userData'), 'kiosk.log'); }
function trimLog() {
  try {
    const p = logPath();
    if (fs.existsSync(p) && fs.statSync(p).size > 1024 * 1024) {
      const tail = fs.readFileSync(p, 'utf8').split('\n').slice(-500).join('\n');
      fs.writeFileSync(p, tail);
    }
  } catch {}
}

// ── Config ───────────────────────────────────────────────────────────────────
function programDataConfigPath() {
  if (process.platform !== 'win32') return null;
  const pd = process.env.ProgramData || process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE;
  return pd ? path.join(pd, 'FieldLinkKiosk', 'config.json') : null;
}

function configCandidates() {
  const list = [];
  const pd = programDataConfigPath();
  if (pd) list.push(pd);
  list.push(path.join(path.dirname(app.getPath('exe')), 'config.json'));
  list.push(path.join(app.getPath('userData'), 'config.json'));
  if (!app.isPackaged) list.push(path.join(__dirname, 'config.json'));
  return [...new Set(list)];
}

// Returns { config, source } — the newest valid config.json, or { config: null }.
function loadConfig() {
  let best = null;
  for (const p of configCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { config: parsed, source: p, mtimeMs: stat.mtimeMs };
    } catch (e) {
      log(`config: could not read ${p}: ${e.message}`);
    }
  }
  return best || { config: null, source: null };
}

// Writable targets, in order of preference. ProgramData is machine-wide and is
// made writable for the kiosk user by SETUP-KIOSK-MODE.ps1; userData always works.
function writableConfigTargets() {
  const list = [];
  const pd = programDataConfigPath();
  if (pd) list.push(pd);
  list.push(path.join(app.getPath('userData'), 'config.json'));
  if (!app.isPackaged) list.unshift(path.join(__dirname, 'config.json'));
  return list;
}

function saveConfig(patch) {
  const { config } = loadConfig();
  const merged = { ...(config || {}), ...patch, updatedAt: new Date().toISOString(), updatedBy: `FieldLinkKiosk ${APP_VERSION}` };
  const body = JSON.stringify(merged, null, 2);
  let lastErr = null;
  for (const target of writableConfigTargets()) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, target);
      log(`config: saved to ${target}`);
      return target;
    } catch (e) {
      lastErr = e;
      log(`config: cannot write ${target}: ${e.message}`);
    }
  }
  throw new Error(`Could not save config anywhere (${lastErr ? lastErr.message : 'unknown error'})`);
}

function parseKioskUrl(kioskUrl) {
  try {
    const u = new URL(kioskUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return { url: u.toString(), origin: u.origin, key: u.searchParams.get('key') || '' };
  } catch { return null; }
}

// Accepts a full kiosk URL or a bare key; returns a normalised kiosk URL.
function normaliseKioskInput(text, fallbackOrigin) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Nothing entered.');
  if (KEY_RE.test(t)) {
    const origin = normaliseOrigin(fallbackOrigin || DEFAULT_SERVER);
    return `${origin}/kiosk?key=${t}`;
  }
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const parsed = parseKioskUrl(withScheme);
  if (!parsed) throw new Error('That is not a valid web address.');
  if (!parsed.key) throw new Error('That address has no ?key=… part. Copy the full kiosk URL from FieldLink Admin → Kiosk.');
  if (!KEY_RE.test(parsed.key)) throw new Error('The key in that address does not look like a FieldLink kiosk key.');
  return parsed.url;
}

function normaliseOrigin(text) {
  const t = String(text || '').trim();
  if (!t) return DEFAULT_SERVER;
  const withScheme = /^https?:\/\//i.test(t) ? t : `https://${t}`;
  const u = new URL(withScheme);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Server must be an http(s) address.');
  return u.origin;
}

// ── Server health / key validity ─────────────────────────────────────────────
async function fetchJson(url, init = {}) {
  const res = await net.fetch(url, {
    ...init,
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Accept': 'application/json', 'User-Agent': `FieldLinkKiosk/${APP_VERSION}`, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, ok: res.ok, body };
}

// → { status: 'ok'|'invalid'|'server'|'offline', http, info, error }
async function checkKey(kioskUrl) {
  const parsed = parseKioskUrl(kioskUrl);
  if (!parsed || !parsed.key) return { status: 'invalid', error: 'no key in URL' };
  const headers = { 'x-kiosk-key': parsed.key };
  try {
    let r = await fetchJson(`${parsed.origin}/api/kiosk/whoami`, { headers });
    // Older servers do not have /whoami; /hash has existed for a long time.
    if (r.status === 404) r = await fetchJson(`${parsed.origin}/api/kiosk/hash`, { headers });
    if (r.ok) return { status: 'ok', http: r.status, info: r.body || {} };
    if (r.status === 401 || r.status === 403) return { status: 'invalid', http: r.status, error: (r.body && r.body.error) || `HTTP ${r.status}` };
    return { status: 'server', http: r.status, error: (r.body && r.body.error) || `HTTP ${r.status}` };
  } catch (e) {
    return { status: 'offline', error: e && e.message ? e.message : String(e) };
  }
}

// ── Application state ────────────────────────────────────────────────────────
let win = null;
let kioskUrl = null;          // current kiosk URL (string) or null
let configSource = null;
let view = 'none';            // 'kiosk' | 'recovery'
let recoveryReason = null;    // 'invalid-key' | 'offline' | 'server' | 'no-config' | 'manual'
let pageFailed = false;       // kiosk page failed to load / showed an HTTP error page
let invalidStreak = 0;
let offlineStreak = 0;
let lastCheck = null;         // { at, status, http, error, info }
let checkTimer = null;
let checking = false;
let nextCheckAt = null;
let lastGoodAt = null;
let keyInfo = null;           // { name, key_prefix, display_mode, ... } from /whoami

function stateForPage() {
  const parsed = kioskUrl ? parseKioskUrl(kioskUrl) : null;
  return {
    reason:        recoveryReason,
    appVersion:    APP_VERSION,
    electron:      process.versions.electron,
    hostname:      os.hostname(),
    server:        parsed ? parsed.origin : null,
    keyPrefix:     parsed && parsed.key ? parsed.key.slice(0, 20) + '…' : null,
    keyName:       keyInfo && keyInfo.name ? keyInfo.name : null,
    hasConfig:     !!kioskUrl,
    configSource,
    configTargets: writableConfigTargets(),
    logPath:       logPath(),
    lastCheck,
    lastGoodAt,
    nextCheckAt,
    defaultServer: DEFAULT_SERVER,
  };
}

function pushState() {
  if (win && !win.isDestroyed() && view === 'recovery') {
    win.webContents.send('kiosk:state', stateForPage());
  }
}

function applyConfig() {
  const { config, source } = loadConfig();
  configSource = source;
  const parsed = config && config.kioskUrl ? parseKioskUrl(config.kioskUrl) : null;
  kioskUrl = parsed ? parsed.url : null;
  if (config && config.kioskUrl && !parsed) log(`config: kioskUrl is not a valid URL: ${config.kioskUrl}`);
  log(`config: ${kioskUrl ? `using ${source}` : 'no usable config found'} (candidates: ${configCandidates().join(' | ')})`);
  return !!kioskUrl;
}

// ── Views ────────────────────────────────────────────────────────────────────
function showKiosk() {
  if (!win || win.isDestroyed() || !kioskUrl) return;
  view = 'kiosk';
  recoveryReason = null;
  pageFailed = false;
  log(`view: kiosk → ${maskUrl(kioskUrl)}`);
  win.loadURL(kioskUrl, { userAgent: userAgent() });
}

function showRecovery(reason) {
  if (!win || win.isDestroyed()) return;
  if (view === 'recovery') {
    // Never re-navigate while the admin may be typing — just update the reason.
    if (recoveryReason !== reason) { recoveryReason = reason; log(`view: recovery reason → ${reason}`); }
    pushState();
    return;
  }
  view = 'recovery';
  recoveryReason = reason;
  log(`view: recovery (${reason})`);
  win.loadFile(path.join(__dirname, 'recovery.html'), { query: { reason } });
}

function maskUrl(u) {
  const p = parseKioskUrl(u);
  return p ? `${p.origin}/kiosk?key=${p.key ? p.key.slice(0, 20) + '…' : ''}` : String(u);
}

let _ua = null;
function userAgent() {
  if (!_ua) _ua = `${win.webContents.getUserAgent()} FieldLinkKiosk/${APP_VERSION}`;
  return _ua;
}

// ── Health loop ──────────────────────────────────────────────────────────────
function scheduleCheck(delayMs) {
  if (checkTimer) clearTimeout(checkTimer);
  nextCheckAt = Date.now() + delayMs;
  checkTimer = setTimeout(runCheck, delayMs);
  pushState();
}

function backoffDelay(streak) {
  return RETRY_STEPS_MS[Math.min(streak, RETRY_STEPS_MS.length) - 1] || RETRY_STEPS_MS[0];
}

async function runCheck() {
  if (checking) return;
  checking = true;
  try {
    if (!kioskUrl) {
      showRecovery('no-config');
      scheduleCheck(HEALTH_INTERVAL_MS);
      return;
    }
    const result = await checkKey(kioskUrl);
    lastCheck = { at: Date.now(), ...result };

    if (result.status === 'ok') {
      invalidStreak = 0; offlineStreak = 0; lastGoodAt = Date.now();
      if (result.info && (result.info.name || result.info.key_prefix)) keyInfo = result.info;
      const recovering = view === 'recovery' && ['invalid-key', 'offline', 'server', 'no-config'].includes(recoveryReason);
      if (recovering || (view === 'kiosk' && pageFailed)) {
        log(`health: ok — loading kiosk (was ${view}/${recoveryReason || (pageFailed ? 'page-failed' : '')})`);
        showKiosk();
      } else {
        pushState();
      }
      scheduleCheck(HEALTH_INTERVAL_MS);
      return;
    }

    if (result.status === 'invalid') {
      invalidStreak++; offlineStreak = 0;
      log(`health: key rejected (${result.error}) streak=${invalidStreak}`);
      // Two consecutive rejections before taking over a working display —
      // the server never answers 401 transiently, this is just belt and braces.
      if (invalidStreak >= 2 || view !== 'kiosk' || pageFailed) showRecovery('invalid-key');
      scheduleCheck(invalidStreak < 2 ? 5000 : HEALTH_INTERVAL_MS);
      return;
    }

    // 'server' (5xx, maintenance) or 'offline' (no network / DNS / timeout)
    offlineStreak++; invalidStreak = 0;
    log(`health: ${result.status} (${result.error}) streak=${offlineStreak}`);
    if (view === 'kiosk' && !pageFailed) {
      // The page is up and has its own offline handling (service worker) — leave it alone.
    } else if (view === 'recovery' && recoveryReason === 'invalid-key') {
      // Keep the key message; it is more useful than "offline".
      pushState();
    } else {
      showRecovery(result.status === 'server' ? 'server' : 'offline');
    }
    scheduleCheck(backoffDelay(offlineStreak));
  } catch (e) {
    log(`health: unexpected error ${e && e.stack || e}`);
    scheduleCheck(HEALTH_INTERVAL_MS);
  } finally {
    checking = false;
  }
}

// ── Config file watching (INSTALL.bat re-run while the app is open) ──────────
let watchTimer = null;
function watchConfigDirs() {
  const dirs = [...new Set(configCandidates().map(p => path.dirname(p)))];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      fs.watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && !/config\.json/i.test(String(filename))) return;
        if (watchTimer) clearTimeout(watchTimer);
        watchTimer = setTimeout(onConfigChanged, 1500);
      });
    } catch (e) { log(`watch: cannot watch ${dir}: ${e.message}`); }
  }
}

function onConfigChanged() {
  const before = kioskUrl;
  applyConfig();
  if (kioskUrl && kioskUrl !== before) {
    log('config: kioskUrl changed on disk — reloading');
    invalidStreak = 0; keyInfo = null;
    showKiosk();
    scheduleCheck(3000);
  } else if (kioskUrl && view === 'recovery' && recoveryReason === 'no-config') {
    showKiosk();
    scheduleCheck(3000);
  }
}

// ── IPC from recovery.html ───────────────────────────────────────────────────
ipcMain.handle('kiosk:get-state', () => stateForPage());

ipcMain.handle('kiosk:pair', async (_e, { code, server } = {}) => {
  try {
    const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!CODE_RE.test(clean)) return { ok: false, error: 'Enter the 8-character code exactly as shown in FieldLink Admin.' };
    const current = kioskUrl ? parseKioskUrl(kioskUrl) : null;
    const origin = normaliseOrigin(server || (current && current.origin) || DEFAULT_SERVER);
    log(`pair: trying code ${clean.slice(0, 2)}…… against ${origin}`);
    const r = await fetchJson(`${origin}/api/kiosk/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: clean, hostname: os.hostname(), app_version: APP_VERSION }),
    });
    if (!r.ok) {
      const msg = (r.body && r.body.error) || (r.status === 404 ? 'This FieldLink server does not support pairing codes yet.' : `Server answered HTTP ${r.status}.`);
      log(`pair: failed ${r.status} ${msg}`);
      return { ok: false, error: msg };
    }
    const url = r.body && r.body.url;
    const parsed = url ? parseKioskUrl(url) : null;
    if (!parsed || !parsed.key) return { ok: false, error: 'The server did not return a kiosk URL.' };
    const saved = saveConfig({ kioskUrl: parsed.url });
    keyInfo = r.body.key || null;
    kioskUrl = parsed.url; configSource = saved; invalidStreak = 0;
    log(`pair: linked as "${(r.body.key && r.body.key.name) || '?'}" — saved to ${saved}`);
    showKiosk();
    scheduleCheck(5000);
    return { ok: true, name: r.body.key && r.body.key.name, saved };
  } catch (e) {
    log(`pair: error ${e && e.message}`);
    return { ok: false, error: e && e.message ? e.message : 'Could not reach the server.' };
  }
});

ipcMain.handle('kiosk:set-url', async (_e, { text, server } = {}) => {
  try {
    const current = kioskUrl ? parseKioskUrl(kioskUrl) : null;
    const url = normaliseKioskInput(text, server || (current && current.origin));
    const check = await checkKey(url);
    if (check.status === 'invalid') return { ok: false, error: 'The server rejected that key. Copy the URL again from FieldLink Admin → Kiosk → ⚙ Settings → Copy URL.' };
    // Offline/server errors: save anyway — the health loop will bring the page up when the server is reachable.
    const saved = saveConfig({ kioskUrl: url });
    kioskUrl = url; configSource = saved; invalidStreak = 0; keyInfo = check.info || null;
    log(`set-url: saved ${maskUrl(url)} to ${saved} (check=${check.status})`);
    showKiosk();
    scheduleCheck(5000);
    return { ok: true, saved, warning: check.status === 'ok' ? null : `Saved, but the server is not reachable right now (${check.error}). The kiosk will keep retrying.` };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
});

ipcMain.handle('kiosk:retry', async () => {
  if (checkTimer) clearTimeout(checkTimer);
  invalidStreak = 0;
  await runCheck();
  return stateForPage();
});

ipcMain.handle('kiosk:back', () => {
  if (kioskUrl) { showKiosk(); scheduleCheck(HEALTH_INTERVAL_MS); return { ok: true }; }
  return { ok: false, error: 'No kiosk URL configured yet.' };
});

ipcMain.handle('kiosk:quit', () => { app.quit(); });

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const { config } = loadConfig();
  win = new BrowserWindow({
    width:  (config && config.width)  || 1920,
    height: (config && config.height) || 1080,
    fullscreen: true,
    kiosk: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--flk-version=${APP_VERSION}`],
    },
  });

  // Stay on the kiosk's own server (or our local recovery page).
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return;
    const p = kioskUrl ? parseKioskUrl(kioskUrl) : null;
    if (!p || !url.startsWith(p.origin)) { log(`blocked navigation to ${url}`); e.preventDefault(); }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Network down at boot, DNS failure, connection refused…
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: we navigated away */) return;
    log(`page: failed to load ${maskUrl(url)} (${code} ${desc})`);
    if (view === 'kiosk') {
      pageFailed = true;
      offlineStreak = Math.max(offlineStreak, 1);
      showRecovery('offline');
      scheduleCheck(RETRY_STEPS_MS[0]);
    }
  });

  // A maintenance page or gateway error (502/503) "loads" fine as far as
  // Chromium is concerned. Remember that so the health loop reloads once the
  // server is healthy again — but leave the server's own page on screen.
  win.webContents.on('did-navigate', (_e, url, httpCode) => {
    if (view !== 'kiosk' || !url.startsWith('http')) return;
    if (httpCode >= 400) { pageFailed = true; log(`page: HTTP ${httpCode} for ${maskUrl(url)}`); scheduleCheck(RETRY_STEPS_MS[0]); }
    else pageFailed = false;
  });

  win.webContents.on('render-process-gone', (_e, details) => {
    log(`page: renderer gone (${details.reason}) — reloading in 2s`);
    setTimeout(() => { if (view === 'kiosk') showKiosk(); else if (win && !win.isDestroyed()) win.webContents.reload(); }, 2000);
  });
  win.webContents.on('unresponsive', () => {
    log('page: unresponsive — reloading in 10s unless it recovers');
    setTimeout(() => { if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.reload(); }, 10000);
  });
  win.webContents.on('console-message', (_e, level, message) => {
    // Electron <34: (event, level, message, …); Electron ≥34: (details)
    if (_e && typeof _e === 'object' && 'message' in _e && level === undefined) { message = _e.message; level = _e.level === 'error' || _e.level === 'warning' ? 2 : 0; }
    if (level >= 2) log(`page console: ${message}`);
  });

  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  trimLog();
  log(`FieldLinkKiosk ${APP_VERSION} starting (electron ${process.versions.electron}, ${os.hostname()})`);

  try { powerSaveBlocker.start('prevent-display-sleep'); } catch {}

  createWindow();
  applyConfig();
  watchConfigDirs();

  if (kioskUrl) showKiosk(); else showRecovery('no-config');
  scheduleCheck(kioskUrl ? 5000 : HEALTH_INTERVAL_MS);

  globalShortcut.register('CommandOrControl+Shift+K', () => {
    if (view === 'recovery' && recoveryReason === 'manual') { if (kioskUrl) showKiosk(); }
    else showRecovery('manual');
  });
  globalShortcut.register('CommandOrControl+Shift+R', () => {
    if (kioskUrl) { invalidStreak = 0; showKiosk(); scheduleCheck(5000); }
  });
  globalShortcut.register('CommandOrControl+Shift+Q', () => {
    globalShortcut.unregisterAll();
    app.quit();
  });
});

// Only one kiosk window at a time (the Windows shell can launch us more than once).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (checkTimer) clearTimeout(checkTimer); });
