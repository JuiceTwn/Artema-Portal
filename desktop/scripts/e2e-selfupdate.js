'use strict';
// Headless test for the server updating itself from a (pretend) private GitHub repository: finding the release, downloading and
// checking it, keeping the token away from the download host, and swapping in the server app together with the client payload.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { ServerUpdater } = require('../src/selfupdate');
const { buildManifest } = require('../src/update');
const { can } = require('../src/roles');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-selfupdate-e2e-'));
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const put = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = 'github_pat_test_token';

/** A zip shaped like the server build: the program, resources/app (server) and resources/update (the client payload). */
async function makeRelease(version, { edition = 'server', electron = '45.0.0', nested = false, appVersion = version } = {}) {
  const dir = path.join(T, 'pkg-' + version + '-' + edition + '-' + electron + (nested ? '-n' : '')), top = nested ? path.join(dir, 'Artema Portal Server') : dir;
  fs.rmSync(dir, { recursive: true, force: true });
  put(top, 'Artema Portal Server.exe', 'not really a program');
  put(top, 'resources/app/package.json', JSON.stringify({ name: 'artema-portal', version: appVersion, artemaEdition: edition }));
  put(top, 'resources/app/main.js', '// server'); put(top, 'resources/app/VERSION', version);
  put(top, 'resources/update/app/package.json', JSON.stringify({ name: 'artema-portal', version, artemaEdition: 'client' }));
  put(top, 'resources/update/app/main.js', '// client'); put(top, 'resources/update/app/src/a.js', '// a for ' + version);
  const manifest = await buildManifest(path.join(top, 'resources', 'update', 'app'), { version, edition: 'client', electron });
  put(top, 'resources/update/manifest.json', JSON.stringify(manifest));
  const zip = path.join(T, `release-${path.basename(dir)}.zip`);
  execFileSync('tar', ['-a', '-cf', zip, '-C', dir, '.']);
  return { zip, sha: crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex') };
}

/** An app install folder: the running server and its client payload. */
function makeInstall(tag, version) {
  const root = path.join(T, tag); fs.rmSync(root, { recursive: true, force: true });
  put(root, 'resources/app/package.json', JSON.stringify({ name: 'artema-portal', version, artemaEdition: 'server' }));
  put(root, 'resources/app/main.js', '// old server'); put(root, 'resources/app/VERSION', version);
  put(root, 'resources/update/app/main.js', '// old client'); put(root, 'resources/update/manifest.json', '{"old":true}');
  return { appDir: path.join(root, 'resources', 'app'), updateDir: path.join(root, 'resources', 'update'), root };
}

(async () => {
  const servers = [];
  try {
    // ---- the rules
    check('only the dev level may install server software', can('dev', 'server.update') && !can('admin', 'server.update') && !can('general', 'server.update'));

    // ---- a pretend GitHub: the API (needs the token) and a separate download host (must never see it)
    let release = null, blob = null, sumText = '', seenOnBlob = [], apiHits = 0;
    const blobSrv = http.createServer((req, res) => {
      seenOnBlob.push(req.headers.authorization || '');
      if (req.url === '/zip' && blob) { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': blob.length }); res.end(blob); } else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => blobSrv.listen(0, '127.0.0.1', r)); servers.push(blobSrv);
    const blobUrl = `http://127.0.0.1:${blobSrv.address().port}/zip`;
    const api = http.createServer((req, res) => {
      apiHits++;
      if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{}'); }
      if (req.url === '/repos/o/r/releases/latest') { res.writeHead(release ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(release || {})); }
      if (req.url === '/repos/o/r/releases/assets/1') { res.writeHead(302, { Location: blobUrl }); return res.end(); }
      if (req.url === '/repos/o/r/releases/assets/2') { res.writeHead(200); return res.end(sumText); }
      res.writeHead(404); res.end();
    });
    await new Promise(r => api.listen(0, '127.0.0.1', r)); servers.push(api);
    const base = `http://127.0.0.1:${api.address().port}`;
    const publish = async (version, opts = {}) => {
      const b = await makeRelease(version, opts);
      blob = fs.readFileSync(b.zip); sumText = (opts.badSum ? '0'.repeat(64) : b.sha) + '  x.zip\n';
      release = { tag_name: 'v' + version, body: 'Faster file search', assets: [{ id: 1, name: `Artema-Portal-Server-${version}-win.zip`, size: blob.length }, { id: 2, name: `Artema-Portal-Server-${version}-win.zip.sha256`, size: 80 }] };
    };
    let token = '';
    const mk = (inst, version = '1.0.1') => new ServerUpdater({ appDir: inst.appDir, updateDir: inst.updateDir, version, electron: '45.0.0', repo: 'o/r', apiBase: base, getToken: () => token });

    // ---- finding the release
    let inst = makeInstall('inst1', '1.0.1'), u = mk(inst);
    await u.check();
    check('with no token it asks to connect to GitHub, and does not call out', u.state.state === 'no-token' && apiHits === 0);
    token = 'wrong'; await u.check();
    check('a token GitHub refuses is reported plainly', u.state.state === 'error' && /did not accept/.test(u.state.message), u.state);
    token = TOKEN; release = null; await u.check();
    check('a repository it cannot see is reported plainly', u.state.state === 'error' && /can't find releases/.test(u.state.message), u.state);
    await publish('1.0.1'); await u.check();
    check('the same version means up to date', u.state.state === 'none', u.state);
    await publish('1.0.2'); await u.check();
    check('a newer release is offered', u.state.state === 'available' && u.state.latest === '1.0.2' && /Faster file search/.test(u.state.notes), u.state);
    release.assets.pop(); await u.check();
    check('a release with no checksum or build attached is not offered', u.state.state === 'error' && /no server build/.test(u.state.message), u.state);
    check('the status never contains the token', !JSON.stringify(u.status()).includes(TOKEN) && u.status().hasToken === true);

    // ---- downloading and checking
    await publish('1.0.2'); await u.check(); seenOnBlob = [];
    check('install downloads, checks and unpacks it', await u.install() === true && u.state.state === 'ready', u.state);
    check('the token went to the API but was not sent to the download host', seenOnBlob.length === 1 && seenOnBlob[0] === '', seenOnBlob);
    const r1 = u.ready();
    check('the staged update holds the server app and the client payload', r1 && fs.readFileSync(path.join(r1.stageDir, 'VERSION'), 'utf8') === '1.0.2' && fs.existsSync(path.join(r1.extra[0].stage, 'manifest.json')) && fs.existsSync(path.join(r1.extra[0].stage, 'app', 'src', 'a.js')), r1);
    check('nothing in the running install changed yet', fs.readFileSync(path.join(inst.appDir, 'VERSION'), 'utf8') === '1.0.1' && fs.readFileSync(path.join(inst.updateDir, 'manifest.json'), 'utf8') === '{"old":true}');
    check('the download itself is cleaned away', !fs.existsSync(u.zipPath) && !fs.existsSync(path.join(u.stageRoot, 'x')));

    // ---- things that must be refused
    inst = makeInstall('inst2', '1.0.1'); u = mk(inst);
    await publish('1.0.2', { badSum: true }); await u.check();
    check('a download that does not match its checksum is refused and cleared', await u.install() === false && /damaged/.test(u.state.message) && !fs.existsSync(u.stageRoot) && !fs.existsSync(u.zipPath), u.state);
    await publish('1.0.2', { edition: 'client' }); await u.check();
    check('a client build posing as the server is refused', await u.install() === false && /not the server build/.test(u.state.message), u.state);
    await publish('1.0.2', { appVersion: '9.9.9' }); await u.check();
    check('a build whose version differs from the release is refused', await u.install() === false && /not the server build of version 1.0.2/.test(u.state.message), u.state);
    await publish('1.0.2', { electron: '99.0.0' }); await u.check();
    check('a build needing another Electron is not installed in place', await u.install() === false && u.state.state === 'blocked' && !u.ready() && !fs.existsSync(u.stageRoot), u.state);
    await publish('1.0.2', { nested: true }); await u.check();
    check('a zip with everything inside one folder still works', await u.install() === true && !!u.ready(), u.state);
    check('only the person pressing Install can start the swap', (() => { const x = mk(makeInstall('inst3', '1.0.1')); return x.ready() === null; })());

    // ---- the swap itself, with the real restart helper
    const helper = path.join(__dirname, '..', 'src', 'update-helper.js');
    // The helper starts "the app" it is given. Never hand it process.execPath: when this runs inside the packaged app that would
    // start (and install) the real Artema Portal Server. A cmd.exe that exits at once stands in, with an error for a version called "crash".
    const standIn = (res, version) => ['/c', 'exit', /crash/.test(version) ? '1' : '0'];          // a program that starts and exits at once, with an error for a version called "crash"
    const standInExe = process.env.ComSpec || 'cmd.exe';
    const swap = async (tag, version, opts) => {
      const i = makeInstall(tag, '1.0.1'), up = mk(i);
      await publish(version, opts); await up.check(); await up.install();
      const info = up.ready(), res = path.dirname(i.appDir);
      const job = { pid: 2147480000, appDir: info.appDir, stageDir: info.stageDir, oldDir: info.appDir + '.old', extra: info.extra, cleanup: info.cleanup, exe: standInExe, args: standIn(res, version), version, logFile: path.join(res, 'update.log'), watchMs: 30000 };
      const h = spawn(process.execPath, [helper, JSON.stringify(job)], { stdio: 'ignore' });
      await new Promise(r => h.on('exit', r)); await sleep(300);
      const read = f => { try { return fs.readFileSync(path.join(res, f), 'utf8'); } catch { return null; } };
      return { read, has: f => fs.existsSync(path.join(res, f)), started: (read('started.txt') || '').split(/\s+/).filter(Boolean), log: read('update.log') || '' };
    };
    let s = await swap('swap-ok', '1.0.2');
    check('the helper swaps in the new server app and the new client payload together', s.read('app/VERSION') === '1.0.2' && s.has('update/app/src/a.js') && s.read('update/manifest.json') !== '{"old":true}' && /is running/.test(s.log), s);
    check('...and leaves no old copies or staging behind', !s.has('app.old') && !s.has('update.old') && !s.has('server-update') && !s.has('server-update.zip'), s);
    s = await swap('swap-crash', '1.0.3-crash');
    check('a new server that crashes puts back both the old app and the old client payload', s.read('app/VERSION') === '1.0.1' && s.read('update/manifest.json') === '{"old":true}' && !s.has('update/app/src/a.js') && s.has('app.failed') && /going back/.test(s.log), s);
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const s of servers) { try { s.closeAllConnections && s.closeAllConnections(); s.close(); } catch { /* already closed */ } }
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
