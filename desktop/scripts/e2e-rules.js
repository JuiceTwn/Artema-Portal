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
  const t = js.applyDoorShopTemplate('Office', '');
  const f2 = js.fields(), by = n => f2.find(f => f.name === n);
  check('the starter makes a column per step and reuses the ones that exist', t.columns.length === 10 && !t.columns.includes('CNC Frame') && by('Verification') && by('Paint').labels.some(l => l.done));
  const tabs = js.views(), tab = n => tabs.find(v => v.name === n);
  const ver = tab('Verification').filter;
  check('Verification waits for frame filling, the panel and the rail & stile', ver.length === 4 && ver.slice(0, 3).every(c => c.test === 'finished' && !c.not) && ver[3].not === true && ver[3].field === by('Verification').id);
  check('each station tab shows a door once the step before it is done', tab('Paint').filter.length === 2 && tab('Paint').filter[0].field === by('Paint Prep').id && tab('Where is everything').filter.length === 0);
  const t2 = js.applyDoorShopTemplate('Office', '');
  check('applying it again changes nothing', !t2.columns.length && !t2.tabs.length && !t2.rules.length);
  // walk one door through and check where it shows up
  const done = n => by(n).labels.find(l => l.done).id;
  const shown = id => { const cur = Object.entries(js.cellsOf(id)).map(([f, c]) => ({ field_id: +f, label_id: c.label })); const dn = new Set(js.fields().flatMap(f => f.labels.filter(l => l.done).map(l => l.id)));
    return js.views().filter(v => v.filter.length && v.filter.every(c => js.holdsCond(c, cur, dn))).map(v => v.name); };
  const d6 = js.createDoor({ number: '26-706', components: [] }, 'Office');
  check('a new door starts at Material Cutting, with no rail & stile', shown(d6).join() === 'Material Cutting' && js.cellsOf(d6)[by('CNC Rail & Stile').id].label === by('CNC Rail & Stile').labels.find(l => l.name === 'Not needed').id);
  js.setCell(d6, by('Material Cutting').id, done('Material Cutting'), 'Office', '');
  check('then it is on the three CNC tabs at once', shown(d6).sort().join() === 'CNC Frame,CNC Panel');
  js.setCell(d6, by('CNC Frame').id, done('CNC Frame'), 'Office', ''); js.setCell(d6, by('CNC Panel').id, done('CNC Panel'), 'Office', '');
  check('the frame goes to Frame Filling; the finished panel waits', shown(d6).join() === 'Frame Filling');
  js.setCell(d6, by('Frame Filling').id, done('Frame Filling'), 'Office', '');
  check('with everything made, it is on Verification alone', shown(d6).join() === 'Verification', shown(d6));
  for (const n of ['Verification', 'Paint Prep', 'Paint', 'Assembly', 'Wrapping & QC']) js.setCell(d6, by(n).id, done(n), 'Office', '');
  check('then it goes through paint prep, paint, assembly and QC to Shipping', shown(d6).join() === 'Shipping');
  js.setCell(d6, by('Shipping').id, done('Shipping'), 'Office', '');
  check('shipped doors leave the board by themselves', js.door(d6).archived === true && shown(d6).length === 0);
  js.close();
} catch (e) {
  console.log('FAIL unexpected error: ' + (e && e.stack || e));
  fails.push('unexpected error');
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll passed');
process.exit(fails.length ? 1 : 0);
