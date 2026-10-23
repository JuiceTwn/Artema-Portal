'use strict';
// Headless end-to-end test: one main computer + two connecting computers, all in this process.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.ARTEMA_DEFAULT_PORT = '18099';      // keep discovery away from a real Portal that may be running on 8080
const { Core } = require('../src/core');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-node-e2e-'));
const WEB = path.join(__dirname, '..', 'web');
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, secs = 15) => { const end = Date.now() + secs * 1000; while (Date.now() < end) { if (await fn()) return true; await sleep(400); } return false; };
const ex = p => fs.existsSync(p);
const mk = (tag, hooks) => { fs.mkdirSync(path.join(T, tag, 'desk'), { recursive: true }); return new Core({ dataDir: path.join(T, tag, 'data'), webDir: WEB, desktopDir: path.join(T, tag, 'desk'), hooks }); };
const touch = (p, ageSec) => { const t = Date.now() / 1000 - ageSec; fs.utimesSync(p, t, t); };

(async () => {
  const incoming = [], received = [], extra = [];
  const host = mk('host', { onIncoming: (w, n) => incoming.push([w, n]) });
  const c1 = mk('c1', { onReceived: l => received.push(...l) }), c2 = mk('c2');
  try {
    for (const c of [host, c1, c2]) await c.startLocalServer(0);
    const L = c => p => c.localUrl(p);
    let r = await (await fetch(host.localUrl('/api/state'))).json(); check('wizard state reachable', r.configured === false);
    r = await fetch(host.localUrl('/')); check('wizard page served', r.status === 200 && (await r.text()).includes('Artema Portal Setup'));

    r = await host.setupHost('CNC Shop', 18081); check('host setup', r.ok, r);
    const P = 'http://127.0.0.1:18081', hostDir = path.join(T, 'host', 'desk', 'Artema Portal');
    check('host folder + starter folders', ['To CNC', 'From CNC', 'Drawings', 'Photos'].every(n => ex(path.join(hostDir, n))));
    check('host info', (await (await fetch(P + '/api/info')).json()).name === 'CNC Shop');
    r = await fetch(P + '/'); check('portal UI served', r.status === 200 && (await r.text()).includes('Artema Portal'));
    for (const f of ['portal.js', 'portal.css', 'theme.css', 'assets/logo-light.webp']) check('static ' + f, (await fetch(P + '/' + f)).status === 200);
    check('traversal blocked (static)', (await fetch(P + '/..%2f..%2fpackage.json')).status === 404);
    check('traversal blocked (api)', (await fetch(P + '/api/file?path=../../x')).status === 400);

    r = await c1.probe('127.0.0.1:18081'); check('probe finds host', r && r.name === 'CNC Shop', r);
    r = await c1.join('127.0.0.1:18081', 'Boss Office'); check('client 1 join', r.ok, r);
    r = await c2.join('127.0.0.1:18081', 'boss office').then(() => ({ ok: true }), e => ({ ok: false, e: e.message })); check('duplicate name rejected', !r.ok, r);
    r = await c2.join('127.0.0.1:18081', 'Cutting Room'); check('client 2 join', r.ok, r);
    const d1 = path.join(T, 'c1', 'desk', 'Artema Portal'), d2 = path.join(T, 'c2', 'desk', 'Artema Portal');
    check('clients get starter folders', await wait(() => ex(path.join(d1, 'To CNC')) && ex(path.join(d2, 'Photos'))));

    fs.writeFileSync(path.join(d1, 'To CNC', 'door.dxf'), '0\nSECTION\n'.repeat(500)); touch(path.join(d1, 'To CNC', 'door.dxf'), 30);
    check('c1 -> host', await wait(() => ex(path.join(hostDir, 'To CNC', 'door.dxf'))));
    check('host -> c2', await wait(() => ex(path.join(d2, 'To CNC', 'door.dxf'))));
    check('content identical', fs.readFileSync(path.join(d2, 'To CNC', 'door.dxf')).equals(fs.readFileSync(path.join(d1, 'To CNC', 'door.dxf'))));
    check('host notified of incoming file', incoming.some(([w, n]) => w === 'Boss Office' && n === 'door.dxf'), incoming);

    // browser upload (with unicode name), then both clients get it and c1 is notified
    r = await fetch(P + '/api/file?path=' + encodeURIComponent('From CNC/note é.txt') + '&mtime=' + (Math.floor(Date.now() / 1000) - 60),
      { method: 'PUT', body: 'hello from the browser', headers: { 'X-Device': 'Ben' } });
    check('web upload', r.status === 200);
    check('upload reaches both clients', await wait(() => ex(path.join(d1, 'From CNC', 'note é.txt')) && ex(path.join(d2, 'From CNC', 'note é.txt'))));
    check('c1 got a "received" notification from Ben', received.some(x => x.by === 'Ben' && x.name === 'note é.txt'), received);
    const lst = await (await fetch(P + '/api/list?path=From%20CNC')).json();
    check('added-by recorded', lst.items.some(i => i.name.startsWith('note') && i.by === 'Ben'), lst);
    check('search', (await (await fetch(P + '/api/search?q=door%20dxf')).json()).items.some(i => i.name === 'door.dxf'));
    check('search no match', (await (await fetch(P + '/api/search?q=zzzz')).json()).items.length === 0);
    const dl = await fetch(P + '/api/file?path=To%20CNC/door.dxf'); check('download', dl.status === 200 && Buffer.from(await dl.arrayBuffer()).equals(fs.readFileSync(path.join(hostDir, 'To CNC', 'door.dxf'))));

    await sleep(2200); fs.writeFileSync(path.join(d2, 'To CNC', 'door.dxf'), 'edited by c2 '.repeat(100));
    check('edit c2 -> c1', await wait(() => fs.readFileSync(path.join(d1, 'To CNC', 'door.dxf'), 'utf8').startsWith('edited by c2')));
    fs.mkdirSync(path.join(d1, 'Drawings', 'Job 12')); await sleep(2200); fs.writeFileSync(path.join(d1, 'Drawings', 'Job 12', 'a.pdf'), '%PDF'.repeat(10));
    check('nested folder reaches c2', await wait(() => ex(path.join(d2, 'Drawings', 'Job 12', 'a.pdf'))));
    fs.unlinkSync(path.join(d1, 'To CNC', 'door.dxf'));
    check('delete c1 -> host & c2', await wait(() => !ex(path.join(hostDir, 'To CNC', 'door.dxf')) && !ex(path.join(d2, 'To CNC', 'door.dxf'))));
    const inTrash = (function walk(d) { return ex(d) && fs.readdirSync(d, { withFileTypes: true }).some(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'door.dxf'); })(path.join(hostDir, '.trash'));
    check('deleted copy kept in trash', inTrash);
    check('trash not synced to clients', !ex(path.join(d1, '.trash')));
    r = await fetch(P + '/api/move', { method: 'POST', body: JSON.stringify({ from: 'Drawings/Job 12', to: 'Drawings/Job 13' }), headers: { 'X-Device': 'Ben' } });
    check('rename folder', r.status === 200);
    check('rename reaches c2', await wait(() => ex(path.join(d2, 'Drawings', 'Job 13', 'a.pdf')) && !ex(path.join(d2, 'Drawings', 'Job 12'))));

    for (const d of [d1, d2]) fs.writeFileSync(path.join(d, 'To CNC', 'c.txt'), 'base');
    check('base file synced', await wait(() => ex(path.join(hostDir, 'To CNC', 'c.txt'))));
    await sleep(2500);
    fs.writeFileSync(path.join(d1, 'To CNC', 'c.txt'), 'one'); fs.writeFileSync(path.join(d2, 'To CNC', 'c.txt'), 'two');
    touch(path.join(d1, 'To CNC', 'c.txt'), 20); touch(path.join(d2, 'To CNC', 'c.txt'), 10);
    await sleep(8000);
    const names = fs.readdirSync(path.join(hostDir, 'To CNC')); console.log('   conflict dir:', names);
    check('conflict keeps both versions', names.some(n => n.includes('conflict')) && names.includes('c.txt'));
    const dv = (await (await fetch(P + '/api/devices')).json()).devices; const on = Object.fromEntries(dv.map(d => [d.name, d.online]));
    check('devices online', on['Boss Office'] && on['Cutting Room'], on);
    check('activity feed', (await (await fetch(P + '/api/activity')).json()).items.length >= 3);

    fs.rmSync(d2, { recursive: true, force: true });
    check('wiped client restores from host', await wait(() => ex(path.join(d2, 'Drawings', 'Job 13', 'a.pdf')), 20));
    check('host untouched by wipe', ex(path.join(hostDir, 'Drawings', 'Job 13', 'a.pdf')));
    check('restore finishes cleanly (folders restored as folders)', await wait(() => c2.agent.status.state === 'ok' && ex(path.join(d2, 'Photos')) && ex(path.join(d2, 'From CNC')), 20), c2.agent.status);

    // main computer goes away: client shows offline, then recovers
    await host.stopRole();
    check('client reports offline', await wait(() => c1.agent.status.state === 'offline', 12), c1.agent.status);
    await host.startRole();
    check('client recovers', await wait(() => c1.agent.status.state === 'ok', 12), c1.agent.status);
    // disconnecting a client leaves its files
    await c2.reset(); check('reset leaves files in place', ex(path.join(d2, 'Drawings')) && !c2.configured);

    // ---- plug and play
    const c3 = mk('c3'); extra.push(c3); await c3.startLocalServer(0);
    r = await c3.autoSetup();
    check('new PC finds the main computer and joins with no questions', r.action === 'joined' && c3.configured, r);
    check('auto-joined PC got its folder and starter folders', await wait(() => ex(path.join(T, 'c3', 'desk', 'Artema Portal', 'To CNC'))));
    check('configured PC never auto-sets-up again', (await c3.autoSetup()).action === 'already');
    const solo = mk('solo'); extra.push(solo); await solo.startLocalServer(0); solo.discover = async () => [];
    check('first PC on an empty network is told it is first', (await solo.autoSetup()).action === 'none');

    const c4 = mk('c4'); extra.push(c4); await c4.startLocalServer(0);
    await c4.join('127.0.0.1:18081', 'Router CNC 2');
    let devs = (await (await fetch(P + '/api/devices')).json()).devices;
    check('tag guessed from the name (CNC)', (devs.find(d => d.name === 'Router CNC 2') || {}).tag === 'CNC', devs);
    const id4 = devs.find(d => d.name === 'Router CNC 2').id;
    await fetch(P + '/api/devices/tag', { method: 'POST', body: JSON.stringify({ id: id4, tag: 'Edgebander' }), headers: { 'X-Device': 'Ben' } });
    devs = (await (await fetch(P + '/api/devices')).json()).devices;
    check('tag can be edited', (devs.find(d => d.id === id4) || {}).tag === 'Edgebander');

    // ---- hardening
    const { request } = require('../src/util');
    let crashed = false; const onUnc = () => { crashed = true; }; process.on('uncaughtException', onUnc);
    const rej = await request('PUT', P + '/api/file?path=x.bin', { headers: { 'Content-Length': '10', 'X-Device': 't' }, body: fs.createReadStream(path.join(T, 'does-not-exist')) }).then(() => 'resolved', () => 'rejected');
    await sleep(300); process.off('uncaughtException', onUnc);
    check('a missing/locked file during upload fails that one request without crashing', rej === 'rejected' && !crashed, { rej, crashed });

    // a folder we cannot read for a moment must never look like "the user deleted everything in it"
    const realRead = fs.readdirSync, blockLocal = path.join(d1, 'Drawings'), blockHost = path.join(hostDir, 'Drawings');
    fs.readdirSync = function (p, ...a) { if (String(p) === blockLocal) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return realRead.call(this, p, ...a); };
    await sleep(7000); fs.readdirSync = realRead;
    check('unreadable local folder is not treated as deleted', ex(path.join(hostDir, 'Drawings', 'Job 13', 'a.pdf')) && ex(path.join(d1, 'Drawings', 'Job 13', 'a.pdf')));
    fs.readdirSync = function (p, ...a) { if (String(p) === blockHost) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return realRead.call(this, p, ...a); };
    await sleep(7000); fs.readdirSync = realRead;
    check('unreadable folder on the main computer does not make clients delete their copies', ex(path.join(d1, 'Drawings', 'Job 13', 'a.pdf')) && ex(path.join(hostDir, 'Drawings', 'Job 13', 'a.pdf')));
    check('...and syncing carries on afterwards', await wait(() => c1.agent.status.state === 'ok', 12), c1.agent.status);

    // joining a different main computer must not wipe local files because of old sync memory
    const walkSigs = root => { const o = {}; (function w(d, pre) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name), k = pre + e.name; if (e.name.startsWith('.')) continue; if (e.isDirectory()) { o[k] = 'd'; w(f, k + '/'); } else { const s = fs.statSync(f); o[k] = `${s.size}:${Math.floor(s.mtimeMs / 1000)}`; } } })(root, ''); return o; };
    const hostB = mk('hostB'); extra.push(hostB); await hostB.startLocalServer(0); await hostB.setupHost('Other Main', 18095);
    const hostBDir = path.join(T, 'hostB', 'desk', 'Artema Portal');
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(d2, `memory-${i}.txt`), 'x'.repeat(10 + i));     // 12 files = enough to look like a "mass" anyway
    await sleep(2200);
    fs.mkdirSync(path.join(T, 'c2', 'data'), { recursive: true });
    // only 5 remembered files: few enough that the mass-delete safety net stays out of it, so this isolates the real fix
    const fewSigs = Object.fromEntries(Object.entries(walkSigs(d2)).filter(([k]) => /^memory-[0-4]\.txt$/.test(k)));
    fs.writeFileSync(path.join(T, 'c2', 'data', 'sync-state.json'), JSON.stringify({ base: fewSigs, key: 'some-other-main-computer' }));
    r = await c2.join('127.0.0.1:18095', 'Cutting Room'); check('client joins a different main computer', r.ok, r);
    await sleep(9000);
    check('old sync memory from another main computer does not delete local files', ex(path.join(d2, 'memory-3.txt')) && ex(path.join(d2, 'Drawings', 'Job 13', 'a.pdf')));
    check('...they are shared to the new main computer instead', await wait(() => ex(path.join(hostBDir, 'memory-3.txt')), 12));

    // something else answering at the old address (a different main computer) must not be mirrored
    const hostC = mk('hostC'); extra.push(hostC); await hostC.startLocalServer(0); await hostC.setupHost('Host C', 18096);
    const clC = mk('clC'); extra.push(clC); await clC.startLocalServer(0); await clC.join('127.0.0.1:18096', 'Client C');
    const dC = path.join(T, 'clC', 'desk', 'Artema Portal'), hostCDir = path.join(T, 'hostC', 'desk', 'Artema Portal');
    check('client C gets its folders', await wait(() => ex(path.join(dC, 'To CNC'))));
    fs.writeFileSync(path.join(dC, 'To CNC', 'precious.dxf'), 'important'); touch(path.join(dC, 'To CNC', 'precious.dxf'), 30);
    check('client C shares a file', await wait(() => ex(path.join(hostCDir, 'To CNC', 'precious.dxf'))));
    await hostC.stopRole(); fs.rmSync(hostCDir, { recursive: true, force: true });
    hostC.cfg = { ...hostC.cfg, instance_id: 'ffff0000ffff0000' }; await hostC.startRole();      // a brand-new, empty main computer takes over the address
    await sleep(9000);
    check('a different main computer at the same address does not erase the client', ex(path.join(dC, 'To CNC', 'precious.dxf')));
    check('client reports that this is not its main computer', clC.agent.status.state === 'offline', clC.agent.status);

    // ---- web pages must not be able to drive the API, and a rebinding-style Host is refused
    r = await fetch(P + '/api/delete', { method: 'POST', body: JSON.stringify({ path: 'To CNC' }) });
    check('state-changing request without the custom header is refused', r.status === 403, r.status);
    const badHost = await new Promise(res => { const rq = require('http').request({ host: '127.0.0.1', port: 18081, path: '/api/info', headers: { Host: 'evil.example.com' } }, rs => { rs.resume(); res(rs.statusCode); }); rq.on('error', () => res(0)); rq.end(); });
    check('request carrying another domain as Host is refused', badHost === 403, badHost);
    check('ordinary requests still work', (await fetch(P + '/api/info')).status === 200);
    check('no request timeout on big uploads', host.server.requestTimeout === 0);

    // automatic setup walks to the next free port when the default is taken
    const blocker = require('net').createServer(); await new Promise(r => blocker.listen(18090, '0.0.0.0', r));
    const auto = mk('auto'); extra.push(auto); await auto.startLocalServer(0);
    r = await auto.setupHost('Auto Main', 18090, true);
    check('automatic setup skips a busy port', r.ok && r.address.endsWith(':18091'), r);
    await auto.shutdown(); blocker.close();

    // main computer changes address -> clients find it again by its ID
    const oldUrl = c1.cfg.host_url;
    await host.stopRole(); host.cfg = { ...host.cfg, port: 18082 }; await host.startRole();
    check('client follows the main computer to its new address', await wait(() => c1.cfg.host_url !== oldUrl && c1.cfg.host_url.endsWith(':18082'), 60), c1.cfg.host_url);
    check('...and syncing resumes', await wait(() => c1.agent.status.state === 'ok', 15), c1.agent.status);

    // a second main computer appears -> both notice
    const host2 = mk('host2'); extra.push(host2); await host2.startLocalServer(0);
    await host2.setupHost('Second Main', 18083);
    check('duplicate main computers are detected', await wait(() => host.conflict || host2.conflict, 15), { a: host.conflict, b: host2.conflict });
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of [host, c1, c2, ...extra]) await c.shutdown().catch(() => { });
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
