'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, BAD_CHARS, ignored, readJson, writeJson, cleanName, hide, lanIp } = require('./util');
const { newToken, hashToken, WEB_SESSION_DAYS } = require('./security');

const STARTER_FOLDERS = ['To CNC', 'From CNC', 'Drawings', 'Photos'];
const ONLINE_SECONDS = 12;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;       // Windows device names: opening one of these writes to hardware, not disk
const MAX_UPLOAD = 8 * 1024 ** 3;
const MAX_WEB_SESSIONS = 200;
const nowSec = () => Date.now() / 1000;

/** Everything the main computer knows: the folder, who added what, which PCs exist. */
class Store {
  constructor(root, hostName, dataDir, hooks = {}) {
    const fresh = !fs.existsSync(root);
    fs.mkdirSync(root, { recursive: true });
    if (fresh) for (const n of STARTER_FOLDERS) fs.mkdirSync(path.join(root, n), { recursive: true });
    this.root = root;
    this.realRoot = fs.realpathSync(root);
    this.maxUpload = hooks.maxUpload || MAX_UPLOAD;
    this.hostName = hostName;
    this.hooks = hooks;
    this.trash = path.join(root, '.trash');
    this.metaPath = path.join(dataDir, 'meta.json');
    this.devicesPath = path.join(dataDir, 'devices.json');
    this.sessionsPath = path.join(dataDir, 'sessions.json');
    this.activityPath = path.join(dataDir, 'activity.json');
    this.meta = readJson(this.metaPath, {});
    this.devices = readJson(this.devicesPath, {});
    this.activity = readJson(this.activityPath, []);
    this.sessions = readJson(this.sessionsPath, {});          // browser sign-ins: token hash -> { name, exp }
    this.seen = new Map();
    this.versions = new Map();          // which app version each computer last said it runs (in memory: it re-reports within minutes)
    this.pruneSessions();
    this.reindex();
  }

  // ---- who is allowed in
  /** token hash -> device id. Raw tokens are never stored: this file leaking does not let anyone in. */
  reindex() {
    this.byHash = new Map();
    for (const [id, d] of Object.entries(this.devices)) if (d.th) this.byHash.set(d.th, id);
  }
  pruneSessions() {
    const t = nowSec(); let changed = false;
    for (const [h, v] of Object.entries(this.sessions)) if (!v || v.exp < t) { delete this.sessions[h]; changed = true; }
    if (changed) writeJson(this.sessionsPath, this.sessions, 0o600);
  }
  /** { kind: 'device'|'web', id?, name } for a valid token, otherwise null. */
  authToken(token) {
    if (!token || typeof token !== 'string' || token.length > 200) return null;
    const h = hashToken(token);
    const id = this.byHash.get(h);
    if (id && this.devices[id]) return { kind: 'device', id, name: this.devices[id].name };
    const s = this.sessions[h];
    if (s && s.exp >= nowSec()) return { kind: 'web', name: s.name };
    return null;
  }
  createWebSession(name) {
    this.pruneSessions();
    const keys = Object.keys(this.sessions);
    if (keys.length >= MAX_WEB_SESSIONS) {
      keys.sort((a, b) => this.sessions[a].exp - this.sessions[b].exp);
      for (const k of keys.slice(0, keys.length - MAX_WEB_SESSIONS + 1)) delete this.sessions[k];
    }
    const token = newToken();
    this.sessions[hashToken(token)] = { name: cleanName(name, 40) || 'Guest', exp: nowSec() + WEB_SESSION_DAYS * 86400 };
    writeJson(this.sessionsPath, this.sessions, 0o600);
    return token;
  }
  clearWebSessions() { this.sessions = {}; writeJson(this.sessionsPath, this.sessions, 0o600); }

  // ---- paths
  safe(rel) {
    const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(p => p !== '' && p !== '.');
    for (const p of parts) {
      if (p === '..' || ignored(p) || BAD_CHARS.test(p) || /[ .]$/.test(p) || RESERVED_NAMES.test(p) || p.length > 200) throw new HttpError(400, "That name can't be used");
    }
    const full = path.join(this.root, ...parts);
    this.contain(full);
    return { full, rel: parts.join('/') };
  }

