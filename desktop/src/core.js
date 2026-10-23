'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const {
  APP_NAME, VERSION, HttpError, readJson, writeJson, lanIp, jsonRequest, sendJson, readBody, serveStatic, sendError, guardRequest, log,
} = require('./util');
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
  }

  get configured() { return this.cfg.role === 'host' || this.cfg.role === 'client'; }
  get folder() { return this.cfg.folder || path.join(this.desktopDir, APP_NAME); }

  portalUrl() {
    if (this.cfg.role === 'host') return `http://localhost:${this.cfg.port}/`;
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
        const port = parseInt(this.cfg.port, 10);
        this.server = createPortalServer(this.store, port, this.webDir, { reveal: this.hooks.reveal });
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
        this.agent = new Agent(this.cfg, this.dataDir, { onReceived: this.hooks.onReceived });
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
      const url = `http://${same.address}`;
      if (url === this.cfg.host_url) { a.offlineSince = 0; return; }
      log(`main computer moved ${this.cfg.host_url} -> ${url}`);
      a.stop();
      this.saveCfg({ ...this.cfg, host_url: url });
      this.agent = new Agent(this.cfg, this.dataDir, { onReceived: this.hooks.onReceived });
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
  }

  saveCfg(cfg) { this.cfg = cfg; writeJson(this.cfgPath, cfg); }

  // ---- wizard actions
  state() {
    const s = {
      configured: this.configured, role: this.cfg.role || null, name: this.cfg.name || '', hostname: os.hostname(),
      default_port: DEFAULT_PORT, lan_ip: lanIp(), folder: this.folder, portal_url: this.portalUrl(), error: this.startError, version: VERSION,
      conflict: this.conflict,
    };
    if (this.cfg.role === 'host') {
      s.port = this.cfg.port; s.address = `${lanIp()}:${this.cfg.port}`;
      s.devices = this.store ? Object.keys(this.store.devices).length : 0;
      s.status = this.server ? { state: 'ok', message: 'Serving files' } : { state: 'warn', message: 'Not running' };
    } else if (this.cfg.role === 'client') {
      s.host_url = this.cfg.host_url;
      s.status = this.agent ? this.agent.status : { state: 'warn', message: 'Not running', files: 0 };
    }
    return s;
  }

  async probe(addr) {
    try {
      addr = normAddr(addr);
      const info = await jsonRequest('GET', `http://${addr}/api/info`, { timeout: 3000 });
      return info.app === APP_NAME ? { address: addr, name: info.name || addr, id: info.id } : null;
    } catch { return null; }
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
  async autoSetup() {
    if (this.configured) return { action: 'already', portal_url: this.portalUrl() };
    const found = await this.discover();
    if (!found.length) return { action: 'none', hostname: os.hostname() };
    const base = os.hostname().replace(/[^\w .-]/g, '').slice(0, 34) || 'Computer';
    for (let n = 1; n <= 9; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      try {
        const r = await this.join(found[0].address, name);
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
    name = String(name || '').trim();
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
    return { ok: true, address: `${lanIp()}:${port}`, firewall, portal_url: this.portalUrl() };
  }

  async join(addr, name) {
    name = String(name || '').trim();
    if (!name || name.length > 40) throw new HttpError(400, 'Give this computer a name');
    const host = await this.probe(addr);
    if (!host) throw new HttpError(400, "Couldn't find the main computer at that address");
    const url = `http://${host.address}`;
    const oldId = this.cfg.host_url === url ? this.cfg.device_id : undefined;
    let reg;
    try {
      reg = await jsonRequest('POST', url + '/api/register', { headers: { 'Content-Type': 'application/json', 'X-Device': encodeURIComponent(name) }, body: Buffer.from(JSON.stringify({ name, id: oldId, tag: guessTag(name) })), timeout: 8000 });
    } catch (e) {
      throw new HttpError(400, e.status === 409 ? 'Another computer already uses that name. Pick a different one.' : 'The main computer refused the connection');
    }
    await this.stopRole();
    this.saveCfg({ role: 'client', name, host_url: url, host_id: host.id || '', device_id: reg.id, folder: path.join(this.desktopDir, APP_NAME) });
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
        guardRequest(req);
        const u = new URL(req.url, 'http://x');
        if (!u.pathname.startsWith('/api/')) return serveStatic(res, this.webDir, u.pathname, 'wizard.html');
        const ep = u.pathname.slice(5);
        if (req.method === 'GET' && ep === 'state') return sendJson(res, this.state());
        if (req.method === 'POST') {
          const b = await readBody(req);
          if (ep === 'probe') { const f = await this.probe(b.address); return sendJson(res, { ok: !!f, ...(f || {}) }); }
          if (ep === 'scan') return sendJson(res, { found: await this.discover() });
          if (ep === 'auto') return sendJson(res, await this.autoSetup());
          if (ep === 'host') return sendJson(res, await this.setupHost(b.name, parseInt(b.port, 10) || DEFAULT_PORT, !!b.auto));
          if (ep === 'join') return sendJson(res, await this.join(b.address, b.name));
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
