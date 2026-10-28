'use strict';
// Headless test for the automations: a door moves itself between stations, safely, in one transaction, and can be undone as one.
const fs = require('fs'), os = require('os'), path = require('path');
const { JobStore } = require('../src/jobs');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-rules-e2e-'));
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };
const throws = (fn, status, part) => { try { fn(); return false; } catch (e) { return (!status || e.status === status) && (!part || e.message.includes(part)); } };

try {
  const js = new JobStore(path.join(T, 'jobs.db'), path.join(T, 'backups'));
  const fields = js.fields();
  const frame = fields.find(f => f.name === 'CNC Frame'), panel = fields.find(f => f.name === 'CNC Panel');
  const lab = (f, n) => f.labels.find(l => l.name === n).id;

  // a Station column, stations in order
  const stationId = js.addField('Station', 'status', 'Office', '');
  js.saveLabels(stationId, ['Frame Prep', 'Paint', 'Assembly', 'Shipping', 'Done'].map(n => ({ name: n, color: 'blue', done: n === 'Done' })), 'Office', '');
  const station = js.fields().find(f => f.id === stationId);
  const st = n => lab(station, n);
  const stationOf = id => (js.cellsOf(id)[stationId] || {}).label;

  const rule1 = {
    name: 'CNC finished: on to Paint',
    when: { kind: 'cell', field: frame.id, label: lab(frame, 'Done') },
    if: [{ field: panel.id, label: lab(panel, 'Done') }, { field: stationId, label: st('Frame Prep') }],
    then: [{ do: 'next', field: stationId }, { do: 'comment', text: 'Moved to Paint automatically' }],
  };
  const rule2 = { name: 'Same, when the panel finishes last', when: { kind: 'cell', field: panel.id, label: lab(panel, 'Done') }, if: [{ field: frame.id, label: lab(frame, 'Done') }, { field: stationId, label: st('Frame Prep') }], then: [{ do: 'next', field: stationId }, { do: 'comment', text: 'Moved to Paint automatically' }] };
  const rule3 = { name: 'New doors start at Frame Prep', when: { kind: 'added' }, if: [], then: [{ do: 'set', field: stationId, label: st('Frame Prep') }] };

  check('there are no rules to start with', js.rules().length === 0 && js.config().rules.length === 0);
  js.saveRules([rule3, rule1, rule2], 'Office', '');
  const saved = js.rules();
  check('rules are saved in order with their ids and the board config carries them', saved.length === 3 && saved[0].name === rule3.name && saved.every(r => r.id && r.enabled) && js.config().rules.length === 3);

  // adding a door
  const d1 = js.createDoor({ number: '26-701', components: [] }, 'Office');
  check('a rule can start a new door at the first station', stationOf(d1) === st('Frame Prep'));
  check('the automatic change is in the history as Automation with the rule name', js.events(10, d1).some(e => e.kind === 'cell.set' && e.dept === 'Automation' && e.who === rule3.name && e.data.rule === rule3.name));

  // moving
  let auto = js.setCell(d1, frame.id, lab(frame, 'Done'), 'Frame Prep', '');
  check('one of two CNC columns done: the door stays put', stationOf(d1) === st('Frame Prep') && auto.length === 0);
  auto = js.setCell(d1, panel.id, lab(panel, 'Done'), 'Frame Prep', '');
  check('when the second is done the door moves to the next station by itself', stationOf(d1) === st('Paint'), stationOf(d1));
  check('the move is reported so one Undo can take it back', auto.length === 1 && auto[0].after === st('Paint') && auto[0].before === st('Frame Prep'));
  check('the rule left an update on the door', js.comments(d1).some(c => c.dept === 'Automation' && c.body === 'Moved to Paint automatically'));
  check('a rule does not run twice for the same change', js.comments(d1).filter(c => c.dept === 'Automation').length === 1);
  js.setCell(d1, frame.id, null, 'Frame Prep', ''); js.setCell(d1, frame.id, lab(frame, 'Done'), 'Frame Prep', '');
  check('a door that already left Frame Prep is not moved again (the condition holds)', stationOf(d1) === st('Paint'));

  // undo as one
  const d2 = js.createDoor({ number: '26-702', components: [] }, 'Office');
  js.setCell(d2, frame.id, lab(frame, 'Done'), 'Frame Prep', '');
  auto = js.setCell(d2, panel.id, lab(panel, 'Done'), 'Frame Prep', '');
  js.setCells([{ id: d2, field: panel.id, value: null }, ...auto.map(a => ({ id: a.door, field: a.field, value: a.before }))], 'Frame Prep', '');
  check('undo puts the cell and what the rules did back, without running the rules again', stationOf(d2) === st('Frame Prep') && !(js.cellsOf(d2)[panel.id]));

  // chains and loops
  js.saveRules([
    { name: 'A', when: { kind: 'cell', field: stationId, label: st('Paint') }, if: [], then: [{ do: 'set', field: stationId, label: st('Assembly') }] },
    { name: 'B', when: { kind: 'cell', field: stationId, label: st('Assembly') }, if: [], then: [{ do: 'set', field: stationId, label: st('Paint') }] },
  ], 'Office', '');
  const d3 = js.createDoor({ number: '26-703', components: [] }, 'Office');
  let ended = true; try { js.setCell(d3, stationId, st('Paint'), 'Paint', ''); } catch { ended = false; }
  check('rules that set each other off stop (each runs once per change)', ended && stationOf(d3) === st('Paint'), stationOf(d3));

  // archive, disable, "any label"
  js.saveRules([
    { name: 'Done means archived', enabled: false, when: { kind: 'cell', field: stationId, label: st('Done') }, if: [], then: [{ do: 'archive' }] },
    { name: 'Any change at Shipping is noted', when: { kind: 'cell', field: stationId, label: null }, if: [{ field: stationId, label: st('Shipping'), not: true }], then: [{ do: 'comment', text: 'moved' }] },
  ], 'Office', '');
  const d4 = js.createDoor({ number: '26-704', components: [] }, 'Office');
  js.setCell(d4, stationId, st('Done'), 'Shipping', '');
  check('a switched-off rule does nothing', js.door(d4).archived === false);
  check('"any label" with a "is not" condition fires when it holds', js.comments(d4).length === 1);
  const rs = js.rules(); rs[0].enabled = true; js.saveRules(rs, 'Office', '');
  js.setCell(d4, stationId, st('Shipping'), 'Shipping', ''); js.setCell(d4, stationId, st('Done'), 'Shipping', '');
  check('switched on, the rule archives the door', js.door(d4).archived === true);

  // validation
  check('a rule must be named', throws(() => js.saveRules([{ ...rule1, name: '' }], 'Office', ''), 400, 'name'));
  check('a rule pointing at a label of another column is refused', throws(() => js.saveRules([{ ...rule1, when: { kind: 'cell', field: frame.id, label: lab(panel, 'Done') } }], 'Office', ''), 400, 'label'));
  check('a rule with nothing to do is refused', throws(() => js.saveRules([{ ...rule1, then: [] }], 'Office', ''), 400, 'something to do'));
  check('a failed save changes nothing', js.rules().length === 2);

  // tabs that show only some doors: conditions on statuses
  const views = js.views();
  check('a tab starts with no filter', views.every(v => Array.isArray(v.filter) && v.filter.length === 0));
  const atPaint = [{ field: stationId, test: 'label', label: st('Paint'), not: false }];
  js.saveViews(views.map((v, i) => ({ id: v.id, name: v.name, cols: v.cols, filter: i === 0 ? atPaint : undefined })), 'Office', '');
  check('a tab can be filtered by a label', js.views()[0].filter.length === 1 && js.views()[0].filter[0].label === st('Paint') && js.views()[1].filter.length === 0);
  js.saveViews(js.views().map(v => ({ id: v.id, name: v.name, cols: v.cols })), 'Office', '');
  check('saving tabs without a filter keeps it (older screens)', js.views()[0].filter.length === 1);
  check('a filter pointing at a label of another column is refused', throws(() => js.saveViews(js.views().map(v => ({ id: v.id, name: v.name, cols: v.cols, filter: [{ field: frame.id, test: 'label', label: st('Paint') }] })), 'Office', ''), 400, 'label'));
  js.saveViews(js.views().map(v => ({ id: v.id, name: v.name, cols: v.cols, filter: [{ field: frame.id, test: 'finished', not: true }] })), 'Office', '');
  check('a filter can ask for finished / not finished', js.views()[0].filter[0].test === 'finished' && js.views()[0].filter[0].not === true && !('label' in js.views()[0].filter[0]));

  // "is finished" in a rule's conditions
  js.saveRules([{ name: 'Both CNC done', when: { kind: 'cell', field: panel.id, label: null }, if: [{ field: panel.id, test: 'finished' }, { field: frame.id, test: 'finished' }], then: [{ do: 'comment', text: 'CNC finished' }] }], 'Office', '');
  const d5 = js.createDoor({ number: '26-705', components: [] }, 'Office');
  js.setCell(d5, panel.id, lab(panel, 'Done'), 'Frame Prep', '');
  check('a rule can ask whether a status is finished', js.comments(d5).length === 0);
  js.setCell(d5, frame.id, lab(frame, 'Done'), 'Frame Prep', ''); js.setCell(d5, panel.id, lab(panel, 'Working on it'), 'Frame Prep', ''); js.setCell(d5, panel.id, lab(panel, 'Done'), 'Frame Prep', '');
  check('…and it fires once both are', js.comments(d5).length === 1);

  // the door shop starter
  js.saveViews(js.views().map(v => ({ id: v.id, name: v.name, cols: v.cols, filter: [] })), 'Office', '');
  js.saveRules([], 'Office', '');
  check('before the starter a door has no needs and nothing is set', js.needsConfig() === null && js.door(js.createDoor({ number: '26-690', components: [], needs: { frame: false } }, 'Office')).needs === null);
  const t = js.applyDoorShopTemplate('Office', '');
  const f2 = js.fields(), by = n => f2.find(f => f.name === n);
  check('the starter makes a column per step and reuses the ones that exist', t.columns.length === 12 && !t.columns.includes('CNC Frame') && by('Verification') && by('Wrapping') && by('QC') && by('Panel Received'), t.columns);
  check('a column that was already there gets a "Not needed" label that counts as done', js.fields().find(f => f.name === 'CNC Panel').labels.some(l => l.name === 'Not needed' && l.done));
  const t2 = js.applyDoorShopTemplate('Office', '');
  check('applying it again changes nothing', !t2.columns.length && !t2.tabs.length && !t2.rules.length);
  const fl = () => js.fields(), F = n => fl().find(f => f.name === n);
  const done = n => F(n).labels.find(l => l.done).id;
  const shown = id => { const cur = Object.entries(js.cellsOf(id)).map(([f, c]) => ({ field_id: +f, label_id: c.label })); const dn = new Set(fl().flatMap(f => f.labels.filter(l => l.done).map(l => l.id)));
    return js.views().filter(v => v.filter.length && v.filter.every(c => js.holdsCond(c, cur, dn))).map(v => v.name).sort().join(' | '); };
  const tap = (id, ...names) => { for (const n of names) js.setCell(id, F(n).id, done(n), 'Office', ''); };
  const door = (number, needs) => js.createDoor({ number, components: [], needs }, 'Office');

  // a frame and a panel (the usual door)
  const a1 = door('26-801', { frame: true, panel: true, rs: false });
  check('frame + panel: cutting for the frame, and the panel is waited for from the provider', shown(a1) === 'Material Cutting | Panels coming in', shown(a1));
  tap(a1, 'Material Cutting');
  check('cutting does not hold up the panel, and the frame goes to CNC', shown(a1) === 'CNC Frame | Panels coming in');
  tap(a1, 'Panel Received');
  check('the panel is CNC\'d only once it has arrived', shown(a1) === 'CNC Frame | CNC Panel');
  tap(a1, 'CNC Panel', 'CNC Frame');
  check('the panel waits (on no tab) while the frame is filled', shown(a1) === 'Frame Filling', shown(a1));
  tap(a1, 'Frame Filling');
  check('with the parts that are needed finished, it is on Verification (no rail & stile held it up)', shown(a1) === 'Verification', shown(a1));

  // a rail & stile door: the same door with all three
  const a2 = door('26-802', { frame: true, panel: true, rs: true });
  tap(a2, 'Material Cutting');
  check('rail & stile adds its own CNC tab', shown(a2) === 'CNC Frame | CNC Rail & Stile | Panels coming in', shown(a2));
  tap(a2, 'Panel Received', 'CNC Panel', 'CNC Frame', 'Frame Filling', 'CNC Rail & Stile');
  check('it goes to Cliff\'s area to be filled and assembled, and Verification waits for it', shown(a2) === 'Rail & Stile (Cliff)', shown(a2));
  tap(a2, 'Rail & Stile Filling & Assembly');
  check('then all three come together at Verification', shown(a2) === 'Verification');

  // replacements: only one part
  const p1 = door('26-803', { frame: false, panel: true, rs: false });
  check('a panel-only replacement skips cutting altogether', shown(p1) === 'Panels coming in', shown(p1));
  tap(p1, 'Panel Received', 'CNC Panel');
  check('…and goes straight to Verification once the panel is done', shown(p1) === 'Verification', shown(p1));
  const f1 = door('26-804', { frame: true, panel: false, rs: false });
  check('a frame-only replacement needs cutting but no panel', shown(f1) === 'Material Cutting', shown(f1));
  tap(f1, 'Material Cutting', 'CNC Frame', 'Frame Filling');
  check('…and goes to Verification when the frame is filled', shown(f1) === 'Verification', shown(f1));
  const r1 = door('26-805', { frame: false, panel: false, rs: true });
  tap(r1, 'Material Cutting', 'CNC Rail & Stile', 'Rail & Stile Filling & Assembly');
  check('a rail & stile panel on its own goes cutting, CNC, Cliff, Verification', shown(r1) === 'Verification', shown(r1));
  check('a door with nothing to make has nothing to wait for', shown(door('26-806', { frame: false, panel: false, rs: false })) === 'Verification');

  // fixing what a door needs afterwards
  const c1 = door('26-807', { frame: true, panel: true, rs: false });
  js.setNeeds(c1, { frame: true, panel: true, rs: true }, 'Office', '');
  check('the office can say later that a door needs rail & stile', js.door(c1).needs.rs === true && shown(c1) === 'Material Cutting | Panels coming in');
  tap(c1, 'Material Cutting');
  check('…and the work already done is kept when it does', shown(c1) === 'CNC Frame | CNC Rail & Stile | Panels coming in');
  tap(c1, 'CNC Frame');
  js.setNeeds(c1, { frame: false, panel: true, rs: true }, 'Office', '');
  check('taking a part away sets it to Not needed', js.door(c1).needs.frame === false && !shown(c1).includes('Frame Filling'));
  js.setNeeds(c1, { frame: true, panel: true, rs: true }, 'Office', '');
  check('putting it back does not erase real progress', js.cellsOf(c1)[F('CNC Frame').id].label === done('CNC Frame') && js.door(c1).needs.frame === true);

  // wrapping and QC: one station, two steps, either order
  const w1 = door('26-808', { frame: true, panel: false, rs: false });
  tap(w1, 'Material Cutting', 'CNC Frame', 'Frame Filling', 'Verification', 'Paint Prep', 'Paint', 'Assembly');
  check('after assembly the door is on Wrapping & QC', shown(w1) === 'Wrapping & QC', shown(w1));
  tap(w1, 'QC');
  check('with QC done first it stays there until it is wrapped', shown(w1) === 'Wrapping & QC');
  tap(w1, 'Wrapping');
  check('then it goes to Shipping', shown(w1) === 'Shipping', shown(w1));
  tap(w1, 'Shipping');
  check('shipped doors leave the board by themselves', js.door(w1).archived === true && shown(w1) === '');

  // deleting a column or label does not leave tabs and rules pointing at nothing
  js.saveRules([{ name: 'Needs QC', when: { kind: 'cell', field: F('QC').id, label: done('QC') }, if: [], then: [{ do: 'comment', text: 'QC done' }] }], 'Office', '');
  js.deleteField(F('QC').id, 'Office', '');
  check('a tab loses a condition on a deleted column rather than keep pointing at it', js.views().every(v => v.filter.every(c => js.fields().some(f => f.id === c.field) && (c.with || []).every(x => js.fields().some(f => f.id === x)))));
  check('a rule that watched a deleted column is switched off', js.rules().find(r => r.name === 'Needs QC').enabled === false);
  // the order form's free-text notes, and rail & stile read from the panel type (as on the shop's real forms)
  {
    const XLSX = require('xlsx'), { Orders } = require('../src/orders'), { doorFromOrder } = require('../src/intake');
    const root = path.join(T, 'orders'); fs.mkdirSync(path.join(root, 'Door Orders'), { recursive: true });
    const make = (door, ptype, notes) => {
      const ws = {}, put = (a, v) => { ws[a] = { t: 's', v, w: String(v) }; };
      put('I4', 'Customer Name:'); put('J4', 'Acme'); put('I19', 'Panel Series'); put('J19', 'Mastergrain'); put('I20', 'Panel type:'); put('J20', ptype);
      put('I8', 'Target Ship Date:'); put('J8', 'September 24, 2026'); put('I45', 'Door Number:'); put('J45', door); put('B20', 'Hinge Side:'); put('E20', 'RH');
      put('B46', 'Other Notes:'); put('E46', notes[0]); put('C48', notes[1]); put('C51', notes[2]); if (notes[2]) put('H51', '10 MIN'); put('J47', 'Frame'); put('C58', 'Please Sign & date to confirm');
      ws['!ref'] = 'A1:AM70';
      XLSX.writeFile({ SheetNames: ['Main Order Form'], Sheets: { 'Main Order Form': ws } }, path.join(root, 'Door Orders', `Door ${door}.xlsx`), { bookType: 'xlsx' });
    };
    make('26-901', '2 panel', ['install lock', 'send capping separate', 'Trimmed 5/8" off panel CH']); make('26-902', 'Flush', ['-', '', '']);
    const o = new Orders(root, XLSX), list = o.list(), a = list.find(x => x.door === '26-901'), b = list.find(x => x.door === '26-902');
    check('the form\'s Other Notes are read, one line per row, stopping before "Please Sign"', a.f.orderNotes === 'install lock\nsend capping separate\nTrimmed 5/8" off panel CH · 10 MIN', a.f.orderNotes);
    check('a form with no notes has none', b.f.orderNotes === '');
    check('"2 panel" reads as rail & stile and "Flush" does not', doorFromOrder(a).needs.rs === true && doorFromOrder(b).needs.rs === false);
  }
  js.close();
} catch (e) {
  console.log('FAIL unexpected error: ' + (e && e.stack || e));
  fails.push('unexpected error');
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll passed');
process.exit(fails.length ? 1 : 0);
