'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, shell, nativeImage, safeStorage, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Core } = require('./src/core');
const { setLogFile, log } = require('./src/util');

const APP_ID = 'com.artema.portal';
const TITLEBAR = 36;
const BACKGROUND = process.argv.includes('--background');
app.setName('Artema Portal');
app.setAppUserModelId(APP_ID);
if (process.env.ARTEMA_DATA) app.setPath('userData', process.env.ARTEMA_DATA);

// A stray error in one transfer must never pop a blocking dialog on an unattended machine.
process.on('uncaughtException', e => log('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', e => log('unhandled rejection: ' + (e && e.stack || e)));

let core = null, win = null, tray = null, quitting = false, toldAboutTray = false;
const asset = n => path.join(__dirname, 'assets', n);

// ---- notifications
function notify(title, body) {
  if (!Notification.isSupported() || (win && !win.isDestroyed() && win.isFocused())) return;
  const n = new Notification({ title, body, icon: asset('icon.png') });
  n.on('click', showWindow);
  n.show();
}

// ---- window
const isOurs = url => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;           // this computer's own pages
    return u.protocol === 'https:' && !!(core && core.cfg.host_url && new URL(core.cfg.host_url).hostname === u.hostname);
  } catch { return false; }
};
const targetUrl = () => (core.configured && !core.startError ? core.portalUrl() : core.localUrl('/'));

// The main computer's certificate is self-signed on purpose: this window accepts exactly that certificate (this computer's
// own, or the one pinned when it joined) and nothing else. Any other certificate error is refused as usual.
app.on('certificate-error', (event, _wc, url, _error, certificate, callback) => {
  event.preventDefault();
  callback(!!(core && core.trustsCertificate(url, certificate.data)));
});

// A joined computer's window is signed in to the main computer with the token it received when it joined.
async function primeSession() {
  const c = core && core.sessionCookie();
  if (!c) return;
  try {
    await session.defaultSession.cookies.set({ url: c.url, name: c.name, value: c.value, secure: true, httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 365 * 86400 });
  } catch (e) { log('could not sign the window in: ' + e.message); }
}
async function load(url) { await primeSession(); if (win && !win.isDestroyed()) await win.loadURL(url); }

const CHROME_CSS = `
  html.in-electron body { padding-top: ${TITLEBAR}px; }
  html.in-electron .app { height: calc(100vh - ${TITLEBAR}px); }
  html.in-electron .detail { top: ${TITLEBAR}px; }
  #app-drag { position: fixed; top: 0; left: 0; right: 0; height: ${TITLEBAR}px; background: #0a0b0f; -webkit-app-region: drag; z-index: 2000; }
`;
const CHROME_JS = `document.documentElement.classList.add('in-electron');
  if (!document.getElementById('app-drag')) document.body.insertAdjacentHTML('beforeend', '<div id="app-drag"></div>');`;

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 420, minHeight: 560, show: false, backgroundColor: '#0a0b0f',
    title: 'Artema Portal', icon: asset('icon.png'), autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#0a0b0f', symbolColor: '#f6efe6', height: TITLEBAR },
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: false },
  });
  win.removeMenu();
  win.once('ready-to-show', () => win.show());
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray) {
      toldAboutTray = true;
      new Notification({ title: 'Artema Portal is still running', body: 'It keeps syncing in the background. Use the tray icon to open or quit.', icon: asset('icon.png') }).show();
    }
  });
  const wc = win.webContents;
  wc.on('did-finish-load', () => { wc.insertCSS(CHROME_CSS).catch(() => { }); wc.executeJavaScript(CHROME_JS).catch(() => { }); });
  wc.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (!isMain || code === -3) return;                         // -3 = aborted by another navigation
    win.loadURL(core.localUrl('/offline.html?to=' + encodeURIComponent(url)));
  });
  wc.on('will-navigate', (e, url) => { if (!isOurs(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !isOurs(url)) shell.openExternal(url); return { action: 'deny' }; });
  load(targetUrl()).catch(() => { });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

// ---- tray
function rebuildTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Artema Portal', click: () => { showWindow(); if (core.configured) load(targetUrl()).catch(() => { }); } },
    { label: 'Show the Portal folder', enabled: core.configured, click: () => shell.openPath(core.folder) },
    { label: 'Setup and status', click: () => { showWindow(); win.loadURL(core.localUrl('/')); } },
    { type: 'separator' },
    { label: 'Quit Artema Portal', click: quit },
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.on('click', showWindow);
  rebuildTray();
  setInterval(() => {
    const s = core.state().status;
    tray.setToolTip(`Artema Portal${s ? ' · ' + s.message : ''}`);
  }, 5000);
}
async function quit() {
  quitting = true;
  try { await core.shutdown(); } catch { /* exiting anyway */ }
  app.quit();
}

