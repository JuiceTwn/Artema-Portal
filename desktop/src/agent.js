'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ignored, readJson, writeJson, log, sleep, request, readAll, jsonRequest, TLS_IDENTITY_ERRORS } = require('./util');

const SYNC_MS = 3000;
const NET_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNABORTED', 'EPIPE']);
const depth = p => p.split('/').length;

/**
 * Keeps this computer's Artema Portal folder identical to the main computer's.
 * A path's signature is "d" for a folder or "size:mtimeSeconds" for a file. For every path we compare
 * what's here (L), what's there (R) and what we agreed on last time (B) to tell new, changed and deleted apart.
 */
class Agent {
  constructor(cfg, dataDir, hooks = {}) {
    this.cfg = cfg;                                  // host_cert (PEM, pinned) and token (already unsealed) come from the Core
    this.url = cfg.host_url.replace(/\/$/, '');
    this.ca = cfg.host_cert || null;
    this.token = cfg.token || '';
    this.folder = cfg.folder;
    this.statePath = path.join(dataDir, 'sync-state.json');
    this.hooks = hooks;
    this.stopped = false;
    this.first = true;
    this.status = { state: 'starting', message: 'Starting…', last: null, files: 0 };
  }

  headers(extra = {}) {
    return { 'X-Device': encodeURIComponent(this.cfg.name), Authorization: `Bearer ${this.token}`, ...extra };
  }
  call(p, body) {
    const has = body !== undefined;
    return jsonRequest(has ? 'POST' : 'GET', this.url + p, {
      headers: this.headers(has ? { 'Content-Type': 'application/json' } : {}), body: has ? Buffer.from(JSON.stringify(body)) : null, ca: this.ca,
    });
  }

