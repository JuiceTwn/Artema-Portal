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
