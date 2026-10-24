'use strict';
// Headless test for the "two main computers" and "security certificate changed" situations, all in this process.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.ARTEMA_DEFAULT_PORT = '18199';      // keep discovery away from a real Portal that may be running on this machine
process.env.ARTEMA_UDP_PORT = '41299';
const { Core } = require('../src/core');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-cert-e2e-'));
const WEB = path.join(__dirname, '..', 'web');
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, secs = 15) => { const end = Date.now() + secs * 1000; while (Date.now() < end) { if (await fn()) return true; await sleep(400); } return false; };
const mk = tag => {
  fs.mkdirSync(path.join(T, tag, 'desk'), { recursive: true });
  const c = new Core({ dataDir: path.join(T, tag, 'data'), webDir: WEB, desktopDir: path.join(T, tag, 'desk'), hooks: {} });
  c.trustLoopback = false;
  return c;
};
const attempt = p => p.then(r => ({ ok: true, r }), e => ({ ok: false, message: e.message }));
const newCert = async c => { await c.stopRole(); fs.rmSync(path.join(c.dataDir, 'tls'), { recursive: true, force: true }); await c.startRole(); };

(async () => {
  const all = [];
  const mkc = tag => { const c = mk(tag); all.push(c); return c; };
  try {
    const A = mkc('A'), B = mkc('B'), C1 = mkc('C1'), C2 = mkc('C2'), C3 = mkc('C3'), C4 = mkc('C4');
    for (const c of all) await c.startLocalServer(0);
    await A.setupHost('Host A', 18101); await B.setupHost('Host B', 18102);
    const pa = A.getPin(), pb = B.getPin(), addrA = '127.0.0.1:18101', addrB = '127.0.0.1:18102';

    // ---- a computer on a network with two main computers joins the one whose PIN it was given
    C1.discover = async () => [await C1.probe(addrB), await C1.probe(addrA)];      // B answers first
    let r = await attempt(C1.autoSetup(pa));
    check('two main computers: the PIN picks the right one', r.ok && r.r.action === 'joined' && C1.cfg.host_url.endsWith(':18101'), r);
    C2.discover = async () => [await C2.probe(addrA), await C2.probe(addrB)];
    r = await attempt(C2.autoSetup(pb));
    check('two main computers: works whichever answers first', r.ok && r.r.action === 'joined' && C2.cfg.host_url.endsWith(':18102'), r);
    C3.discover = async () => [await C3.probe(addrA), await C3.probe(addrB)];
    r = await attempt(C3.autoSetup('AAAAA-AAAAA'));
    check('two main computers: a wrong PIN still gets the plain PIN message', !r.ok && /PIN/.test(r.message) && !C3.configured, r);

    // ---- a pinned connection talks to the pinned certificate and to nothing else
    // (Electron's TLS library does not accept a self-signed server certificate as a trust anchor, so the pin is an exact comparison)
    const { loadOrCreateCert } = require('../src/security'), { request, readAll } = require('../src/util'), tlsLib = require('tls');
    const rogue = await loadOrCreateCert(path.join(T, 'rogue'), {});
    let leaked = '';
    const rogueServer = tlsLib.createServer({ key: rogue.key, cert: rogue.cert }, s => { s.on('data', d => { leaked += d; }); s.on('error', () => { }); });
    await new Promise(res => rogueServer.listen(0, '127.0.0.1', res));
    const rogueErr = await request('GET', `https://127.0.0.1:${rogueServer.address().port}/api/x`, { headers: { Authorization: 'Bearer SECRET-TOKEN' }, ca: A.tls.cert, timeout: 4000 }).then(() => null, e => e);
    await sleep(300); rogueServer.close();
    check('a pinned connection refuses any other certificate', rogueErr && rogueErr.code === 'CERT_MISMATCH', rogueErr && rogueErr.code);
    check('...and never sends it the request or the token', leaked === '', leaked);
    const pinnedOk = await request('GET', `https://${addrA}/api/info`, { ca: A.tls.cert, timeout: 4000 });
    check('...but talks normally to the pinned one', pinnedOk.statusCode === 200 && JSON.parse((await readAll(pinnedOk)).toString()).name === 'Host A');

    // ---- a main computer that gets a new certificate in the middle of a join
    const realProbe = C3.probe.bind(C3);
    let swaps = 0;
    C3.probe = async addr => { const p = await realProbe(addr); if (swaps++ === 0) await newCert(A); return p; };
    r = await attempt(C3.join(addrA, 'Office 3', A.getPin()));
    check('certificate swapped mid-join: the join is retried and succeeds', r.ok && C3.configured && swaps === 2, r);

    // ---- a restart that keeps the certificate changes nothing
    const fp = A.tls.fingerprint;
    await A.stopRole(); await A.startRole();
    check('restart keeps the same certificate', A.tls.fingerprint === fp);

    // ---- a certificate that has to be replaced is never replaced silently: the old one is kept and the log says why
    const tlsDir = path.join(A.dataDir, 'tls');
    await A.stopRole();
    for (const f of ['key.pem', 'key.sealed']) fs.rmSync(path.join(tlsDir, f), { force: true });      // the key is gone, the certificate is still there
    await A.startRole();
    check('a certificate whose key is lost is replaced', A.tls.fingerprint !== fp);
    check('...and the old certificate is kept', fs.readdirSync(tlsDir).some(f => /^cert\.replaced-/.test(f)), fs.readdirSync(tlsDir));

    // ---- computers that joined before the replacement say what to do
    check('computer pinned to the old certificate says to reconnect with the PIN',
      await wait(() => C1.agent && C1.agent.status.state === 'offline' && /Reconnect this computer.*PIN/.test(C1.agent.status.message), 20), C1.agent && C1.agent.status);
    r = await attempt(C1.join(addrA, 'Office 1', A.getPin()));
    check('...and reconnecting with the PIN works', r.ok && await wait(() => C1.agent && C1.agent.status.state === 'ok', 15), r);
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of all) { try { await c.stopRole(); } catch { /* already stopped */ } }
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
