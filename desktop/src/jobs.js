'use strict';
/**
 * Doors and how they move through the shop (the "Monday" part), kept in SQLite (jobs.db) on the main computer.
 *
 * Who did something is a department, never a person or a computer: the shop has no logins. A sign-off may carry a name typed or
 * tapped for that one action (`who`); nothing is remembered between actions.
 *
 *  - A door has one position in the flow (workflow.js): its first step not yet completed. A step is completed at most once, so a
 *    repair can never be counted twice.
 *  - A repair is a detour: the door is sent to another department's list without moving in the flow, and comes back to the same step
 *    when the repair is done. Detours are counted separately (rework by department and reason).
 *  - A door is made of components (frame, panel, rail & stile) that come from a source: an internal provider or an outside supplier,
 *    treated the same. The CNC step waits until they have arrived.
 *  - Every change is also written to an event log, in the same transaction.
 *
 * If jobs.db can't be opened, the newest good backup is restored; if there is none, the main computer says so in the log and the
 * damaged file is kept aside. It never silently starts empty over data it could not read.
 */
const fs = require('fs');
const path = require('path');
const { log } = require('./util');
const { STEPS, STEP_KEYS, stepOf, COMPONENT_KINDS, NEEDED_BEFORE, DEFAULT_CHECKS, nextStep, FLOW_DEPARTMENTS } = require('./workflow');

/** Departments that can act or receive a detour: the flow, the providers that feed it, and the office. */
const ACTORS = [...FLOW_DEPARTMENTS, 'Skins', 'Panel Assembly', 'Rail & Stile', 'Office'];
const SOURCE_KINDS = ['internal', 'external'];

const SCHEMA_VERSION = 1;
const MIGRATIONS = {
  1: `
    CREATE TABLE projects (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE doors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      number      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      project_id  INTEGER REFERENCES projects(id),
      customer    TEXT    NOT NULL DEFAULT '',
      source_path TEXT    NOT NULL DEFAULT '',
      ship_date   TEXT    NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      released_at INTEGER,
      released_by TEXT    NOT NULL DEFAULT ''
    );
    CREATE INDEX doors_project ON doors(project_id);
    CREATE TABLE components (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      door_id     INTEGER NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
      kind        TEXT    NOT NULL CHECK (kind IN ('frame', 'panel', 'rail_stile')),
      source_kind TEXT    NOT NULL CHECK (source_kind IN ('internal', 'external')),
      source      TEXT    NOT NULL DEFAULT '',
      expected_at TEXT    NOT NULL DEFAULT '',
      ready_at    INTEGER,
      ready_by    TEXT    NOT NULL DEFAULT '',
      UNIQUE (door_id, kind)
    );
    CREATE TABLE checks (
      door_id INTEGER NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
      item    TEXT    NOT NULL,
      done_at INTEGER,
      done_by TEXT    NOT NULL DEFAULT '',
      PRIMARY KEY (door_id, item)
    );
    CREATE TABLE completions (
      door_id INTEGER NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
      step    TEXT    NOT NULL,
      at      INTEGER NOT NULL,
      dept    TEXT    NOT NULL,
      who     TEXT    NOT NULL DEFAULT '',
      PRIMARY KEY (door_id, step)
    ) WITHOUT ROWID;
    CREATE TABLE detours (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      door_id   INTEGER NOT NULL REFERENCES doors(id) ON DELETE CASCADE,
      step      TEXT    NOT NULL,
      from_dept TEXT    NOT NULL,
      to_dept   TEXT    NOT NULL,
      reason    TEXT    NOT NULL DEFAULT '',
      rush      INTEGER NOT NULL DEFAULT 1,
      opened_at INTEGER NOT NULL,
      opened_by TEXT    NOT NULL DEFAULT '',
      closed_at INTEGER,
      closed_by TEXT    NOT NULL DEFAULT '',
      closed_dept TEXT  NOT NULL DEFAULT ''
    );
    CREATE INDEX detours_open ON detours(to_dept) WHERE closed_at IS NULL;
    CREATE INDEX detours_door ON detours(door_id);
    CREATE TABLE events (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      INTEGER NOT NULL,
      door_id INTEGER,
      kind    TEXT    NOT NULL,
      dept    TEXT    NOT NULL DEFAULT '',
      who     TEXT    NOT NULL DEFAULT '',
      data    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX events_door ON events(door_id, id);
  `,
};

