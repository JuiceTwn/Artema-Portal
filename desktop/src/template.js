'use strict';
/**
 * A starting point for a door shop's flow, applied with one tap by an admin and then edited like anything else.
 *
 * Every step is a status column ("Done" counts as done). A tab shows a door once the steps before it are finished and its own is not,
 * so a door turns up on the next station's tab by itself, and a step that needs several earlier ones (Verification) waits for all of them.
 *
 *   Material Cutting ─┬─ CNC Frame ───────────── Frame Filling ──────────────────┐
 *                     └─ CNC Rail & Stile ─ Rail & Stile Filling & Assembly ──────┤
 *   Panel Received ───── CNC Panel ──────────────────────────────────────────────┴─ Verification ─ Paint Prep ─ Paint ─┐
 *   Glass Arrived ─ Glass QC (its own stream, on the shop's order form: arrived, QC, returned) ───────────────────────────┴─ Assembly ─ Wrapping, QC ─ Shipping
 *
 * Doors differ: a replacement may be only a frame, only a panel, or only a rail & stile panel. So each door says which of the three it
 * needs (needs.js): the others are set to "Not needed", which counts as finished, so nothing waits on a part that is not coming.
 * Material Cutting is only for frames and rail & stile (panels come from providers), so it is not needed when neither is.
 *
 * Applying it twice changes nothing that already exists (columns, tabs and rules are matched by name).
 */
const NOT_NEEDED = 'Not needed';
const PLAIN = [['Working on it', 'orange'], ['Done', 'green', 'done'], ['Stuck', 'red', 'attn']];
const OPTIONAL = [['Working on it', 'orange'], ['Done', 'green', 'done'], [NOT_NEEDED, 'grey', 'done'], ['Stuck', 'red', 'attn']];
const GLASS_IN = [['Ordered', 'orange'], ['Arrived', 'green', 'done'], [NOT_NEEDED, 'grey', 'done'], ['Stuck', 'red', 'attn']];
const GLASS_QC = [['Checking', 'orange'], ['Passed', 'green', 'done'], [NOT_NEEDED, 'grey', 'done'], ['Failed: returned', 'red', 'attn']];
const RECEIVING = [['Ordered', 'orange'], ['Received', 'green', 'done'], [NOT_NEEDED, 'grey', 'done'], ['Stuck', 'red', 'attn']];

