'use strict';
/**
 * Updates that travel with the server.
 *
 * The server build carries a copy of the client app (`update/app`) and a manifest listing every file with its size and SHA-256.
 * Installing a new server is therefore the only step: each client asks the server what version it has, fetches only the files that
 * differ, checks every one against the manifest, builds the complete new app next to the old one, and hands over to the restart helper.
 *
 * Trust: the files only ever come over the connection pinned to the main computer when this computer joined (see util.request), and a
 * computer can only be sent the client app of a newer version built for the same Electron. Nothing is ever deleted or written outside
 * the app's own folder.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { compare, valid } = require('./version');
const { log } = require('./util');

const MAX_FILES = 20000, MAX_TOTAL = 2 * 1024 ** 3;

/** A path inside the app, written with `/`: no way out of the folder, no drive letters, nothing odd for Windows. */
function safeRel(p) {
  if (typeof p !== 'string' || !p || p.length > 300 || p.startsWith('/')) return false;
  if (/[\\:*?"<>|\u0000-\u001f]/.test(p)) return false;
  return p.split('/').every(s => s && !/^\.+$/.test(s) && !/\s$/.test(s));
}
const toFull = (root, rel) => path.join(root, ...rel.split('/'));

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

function listFiles(root, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) throw new Error(`links are not allowed in an update: ${r}`);
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Describes an app folder: every file with its size and SHA-256. Used when the server build is made. */
async function buildManifest(appDir, { version, edition = 'client', electron }) {
  const files = [];
  for (const rel of listFiles(appDir).sort()) {
    const full = toFull(appDir, rel);
    files.push({ path: rel, size: fs.statSync(full).size, sha256: await sha256File(full) });
  }
  return { format: 1, version, edition, electron, created: new Date().toISOString(), files };
}

/** '' when the manifest is usable, otherwise why not. Everything in it is untrusted until it passes. */
function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'not a manifest';
  if (m.format !== 1) return 'unknown format';
  if (!valid(m.version)) return 'bad version';
  if (m.edition !== 'client') return 'not a client update';
  if (typeof m.electron !== 'string' || !m.electron) return 'no Electron version';
  if (!Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) return 'bad file list';
  const seen = new Set(); let total = 0;
  for (const f of m.files) {
    if (!f || !safeRel(f.path)) return `unsafe path ${JSON.stringify(f && f.path)}`;
    if (!Number.isInteger(f.size) || f.size < 0) return `bad size for ${f.path}`;
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256)) return `bad checksum for ${f.path}`;
    const k = f.path.toLowerCase();
    if (seen.has(k)) return `duplicate ${f.path}`;
    seen.add(k); total += f.size;
  }
  if (total > MAX_TOTAL) return 'too large';
  if (!seen.has('package.json') || !seen.has('main.js')) return 'incomplete app';
  return '';
}
const manifestHash = m => crypto.createHash('sha256').update(JSON.stringify(m.files.map(f => [f.path, f.size, f.sha256]))).digest('hex');

/** The server's side: serves the client app it was built with. Only files named in a valid manifest can ever be read. */
class UpdateSource {
  constructor(dir) { this.dir = dir; this.cache = null; }
  manifest() {
    try {
      const file = path.join(this.dir, 'manifest.json'), mt = fs.statSync(file).mtimeMs;
      if (this.cache && this.cache.mt === mt) return this.cache.m;
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      const bad = validateManifest(m);
      if (bad) { log(`update manifest ignored: ${bad}`); this.cache = { mt, m: null, index: new Map() }; return null; }
      this.cache = { mt, m, index: new Map(m.files.map(f => [f.path, f])) };
      return m;
    } catch { return null; }
  }
  file(rel) {
    if (!this.manifest()) return null;
    const entry = this.cache.index.get(rel);
    return entry ? { full: toFull(path.join(this.dir, 'app'), rel), size: entry.size } : null;
  }
}

/** A client's side: finds out whether the main computer carries a newer client, and stages it completely before anything changes. */
class UpdateClient {
  /** api: { json(pathAndQuery) -> object (throws with .status), file(rel) -> http response } */
  constructor({ appDir, version, electron, api, onChange }) {
    this.appDir = appDir; this.version = version; this.electron = electron; this.api = api; this.onChange = onChange || (() => { });
    this.stageDir = appDir + '.update';
    this.markerPath = appDir + '.update.json';
    this.state = { state: 'idle', version: '', message: '' };
    this.busy = false;
  }
  set(state, message = '', version = '') { this.state = { state, version, message }; try { this.onChange(this.state); } catch { /* a listener must not break updating */ } }