  async download(p, sig) {
    const dest = path.join(this.folder, ...p.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = path.join(path.dirname(dest), `.artema-${crypto.randomBytes(8).toString('hex')}.part`);
    try {
      const res = await request('GET', `${this.url}/api/file?path=${encodeURIComponent(p)}`, { headers: this.headers(), timeout: 30000, ca: this.ca });
      if (res.statusCode !== 200) { res.resume(); throw Object.assign(new Error(`download ${res.statusCode}`), { status: res.statusCode }); }
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmp);
        res.on('error', reject); res.on('aborted', () => reject(new Error('download interrupted')));
        ws.on('error', reject); ws.on('finish', resolve);
        res.pipe(ws);
      });
      fs.renameSync(tmp, dest);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* moved or never created */ }
    }
    const mt = parseInt(sig.split(':')[1], 10);
    fs.utimesSync(dest, mt, mt);
    const st = fs.statSync(dest);
    return `${st.size}:${Math.floor(st.mtimeMs / 1000)}`;
  }

  async upload(p, sig, expect) {
    const [size, mtime] = sig.split(':');
    const src = path.join(this.folder, ...p.split('/'));
    const res = await request('PUT', `${this.url}/api/file?path=${encodeURIComponent(p)}&mtime=${mtime}`, {
      headers: this.headers({ 'Content-Length': size, 'Content-Type': 'application/octet-stream', 'X-Expect': expect || 'none' }),
      body: fs.createReadStream(src), timeout: 60000, ca: this.ca,
    });
    await readAll(res);
    if (res.statusCode >= 300) throw Object.assign(new Error(`upload ${res.statusCode}`), { status: res.statusCode });
  }

  /**
   * What's on disk right now. Anything we couldn't read (antivirus lock, permissions, a file vanishing mid-scan)
   * is reported as "unknown", never as "missing", so a hiccup can't look like the user deleting files.
   */
  scanLocal() {
    const out = {}, unstable = new Set(), blocked = [], now = Date.now();
    const walk = (dir, prefix) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { blocked.push(prefix.replace(/\/$/, '')); return; }
      for (const e of ents) {
        if (ignored(e.name)) continue;
        const p = prefix + e.name, full = path.join(dir, e.name);
        let st; try { st = fs.statSync(full); } catch { unstable.add(p); continue; }
        if (st.isDirectory()) { out[p] = 'd'; walk(full, p + '/'); continue; }
        out[p] = `${st.size}:${Math.floor(st.mtimeMs / 1000)}`;
        if (now - st.mtimeMs < 2000) unstable.add(p);      // still being copied in: leave it alone this round
      }
    };
    walk(this.folder, '');
    if (blocked.includes('')) throw Object.assign(new Error('sync folder unreadable'), { code: 'FOLDER_UNREADABLE' });
    return { local: out, unstable, blocked };
  }

  async sync(base) {
    if (!fs.existsSync(this.folder)) {
      fs.mkdirSync(this.folder, { recursive: true });
      for (const k of Object.keys(base)) delete base[k];       // folder was removed: restore from the main computer
    }
    // Make sure the thing at this address is still OUR main computer before trusting anything it says about deletions.
    const info = await this.call('/api/info');
    if (this.cfg.host_id && info.id && info.id !== this.cfg.host_id) throw Object.assign(new Error('different main computer'), { code: 'WRONG_HOST' });
    const tree = (await this.call('/api/tree')).items;
    const remote = {}, authors = {};
    for (const [p, v] of Object.entries(tree)) { remote[p] = v.d ? 'd' : `${v.s}:${v.m}`; authors[p] = v.b || ''; }
    const { local, unstable, blocked } = this.scanLocal();
    const isBlocked = p => blocked.some(b => p === b || p.startsWith(b + '/'));

    const plan = { mkUp: [], mkDown: [], up: [], down: [], ldel: [], rdel: [], conflict: [] };
    const all = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
    for (const p of all) {
      if (unstable.has(p) || isBlocked(p)) continue;
      const L = local[p], R = remote[p], B = base[p];
      if (L === R) { if (L === undefined) delete base[p]; else base[p] = L; continue; }
      if ((L === 'd' || R === 'd') && L !== undefined && R !== undefined) continue;     // file vs folder clash: leave for a human
      let what;
      if (B === undefined) what = R === undefined ? 'up' : L === undefined ? 'down' : 'conflict';
      else if (L === B) what = R === undefined ? 'ldel' : 'down';
      else if (R === B) what = L === undefined ? 'rdel' : 'up';
      else what = L === undefined ? 'down' : R === undefined ? 'up' : 'conflict';
      if (what === 'up' && L === 'd') what = 'mkUp';
      if (what === 'down' && R === 'd') what = 'mkDown';
      plan[what].push(p);
    }

    // Safety net: a sudden wave of deletions is almost always a mistake (wiped folder, drive hiccup). Restore instead.
    const known = Math.max(Object.keys(base).length, 1);
    // (folders must be restored as folders, not transferred as if they were files)
    if (plan.rdel.length >= 8 && plan.rdel.length > known / 2) {
      for (const p of plan.rdel) plan[remote[p] === 'd' ? 'mkDown' : 'down'].push(p);
      plan.rdel = [];
    }
    if (plan.ldel.length >= 8 && plan.ldel.length > known / 2) {
      for (const p of plan.ldel) plan[local[p] === 'd' ? 'mkUp' : 'up'].push(p);
      plan.ldel = [];
    }

    let errors = 0;
    const received = [];
    const attempt = async fn => {
      try { await fn(); } catch (e) {
        if (NET_ERRORS.has(e.code) || TLS_IDENTITY_ERRORS.has(e.code) || e.status === 401) throw e;     // connection dropped, wrong certificate or access withdrawn: stop and report
        errors++; log(`sync error: ${e && e.message || e}`);
      }
    };

    for (const p of plan.mkUp.sort((a, b) => depth(a) - depth(b))) await attempt(async () => { await this.call('/api/mkdir', { path: p }); base[p] = 'd'; });
    for (const p of plan.mkDown.sort((a, b) => depth(a) - depth(b))) await attempt(async () => { fs.mkdirSync(path.join(this.folder, ...p.split('/')), { recursive: true }); base[p] = 'd'; });
    for (const p of plan.down) {
      await attempt(async () => {
        const isNew = base[p] === undefined && local[p] === undefined;
        base[p] = await this.download(p, remote[p]);
        if (isNew && authors[p] && authors[p] !== this.cfg.name) received.push({ name: p.split('/').pop(), by: authors[p], path: p });
      });
    }
    for (const p of plan.conflict) {
      await attempt(async () => {
        const src = path.join(this.folder, ...p.split('/'));
        const ext = path.extname(src), stem = src.slice(0, src.length - ext.length);
        let n = 1, copy = `${stem} (conflict ${this.cfg.name})${ext}`;
        while (fs.existsSync(copy)) copy = `${stem} (conflict ${this.cfg.name} ${++n})${ext}`;
        fs.renameSync(src, copy);
        base[p] = await this.download(p, remote[p]);
      });
    }
    for (const p of plan.up) {
      await attempt(async () => {
        try { await this.upload(p, local[p], remote[p]); base[p] = local[p]; }
        catch (e) { if (e.status === 412) return; throw e; }        // someone else changed it first: next round sees a conflict and keeps both
      });
    }
    for (const p of plan.ldel.sort((a, b) => depth(b) - depth(a))) {
      await attempt(async () => {
        const t = path.join(this.folder, ...p.split('/'));
        if (local[p] === 'd') fs.rmdirSync(t); else fs.unlinkSync(t);
        delete base[p];
      });
    }
    for (const p of plan.rdel.sort((a, b) => depth(b) - depth(a))) {
      await attempt(async () => {
        try { await this.call('/api/delete', { path: p }); } catch (e) { if (e.status !== 404) throw e; }
        delete base[p];
      });
    }

    writeJson(this.statePath, { base, key: this.hostKey() });
    this.status.files = Object.values(remote).filter(v => v !== 'd').length;
    if (!this.first && received.length && this.hooks.onReceived) this.hooks.onReceived(received);
    this.first = false;
    return errors;
  }

  /** Who this sync memory belongs to. Memory from a different main computer is never trusted (it would read as mass deletion). */
  hostKey() { return this.cfg.host_id || this.cfg.host_url; }

  start() {
    this.stopped = false;
    const saved = readJson(this.statePath, {});
    const base = saved.key === this.hostKey() ? (saved.base || {}) : {};
    const loop = async () => {
      while (!this.stopped) {
        let pause = 0;
        try {
          const errs = await this.sync(base);
          this.offlineSince = 0;
          if (errs) Object.assign(this.status, { state: 'warn', message: `${errs} file(s) couldn't sync yet` });
          else Object.assign(this.status, { state: 'ok', message: 'Up to date', last: Math.floor(Date.now() / 1000) });
        } catch (e) {
          if (e.status === 401) {
            pause = 15000;
            Object.assign(this.status, { state: 'warn', message: 'The main computer no longer lets this computer in. Reconnect it from Setup and status.' });
          } else if (TLS_IDENTITY_ERRORS.has(e.code) || e.code === 'CERT_MISMATCH') {
            this.offlineSince = this.offlineSince || Date.now();
            log(`certificate check failed (${e.code}) for ${this.url}`);
            Object.assign(this.status, { state: 'offline', message: "Stopped: the main computer's security certificate isn't the one this computer trusts" });
          } else if (NET_ERRORS.has(e.code) || e.message === 'timeout' || e.code === 'WRONG_HOST') {
            this.offlineSince = this.offlineSince || Date.now();
            Object.assign(this.status, { state: 'offline', message: e.code === 'WRONG_HOST' ? "That isn't the main computer any more" : "Can't reach the main computer" });
          } else if (e.code === 'FOLDER_UNREADABLE') {
            Object.assign(this.status, { state: 'warn', message: "Can't read the Artema Portal folder right now" });
          } else { log('agent error: ' + (e && e.stack || e)); Object.assign(this.status, { state: 'warn', message: 'Something went wrong. Retrying…' }); }
        }
        if (pause) await sleep(pause);
        await sleep(SYNC_MS);
      }
    };
    loop();
  }
  stop() { this.stopped = true; }
}

module.exports = { Agent };
