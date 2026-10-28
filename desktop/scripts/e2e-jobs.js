'use strict';
// Headless test for the job store: the flow, components, release, repairs (detours that never double count), the event log, and backups.
const fs = require('fs'), os = require('os'), path = require('path');
const { JobStore } = require('../src/jobs');
const { STEP_KEYS, nextStep } = require('../src/workflow');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-jobs-e2e-'));
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const throws = (fn, status, part) => { try { fn(); return false; } catch (e) { return (!status || e.status === status) && (!part || e.message.includes(part)); } };

const fresh = tag => new JobStore(path.join(T, tag, 'jobs.db'), path.join(T, tag, 'backups'));
const comps = [
  { kind: 'frame', sourceKind: 'internal', source: 'Frame Prep' },
  { kind: 'panel', sourceKind: 'internal', source: 'Panel Assembly' },
  { kind: 'rail_stile', sourceKind: 'internal', source: 'Rail & Stile' },
];
/** Gets a door released with every part ticked. */
function released(js, number, extra = {}) {
  const id = js.createDoor({ number, components: comps, ...extra });
  for (const c of js.door(id).checks) js.setCheck(id, c.item, true, 'Office', 'Ben');
  js.release(id, 'Office', 'Ben');
  return id;
}
const flowTo = (js, id, lastKey) => { for (let n = js.door(id).next; n; n = js.door(id).next) { js.complete(id, n.key, n.dept, ''); if (n.key === lastKey) break; } };

