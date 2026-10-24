'use strict';
/**
 * The server updating itself from the newest release in the private GitHub repository.
 *
 * A release carries the server build (`Artema-Portal-Server-<version>-win.zip`, which already holds the client app that connected
 * computers update from) and its checksum (`<same name>.sha256`). The server finds the newest release, downloads the zip, checks it
 * against the checksum, unpacks it next to the running app and checks that it is the server build of the version the release
 * claims, built for the same Electron. Only then is it handed to the restart helper (update-helper.js), which swaps in both the
 * server app (`resources/app`) and the client payload (`resources/update`). From then on the normal server-to-client updates take over.
 *
 * The access token is a read-only GitHub token kept sealed on this computer. It is sent to GitHub's API and nowhere else:
 * downloads are redirected to another host, and the token is dropped on the way.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { compare, valid } = require('./version');
const { validateManifest } = require('./update');
const { log } = require('./util');

const DEFAULT_REPO = 'JuiceTwn/Artema-Portal';
const API = 'https://api.github.com';
const MAX_ZIP = 1024 ** 3;
const ASSET = /^Artema-Portal-Server-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-win\.zip$/;
const REDIRECTS = [301, 302, 303, 307, 308];
const rm = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };

/** GET that follows redirects, but only sends the token to the API's own address. Resolves with the response stream. */
function fetchStream(urlStr, { token = '', accept = 'application/json', origin, hops = 5, timeout = 30000 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error('bad address')); }
    const lib = u.protocol === 'https:' ? https : u.protocol === 'http:' ? http : null;
    if (!lib) return reject(new Error('bad address'));
    const headers = { 'User-Agent': 'Artema-Portal', Accept: accept };
    if (token && u.origin === origin) { headers.Authorization = `Bearer ${token}`; headers['X-GitHub-Api-Version'] = '2022-11-28'; }
    const req = lib.get(u, { headers, timeout }, res => {
      if (REDIRECTS.includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (hops <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u);
        if (u.protocol === 'https:' && next.protocol !== 'https:') return reject(new Error('refused a redirect to an unencrypted address'));
        return resolve(fetchStream(next.href, { token, accept, origin, hops: hops - 1, timeout }));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}
const readText = res => new Promise((resolve, reject) => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c).toString('utf8'))); res.on('error', reject); });
const untar = (zip, dir) => new Promise((resolve, reject) => execFile('tar', ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 10 * 60 * 1000 }, err => (err ? reject(new Error('could not unpack the download: ' + err.message)) : resolve())));

class ServerUpdater {
  /** { appDir, updateDir, version, electron, repo, apiBase, getToken(), onChange(state) } */
  constructor(o) {
    this.appDir = o.appDir; this.updateDir = o.updateDir; this.version = o.version; this.electron = o.electron;
    this.repo = o.repo || DEFAULT_REPO;
    this.api = (o.apiBase || API).replace(/\/+$/, '');
    if (!/^https:/.test(this.api) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(this.api)) throw new Error('the update address must be https');
    this.origin = new URL(this.api).origin;
    this.getToken = o.getToken || (() => ''); this.onChange = o.onChange || (() => { });
    this.resources = path.dirname(this.appDir);
    this.stageRoot = path.join(this.resources, 'server-update'); this.zipPath = this.stageRoot + '.zip';
    this.state = { state: 'idle', latest: '', message: '', progress: 0, checked: 0, notes: '' };
    this.release = null; this.busy = false; this.confirmed = false;
  }

  set(state, message = '', extra = {}) {
    this.state = { ...this.state, state, message, ...extra };
    try { this.onChange(this.state); } catch { /* a listener must not break updating */ }
  }
  status() { return { ...this.state, current: this.version, repo: this.repo, hasToken: !!this.getToken() }; }

  async json(p) {
    const res = await fetchStream(this.api + p, { token: this.getToken(), accept: 'application/vnd.github+json', origin: this.origin });
    const text = await readText(res);
    if (res.statusCode === 401) throw new Error('GitHub did not accept the access token. Make a new one and enter it again.');
    if (res.statusCode === 403) throw new Error('GitHub refused the request (the token may have expired, or GitHub is limiting requests).');
    if (res.statusCode === 404) throw new Error(`GitHub can't find releases for ${this.repo}. Check that the token can read that repository.`);
    if (res.statusCode !== 200) throw new Error(`GitHub answered ${res.statusCode}`);
    try { return JSON.parse(text); } catch { throw new Error('GitHub sent something unexpected'); }
  }

  /** Looks at the newest release. Never changes anything on disk. */
  async check() {
    if (this.busy) return this.status();
    if (!this.getToken()) { this.set('no-token', 'Connect this server to GitHub to check for new versions.'); return this.status(); }
    this.busy = true; this.set('checking', 'Checking GitHub…');
    try {
      const rel = await this.json(`/repos/${this.repo}/releases/latest`);
      const version = String(rel.tag_name || '').replace(/^v/i, '');
      if (!valid(version)) throw new Error(`The newest release (${rel.tag_name || 'unnamed'}) doesn't have a version number Artema Portal understands.`);
      const checked = Date.now();
      if (compare(version, this.version) <= 0) { this.release = null; this.set('none', "You're up to date.", { latest: version, checked, notes: '' }); return this.status(); }
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      const zip = assets.find(a => { const m = ASSET.exec(a.name || ''); return m && m[1] === version; });
      const sum = zip && assets.find(a => a.name === zip.name + '.sha256');
      if (!zip || !sum) throw new Error(`Version ${version} is on GitHub but has no server build attached yet.`);
      this.release = { version, zip, sum };
      this.set('available', `Version ${version} is ready to install.`, { latest: version, checked, notes: String(rel.body || '').slice(0, 600) });
    } catch (e) {
      log(`server update check failed: ${e.message}`);
      this.set('error', e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? "Can't reach GitHub right now. Check the internet connection." : e.message, { checked: Date.now() });
    } finally { this.busy = false; }
    return this.status();
  }

