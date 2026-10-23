'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const {
  APP_NAME, VERSION, HttpError, readJson, writeJson, cleanName, lanIp, request, readAll, peerCertPem, TLS_IDENTITY_ERRORS,
  jsonRequest, sendJson, readBody, serveStatic, sendError, guardRequest, log,
} = require('./util');
const {
  genPin, normPin, prettyPin, joinProof, fingerprintOfPem, loadOrCreateCert, COOKIE, LOCAL_HEADERS,
} = require('./security');
const { Store } = require('./store');
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
  constructor({ dataDir, webDir, desktopDir, hooks = {} }) {
    this.dataDir = dataDir;
    this.webDir = webDir;
    this.desktopDir = desktopDir;
    this.hooks = hooks;
    this.cfgPath = path.join(dataDir, 'config.json');
    this.cfg = readJson(this.cfgPath, {});
    this.store = null; this.server = null; this.agent = null;
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
  async startRole() {
    this.startError = '';
    try {
      if (this.cfg.role === 'host') {
        if (!this.cfg.instance_id) this.saveCfg({ ...this.cfg, instance_id: crypto.randomBytes(8).toString('hex') });
        this.store = new Store(this.cfg.folder, this.cfg.name, this.dataDir, { onIncoming: this.hooks.onIncoming });
        this.store.instanceId = this.cfg.instance_id;
        if (!this.getPin()) this.saveCfg(this.withSecret(this.cfg, 'join_pin', genPin()));
        this.tls = await loadOrCreateCert(path.join(this.dataDir, 'tls'), { seal: t => this.seal(t), unseal: t => this.unseal(t), hostnames: [os.hostname()], ips: [lanIp()] });
        const port = parseInt(this.cfg.port, 10);
        this.server = createPortalServer(this.store, port, this.webDir, {
          reveal: this.hooks.reveal, tls: this.tls, getPin: () => this.getPin(), rotatePin: () => this.rotatePin(), trustLoopback: () => this.trustLoopback,
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
      }
    } catch (e) {
      this.startError = e.code === 'EADDRINUSE' ? 'That port is already in use. Try another one.' : String(e.message || e);
      this.server = null;
      log(`start failed: ${e && e.stack || e}`);
    }
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
    if (this.beacon) { this.beacon.stop(); this.beacon = null; }
    if (this.server) { const s = this.server; await new Promise(r => { s.close(r); s.closeAllConnections && s.closeAllConnections(); }); }
    if (this.agent) this.agent.stop();
    this.server = this.agent = this.store = null;
    this.tls = null;
  }

  saveCfg(cfg) { this.cfg = cfg; writeJson(this.cfgPath, cfg, 0o600); }

  // ---- wizard actions
  state() {
    const s = {
      configured: this.configured, role: this.cfg.role || null, name: this.cfg.name || '', hostname: os.hostname(),
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
      return { address: addr, name: info.name || addr, id: info.id, pem, fp: fingerprintOfPem(pem) };
    } catch { return null; }
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
    const found = await this.discover();
    if (!found.length) return { action: 'none', hostname: os.hostname() };
    if (!normPin(pin)) return { action: 'needs-pin', host: found[0].name, address: found[0].address };       // the one question: the PIN on the main computer
    const base = os.hostname().replace(/[^\w .-]/g, '').slice(0, 34) || 'Computer';
    for (let n = 1; n <= 9; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      try {
        const r = await this.join(found[0].address, name, pin);
        return { action: 'joined', name, ...r };
      } catch (e) {
        if (!/already uses that name/.test(e.message)) throw e;
      }
    }
    throw new HttpError(400, 'Could not find a free name for this computer');
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
    name = cleanName(name, 41);
    if (!name || name.length > 40) throw new HttpError(400, 'Give this computer a name');
    if (!(port >= 1024 && port <= 65535)) throw new HttpError(400, 'Pick a port between 1024 and 65535');
    await this.stopRole();
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
    name = cleanName(name, 41);
    if (!name || name.length > 40) throw new HttpError(400, 'Give this computer a name');
    if (!normPin(pin)) throw new HttpError(400, 'Enter the PIN shown on the main computer');
    const host = await this.probe(addr);
    if (!host) {
      if (await this.isOlderMain(addr)) throw new HttpError(400, 'That main computer is running an older version of Artema Portal. Update it first.');
      throw new HttpError(400, "Couldn't find the main computer at that address");
    }
    const url = `https://${host.address}`;
    const oldId = this.cfg.host_id && host.id && this.cfg.host_id === host.id ? this.cfg.device_id : undefined;
    let reg;
    try {
      // The proof is bound to the certificate we just saw, and the request only goes through if it is still that same certificate.
      reg = await jsonRequest('POST', url + '/api/register', {
        headers: { 'Content-Type': 'application/json', 'X-Device': encodeURIComponent(name) },
        body: Buffer.from(JSON.stringify({ name, id: oldId, tag: guessTag(name), proof: joinProof(pin, host.fp) })), timeout: 8000, ca: host.pem,
      });
    } catch (e) {
      if (e.status === 409) throw new HttpError(400, 'Another computer already uses that name. Pick a different one.');
      if (e.status === 403) throw new HttpError(400, "That PIN isn't right. Check the PIN shown on the main computer.");
      if (e.status === 429) throw new HttpError(400, e.message);
      if (TLS_IDENTITY_ERRORS.has(e.code)) throw new HttpError(400, "The main computer's security certificate changed while connecting. Try again.");
      throw new HttpError(400, 'The main computer refused the connection');
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
