'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const {
  APP_NAME, VERSION, HttpError, readJson, writeJson, cleanName, lanIp, request, readAll, peerCertPem, TLS_IDENTITY_ERRORS,
  jsonRequest, sendJson, readBody, serveStatic, sendError, guardRequest, log, sleep,
} = require('./util');
const {
  genPin, normPin, prettyPin, joinProof, fingerprintOfPem, loadOrCreateCert, COOKIE, LOCAL_HEADERS,
} = require('./security');
const { Store } = require('./store');
const { RoleStore } = require('./roles');
const { JobStore } = require('./jobs');
const { UpdateSource, UpdateClient } = require('./update');
const { ServerUpdater } = require('./selfupdate');
const { Orders } = require('./orders');
const { compare, valid } = require('./version');
const { createPortalServer } = require('./server');
const { Agent } = require('./agent');
const { Beacon, probeUdp } = require('./discovery');
const crypto = require('crypto');

const DEFAULT_PORT = parseInt(process.env.ARTEMA_DEFAULT_PORT, 10) || 8080;     // env override is for automated tests
const RELOCATE_AFTER_MS = 15000;

/** Best-guess label for a computer from its name. Editable later on the Computers page. */
function guessTag(name) {
  const n = String(name || '').toLowerCase();
  if (/cnc|homag|router|saw|shop|machine|mill/.test(n)) return 'CNC';
  if (/office|boss|admin|front|desk|sales|design|ben/.test(n)) return 'Office';
  return '';
}

function normAddr(addr) {
  addr = String(addr || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!addr) throw new HttpError(400, "Enter the main computer's address");
  return addr.includes(':') ? addr : `${addr}:${DEFAULT_PORT}`;
}

/**
 * Everything except the window: owns the config, runs either the main-computer server or the sync agent,
 * and answers the setup wizard. Platform bits (tray, startup, notifications) come in through `hooks`.
 */
class Core {
  /**
   * `edition` is fixed by the build, never by anything on disk or on the network:
   *   'server' - always the main computer, sets itself up, can never join another one
   *   'client' - always a connecting computer, can never become the main computer
   *   'any'    - development and tests only: either, chosen in the wizard
   */
  constructor({ dataDir, webDir, desktopDir, hooks = {}, edition = 'any', app = {} }) {
    this.edition = edition;
    // what the packaged app knows about itself: { version, electron, appDir, updateDir, updateFirstMs, updateEveryMs }. Empty in development.
    this.app = app;
    this.updater = null; this.updateTimers = [];
    this.selfUpdater = null; this.selfTimers = [];
    this.dataDir = dataDir;
    this.webDir = webDir;
    this.desktopDir = desktopDir;
    this.hooks = hooks;
    this.cfgPath = path.join(dataDir, 'config.json');
    this.cfg = readJson(this.cfgPath, {});
    this.store = null; this.server = null; this.agent = null; this.roles = null; this.jobs = null; this.jobTimers = [];
    this.startError = '';
    this.localServer = null; this.localPort = 0;
    this.beacon = null; this.watchTimer = null; this.conflict = null;
    this.tls = null;
    this.trustLoopback = true;      // the person sitting at the main computer needs no sign-in; automated tests switch this off to exercise the sign-in itself
  }

