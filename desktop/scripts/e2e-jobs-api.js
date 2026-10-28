'use strict';
// Headless test for the jobs API on a real server: adding doors from order forms, the department queues, the flow, repairs and undo.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ARTEMA_DEFAULT_PORT = '18699';
process.env.ARTEMA_UDP_PORT = '41696';
const XLSX = require('xlsx');
const { Core } = require('../src/core');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-jobsapi-e2e-'));
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };

function makeForm(file, { door, customer = 'Evolve Windows & Doors', project = 'Pinnacle Town Houses', ship = '11/20/2026' }) {
  const ws = {};
  const put = (a, v) => { ws[a] = { t: 's', v, w: String(v) }; };
  put('I4', 'Customer Name:'); put('J4', customer);
  put('I5', 'Tag Name:'); put('J5', project);
  put('I6', 'Target Ship Date:'); put('J6', ship);
  put('I45', 'Door Number:'); put('J45', door);
  put('B20', 'Hinge Side:'); put('E20', 'RH');
  put('I19', 'Panel Series'); put('J19', 'Richersons Smooth skin');
  ws['!ref'] = 'A1:AM70';
  XLSX.writeFile({ SheetNames: ['Main Order Form'], Sheets: { 'Main Order Form': ws } }, file, { bookType: 'xlsx' });
}

