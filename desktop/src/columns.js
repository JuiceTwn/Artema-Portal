'use strict';
/**
 * The board's editable columns, in the spirit of the Monday board it replaces.
 *
 *  - A status column is a dropdown of labels (a name and a colour); admins add, rename, recolour, reorder and delete labels at will.
 *    Anyone sets a door's cell by picking a label. A label can be flagged "counts as done" or "needs a look" so reports can use it.
 *  - A column can also be a date or a text. Admins add, rename and remove columns.
 *  - A view (a tab) is a saved list of columns: built-ins (door, updates, files, ship date, customer, notes), details read from the
 *    order form ("f:size"), and the admin's own columns ("#12").
 *  - Per-door comments ("updates"), archiving, and the one switch that turns the guided steps (jobs.js) on or off.
 *
 * It adds methods to JobStore (see the end of jobs.js) so everything shares one database, one transaction helper and one event log.
 */

/** Label colours, by name: what is stored is the name, so the look can change in one place. */
const PALETTE = {
  blue: '#3a9bd0', sky: '#5fb6ea', periwinkle: '#6b8be8', lavender: '#a8b8e6', violet: '#7a79d9', mauve: '#8e5ea2',
  pink: '#f677cb', hotpink: '#ff3fa4', red: '#e8687c', coral: '#ff7b6b', salmon: '#ffb3b0', orange: '#fdab61',
  mustard: '#d6c260', yellow: '#f7d154', lime: '#b4dd4a', green: '#34c98a', forest: '#2c9763', teal: '#2aa7a0',
  brown: '#6b4640', grey: '#7e8499',
};
const FIELD_KINDS = ['status', 'date', 'text'];
const BUILTIN_COLS = ['door', 'updates', 'files', 'ship', 'customer', 'notes', 'at', 'where', 'next', 'flags'];
const MAX_LABELS = 40, MAX_FIELDS = 40, MAX_VIEWS = 30, MAX_COLS = 40, MAX_FILTER = 6;

/** What a fresh install starts with: the CNC columns as they are on the Monday board today. The admin changes all of it. */
const SEED_FIELDS = [
  { name: 'CNC Timeline', kind: 'date' },
  { name: 'CNC Frame', kind: 'status', labels: [
    ['Ready', 'blue'], ['Done', 'green', 'done'], ['Cutting Parts', 'orange'], ['Precut/Pre-assembly', 'lavender'], ['CNC Parts', 'lime'],
    ['Ready for Pre-assembly', 'pink'], ['Verification Needed', 'hotpink'], ['Precut/Cladding', 'violet'], ['Filling/QC', 'mustard'],
    ['Cut/Ready to Clad', 'forest'], ['Stuck', 'red', 'attn'],
  ] },
  { name: 'CNC Panel', kind: 'status', labels: [
    ['Ready', 'blue'], ['Verification Needed', 'hotpink'], ['Ready (Temp Panel)', 'periwinkle'], ['Done', 'green', 'done'], ['Panel needs trimmed', 'mauve'],
    ['Sidelight needs trimmed', 'violet'], ['Rail and stile', 'brown'], ['Working on it', 'coral'], ['Lift and slide', 'lime'], ['Stuck', 'red', 'attn'], ['Large Format', 'salmon'],
  ] },
];
const NEW_STATUS_LABELS = [['Working on it', 'orange'], ['Done', 'green', 'done'], ['Stuck', 'red', 'attn']];

