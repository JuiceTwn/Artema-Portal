'use strict';
// Headless test for updates: version order, the manifest, staging from the main computer, the restart helper (with rollback), and cleanup.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, spawnSync } = require('child_process');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ARTEMA_DEFAULT_PORT = '18499';
process.env.ARTEMA_UDP_PORT = '41496';
const { Core } = require('../src/core');
const { compare, valid } = require('../src/version');
const { safeRel, buildManifest, validateManifest } = require('../src/update');
const { noteVersion, cleanUpdateLeftovers, stopInstalledCopies } = require('../src/housekeeping');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-update-e2e-'));
const WEB = path.join(__dirname, '..', 'web');
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const put = (root, rel, text) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const tree = root => { const out = {}; const walk = (d, p) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = p ? p + '/' + e.name : e.name; e.isDirectory() ? walk(path.join(d, e.name), r) : out[r] = fs.readFileSync(path.join(d, e.name), 'utf8'); } }; walk(root, ''); return out; };
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

/** An app folder shaped like the real one. */
function makeApp(root, version, extra = {}) {
  fs.rmSync(root, { recursive: true, force: true });
  put(root, 'package.json', JSON.stringify({ name: 'artema-portal', version, artemaEdition: 'client' }));
  put(root, 'main.js', '// main');
  put(root, 'src/a.js', '// a');
  put(root, 'src/b.js', `// b for ${version}`);
  put(root, 'node_modules/x/index.js', '// x');
  for (const [k, v] of Object.entries(extra)) put(root, k, v);
}
async function publish(dir, version, { electron = '45.0.0', corrupt = false, edit } = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  makeApp(path.join(dir, 'app'), version);
  const m = await buildManifest(path.join(dir, 'app'), { version, edition: 'client', electron });
  if (edit) edit(m);
  if (corrupt) put(path.join(dir, 'app'), 'src/b.js', '// tampered after the manifest was made');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
}

