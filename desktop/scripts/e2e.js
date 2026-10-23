'use strict';
// Headless end-to-end test: one main computer + two connecting computers, all in this process.
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https'), http = require('http');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';    // the test's own fetch() calls talk to self-signed certificates (the app's pinned connections force verification on regardless)
process.env.ARTEMA_DEFAULT_PORT = '18099';      // keep discovery away from a real Portal that may be running on 8080
const { Core } = require('../src/core');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-node-e2e-'));
const WEB = path.join(__dirname, '..', 'web');
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, secs = 15) => { const end = Date.now() + secs * 1000; while (Date.now() < end) { if (await fn()) return true; await sleep(400); } return false; };
const ex = p => fs.existsSync(p);
const mk = (tag, hooks) => {
  fs.mkdirSync(path.join(T, tag, 'desk'), { recursive: true });
  const c = new Core({ dataDir: path.join(T, tag, 'data'), webDir: WEB, desktopDir: path.join(T, tag, 'desk'), hooks });
  c.trustLoopback = false;      // every request here comes from 127.0.0.1: switch the "person at the main computer" shortcut off so the real sign-in is what gets tested
  return c;
};
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
    const P = 'https://127.0.0.1:18081', hostDir = path.join(T, 'host', 'desk', 'Artema Portal');
    check('host folder + starter folders', ['To CNC', 'From CNC', 'Drawings', 'Photos'].every(n => ex(path.join(hostDir, n))));
    check('host info', (await (await fetch(P + '/api/info')).json()).name === 'CNC Shop');
    const PIN = host.getPin();
    check('host has a join PIN', /^[A-Z2-9]{10}$/.test(PIN), PIN);
    // a browser signs in with the PIN and gets a cookie
    r = await fetch(P + '/api/register', { method: 'POST', body: JSON.stringify({ web: true, name: 'Ben', pin: PIN }), headers: { 'X-Device': 'Ben', 'Content-Type': 'application/json' } });
    check('browser sign-in with the PIN', r.status === 200, r.status);
    const setCookie = r.headers.get('set-cookie') || '';
    check('sign-in cookie is HttpOnly, Secure and SameSite=Strict', /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie);
    const cookie = setCookie.split(';')[0];
    const H = (extra = {}) => ({ 'X-Device': 'Ben', Cookie: cookie, ...extra });
    r = await fetch(P + '/'); check('portal UI served', r.status === 200 && (await r.text()).includes('Artema Portal'));
    for (const f of ['portal.js', 'portal.css', 'theme.css', 'assets/logo-light.webp']) check('static ' + f, (await fetch(P + '/' + f)).status === 200);
    check('traversal blocked (static)', (await fetch(P + '/..%2f..%2fpackage.json')).status === 404);
    check('traversal blocked (api)', (await fetch(P + '/api/file?path=../../x', { headers: H() })).status === 400);

    r = await c1.probe('127.0.0.1:18081'); check('probe finds host', r && r.name === 'CNC Shop' && r.fp.length === 64, r);
    r = await c1.join('127.0.0.1:18081', 'Boss Office', PIN); check('client 1 join', r.ok, r);
    r = await c2.join('127.0.0.1:18081', 'boss office', PIN).then(() => ({ ok: true }), e => ({ ok: false, e: e.message })); check('duplicate name rejected', !r.ok, r);
    r = await c2.join('127.0.0.1:18081', 'Cutting Room', PIN); check('client 2 join', r.ok, r);
    const d1 = path.join(T, 'c1', 'desk', 'Artema Portal'), d2 = path.join(T, 'c2', 'desk', 'Artema Portal');
    check('clients get starter folders', await wait(() => ex(path.join(d1, 'To CNC')) && ex(path.join(d2, 'Photos'))));

    fs.writeFileSync(path.join(d1, 'To CNC', 'door.dxf'), '0\nSECTION\n'.repeat(500)); touch(path.join(d1, 'To CNC', 'door.dxf'), 30);
    check('c1 -> host', await wait(() => ex(path.join(hostDir, 'To CNC', 'door.dxf'))));
    check('host -> c2', await wait(() => ex(path.join(d2, 'To CNC', 'door.dxf'))));
    check('content identical', fs.readFileSync(path.join(d2, 'To CNC', 'door.dxf')).equals(fs.readFileSync(path.join(d1, 'To CNC', 'door.dxf'))));
    check('host notified of incoming file', incoming.some(([w, n]) => w === 'Boss Office' && n === 'door.dxf'), incoming);

    // browser upload (with unicode name), then both clients get it and c1 is notified
    r = await fetch(P + '/api/file?path=' + encodeURIComponent('From CNC/note é.txt') + '&mtime=' + (Math.floor(Date.now() / 1000) - 60),
      { method: 'PUT', body: 'hello from the browser', headers: H() });
    check('web upload', r.status === 200);
    check('upload reaches both clients', await wait(() => ex(path.join(d1, 'From CNC', 'note é.txt')) && ex(path.join(d2, 'From CNC', 'note é.txt'))));
    check('c1 got a "received" notification from Ben', received.some(x => x.by === 'Ben' && x.name === 'note é.txt'), received);
    const lst = await (await fetch(P + '/api/list?path=From%20CNC', { headers: H() })).json();
    check('added-by recorded', lst.items.some(i => i.name.startsWith('note') && i.by === 'Ben'), lst);
    check('search', (await (await fetch(P + '/api/search?q=door%20dxf', { headers: H() })).json()).items.some(i => i.name === 'door.dxf'));
    check('search no match', (await (await fetch(P + '/api/search?q=zzzz', { headers: H() })).json()).items.length === 0);
    const dl = await fetch(P + '/api/file?path=To%20CNC/door.dxf', { headers: H() }); check('download', dl.status === 200 && Buffer.from(await dl.arrayBuffer()).equals(fs.readFileSync(path.join(hostDir, 'To CNC', 'door.dxf'))));

    await sleep(2200); fs.writeFileSync(path.join(d2, 'To CNC', 'door.dxf'), 'edited by c2 '.repeat(100));
    check('edit c2 -> c1', await wait(() => fs.readFileSync(path.join(d1, 'To CNC', 'door.dxf'), 'utf8').startsWith('edited by c2')));
    fs.mkdirSync(path.join(d1, 'Drawings', 'Job 12')); await sleep(2200); fs.writeFileSync(path.join(d1, 'Drawings', 'Job 12', 'a.pdf'), '%PDF'.repeat(10));
    check('nested folder reaches c2', await wait(() => ex(path.join(d2, 'Drawings', 'Job 12', 'a.pdf'))));
    fs.unlinkSync(path.join(d1, 'To CNC', 'door.dxf'));
    check('delete c1 -> host & c2', await wait(() => !ex(path.join(hostDir, 'To CNC', 'door.dxf')) && !ex(path.join(d2, 'To CNC', 'door.dxf'))));
    const inTrash = (function walk(d) { return ex(d) && fs.readdirSync(d, { withFileTypes: true }).some(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name === 'door.dxf'); })(path.join(hostDir, '.trash'));
    check('deleted copy kept in trash', inTrash);
    check('trash not synced to clients', !ex(path.join(d1, '.trash')));
    r = await fetch(P + '/api/move', { method: 'POST', body: JSON.stringify({ from: 'Drawings/Job 12', to: 'Drawings/Job 13' }), headers: H() });
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
    const dv = (await (await fetch(P + '/api/devices', { headers: H() })).json()).devices; const on = Object.fromEntries(dv.map(d => [d.name, d.online]));
    check('devices online', on['Boss Office'] && on['Cutting Room'], on);
    check('activity feed', (await (await fetch(P + '/api/activity', { headers: H() })).json()).items.length >= 3);

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
    check('new PC finds the main computer and asks only for the PIN', r.action === 'needs-pin' && !c3.configured, r);
    r = await c3.autoSetup('AAAAA-AAAAA').then(x => x, e => ({ action: 'error', message: e.message }));
    check('a wrong PIN is refused with a plain message', r.action === 'error' && /PIN/.test(r.message) && !c3.configured, r);
    r = await c3.autoSetup(PIN);
    check('...and with the PIN it joins by itself', r.action === 'joined' && c3.configured, r);
    check('auto-joined PC got its folder and starter folders', await wait(() => ex(path.join(T, 'c3', 'desk', 'Artema Portal', 'To CNC'))));
    check('configured PC never auto-sets-up again', (await c3.autoSetup()).action === 'already');
    const solo = mk('solo'); extra.push(solo); await solo.startLocalServer(0); solo.discover = async () => [];
    check('first PC on an empty network is told it is first', (await solo.autoSetup()).action === 'none');

    const c4 = mk('c4'); extra.push(c4); await c4.startLocalServer(0);
    await c4.join('127.0.0.1:18081', 'Router CNC 2', PIN);
    let devs = (await (await fetch(P + '/api/devices', { headers: H() })).json()).devices;
    check('tag guessed from the name (CNC)', (devs.find(d => d.name === 'Router CNC 2') || {}).tag === 'CNC', devs);
    const id4 = devs.find(d => d.name === 'Router CNC 2').id;
    r = await fetch(P + '/api/devices/tag', { method: 'POST', body: JSON.stringify({ id: id4, tag: 'Edgebander' }), headers: H() });
    check('a signed-in browser cannot change computers (main computer only)', r.status === 403, r.status);
    host.trustLoopback = true;          // now act as the person sitting at the main computer
    r = await fetch(P + '/api/devices/tag', { method: 'POST', body: JSON.stringify({ id: id4, tag: 'Edgebander' }), headers: { 'X-Device': 'Main' } });
    host.trustLoopback = false;
    devs = (await (await fetch(P + '/api/devices', { headers: H() })).json()).devices;
    check('tag can be edited at the main computer', r.status === 200 && (devs.find(d => d.id === id4) || {}).tag === 'Edgebander', r.status);

    // ---- hardening
    const { request } = require('../src/util');
    let crashed = false; const onUnc = () => { crashed = true; }; process.on('uncaughtException', onUnc);
    const rej = await request('PUT', P + '/api/file?path=x.bin', { headers: { 'Content-Length': '10', 'X-Device': 't', Cookie: cookie }, body: fs.createReadStream(path.join(T, 'does-not-exist')) }).then(() => 'resolved', () => 'rejected');
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
    r = await c2.join('127.0.0.1:18095', 'Cutting Room', hostB.getPin()); check('client joins a different main computer', r.ok, r);
    await sleep(9000);
    check('old sync memory from another main computer does not delete local files', ex(path.join(d2, 'memory-3.txt')) && ex(path.join(d2, 'Drawings', 'Job 13', 'a.pdf')));
    check('...they are shared to the new main computer instead', await wait(() => ex(path.join(hostBDir, 'memory-3.txt')), 12));

    // something else answering at the old address (a different main computer) must not be mirrored
    const hostC = mk('hostC'); extra.push(hostC); await hostC.startLocalServer(0); await hostC.setupHost('Host C', 18096);
    const clC = mk('clC'); extra.push(clC); await clC.startLocalServer(0); await clC.join('127.0.0.1:18096', 'Client C', hostC.getPin());
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
    const badHost = await new Promise(res => { const rq = https.request({ host: '127.0.0.1', port: 18081, path: '/api/info', headers: { Host: 'evil.example.com' }, rejectUnauthorized: false }, rs => { rs.resume(); res(rs.statusCode); }); rq.on('error', () => res(0)); rq.end(); });
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

    // =====================================================================================================
    // ---- security: sign-in, PIN, certificate pinning, secrets at rest, upload hardening
    // =====================================================================================================
    const { joinProof, loadOrCreateCert } = require('../src/security');
    const { TLS_IDENTITY_ERRORS } = require('../src/util');
    const sealHooks = { seal: t => 'sealed:' + Buffer.from(t).toString('base64'), unseal: t => (String(t).startsWith('sealed:') ? Buffer.from(String(t).slice(7), 'base64').toString() : '') };
    const hs = mk('sec', sealHooks); extra.push(hs); await hs.startLocalServer(0);
    await hs.setupHost('Sec Host', 18110);
    const S = 'https://127.0.0.1:18110', hsDir = path.join(T, 'sec', 'desk', 'Artema Portal');
    const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', body: JSON.stringify(body), headers: { 'X-Device': 'T', 'Content-Type': 'application/json', ...headers } });

    // nothing is reachable without signing in
    const closed = ['/api/list?path=', '/api/tree', '/api/devices', '/api/activity', '/api/search?q=a', '/api/file?path=x', '/api/me', '/api/pin'];
    const codes = []; for (const p of closed) codes.push((await fetch(S + p)).status);
    check('every data endpoint answers 401 without signing in', codes.every(c => c === 401), codes);
    check('writes are refused without signing in', (await post(S, '/api/delete', { path: 'To CNC' })).status === 401 && (await fetch(S + '/api/file?path=x.txt', { method: 'PUT', body: 'hi', headers: { 'X-Device': 'x' } })).status === 401);
    check('a made-up bearer token is refused', (await fetch(S + '/api/tree', { headers: { Authorization: 'Bearer nope' } })).status === 401);
    check('a made-up cookie is refused', (await fetch(S + '/api/tree', { headers: { Cookie: 'artema_token=nope' } })).status === 401);
    const pub = await (await fetch(S + '/api/info')).json();
    check('public info reveals no folder path, address or admin flag', !('folder' in pub) && !('ip' in pub) && !('local' in pub) && pub.tls === true, pub);

    // browser hardening headers
    r = await fetch(S + '/');
    check('security headers on the pages', r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY' && /script-src 'self'/.test(r.headers.get('content-security-policy') || '') && r.headers.get('referrer-policy') === 'no-referrer');
    check('no inline scripts or handlers in the Portal page (the policy would block them)', !/<script(?![^>]*\bsrc=)/i.test(await r.text()) && !/\son(error|click|load)=/i.test(fs.readFileSync(path.join(WEB, 'portal.js'), 'utf8').replace(/\.on(error|click|load) =/g, '')));
    check('API answers are never cached', (await fetch(S + '/api/info')).headers.get('cache-control') === 'no-store');
    await new Promise(res => { const rq = http.request({ host: '127.0.0.1', port: 18110, path: '/api/info' }, rs => { rs.resume(); res(); }); rq.on('error', () => { check('plain http to the Portal port is not served', true); res(); }); rq.setTimeout(2000, () => { rq.destroy(); }); rq.end(); });

    // the PIN
    const fp = hs.tls.fingerprint;
    check('wrong PIN refused', (await post(S, '/api/register', { name: 'Intruder', pin: 'AAAAA-AAAAA' })).status === 403);
    check('proof made for a different certificate refused (what a man-in-the-middle would produce)', (await post(S, '/api/register', { name: 'Intruder', proof: joinProof(hs.getPin(), 'ab'.repeat(32)) })).status === 403);
    r = await post(S, '/api/register', { name: 'Proof PC', proof: joinProof(hs.getPin(), fp) });
    const reg = await r.json();
    check('proof for this certificate accepted, token issued', r.status === 200 && reg.token && reg.token.length >= 40 && reg.id, reg);
    r = await fetch(S + '/api/me', { headers: { Authorization: `Bearer ${reg.token}` } });
    check('the issued token signs in as that computer', r.status === 200 && (await r.json()).kind === 'device');
    const devJson = fs.readFileSync(path.join(T, 'sec', 'data', 'devices.json'), 'utf8');
    check('the main computer stores only a hash of the token', !devJson.includes(reg.token) && /"th":"[0-9a-f]{64}"/.test(devJson));

    // secrets at rest
    const cfgText = fs.readFileSync(hs.cfgPath, 'utf8');
    check('PIN is sealed in the config file', !cfgText.includes(hs.getPin()) && cfgText.includes('join_pin_enc') && !cfgText.includes('"join_pin"'), cfgText);
    check('certificate private key is sealed, not left as a plain file', fs.existsSync(path.join(T, 'sec', 'data', 'tls', 'key.sealed')) && !fs.existsSync(path.join(T, 'sec', 'data', 'tls', 'key.pem')));
    if (process.platform !== 'win32') {
      const priv = f => (fs.statSync(f).mode & 0o077) === 0;
      check('config, device list and key files are readable by this user only', priv(host.cfgPath) && priv(path.join(T, 'host', 'data', 'devices.json')) && priv(path.join(T, 'host', 'data', 'tls', 'key.pem')));
    }

    // brute force: its own main computer, because the lock-out is per address
    const hd = mk('brute'); extra.push(hd); await hd.startLocalServer(0); await hd.setupHost('Brute Host', 18111);
    const B = 'https://127.0.0.1:18111', bad = [];
    for (let i = 0; i < 10; i++) bad.push((await post(B, '/api/register', { name: 'x', pin: 'WRONGWRONG' })).status);
    check('ten wrong PINs are each refused', bad.every(c => c === 403), bad);
    r = await post(B, '/api/register', { name: 'x', pin: hd.getPin() });
    check('after that the address is locked out, even with the right PIN', r.status === 429, r.status);

    // signed-in browser: uploads can never run anything
    r = await post(S, '/api/register', { web: true, name: 'Sec Ben', pin: hs.getPin() });
    const sc = (r.headers.get('set-cookie') || '').split(';')[0], SH = (x = {}) => ({ 'X-Device': 'Ben', Cookie: sc, ...x });
    check('web session works', (await (await fetch(S + '/api/me', { headers: SH() })).json()).kind === 'web');
    const put = (rel, body, headers = {}) => fetch(S + '/api/file?path=' + encodeURIComponent(rel) + '&mtime=' + (Math.floor(Date.now() / 1000) - 60), { method: 'PUT', body, headers: SH(headers) });
    await put('pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    r = await fetch(S + '/api/file?path=pic.svg&inline=1', { headers: SH() });
    check('an uploaded SVG is never opened inline and is sandboxed', /^attachment/.test(r.headers.get('content-disposition')) && r.headers.get('content-security-policy') === 'sandbox' && r.headers.get('x-content-type-options') === 'nosniff', [...r.headers]);
    await put('note.txt', 'hello');
    r = await fetch(S + '/api/file?path=note.txt&inline=1', { headers: SH() });
    check('plain text may show inline but sandboxed', /^inline/.test(r.headers.get('content-disposition')) && r.headers.get('content-security-policy') === 'sandbox');
    await put('doc.pdf', '%PDF-1.4 test');
    r = await fetch(S + '/api/file?path=doc.pdf&inline=1', { headers: SH() });
    check('PDF still previews inline', /^inline/.test(r.headers.get('content-disposition')) && !/sandbox/.test(r.headers.get('content-security-policy') || ''));
    r = await new Promise(res => { const rq = https.request({ host: '127.0.0.1', port: 18110, method: 'PUT', path: '/api/file?path=chunk.bin', rejectUnauthorized: false, headers: { 'X-Device': 'Ben', Cookie: sc, 'Transfer-Encoding': 'chunked' } }, rs => { rs.resume(); res(rs.statusCode); }); rq.on('error', () => res(0)); rq.write('abc'); rq.end(); });
    check('an upload that does not say its size is refused', r === 411, r);
    check('Windows device names are refused (CON, NUL)', (await put('CON.txt', 'x')).status === 400 && (await put('folder/nul', 'x')).status === 400);
    hs.store.maxUpload = 10; r = await put('big.bin', 'x'.repeat(11)); hs.store.maxUpload = 8 * 1024 ** 3;
    check('an upload over the size limit is refused', r.status === 413, r.status);
    if (process.platform !== 'win32') {
      let linked = true; try { fs.symlinkSync(os.tmpdir(), path.join(hsDir, 'escape')); } catch { linked = false; }
      if (linked) {
        check('a shortcut pointing outside the shared folder cannot be listed', (await fetch(S + '/api/list?path=escape', { headers: SH() })).status === 400);
        check('...or written through', (await put('escape/evil.txt', 'x')).status === 400 && !fs.existsSync(path.join(os.tmpdir(), 'evil.txt')));
        fs.unlinkSync(path.join(hsDir, 'escape'));
      }
    }

    // only the person at the main computer manages computers and the PIN
    const adm = [];
    for (const [ep, body] of [['devices/remove', { id: reg.id }], ['devices/tag', { id: reg.id, tag: 'x' }], ['pin/rotate', {}], ['reveal', { path: '' }]]) adm.push((await post(S, '/api/' + ep, body, SH())).status);
    adm.push((await fetch(S + '/api/pin', { headers: SH() })).status);
    check('a signed-in browser cannot remove/tag computers, see or change the PIN, or open folders on the main computer', adm.every(c => c === 403), adm);
    const bearerAdm = (await post(S, '/api/devices/remove', { id: reg.id }, { Authorization: `Bearer ${reg.token}` })).status;
    check('...and neither can a joined computer', bearerAdm === 403, bearerAdm);

    // a joined computer syncs with its token; removing it locks it out; its files stay
    const cs = mk('sec-c1'); extra.push(cs); await cs.startLocalServer(0);
    r = await cs.join('127.0.0.1:18110', 'Sec Client', 'WRONG-WRONG').then(() => 'joined', e => e.message);
    check('joining with the wrong PIN gives a plain message', /PIN/.test(r), r);
    await cs.join('127.0.0.1:18110', 'Sec Client', hs.getPin());
    const csDir = path.join(T, 'sec-c1', 'desk', 'Artema Portal');
    check('client holds a sealed or private token, never a bare one next to the PIN', !!cs.secret('device_token') && !fs.readFileSync(cs.cfgPath, 'utf8').includes(cs.secret('device_token')) === !!cs.cfg.device_token_enc || !!cs.cfg.device_token);
    check('joined computer syncs using its token', await wait(() => cs.agent && cs.agent.status.state === 'ok' && ex(path.join(csDir, 'note.txt')), 20), cs.agent && cs.agent.status);
    const csToken = cs.secret('device_token');
    const csId = cs.cfg.device_id;
    hs.trustLoopback = true;
    r = await post(S, '/api/devices/remove', { id: csId });
    const shownPin = await (await fetch(S + '/api/pin')).json();
    check('the main computer can show its PIN', /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(shownPin.pin) && r.status === 200, shownPin);
    hs.trustLoopback = false;
    check('a removed computer\'s token stops working', (await fetch(S + '/api/tree', { headers: { Authorization: `Bearer ${csToken}` } })).status === 401);
    check('a removed computer is told so, and keeps its files', await wait(() => /no longer/.test(cs.agent.status.message), 20) && ex(path.join(csDir, 'note.txt')), cs.agent.status);

    // a new PIN: old one dead, browsers sign in again, computers stay
    const csb = mk('sec-c2'); extra.push(csb); await csb.startLocalServer(0);
    await csb.join('127.0.0.1:18110', 'Sec Client B', hs.getPin());
    const oldPin = hs.getPin();
    hs.trustLoopback = true; r = await (await post(S, '/api/pin/rotate', {})).json(); hs.trustLoopback = false;
    check('a new PIN is made', /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(r.pin) && hs.getPin() !== oldPin, r);
    check('the old PIN no longer works', (await post(S, '/api/register', { name: 'Late', pin: oldPin })).status === 403);
    check('browsers that signed in with the old PIN must sign in again', (await fetch(S + '/api/me', { headers: SH() })).status === 401);
    check('computers already joined keep working after a new PIN', await wait(() => csb.agent.status.state === 'ok', 15), csb.agent.status);

    // the certificate: a client trusts exactly the one it saw when it joined
    const rogueDir = path.join(T, 'rogue'); const rc = await loadOrCreateCert(rogueDir, {});
    let rogueHits = 0; const rogue = https.createServer({ key: rc.key, cert: rc.cert }, (q, a) => { rogueHits++; a.end('{}'); });
    await new Promise(res => rogue.listen(18113, '127.0.0.1', res));
    const { request: rawRequest } = require('../src/util');
    r = await rawRequest('GET', 'https://127.0.0.1:18113/api/tree', { headers: { Authorization: `Bearer ${csb.secret('device_token')}` }, ca: csb.cfg.host_cert }).then(() => 'connected', e => e.code);
    check('a look-alike with a different certificate is refused before any token is sent', TLS_IDENTITY_ERRORS.has(r) && rogueHits === 0, { r, rogueHits });
    rogue.close();
    const before = hs.tls.fingerprint;
    await hs.stopRole(); fs.rmSync(path.join(T, 'sec', 'data', 'tls'), { recursive: true, force: true }); await hs.startRole();     // the main computer now has a different certificate
    check('(the main computer really did get a new certificate)', hs.tls && hs.tls.fingerprint !== before);
    check('a client whose pinned certificate no longer matches stops, and says why', await wait(() => csb.agent.status.state === 'offline' && /certificate/.test(csb.agent.status.message), 20), csb.agent.status);
    check('...and its files are untouched', ex(path.join(T, 'sec-c2', 'desk', 'Artema Portal', 'note.txt')));

    // a main computer from before encryption is recognised, not just "not found"
    const oldMain = http.createServer((q, a) => { a.setHeader('Content-Type', 'application/json'); a.end(JSON.stringify({ app: 'Artema Portal', name: 'Old Main' })); });
    await new Promise(res => oldMain.listen(18112, '127.0.0.1', res));
    const co = mk('sec-c3'); extra.push(co); await co.startLocalServer(0);
    r = await co.join('127.0.0.1:18112', 'New PC', 'ABCDE-FGHJK').then(() => 'joined', e => e.message);
    check('joining a main computer that has not been updated explains what to do', /older version/.test(r), r);
    oldMain.close();


  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of [host, c1, c2, ...extra]) await c.shutdown().catch(() => { });
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
