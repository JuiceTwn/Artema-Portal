'use strict';
/**
 * A starting point for a door shop's flow, applied with one tap by an admin and then edited like anything else.
 *
 * Every step is a status column ("Done" counts as done). A tab shows a door once the steps before it are finished and its own is not,
 * so a door turns up on the next station's tab by itself, and a step that needs several earlier ones (Verification) waits for all of them.
 *
 *   Material Cutting ─┬─ CNC Frame ───────── Frame Filling ──────────────┐
 *                     ├─ CNC Panel ──────────────────────────────────────┼─ Verification ─ Paint Prep ─ Paint ─ Assembly ─ Wrapping & QC ─ Shipping
 *                     └─ CNC Rail & Stile ─ Rail & Stile Filling & Assembly ┘
 *
 * Applying it twice changes nothing that already exists (columns, tabs and rules are matched by name).
 */
const DEFAULT_LABELS = [['Working on it', 'orange'], ['Done', 'green', 'done'], ['Stuck', 'red', 'attn']];
const RS_LABELS = [['Needed', 'blue'], ['Working on it', 'orange'], ['Done', 'green', 'done'], ['Not needed', 'grey', 'done'], ['Stuck', 'red', 'attn']];

/** name, steps that must be finished first, columns shown from the order form, labels. */
const STEPS = [
  { name: 'Material Cutting', after: [], form: ['size'] },
  { name: 'CNC Frame', after: ['Material Cutting'], form: ['size', 'frame', 'jamb'] },
  { name: 'CNC Panel', after: ['Material Cutting'], form: ['series', 'ptype', 'size'] },
  { name: 'CNC Rail & Stile', after: ['Material Cutting'], form: ['size'], labels: RS_LABELS },
  { name: 'Frame Filling', after: ['CNC Frame'], form: ['frame', 'jamb'] },
  { name: 'Rail & Stile Filling & Assembly', after: ['CNC Rail & Stile'], form: ['size'], labels: RS_LABELS },
  { name: 'Verification', after: ['Frame Filling', 'CNC Panel', 'Rail & Stile Filling & Assembly'], form: ['size', 'series', 'frame'] },
  { name: 'Paint Prep', after: ['Verification'], form: ['extFinish', 'intFinish', 'frameOut', 'frameIn'] },
  { name: 'Paint', after: ['Paint Prep'], form: ['extFinish', 'intFinish', 'frameOut', 'frameIn'] },
  { name: 'Assembly', after: ['Paint'], form: ['glass', 'handle', 'hardware'] },
  { name: 'Wrapping & QC', after: ['Assembly'], form: ['size'] },
  { name: 'Shipping', after: ['Wrapping & QC'], form: ['po', 'orderNo'] },
];
const TAB_NAME = { 'Rail & Stile Filling & Assembly': 'Rail & Stile (Cliff)' };

function install(JobStore, { actor, bad }) {
  Object.assign(JobStore.prototype, {
    applyDoorShopTemplate(dept, who) {
      const d = actor(dept);
      return this.tx(db => {
        const made = { columns: [], tabs: [], rules: [] };
        const ids = new Map(db.prepare('SELECT id, name FROM fields').all().map(f => [f.name.toLowerCase(), f.id]));
        const col = name => ids.get(name.toLowerCase());
        for (const s of STEPS) {
          if (col(s.name)) continue;
          ids.set(s.name.toLowerCase(), this.insertField(db, s.name, 'status', s.labels || DEFAULT_LABELS));
          made.columns.push(s.name);
        }
        const done = fid => (db.prepare('SELECT id FROM labels WHERE field_id = ? AND done = 1 ORDER BY position LIMIT 1').get(fid) || {}).id;
        for (const s of STEPS) if (!done(col(s.name))) throw bad(`“${s.name}” already exists but has no label that counts as done. Mark one in its labels, then try again.`);
        const labelId = (fid, name) => (db.prepare('SELECT id FROM labels WHERE field_id = ? AND name = ? COLLATE NOCASE').get(fid, name) || {}).id;

        const haveViews = new Set(db.prepare('SELECT name FROM views').all().map(v => v.name.toLowerCase()));
        let pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM views').get().p;
        const addView = (name, cols, filter) => {
          if (haveViews.has(name.toLowerCase())) return;
          db.prepare('INSERT INTO views (name, position, cols, filter) VALUES (?, ?, ?, ?)').run(name, pos++, JSON.stringify(cols), JSON.stringify(filter));
          made.tabs.push(name);
        };
        addView('Where is everything', ['door', 'updates', 'ship', 'customer', 'at', 'notes'], []);
        for (const s of STEPS) {
          const filter = [...s.after.map(a => ({ field: col(a), test: 'finished', not: false })), { field: col(s.name), test: 'finished', not: true }];
          addView(TAB_NAME[s.name] || s.name, ['door', 'updates', 'files', 'ship', 'customer', '#' + col(s.name), ...s.form.map(f => 'f:' + f), 'notes'], filter);
        }

        const haveRules = new Set(db.prepare('SELECT name FROM rules').all().map(r => r.name.toLowerCase()));
        let rpos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rules').get().p;
        const addRule = (name, rule) => {
          if (haveRules.has(name.toLowerCase())) return;
          db.prepare('INSERT INTO rules (name, position, enabled, rule) VALUES (?, ?, 1, ?)').run(name, rpos++, JSON.stringify(rule));
          made.rules.push(name);
        };
        const rs1 = col('CNC Rail & Stile'), rs2 = col('Rail & Stile Filling & Assembly'), ship = col('Shipping');
        const skip = [[rs1, labelId(rs1, 'Not needed')], [rs2, labelId(rs2, 'Not needed')]].filter(x => x[1]).map(([field, label]) => ({ do: 'set', field, label }));          // a column of your own without that label is left alone
        if (skip.length) addRule('New doors: no rail & stile unless the office says so', { when: { kind: 'added' }, if: [], then: skip });
        addRule('Shipped: take the door off the board', { when: { kind: 'cell', field: ship, label: done(ship) }, if: [], then: [{ do: 'archive' }] });

        this.event(db, null, 'board.template', d, who, { template: 'door-shop', ...made });
        return made;
      });
    },
  });
}

module.exports = { install, STEPS };
