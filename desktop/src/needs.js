'use strict';
/**
 * What a door needs. Doors differ: a replacement may be only a frame, only a panel, or only a rail & stile panel. Each part of a door is
 * a track (a few status columns); a part the door does not need has those columns set to "Not needed", which counts as finished, so
 * nothing downstream waits for it. Cutting is for the parts that are cut here, so it is not needed when none of them is.
 *
 * The tracks are set up by the starter (template.js) and stored under meta 'needs'. With no tracks, none of this does anything.
 */
const NOT_NEEDED = 'Not needed';
const DEFAULT_NEEDS = { frame: true, panel: true, rs: false };

function install(JobStore, { actor, bad }) {
  Object.assign(JobStore.prototype, {
    /** { cutting: [fieldIds], tracks: [{ key, name, cuts, fields: [fieldIds] }] }, or null when the starter was never applied. Deleted columns are left out. */
    needsConfig() {
      const db = this.need(), row = db.prepare("SELECT value FROM meta WHERE key = 'needs'").get();
      if (!row) return null;
      const have = new Set(db.prepare('SELECT id FROM fields').all().map(f => f.id)), keep = a => a.filter(id => have.has(id));
      const c = JSON.parse(row.value);
      return { cutting: keep(c.cutting), tracks: c.tracks.map(t => ({ ...t, fields: keep(t.fields) })).filter(t => t.fields.length) };
    },
    /**
     * Records what a door needs and sets the columns to match: a part it does not need becomes "Not needed"; one it does need has "Not needed"
     * cleared again. Real progress is never overwritten, so switching a part off and on again loses nothing. Inside the caller's transaction.
     */
    applyNeeds(db, doorId, needs) {
      const cfg = this.needsConfig();
      if (!cfg) return;
      const want = { ...DEFAULT_NEEDS, ...(this.needsOf(doorId) || {}), ...(needs || {}) };
      const ctx = { rules: false, auto: [] };          // choosing what a door needs is not a change the rules should react to
      const info = fid => ({ nn: (db.prepare('SELECT id FROM labels WHERE field_id = ? AND name = ? COLLATE NOCASE').get(fid, NOT_NEEDED) || {}).id,
        cur: db.prepare('SELECT c.label_id AS id, l.done AS done FROM cells c LEFT JOIN labels l ON l.id = c.label_id WHERE c.door_id = ? AND c.field_id = ?').get(doorId, fid) });
      const set = (fid, on) => {
        const { nn, cur } = info(fid); if (!nn) return;
        if (on) { if (cur && cur.id === nn) this.writeCell(db, doorId, fid, null, 'Office', '', ctx); }
        else if (!(cur && cur.done)) this.writeCell(db, doorId, fid, nn, 'Office', '', ctx);
      };
      for (const t of cfg.tracks) {
        db.prepare('INSERT INTO door_needs (door_id, key, needed) VALUES (?, ?, ?) ON CONFLICT(door_id, key) DO UPDATE SET needed = excluded.needed').run(doorId, t.key, want[t.key] ? 1 : 0);
        for (const f of t.fields) set(f, !!want[t.key]);
      }
      const cuts = cfg.tracks.some(t => t.cuts && want[t.key]);
      for (const f of cfg.cutting) set(f, cuts);
    },
    /** What a door needs now: { frame, panel, rs } (null when there are no tracks). A door with nothing recorded needs everything. */
    needsOf(doorId) {
      const cfg = this.needsConfig();
      if (!cfg) return null;
      const rows = new Map(this.need().prepare('SELECT key, needed FROM door_needs WHERE door_id = ?').all(doorId).map(r => [r.key, !!r.needed]));
      return Object.fromEntries(cfg.tracks.map(t => [t.key, rows.has(t.key) ? rows.get(t.key) : true]));
    },
    setNeeds(ref, needs, dept, who) {
      const d = actor(dept);
      if (!this.needsConfig()) throw bad('Set up the door shop flow first (Board, Customize)');
      return this.tx(db => {
        const id = this.doorId(ref);
        this.applyNeeds(db, id, needs);
        this.event(db, id, 'door.needs', d, who, { needs: this.needsOf(id) });
      });
    },
  });
}

module.exports = { install, DEFAULT_NEEDS };
