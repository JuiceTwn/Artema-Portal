'use strict';
/**
 * What a component looks like and where it is kept: a picture and a short "where" note per component name (Mullcaps, FG Double Glass Stop,
 * Frame Header...). Shown when someone taps a part on a station card, so a new person can find the right thing. The office and admins edit
 * it at any time. The picture is a small JPEG (resized by the screen) kept in the same database, so it is backed up and synced with
 * everything else and needs no extra files.
 */
const MAX_IMAGE = 600000;          // characters of data URL, about 450 KB of picture
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** Same part, any spelling: case, spaces and punctuation do not matter. */
const keyOf = name => String(name == null ? '' : name).toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim().slice(0, 80);

function install(JobStore, { actor, text, bad, now }) {
  Object.assign(JobStore.prototype, {
    /** One component's picture and place; empty strings when nobody has set them. */
    partInfo(name) {
      const row = this.need().prepare('SELECT key, name, location, image, updated_at, updated_by FROM part_info WHERE key = ?').get(keyOf(name));
      return row ? { ...row, set: true } : { key: keyOf(name), name: text(name, 80), location: '', image: '', updated_at: 0, updated_by: '', set: false };
    },
    /** Which components have something set, without the pictures, so a parts list can mark them. */
    partInfoList() {
      return this.need().prepare("SELECT key, location, image != '' AS has_image FROM part_info").all().map(r => ({ key: r.key, location: r.location, image: !!r.has_image }));
    },
    /** `image`: undefined keeps the current picture, '' removes it, a data URL replaces it. */
    savePartInfo(name, { location, image }, dept, who) {
      const d = actor(dept), key = keyOf(name), label = text(name, 80);
      if (!key) throw bad('Which component is this for?');
      if (image !== undefined && image !== null && image !== '' && (typeof image !== 'string' || image.length > MAX_IMAGE || !IMAGE_RE.test(image))) throw bad('That picture is not usable. Try a smaller one.');
      return this.tx(db => {
        const old = db.prepare('SELECT name, location, image FROM part_info WHERE key = ?').get(key);
        const next = { location: location === undefined ? (old ? old.location : '') : text(location, 120), image: image === undefined || image === null ? (old ? old.image : '') : image };
        db.prepare('INSERT INTO part_info (key, name, location, image, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET location = excluded.location, image = excluded.image, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
          .run(key, old ? old.name : label, next.location, next.image, now(), text(who, 80) || d);
        this.event(db, null, 'part.info', d, who, { part: label, location: next.location, picture: !!next.image });
        return { key, name: old ? old.name : label, location: next.location, image: next.image };
      });
    },
    deletePartInfo(name, dept, who) {
      const d = actor(dept), key = keyOf(name);
      return this.tx(db => {
        const r = db.prepare('DELETE FROM part_info WHERE key = ?').run(key);
        if (r.changes) this.event(db, null, 'part.info.removed', d, who, { part: text(name, 80) });
      });
    },
  });
}

module.exports = { install, keyOf, MAX_IMAGE };
