'use strict';
const { app, BrowserWindow, Tray, Menu, Notification, shell, nativeImage, safeStorage, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const os = require('os');
const { spawn } = require('child_process');
const { Core } = require('./src/core');
const { setLogFile, log } = require('./src/util');
const { noteVersion, cleanUpdateLeftovers, stopInstalledCopies } = require('./src/housekeeping');

// Which build this is is decided when it is built (package.json "artemaEdition"), never by anything the app finds at run time:
// the server build is always the main computer, the client build never is. ARTEMA_EDITION is for running from source.
const EDITION = ['server', 'client'].find(e => e === (process.env.ARTEMA_EDITION || require('./package.json').artemaEdition)) || 'any';
const IS_SERVER = EDITION === 'server';
const APP_NAME = IS_SERVER ? 'Artema Portal Server' : 'Artema Portal';
const APP_ID = IS_SERVER ? 'com.artema.portal.server' : 'com.artema.portal';
const TITLEBAR = 36;
const BACKGROUND = process.argv.includes('--background');
app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
// Each edition keeps its own settings, so installing or updating one can never touch the other's identity, PIN or certificate.
app.setPath('userData', process.env.ARTEMA_DATA || path.join(app.getPath('appData'), APP_NAME));

// A stray error in one transfer must never pop a blocking dialog on an unattended machine.
process.on('uncaughtException', e => log('uncaught: ' + (e && e.stack || e)));
process.on('unhandledRejection', e => log('unhandled rejection: ' + (e && e.stack || e)));

let core = null, win = null, tray = null, quitting = false, toldAboutTray = false, updating = false;

// What the packaged app knows about itself, for updates. The server build carries the client app in resources/update;
// connecting computers fetch it from there. Empty when run from source. The ARTEMA_UPDATE_* switches are for automated tests only.
const appInfo = app.isPackaged ? {
  version: app.getVersion(), electron: process.versions.electron, appDir: path.join(process.resourcesPath, 'app'),
  updateDir: IS_SERVER ? path.join(process.resourcesPath, 'update') : null,
  updateFirstMs: process.env.ARTEMA_UPDATE_FIRST_MS ? parseInt(process.env.ARTEMA_UPDATE_FIRST_MS, 10) : undefined,
  updateEveryMs: process.env.ARTEMA_UPDATE_EVERY_MS ? parseInt(process.env.ARTEMA_UPDATE_EVERY_MS, 10) : undefined,
} : {};
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
    setImmediate(maybeApplyUpdate);              // nobody is looking at the window now: a waiting update can install
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
  const pending = core.pendingUpdate();
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(pending ? [{ label: `Restart to install version ${pending.version}`, click: () => applyUpdate() }, { type: 'separator' }] : []),
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

// ---- updates from the main computer
// A complete new copy of the app is already waiting next to the running one. Installing it means quitting, so it happens when
// nobody is looking at the window; a small helper (src/update-helper.js) swaps the folders, starts the new version, and goes
// back to the old one if the new one crashes.
const windowVisible = () => !!(win && !win.isDestroyed() && win.isVisible());
function onUpdateReady(info) {
  rebuildTray();
  if (info.now) return applyUpdate();          // the person pressed "Install" on the main computer: no waiting for the window to close
  if (windowVisible()) notify('Update ready', `Version ${info.version} installs as soon as you close the window.`);
  else applyUpdate();
}
function maybeApplyUpdate() { if (core && core.pendingUpdate() && !windowVisible()) applyUpdate(); }
async function applyUpdate() {
  const info = core && core.pendingUpdate();
  if (!info || updating) return;
  updating = true;
  try {
    const helper = path.join(os.tmpdir(), `artema-update-${process.pid}-${Date.now()}.js`);
    fs.copyFileSync(path.join(__dirname, 'src', 'update-helper.js'), helper);          // run from outside the folder it is about to replace
    const job = { pid: process.pid, appDir: info.appDir, stageDir: info.stageDir, oldDir: info.appDir + '.old', exe: process.execPath, args: info.args || ['--background'], extra: info.extra, cleanup: info.cleanup, version: info.version, logFile: path.join(app.getPath('userData'), 'update.log') };
    log(`restarting to install version ${info.version}`);
    spawn(process.execPath, [helper, JSON.stringify(job)], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).unref();
    quitting = true;
    try { await core.shutdown(); } catch { /* exiting anyway */ }
    app.exit(0);
  } catch (e) { updating = false; log(`could not start the update: ${e.message}`); }
}

// ---- self-install
// The download is a plain folder. The first time it runs it copies itself to a permanent place, adds Start menu and
// Desktop shortcuts, and relaunches from there, so the downloaded folder can be deleted afterwards.
function installDir() { return process.env.ARTEMA_INSTALL_DIR || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', IS_SERVER ? 'Artema Portal Server' : 'Artema Portal Desktop'); }   // not "Artema Portal": the old Python version used that folder

function makeShortcuts(exe) {
  if (process.env.ARTEMA_NO_SHORTCUTS) return;
  const opts = { target: exe, cwd: path.dirname(exe), icon: path.join(path.dirname(exe), 'resources', 'app', 'assets', 'icon.ico'), iconIndex: 0, description: APP_NAME, appUserModelId: APP_ID };
  const places = [path.join(app.getPath('desktop'), `${APP_NAME}.lnk`),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`)];
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
  const exe = path.join(target, path.basename(process.execPath));
  try {
    await stopInstalledCopies(exe);          // an older version still sitting in the tray would hold the files (and the lock) we need
    fs.mkdirSync(target, { recursive: true });
    // replace the app wholesale so no file of an older version can linger and mix with the new one
    for (const leftover of ['app', 'app.old', 'app.update', 'app.update.json', 'app.failed']) fs.rmSync(path.join(target, 'resources', leftover), { recursive: true, force: true });
    fs.cpSync(here, target, { recursive: true, force: true });
  } catch (e) {
    log('self-install failed, running in place: ' + e.message);
    splash.close();
    return false;
  }
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
  // A work order as a PDF: the page is drawn by a hidden window (no scripts, no network) and printed to Letter paper.
  renderPdf: async html => {
    const file = path.join(os.tmpdir(), `artema-workorder-${process.pid}-${Date.now()}.html`);
    fs.writeFileSync(file, html);
    const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, spellcheck: false } });
    try {
      await w.loadFile(file);
      return await w.webContents.printToPDF({ pageSize: 'Letter', printBackground: true, margins: { marginType: 'none' } });
    } finally { w.destroy(); try { fs.unlinkSync(file); } catch { /* temp folder */ } }
  },
  onConflict: c => notify('Two main computers found', `“${c.name}” (${c.address}) is also acting as a main computer. Open Setup and status to sort it out.`),
  onRelocated: () => notify('Reconnected', 'The main computer changed address. Artema Portal followed it.'),
  onUpdateReady,
  // The newest server owns the default port. Closes whatever Artema Portal program is listening on it (and nothing else).
  stopPortHolder: port => new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(false);
    const ps = `$p = (Get-NetTCPConnection -LocalPort ${parseInt(port, 10)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; ` +
      `if ($p) { $n = (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName; if ($n -like 'Artema Portal*' -and $p -ne ${process.pid}) { taskkill /PID $p /T /F | Out-Null; 'closed' } }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, (_err, out) => resolve(/closed/.test(String(out || ''))));
  }),
  openFirewall: port => new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(true);
    const rule = (name, proto, p) => new Promise(r => execFile('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow',
      `protocol=${proto}`, `localport=${p}`, 'profile=private,domain'], { windowsHide: true, timeout: 15000 }, err => r(!err)));
    Promise.all([rule('Artema Portal', 'TCP', port), rule('Artema Portal discovery', 'UDP', 41234)]).then(([a, b]) => resolve(a && b));
  }),
  afterSetup: () => { applyLoginItem(true); rebuildTray(); },
  afterReset: () => { applyLoginItem(false); rebuildTray(); },
};

