'use strict';
/**
 * Who may do what, by computer.
 *
 * Three roles, lowest to highest:  general (shop floor)  <  admin  <  dev
 * Every computer that joins is `general` until the main computer assigns something else. The main computer's own window is
 * always `dev`. A browser signed in with the PIN is `general`.
 *
 * Roles live in a small SQLite file (portal.db) so a crash or power cut mid-write can't leave them half changed. If that file
 * can't be opened or is damaged, nobody is promoted: every computer behaves as `general` and the main computer says so in the log.
 */
const fs = require('fs');
const path = require('path');
const { log } = require('./util');

const ROLES = ['general', 'admin', 'dev'];
const rank = role => ROLES.indexOf(role);
const isRole = role => ROLES.includes(role);

/** The lowest role allowed to do each thing. Anything not listed here is open to every role. */
const PERMISSIONS = {
  'pin.view': 'admin',
  'pin.rotate': 'admin',
  'devices.tag': 'admin',
  'devices.remove': 'admin',
  'parts.info': 'admin',            // the picture and "where it is" shown for a component (the office, by department, may too: see server.js)
  'board.edit': 'admin',            // the board's columns, labels and tabs, and whether the guided steps are on
  'devices.role': 'admin',          // admins hand out `general` and `admin`; only dev hands out `dev`: see canAssign
  'server.update': 'dev',           // installs new software on the main computer from GitHub
  'files.reveal': 'dev',           // opens a folder on the main computer's own screen
};

/** May this role do this action? Unknown actions are open; unknown roles can do nothing that is restricted. */
function can(role, action) {
  const need = PERMISSIONS[action];
  return need === undefined || (isRole(role) && rank(role) >= rank(need));
}

/** May `by` change a computer that currently has `current` to `next`? Nobody can hand out or change a role above their own. */
function canAssign(by, current, next) {
  return can(by, 'devices.role') && isRole(next) && rank(next) <= rank(by) && rank(current) <= rank(by);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS device_roles (
    device_id  TEXT    PRIMARY KEY,
    role       TEXT    NOT NULL CHECK (role IN ('general', 'admin', 'dev')),
    updated_at INTEGER NOT NULL,
    updated_by TEXT    NOT NULL DEFAULT ''
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS role_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    device_id TEXT    NOT NULL,
    old_role  TEXT    NOT NULL,
    new_role  TEXT    NOT NULL,
    by        TEXT    NOT NULL DEFAULT ''
  );
`;
const SCHEMA_VERSION = 1;
const now = () => Math.floor(Date.now() / 1000);

class RoleStore {
  constructor(file) {
    this.file = file;
    this.db = null;
    this.unavailable = '';
    this.open();
  }

  open() {
    try { this.db = this.openChecked(); } catch (first) {
      // damaged file: keep it for inspection, start clean (everyone back to `general`, which is the safe direction)
      try {
        const aside = `${this.file}.damaged-${Date.now()}`;
        if (fs.existsSync(this.file)) fs.renameSync(this.file, aside);
        for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(this.file + ext); } catch { /* none */ } }
        log(`roles database was unreadable (${first.message}); kept as ${path.basename(aside)}, all computers are general until roles are assigned again`);
        this.db = this.openChecked();
      } catch (second) {
        this.db = null;
        this.unavailable = String(second.message || second);
        log(`roles database unavailable (${this.unavailable}): every computer is treated as general`);
      }
    }
  }

  openChecked() {
    const { DatabaseSync } = require('node:sqlite');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const check = db.prepare('PRAGMA quick_check').get();
      if (!check || Object.values(check)[0] !== 'ok') throw new Error('integrity check failed');
      db.exec(SCHEMA);
      const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
      if (!row || row.v === null) db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
      else if (row.v > SCHEMA_VERSION) throw new Error(`database is from a newer version (${row.v})`);
      return db;
    } catch (e) { try { db.close(); } catch { /* already closed */ } throw e; }
  }

  /** The role of a computer. Anything unknown, or any trouble reading, is `general`. */
  get(deviceId) {
    if (!this.db || !deviceId) return 'general';
    try {
      if (!this.getStmt) this.getStmt = this.db.prepare('SELECT role FROM device_roles WHERE device_id = ?');          // looked up on every request: prepare once
      const row = this.getStmt.get(String(deviceId));
      return row && isRole(row.role) ? row.role : 'general';
    } catch (e) { log(`roles: could not read (${e.message})`); return 'general'; }
  }

  /** Assigns a role and records who did it, in one transaction. */
  set(deviceId, role, by = '') {
    if (!isRole(role)) throw new Error('Unknown role');
    if (!this.db) throw Object.assign(new Error('Roles are unavailable right now'), { status: 503 });
    const db = this.db, id = String(deviceId);
    db.exec('BEGIN IMMEDIATE');
    try {
      const old = db.prepare('SELECT role FROM device_roles WHERE device_id = ?').get(id);
      const prev = old ? old.role : 'general';
      if (role === 'general') db.prepare('DELETE FROM device_roles WHERE device_id = ?').run(id);       // general is the default: no row
      else db.prepare('INSERT INTO device_roles (device_id, role, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at, updated_by = excluded.updated_by').run(id, role, now(), String(by));
      if (prev !== role) db.prepare('INSERT INTO role_log (at, device_id, old_role, new_role, by) VALUES (?, ?, ?, ?, ?)').run(now(), id, prev, role, String(by));
      db.exec('COMMIT');
      return prev;
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* nothing open */ } throw e; }
  }

  /** A computer was removed from the network: its role goes with it. */
  forget(deviceId) { if (this.db) { try { this.set(deviceId, 'general', 'removed'); } catch { /* best effort */ } } }

  /** { deviceId: role } for every computer that has been given something above general. */
  all() {
    if (!this.db) return {};
    try { return Object.fromEntries(this.db.prepare('SELECT device_id, role FROM device_roles').all().map(r => [r.device_id, r.role])); } catch { return {}; }
  }

  history(limit = 50) {
    if (!this.db) return [];
    try { return this.db.prepare('SELECT at, device_id, old_role, new_role, by FROM role_log ORDER BY id DESC LIMIT ?').all(limit); } catch { return []; }
  }

  close() { this.getStmt = null; try { if (this.db) this.db.close(); } catch { /* already closed */ } this.db = null; }
}

module.exports = { ROLES, PERMISSIONS, RoleStore, can, canAssign, isRole, rank };