const now = () => Math.floor(Date.now() / 1000);
const text = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** The acting department, checked. Anything not a known department is refused so a typo can't create a ghost department. */
function actor(dept) {
  const d = ACTORS.find(a => a.toLowerCase() === text(dept).toLowerCase());
  if (!d) throw bad('Pick a department first');
  return d;
}

class JobStore {
  /** `file` is jobs.db; `backupDir` is where backups go (kept on a different folder than the database, ideally a different disk). */
  constructor(file, backupDir) {
    this.file = file;
    this.backupDir = backupDir || path.join(path.dirname(file), 'backups');
    this.db = null;
    this.unavailable = '';
    this.restoredFrom = '';
    this.open();
  }

  // ---- opening, migration, recovery
  open() {
    try { this.db = this.openChecked(this.file); } catch (first) {
      const aside = `${this.file}.damaged-${Date.now()}`;
      try {
        if (fs.existsSync(this.file)) fs.renameSync(this.file, aside);
        for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(this.file + ext); } catch { /* none */ } }
      } catch { /* keep going: restoring below overwrites */ }
      const good = this.backups().find(b => this.verify(b.file));
      if (good) {
        try {
          fs.copyFileSync(good.file, this.file);
          this.db = this.openChecked(this.file);
          this.restoredFrom = good.name;
          log(`jobs database was unreadable (${first.message}); restored from backup ${good.name}, damaged file kept as ${path.basename(aside)}`);
          return;
        } catch (e) { this.db = null; log(`jobs database: restore from ${good.name} failed (${e.message})`); }
      }
      if (fs.existsSync(aside)) {
        this.unavailable = `unreadable (${first.message}) and no good backup; damaged file kept as ${path.basename(aside)}`;
        log(`jobs database ${this.unavailable}`);
      } else {
        try { this.db = this.openChecked(this.file); } catch (second) { this.unavailable = String(second.message || second); log(`jobs database unavailable (${this.unavailable})`); }
      }
    }
  }

  openChecked(file) {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const check = db.prepare('PRAGMA quick_check').get();
      if (!check || Object.values(check)[0] !== 'ok') throw new Error('integrity check failed');
      db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
      let v = row && row.v ? row.v : 0;
      if (v > SCHEMA_VERSION) throw new Error(`database is from a newer version (${v})`);
      while (v < SCHEMA_VERSION) {
        db.exec('BEGIN IMMEDIATE');
        try { db.exec(MIGRATIONS[v + 1]); db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
        v++;
      }
      return db;
    } catch (e) { try { db.close(); } catch { /* already closed */ } throw e; }
  }

  get ok() { return !!this.db; }
  need() { if (!this.db) throw bad('Jobs are unavailable right now', 503); return this.db; }

  /** Runs `fn` as one transaction: the change and its event-log row both happen, or neither does. */
  tx(fn) {
    const db = this.need();
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(db); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* none open */ } throw e; }
  }
  event(db, doorId, kind, dept, who, data) {
    db.prepare('INSERT INTO events (at, door_id, kind, dept, who, data) VALUES (?, ?, ?, ?, ?, ?)').run(now(), doorId, kind, dept || '', text(who, 80), JSON.stringify(data || {}));
  }

  // ---- doors
  /**
   * Adds a door. `number` is the door number (like 26-611) and must be new. `project` (a name) groups doors; a door with none stands
   * alone. `components` is [{ kind, sourceKind, source, expectedAt }]; `checks` defaults to the parts the office confirms before release.
   */
  createDoor(input, by = 'Office') {
    const number = text(input && input.number, 40);
    if (!number) throw bad('A door needs a number');
    const comps = (input.components || []).map(c => {
      if (!COMPONENT_KINDS.includes(c.kind)) throw bad(`Unknown component: ${c.kind}`);
      const sourceKind = SOURCE_KINDS.includes(c.sourceKind) ? c.sourceKind : 'internal';
      return { kind: c.kind, sourceKind, source: text(c.source, 80), expectedAt: text(c.expectedAt, 20) };
    });
    if (new Set(comps.map(c => c.kind)).size !== comps.length) throw bad('A door can have each component only once');
    const checks = [...new Set((input.checks || DEFAULT_CHECKS).map(c => text(c, 60)).filter(Boolean))];
    return this.tx(db => {
      if (db.prepare('SELECT 1 FROM doors WHERE number = ?').get(number)) throw bad(`Door ${number} already exists`, 409);
      let projectId = null;
      const pn = text(input.project, 80);
      if (pn) {
        const p = db.prepare('SELECT id FROM projects WHERE name = ?').get(pn);
        projectId = p ? p.id : Number(db.prepare('INSERT INTO projects (name, created_at) VALUES (?, ?)').run(pn, now()).lastInsertRowid);
      }
      const id = Number(db.prepare('INSERT INTO doors (number, project_id, customer, source_path, ship_date, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(number, projectId, text(input.customer, 120), text(input.sourcePath, 300), text(input.shipDate, 20), now()).lastInsertRowid);
      for (const c of comps) db.prepare('INSERT INTO components (door_id, kind, source_kind, source, expected_at) VALUES (?, ?, ?, ?, ?)').run(id, c.kind, c.sourceKind, c.source, c.expectedAt);
      for (const item of checks) db.prepare('INSERT INTO checks (door_id, item) VALUES (?, ?)').run(id, item);
      this.event(db, id, 'door.created', 'Office', by, { number, project: pn });
      return id;
    });
  }

  doorId(ref) {
    const db = this.need();
    const row = typeof ref === 'number' || /^\d+$/.test(String(ref))
      ? db.prepare('SELECT id FROM doors WHERE id = ?').get(Number(ref))
      : db.prepare('SELECT id FROM doors WHERE number = ?').get(text(ref, 40));
    if (!row) throw bad('Door not found', 404);
    return row.id;
  }

  /** Everything about one door, worked out fresh: where it is in the flow, what it is waiting on, and any repair in progress. */
  door(ref) {
    const db = this.need(), id = this.doorId(ref);
    const d = db.prepare('SELECT d.*, p.name AS project FROM doors d LEFT JOIN projects p ON p.id = d.project_id WHERE d.id = ?').get(id);
    const components = db.prepare('SELECT * FROM components WHERE door_id = ? ORDER BY id').all(id);
    const checks = db.prepare('SELECT item, done_at, done_by FROM checks WHERE door_id = ? ORDER BY rowid').all(id);
    const completions = db.prepare('SELECT step, at, dept, who FROM completions WHERE door_id = ?').all(id)
      .sort((a, b) => STEP_KEYS.indexOf(a.step) - STEP_KEYS.indexOf(b.step));
    const detours = db.prepare('SELECT * FROM detours WHERE door_id = ? ORDER BY id').all(id);
    const open = detours.filter(x => x.closed_at === null);
    const next = nextStep(completions.map(c => c.step));
    const released = d.released_at !== null;
    const waiting = next && next.key === NEEDED_BEFORE ? components.filter(c => c.ready_at === null).map(c => c.kind) : [];
    const status = !released ? 'new' : !next ? 'done' : open.length ? 'repair' : 'active';
    return {
      id, number: d.number, project: d.project || '', customer: d.customer, sourcePath: d.source_path, shipDate: d.ship_date,
      createdAt: d.created_at, releasedAt: d.released_at, releasedBy: d.released_by, status,
      next: next ? { key: next.key, dept: next.dept, label: next.label, qc: next.qc } : null,
      waitingOn: waiting, checks, components, completions, detours, openDetours: open,
    };
  }

  setCheck(ref, item, done, dept, who) {
    const d = actor(dept);
    return this.tx(db => {
      const id = this.doorId(ref);
      const r = done
        ? db.prepare('UPDATE checks SET done_at = ?, done_by = ? WHERE door_id = ? AND item = ?').run(now(), text(who, 80), id, text(item, 60))
        : db.prepare("UPDATE checks SET done_at = NULL, done_by = '' WHERE door_id = ? AND item = ?").run(id, text(item, 60));
      if (!r.changes) throw bad('No such part on this door', 404);
      this.event(db, id, done ? 'check.done' : 'check.undone', d, who, { item: text(item, 60) });
    });
  }

  setComponentReady(ref, kind, ready, dept, who) {
    const d = actor(dept);
    return this.tx(db => {
      const id = this.doorId(ref);
      const r = ready
        ? db.prepare('UPDATE components SET ready_at = COALESCE(ready_at, ?), ready_by = ? WHERE door_id = ? AND kind = ?').run(now(), text(who, 80), id, kind)
        : db.prepare("UPDATE components SET ready_at = NULL, ready_by = '' WHERE door_id = ? AND kind = ?").run(id, kind);
      if (!r.changes) throw bad('This door has no such component', 404);
      this.event(db, id, ready ? 'component.ready' : 'component.unready', d, who, { kind });
    });
  }

  /** The office starts a door. Every part on its list must be confirmed in first. */
  release(ref, dept, who) {
    const d = actor(dept);
    return this.tx(db => {
      const id = this.doorId(ref);
      const row = db.prepare('SELECT released_at FROM doors WHERE id = ?').get(id);
      if (row.released_at !== null) throw bad('This door is already released', 409);
      const missing = db.prepare('SELECT item FROM checks WHERE door_id = ? AND done_at IS NULL ORDER BY rowid').all(id).map(r => r.item);
      if (missing.length) throw Object.assign(bad(`Still waiting on: ${missing.join(', ')}`, 409), { missing });
      db.prepare('UPDATE doors SET released_at = ?, released_by = ? WHERE id = ?').run(now(), text(who, 80) || d, id);
      this.event(db, id, 'door.released', d, who, {});
    });
  }

  // ---- the flow
  /**
   * Completes the door's next step. `step` must be that step (so two people tapping the same button can't both count), the door must
   * be released, with no repair open, and the CNC step also waits for the door's components. Finishing the cut makes an in-house
   * frame ready by itself.
   */
  complete(ref, step, dept, who) {
    const d = actor(dept), s = stepOf(step);
    if (!s) throw bad('Unknown step');
    return this.tx(db => {
      const id = this.doorId(ref), door = this.door(id);
      if (door.status === 'new') throw bad('This door has not been released yet', 409);
      if (door.status === 'done') throw bad('This door is finished', 409);
      if (!door.next || door.next.key !== s.key) throw bad(door.completions.some(c => c.step === s.key) ? 'That step is already done' : `${door.next.label} comes first`, 409);
      if (door.openDetours.length) throw bad('This door is out for repair; finish the repair first', 409);
      if (door.waitingOn.length) throw Object.assign(bad(`Waiting on: ${door.waitingOn.join(', ')}`, 409), { waitingOn: door.waitingOn });
      db.prepare('INSERT INTO completions (door_id, step, at, dept, who) VALUES (?, ?, ?, ?, ?)').run(id, s.key, now(), d, text(who, 80));
      if (s.key === 'frame-prep.cut') db.prepare("UPDATE components SET ready_at = COALESCE(ready_at, ?), ready_by = ? WHERE door_id = ? AND kind = 'frame' AND source_kind = 'internal' AND source = 'Frame Prep'").run(now(), text(who, 80), id);
      this.event(db, id, 'step.done', d, who, { step: s.key, offDept: s.dept !== d && d !== 'Office' });
    });
  }

  /** Takes back the latest completed step (a mis-tap). Only the latest, and not once a repair is open. */
  undo(ref, dept, who) {
    const d = actor(dept);
    return this.tx(db => {
      const id = this.doorId(ref), door = this.door(id);
      const last = door.completions[door.completions.length - 1];
      if (!last) throw bad('Nothing to undo', 409);
      if (door.openDetours.length) throw bad('This door is out for repair', 409);
      db.prepare('DELETE FROM completions WHERE door_id = ? AND step = ?').run(id, last.step);
      this.event(db, id, 'step.undone', d, who, { step: last.step });
      return last.step;
    });
  }

  // ---- repairs
  /** Sends a released, unfinished door to another department for repair. Its place in the flow does not change. */
  openDetour(ref, { toDept, reason, rush = true }, dept, who) {
    const from = actor(dept), to = actor(toDept);
    return this.tx(db => {
      const id = this.doorId(ref), door = this.door(id);
      if (door.status === 'new') throw bad('This door has not been released yet', 409);
      if (door.status === 'done') throw bad('This door is finished', 409);
      if (door.openDetours.some(x => x.to_dept === to)) throw bad(`Already out for repair at ${to}`, 409);
      const did = Number(db.prepare('INSERT INTO detours (door_id, step, from_dept, to_dept, reason, rush, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, door.next.key, from, to, text(reason, 300), rush ? 1 : 0, now(), text(who, 80)).lastInsertRowid);
      this.event(db, id, 'detour.opened', from, who, { detour: did, to, reason: text(reason, 300), at: door.next.key });
      return did;
    });
  }

  closeDetour(detourId, dept, who) {
    const d = actor(dept);
    return this.tx(db => {
      const row = db.prepare('SELECT * FROM detours WHERE id = ?').get(Number(detourId));
      if (!row) throw bad('Repair not found', 404);
      if (row.closed_at !== null) throw bad('That repair is already finished', 409);
      db.prepare('UPDATE detours SET closed_at = ?, closed_by = ?, closed_dept = ? WHERE id = ?').run(now(), text(who, 80), d, row.id);
      this.event(db, row.door_id, 'detour.closed', d, who, { detour: row.id, to: row.to_dept });
    });
  }

  // ---- lists
  /** Doors whose next step belongs to `dept` (ready to work or waiting), plus repairs sent to it. Rush repairs come first. */
  queue(dept) {
    const dd = actor(dept);
    const db = this.need();
    const ids = db.prepare('SELECT id FROM doors WHERE released_at IS NOT NULL ORDER BY ship_date = \'\', ship_date, id').all();
    const work = [], repairs = [];
    for (const { id } of ids) {
      const door = this.door(id);
      if (door.status === 'active' && door.next.dept === dd) work.push(door);
      for (const dt of door.openDetours) if (dt.to_dept === dd) repairs.push({ ...dt, door });
    }
    repairs.sort((a, b) => b.rush - a.rush || a.opened_at - b.opened_at);
    return { dept: dd, work, repairs };
  }

  /** Every unfinished door with where it is, for the office board. New (unreleased) doors are included. */
  board() {
    return this.need().prepare('SELECT id FROM doors ORDER BY ship_date = \'\', ship_date, id').all().map(r => this.door(r.id)).filter(d => d.status !== 'done');
  }

  /** "5 of 13": how many of a project's doors have finished a step (or the whole flow when none is given). */
  project(name, step) {
    const db = this.need();
    const p = db.prepare('SELECT id, name FROM projects WHERE name = ?').get(text(name, 80));
    if (!p) throw bad('Project not found', 404);
    const ids = db.prepare('SELECT id FROM doors WHERE project_id = ?').all(p.id).map(r => r.id);
    const key = step || STEP_KEYS[STEP_KEYS.length - 1];
    if (!stepOf(key)) throw bad('Unknown step');
    const doneAt = db.prepare('SELECT COUNT(*) AS n FROM completions WHERE step = ? AND door_id IN (SELECT id FROM doors WHERE project_id = ?)').get(key, p.id).n;
    return { name: p.name, doors: ids.length, step: key, done: doneAt };
  }

  /** Rework counts: how often each department received repairs, and for what, over a period (seconds since). */
  rework(sinceSeconds = 30 * 86400) {
    const db = this.need(), since = now() - sinceSeconds;
    return db.prepare(`SELECT to_dept AS dept, COUNT(*) AS count, SUM(COALESCE(closed_at, strftime('%s','now')) - opened_at) AS seconds
                       FROM detours WHERE opened_at >= ? GROUP BY to_dept ORDER BY count DESC`).all(since).map(r => ({ dept: r.dept, count: r.count, seconds: Number(r.seconds) }));
  }

  events(limit = 100, ref) {
    const db = this.need();
    const rows = ref === undefined
      ? db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM events WHERE door_id = ? ORDER BY id DESC LIMIT ?').all(this.doorId(ref), limit);
    return rows.map(r => ({ ...r, data: JSON.parse(r.data || '{}') }));
  }

  // ---- backups
  /** Backups on disk, newest first: [{ name, file, at }]. */
  backups() {
    let names = []; try { names = fs.readdirSync(this.backupDir); } catch { return []; }
    return names.filter(n => /^jobs-\d{8}-\d{6}(-\d+)?\.db$/.test(n)).sort().reverse().map(n => ({ name: n, file: path.join(this.backupDir, n) }));
  }

  /** True when the file opens and passes SQLite's integrity check. */
  verify(file) {
    let db;
    try {
      const { DatabaseSync } = require('node:sqlite');
      db = new DatabaseSync(file, { readOnly: true });
      const c = db.prepare('PRAGMA quick_check').get();
      return !!c && Object.values(c)[0] === 'ok';
    } catch { return false; } finally { try { if (db) db.close(); } catch { /* none */ } }
  }

  /**
   * Writes a consistent copy of the database (safe while it is in use), checks it, and keeps the newest `keep` copies.
   * Returns the new backup's name. A copy that fails its check is deleted and reported, never kept as if it were good.
   */
  backup(keep = 30) {
    const db = this.need();
    fs.mkdirSync(this.backupDir, { recursive: true });
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    let name = `jobs-${stamp}.db`, n = 1;
    while (fs.existsSync(path.join(this.backupDir, name))) name = `jobs-${stamp}-${n++}.db`;
    const file = path.join(this.backupDir, name);
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    if (!this.verify(file)) { try { fs.unlinkSync(file); } catch { /* gone */ } throw new Error('The backup did not pass its check and was discarded'); }
    for (const old of this.backups().slice(keep)) { try { fs.unlinkSync(old.file); } catch { /* best effort */ } }
    return name;
  }

  close() { try { if (this.db) this.db.close(); } catch { /* already closed */ } this.db = null; }
}

module.exports = { JobStore, ACTORS, STEPS };