// Another copy already running normally means "just show it". The exception is a freshly downloaded copy (not the installed one):
// that is someone installing a new version, so it goes on to replace the old one, which it closes first.
const runningFromInstall = () => path.resolve(path.dirname(process.execPath)).toLowerCase() === path.resolve(installDir()).toLowerCase();
const hasLock = app.requestSingleInstanceLock();
const installing = !hasLock && app.isPackaged && process.platform === 'win32' && !runningFromInstall() && !(process.env.ARTEMA_DATA && !process.env.ARTEMA_INSTALL_DIR);

if (!hasLock && !installing) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => { if (!argv.includes('--background')) showWindow(); });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));       // pages never get camera, location, notifications...
    setLogFile(path.join(app.getPath('userData'), 'portal.log'));
    if (await ensureInstalled()) return;
    if (!hasLock) { app.quit(); return; }          // could not install over the running copy: leave it alone
    core = new Core({
      dataDir: app.getPath('userData'), webDir: path.join(__dirname, 'web'),
      desktopDir: process.env.ARTEMA_DESKTOP || app.getPath('desktop'), hooks, edition: EDITION, app: appInfo,
    });
    const ran = noteVersion(app.getPath('userData'), app.getVersion());          // first run of a new version: tidy up after the old one
    if (app.isPackaged) {
      cleanUpdateLeftovers(appInfo.appDir, app.getVersion());
      if (ran.changed) {
        log(`version ${ran.previous || '(first run)'} -> ${app.getVersion()}`);
        if (runningFromInstall()) makeShortcuts(process.execPath);          // shortcuts always point at the program that is installed now
      }
    }
    await core.startLocalServer(parseInt(process.env.ARTEMA_LOCAL_PORT, 10) || 0);   // env switches are for automated tests only
    await core.startRole();
    await core.ensureServer();          // the server build needs no setup: it simply becomes the main computer
    log(`started v${app.getVersion()} edition=${EDITION} role=${core.cfg.role || 'none'}`);
    createTray();
    if (core.configured) applyLoginItem(true);
    if (process.env.ARTEMA_NO_WINDOW) return;
    if (!BACKGROUND || !core.configured) createWindow();
  });
  app.on('before-quit', () => { quitting = true; });
}
