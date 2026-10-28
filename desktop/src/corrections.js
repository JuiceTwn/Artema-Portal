'use strict';
/**
 * Corrections: something had to be fixed on a door (trimmed 5/8 off the panel, re-cut a part, sanded a filler). The shop already writes
 * these in the order form's notes with initials and minutes; here they are a record, so rework can be counted: how often, where, and how
 * many minutes it costs. That is the waste worth going after.
 */
const REASONS = ['Trimmed', 'Re-cut', 'Filler or sanding', 'Re-painted', 'Wrong size', 'Damaged', 'Wrong or missing part', 'Other'];

function install(JobStore, { actor, text, bad, now }) {
  Object.assign(JobStore.prototype, {
    addCorrection(ref, { reason, minutes, note, station }, dept, who) {
      const d = actor(dept), r = text(reason, 40), mins = Math.round(Number(minutes) || 0);
      if (!r) throw bad('Say what was fixed');
      if (mins < 0 || mins > 1440) throw bad('That is not a sensible number of minutes');
      return this.tx(db => {
        const id = this.doorId(ref);
        const cid = Number(db.prepare('INSERT INTO corrections (door_id, at, dept, who, station, reason, minutes, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, now(), d, text(who, 80), text(station, 60), r, mins, text(note, 300)).lastInsertRowid);
        this.event(db, id, 'correction.added', d, who, { correction: cid, reason: r, minutes: mins, station: text(station, 60) });
        return cid;
      });
    },
    corrections(ref) {
      return this.need().prepare('SELECT id, at, dept, who, station, reason, minutes, note FROM corrections WHERE door_id = ? ORDER BY id DESC').all(this.doorId(ref));
    },
    /** Rework over the last `days`: by reason, by station, and the latest few, with the minutes they cost. */
    correctionSummary(days = 30) {
      const db = this.need(), since = now() - Math.max(1, Math.min(365, Number(days) || 30)) * 86400;
      const by = col => db.prepare(`SELECT ${col} AS name, COUNT(*) AS count, COALESCE(SUM(minutes), 0) AS minutes FROM corrections WHERE at >= ? GROUP BY ${col} ORDER BY minutes DESC, count DESC`).all(since).map(r => ({ ...r }));
      const total = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(minutes), 0) AS minutes, COUNT(DISTINCT door_id) AS doors FROM corrections WHERE at >= ?').get(since);
      const recent = db.prepare('SELECT c.id, c.at, c.dept, c.who, c.station, c.reason, c.minutes, c.note, d.number FROM corrections c JOIN doors d ON d.id = c.door_id WHERE c.at >= ? ORDER BY c.id DESC LIMIT 12').all(since).map(r => ({ ...r }));
      return { days: Math.round((now() - since) / 86400), total: { ...total }, byReason: by('reason'), byStation: by("CASE WHEN station = '' THEN dept ELSE station END"), recent };
    },
  });
}

module.exports = { install, REASONS };
