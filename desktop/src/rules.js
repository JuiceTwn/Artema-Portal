'use strict';
/**
 * Automations: a door moves itself. A rule is data an admin edits, run on the main computer in the same transaction as the change
 * that set it off, so a change and its follow-ups happen together or not at all.
 *
 *   when   a status becomes a label (or any label), or a door is added
 *   if     up to a few statuses are (or are not) a given label
 *   then   set a status, move a status to its next label, add an update, or archive the door
 *
 * "Move to the next station" is a status column (usually called Station) whose labels are the stations in order, plus the `next`
 * action. A door turning up in the next station's tab is the notification, so nothing needs a login, an email or a sound.
 *
 * Safety: a rule runs at most once per change however the rules chain, a chain is cut off after a few steps, and every automatic
 * change is in the history as "Automation" with the rule's name. The screen can undo a change together with what it set off (setCells).
 */
const MAX_RULES = 50, MAX_IF = 3, MAX_THEN = 5, MAX_CHAIN = 8;
const WHEN_KINDS = ['cell', 'added'], DOS = ['set', 'next', 'comment', 'archive'];

function install(JobStore, { text, bad, now }) {
  Object.assign(JobStore.prototype, {
    /**
     * Checks a list of conditions on statuses, used by rules ("if") and by tabs (which doors to show). A condition is
     * { field, test: 'label' | 'finished', label?, not } : the status is that label, or its label is flagged "counts as done".
     * `not` turns it round. Returns them in their stored form; anything pointing at a column or label that does not exist is refused.
     */
    cleanConds(db, list, max, who) {
      if (!Array.isArray(list)) return [];
      if (list.length > max) throw bad(`${who}: up to ${max} conditions`);
      const fields = new Map(db.prepare('SELECT id, kind FROM fields').all().map(f => [f.id, f.kind]));
      const labels = new Map(db.prepare('SELECT id, field_id FROM labels').all().map(l => [l.id, l.field_id]));
      return list.map(c => {
        if (!c || fields.get(Number(c.field)) !== 'status') throw bad(`${who}: a condition needs a status column`);
        const test = c.test === 'finished' ? 'finished' : 'label';
        if (test === 'finished') return { field: Number(c.field), test, not: !!c.not };
        if (labels.get(Number(c.label)) !== Number(c.field)) throw bad(`${who}: a condition points at a label that does not exist`);
        return { field: Number(c.field), test, label: Number(c.label), not: !!c.not };
      });
    },
    /** Does a door's status meet a condition? `cur` is [{ field_id, label_id }] and `done` the ids of labels that count as done. */
    holdsCond(c, cur, done) {
      const at = cur.find(x => x.field_id === c.field), id = at ? at.label_id : null;
      const yes = c.test === 'finished' ? id !== null && done.has(id) : id === c.label;
      return yes !== !!c.not;
    },

    /** The record that follows one change through the rules. */
    ruleContext() { return { fired: new Set(), depth: 0, auto: [], rules: true }; },

    rules() {
      return this.need().prepare('SELECT id, name, enabled, rule FROM rules ORDER BY position, id').all().map(r => ({ id: r.id, name: r.name, enabled: !!r.enabled, ...JSON.parse(r.rule) }));
    },

    /**
     * Replaces the rules with `list` ([{ id?, name, enabled, when, if, then }], in order). Anything pointing at a column or label that
     * does not exist is refused, so a saved rule can always run.
     */
    saveRules(list, dept, who) {
      const d = require('./jobs').ACTORS.find(a => a.toLowerCase() === text(dept).toLowerCase());
      if (!d) throw bad('Pick a department first');
      if (!Array.isArray(list)) throw bad('No rules given');
      if (list.length > MAX_RULES) throw bad(`There can be up to ${MAX_RULES} rules`);
      return this.tx(db => {
        const fields = new Map(db.prepare('SELECT id, kind FROM fields').all().map(f => [f.id, f.kind]));
        const labels = new Map(db.prepare('SELECT id, field_id FROM labels').all().map(l => [l.id, l.field_id]));
        const fieldOk = (id, status) => fields.has(Number(id)) && (!status || fields.get(Number(id)) === 'status');
        const labelOk = (field, label) => labels.get(Number(label)) === Number(field);
        const have = new Set(db.prepare('SELECT id FROM rules').all().map(r => r.id));
        const clean = list.map(r => {
          const name = text(r && r.name, 60);
          if (!name) throw bad('Every rule needs a name');
          const w = r.when || {}, when = { kind: w.kind };
          if (!WHEN_KINDS.includes(when.kind)) throw bad(`“${name}”: pick what starts it`);
          if (when.kind === 'cell') {
            if (!fieldOk(w.field, true)) throw bad(`“${name}”: pick a status column to watch`);
            when.field = Number(w.field); when.label = w.label === null || w.label === undefined || w.label === '' ? null : Number(w.label);
            if (when.label !== null && !labelOk(when.field, when.label)) throw bad(`“${name}”: that label is not in the column it watches`);
          }
          const conds = this.cleanConds(db, r.if, MAX_IF, `“${name}”`);
          const acts = (Array.isArray(r.then) ? r.then : []).map(a => {
            if (!a || !DOS.includes(a.do)) throw bad(`“${name}”: pick what it does`);
            if (a.do === 'set') {
              if (!fieldOk(a.field, true) || !(a.label === null || labelOk(a.field, a.label))) throw bad(`“${name}”: an action points at a label that does not exist`);
              return { do: 'set', field: Number(a.field), label: a.label === null ? null : Number(a.label) };
            }
            if (a.do === 'next') {
              if (!fieldOk(a.field, true)) throw bad(`“${name}”: pick the column to move forward`);
              return { do: 'next', field: Number(a.field) };
            }
            if (a.do === 'comment') {
              const t = text(a.text, 200);
              if (!t) throw bad(`“${name}”: an update needs some words`);
              return { do: 'comment', text: t };
            }
            return { do: 'archive' };
          });
          if (!acts.length) throw bad(`“${name}”: it needs something to do`);
          if (acts.length > MAX_THEN) throw bad(`“${name}”: a rule can do up to ${MAX_THEN} things`);
          if (r.id && !have.has(Number(r.id))) throw bad('No such rule', 404);
          return { id: r.id ? Number(r.id) : 0, name, enabled: r.enabled !== false, body: JSON.stringify({ when, if: conds, then: acts }) };
        });
        const keep = new Set(clean.filter(r => r.id).map(r => r.id));
        for (const id of have) if (!keep.has(id)) db.prepare('DELETE FROM rules WHERE id = ?').run(id);
        clean.forEach((r, i) => {
          if (r.id) db.prepare('UPDATE rules SET name = ?, position = ?, enabled = ?, rule = ? WHERE id = ?').run(r.name, i, r.enabled ? 1 : 0, r.body, r.id);
          else db.prepare('INSERT INTO rules (name, position, enabled, rule) VALUES (?, ?, ?, ?)').run(r.name, i, r.enabled ? 1 : 0, r.body);
        });
        this.event(db, null, 'board.rules.saved', d, who, { count: clean.length });
      });
    },

    /**
     * Runs the rules that watch `trigger` ({ kind: 'cell', field, label } or { kind: 'added' }) on one door, inside the caller's
     * transaction. Their changes can set off further rules; each rule fires at most once for the whole chain.
     */
    runRules(db, doorId, trigger, ctx) {
      if (!ctx || ctx.rules === false || ctx.depth >= MAX_CHAIN) return;
      const rows = db.prepare('SELECT id, name, rule FROM rules WHERE enabled = 1 ORDER BY position, id').all();
      if (!rows.length) return;
      for (const row of rows) {
        if (ctx.fired.has(row.id)) continue;
        const r = JSON.parse(row.rule), w = r.when;
        if (w.kind !== trigger.kind) continue;
        if (w.kind === 'cell' && (w.field !== trigger.field || (w.label !== null && w.label !== trigger.label))) continue;
        const cur = db.prepare('SELECT field_id, label_id FROM cells WHERE door_id = ?').all(doorId);
        const done = new Set(db.prepare('SELECT id FROM labels WHERE done = 1').all().map(l => l.id));
        if (!r.if.every(c => this.holdsCond({ test: 'label', ...c }, cur, done))) continue;
        ctx.fired.add(row.id);
        ctx.depth++;
        try {
          for (const a of r.then) this.doAction(db, doorId, a, row.name, ctx);
        } finally { ctx.depth--; }
      }
    },

    doAction(db, doorId, a, ruleName, ctx) {
      if (a.do === 'set') this.writeCell(db, doorId, a.field, a.label, 'Automation', ruleName, ctx, ruleName);
      else if (a.do === 'next') {
        const cur = db.prepare('SELECT label_id FROM cells WHERE door_id = ? AND field_id = ?').get(doorId, a.field);
        const ls = db.prepare('SELECT id FROM labels WHERE field_id = ? ORDER BY position, id').all(a.field).map(l => l.id);
        const at = cur && cur.label_id !== null ? ls.indexOf(cur.label_id) : -1;
        if (at + 1 < ls.length) this.writeCell(db, doorId, a.field, ls[at + 1], 'Automation', ruleName, ctx, ruleName);          // already at the last one: nothing to do
      } else if (a.do === 'comment') {
        const cid = Number(db.prepare('INSERT INTO comments (door_id, at, dept, who, body) VALUES (?, ?, ?, ?, ?)').run(doorId, now(), 'Automation', ruleName, a.text).lastInsertRowid);
        this.event(db, doorId, 'comment.added', 'Automation', ruleName, { comment: cid, rule: ruleName });
      } else if (a.do === 'archive') {
        db.prepare('UPDATE doors SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(now(), doorId);
        this.event(db, doorId, 'door.archived', 'Automation', ruleName, { rule: ruleName });
      }
    },
  });
}

module.exports = { install, MAX_RULES };