/** name, steps that must be finished first, columns shown from the order form, labels. */
const STEPS = [
  { name: 'Material Cutting', after: [], form: ['frameOptions', 'size'], labels: OPTIONAL },
  { name: 'CNC Frame', after: ['Material Cutting'], form: ['frameOptions', 'size', 'frame', 'jamb'], labels: OPTIONAL },
  { name: 'Frame Filling', after: ['CNC Frame'], form: ['frame', 'jamb'], labels: OPTIONAL },
  { name: 'CNC Rail & Stile', after: ['Material Cutting'], form: ['size'], labels: OPTIONAL },
  { name: 'Rail & Stile Filling & Assembly', after: ['CNC Rail & Stile'], form: ['size'], labels: OPTIONAL, tab: 'Rail & Stile (Cliff)' },
  { name: 'Panel Received', after: [], form: ['series', 'ptype', 'size'], labels: RECEIVING, tab: 'Panels coming in' },
  { name: 'CNC Panel', after: ['Panel Received'], form: ['series', 'ptype', 'size'], labels: OPTIONAL },
  { name: 'Glass Arrived', after: [], form: ['glass'], labels: GLASS_IN, tab: 'Glass', also: ['Glass QC'] },
  { name: 'Glass QC', after: ['Glass Arrived'], form: [], labels: GLASS_QC, tab: null },
  { name: 'Verification', after: ['Frame Filling', 'CNC Panel', 'Rail & Stile Filling & Assembly'], form: ['size', 'series', 'frame'] },
  { name: 'Paint Prep', after: ['Verification'], form: ['extFinish', 'intFinish', 'frameOut', 'frameIn', 'paintFormula'] },
  { name: 'Paint', after: ['Paint Prep'], form: ['extFinish', 'intFinish', 'frameOut', 'frameIn', 'paintFormula'] },
  { name: 'Assembly', after: ['Paint', 'Glass QC'], form: ['frameOptions', 'glass', 'handle', 'hardware'] },
  // one station, two separate steps: the tab shows a door until both are done
  { name: 'Wrapping', after: ['Assembly'], form: ['size'], tab: 'Wrapping & QC', also: ['QC'] },
  { name: 'QC', after: ['Assembly'], form: [], tab: null },
  { name: 'Shipping', after: ['Wrapping', 'QC'], form: ['frameOptions', 'po', 'orderNo'] },
];
/** Which columns belong to which part of a door, and whether that part goes through cutting. */
const TRACKS = [
  { key: 'frame', name: 'Frame', cuts: true, fields: ['CNC Frame', 'Frame Filling'] },
  { name: 'Panel', key: 'panel', cuts: false, fields: ['Panel Received', 'CNC Panel'] },
  { name: 'Rail & stile panel', key: 'rs', cuts: true, fields: ['CNC Rail & Stile', 'Rail & Stile Filling & Assembly'] },
  { name: 'Glass', key: 'glass', cuts: false, fields: ['Glass Arrived', 'Glass QC'] },
];
const CUTTING = ['Material Cutting'];
const OBSOLETE_RULE = 'New doors: no rail & stile unless the office says so';          // from the first version of this starter

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
          ids.set(s.name.toLowerCase(), this.insertField(db, s.name, 'status', s.labels || PLAIN));
          made.columns.push(s.name);
        }
        // where the door's parts are (the shop's order form has a Cart #): one text on every station tab
        if (!col('Cart')) { ids.set('cart', this.insertField(db, 'Cart', 'text', null)); made.columns.push('Cart'); }
        // a column that was already there (CNC Frame, say) gets a "Not needed" label if the door can skip that part
        const optional = new Set([...TRACKS.flatMap(t => t.fields), ...CUTTING].map(n => n.toLowerCase()));
        for (const s of STEPS) {
          const fid = col(s.name);
          if (!optional.has(s.name.toLowerCase())) continue;
          if (!db.prepare('SELECT 1 FROM labels WHERE field_id = ? AND done = 1').get(fid)) throw bad(`“${s.name}” already exists but has no label that counts as done. Mark one in its labels, then try again.`);
          if (!db.prepare('SELECT 1 FROM labels WHERE field_id = ? AND name = ? COLLATE NOCASE').get(fid, NOT_NEEDED)) {
            const p = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM labels WHERE field_id = ?').get(fid).p;
            db.prepare('INSERT INTO labels (field_id, name, color, position, done, attn) VALUES (?, ?, ?, ?, 1, 0)').run(fid, NOT_NEEDED, 'grey', p);
          }
        }
        for (const s of STEPS) if (!db.prepare('SELECT 1 FROM labels WHERE field_id = ? AND done = 1').get(col(s.name))) throw bad(`“${s.name}” already exists but has no label that counts as done. Mark one in its labels, then try again.`);
        const done = fid => (db.prepare('SELECT id FROM labels WHERE field_id = ? AND done = 1 ORDER BY position LIMIT 1').get(fid) || {}).id;

        const haveViews = new Set(db.prepare('SELECT name FROM views').all().map(v => v.name.toLowerCase()));
        let pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM views').get().p;
        const addView = (name, cols, filter) => {
          if (haveViews.has(name.toLowerCase())) return;
          db.prepare('INSERT INTO views (name, position, cols, filter) VALUES (?, ?, ?, ?)').run(name, pos++, JSON.stringify(cols), JSON.stringify(filter));
          made.tabs.push(name);
        };
        addView('Where is everything', ['door', 'updates', 'ship', 'customer', 'at', 'notes'], []);
        for (const s of STEPS) {
          if (s.tab === null) continue;          // shares the tab of the step before it
          const group = [s.name, ...(s.also || [])];
          const filter = [...s.after.map(a => ({ field: col(a), test: 'finished', not: false })),
            group.length > 1 ? { field: col(group[0]), with: group.slice(1).map(col), test: 'finished', not: true } : { field: col(s.name), test: 'finished', not: true }];
          addView(s.tab || s.name, ['door', 'updates', 'files', 'ship', 'customer', ...group.map(g => '#' + col(g)), '#' + col('Cart'), ...s.form.map(f => 'f:' + f), 'notes'], filter);
        }

        // a tab from an earlier version of the starter: give it the Cart, and make Assembly wait for the glass
        for (const s of STEPS) {
          const v = db.prepare('SELECT id, cols, filter FROM views WHERE name = ? COLLATE NOCASE').get(s.tab || s.name);
          if (!v || s.tab === null || !made.tabs.length && false) continue;
          const cols = JSON.parse(v.cols), filter = JSON.parse(v.filter || '[]');
          let changed = false;
          if (!cols.includes('#' + col('Cart')) && cols.some(c => c[0] === '#')) { cols.splice(Math.max(1, cols.length - 1), 0, '#' + col('Cart')); changed = true; }
          if (s.name === 'Assembly' && !filter.some(c => c.field === col('Glass QC'))) { filter.splice(filter.length - 1, 0, { field: col('Glass Arrived'), with: [col('Glass QC')], test: 'finished', not: false }); changed = true; }
          if (changed) db.prepare('UPDATE views SET cols = ?, filter = ? WHERE id = ?').run(JSON.stringify(cols), JSON.stringify(filter), v.id);
        }

        // which columns are the door's parts: what "this door needs" switches
        db.prepare("INSERT INTO meta (key, value) VALUES ('needs', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .run(JSON.stringify({ cutting: CUTTING.map(col), tracks: TRACKS.map(t => ({ key: t.key, name: t.name, cuts: t.cuts, fields: t.fields.map(col) })) }));

        const haveRules = new Set(db.prepare('SELECT name FROM rules').all().map(r => r.name.toLowerCase()));
        let rpos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM rules').get().p;
        const addRule = (name, rule) => {
          if (haveRules.has(name.toLowerCase())) return;
          db.prepare('INSERT INTO rules (name, position, enabled, rule) VALUES (?, ?, 1, ?)').run(name, rpos++, JSON.stringify(rule));
          made.rules.push(name);
        };
        db.prepare('DELETE FROM rules WHERE name = ? COLLATE NOCASE').run(OBSOLETE_RULE);
        const ship = col('Shipping');
        addRule('Shipped: take the door off the board', { when: { kind: 'cell', field: ship, label: done(ship) }, if: [], then: [{ do: 'archive' }] });

        this.event(db, null, 'board.template', d, who, { template: 'door-shop', ...made });
        return made;
      });
    },
  });
}

module.exports = { install, STEPS, TRACKS, NOT_NEEDED };
