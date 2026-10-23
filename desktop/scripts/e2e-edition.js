'use strict';
// Headless test for the two builds: the server build is always the main computer, the client build never is.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.ARTEMA_DEFAULT_PORT = '18299';
process.env.ARTEMA_UDP_PORT = '41297';
const { Core } = require('../src/core');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-edition-e2e-'));
const WEB = path.join(__dirname, '..', 'web');
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const attempt = p => p.then(r => ({ ok: true, r }), e => ({ ok: false, message: e.message }));
const all = [];
const mk = (tag, edition) => {
  fs.mkdirSync(path.join(T, tag, 'desk'), { recursive: true });
  const c = new Core({ dataDir: path.join(T, tag, 'data'), webDir: WEB, desktopDir: path.join(T, tag, 'desk'), hooks: {}, edition });
  c.trustLoopback = false; all.push(c);
  return c;
};

(async () => {
  try {
    // ---- server build
    const S = mk('server', 'server');
    await S.startLocalServer(0); await S.startRole();
    check('server build starts with nothing set up', !S.configured && !S.startError);
    await S.ensureServer();
    check('server build sets itself up as the main computer', S.configured && S.cfg.role === 'host' && !!S.server && !S.startError, { cfg: S.cfg, err: S.startError });
    check('state says which build it is', S.state().edition === 'server' && S.state().role === 'host');
    const port = S.cfg.port, pin = S.getPin(), fp = S.tls.fingerprint, id = S.cfg.instance_id;
    check('server build cannot join another main computer', !(await attempt(S.join('127.0.0.1:1', 'x', 'AAAAA-AAAAA'))).ok);
    const auto = await attempt(S.autoSetup('AAAAA-AAAAA'));
    check('server build cannot auto-join either', !auto.ok || auto.r.action === 'already', auto);
    const fresh = new Core({ dataDir: path.join(T, 'unset', 'data'), webDir: WEB, desktopDir: path.join(T, 'unset', 'desk'), hooks: {}, edition: 'server' });
    check('...not even before it has been set up', !(await attempt(fresh.autoSetup('AAAAA-AAAAA'))).ok);
    await S.ensureServer();
    check('setting up twice changes nothing', S.cfg.port === port && S.getPin() === pin && S.tls.fingerprint === fp);

    // ---- an update is a restart on the same settings: identity, PIN and certificate must not move
    await S.stopRole();
    const S2 = new Core({ dataDir: S.dataDir, webDir: WEB, desktopDir: S.desktopDir, hooks: {}, edition: 'server' });
    all.push(S2); S2.trustLoopback = false;
    await S2.startLocalServer(0); await S2.startRole(); await S2.ensureServer();
    check('after an update the server keeps its port, PIN, id and certificate',
      S2.cfg.port === port && S2.getPin() === pin && S2.cfg.instance_id === id && S2.tls.fingerprint === fp && !!S2.server, { cfg: S2.cfg, err: S2.startError });

    // ---- client build
    const C = mk('client', 'client');
    await C.startLocalServer(0); await C.startRole(); await C.ensureServer();
    check('client build never sets itself up as a main computer', !C.configured && !C.server, C.cfg);
    check('client build cannot be made the main computer', !(await attempt(C.setupHost('Nope', 18290))).ok && !C.configured);
    const addr = `127.0.0.1:${port}`;
    const r = await attempt(C.join(addr, 'Office 1', pin));
    check('client build joins the server build', r.ok && C.cfg.role === 'client' && !!C.agent, r);
    check('client state says which build it is', C.state().edition === 'client' && C.state().role === 'client');

    // ---- settings left behind by the other kind of build are refused, not obeyed
    const W = mk('wrong-client', 'client');
    fs.mkdirSync(W.dataDir, { recursive: true });
    fs.writeFileSync(path.join(W.dataDir, 'config.json'), JSON.stringify({ role: 'host', name: 'Old', port: 18291, folder: path.join(T, 'wrong-client', 'desk', 'Artema Portal') }));
    W.cfg = JSON.parse(fs.readFileSync(path.join(W.dataDir, 'config.json'), 'utf8'));
    await W.startRole();
    check('client build refuses settings that make it a main computer', !W.server && /server version/.test(W.startError), W.startError);
    const V = mk('wrong-server', 'server');
    V.cfg = { role: 'client', name: 'Old', host_url: 'https://127.0.0.1:1' };
    await V.startRole(); await V.ensureServer();
    check('server build refuses settings that make it a connecting computer', !V.server && !V.agent && /connecting computer/.test(V.startError), V.startError);

    // ---- development runs (no edition) behave as before
    const D = mk('dev', 'any');
    await D.startLocalServer(0);
    check('a build with no edition can still choose', D.state().edition === 'any' && (await attempt(D.setupHost('Dev', 18292))).ok);
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of all) { try { await c.shutdown(); } catch { /* already stopped */ } }
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