  /** A shortcut or symlink inside the shared folder must not lead the API outside it. */
  contain(full) {
    const norm = x => (process.platform === 'win32' ? x.toLowerCase() : x);
    let probe = full, real = null;
    for (;;) {
      try { real = fs.realpathSync(probe); break; } catch (e) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw new HttpError(400, "That name can't be used");
        const up = path.dirname(probe);
        if (up === probe) throw new HttpError(400, "That name can't be used");
        probe = up;
      }
    }
    const root = norm(this.realRoot), r = norm(real);
    if (r !== root && !r.startsWith(root + path.sep)) throw new HttpError(400, "That name can't be used");
  }

  // ---- reading
  item(name, rel, st) {
    const dir = st.isDirectory();
    return { name, path: rel, dir, size: dir ? 0 : st.size, mtime: Math.floor(st.mtimeMs / 1000), by: (this.meta[rel] || {}).by || '' };
  }

  list(relIn) {
    const { full, rel } = this.safe(relIn);
    let ents;
    try { ents = fs.readdirSync(full, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new HttpError(404, 'Not found'); throw e; }
    const out = [];
    for (const e of ents) {
      if (ignored(e.name)) continue;
      let st; try { st = fs.statSync(path.join(full, e.name)); } catch { continue; }
      out.push(this.item(e.name, rel ? `${rel}/${e.name}` : e.name, st));
    }
    out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
    return out;
  }

  tree() {
    // A partial listing would make every client think the missing files were deleted, so any read error fails the whole request.
    const out = {};
    let failed = null;
    const walk = (dir, prefix) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code !== 'ENOENT') failed = e; return; }
      for (const e of ents) {
        if (ignored(e.name)) continue;
        const p = prefix + e.name, full = path.join(dir, e.name);
        let st; try { st = fs.statSync(full); } catch (err) { if (err.code !== 'ENOENT') failed = err; continue; }
        if (st.isDirectory()) { out[p] = { d: true }; walk(full, p + '/'); }
        else out[p] = { d: false, s: st.size, m: Math.floor(st.mtimeMs / 1000), b: (this.meta[p] || {}).by || '' };
      }
    };
    walk(this.root, '');
    if (failed) throw new HttpError(503, 'The shared folder is temporarily unreadable');
    return out;
  }

  search(q) {
    const tokens = String(q || '').toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
    if (!tokens.length) return [];
    const hits = [];
    const walk = (dir, prefix) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (ignored(e.name)) continue;
        const rel = prefix + e.name, full = path.join(dir, e.name);
        let st; try { st = fs.statSync(full); } catch { continue; }
        const isDir = st.isDirectory();
        const name = e.name.toLowerCase(), hay = rel.toLowerCase();
        if (tokens.every(t => hay.includes(t))) {
          const score = tokens.reduce((s, t) => s + (name.includes(t) ? 3 : 0) + (name.startsWith(t) ? 2 : 0), 0) + (isDir ? 2 : 0);
          hits.push({ score, m: st.mtimeMs, item: this.item(e.name, rel, st) });
        }
        if (isDir) walk(full, rel + '/');
      }
    };
    walk(this.root, '');
    hits.sort((a, b) => b.score - a.score || b.m - a.m);
    return hits.slice(0, 80).map(h => h.item);
  }

  // ---- writing
  async putFile(relIn, stream, length, mtime, who, expect) {
    const { full, rel } = this.safe(relIn);
    if (!rel || (fs.existsSync(full) && fs.statSync(full).isDirectory())) throw new HttpError(400, "That isn't a file");
    if (length > this.maxUpload) throw new HttpError(413, 'That file is too large');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    this.contain(path.dirname(full));
    const tmp = path.join(path.dirname(full), `.artema-${crypto.randomBytes(8).toString('hex')}.part`);
    let received = 0, existed = false;
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        stream.on('data', c => { received += c.length; });
        stream.on('error', reject);
        stream.on('aborted', () => { ws.destroy(); reject(new Error('upload interrupted')); });
        ws.on('error', reject);
        ws.on('finish', resolve);
        stream.pipe(ws);
      });
      if (received !== length) throw new Error('upload interrupted');
      existed = fs.existsSync(full);
      if (expect) {          // sync agents say which version they are replacing; refuse if someone got there first
        const cur = existed ? (st => `${st.size}:${Math.floor(st.mtimeMs / 1000)}`)(fs.statSync(full)) : 'none';
        if (cur !== expect) throw new HttpError(412, 'That file changed in the meantime');
      }
      if (existed) this.toTrash(full, rel, true);
      fs.renameSync(tmp, full);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* already moved */ }
    }
    if (mtime) fs.utimesSync(full, mtime, mtime);
    this.meta[rel] = { by: who, at: nowSec() };
    writeJson(this.metaPath, this.meta);
    this.logEvent(who, existed ? 'updated' : 'added', rel);
    if (this.hooks.onIncoming && who && who !== this.hostName) this.hooks.onIncoming(who, path.basename(rel), rel);
  }

  toTrash(full, rel, copy) {
    const d = new Date(), z = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
    const dest = path.join(this.trash, stamp, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    hide(this.trash);
    if (copy) fs.copyFileSync(full, dest); else fs.renameSync(full, dest);
  }

  delete(relIn, who) {
    const { full, rel } = this.safe(relIn);
    if (!rel) throw new HttpError(400, "Can't delete the main folder");
    if (!fs.existsSync(full)) return;
    this.toTrash(full, rel, false);
    for (const k of Object.keys(this.meta)) if (k === rel || k.startsWith(rel + '/')) delete this.meta[k];
    writeJson(this.metaPath, this.meta);
    this.logEvent(who, 'deleted', rel);
  }

  mkdir(relIn, who) {
    const { full, rel } = this.safe(relIn);
    if (!rel) throw new HttpError(400, 'Give the folder a name');
    if (fs.existsSync(full)) return;
    fs.mkdirSync(full, { recursive: true });
    this.logEvent(who, 'created folder', rel);
  }

  move(srcIn, dstIn, who) {
    const a = this.safe(srcIn), b = this.safe(dstIn);
    if (!a.rel || !b.rel || !fs.existsSync(a.full)) throw new HttpError(404, 'Not found');
    if (fs.existsSync(b.full)) throw new HttpError(409, 'That already exists');
    fs.mkdirSync(path.dirname(b.full), { recursive: true });
    fs.renameSync(a.full, b.full);
    for (const k of Object.keys(this.meta)) {
      if (k === a.rel || k.startsWith(a.rel + '/')) { this.meta[b.rel + k.slice(a.rel.length)] = this.meta[k]; delete this.meta[k]; }
    }
    writeJson(this.metaPath, this.meta);
    this.logEvent(who, 'renamed', b.rel);
  }

  // ---- people and history
  logEvent(who, action, rel) {
    this.activity.push({ t: Math.floor(nowSec()), who: who || 'Someone', action, path: rel });
    if (this.activity.length > 200) this.activity.splice(0, this.activity.length - 200);
    writeJson(this.activityPath, this.activity);
  }

  setTag(id, tag) {
    if (!this.devices[id]) throw new HttpError(404, 'Not found');
    this.devices[id].tag = cleanName(tag, 20);
    writeJson(this.devicesPath, this.devices, 0o600);
  }

  /** Adds (or re-adds) a computer and gives it a fresh token. The token is returned once; only its hash is kept. */
  register(name, ip, existingId, tag) {
    name = cleanName(name, 40);
    if (!name) throw new HttpError(400, 'Pick a name between 1 and 40 characters');
    for (const [id, d] of Object.entries(this.devices)) {
      if (d.name.toLowerCase() === name.toLowerCase() && id !== existingId) throw new HttpError(409, 'Another computer already uses that name');
    }
    const id = existingId && this.devices[existingId] ? existingId : crypto.randomBytes(6).toString('hex');
    const prev = this.devices[id] || {};
    const token = newToken();
    this.devices[id] = { name, ip, added: prev.added || Math.floor(nowSec()), tag: prev.tag || cleanName(tag, 20), th: hashToken(token) };
    this.reindex();
    writeJson(this.devicesPath, this.devices, 0o600);
    this.seen.set(id, nowSec());
    return { id, token };
  }
  touch(id) { if (this.devices[id]) this.seen.set(id, nowSec()); }
  setVersion(id, v) { if (this.devices[id] && /^[0-9A-Za-z.+-]{1,40}$/.test(String(v))) this.versions.set(id, String(v)); }
  removeDevice(id) { delete this.devices[id]; this.seen.delete(id); this.reindex(); writeJson(this.devicesPath, this.devices, 0o600); }

  deviceList() {
    const out = [{ id: 'host', name: this.hostName, online: true, host: true, ip: lanIp() }];
    const t = nowSec();
    for (const [id, d] of Object.entries(this.devices)) {
      const last = this.seen.get(id);
      out.push({ id, name: d.name, ip: d.ip || '', tag: d.tag || '', version: this.versions.get(id) || '', host: false, online: !!(last && t - last < ONLINE_SECONDS), last: last ? Math.floor(last) : null });
    }
    return out;
  }
}

module.exports = { Store, STARTER_FOLDERS };