(async () => {
  const cores = [];
  try {
    // ---- version order
    check('versions sort the way releases do', compare('1.0.2', '1.0.1') === 1 && compare('1.0.1', '1.0.2') === -1 && compare('1.0.1', '1.0.1') === 0 && compare('1.10.0', '1.9.9') === 1);
    check('a release is newer than its own test builds', compare('1.0.1', '1.0.1-test.9') === 1 && compare('1.0.1-test.10', '1.0.1-test.9') === 1 && compare('1.0.1-test.2', '1.0.1-test.10') === -1);
    check('text that is not a version is refused', !valid('latest') && !valid('1.0') && (() => { try { compare('x', '1.0.0'); return false; } catch { return true; } })());

    // ---- what a manifest may contain
    check('paths that could leave the app folder are refused', ['../x', 'a/../b', '/etc/x', 'C:/x', 'a\\b', 'a//b', '', '.', 'a/ '].every(p => !safeRel(p)) && safeRel('node_modules/x/index.js'));
    makeApp(path.join(T, 'probe'), '1.0.1');
    const m0 = await buildManifest(path.join(T, 'probe'), { version: '1.0.2', electron: '45.0.0' });
    check('a good manifest is accepted', validateManifest(m0) === '');
    const clone = f => { const m = JSON.parse(JSON.stringify(m0)); f(m); return validateManifest(m); };
    check('a manifest for the wrong edition is refused', clone(m => { m.edition = 'server'; }) !== '');
    check('a manifest with an unsafe path is refused', clone(m => { m.files[0].path = '../evil.js'; }) !== '');
    check('a manifest with a bad checksum is refused', clone(m => { m.files[0].sha256 = 'abc'; }) !== '');
    check('a manifest with no main.js is refused', clone(m => { m.files = m.files.filter(f => f.path !== 'main.js'); }) !== '');
    check('a manifest that lists a file twice is refused', clone(m => { m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase() }); }) !== '');
    check('a manifest with a bad version is refused', clone(m => { m.version = 'soon'; }) !== '');

    // ---- the main computer serves its client app; a connected computer stages it
    const srvDir = path.join(T, 'srv-update'), clientApp = path.join(T, 'client', 'resources', 'app');
    await publish(srvDir, '1.0.2');
    makeApp(clientApp, '1.0.1', { 'src/old.js': '// no longer part of the app' });
    const mkCore = (tag, extra) => {
      fs.mkdirSync(path.join(T, tag, 'desk'), { recursive: true });
      const c = new Core({ dataDir: path.join(T, tag, 'data'), webDir: WEB, desktopDir: path.join(T, tag, 'desk'), ...extra });
      c.trustLoopback = false; cores.push(c); return c;
    };
    const ready = [];
    const S = mkCore('srv', { app: { updateDir: srvDir } });
    const C = mkCore('cli', { hooks: { onUpdateReady: i => ready.push(i) }, app: { version: '1.0.1', electron: '45.0.0', appDir: clientApp, updateFirstMs: 3600000 } });
    for (const c of cores) await c.startLocalServer(0);
    await S.setupHost('Host', 18401);
    await C.join('127.0.0.1:18401', 'Floor PC', S.getPin());
    check('a connected computer has an update checker', !!C.updater);
    check('the main computer itself never updates from anyone', !S.updater);

    const calls = []; const realFile = C.updater.api.file;
    C.updater.api.file = rel => { calls.push(rel); return realFile(rel); };
    let st = await C.updater.check();
    check('a newer version on the main computer is staged', st.state === 'ready' && st.version === '1.0.2', st);
    check('...and the app is told it is ready', ready.length === 1 && ready[0].version === '1.0.2');
    check('only the files that differ are downloaded', calls.sort().join() === 'package.json,src/b.js', calls);
    const stage = C.updater.stageDir, newTree = tree(path.join(srvDir, 'app'));
    check('the staged app is exactly the new app (stale files gone)', same(tree(stage), newTree));
    check('the running app was not touched while staging', fs.existsSync(path.join(clientApp, 'src', 'old.js')) && fs.readFileSync(path.join(clientApp, 'package.json'), 'utf8').includes('1.0.1'));
    check('a ready update can be handed to the restart helper', (() => { const p = C.pendingUpdate(); return p && p.version === '1.0.2' && p.stageDir === stage && p.appDir === clientApp; })());
    calls.length = 0; st = await C.updater.check();
    check('checking again does not download it again', st.state === 'ready' && calls.length === 0, calls);
    check('the main computer learns which version each computer runs', S.store.deviceList().find(d => d.name === 'Floor PC').version === '1.0.1');

    // ---- things that must never be installed
    const expectNone = async (name, version, opts) => {
      await publish(srvDir, version, opts); C.updater.clearStage(); calls.length = 0;
      const s = await C.updater.check(); check(name, s.state === 'none' && !C.pendingUpdate() && !fs.existsSync(stage), { s, calls });
    };
    await expectNone('the same version is not installed again', '1.0.1');
    await expectNone('an older version is never installed (no downgrade)', '1.0.0');
    await expectNone('an older test build is never installed over a release', '1.0.1-test.5');
    await publish(srvDir, '1.0.3', { electron: '46.0.0' }); C.updater.clearStage();
    st = await C.updater.check();
    check('an update built for a different Electron is held back, not installed', st.state === 'blocked' && !C.pendingUpdate(), st);
    await publish(srvDir, '1.0.3', { corrupt: true }); C.updater.clearStage();
    st = await C.updater.check();
    check('a file that fails its checksum stops the update and leaves nothing behind', st.state === 'error' && !C.pendingUpdate() && !fs.existsSync(stage) && !fs.existsSync(C.updater.markerPath), st);
    await publish(srvDir, '1.0.3', { edit: m => { m.files[2].path = '../escape.js'; } }); C.updater.clearStage();
    st = await C.updater.check();
    check('a manifest with an unsafe path is ignored', st.state === 'none' && !fs.existsSync(path.join(T, 'client', 'resources', 'escape.js')), st);
    fs.rmSync(path.join(srvDir, 'manifest.json'));
    st = await C.updater.check();
    check('a main computer with no update to offer is simply fine', st.state === 'none', st);
    await publish(srvDir, '1.0.4'); C.updater.clearStage();
    st = await C.updater.check();
    check('a later update is picked up once it exists', st.state === 'ready' && st.version === '1.0.4', st);
    check('the update state is visible to the window', C.state().update && C.state().update.state === 'ready');

    // ---- the restart helper
    const helper = path.join(__dirname, '..', 'src', 'update-helper.js');
    // Never hand the helper process.execPath to start: inside the packaged app that would launch (and install) the real program.
    const standIn = (res, version) => ['/c', 'exit', /crash/.test(version) ? '1' : '0'];          // a program that starts and exits at once, with an error for a version called "crash"
    const standInExe = process.env.ComSpec || 'cmd.exe';
    const runHelper = async (tag, oldV, newV) => {
      const res = path.join(T, tag); fs.rmSync(res, { recursive: true, force: true });
      put(res, 'app/VERSION', oldV); put(res, 'app.update/VERSION', newV); put(res, 'app.update.json', '{}');
      const job = { pid: 2147480000, appDir: path.join(res, 'app'), stageDir: path.join(res, 'app.update'), oldDir: path.join(res, 'app.old'), exe: standInExe, args: standIn(res, newV), version: newV, logFile: path.join(res, 'update.log'), watchMs: 30000 };
      const h = spawn(process.execPath, [helper, JSON.stringify(job)], { stdio: 'ignore' });
      await new Promise(r => h.on('exit', r));
      await sleep(300);
      const read = f => { try { return fs.readFileSync(path.join(res, f), 'utf8'); } catch { return null; } };
      return { res, version: read('app/VERSION'), started: (read('started.txt') || '').split(/\s+/).filter(Boolean), log: read('update.log') || '', has: f => fs.existsSync(path.join(res, f)) };
    };
    let r = await runHelper('h-ok', 'OLD', 'NEW');
    check('the helper puts the new app in place and starts it', r.version === 'NEW' && /is running/.test(r.log), r);
    check('...and cleans up after itself', !r.has('app.old') && !r.has('app.update') && !r.has('app.update.json'), r);
    r = await runHelper('h-crash', 'OLD', 'NEW-crash');
    check('a new version that crashes is rolled back to the old one', r.version === 'OLD' && r.has('app.failed') && !r.has('app.update'), r);
    check('...and the old version is started again', /going back/.test(r.log) && r.version === 'OLD', r);

    // ---- cleanup
    const res = path.join(T, 'tidy'); fs.rmSync(res, { recursive: true, force: true });
    put(res, 'app/package.json', '{}'); put(res, 'app.old/x', 'x'); put(res, 'app.update/x', 'x'); put(res, 'app.update.json', JSON.stringify({ version: '1.0.1' })); put(res, 'app.failed/x', 'x');
    cleanUpdateLeftovers(path.join(res, 'app'), '1.0.1');
    check('after an update the old app and a stale staged update are removed', !fs.existsSync(path.join(res, 'app.old')) && !fs.existsSync(path.join(res, 'app.update')) && !fs.existsSync(path.join(res, 'app.update.json')));
    check('a failed version is kept so it can be looked at', fs.existsSync(path.join(res, 'app.failed')));
    put(res, 'app.update/x', 'x'); put(res, 'app.update.json', JSON.stringify({ version: '1.0.9' }));
    cleanUpdateLeftovers(path.join(res, 'app'), '1.0.1');
    check('a newer staged update is left alone', fs.existsSync(path.join(res, 'app.update')) && fs.existsSync(path.join(res, 'app.update.json')));
    const dd = path.join(T, 'vdata');
    check('the first run of a version is noticed once', noteVersion(dd, '1.0.1').changed && !noteVersion(dd, '1.0.1').changed && noteVersion(dd, '1.0.2').previous === '1.0.1');
    if (process.platform === 'win32') {
      const exe = 'C:\\Users\\x\\AppData\\Local\\Programs\\Artema Portal\\Artema Portal.exe', killed = []; let listed = 0;
      const exec = async (cmd, args) => {
        if (/powershell/i.test(cmd)) {
          listed++;
          const rows = listed === 1 ? [
            { ProcessId: 100, ParentProcessId: 1, ExecutablePath: exe }, { ProcessId: 101, ParentProcessId: 100, ExecutablePath: exe },
            { ProcessId: 300, ParentProcessId: 1, ExecutablePath: 'D:\\Downloads\\Artema Portal\\Artema Portal.exe' }, { ProcessId: 555, ParentProcessId: 1, ExecutablePath: exe }] : [];
          return { stdout: JSON.stringify(rows) };
        }
        killed.push(args[1]); return { stdout: '' };
      };
      const n = await stopInstalledCopies(exe, 555, exec);
      check('an older installed copy is closed, never this one or a copy somewhere else', n === 1 && killed.join() === '100', { n, killed });
    }

    // ---- the newest server owns the default port (18499 in this test)
    const stopHolder = async port => { const h = cores.find(c => c.server && parseInt(c.cfg.port, 10) === port); if (!h) return false; await h.stopRole(); return true; };
    const mkServer = (tag, version) => mkCore(tag, { edition: 'server', hooks: { stopPortHolder: stopHolder }, app: { version } });
    const oldHost = mkCore('p-old', {}); await oldHost.startLocalServer(0); await oldHost.setupHost('Old test host', 18499);          // no version: an older build
    const v2 = mkServer('p-v2', '1.0.2'); await v2.startLocalServer(0); await v2.ensureServer();
    check('a newer server takes the default port from an older one', v2.cfg.port === 18499 && !!v2.server && !oldHost.server, { port: v2.cfg.port, err: v2.startError });
    const v2b = mkServer('p-v2b', '1.0.2'); await v2b.startLocalServer(0); await v2b.ensureServer();
    check('a server of the same version does not push the running one off', !!v2.server && v2.cfg.port === 18499 && !!v2b.server && v2b.cfg.port !== 18499, { v2: v2.cfg.port, v2b: v2b.cfg.port });
    const v3 = mkServer('p-v3', '1.0.3'); await v3.startLocalServer(0); await v3.ensureServer();
    check('an even newer server takes it over in turn', v3.cfg.port === 18499 && !!v3.server && !v2.server, { v3: v3.cfg.port });
    await v3.stopRole(); await v2b.stopRole(); await v2b.startRole();
    check('a server saved on another port moves to the default port once it is free', v2b.cfg.port === 18499 && !!v2b.server, { port: v2b.cfg.port, err: v2b.startError });
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of cores) { try { await c.shutdown(); } catch { /* already stopped */ } }
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
