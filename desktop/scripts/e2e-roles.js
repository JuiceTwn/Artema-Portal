'use strict';
// Headless test for roles: general < admin < dev, assigned per computer, kept in SQLite.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';      // this test's own fetch() calls talk to self-signed certificates
process.env.ARTEMA_DEFAULT_PORT = '18399';
process.env.ARTEMA_UDP_PORT = '41396';
const { Core } = require('../src/core');
const { RoleStore, can, canAssign, ROLES } = require('../src/roles');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-roles-e2e-'));
const WEB = path.join(__dirname, '..', 'web');
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const all = [];
const mk = tag => {
  fs.mkdirSync(path.join(T, tag, 'desk'), { recursive: true });
  const c = new Core({ dataDir: path.join(T, tag, 'data'), webDir: WEB, desktopDir: path.join(T, tag, 'desk'), hooks: {} });
  c.trustLoopback = false; all.push(c);
  return c;
};

(async () => {
  try {
    // ---- the rules themselves
    check('roles run general < admin < dev', ROLES.join() === 'general,admin,dev');
    check('general can do none of the restricted things', !['pin.view', 'pin.rotate', 'devices.tag', 'devices.remove', 'devices.role', 'files.reveal'].some(a => can('general', a)));
    check('admin can manage computers but not reveal folders', can('admin', 'devices.role') && can('admin', 'pin.rotate') && !can('admin', 'files.reveal'));
    check('dev can do everything', can('dev', 'files.reveal') && can('dev', 'devices.role'));
    check('unknown roles can do nothing restricted, unknown actions are open', !can('boss', 'pin.view') && can('boss', 'files.list'));
    check('nobody hands out a role above their own', canAssign('admin', 'general', 'admin') && !canAssign('admin', 'general', 'dev') && !canAssign('admin', 'dev', 'general') && canAssign('dev', 'admin', 'dev') && !canAssign('general', 'general', 'general'));

    // ---- a main computer and three joined computers
    const H = mk('host'), A = mk('a'), B = mk('b'), G = mk('g');
    for (const c of all) await c.startLocalServer(0);
    await H.setupHost('Host', 18301);
    const pin = H.getPin(), P = 'https://127.0.0.1:18301';
    for (const [c, n] of [[A, 'Office A'], [B, 'Office B'], [G, 'Floor G']]) await c.join('127.0.0.1:18301', n, pin);
    const ids = {}; for (const [k, c] of [['a', A], ['b', B], ['g', G]]) ids[k] = c.cfg.device_id;
    const as = c => ({ Authorization: 'Bearer ' + c.secret('device_token'), 'X-Device': 'test', 'Content-Type': 'application/json' });
    const call = async (who, method, ep, body) => {
      H.trustLoopback = who === 'host';
      try {
        const r = await fetch(P + '/api/' + ep, { method, headers: who === 'host' ? { 'X-Device': 'host', 'Content-Type': 'application/json' } : as(who), body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      } finally { H.trustLoopback = false; }
    };

    let r = await call(G, 'GET', 'me');
    check('a newly joined computer is general', r.status === 200 && r.body.role === 'general', r);
    check('...and the main computer itself is dev', (await call('host', 'GET', 'me')).body.role === 'dev');
    check('general cannot see the PIN', (await call(G, 'GET', 'pin')).status === 403);
    check('general cannot make a new PIN', (await call(G, 'POST', 'pin/rotate', {})).status === 403);
    check('general cannot remove or retag a computer', (await call(G, 'POST', 'devices/remove', { id: ids.a })).status === 403 && (await call(G, 'POST', 'devices/tag', { id: ids.a, tag: 'x' })).status === 403);
    check('general cannot assign roles', (await call(G, 'POST', 'devices/role', { id: ids.g, role: 'dev' })).status === 403);
    check('general still has the ordinary file features', (await call(G, 'GET', 'list')).status === 200 && (await call(G, 'GET', 'devices')).status === 200);

    // ---- stations: which board tabs a computer opens on (assigned from the Computers screen)
    r = await call('host', 'GET', 'devices'); const choices = r.body.stationChoices || [];
    check('the computers list offers the stations that can be assigned', r.status === 200 && choices.length >= 1 && choices.every(c => c.id && c.name), r.body.stationChoices);
    const st0 = choices[0].id;
    check('general cannot assign stations', (await call(G, 'POST', 'devices/stations', { id: ids.g, stations: [st0] })).status === 403);
    check('the main computer can', (await call('host', 'POST', 'devices/stations', { id: ids.g, stations: [st0] })).status === 200);
    r = await call(G, 'GET', 'me'); check('the computer is told its stations on the very next request', JSON.stringify(r.body.stations) === JSON.stringify([st0]), r.body);
    check('an unknown station is refused', (await call('host', 'POST', 'devices/stations', { id: ids.g, stations: [999999] })).status === 400);
    check('an unknown computer is a clean 404', (await call('host', 'POST', 'devices/stations', { id: 'nope', stations: [] })).status === 404);
    check('another computer is not told someone else\'s stations', (await call(B, 'GET', 'me')).body.stations.length === 0);
    r = await call('host', 'GET', 'devices'); check('the list shows who has which', r.body.devices.find(d => d.id === ids.g).stations.join() === String(st0));
    check('clearing them leaves the computer with none', (await call('host', 'POST', 'devices/stations', { id: ids.g, stations: [] })).status === 200 && (await call(G, 'GET', 'me')).body.stations.length === 0);

    // ---- what a component looks like and where it is kept: admins and the Office department, not the floor
    r = await call(G, 'POST', 'jobs/partinfo/save', { name: 'Mullcaps', location: 'Rack 3', dept: 'Office' });
    check('general cannot edit where a component is kept', r.status === 403, r);
    check('...but can read it', (await call(G, 'GET', 'jobs/partinfo?name=Mullcaps')).status === 200);
    check('the main computer can', (await call('host', 'POST', 'jobs/partinfo/save', { name: 'Mullcaps', location: 'Rack 3', dept: 'Office' })).status === 200);
    check('general sees it', (await call(G, 'GET', 'jobs/partinfo?name=Mullcaps')).body.location === 'Rack 3');
    check('a computer is told whether it may edit', (await call(G, 'GET', 'me')).body.partsEdit === false && (await call('host', 'GET', 'me')).body.partsEdit === true);
    check('an admin has Office, so an admin computer may', (await call('host', 'POST', 'devices/role', { id: ids.a, role: 'admin' })).status === 200 && (await call(A, 'POST', 'jobs/partinfo/save', { name: 'Glass stop', location: 'Rack 9', dept: 'Office' })).status === 200);
    check('a floor computer an admin has put in the Office department may too', (await call('host', 'POST', 'devices/department', { id: ids.g, dept: 'Office' })).status === 200 && (await call(G, 'POST', 'jobs/partinfo/save', { name: 'Glass stop', location: 'Rack 10', dept: 'Office' })).status === 200 && (await call(G, 'GET', 'me')).body.partsEdit === true);
    check('…and not when it goes back to another department', (await call('host', 'POST', 'devices/department', { id: ids.g, dept: 'Paint' })).status === 200 && (await call(G, 'POST', 'jobs/partinfo/save', { name: 'Glass stop', location: 'x', dept: 'Office' })).status === 403);
    check('a computer named for the office starts in Office, so it may', (await call(B, 'POST', 'jobs/partinfo/save', { name: 'Glass stop', location: 'y', dept: 'Office' })).status === 200);
    await call('host', 'POST', 'devices/role', { id: ids.a, role: 'general' });

    // ---- the main computer promotes
    check('the main computer can make a computer admin', (await call('host', 'POST', 'devices/role', { id: ids.a, role: 'admin' })).status === 200);
    r = await call(A, 'GET', 'me'); check('the change applies on the very next request', r.body.role === 'admin', r);
    r = await call(G, 'GET', 'devices'); const row = r.body.devices.find(d => d.id === ids.a);
    check('the device list shows each role', row && row.role === 'admin' && r.body.devices.find(d => d.host).role === 'dev' && r.body.devices.find(d => d.id === ids.g).role === 'general', r.body.devices);

    // ---- what an admin can and cannot do
    check('admin can see the PIN and make a new one', (await call(A, 'GET', 'pin')).status === 200 && (await call(A, 'POST', 'pin/rotate', {})).status === 200);
    check('admin can make another computer admin', (await call(A, 'POST', 'devices/role', { id: ids.b, role: 'admin' })).status === 200);
    check('admin cannot make a computer dev', (await call(A, 'POST', 'devices/role', { id: ids.g, role: 'dev' })).status === 403);
    check('admin cannot reveal folders on the main computer', (await call(A, 'POST', 'reveal', { path: '' })).status === 403);
    check('a role that does not exist is refused', (await call('host', 'POST', 'devices/role', { id: ids.g, role: 'boss' })).status === 400);
    check('a computer that does not exist is refused', (await call('host', 'POST', 'devices/role', { id: 'nope', role: 'admin' })).status === 404);
    check('the main computer itself has no role to change', (await call('host', 'POST', 'devices/role', { id: 'host', role: 'general' })).status === 404);

    // ---- nobody can touch a computer ranked above them
    await call('host', 'POST', 'devices/role', { id: ids.b, role: 'dev' });
    check('admin cannot demote a dev', (await call(A, 'POST', 'devices/role', { id: ids.b, role: 'general' })).status === 403);
    check('admin cannot remove a dev', (await call(A, 'POST', 'devices/remove', { id: ids.b })).status === 403);
    check('a dev can demote an admin', (await call(B, 'POST', 'devices/role', { id: ids.a, role: 'general' })).status === 200 && (await call(A, 'GET', 'me')).body.role === 'general');

    // ---- it survives restarts, and removal takes the role with it
    await call('host', 'POST', 'devices/role', { id: ids.a, role: 'admin' });
    await H.stopRole(); await H.startRole();
    check('roles survive a restart', (await call(A, 'GET', 'me')).body.role === 'admin' && (await call(B, 'GET', 'me')).body.role === 'dev');
    check('a general computer stays general', (await call(G, 'GET', 'me')).body.role === 'general');
    await call('host', 'POST', 'devices/remove', { id: ids.a });
    check('removing a computer clears its role', H.roles.get(ids.a) === 'general' && !(ids.a in H.roles.all()));
    r = await call('host', 'GET', 'devices/history');
    check('the main computer can read the role history, general cannot', r.status === 200 && r.body.items.length >= 5 && r.body.items[0].name && (await call(G, 'GET', 'devices/history')).status === 403, r);
    const log = H.roles.history(50);
    check('every change is on record, newest first', log.length >= 5 && log[0].device_id === ids.a && log[0].new_role === 'general', log);

    // ---- a damaged roles file never promotes anyone
    await H.stopRole();
    fs.writeFileSync(path.join(H.dataDir, 'portal.db'), 'this is not a database'.repeat(100));
    for (const ext of ['-wal', '-shm']) fs.rmSync(path.join(H.dataDir, 'portal.db' + ext), { force: true });
    await H.startRole();
    check('a damaged roles file is kept aside and the server still starts', !!H.server && !H.startError && fs.readdirSync(H.dataDir).some(f => f.startsWith('portal.db.damaged-')));
    check('...and everyone is general again', (await call(B, 'GET', 'me')).body.role === 'general');
    check('...and roles can be assigned again', (await call('host', 'POST', 'devices/role', { id: ids.b, role: 'admin' })).status === 200 && (await call(B, 'GET', 'me')).body.role === 'admin');

    // ---- a roles file that cannot be opened at all fails safe
    const notAFolder = path.join(T, 'plain-file'); fs.writeFileSync(notAFolder, 'x');          // the roles file would have to live "inside" a file
    const bad = new RoleStore(path.join(notAFolder, 'portal.db'));
    check('an unopenable roles file means everyone is general', bad.unavailable !== '' && bad.get('anything') === 'general');
    let threw = null; try { bad.set('x', 'admin', 't'); } catch (e) { threw = e; }
    check('...and nothing can be assigned', threw && threw.status === 503);

    // ---- it is fast
    const s = H.roles; const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20000; i++) s.get(ids.b);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    check(`20,000 role lookups take ${ms.toFixed(0)} ms`, ms < 1500, ms);
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of all) { try { await c.shutdown(); } catch { /* already stopped */ } }
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
