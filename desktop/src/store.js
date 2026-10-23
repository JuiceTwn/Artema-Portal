'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError, BAD_CHARS, ignored, readJson, writeJson, hide, lanIp } = require('./util');

const STARTER_FOLDERS = ['To CNC', 'From CNC', 'Drawings', 'Photos'];
const ONLINE_SECONDS = 12;
const nowSec = () => Date.now() / 1000;

/** Everything the main computer knows: the folder, who added what, which PCs exist. */
class Store {
  constructor(root, hostName, dataDir, hooks = {}) {
    const fresh = !fs.existsSync(root);
    fs.mkdirSync(root, { recursive: true });
    if (fresh) for (const n of STARTER_FOLDERS) fs.mkdirSync(path.join(root, n), { recursive: true });
    this.root = root;
    this.hostName = hostName;
    this.hooks = hooks;
    this.trash = path.join(root, '.trash');
    this.metaPath = path.join(dataDir, 'meta.json');
    this.devicesPath = path.join(dataDir, 'devices.json');
    this.activityPath = path.join(dataDir, 'activity.json');
    this.meta = readJson(this.metaPath, {});
    this.devices = readJson(this.devicesPath, {});
    this.activity = readJson(this.activityPath, []);
    this.seen = new Map();
  }

  // ---- paths
  safe(rel) {
    const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(p => p !== '' && p !== '.');
    for (const p of parts) {
      if (p === '..' || ignored(p) || BAD_CHARS.test(p) || /[ .]$/.test(p)) throw new HttpError(400, "That name can't be used");
    }
    return { full: path.join(this.root, ...parts), rel: parts.join('/') };
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
    fs.mkdirSync(path.dirname(full), { recursive: true });
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
    this.devices[id].tag = String(tag || '').trim().slice(0, 20);
    writeJson(this.devicesPath, this.devices);
  }

  register(name, ip, existingId, tag) {
    name = String(name || '').trim();
    if (!name || name.length > 40) throw new HttpError(400, 'Pick a name between 1 and 40 characters');
    for (const [id, d] of Object.entries(this.devices)) {
      if (d.name.toLowerCase() === name.toLowerCase() && id !== existingId) throw new HttpError(409, 'Another computer already uses that name');
    }
    const id = existingId && this.devices[existingId] ? existingId : crypto.randomBytes(6).toString('hex');
    const prev = this.devices[id] || {};
    this.devices[id] = { name, ip, added: prev.added || Math.floor(nowSec()), tag: prev.tag || String(tag || '').trim().slice(0, 20) };
    writeJson(this.devicesPath, this.devices);
    this.seen.set(id, nowSec());
    return id;
  }
  touch(id) { if (this.devices[id]) this.seen.set(id, nowSec()); }
  removeDevice(id) { delete this.devices[id]; this.seen.delete(id); writeJson(this.devicesPath, this.devices); }

  deviceList() {
    const out = [{ id: 'host', name: this.hostName, online: true, host: true, ip: lanIp() }];
    const t = nowSec();
    for (const [id, d] of Object.entries(this.devices)) {
      const last = this.seen.get(id);
      out.push({ id, name: d.name, ip: d.ip || '', tag: d.tag || '', host: false, online: !!(last && t - last < ONLINE_SECONDS), last: last ? Math.floor(last) : null });
    }
    return out;
  }
}

module.exports = { Store, STARTER_FOLDERS };