  // ---- secrets: the join PIN and this computer's token are sealed with the operating system's key store when it offers one
  seal(text) { try { return this.hooks.seal ? this.hooks.seal(String(text)) || null : null; } catch { return null; } }
  unseal(text) { try { return this.hooks.unseal ? this.hooks.unseal(String(text)) || '' : ''; } catch { return ''; } }
  secret(name) { return this.cfg[name + '_enc'] ? this.unseal(this.cfg[name + '_enc']) : (this.cfg[name] || ''); }
  withSecret(cfg, name, value) {
    const out = { ...cfg }; delete out[name]; delete out[name + '_enc'];
    const sealed = this.seal(value);
    if (sealed) out[name + '_enc'] = sealed; else out[name] = value;
    return out;
  }
  getPin() { return this.secret('join_pin'); }
  rotatePin() {
    const pin = genPin();
    this.saveCfg(this.withSecret(this.cfg, 'join_pin', pin));
    if (this.store) this.store.clearWebSessions();          // browsers that signed in with the old PIN sign in again
    log('join PIN replaced');
    return pin;
  }
  /** What the sync agent needs, with the token unsealed. Null when this computer was joined before the Portal had PINs. */
  runtimeCfg() {
    const token = this.secret('device_token');
    if (!token || !this.cfg.host_cert || !/^https:/.test(this.cfg.host_url || '')) return null;
    return { ...this.cfg, token };
  }
  /** Used by the app window: may it accept this self-signed certificate for this address? Only our own, or the pinned main computer's. */
  trustsCertificate(urlStr, pem) {
    try {
      const fp = fingerprintOfPem(pem), u = new URL(urlStr);
      const local = ['localhost', '127.0.0.1', '[::1]', os.hostname().toLowerCase(), lanIp()].includes(u.hostname.toLowerCase());
      if (this.cfg.role === 'host' && this.tls && fp === this.tls.fingerprint && local) return true;
      if (this.cfg.role === 'client' && this.cfg.host_cert && fp === fingerprintOfPem(this.cfg.host_cert) && u.hostname === new URL(this.cfg.host_url).hostname) return true;
    } catch { /* not a certificate we understand */ }
    return false;
  }
  /** The sign-in the app window should carry to the main computer (client computers only; the main computer's own window is trusted). */
  sessionCookie() {
    const token = this.secret('device_token');
    return this.cfg.role === 'client' && token && /^https:/.test(this.cfg.host_url || '') ? { url: this.cfg.host_url.replace(/\/$/, '') + '/', name: COOKIE, value: token } : null;
  }

  get configured() { return this.cfg.role === 'host' || this.cfg.role === 'client'; }
  get folder() { return this.cfg.folder || path.join(this.desktopDir, APP_NAME); }

  portalUrl() {
    if (this.cfg.role === 'host') return `https://localhost:${this.cfg.port}/`;
    if (this.cfg.role === 'client') return `${this.cfg.host_url.replace(/\/$/, '')}/?as=${encodeURIComponent(this.cfg.name)}`;
    return '';
  }
  localUrl(p = '/') { return `http://127.0.0.1:${this.localPort}${p}`; }

  // ---- lifecycle
  /** Why this build can't run the role saved in its settings (settings left by another kind of build), or ''. */
  roleConflict() {
    if (this.edition === 'client' && this.cfg.role === 'host') return 'This is the connecting-computer version of Artema Portal, but its settings are for the main computer. Install the server version on the main computer, and reset this one from Setup and status.';
    if (this.edition === 'server' && this.cfg.role === 'client') return 'This is the server version of Artema Portal, but its settings are for a connecting computer. Reset it from Setup and status.';
    return '';
  }

  /** The server build needs no wizard: with nothing set up yet it becomes the main computer, on the first free port from the default. */
  async ensureServer() {
    if (this.edition !== 'server' || this.configured || this.startError) return;
    const name = (os.hostname().replace(/[^\w .-]/g, '').slice(0, 40)) || 'Main computer';
    try { await this.setupHost(name, DEFAULT_PORT, true); } catch (e) { this.startError = String(e.message || e); log(`server setup failed: ${e && e.stack || e}`); }
  }