  readMarker() { try { return JSON.parse(fs.readFileSync(this.markerPath, 'utf8')); } catch { return null; } }
  clearStage() {
    try { fs.rmSync(this.stageDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(this.markerPath, { force: true }); } catch { /* none */ }
  }
  /** What the restart helper needs, only when a complete update is waiting. */
  ready() {
    const mk = this.readMarker();
    return this.state.state === 'ready' && mk && fs.existsSync(this.stageDir) ? { stageDir: this.stageDir, appDir: this.appDir, version: mk.version } : null;
  }

  async check() {
    if (this.busy) return this.state;
    this.busy = true;
    try {
      this.set('checking');
      let m;
      try { m = await this.api.json('/api/update/manifest?v=' + encodeURIComponent(this.version)); } catch (e) {
        if (e.status === 404) { this.set('none'); return this.state; }
        throw e;
      }
      const bad = validateManifest(m);
      if (bad) { log(`update ignored: ${bad}`); this.set('none'); return this.state; }
      if (compare(m.version, this.version) <= 0) { if (this.readMarker()) this.clearStage(); this.set('none'); return this.state; }      // never downgrade, never reinstall the same version
      if (m.electron !== this.electron) {
        log(`update ${m.version} needs Electron ${m.electron} (this is ${this.electron}): needs a full reinstall`);
        this.set('blocked', `Version ${m.version} needs a full reinstall from the server's zip.`, m.version);
        return this.state;
      }
      const mk = this.readMarker();
      if (mk && mk.version === m.version && mk.hash === manifestHash(m) && fs.existsSync(this.stageDir)) { this.set('ready', '', m.version); return this.state; }
      await this.stage(m);
    } catch (e) {
      // offline, or the server restarted: not worth alarming anyone. Try again next time.
      if (this.state.state !== 'error') this.set('none');
      log(`update check failed: ${e.code || e.message}`);
    } finally { this.busy = false; }
    return this.state;
  }

  async stage(m) {
    this.clearStage();
    fs.mkdirSync(this.stageDir, { recursive: true });
    let fetched = 0, reused = 0;
    try {
      this.set('downloading', `Getting version ${m.version}…`, m.version);
      for (const f of m.files) {
        const dest = toFull(this.stageDir, f.path), local = toFull(this.appDir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (await this.sameAsLocal(local, f)) { fs.copyFileSync(local, dest); reused++; continue; }
        await this.download(f, dest); fetched++;
      }
      fs.writeFileSync(this.markerPath, JSON.stringify({ version: m.version, hash: manifestHash(m), files: m.files.length, at: Date.now() }));
      log(`update ${m.version} staged (${fetched} files downloaded, ${reused} already here)`);
      this.set('ready', '', m.version);
    } catch (e) {
      this.clearStage();
      log(`update ${m.version} failed: ${e.message}`);
      this.set('error', 'The update could not be downloaded. It will try again.', m.version);
    }
  }

  async sameAsLocal(local, f) {
    try { return fs.statSync(local).size === f.size && (await sha256File(local)) === f.sha256; } catch { return false; }
  }

  async download(f, dest) {
    const res = await this.api.file(f.path);
    if (res.statusCode !== 200) { res.resume(); throw new Error(`${f.path}: server said ${res.statusCode}`); }
    const part = dest + '.part', hash = crypto.createHash('sha256');
    let size = 0;
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(part);
        res.on('data', c => { size += c.length; hash.update(c); });
        res.on('error', reject); res.on('aborted', () => reject(new Error('download interrupted')));
        ws.on('error', reject); ws.on('finish', resolve);
        res.pipe(ws);
      });
      if (size !== f.size || hash.digest('hex') !== f.sha256) throw new Error(`${f.path} failed its check`);
      fs.renameSync(part, dest);
    } finally { try { fs.rmSync(part, { force: true }); } catch { /* moved or never created */ } }
  }
}

module.exports = { safeRel, sha256File, buildManifest, validateManifest, manifestHash, UpdateSource, UpdateClient };