  /** Downloads, checks and unpacks the release. True when a complete update is waiting to be swapped in. */
  async install() {
    if (this.busy) return false;
    if (this.state.state !== 'available' || !this.release) { await this.check(); if (this.state.state !== 'available') return false; }
    const { version, zip, sum } = this.release;
    this.busy = true; this.confirmed = false;
    try {
      this.clear();
      this.set('downloading', `Downloading version ${version}…`, { progress: 0 });
      const expected = (await readText(await this.asset(sum))).trim().split(/\s+/)[0].toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('The release checksum is not readable.');
      const total = Math.min(zip.size || 0, MAX_ZIP);
      const hash = crypto.createHash('sha256'); let got = 0;
      const res = await this.asset(zip);
      await new Promise((resolve, reject) => {
        fs.mkdirSync(this.resources, { recursive: true });
        const out = fs.createWriteStream(this.zipPath);
        res.on('data', c => {
          got += c.length;
          if (got > MAX_ZIP) return res.destroy(new Error('The download is larger than expected.'));
          hash.update(c);
          if (total) this.state.progress = Math.min(99, Math.round(got / total * 100));
        });
        res.on('error', reject); out.on('error', reject); out.on('finish', resolve);
        res.pipe(out);
      });
      if (hash.digest('hex') !== expected) throw new Error('The download is damaged (checksum does not match). Try again.');

      this.set('downloading', 'Unpacking…', { progress: 99 });
      const x = path.join(this.stageRoot, 'x');
      fs.mkdirSync(x, { recursive: true });
      await untar(this.zipPath, x);
      const root = [x, ...fs.readdirSync(x, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(x, e.name))]
        .find(d => fs.existsSync(path.join(d, 'resources', 'app', 'package.json')));
      if (!root) throw new Error('The download is not an Artema Portal server build.');
      const app = path.join(root, 'resources', 'app'), upd = path.join(root, 'resources', 'update');
      const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
      if (pkg.artemaEdition !== 'server' || pkg.version !== version) throw new Error(`The download is not the server build of version ${version}.`);
      let manifest; try { manifest = JSON.parse(fs.readFileSync(path.join(upd, 'manifest.json'), 'utf8')); } catch { manifest = null; }
      const bad = validateManifest(manifest);
      if (bad || manifest.version !== version) throw new Error(`The download's update for connected computers is not valid (${bad || 'wrong version'}).`);
      if (manifest.electron !== this.electron) {
        this.clear();
        this.set('blocked', `Version ${version} needs a newer Electron (${manifest.electron}, this is ${this.electron}), so it has to be installed from its zip instead of from here.`);
        return false;
      }
      fs.renameSync(app, path.join(this.stageRoot, 'app')); fs.renameSync(upd, path.join(this.stageRoot, 'update'));
      rm(x); rm(this.zipPath);
      this.confirmed = true;
      this.set('ready', `Version ${version} is downloaded. Restarting…`, { progress: 100 });
      return true;
    } catch (e) {
      log(`server update failed: ${e.message}`);
      this.clear();
      this.set('error', e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' ? "Can't reach GitHub right now. Check the internet connection." : e.message);
      return false;
    } finally { this.busy = false; }
  }

  /** The private repository's asset download: the API address with a binary Accept header, redirected to storage by GitHub. */
  async asset(a) {
    const res = await fetchStream(`${this.api}/repos/${this.repo}/releases/assets/${a.id}`, { token: this.getToken(), accept: 'application/octet-stream', origin: this.origin, timeout: 60000 });
    if (res.statusCode !== 200) { res.resume(); throw new Error(`GitHub answered ${res.statusCode} for ${a.name}`); }
    return res;
  }

  clear() { rm(this.stageRoot); rm(this.zipPath); }

  /** What the restart helper needs, once the person has chosen to install and a complete update is waiting. */
  ready() {
    if (!this.confirmed || this.state.state !== 'ready' || !this.updateDir) return null;
    return {
      stageDir: path.join(this.stageRoot, 'app'), appDir: this.appDir, version: this.state.latest,
      extra: [{ dir: this.updateDir, stage: path.join(this.stageRoot, 'update'), old: this.updateDir + '.old' }],
      cleanup: [this.stageRoot, this.zipPath], args: [],
    };
  }

  /** At start-up: whatever an earlier update left behind is no use any more. */
  tidy(final) {
    this.clear();
    if (final) rm(this.updateDir + '.old');
  }
}

module.exports = { ServerUpdater, DEFAULT_REPO, ASSET, fetchStream };
