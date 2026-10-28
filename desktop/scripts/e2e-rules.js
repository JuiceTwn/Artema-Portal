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
  check('the starter makes a column per step and reuses the ones that exist', t.columns.length === 15 && !t.columns.includes('CNC Frame') && by('Verification') && by('Wrapping') && by('QC') && by('Panel Received'), t.columns);
  check('a column that was already there gets a "Not needed" label that counts as done', js.fields().find(f => f.name === 'CNC Panel').labels.some(l => l.name === 'Not needed' && l.done));
  const t2 = js.applyDoorShopTemplate('Office', '');
  check('applying it again changes nothing', !t2.columns.length && !t2.tabs.length && !t2.rules.length);
  const fl = () => js.fields(), F = n => fl().find(f => f.name === n);
  const done = n => F(n).labels.find(l => l.done).id;
  const shown = id => { const cur = Object.entries(js.cellsOf(id)).map(([f, c]) => ({ field_id: +f, label_id: c.label })); const dn = new Set(fl().flatMap(f => f.labels.filter(l => l.done).map(l => l.id)));
    return js.views().filter(v => v.filter.length && v.filter.every(c => js.holdsCond(c, cur, dn))).map(v => v.name).sort().join(' | '); };
  const tap = (id, ...names) => { for (const n of names) js.setCell(id, F(n).id, done(n), 'Office', ''); };
  const door = (number, needs) => js.createDoor({ number, components: [], needs: { glass: false, ...needs } }, 'Office');          // glass has its own scenarios below

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
  check('the office can say later that a door needs rail & stile', js.door(c1).needs.rs === true && shown(c1) === 'Material Cutting | Panels coming in', shown(c1));
  tap(c1, 'Material Cutting');
  check('…and the work already done is kept when it does', shown(c1) === 'CNC Frame | CNC Rail & Stile | Panels coming in');
  tap(c1, 'CNC Frame');
  js.setNeeds(c1, { frame: false, panel: true, rs: true }, 'Office', '');
  check('taking a part away sets it to Not needed', js.door(c1).needs.frame === false && !shown(c1).includes('Frame Filling'));
  js.setNeeds(c1, { frame: true, panel: true, rs: true }, 'Office', '');
  check('putting it back does not erase real progress', js.cellsOf(c1)[F('CNC Frame').id].label === done('CNC Frame') && js.door(c1).needs.frame === true);

  // glass: its own stream (arrived, then QC), and Assembly waits for it
  const g1 = door('26-809', { frame: true, panel: false, rs: false, glass: true });
  tap(g1, 'Material Cutting', 'CNC Frame', 'Frame Filling', 'Verification', 'Paint Prep', 'Paint');
  check('a door with glass is on the Glass tab from the start, and Assembly waits for it', shown(g1) === 'Glass', shown(g1));
  tap(g1, 'Glass Arrived');
  check('glass that has arrived still has to pass QC (the tab keeps it)', shown(g1) === 'Glass', shown(g1));
  tap(g1, 'Glass QC');
  check('with glass checked, the door can be assembled', shown(g1) === 'Assembly', shown(g1));
  const g2 = door('26-810', { frame: true, panel: false, rs: false, glass: false });
  check('a door with no glass never shows on the Glass tab', !shown(g2).includes('Glass'));
  check('the Cart column is on every station tab', js.views().filter(v => v.filter.length).every(v => v.cols.includes('#' + F('Cart').id)));

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
  // corrections: rework as a record, with minutes
  {
    const cd = js.createDoor({ number: '26-950', components: [] }, 'Office');
    js.addCorrection(cd, { reason: 'Trimmed', minutes: 10, station: 'Assembly', note: 'trimmed 5/8 off top of panel' }, 'Assembly', 'CH');
    js.addCorrection(cd, { reason: 'Re-painted', minutes: 45, station: 'Paint' }, 'Paint', '');
    js.addCorrection(cd, { reason: 'Trimmed', minutes: 5, station: 'Assembly' }, 'Assembly', 'CH');
    const sum = js.correctionSummary(30);
    check('corrections are logged with who, where and how long', js.corrections(cd).length === 3 && js.corrections(cd)[2].who === 'CH' && js.corrections(cd)[2].minutes === 10);
    check('the summary totals the minutes and doors', sum.total.count === 3 && sum.total.minutes === 60 && sum.total.doors === 1, sum.total);
    check('…and ranks the reasons and stations by the minutes they cost', sum.byReason[0].name === 'Re-painted' && sum.byReason[0].minutes === 45 && sum.byStation.find(x => x.name === 'Assembly').minutes === 15, sum.byStation);
    check('a correction needs a reason and sensible minutes', throws(() => js.addCorrection(cd, { reason: '', minutes: 5 }, 'Paint', ''), 400) && throws(() => js.addCorrection(cd, { reason: 'Trimmed', minutes: -5 }, 'Paint', ''), 400));
    check('it is in the door\'s history', js.events(20, cd).some(e => e.kind === 'correction.added' && e.data.minutes === 45));
  }

  // the order form's free-text notes, and rail & stile read from the panel type (as on the shop's real forms)
  {
    const XLSX = require('xlsx'), { Orders } = require('../src/orders'), { doorFromOrder } = require('../src/intake');
    const root = path.join(T, 'orders'); fs.mkdirSync(path.join(root, 'Door Orders'), { recursive: true });
    const make = (door, series, ptype, sidePtype, notes) => {
      const ws = {}, put = (a, v) => { ws[a] = { t: 's', v, w: String(v) }; };
      put('I4', 'Customer Name:'); put('J4', 'Acme'); put('I19', 'Panel Series'); put('J19', series); put('I20', 'Panel type:'); put('J20', ptype);
      put('I25', 'Main Door glass size:'); put('J25', door === '26-903' ? 'FALSE' : '22 x 64 x 1');
      if (sidePtype) { put('I31', 'Panel type:'); put('J31', sidePtype); }
      put('I8', 'Target Ship Date:'); put('J8', 'September 24, 2026'); put('I45', 'Door Number:'); put('J45', door); put('B20', 'Hinge Side:'); put('E20', 'RH');
      put('B46', 'Other Notes:'); put('E46', notes[0]); put('C48', notes[1]); put('C51', notes[2]); if (notes[2]) put('H51', '10 MIN'); put('J47', 'Frame'); put('C58', 'Please Sign & date to confirm');
      put('I73', 'Mixed in House / Formula #:'); put('J73', '109971542');
      ws['!ref'] = 'A1:AM80';
      const pl = {}, pp = (a, v) => { pl[a] = { t: 's', v, w: String(v) }; }, pn = (a, v) => { pl[a] = { t: 'n', v, w: String(v) }; };
      pp('A11', '800 Side Jambs'); pp('D11', 'Quantity'); pp('F11', 'Cut'); pp('G11', 'Prep'); pp('H11', 'Filled'); pp('I11', 'Paint Prep'); pp('J11', 'Painted'); pp('K11', 'Quality');
      pp('A12', 'Door Jamb'); pp('C12', '97 1/4'); pn('D12', 2); pp('E12', '1,2'); pp('F12', 'Done'); pp('G12', 'Done'); pp('H12', '-'); pp('I12', '-');
      pp('A13', 'FALSE'); pp('D13', 'FALSE'); pp('A14', '800 Header'); pp('D14', 'Quantity'); pp('F14', 'Cut'); pp('G14', 'Prep'); pp('H14', 'Filled');
      pp('A15', 'Frame Header'); pp('C15', '44 1/4'); pn('D15', 1); pp('F15', 'Done'); pp('G15', 'Done'); pp('H15', '-');
      pp('A54', 'Other Components'); pp('D54', 'Quantity'); pp('F54', 'Cut'); pp('A56', 'door panel'); pp('C56', 'FALSE'); pn('D56', 1); pp('F56', '-');
      pl['!ref'] = 'A1:K70';
      XLSX.writeFile({ SheetNames: ['Main Order Form', 'Parts List'], Sheets: { 'Main Order Form': ws, 'Parts List': pl } }, path.join(root, 'Door Orders', `Door ${door}.xlsx`), { bookType: 'xlsx' });
    };
    make('26-901', 'Mastergrain Smooth Edge', '2 panel', '', ['install lock', 'send capping separate', 'Trimmed 5/8" off panel CH']);
    make('26-902', 'Traditional Rail and Stile', 'Flush', '', ['-', '', '']);
    make('26-903', 'Richersons Smooth skin', 'Flush', 'Modern Rail and Stile', ['-', '', '']);
    const o = new Orders(root, XLSX), list = o.list(), by = d => list.find(x => x.door === d);
    check('the form\'s Other Notes are read, one line per row, stopping before "Please Sign"', by('26-901').f.orderNotes === 'install lock\nsend capping separate\nTrimmed 5/8" off panel CH · 10 MIN', by('26-901').f.orderNotes);
    check('a form with no notes has none', by('26-902').f.orderNotes === '');
    check('"2 panel" and "Flush" are ordinary panels; a "... Rail and Stile" series is rail & stile', doorFromOrder(by('26-901')).needs.rs === false && doorFromOrder(by('26-902')).needs.rs === true);
    check('a rail & stile sidelight panel makes the door need rail & stile too', by('26-903').f.sidelightPanelType === 'Modern Rail and Stile' && doorFromOrder(by('26-903')).needs.rs === true);
    check('glass is needed when the form gives a glass size, and not when it says FALSE', doorFromOrder(by('26-901')).needs.glass === true && doorFromOrder(by('26-903')).needs.glass === false, [by('26-903').f.glassSize]);
    check('the paint formula is read', by('26-901').f.paintFormula === '109971542');
    const parts = o.parts(by('26-901').rel);
    check('the Parts List is read in blocks with sizes, quantities and what is done', parts.length === 3 && parts[0].title === '800 Side Jambs' && parts[0].parts[0].name === 'Door Jamb' && parts[0].parts[0].length === '97 1/4' && parts[0].parts[0].qty === 2 && parts[0].parts[0].done.cut === true && parts[0].parts[0].done.filled === false, JSON.stringify(parts[0]));
    check('empty template rows (FALSE) are skipped', parts.every(sec => sec.parts.every(p => p.name !== 'FALSE')));

    // catching a door up from its Parts List
    const cu = js.createDoor({ number: '26-901', components: [], sourcePath: 'Door Orders/Door 26-901.xlsx', needs: { glass: false } }, 'Office');
    const plan = js.catchupPlan(cu, parts);
    check('catch-up: cut and prepped parts set Material Cutting and CNC Frame, and say why', plan.steps.map(x => x.column).join() === 'Material Cutting,CNC Frame' && /All 2 frame parts are cut/.test(plan.steps[0].why) && /jamb and header/.test(plan.steps[1].why), plan.steps);
    check('…and it does not claim filling that is not done', !plan.steps.some(x => x.column === 'Frame Filling'));
    for (const st of plan.steps) js.setCell(cu, st.field, st.label, 'Office', '');
    check('the door then lands where the work really is', shown(cu) === 'Frame Filling | Panels coming in', shown(cu));
    check('applying it again changes nothing (already done)', js.catchupPlan(cu, parts).steps.every(x => x.already));
    const none = js.createDoor({ number: '26-904', components: [], needs: { frame: false } }, 'Office');
    check('a door with no frame is not caught up from frame parts', js.catchupPlan(none, parts).steps.length === 0);
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