  async startRole() {
    this.startError = '';
    const conflict = this.roleConflict();
    if (conflict) { this.startError = conflict; return; }
    try {
      if (this.cfg.role === 'host') {
        if (!this.cfg.instance_id) this.saveCfg({ ...this.cfg, instance_id: crypto.randomBytes(8).toString('hex') });
        this.store = new Store(this.cfg.folder, this.cfg.name, this.dataDir, { onIncoming: this.hooks.onIncoming });
        this.store.instanceId = this.cfg.instance_id;
        if (!this.getPin()) this.saveCfg(this.withSecret(this.cfg, 'join_pin', genPin()));
        this.tls = await loadOrCreateCert(path.join(this.dataDir, 'tls'), { seal: t => this.seal(t), unseal: t => this.unseal(t), hostnames: [os.hostname()], ips: [lanIp()] });
        let port = parseInt(this.cfg.port, 10);
        // the newest server always sits on the default port: if an older Artema server is holding it, it makes way
        if (this.edition === 'server' && port !== DEFAULT_PORT && await this.tryClaim(DEFAULT_PORT)) {
          log(`port ${DEFAULT_PORT} is now this server's (was on ${port})`);
          port = DEFAULT_PORT; this.saveCfg({ ...this.cfg, port });
        }
        this.roles = new RoleStore(path.join(this.dataDir, 'portal.db'));
        this.jobs = new JobStore(path.join(this.dataDir, 'jobs.db'), this.cfg.backup_dir || path.join(this.dataDir, 'backups'));
        this.startJobBackups();
        this.startSelfUpdater();
        this.server = createPortalServer(this.store, port, this.webDir, {
          appVersion: this.app.version || '', roles: this.roles, jobs: this.jobs, orders: new Orders(this.cfg.folder, new Proxy({}, { get: (_, k) => require('xlsx')[k] })), serverUpdate: this.serverUpdateApi(), renderPdf: this.hooks.renderPdf, update: this.app.updateDir ? new UpdateSource(this.app.updateDir) : null, reveal: this.hooks.reveal, tls: this.tls, getPin: () => this.getPin(), rotatePin: () => this.rotatePin(), trustLoopback: () => this.trustLoopback,
        });
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(port, '0.0.0.0', resolve);
        });
        this.server.keepAliveTimeout = 5000;
        this.conflict = null;
        this.beacon = new Beacon(
          () => ({ app: APP_NAME, id: this.cfg.instance_id, name: this.cfg.name, port }),
          peer => {
            if (peer.id && peer.id !== this.cfg.instance_id && !this.conflict) {
              this.conflict = { name: peer.name, address: `${peer.address}:${peer.port}` };
              if (this.hooks.onConflict) this.hooks.onConflict(this.conflict);
            }
          });
        this.beacon.start();
      } else if (this.cfg.role === 'client') {
        const rc = this.runtimeCfg();
        if (!rc) {
          this.startError = 'This computer was connected before the Portal had a PIN. Choose “Connect to the main computer” and enter the PIN shown on the main computer.';
          return;
        }
        this.agent = new Agent(rc, this.dataDir, { onReceived: this.hooks.onReceived });
        this.agent.start();
        this.watchTimer = setInterval(() => this.relocateIfLost().catch(() => { }), 5000);
        this.startUpdater();
      }
    } catch (e) {
      this.startError = e.code === 'EADDRINUSE' ? 'That port is already in use. Try another one.' : String(e.message || e);
      this.server = null;
      log(`start failed: ${e && e.stack || e}`);
    }
  }

  // ---- updates from the main computer (connecting computers only, and only in the packaged app)
  startUpdater() {
    const a = this.app;
    if (this.edition === 'server' || !a.appDir || !a.version || !a.electron) return;
    this.updater = new UpdateClient({
      appDir: a.appDir, version: a.version, electron: a.electron,
      api: {
        json: p => this.agent.call(p),
        file: rel => request('GET', `${this.agent.url}/api/update/file?path=${encodeURIComponent(rel)}`, { headers: this.agent.headers(), timeout: 60000, ca: this.agent.ca }),
      },
      onChange: s => {
        if (s.state === 'ready' && this.hooks.onUpdateReady) this.hooks.onUpdateReady({ version: s.version });
      },
    });
    const check = () => this.updater && this.updater.check().catch(() => { });
    this.updateTimers = [setTimeout(check, a.updateFirstMs != null ? a.updateFirstMs : 20000), setInterval(check, a.updateEveryMs || 10 * 60 * 1000)];
  }
  stopUpdater() {
    for (const t of this.updateTimers) { clearTimeout(t); clearInterval(t); }
    this.updateTimers = []; this.updater = null;
  }
  /** What the restart helper needs, when a complete update is waiting; otherwise null. */
  pendingUpdate() { return this.updater ? this.updater.ready() : this.selfUpdater ? this.selfUpdater.ready() : null; }

  // ---- the server updating itself from the private GitHub repository (server build, packaged app only)
  startSelfUpdater() {
    const a = this.app;
    this.stopSelfUpdater();
    if (this.edition !== 'server' || !a.appDir || !a.updateDir || !a.version || !a.electron) return;
    this.selfUpdater = new ServerUpdater({
      appDir: a.appDir, updateDir: a.updateDir, version: a.version, electron: a.electron, repo: this.cfg.github_repo, apiBase: process.env.ARTEMA_GITHUB_API,
      getToken: () => this.secret('github_token'),
    });
    this.selfUpdater.tidy(false);
    // look now and then so "a new version is ready" shows without anyone pressing anything; it never installs by itself
    const check = () => this.selfUpdater && this.selfUpdater.check().catch(() => { });
    this.selfTimers = [setTimeout(check, a.checkFirstMs != null ? a.checkFirstMs : 60000), setInterval(check, a.checkEveryMs || 6 * 3600 * 1000)];
    const late = setTimeout(() => this.selfUpdater && this.selfUpdater.tidy(true), 90000); late.unref && late.unref();       // the rollback copy is kept until the new version has been running a while
    this.selfTimers.push(late);
    for (const t of this.selfTimers) t.unref && t.unref();
  }
  stopSelfUpdater() {
    for (const t of this.selfTimers) { clearTimeout(t); clearInterval(t); }
    this.selfTimers = []; this.selfUpdater = null;
  }
  serverUpdateApi() {
    const hasToken = () => !!this.secret('github_token');
    return {
      status: () => this.selfUpdater ? this.selfUpdater.status() : { state: 'unavailable', message: 'Updating from GitHub works in the installed server app.', hasToken: hasToken(), current: this.app.version || '' },
      check: async () => { if (!this.selfUpdater) throw new HttpError(400, 'Updating from GitHub works in the installed server app.'); return this.selfUpdater.check(); },
      // downloading takes a while: answer straight away, and the page watches the progress
      install: () => {
        const u = this.selfUpdater;
        if (!u) throw new HttpError(400, 'Updating from GitHub works in the installed server app.');
        if (!u.busy) u.install().then(ok => { if (ok && this.hooks.onUpdateReady) this.hooks.onUpdateReady({ version: u.state.latest, now: true }); }).catch(e => log(`server update: ${e.message}`));
        return u.status();
      },
      setToken: async token => {
        if (token.length > 300 || /\s/.test(token)) throw new HttpError(400, "That doesn't look like a GitHub token");
        const out = { ...this.cfg }; delete out.github_token; delete out.github_token_enc;
        this.saveCfg(token ? this.withSecret(out, 'github_token', token) : out);
        log(token ? 'GitHub access token saved' : 'GitHub access token removed');
        if (!this.selfUpdater) return { state: 'unavailable', message: 'Updating from GitHub works in the installed server app.', hasToken: !!token };
        return token ? this.selfUpdater.check() : (this.selfUpdater.set('no-token', 'Connect this server to GitHub to check for new versions.'), this.selfUpdater.status());       // checking right away tells them whether the token works
      },
    };
  }

  /** The main computer's address changed (router reboot, new lease)? Find it again by its ID and carry on. */
  async relocateIfLost() {
    const a = this.agent;
    if (!a || this.cfg.role !== 'client' || !a.offlineSince || Date.now() - a.offlineSince < RELOCATE_AFTER_MS || this.relocating) return;
    this.relocating = true;
    try {
      const found = await this.discover();
      const same = found.find(h => (this.cfg.host_id && h.id === this.cfg.host_id));
      if (!same) return;
      // only follow it if what answers there still presents the certificate this computer pinned when it joined
      const check = await this.probe(same.address);
      if (!check || !check.pem || check.fp !== fingerprintOfPem(this.cfg.host_cert)) { log(`not following ${same.address}: certificate differs`); return; }
      const url = `https://${same.address}`;
      if (url === this.cfg.host_url) { a.offlineSince = 0; return; }
      log(`main computer moved ${this.cfg.host_url} -> ${url}`);
      a.stop();
      this.saveCfg({ ...this.cfg, host_url: url });
      this.agent = new Agent(this.runtimeCfg(), this.dataDir, { onReceived: this.hooks.onReceived });
      this.agent.start();
      if (this.hooks.onRelocated) this.hooks.onRelocated(url);
    } finally { this.relocating = false; }
  }

  async stopRole() {
    clearInterval(this.watchTimer); this.watchTimer = null;
    this.stopUpdater();
    this.stopSelfUpdater();
    if (this.beacon) { this.beacon.stop(); this.beacon = null; }
    if (this.server) { const s = this.server; await new Promise(r => { s.close(r); s.closeAllConnections && s.closeAllConnections(); }); }
    if (this.agent) this.agent.stop();
    this.server = this.agent = this.store = null;
    for (const t of this.jobTimers) { clearTimeout(t); clearInterval(t); }
    this.jobTimers = [];
    if (this.jobs) { this.jobs.close(); this.jobs = null; }
    if (this.roles) { this.roles.close(); this.roles = null; }
    this.tls = null;
  }

  /**
   * Backs up the jobs database every 6 hours, and once at start unless a recent backup exists (restarts must not flood the folder).
   * Backups go to `backup_dir` from the settings when it is set (ideally another disk), otherwise next to the data.
   */
  startJobBackups() {
    const jobs = this.jobs;
    if (!jobs || !jobs.ok) return;
    const run = () => { try { const n = jobs.backup(); log(`jobs backup written: ${n}`); } catch (e) { log(`jobs backup FAILED: ${e.message}`); } };
    const newest = jobs.backups()[0];
    let age = Infinity; try { if (newest) age = Date.now() - fs.statSync(newest.file).mtimeMs; } catch { /* none */ }
    const first = setTimeout(run, age > 6 * 3600 * 1000 ? 15000 : 5 * 60 * 1000);
    const every = setInterval(run, 6 * 3600 * 1000);
    first.unref && first.unref(); every.unref && every.unref();
    this.jobTimers = [first, every];
  }

  saveCfg(cfg) { this.cfg = cfg; writeJson(this.cfgPath, cfg, 0o600); }

  // ---- wizard actions
  state() {
    const s = {
      edition: this.edition, app_version: this.app.version || '', configured: this.configured, role: this.cfg.role || null, name: this.cfg.name || '', hostname: os.hostname(),
      default_port: DEFAULT_PORT, lan_ip: lanIp(), folder: this.folder, portal_url: this.portalUrl(), error: this.startError, version: VERSION,
      conflict: this.conflict,
    };
    if (this.cfg.role === 'host') {
      s.port = this.cfg.port; s.address = `${lanIp()}:${this.cfg.port}`; s.pin = prettyPin(this.getPin());
      s.devices = this.store ? Object.keys(this.store.devices).length : 0;
      s.status = this.server ? { state: 'ok', message: 'Serving files' } : { state: 'warn', message: 'Not running' };
    } else if (this.cfg.role === 'client') {
      s.host_url = this.cfg.host_url;
      s.status = this.agent ? this.agent.status : { state: 'warn', message: 'Not running', files: 0 };
      if (this.updater) s.update = this.updater.state;
    }
    return s;
  }

  /** Asks a main computer who it is, and notes the certificate it presents (nothing secret is sent). */
  async probe(addr) {
    try {
      addr = normAddr(addr);
      const res = await request('GET', `https://${addr}/api/info`, { timeout: 3000 });
      const pem = peerCertPem(res);
      const buf = await readAll(res);
      const info = JSON.parse(buf.toString('utf8'));
      if (res.statusCode !== 200 || info.app !== APP_NAME || !pem) return null;
      return { address: addr, name: info.name || addr, id: info.id, version: info.app_version || '', pem, fp: fingerprintOfPem(pem) };
    } catch { return null; }
  }

  /** Is anything listening on this port on this computer? */
  portFree(port) {
    return new Promise(resolve => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
    });
  }

  /**
   * Gets the port for this (newer) server. Free: it is ours. Held by an older Artema Portal server (one that reports no version, or a
   * lower one): ask the app to close that program and take the port. Held by an equal or newer version, or by anything else: leave it.
   */
  async tryClaim(port) {
    if (await this.portFree(port)) return true;
    const mine = this.app.version;
    if (!mine || !valid(mine) || !this.hooks.stopPortHolder) return false;
    const holder = await this.probe(`127.0.0.1:${port}`);
    if (!holder || holder.id === this.cfg.instance_id) return false;
    const older = !holder.version || (valid(holder.version) && compare(mine, holder.version) > 0);
    if (!older) return false;
    log(`port ${port} is held by an older server (${holder.version || 'no version'}), closing it`);
    if (!(await this.hooks.stopPortHolder(port))) return false;
    for (let i = 0; i < 20; i++) { if (await this.portFree(port)) return true; await sleep(250); }
    return false;
  }

  /** A main computer from before the Portal was encrypted answers on plain http: say so instead of "can't find it". */
  async isOlderMain(addr) {
    try {
      const res = await request('GET', `http://${normAddr(addr)}/api/info`, { timeout: 2500 });
      const info = JSON.parse((await readAll(res)).toString('utf8'));
      return info.app === APP_NAME;
    } catch { return false; }
  }

  /** Every Portal main computer on this network: a broadcast shout plus a sweep of the local subnet, merged. */
  async discover() {
    const [udp, tcp] = await Promise.all([probeUdp(), this.scan(DEFAULT_PORT)]);
    const seen = new Map();
    for (const h of [...udp, ...tcp]) {
      if (this.cfg.role === 'host' && h.id && h.id === this.cfg.instance_id) continue;      // that's us
      const key = h.id || h.address;
      if (!seen.has(key)) seen.set(key, h);
    }
    return [...seen.values()];
  }

  /**
   * First launch with no questions: join the Portal that's already out there, or report that we're the first.
   * A computer that has ever been set up never calls this, so a main computer that's just switched off
   * can't make everyone else crown a second one.
   */
  async autoSetup(pin) {
    if (this.configured) return { action: 'already', portal_url: this.portalUrl() };
    if (this.edition === 'server') throw new HttpError(400, "This is the server version of Artema Portal. It is the main computer and can't connect to another one.");
    const found = await this.discover();
    if (!found.length) return { action: 'none', hostname: os.hostname() };
    if (!normPin(pin)) return { action: 'needs-pin', host: found[0].name, address: found[0].address };       // the one question: the PIN on the main computer
    const base = os.hostname().replace(/[^\w .-]/g, '').slice(0, 34) || 'Computer';
    // More than one main computer can answer (an old copy, a test setup, a second office). The PIN belongs to exactly one of them,
    // and it is only ever sent as a proof bound to that machine's certificate, so offer it to each in turn.
    let failure = null;
    for (const h of found) {
      for (let n = 1; n <= 9; n++) {
        const name = n === 1 ? base : `${base}-${n}`;
        try {
          const r = await this.join(h.address, name, pin);
          return { action: 'joined', name, ...r };
        } catch (e) {
          if (/already uses that name/.test(e.message) && n < 9) continue;
          failure = (e.wrongPin ? failure && !failure.wrongPin ? failure : e : failure || e);      // a real problem outranks "wrong PIN" from the other machines
          break;
        }
      }
    }
    throw failure || new HttpError(400, 'Could not find a free name for this computer');
  }

  async scan(port) {
    const ip = lanIp();
    if (ip.startsWith('127.')) return [];
    const prefix = ip.split('.').slice(0, 3).join('.');
    const open = (a, p) => new Promise(resolve => {
      const s = net.connect({ host: a, port: p, timeout: 400 });
      s.once('connect', () => { s.destroy(); resolve(`${a}:${p}`); });
      s.once('timeout', () => { s.destroy(); resolve(null); });
      s.once('error', () => resolve(null));
    });
    const hits = [];
    const targets = [];
    for (let p = port; p < port + 3; p++) for (let i = 1; i <= 254; i++) targets.push([`${prefix}.${i}`, p]);
    for (let i = 0; i < targets.length; i += 96) hits.push(...(await Promise.all(targets.slice(i, i + 96).map(([a, p]) => open(a, p)))).filter(Boolean));
    return (await Promise.all(hits.map(h => this.probe(h)))).filter(Boolean);
  }

  async setupHost(name, port, auto = false) {
    if (this.edition === 'client') throw new HttpError(400, "This version of Artema Portal can't be the main computer. Install the server version on the main computer.");
    name = cleanName(name, 41);
    if (!name || name.length > 40) throw new HttpError(400, 'Give this computer a name');
    if (!(port >= 1024 && port <= 65535)) throw new HttpError(400, 'Pick a port between 1024 and 65535');
    await this.stopRole();
    if (auto && this.edition === 'server' && port === DEFAULT_PORT) await this.tryClaim(port);
    const first = port, tries = auto ? 10 : 1;          // automatic setup walks up to the next free port instead of failing
    for (let i = 0; i < tries; i++) {
      port = first + i;
      this.saveCfg({ role: 'host', name, port, folder: path.join(this.desktopDir, APP_NAME) });
      await this.startRole();
      if (!this.startError || !/already in use/.test(this.startError)) break;
    }
    if (this.startError) {
      const err = this.startError;
      this.cfg = {}; try { fs.unlinkSync(this.cfgPath); } catch { /* none yet */ }
      throw new HttpError(400, err);
    }
    const firewall = this.hooks.openFirewall ? await this.hooks.openFirewall(port) : true;
    if (this.hooks.afterSetup) this.hooks.afterSetup();
    return { ok: true, address: `${lanIp()}:${port}`, pin: prettyPin(this.getPin()), firewall, portal_url: this.portalUrl() };
  }

  async join(addr, name, pin) {
    if (this.edition === 'server') throw new HttpError(400, "This is the server version of Artema Portal. It is the main computer and can't connect to another one.");
    name = cleanName(name, 41);
    if (!name || name.length > 40) throw new HttpError(400, 'Give this computer a name');
    if (!normPin(pin)) throw new HttpError(400, 'Enter the PIN shown on the main computer');
    let host, url, reg;
    // A main computer that restarts with a new certificate between our look at it and the PIN step is retried once: the proof is
    // bound to whichever certificate we saw last, so a second look is as safe as the first.
    for (let attempt = 1; ; attempt++) {
      host = await this.probe(addr);
      if (!host) {
        if (await this.isOlderMain(addr)) throw new HttpError(400, 'That main computer is running an older version of Artema Portal. Update it first.');
        throw new HttpError(400, "Couldn't find the main computer at that address");
      }
      url = `https://${host.address}`;
      const oldId = this.cfg.host_id && host.id && this.cfg.host_id === host.id ? this.cfg.device_id : undefined;
      try {
        // The proof is bound to the certificate we just saw, and the request only goes through if it is still that same certificate.
        reg = await jsonRequest('POST', url + '/api/register', {
          headers: { 'Content-Type': 'application/json', 'X-Device': encodeURIComponent(name) },
          body: Buffer.from(JSON.stringify({ name, id: oldId, tag: guessTag(name), proof: joinProof(pin, host.fp) })), timeout: 8000, ca: host.pem,
        });
        break;
      } catch (e) {
        if (e.status === 409) throw new HttpError(400, 'Another computer already uses that name. Pick a different one.');
        if (e.status === 403) throw Object.assign(new HttpError(400, "That PIN isn't right. Check the PIN shown on the main computer."), { wrongPin: true });
        if (e.status === 429) throw new HttpError(400, e.message);
        if (TLS_IDENTITY_ERRORS.has(e.code)) {
          log(`join: certificate changed while connecting to ${host.address} (attempt ${attempt})`);
          if (attempt < 2) { await sleep(1500); continue; }
          throw new HttpError(400, "The main computer's security certificate keeps changing. Close and reopen Artema Portal on the main computer, then try again.");
        }
        throw new HttpError(400, 'The main computer refused the connection');
      }
    }
    await this.stopRole();
    this.saveCfg(this.withSecret({ role: 'client', name, host_url: url, host_id: host.id || '', host_cert: host.pem, device_id: reg.id, folder: path.join(this.desktopDir, APP_NAME) }, 'device_token', reg.token));
    await this.startRole();
    if (this.hooks.afterSetup) this.hooks.afterSetup();
    return { ok: true, host: host.name, portal_url: this.portalUrl() };
  }

  async reset() {
    await this.stopRole();
    this.cfg = {};
    try { fs.unlinkSync(this.cfgPath); } catch { /* already gone */ }
    try { fs.unlinkSync(path.join(this.dataDir, 'sync-state.json')); } catch { /* none */ }       // never carry old sync memory into a new setup
    if (this.hooks.afterReset) this.hooks.afterReset();
  }

  // ---- this computer's own page (setup wizard + offline screen), loopback only
  async startLocalServer(port = 0) {
    this.localServer = http.createServer(async (req, res) => {
      try {
        for (const [k, v] of Object.entries(LOCAL_HEADERS)) res.setHeader(k, v);
        guardRequest(req);
        const u = new URL(req.url, 'http://x');
        if (!u.pathname.startsWith('/api/')) return serveStatic(res, this.webDir, u.pathname, 'wizard.html');
        const ep = u.pathname.slice(5);
        if (req.method === 'GET' && ep === 'state') return sendJson(res, this.state());
        if (req.method === 'POST') {
          const b = await readBody(req);
          const plain = h => { const { pem, fp, ...rest } = h; return rest; };          // the certificate stays inside the app
          if (ep === 'probe') { const f = await this.probe(b.address); return sendJson(res, { ok: !!f, ...(f ? plain(f) : {}) }); }
          if (ep === 'scan') return sendJson(res, { found: (await this.discover()).map(plain) });
          if (ep === 'auto') return sendJson(res, await this.autoSetup(b.pin));
          if (ep === 'host') return sendJson(res, await this.setupHost(b.name, parseInt(b.port, 10) || DEFAULT_PORT, !!b.auto));
          if (ep === 'join') return sendJson(res, await this.join(b.address, b.name, b.pin));
          if (ep === 'pin/rotate') { if (this.cfg.role !== 'host') throw new HttpError(400, 'Only the main computer has a PIN'); return sendJson(res, { ok: true, pin: prettyPin(this.rotatePin()) }); }
          if (ep === 'reset') { await this.reset(); return sendJson(res, { ok: true }); }
          if (ep === 'open-folder') { if (this.hooks.openFolder) this.hooks.openFolder(this.folder); return sendJson(res, { ok: true }); }
        }
        throw new HttpError(404, 'Not found');
      } catch (e) { sendError(res, e); }
    });
    await new Promise((resolve, reject) => { this.localServer.once('error', reject); this.localServer.listen(port, '127.0.0.1', resolve); });
    this.localPort = this.localServer.address().port;
    return this.localPort;
  }

  async shutdown() {
    await this.stopRole();
    if (this.localServer) { this.localServer.closeAllConnections && this.localServer.closeAllConnections(); this.localServer.close(); }
  }
}

module.exports = { Core, DEFAULT_PORT };