function install(JobStore, { actor, text, bad, now }) {
  Object.assign(JobStore.prototype, {
    // ---- first start
    /** Creates the starting columns and tabs once (never again, even if the admin deletes them all). */
    seed() {
      const db = this.db;
      if (!db || db.prepare("SELECT 1 FROM meta WHERE key = 'seeded'").get()) return;
      try {
        db.exec('BEGIN IMMEDIATE');
        const ids = SEED_FIELDS.map(f => this.insertField(db, f.name, f.kind, f.labels));
        const cnc = ['door', 'updates', 'files', ...ids.map(id => '#' + id), 'notes'];
        const all = ['door', 'updates', 'files', 'ship', 'customer', ...ids.map(id => '#' + id), 'notes'];
        db.prepare('INSERT INTO views (name, position, cols) VALUES (?, 0, ?)').run('CNC', JSON.stringify(cnc));
        db.prepare('INSERT INTO views (name, position, cols) VALUES (?, 1, ?)').run('All doors', JSON.stringify(all));
        db.prepare("INSERT INTO meta (key, value) VALUES ('seeded', '1')").run();
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
    },
    insertField(db, name, kind, labels) {
      const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM fields').get().p;
      const id = Number(db.prepare('INSERT INTO fields (name, kind, position) VALUES (?, ?, ?)').run(name, kind, pos).lastInsertRowid);
      (labels || []).forEach(([n, color, flag], i) => db.prepare('INSERT INTO labels (field_id, name, color, position, done, attn) VALUES (?, ?, ?, ?, ?, ?)').run(id, n, color, i, flag === 'done' ? 1 : 0, flag === 'attn' ? 1 : 0));
      return id;
    },

    // ---- settings
    settings() { const row = this.need().prepare("SELECT value FROM meta WHERE key = 'guided'").get(); return { guided: !!row && row.value === '1' }; },
    /** Turns the guided steps (My work, the release checklist, repairs) on or off. Off is the normal way to run the board. */
    setGuided(on, dept, who) {
      const d = actor(dept);
      return this.tx(db => {
        db.prepare("INSERT INTO meta (key, value) VALUES ('guided', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0');
        this.event(db, null, 'board.guided', d, who, { on: !!on });
      });
    },

    // ---- reading the setup
    fields() {
      const db = this.need();
      const labels = db.prepare('SELECT id, field_id, name, color, position, done, attn FROM labels ORDER BY field_id, position, id').all();
      return db.prepare('SELECT id, name, kind, position FROM fields ORDER BY position, id').all().map(f => ({
        ...f, labels: labels.filter(l => l.field_id === f.id).map(l => ({ id: l.id, name: l.name, color: l.color, done: !!l.done, attn: !!l.attn })),
      }));
    },
    views() { return this.need().prepare('SELECT id, name, cols, filter FROM views ORDER BY position, id').all().map(v => ({ id: v.id, name: v.name, cols: JSON.parse(v.cols), filter: JSON.parse(v.filter || '[]') })); },
    /** The tabs a computer can be assigned to: those with a status column, so there is something to do there. */
    stationChoices() {
      const status = new Set(this.fields().filter(f => f.kind === 'status').map(f => '#' + f.id));
      return this.views().filter(v => v.cols.some(c => status.has(c))).map(v => ({ id: v.id, name: v.name }));
    },
    /** Everything a screen needs to draw the board's columns and tabs. */
    config() { return { ...this.settings(), fields: this.fields(), views: this.views(), rules: this.rules(), needs: this.needsConfig(), palette: PALETTE }; },

    // ---- columns (admin)
    addField(name, kind, dept, who) {
      const d = actor(dept), n = text(name, 40);
      if (!n) throw bad('A column needs a name');
      if (!FIELD_KINDS.includes(kind)) throw bad('Pick what kind of column it is');
      return this.tx(db => {
        if (db.prepare('SELECT COUNT(*) AS c FROM fields').get().c >= MAX_FIELDS) throw bad('That is as many columns as the board can hold');
        const id = this.insertField(db, n, kind, kind === 'status' ? NEW_STATUS_LABELS.map(([a, b, c]) => [a, b, c]) : null);
        this.event(db, null, 'board.field.added', d, who, { field: id, name: n, kind });
        return id;
      });
    },
    renameField(id, name, dept, who) {
      const d = actor(dept), n = text(name, 40);
      if (!n) throw bad('A column needs a name');
      return this.tx(db => {
        const r = db.prepare('UPDATE fields SET name = ? WHERE id = ?').run(n, Number(id));
        if (!r.changes) throw bad('No such column', 404);
        this.event(db, null, 'board.field.renamed', d, who, { field: Number(id), name: n });
      });
    },
    deleteField(id, dept, who) {
      const d = actor(dept);
      return this.tx(db => {
        const f = db.prepare('SELECT name FROM fields WHERE id = ?').get(Number(id));
        if (!f) throw bad('No such column', 404);
        this.forgetRefs(db, { field: Number(id) });
        db.prepare('DELETE FROM fields WHERE id = ?').run(Number(id));          // its labels and every door's value go with it
        for (const v of db.prepare('SELECT id, cols FROM views').all()) {
          const cols = JSON.parse(v.cols).filter(c => c !== '#' + id);
          db.prepare('UPDATE views SET cols = ? WHERE id = ?').run(JSON.stringify(cols), v.id);
        }
        this.event(db, null, 'board.field.deleted', d, who, { field: Number(id), name: f.name });
      });
    },

    /**
     * Replaces a status column's labels with `labels` ([{ id?, name, color, done, attn }], in order). A label with an id is changed,
     * one without is new, and an old label left out is deleted: doors that had it simply show it blank.
     */
    saveLabels(fieldId, labels, dept, who) {
      const d = actor(dept);
      if (!Array.isArray(labels)) throw bad('No labels given');
      if (labels.length > MAX_LABELS) throw bad(`A column can have up to ${MAX_LABELS} labels`);
      const clean = labels.map(l => ({ id: l && l.id ? Number(l.id) : 0, name: text(l && l.name, 40), color: l && l.color, done: !!(l && l.done), attn: !!(l && l.attn) }));
      for (const l of clean) {
        if (!l.name) throw bad('Every label needs a name');
        if (!PALETTE[l.color]) throw bad('Pick a colour for ' + l.name);
      }
      if (new Set(clean.map(l => l.name.toLowerCase())).size !== clean.length) throw bad('Two labels have the same name');
      return this.tx(db => {
        const f = db.prepare('SELECT kind FROM fields WHERE id = ?').get(Number(fieldId));
        if (!f) throw bad('No such column', 404);
        if (f.kind !== 'status') throw bad('Only a status column has labels');
        const have = new Set(db.prepare('SELECT id FROM labels WHERE field_id = ?').all(Number(fieldId)).map(r => r.id));
        for (const l of clean) if (l.id && !have.has(l.id)) throw bad('That label is not in this column');
        const keep = new Set(clean.filter(l => l.id).map(l => l.id));
        const dropped = [...have].filter(id => !keep.has(id));
        if (dropped.length) this.forgetRefs(db, { field: -1, labels: dropped });
        for (const id of dropped) db.prepare('DELETE FROM labels WHERE id = ?').run(id);
        clean.forEach((l, i) => {
          if (l.id) db.prepare('UPDATE labels SET name = ?, color = ?, position = ?, done = ?, attn = ? WHERE id = ?').run(l.name, l.color, i, l.done ? 1 : 0, l.attn ? 1 : 0, l.id);
          else db.prepare('INSERT INTO labels (field_id, name, color, position, done, attn) VALUES (?, ?, ?, ?, ?, ?)').run(Number(fieldId), l.name, l.color, i, l.done ? 1 : 0, l.attn ? 1 : 0);
        });
        this.event(db, null, 'board.labels.saved', d, who, { field: Number(fieldId), count: clean.length });
      });
    },

    /** Replaces the tabs: [{ id?, name, cols }] in order. A tab needs a name and its columns must exist. At least one tab stays. */
    saveViews(views, dept, who) {
      const d = actor(dept);
      if (!Array.isArray(views) || !views.length) throw bad('There must be at least one tab');
      if (views.length > MAX_VIEWS) throw bad(`There can be up to ${MAX_VIEWS} tabs`);
      return this.tx(db => {
        const fieldIds = new Set(db.prepare('SELECT id FROM fields').all().map(r => String(r.id)));
        const okCol = c => typeof c === 'string' && (BUILTIN_COLS.includes(c) || /^f:[a-zA-Z][a-zA-Z0-9]{0,24}$/.test(c) || (c[0] === '#' && fieldIds.has(c.slice(1))));
        const have = new Set(db.prepare('SELECT id FROM views').all().map(r => r.id));
        const clean = views.map(v => {
          const name = text(v && v.name, 40);
          if (!name) throw bad('Every tab needs a name');
          const cols = [...new Set(Array.isArray(v.cols) ? v.cols : [])];
          if (cols.length > MAX_COLS) throw bad('That is too many columns for one tab');
          if (!cols.every(okCol)) throw bad('A tab has a column that does not exist');
          if (!cols.includes('door')) cols.unshift('door');          // every tab starts with the door
          if (v.id && !have.has(Number(v.id))) throw bad('No such tab', 404);
                    const was = v.id ? db.prepare('SELECT filter FROM views WHERE id = ?').get(Number(v.id)) : null;
          const filter = v.filter === undefined ? (was ? JSON.parse(was.filter) : []) : this.cleanConds(db, v.filter, MAX_FILTER, `“${name}”`);          // not sent: keep what is there
          return { id: v.id ? Number(v.id) : 0, name, cols, filter: JSON.stringify(filter) };
        });
        const keep = new Set(clean.filter(v => v.id).map(v => v.id));
        for (const id of have) if (!keep.has(id)) db.prepare('DELETE FROM views WHERE id = ?').run(id);
        clean.forEach((v, i) => {
          if (v.id) db.prepare('UPDATE views SET name = ?, cols = ?, position = ?, filter = ? WHERE id = ?').run(v.name, JSON.stringify(v.cols), i, v.filter, v.id);
          else db.prepare('INSERT INTO views (name, position, cols, filter) VALUES (?, ?, ?, ?)').run(v.name, i, JSON.stringify(v.cols), v.filter);
        });
        this.event(db, null, 'board.views.saved', d, who, { count: clean.length });
      });
    },

    // ---- a door's values
    /**
     * Sets one cell. A status takes a label id (or null to clear), a date takes yyyy-mm-dd (or '' to clear), a text takes up to 200
     * characters. Anyone may do this: it is what the floor does all day. The change is logged against the department.
     */
    setCell(ref, fieldId, value, dept, who) {
      const d = actor(dept);
      return this.tx(db => {
        const ctx = this.ruleContext();
        this.writeCell(db, this.doorId(ref), fieldId, value, d, who, ctx);
        return ctx.auto;          // what the rules changed as a result, so the screen can offer one Undo for all of it
      });
    },
    /**
     * The inside of setCell, inside the caller's transaction. When something really changed, the rules that watch that cell run
     * (rules.js). `ctx` carries the chain so a rule runs at most once per change; `by` is set when a rule is the one changing it.
     */
    writeCell(db, id, fieldId, value, d, who, ctx, by) {
      const f = db.prepare('SELECT id, name, kind FROM fields WHERE id = ?').get(Number(fieldId));
      if (!f) throw bad('No such column', 404);
      let label = null, val = '', shown = '';
      if (f.kind === 'status') {
        if (value !== null && value !== undefined && value !== '') {
          const l = db.prepare('SELECT id, name FROM labels WHERE id = ? AND field_id = ?').get(Number(value), f.id);
          if (!l) throw bad('That label is not in this column');
          label = l.id; shown = l.name;
        }
      } else if (f.kind === 'date') {
        val = String(value == null ? '' : value).trim();
        if (val && !/^\d{4}-\d{2}-\d{2}$/.test(val)) throw bad('That is not a date');
        if (val && Number.isNaN(Date.parse(val + 'T12:00:00'))) throw bad('That is not a date');
        shown = val;
      } else { val = text(value, 200); shown = val; }
      const old = db.prepare('SELECT label_id, value FROM cells WHERE door_id = ? AND field_id = ?').get(id, f.id);
      if ((old ? old.label_id : null) === label && (old ? old.value : '') === val) return false;
      if (label === null && val === '') db.prepare('DELETE FROM cells WHERE door_id = ? AND field_id = ?').run(id, f.id);
      else db.prepare('INSERT INTO cells (door_id, field_id, label_id, value, at, dept) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(door_id, field_id) DO UPDATE SET label_id = excluded.label_id, value = excluded.value, at = excluded.at, dept = excluded.dept')
        .run(id, f.id, label, val, now(), d);
      this.event(db, id, 'cell.set', d, who, by ? { field: f.id, name: f.name, value: shown, rule: by } : { field: f.id, name: f.name, value: shown });
      if (by && ctx) ctx.auto.push({ door: id, field: f.id, name: f.name, before: old ? old.label_id : null, after: label, rule: by });
      if (ctx && ctx.rules !== false && f.kind === 'status') this.runRules(db, id, { kind: 'cell', field: f.id, label }, ctx);
      return true;
    },
    /** Puts several cells back exactly as given, without running any rules: the one Undo for a change and everything it set off. */
    setCells(changes, dept, who) {
      const d = actor(dept);
      if (!Array.isArray(changes) || changes.length > 50) throw bad('Nothing to undo');
      return this.tx(db => {
        const ctx = { rules: false, auto: [] };
        for (const c of changes) this.writeCell(db, this.doorId(c.id), c.field, c.value, d, who, ctx);
      });
    },
    /** { fieldId: { label, value } } for one door. */
    cellsOf(doorId) {
      const out = {};
      for (const c of this.need().prepare("SELECT field_id, label_id, value FROM cells WHERE door_id = ? AND NOT (label_id IS NULL AND value = '')").all(doorId)) out[c.field_id] = { label: c.label_id, value: c.value };
      return out;
    },

    // ---- comments ("updates") on a door
    addComment(ref, body, dept, who) {
      const d = actor(dept), t = String(body == null ? '' : body).replace(/\r/g, '').trim().slice(0, 1000);
      if (!t) throw bad('Write something first');
      return this.tx(db => {
        const id = this.doorId(ref);
        const cid = Number(db.prepare('INSERT INTO comments (door_id, at, dept, who, body) VALUES (?, ?, ?, ?, ?)').run(id, now(), d, text(who, 80), t).lastInsertRowid);
        this.event(db, id, 'comment.added', d, who, { comment: cid });
        return cid;
      });
    },
    comments(ref) { return this.need().prepare('SELECT id, at, dept, who, body FROM comments WHERE door_id = ? ORDER BY id').all(this.doorId(ref)); },
    commentCount(doorId) { return this.need().prepare('SELECT COUNT(*) AS n FROM comments WHERE door_id = ?').get(doorId).n; },

    // ---- finished doors leave the board without being deleted
    setArchived(ref, on, dept, who) {
      const d = actor(dept);
      return this.tx(db => {
        const id = this.doorId(ref);
        db.prepare('UPDATE doors SET archived_at = ? WHERE id = ?').run(on ? now() : null, id);
        this.event(db, id, on ? 'door.archived' : 'door.restored', d, who, {});
      });
    },
  });
}

module.exports = { install, PALETTE, FIELD_KINDS, BUILTIN_COLS };