// ---- self-install
// The download is a plain folder. The first time it runs it copies itself to a permanent place, adds Start menu and
// Desktop shortcuts, and relaunches from there, so the downloaded folder can be deleted afterwards.
function installDir() { return process.env.ARTEMA_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', 'Artema Portal Desktop'); }   // not "Artema Portal": the old Python version used that folder

function makeShortcuts(exe) {
  if (process.env.ARTEMA_NO_SHORTCUTS) return;
  const opts = { target: exe, cwd: path.dirname(exe), icon: path.join(path.dirname(exe), 'resources', 'app', 'assets', 'icon.ico'), iconIndex: 0, description: 'Artema Portal', appUserModelId: APP_ID };
  const places = [path.join(app.getPath('desktop'), 'Artema Portal.lnk'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Artema Portal.lnk')];
  for (const p of places) { try { shell.writeShortcutLink(p, 'create', opts); } catch (e) { log('shortcut failed: ' + e.message); } }
}

async function ensureInstalled() {
  if (!app.isPackaged || process.platform !== 'win32') return false;
  if (process.env.ARTEMA_DATA && !process.env.ARTEMA_INSTALL_DIR) return false;      // automated tests
  const here = path.dirname(process.execPath), target = installDir();
  if (path.resolve(here).toLowerCase() === path.resolve(target).toLowerCase()) return false;
  const splash = new BrowserWindow({ width: 440, height: 220, frame: false, resizable: false, backgroundColor: '#0a0b0f', alwaysOnTop: true, icon: asset('icon.png') });
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<body style="margin:0;background:#0a0b0f;color:#f6efe6;font:600 18px Segoe UI,sans-serif;display:grid;place-items:center;height:100vh;letter-spacing:.02em">Installing Artema Portal…</body>'));
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(here, target, { recursive: true, force: true });
  } catch (e) {
    log('self-install failed, running in place: ' + e.message);
    splash.close();
    return false;
  }
  const exe = path.join(target, path.basename(process.execPath));
  makeShortcuts(exe);
  app.releaseSingleInstanceLock();
  require('child_process').spawn(exe, process.argv.slice(1), { detached: true, stdio: 'ignore', cwd: target }).unref();
  app.exit(0);
  return true;
}

// ---- startup
function applyLoginItem(on) {
  if (!app.isPackaged || process.env.ARTEMA_DATA) return;          // never change login items from a dev run
  app.setLoginItemSettings({ openAtLogin: on, args: ['--background'] });
}
const hooks = {
  // secrets (join PIN, this computer's token, the certificate's private key) are locked with the Windows account when possible
  seal: t => (safeStorage.isEncryptionAvailable() ? 'os1:' + safeStorage.encryptString(t).toString('base64') : null),
  unseal: t => (String(t).startsWith('os1:') ? safeStorage.decryptString(Buffer.from(String(t).slice(4), 'base64')) : ''),
  onIncoming: (who, name) => notify(`${who} sent a file`, name),
  onReceived: list => {
    if (list.length === 1) notify(`${list[0].by} sent you a file`, list[0].name);
    else notify(`${list.length} new files`, 'From ' + [...new Set(list.map(l => l.by))].join(', '));
  },
  reveal: full => { try { fs.statSync(full).isDirectory() ? shell.openPath(full) : shell.showItemInFolder(full); } catch { shell.openPath(path.dirname(full)); } },
  openFolder: f => shell.openPath(f),
  onConflict: c => notify('Two main computers found', `“${c.name}” (${c.address}) is also acting as a main computer. Open Setup and status to sort it out.`),
  onRelocated: () => notify('Reconnected', 'The main computer changed address. Artema Portal followed it.'),
  openFirewall: port => new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(true);
    const rule = (name, proto, p) => new Promise(r => execFile('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow',
      `protocol=${proto}`, `localport=${p}`, 'profile=private,domain'], { windowsHide: true, timeout: 15000 }, err => r(!err)));
    Promise.all([rule('Artema Portal', 'TCP', port), rule('Artema Portal discovery', 'UDP', 41234)]).then(([a, b]) => resolve(a && b));
  }),
  afterSetup: () => { applyLoginItem(true); rebuildTray(); },
  afterReset: () => { applyLoginItem(false); rebuildTray(); },
};

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { if (!argv.includes('--background')) showWindow(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));       // pages never get camera, location, notifications...
    setLogFile(path.join(app.getPath('userData'), 'portal.log'));
    if (await ensureInstalled()) return;
    core = new Core({
      dataDir: app.getPath('userData'), webDir: path.join(__dirname, 'web'),
      desktopDir: process.env.ARTEMA_DESKTOP || app.getPath('desktop'), hooks,
    });
    await core.startLocalServer(parseInt(process.env.ARTEMA_LOCAL_PORT, 10) || 0);   // env switches are for automated tests only
    await core.startRole();
    log(`started v${app.getVersion()} role=${core.cfg.role || 'none'}`);
    createTray();
    if (core.configured) applyLoginItem(true);
    if (process.env.ARTEMA_NO_WINDOW) return;
    if (!BACKGROUND || !core.configured) createWindow();
  });
  app.on('before-quit', () => { quitting = true; });
}
