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
const { execFile } = require('child_process');

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
    pair:          pair ? { code: pair.code, expiresAt: pair.expiresAt, origin: pair.origin, status: pair.status, error: pair.error } : null,
    platform:      process.platform,
    adminActionStartedAt,
    updateState,
    adminJob: adminJob ? { action: adminJob.action, running: adminJob.running, startedAt: adminJob.startedAt, exitCode: adminJob.exitCode, error: adminJob.error } : null,
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
  stopPairRequest();
  log(`view: kiosk → ${maskUrl(kioskUrl)}`);
  win.loadURL(kioskUrl, { userAgent: userAgent() });
}

function showRecovery(reason) {
  if (!win || win.isDestroyed()) return;
  if (view === 'recovery') {
    // Never re-navigate while the admin may be typing — just update the reason.
    if (recoveryReason !== reason) { recoveryReason = reason; log(`view: recovery reason → ${reason}`); }
    maybeStartPairing(reason);
    pushState();
    return;
  }
  view = 'recovery';
  recoveryReason = reason;
  log(`view: recovery (${reason})`);
  win.loadFile(path.join(__dirname, 'recovery.html'), { query: { reason } });
  maybeStartPairing(reason);
}

// On-screen pairing makes sense whenever the display needs (or may want) a new
// key — not while we are merely offline.
function maybeStartPairing(reason) {
  if (!['invalid-key', 'no-config', 'manual'].includes(reason)) return;
  if (pair && pair.status !== 'error') return;
  startPairRequest();
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

// ── Kiosk-displayed pairing code ─────────────────────────────────────────────
// The setup/recovery screen asks the server for a short code and shows it; the
// admin types it into FieldLink Admin → Kiosk → 🔗 Link kiosk. We poll with the
// secret token until the admin has claimed the code, then save the URL the
// server hands back. No keyboard needed at the display.
const PAIR_POLL_MS = 3000;
let pair = null; // { origin, code, token, expiresAt, status: requesting|waiting|error, error, timer }

function stopPairRequest() {
  if (pair && pair.timer) clearTimeout(pair.timer);
  pair = null;
}

async function startPairRequest(serverText) {
  stopPairRequest();
  let origin;
  try {
    const current = kioskUrl ? parseKioskUrl(kioskUrl) : null;
    origin = normaliseOrigin(serverText || (current && current.origin) || DEFAULT_SERVER);
  } catch (e) {
    pair = { status: 'error', error: e.message || String(e), origin: null, code: null, token: null, expiresAt: null, timer: null };
    pushState();
    return;
  }
  const mine = { origin, status: 'requesting', code: null, token: null, expiresAt: null, error: null, timer: null };
  pair = mine;
  pushState();
  try {
    const r = await fetchJson(`${origin}/api/kiosk/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: os.hostname(), app_version: APP_VERSION }),
    });
    if (pair !== mine) return; // superseded by a newer request
    if (!r.ok || !r.body || !r.body.code || !r.body.token) {
      mine.status = 'error';
      mine.error = (r.body && r.body.error) || (r.status === 404
        ? 'This FieldLink server does not support on-screen pairing yet. Ask for a code in FieldLink Admin and type it below instead.'
        : `Server answered HTTP ${r.status}.`);
      log(`pair-request: failed ${r.status} ${mine.error}`);
      pushState();
      return;
    }
    mine.code = r.body.code;
    mine.token = r.body.token;
    mine.expiresAt = Date.parse(r.body.expires_at) || (Date.now() + 15 * 60 * 1000);
    mine.status = 'waiting';
    log(`pair-request: showing code ${mine.code} for ${origin}`);
    pushState();
    mine.timer = setTimeout(pollPairRequest, PAIR_POLL_MS);
  } catch (e) {
    if (pair !== mine) return;
    mine.status = 'error';
    mine.error = `Cannot reach ${origin} (${e && e.message ? e.message : e}).`;
    pushState();
  }
}

async function pollPairRequest() {
  if (!pair || pair.status !== 'waiting' || view !== 'recovery') return;
  const p = pair;
  try {
    const r = await fetchJson(`${p.origin}/api/kiosk/pair/poll`, { headers: { 'x-pair-token': p.token } });
    if (pair !== p) return;
    if (r.ok && r.body && r.body.status === 'linked' && r.body.url) {
      const parsed = parseKioskUrl(r.body.url);
      if (parsed && parsed.key) {
        const saved = saveConfig({ kioskUrl: parsed.url });
        keyInfo = r.body.key || null; kioskUrl = parsed.url; configSource = saved; invalidStreak = 0;
        log(`pair-request: linked as "${(r.body.key && r.body.key.name) || '?'}" — saved to ${saved}`);
        stopPairRequest();
        showKiosk();
        scheduleCheck(5000);
        return;
      }
    }
    const expired = r.status === 404 || r.status === 410 || (r.body && r.body.status === 'expired') || Date.now() > p.expiresAt;
    if (expired) {
      log('pair-request: code expired — requesting a new one');
      startPairRequest(p.origin);
      return;
    }
  } catch (e) { /* offline — keep polling */ }
  if (pair === p) p.timer = setTimeout(pollPairRequest, PAIR_POLL_MS);
}

// ── Privileged helper (resources/kiosk-admin.ps1) ────────────────────────────
// Everything that needs administrator rights (kiosk lockdown, undo, updates)
// runs through one PowerShell script shipped with the app. Elevation goes
// through a normal UAC prompt; progress and results come back via
// %ProgramData%\FieldLinkKiosk-Admin\last-action.json.
let adminActionStartedAt = 0;

function adminScriptPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'kiosk-admin.ps1') : path.join(__dirname, 'resources', 'kiosk-admin.ps1');
}
function adminDir() {
  const pd = process.env.ProgramData || process.env.PROGRAMDATA || process.env.ALLUSERSPROFILE;
  return pd ? path.join(pd, 'FieldLinkKiosk-Admin') : null;
}
function psExe() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
function runPs(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(psExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
      { timeout: timeoutMs || 60000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const extra = err && typeof err.code !== 'number' ? ` ${err.message}` : '';
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') + extra });
      });
  });
}

async function adminStatus() {
  if (process.platform !== 'win32') return { unsupported: true, reason: 'Kiosk mode is only available on Windows.' };
  const r = await runPs(['-File', adminScriptPath(), '-Action', 'Status', '-Exe', app.getPath('exe')], 90000);
  const i = r.stdout.indexOf('{');
  if (i < 0) return { error: (r.stderr || r.stdout || 'No status returned').trim().slice(0, 500) };
  try { return JSON.parse(r.stdout.slice(i)); } catch (e) { return { error: 'Could not read status: ' + e.message }; }
}

// PowerShell's round-trip dates carry 7 fractional digits; trim to 3 for Date.parse.
function parsePsDate(v) {
  if (!v) return 0;
  const t = Date.parse(String(v).replace(/(\.\d{3})\d+/, '$1'));
  return Number.isNaN(t) ? 0 : t;
}

let _resultReadError = null;
function readAdminResult() {
  const dir = adminDir();
  if (!dir) return null;
  const file = path.join(dir, 'last-action.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\ufeff/, ''));
    // Results written before the current action started belong to an earlier run.
    j.stale = adminActionStartedAt > 0 && parsePsDate(j.updatedAt) < adminActionStartedAt - 5000;
    _resultReadError = null;
    return j;
  } catch (e) {
    const msg = e && e.code ? e.code : String(e && e.message || e);
    if (_resultReadError !== msg) { _resultReadError = msg; log(`admin: cannot read ${file}: ${msg}`); }
    return null;
  }
}

let adminJob = null; // { action, startedAt, finishedAt, running, exitCode, logFile, error }

function adminTempDir() {
  const d = path.join(app.getPath('temp'), 'FieldLinkKiosk-admin');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function tailFile(file, maxLines) {
  try {
    const buf = fs.readFileSync(file);
    const utf16 = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
    const txt = (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/\ufeff/g, '').replace(/\r/g, '');
    const lines = txt.split('\n').filter(l => l.trim().length);
    return lines.slice(-(maxLines || 12));
  } catch { return []; }
}

// Runs kiosk-admin.ps1 elevated (one UAC prompt) and WAITS for it, so we know
// exactly when it finished and how. Everything the helper prints goes to a
// log file in this user's temp folder that the screen tails live.
async function adminRunElevated(action) {
  const allowed = ['Lockdown', 'Unlock', 'Update', 'InstallUpdater', 'RemoveUpdater'];
  if (!allowed.includes(action)) return { ok: false, error: 'Unknown action.' };
  if (process.platform !== 'win32') return { ok: false, error: 'Kiosk mode is only available on Windows.' };
  if (adminJob && adminJob.running) return { ok: false, error: `${adminJob.action} is still running.` };

  const dir = adminTempDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(dir, `${action}-${stamp}.log`);
  const runner  = path.join(dir, `run-${action}.ps1`);
  const q = v => String(v).replace(/'/g, "''");
  const ps1 = [
    "$ErrorActionPreference = 'Continue'",
    `$log = '${q(logFile)}'`,
    `"[$(Get-Date -Format 'HH:mm:ss')] helper starting: ${action}" | Out-File -FilePath $log -Encoding utf8`,
    `& '${q(adminScriptPath())}' -Action ${action} -Exe '${q(app.getPath('exe'))}'${action === 'Update' ? ' -Relaunch' : ''} *>&1 | Out-File -FilePath $log -Append -Encoding utf8`,
    '$code = $LASTEXITCODE',
    'if ($null -eq $code) { $code = 0 }',
    `"[$(Get-Date -Format 'HH:mm:ss')] helper exit code $code" | Out-File -FilePath $log -Append -Encoding utf8`,
    'exit $code',
    '',
  ].join('\r\n');
  fs.writeFileSync(runner, '\ufeff' + ps1, 'utf8');

  adminActionStartedAt = Date.now();
  adminJob = { action, startedAt: adminActionStartedAt, finishedAt: null, running: true, exitCode: null, logFile, error: null };
  log(`admin: ${action} requested (UAC prompt) — log ${logFile}`);
  pushState();

  const cmd = `$p = Start-Process -FilePath '${q(psExe())}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${q(runner)}"'; exit $p.ExitCode`;
  const r = await runPs(['-Command', cmd], 15 * 60 * 1000);
  adminJob.running = false;
  adminJob.finishedAt = Date.now();
  adminJob.exitCode = r.code;
  if (r.code !== 0 && !fs.existsSync(logFile)) {
    // Never got as far as running: UAC declined or Start-Process failed.
    const declined = /cancel/i.test(r.stderr) || /1223/.test(r.stderr);
    adminJob.error = declined ? 'Administrator permission was declined.' : (r.stderr.trim().slice(0, 300) || 'Could not start the helper.');
  } else if (r.code !== 0) {
    adminJob.error = `The helper exited with code ${r.code}.`;
  }
  log(`admin: ${action} finished exit=${r.code}${adminJob.error ? ' — ' + adminJob.error : ''}`);
  pushState();
  return { ok: !adminJob.error, error: adminJob.error, exitCode: r.code, startedAt: adminActionStartedAt };
}

function adminJobSnapshot() {
  if (!adminJob) return null;
  const result = readAdminResult();
  const fresh = result && !result.stale ? result : null;
  const finishedOk = !adminJob.running && adminJob.exitCode === 0 && !adminJob.error;
  // Lockdown/Unlock always need a restart to take effect, whether or not the result file was readable.
  const needsRestart = finishedOk && ((fresh && fresh.needsRestart) || ['Lockdown', 'Unlock'].includes(adminJob.action));
  return { ...adminJob, elapsedMs: (adminJob.finishedAt || Date.now()) - adminJob.startedAt, logTail: tailFile(adminJob.logFile, 14), result, needsRestart, resultUnreadable: !result && !!_resultReadError };
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

async function checkUpdate() {
  const p = kioskUrl ? parseKioskUrl(kioskUrl) : null;
  const origin = (pair && pair.origin) || (p && p.origin) || DEFAULT_SERVER;
  try {
    const r = await fetchJson(`${origin}/api/kiosk/installer/version`);
    if (!r.ok || !r.body) return { installed: APP_VERSION, server: origin, error: `HTTP ${r.status}` };
    const latest = r.body.version || null;
    return { installed: APP_VERSION, latest, newer: !!latest && cmpVersion(latest, APP_VERSION) > 0, size: r.body.size, sha256: r.body.sha256 || null, published_at: r.body.published_at, server: origin };
  } catch (e) {
    return { installed: APP_VERSION, server: origin, error: e && e.message ? e.message : String(e) };
  }
}

// ── In-app update (does not depend on the helper script) ─────────────────────
// Download the installer ourselves, verify it, then ask Windows once (UAC) to
// run it silently. The elevated command also relaunches the app afterwards,
// because the installer closes the running app.
let updateState = null; // { phase: checking|downloading|verifying|installing|done|failed, percent, message, error, startedAt }

function setUpdateState(patch) {
  updateState = { ...(updateState || {}), ...patch, updatedAt: Date.now() };
  pushState();
}

async function installUpdateNative() {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only.' };
  if (updateState && ['checking', 'downloading', 'verifying', 'installing'].includes(updateState.phase)) return { ok: false, error: 'An update is already in progress.' };
  setUpdateState({ phase: 'checking', percent: 0, message: 'Checking for a newer build…', error: null, startedAt: Date.now() });
  try {
    const u = await checkUpdate();
    if (u.error) throw new Error(`Could not check ${u.server}: ${u.error}`);
    if (!u.newer) { setUpdateState({ phase: 'done', percent: 100, message: `Already up to date (FieldLinkKiosk ${APP_VERSION}).` }); return { ok: true, upToDate: true }; }
    const dir = path.join(app.getPath('temp'), 'FieldLinkKiosk-update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `FieldLinkKiosk-Setup-${u.latest}.exe`);
    try { fs.unlinkSync(file); } catch {}

    setUpdateState({ phase: 'downloading', percent: 0, message: `Downloading FieldLinkKiosk ${u.latest}…` });
    log(`update: downloading ${u.latest} from ${u.server}`);
    const res = await net.fetch(`${u.server}/api/kiosk/installer`, { cache: 'no-store', headers: { 'User-Agent': `FieldLinkKiosk/${APP_VERSION}` } });
    if (!res.ok || !res.body) throw new Error(`Server answered HTTP ${res.status} for the installer.`);
    const total = Number(res.headers.get('content-length')) || u.size || 0;
    const hash = require('crypto').createHash('sha256');
    let received = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file);
      const reader = res.body.getReader();
      out.on('error', reject);
      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            hash.update(value);
            received += value.length;
            if (!out.write(Buffer.from(value))) await new Promise(r => out.once('drain', r));
            if (total) setUpdateState({ percent: Math.min(99, Math.round(received / total * 100)), message: `Downloading FieldLinkKiosk ${u.latest}… ${(received / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB` });
          }
          out.end(resolve);
        } catch (e) { reject(e); }
      })();
    });

    setUpdateState({ phase: 'verifying', percent: 100, message: 'Verifying download…' });
    const size = fs.statSync(file).size;
    if (u.size && Number(u.size) !== size) throw new Error(`Download is ${size} bytes, expected ${u.size}.`);
    const digest = hash.digest('hex');
    if (u.sha256 && u.sha256.toLowerCase() !== digest) throw new Error('Download checksum does not match the server.');
    log(`update: downloaded ${size} bytes, sha256 ${digest.slice(0, 12)}… (server ${u.sha256 ? 'verified' : 'gave no checksum'})`);

    setUpdateState({ phase: 'installing', message: `Installing FieldLinkKiosk ${u.latest}. Windows will ask for permission; the app closes and reopens by itself.` });
    const exe = app.getPath('exe');
    // The elevated part is a tiny script file (no nested quoting across the
    // command line). It runs after the UAC prompt and survives this process
    // being closed by the installer; explorer.exe relaunches the app de-elevated.
    const runner = path.join(dir, 'run-update.ps1');
    const ps1 = [
      "$ErrorActionPreference = 'Continue'",
      `Start-Process -FilePath '${file.replace(/'/g, "''")}' -ArgumentList '/S' -Wait`,
      'Start-Sleep -Seconds 2',
      `Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + '${exe.replace(/'/g, "''")}' + '"')`,
      '',
    ].join('\r\n');
    fs.writeFileSync(runner, '\ufeff' + ps1, 'utf8');
    const cmd = `Start-Process -FilePath '${psExe()}' -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${runner.replace(/'/g, "''")}"'`;
    const r = await runPs(['-Command', cmd], 120000);
    if (r.code !== 0) {
      const declined = /cancel/i.test(r.stderr) || /1223/.test(r.stderr);
      throw new Error(declined ? 'Administrator permission was declined.' : (r.stderr.trim().slice(0, 300) || 'Could not start the installer.'));
    }
    log(`update: installer ${u.latest} started elevated — expecting to be closed and relaunched`);
    return { ok: true };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    log(`update: failed — ${msg}`);
    setUpdateState({ phase: 'failed', message: `Update failed: ${msg}`, error: msg });
    return { ok: false, error: msg };
  }
}

ipcMain.handle('kiosk:install-update', () => installUpdateNative());
ipcMain.handle('kiosk:update-state', () => updateState);

ipcMain.handle('kiosk:pair-request', async (_e, { server } = {}) => { await startPairRequest(server); return stateForPage(); });
ipcMain.handle('kiosk:admin-status', () => adminStatus());
ipcMain.handle('kiosk:admin-run', (_e, { action } = {}) => adminRunElevated(action));
ipcMain.handle('kiosk:admin-result', () => readAdminResult());
ipcMain.handle('kiosk:admin-job', () => adminJobSnapshot());
ipcMain.handle('kiosk:check-update', () => checkUpdate());
ipcMain.handle('kiosk:restart', () => {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows only.' };
  log('restart requested from the settings screen');
  execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shutdown.exe'), ['/r', '/t', '5', '/c', 'FieldLink Kiosk: restarting to apply kiosk mode', '/d', 'p:4:1'], { windowsHide: true }, () => {});
  return { ok: true };
});

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
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (checkTimer) clearTimeout(checkTimer); stopPairRequest(); });