(async () => {
  let H, F;
  try {
    fs.mkdirSync(path.join(T, 'host', 'desk'), { recursive: true });
    H = new Core({ dataDir: path.join(T, 'host', 'data'), webDir: path.join(__dirname, '..', 'web'), desktopDir: path.join(T, 'host', 'desk'), hooks: {} });
    await H.startLocalServer(0);
    await H.setupHost('Host', 18601);
    const forms = path.join(H.folder, 'Door Orders');
    fs.mkdirSync(forms, { recursive: true });
    makeForm(path.join(forms, 'Door 26-611.xlsx'), { door: '26-611' });
    makeForm(path.join(forms, 'Door 26-612.xlsx'), { door: '26-612', ship: '2026-11-05' });
    makeForm(path.join(forms, 'Door 26-613.xlsx'), { door: '26-613', ship: 'soon' });
    fs.writeFileSync(path.join(forms, 'Door 26-614.xlsx'), 'not a spreadsheet');

    H.trustLoopback = true;
    const call = async (method, ep, body) => {
      const r = await fetch('https://127.0.0.1:18601/api/' + ep, { method, headers: { 'X-Device': 'test', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const get = ep => call('GET', ep), post = (ep, b) => call('POST', ep, b);
    let r;

    r = await post('jobs/settings', { guided: true, dept: 'Office' });
    check('the host (dev) can switch the guided steps on', r.status === 200 && r.body.guided === true);
    r = await get('jobs/meta');
    check('the flow, departments and repair reasons are served', r.status === 200 && r.body.steps.length === 10 && r.body.actors.includes('Paint') && r.body.reasons.length > 3 && r.body.defaults.frame === 'inhouse', r.body);
    r = await get('orders');
    check('order forms say which are in the shop (none yet)', r.status === 200 && Array.isArray(r.body.inShop) && r.body.inShop.length === 0);

    // ---- adding doors
    r = await post('jobs/add', { rel: 'Door 26-611.xlsx', dept: 'Office', choices: { frame: 'bought', panel: 'inhouse', rail_stile: 'none' } });
    const d1 = r.body.door;
    check('a form becomes a door with its details, ship date as yyyy-mm-dd and its form linked', r.status === 200 && d1.number === '26-611' && d1.customer === 'Evolve Windows & Doors' && d1.project === 'Pinnacle Town Houses' && d1.shipDate === '2026-11-20' && d1.sourcePath === 'Door Orders/Door 26-611.xlsx' && d1.status === 'new', r.body);
    check('the choices become components (bought frame, panel made here)', d1.components.map(c => `${c.kind}:${c.source_kind}:${c.source}`).sort().join() === 'frame:external:Supplier,panel:internal:Panel Assembly', d1.components);
    r = await post('jobs/add', { rel: 'Door 26-611.xlsx', dept: 'Office' });
    check('the same form cannot be added twice', r.status === 409 && /already in the shop/.test(r.body.error), r);
    r = await post('jobs/add', { rel: 'Door 26-614.xlsx', dept: 'Office' });
    check('a file that is not an order form is refused politely', r.status === 400 && r.body.error, r);
    r = await post('jobs/add-all', { dept: 'Office' });
    check('"add all" adds the new forms and reports the unreadable one', r.status === 200 && r.body.added.sort().join() === '26-612,26-613' && r.body.skipped.length === 1, r.body);
    r = await get('orders');
    check('order forms now say which are in the shop', r.body.inShop.sort().join() === '26-611,26-612,26-613', r.body.inShop);
    r = await get('jobs/door?id=26-613');
    check('a ship date that can\'t be read is kept as written', r.body.door.shipDate === 'soon');

    // ---- release and the first department
    r = await post('jobs/release', { id: 'x' , dept: 'Office' });
    check('an unknown door is a clean 404', r.status === 404, r);
    r = await post('jobs/release', { id: '26-611', dept: 'Office' });
    check('release waits for the parts and says which', r.status === 409 && /Glass/.test(r.body.error), r);
    for (const item of ['Glass', 'Hardware', 'Sill']) r = await post('jobs/check', { id: '26-611', item, done: true, dept: 'Office' });
    r = await get('jobs/queue?dept=Office');
    check('the office sees doors ready to start', r.body.release.length === 3 && r.body.release.some(d => d.number === '26-611'));
    r = await post('jobs/release', { id: '26-611', dept: 'Office' });
    check('release starts the door; a bought frame means nothing to cut', r.status === 200 && r.body.door.status === 'active' && r.body.door.next.key === 'frame-prep.cnc' && r.body.door.completions[0].skipped === 1, r.body.door);
    r = await get('jobs/queue?dept=Frame%20Prep');
    check('the door shows in Frame Prep\'s list, waiting on its panel', r.body.work.length === 1 && r.body.work[0].waitingOn.join() === 'frame,panel', r.body.work);
    r = await get('jobs/queue?dept=Panel%20Assembly');
    check('the panel maker sees the panel to make', r.body.parts.length === 1 && r.body.parts[0].kind === 'panel' && r.body.parts[0].number === '26-611');
    r = await get('jobs/queue?dept=Office');
    check('the office sees the bought frame to receive', r.body.parts.some(p => p.kind === 'frame' && p.sourceKind === 'external'));
    r = await post('jobs/step', { id: '26-611', step: 'frame-prep.cnc', dept: 'Frame Prep' });
    check('CNC cannot be done while parts are missing', r.status === 409 && /Waiting on/.test(r.body.error), r);
    await post('jobs/ready', { id: '26-611', kind: 'panel', dept: 'Panel Assembly' });
    await post('jobs/ready', { id: '26-611', kind: 'frame', dept: 'Office' });

    // ---- the flow, undo and repairs
    r = await post('jobs/step', { id: '26-611', step: 'frame-prep.cnc', dept: 'Frame Prep' });
    check('with the parts in, CNC is done', r.status === 200 && r.body.door.next.key === 'frame-prep.fill');
    r = await post('jobs/step', { id: '26-611', step: 'frame-prep.fill', dept: 'Frame Prep' });
    r = await post('jobs/undo', { id: '26-611', step: 'frame-prep.cnc', dept: 'Frame Prep' });
    check('undo refuses when the door has already moved on past what you saw', r.status === 409 && /already moved/.test(r.body.error), r);
    r = await post('jobs/undo', { id: '26-611', step: 'frame-prep.fill', dept: 'Frame Prep' });
    check('undo takes back the step you saw', r.status === 200 && r.body.door.next.key === 'frame-prep.fill');
    await post('jobs/step', { id: '26-611', step: 'frame-prep.fill', dept: 'Frame Prep' });
    await post('jobs/step', { id: '26-611', step: 'frame-prep.qc', dept: 'Frame Prep' });
    r = await post('jobs/step', { id: '26-611', step: 'paint.prep', dept: '' });
    check('every change needs a department', r.status === 400 && /department/.test(r.body.error), r);
    await post('jobs/step', { id: '26-611', step: 'paint.prep', dept: 'Paint' });
    r = await post('jobs/repair', { id: '26-611', toDept: 'Frame Prep', reason: 'Filler cracked', dept: 'Paint' });
    check('a repair sends the door to the other department and keeps its place', r.status === 200 && r.body.door.status === 'repair' && r.body.door.next.key === 'paint.paint', r.body);
    r = await get('jobs/queue?dept=Frame%20Prep');
    check('the repair appears in that department\'s list', r.body.repairs.length === 1 && r.body.repairs[0].reason === 'Filler cracked' && r.body.repairs[0].door.number === '26-611');
    r = await post('jobs/repair-done', { detour: r.body.repairs[0].id, dept: 'Frame Prep' });
    r = await get('jobs/board');
    check('the board lists every unfinished door', r.body.doors.length === 3 && r.body.doors.find(d => d.number === '26-611').status === 'active');
    r = await get('jobs/door?id=26-611');
    check('a door\'s page has its history in order', r.body.events.length > 8 && r.body.events[0].kind === 'detour.closed');
    r = await get('jobs/board');
    const b611 = r.body.doors.find(d => d.number === '26-611');
    check('the board carries each door\'s order-form details for the department tables', b611.form && b611.form.customer === 'Evolve Windows & Doors' && b611.form.series === 'Richersons Smooth skin', b611.form);
    r = await post('jobs/note', { id: '26-611', note: '  Check hinge prep  ', dept: 'Frame Prep' });
    check('a note is saved on the door and shown with it', r.status === 200 && r.body.door.notes === 'Check hinge prep', r.body);
    r = await get('jobs/door?id=26-611');
    check('the note change is in the door\'s history', r.body.events.some(e => e.kind === 'note.set' && e.dept === 'Frame Prep'));
    r = await get('jobs/queue?dept=Wizards');
    check('an unknown department is refused', r.status === 400);

    // ---- editable status columns over the API, and who may change the setup
    await post('jobs/settings', { guided: false, dept: 'Office' });
    r = await post('jobs/add', { rel: 'Door 26-612.xlsx', dept: 'Office' });
    check('(already in the shop) a repeat add is still refused with the steps off', r.status === 409);
    fs.rmSync(path.join(forms, 'Door 26-613.xlsx'));
    makeForm(path.join(forms, 'Door 26-620.xlsx'), { door: '26-620' });
    r = await post('jobs/add', { rel: 'Door 26-620.xlsx', dept: 'Office' });
    check('with the steps off a door is on the board straight away: no parts checklist, nothing to release', r.status === 200 && r.body.door.status === 'active' && r.body.door.checks.length === 0 && r.body.door.components.length === 0, r.body.door);
    r = await get('jobs/board');
    const cnc = r.body.fields.find(f => f.name === 'CNC Frame'), ready = cnc.labels.find(l => l.name === 'Ready');
    check('the board carries its columns, tabs, palette and the steps switch', r.body.fields.length === 3 && r.body.views.length === 2 && r.body.palette.blue && r.body.guided === false && r.body.doors.find(d => d.number === '26-620').cells !== undefined);
    r = await post('jobs/cell', { id: '26-620', field: cnc.id, value: ready.id, dept: 'Frame Prep', who: 'Dave' });
    check('anyone can set a cell', r.status === 200 && r.body.door.cells[cnc.id].label === ready.id, r.body);
    r = await post('jobs/cell', { id: '26-620', field: cnc.id, value: 999999, dept: 'Frame Prep' });
    check('a label that does not exist is refused', r.status === 400);
    r = await post('jobs/comment', { id: '26-620', text: 'Customer wants glass changed', dept: 'Office', who: 'Ben' });
    check('anyone can comment, and the door says how many', r.status === 200 && r.body.door.commentCount === 1);
    r = await get('jobs/door?id=26-620');
    check('a door\'s page has its comments', r.body.comments.length === 1 && r.body.comments[0].body === 'Customer wants glass changed' && r.body.comments[0].dept === 'Office' && r.body.guided === false);
    r = await post('jobs/archive', { id: '26-620', dept: 'Office' });
    const arch = await get('jobs/board?archived=1');
    check('an archived door moves to the archive view', r.status === 200 && arch.body.doors.map(d => d.number).join() === '26-620');
    await post('jobs/archive', { id: '26-620', on: false, dept: 'Office' });

    // a computer that is not an admin may set cells but not change the setup; an admin computer may
    fs.mkdirSync(path.join(T, 'floor', 'desk'), { recursive: true });
    F = new Core({ dataDir: path.join(T, 'floor', 'data'), webDir: path.join(__dirname, '..', 'web'), desktopDir: path.join(T, 'floor', 'desk'), hooks: {} });
    await F.startLocalServer(0);
    await F.join('127.0.0.1:18601', 'Floor PC', H.getPin());
    const floor = async (method, ep, body) => { H.trustLoopback = false; try { const x = await fetch('https://127.0.0.1:18601/api/' + ep, { method, headers: { Authorization: 'Bearer ' + F.secret('device_token'), 'X-Device': 'floor', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: x.status, body: await x.json().catch(() => ({})) }; } finally { H.trustLoopback = true; } };
    r = await floor('POST', 'jobs/cell', { id: '26-620', field: cnc.id, value: null, dept: 'Frame Prep' });
    check('a floor computer can set cells', r.status === 200);
    r = await floor('POST', 'jobs/labels/save', { field: cnc.id, labels: [{ name: 'X', color: 'red' }], dept: 'Frame Prep' });
    check('a floor computer cannot edit labels', r.status === 403, r);
    r = await floor('POST', 'jobs/field/add', { name: 'Paint', kind: 'status', dept: 'Frame Prep' });
    check('a floor computer cannot add columns', r.status === 403);
    r = await floor('POST', 'jobs/views/save', { views: [{ name: 'x', cols: ['door'] }], dept: 'Frame Prep' });
    check('a floor computer cannot change the tabs', r.status === 403);
    r = await floor('POST', 'jobs/settings', { guided: true, dept: 'Frame Prep' });
    check('a floor computer cannot turn the guided steps on', r.status === 403 && (await get('jobs/meta')).body.guided === false);
    await post('devices/role', { id: F.cfg.device_id, role: 'admin' });
    r = await floor('POST', 'jobs/labels/save', { field: cnc.id, labels: [...cnc.labels.map(l => ({ id: l.id, name: l.name, color: l.color, done: l.done, attn: l.attn })), { name: 'Waiting for glass', color: 'teal' }], dept: 'Office', who: 'Ben' });
    check('an admin computer can edit labels', r.status === 200, r);
    r = await get('jobs/board');
    check('and the new label is there for everyone', r.body.fields.find(f => f.id === cnc.id).labels.some(l => l.name === 'Waiting for glass'));
    r = await floor('POST', 'jobs/field/add', { name: 'Paint', kind: 'status', dept: 'Office' });
    check('an admin computer can add a column', r.status === 200 && r.body.id > 0, r);

    // ---- the files and the rest still work
    r = await get('list?path=');
    check('files still work alongside jobs', r.status === 200 && Array.isArray(r.body.items));
    check('backups folder is configured next to the data', H.jobs && H.jobs.ok && H.jobs.backupDir.endsWith('backups'));
  } catch (e) {
    console.log('FAIL unexpected error: ' + (e && e.stack || e)); fails.push('unexpected error');
  } finally {
    try { if (F) await F.shutdown(); } catch { /* stopping */ }
    try { if (H) await H.shutdown(); } catch { /* stopping */ }
    try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp */ }
  }
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll passed');
  process.exit(fails.length ? 1 : 0);
})();