try {
  // ---- the flow definition
  check('the flow runs frame prep, paint, assembly, shipping, with a lead-hand QC closing each department but shipping',
    STEP_KEYS.join() === 'frame-prep.cut,frame-prep.cnc,frame-prep.fill,frame-prep.qc,paint.prep,paint.paint,paint.qc,assembly.assemble,assembly.qc,shipping.ship', STEP_KEYS);
  check('paint prep belongs to paint, not frame prep', STEP_KEYS.indexOf('paint.prep') > STEP_KEYS.indexOf('frame-prep.qc'));
  check('the next step is the first one not yet done', nextStep(['frame-prep.cut']).key === 'frame-prep.cnc' && nextStep(STEP_KEYS) === null);

  const js = fresh('a');
  check('a new database opens and is usable', js.ok && !js.unavailable);

  // ---- creating doors
  const id = js.createDoor({ number: '26-611', customer: 'Evolve Windows & Doors', project: 'Pinnacle Town Houses', shipDate: '2026-11-20', components: comps });
  let d = js.door(id);
  check('a new door is not released and has the default part checks', d.status === 'new' && d.checks.map(c => c.item).join() === 'Glass,Hardware,Sill', d);
  check('a door is found by number as well as id', js.door('26-611').id === id && js.door(String(id)).id === id);
  check('door numbers are unique, whatever the case', throws(() => js.createDoor({ number: '26-611' }), 409) && throws(() => js.createDoor({ number: ' 26-611 ' }), 409));
  check('a door needs a number and valid components', throws(() => js.createDoor({ number: '' }), 400) && throws(() => js.createDoor({ number: 'x', components: [{ kind: 'glass' }] }), 400) && throws(() => js.createDoor({ number: 'y', components: [comps[0], comps[0]] }), 400));
  check('a failed creation leaves nothing behind', throws(() => js.door('x')) && throws(() => js.door('y')));

  // ---- release
  check('a door cannot be worked before it is released', throws(() => js.complete(id, 'frame-prep.cut', 'Frame Prep', ''), 409, 'released'));
  check('release waits for every part', throws(() => js.release(id, 'Office', 'Ben'), 409, 'Glass'));
  js.setCheck(id, 'Glass', true, 'Office', 'Ben'); js.setCheck(id, 'Hardware', true, 'Office', 'Ben');
  let missing = null; try { js.release(id, 'Office', 'Ben'); } catch (e) { missing = e.missing; }
  check('release names exactly what is missing', missing && missing.join() === 'Sill', missing);
  js.setCheck(id, 'Sill', true, 'Office', 'Ben');
  js.release(id, 'Office', 'Ben');
  d = js.door(id);
  check('release starts the door at the first step', d.status === 'active' && d.releasedBy === 'Ben' && d.next.key === 'frame-prep.cut' && d.next.dept === 'Frame Prep', d);
  check('a door cannot be released twice', throws(() => js.release(id, 'Office', 'Ben'), 409));
  check('an unknown department is refused', throws(() => js.release(id, 'Wizards', 'Ben'), 400, 'department'));

  // ---- the flow, components and QC
  check('steps must be done in order', throws(() => js.complete(id, 'frame-prep.cnc', 'Frame Prep', ''), 409, 'Cut'));
  check('the queue shows the door to Frame Prep and not to Paint', js.queue('Frame Prep').work.length === 1 && js.queue('Paint').work.length === 0);
  js.complete(id, 'frame-prep.cut', 'Frame Prep', '');
  d = js.door(id);
  check('cutting makes an in-house frame ready by itself', d.components.find(c => c.kind === 'frame').ready_at !== null && d.components.find(c => c.kind === 'panel').ready_at === null, d.components);
  check('CNC waits for the panel and rail & stile', d.waitingOn.join() === 'panel,rail_stile' && throws(() => js.complete(id, 'frame-prep.cnc', 'Frame Prep', ''), 409, 'panel'), d.waitingOn);
  check('a waiting door still shows in the CNC department list, flagged', js.queue('Frame Prep').work[0].waitingOn.length === 2);
  js.setComponentReady(id, 'panel', true, 'Panel Assembly', '');
  js.setComponentReady(id, 'rail_stile', true, 'Rail & Stile', '');
  check('a component can be un-readied by mistake and put back', (js.setComponentReady(id, 'panel', false, 'Office', ''), js.door(id).waitingOn.join() === 'panel') && (js.setComponentReady(id, 'panel', true, 'Office', ''), js.door(id).waitingOn.length === 0));
  js.complete(id, 'frame-prep.cnc', 'Frame Prep', '');
  js.complete(id, 'frame-prep.fill', 'Frame Prep', '');
  check('after fill the door waits for the lead hand QC', js.door(id).next.key === 'frame-prep.qc' && js.door(id).next.qc);
  js.complete(id, 'frame-prep.qc', 'Frame Prep', 'Dave');
  d = js.door(id);
  check('QC records who passed it, and the door moves to Paint', d.completions.find(c => c.step === 'frame-prep.qc').who === 'Dave' && d.next.key === 'paint.prep' && js.queue('Paint').work.length === 1, d.next);
  check('a step already done cannot be done again', throws(() => js.complete(id, 'frame-prep.cut', 'Frame Prep', ''), 409, 'already'));
  js.undo(id, 'Paint', '');
  check('the latest step can be taken back, and only that one', js.door(id).next.key === 'frame-prep.qc' && js.door(id).completions.length === 3);
  js.complete(id, 'frame-prep.qc', 'Frame Prep', 'Dave');

  // ---- repairs: a detour never moves the door and never counts twice
  js.complete(id, 'paint.prep', 'Paint', '');
  const before = js.door(id).completions.length;
  const dt = js.openDetour(id, { toDept: 'Frame Prep', reason: 'Filler cracked on the jamb' }, 'Paint', 'Lee');
  d = js.door(id);
  check('a repair keeps the door at the same step but marks it out for repair', d.status === 'repair' && d.next.key === 'paint.paint' && d.openDetours.length === 1 && d.openDetours[0].from_dept === 'Paint', d);
  const fq = js.queue('Frame Prep'), pq = js.queue('Paint');
  check('the repair shows in the other department as rework, not as flow', fq.repairs.length === 1 && fq.repairs[0].door.number === '26-611' && fq.repairs[0].reason.includes('jamb') && fq.work.length === 0 && pq.work.length === 0 && pq.repairs.length === 0);
  check('nothing is completed while a door is out for repair', throws(() => js.complete(id, 'paint.paint', 'Paint', ''), 409, 'repair') && throws(() => js.undo(id, 'Paint', ''), 409));
  check('the same department cannot be sent the same door twice at once', throws(() => js.openDetour(id, { toDept: 'Frame Prep' }, 'Paint', ''), 409));
  js.closeDetour(dt, 'Frame Prep', 'Mike');
  d = js.door(id);
  check('finishing the repair returns the door to the same step with no extra completion', d.status === 'active' && d.next.key === 'paint.paint' && d.completions.length === before && pq.work.length === 0 && js.queue('Paint').work.length === 1, d);
  check('a finished repair cannot be finished again', throws(() => js.closeDetour(dt, 'Frame Prep', ''), 409));
  js.openDetour(id, { toDept: 'Skins', reason: 'Skin scratched', rush: false }, 'Paint', '');
  js.openDetour(id, { toDept: 'Panel Assembly', reason: 'Wrong rail', rush: true }, 'Paint', '');
  check('a door can be out at several departments, including providers behind it', js.door(id).openDetours.length === 2);
  for (const o of js.door(id).openDetours) js.closeDetour(o.id, o.to_dept, '');
  const rw = js.rework();
  check('rework is counted by department, apart from the flow', rw.length === 3 && rw.every(r => r.count === 1) && js.door(id).completions.length === before, rw);

  // ---- finishing, the board, projects
  flowTo(js, id, 'shipping.ship');
  check('a door that finished every step is done and leaves the board and queues', js.door(id).status === 'done' && js.door(id).next === null && !js.board().some(x => x.id === id) && throws(() => js.openDetour(id, { toDept: 'Paint' }, 'Office', ''), 409));
  const a = released(js, '26-701', { project: 'Pinnacle Town Houses', shipDate: '2026-11-10' });
  const b = released(js, '26-702', { project: 'pinnacle town houses', shipDate: '2026-11-05' });
  const c = js.createDoor({ number: '26-703', project: 'Pinnacle Town Houses' });
  check('doors in a project are grouped, whatever the case of its name', js.project('Pinnacle Town Houses').doors === 4);
  check('"5 of 13": a project counts doors that finished a step', js.project('Pinnacle Town Houses', 'frame-prep.cut').done === 1 && js.project('Pinnacle Town Houses').done === 1);
  check('the board lists unfinished doors by ship date, including unreleased ones', js.board().map(x => x.number).join() === '26-702,26-701,26-703', js.board().map(x => x.number));
  check('a door with no project stands alone', js.door(released(js, '26-800')).project === '');

  // ---- the event log
  const ev = js.events(100, id);
  check('every change is in the event log with its department', ev.length > 20 && ev.some(e => e.kind === 'door.released' && e.dept === 'Office') && ev.some(e => e.kind === 'detour.opened' && e.dept === 'Paint' && e.data.to === 'Frame Prep') && ev.some(e => e.kind === 'step.done' && e.who === 'Dave'));
  const n = js.events(1000).length;
  try { js.complete(id, 'shipping.ship', 'Office', ''); } catch { /* finished */ }
  check('a refused change writes nothing', js.events(1000).length === n);
  js.createDoor({ number: '26-900' });
  const tooLong = (() => { try { js.createDoor({ number: '26-901', components: [{ kind: 'bogus' }] }); } catch { /* refused */ } return js.events(1000).length; })();
  check('a failed creation is rolled back completely', tooLong === n + 1 && throws(() => js.door('26-901'), 404));

  // ---- editable status columns (the Monday-style board)
  const cfg = js.config();
  const fCnc = cfg.fields.find(f => f.name === 'CNC Frame'), fPanel = cfg.fields.find(f => f.name === 'CNC Panel'), fTime = cfg.fields.find(f => f.name === 'CNC Timeline');
  check('a fresh board starts with the CNC columns and tabs from the Monday board', fCnc && fCnc.kind === 'status' && fCnc.labels.length === 11 && fPanel.labels.some(l => l.name === 'Large Format') && fTime.kind === 'date' && cfg.views.map(v => v.name).join() === 'CNC,All doors' && cfg.guided === false, cfg);
  check('the starting tab shows the door, updates, files, the three CNC columns and notes', JSON.stringify(cfg.views[0].cols) === JSON.stringify(['door', 'updates', 'files', '#' + fTime.id, '#' + fCnc.id, '#' + fPanel.id, 'notes']), cfg.views[0].cols);
  const ready = fCnc.labels.find(l => l.name === 'Ready'), stuck = fCnc.labels.find(l => l.name === 'Stuck');
  check('"Done" counts as done and "Stuck" needs a look in the starting labels', fCnc.labels.find(l => l.name === 'Done').done && stuck.attn && !ready.done && !ready.attn);
  js.setCell(id, fCnc.id, ready.id, 'Frame Prep', '');
  check('a status cell is set by picking a label', js.door(id).cells[fCnc.id].label === ready.id);
  check('a label from another column is refused', throws(() => js.setCell(id, fCnc.id, fPanel.labels[0].id, 'Frame Prep', ''), 400, 'not in this column'));
  js.setCell(id, fTime.id, '2026-11-20', 'Office', '');
  check('a date cell takes a date and refuses anything else', js.door(id).cells[fTime.id].value === '2026-11-20' && throws(() => js.setCell(id, fTime.id, 'next week', 'Office', ''), 400, 'date'));
  const n0 = js.events(1000).length;
  js.setCell(id, fCnc.id, ready.id, 'Frame Prep', '');
  check('setting a cell to what it already is changes and logs nothing', js.events(1000).length === n0);
  js.setCell(id, fCnc.id, null, 'Frame Prep', '');
  check('a cell is cleared with null', js.door(id).cells[fCnc.id] === undefined);
  js.setCell(id, fCnc.id, stuck.id, 'Frame Prep', '');
  check('every cell change is in the door\'s history', js.events(5, id)[0].kind === 'cell.set' && js.events(5, id)[0].data.value === 'Stuck' && js.events(5, id)[0].dept === 'Frame Prep');

  // admins edit labels: rename, recolour, add, reorder, delete
  const lab = js.fields().find(f => f.id === fCnc.id).labels;
  js.saveLabels(fCnc.id, [
    { id: stuck.id, name: 'Blocked', color: 'red', attn: true },
    { name: 'Waiting for glass', color: 'teal' },
    ...lab.filter(l => l.name === 'Ready' || l.name === 'Done').map(l => ({ id: l.id, name: l.name, color: l.color, done: l.done })),
  ], 'Office', 'Ben');
  const after = js.fields().find(f => f.id === fCnc.id).labels;
  check('labels can be renamed, added and reordered', after.map(l => l.name).join() === 'Blocked,Waiting for glass,Ready,Done' && after[0].id === stuck.id, after);
  check('a renamed label keeps the doors that had it', js.door(id).cells[fCnc.id].label === stuck.id);
  js.saveLabels(fCnc.id, after.filter(l => l.name !== 'Blocked'), 'Office', 'Ben');
  check('deleting a label leaves those doors blank, not broken', js.door(id).cells[fCnc.id] === undefined && js.fields().find(f => f.id === fCnc.id).labels.length === 3);
  check('labels need a name, a colour from the palette and no duplicates', throws(() => js.saveLabels(fCnc.id, [{ name: '', color: 'red' }], 'Office', ''), 400) && throws(() => js.saveLabels(fCnc.id, [{ name: 'x', color: 'plaid' }], 'Office', ''), 400) && throws(() => js.saveLabels(fCnc.id, [{ name: 'a', color: 'red' }, { name: 'A', color: 'blue' }], 'Office', ''), 400, 'same name'));
  check('a label can only be edited in its own column', throws(() => js.saveLabels(fPanel.id, [{ id: after[0].id, name: 'x', color: 'red' }], 'Office', ''), 400));
  check('only a status column has labels', throws(() => js.saveLabels(fTime.id, [], 'Office', ''), 400, 'status'));

  // admins add, rename and delete columns, and arrange tabs
  const fPaint = js.addField('Paint Status', 'status', 'Office', 'Ben');
  check('a new status column starts with working on it, done and stuck', js.fields().find(f => f.id === fPaint).labels.map(l => l.name).join() === 'Working on it,Done,Stuck');
  js.renameField(fPaint, 'Paint', 'Office', 'Ben');
  js.saveViews([{ id: cfg.views[0].id, name: 'CNC', cols: cfg.views[0].cols }, { name: 'Paint', cols: ['door', 'ship', '#' + fPaint, 'f:extFinish', 'notes'] }], 'Office', 'Ben');
  check('tabs are saved in order with their columns, and a removed tab is gone', js.views().map(v => v.name).join() === 'CNC,Paint' && js.views()[1].cols.join() === 'door,ship,#' + fPaint + ',f:extFinish,notes');
  check('a tab can\'t use a column that doesn\'t exist, and there is always one tab', throws(() => js.saveViews([{ name: 'x', cols: ['#9999'] }], 'Office', ''), 400) && throws(() => js.saveViews([], 'Office', ''), 400));
  js.deleteField(fPaint, 'Office', 'Ben');
  check('deleting a column also takes it out of every tab', !js.views()[1].cols.includes('#' + fPaint) && js.views()[1].cols.join() === 'door,ship,f:extFinish,notes');
  check('a tab always keeps the door column', js.saveViews([{ id: js.views()[0].id, name: 'CNC', cols: ['notes'] }], 'Office', '') === undefined && js.views()[0].cols[0] === 'door');

  // comments, archive, settings
  js.addComment(id, '  Customer called, wants it Friday  ', 'Office', 'Ben');
  js.addComment(id, 'Noted', 'Frame Prep', '');
  check('comments are kept in order with who wrote them, and counted on the door', js.comments(id).map(c => c.body).join('|') === 'Customer called, wants it Friday|Noted' && js.comments(id)[0].dept === 'Office' && js.comments(id)[0].who === 'Ben' && js.door(id).commentCount === 2);
  check('an empty comment is refused', throws(() => js.addComment(id, '   ', 'Office', ''), 400));
  const onBoard = js.board().length;
  js.setArchived(a, true, 'Office', 'Ben');
  check('an archived door leaves the board and shows in the archive', js.board().length === onBoard - 1 && js.board('archived').map(d => d.number).join() === '26-701' && js.door(a).archived);
  js.setArchived(a, false, 'Office', 'Ben');
  check('an archived door can be brought back', js.board().length === onBoard && js.board('archived').length === 0);
  js.setGuided(true, 'Office', 'Ben');
  check('the guided steps are an on/off switch, off to begin with', js.settings().guided === true && (js.setGuided(false, 'Office', ''), js.settings().guided === false));
  check('the board setup is not seeded again once it has been changed', (() => { const f = js.fields().length; js.seed(); return js.fields().length === f; })());

  // ---- backups
  const name = js.backup(3);
  check('a backup is written, passes its check, and is listed', js.backups()[0].name === name && js.verify(js.backups()[0].file));
  for (let i = 0; i < 4; i++) js.backup(3);
  check('only the newest few backups are kept', js.backups().length === 3, js.backups().length);
  check('two backups in the same second get different names', new Set(js.backups().map(x => x.name)).size === 3);

  // ---- damage and recovery
  const count = js.board().length;
  js.close();
  fs.writeFileSync(js.file, Buffer.from('this is not a database at all'.repeat(100)));
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(js.file + ext); } catch { /* none */ } }
  const re = new JobStore(js.file, js.backupDir);
  check('a damaged database is restored from the newest good backup', re.ok && re.restoredFrom !== '' && re.board().length === count && re.door('26-611').status === 'done', re.unavailable);
  check('the damaged file is kept for inspection', fs.readdirSync(path.dirname(js.file)).some(f => f.includes('.damaged-')));
  re.close();

  fs.rmSync(path.join(T, 'a', 'backups'), { recursive: true, force: true });
  fs.writeFileSync(js.file, Buffer.from('still not a database'.repeat(100)));
  const lost = new JobStore(js.file, js.backupDir);
  check('with no backup, it refuses to start empty over data it could not read', !lost.ok && lost.unavailable.includes('no good backup') && throws(() => lost.board(), 503));
  lost.close();

  const fresh2 = fresh('b');
  check('a brand new install starts empty with no backups', fresh2.ok && fresh2.board().length === 0 && fresh2.backups().length === 0);
  fresh2.close();
} catch (e) {
  console.log('FAIL unexpected error: ' + (e && e.stack || e));
  fails.push('unexpected error');
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll passed');
process.exit(fails.length ? 1 : 0);
