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

  // tabs that show one station
  const views = js.views();
  js.saveViews(views.map((v, i) => ({ id: v.id, name: v.name, cols: v.cols, station: i === 0 ? st('Paint') : undefined })), 'Office', '');
  check('a tab can show only one station', js.views()[0].station === st('Paint') && js.views()[1].station === null);
  js.saveViews(js.views().map(v => ({ id: v.id, name: v.name, cols: v.cols })), 'Office', '');
  check('saving tabs without a station keeps the station (older screens)', js.views()[0].station === st('Paint'));
  js.saveLabels(stationId, station.labels.filter(l => l.name !== 'Paint').map(l => ({ id: l.id, name: l.name, color: l.color, done: l.done })), 'Office', '');
  check('deleting a station label clears the tabs that showed it', js.views()[0].station === null);
  js.close();
} catch (e) {
  console.log('FAIL unexpected error: ' + (e && e.stack || e));
  fails.push('unexpected error');
} finally {
  try { fs.rmSync(T, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(fails.length ? `\n${fails.length} FAILED` : '\nAll passed');
process.exit(fails.length ? 1 : 0);
