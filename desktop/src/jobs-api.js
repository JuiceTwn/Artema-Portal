'use strict';
/**
 * The /api/jobs/... calls: what the screens ask the job store (jobs.js), and the few things that start from an order form (intake.js).
 * There are no logins: every change says which department made it (`dept`) and may carry a name typed for that one action (`who`).
 */
const { HttpError } = require('./util');
const { STAGES, STEPS } = require('./workflow');
const { ACTORS } = require('./jobs');
const { REASONS: CORRECTION_REASONS } = require('./corrections');
const { doorFromOrder, DEFAULT_CHOICES } = require('./intake');

/** The usual reasons a door goes back for repair: one tap instead of typing. */
const REPAIR_REASONS = ['Filler or sanding', 'Paint defect', 'Damaged', 'Wrong size', 'Prepping is wrong', 'Wrong part', 'Other'];

/** The job store reports problems with a status; the server wants them as HttpErrors. */
function wrap(fn) {
  try { return fn(); } catch (e) {
    if (e instanceof HttpError || !e || !e.status) throw e;
    throw new HttpError(e.status, e.message);
  }
}

/**
 * Each door with the details read from its order form (size, colours, frame...), so a department's table can show what that
 * department works from. A form that can't be read just leaves `form` empty.
 */
function withForms(orders, doors) {
  let byPath = new Map();
  if (orders) { try { byPath = new Map(orders.list().filter(o => !o.error).map(o => [o.path, o.f])); } catch { /* forms unreadable: tables still work */ } }
  return doors.map(d => ({ ...d, form: byPath.get(d.sourcePath) || null }));
}

/**
 * Adds a door. With the guided steps off (the normal case) a door is simply on the board: no parts checklist, nothing to release.
 * With them on it starts as "not started" with the parts to confirm, as before.
 */
function addDoor(jobs, input, guided, dept, who) {
  if (guided) return jobs.createDoor(input, dept || 'Office');
  const id = jobs.createDoor({ ...input, components: [], checks: [] }, dept || 'Office');
  jobs.release(id, dept || 'Office', who || 'automatic');
  return id;
}

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Handles a GET; returns the JSON to send. */
function get(jobs, orders, ep, q) {
  if (!jobs || !jobs.ok) throw new HttpError(503, 'Jobs are unavailable right now. Ask whoever looks after the Portal.');
  return wrap(() => {
    if (ep === 'jobs/meta') return { stages: STAGES, steps: STEPS, actors: ACTORS, reasons: REPAIR_REASONS, correctionReasons: CORRECTION_REASONS, defaults: DEFAULT_CHOICES, ...jobs.settings() };
    if (ep === 'jobs/board') return { ...jobs.config(), doors: withForms(orders, jobs.board(q.archived === '1' ? 'archived' : 'active')) };
    if (ep === 'jobs/queue') { const r = jobs.queue(str(q.dept)); return { ...r, work: withForms(orders, r.work) }; }
    if (ep === 'jobs/door') { const door = jobs.door(str(q.id)); return { door, events: jobs.events(40, door.id), comments: jobs.comments(door.id), corrections: jobs.corrections(door.id), ...jobs.config() }; }
    if (ep === 'jobs/corrections') return jobs.correctionSummary(Number(q.days) || 30);
    if (ep === 'jobs/parts') {
      const door = jobs.door(str(q.id)), rel = String(door.sourcePath || '').replace(/^Door Orders\//, '');
      if (!orders || !rel) return { sections: [], note: 'This door has no order form.' };
      try { return { sections: orders.parts(rel) }; } catch { return { sections: [], note: 'Could not read the order form.' }; }
    }
    if (ep === 'jobs/catchup') {
      const door = jobs.door(str(q.id)), rel = String(door.sourcePath || '').replace(/^Door Orders\//, '');
      if (!orders || !rel) return { steps: [], note: 'This door has no order form to read.' };
      let sections = []; try { sections = orders.parts(rel); } catch { return { steps: [], note: 'Could not read the order form.' }; }
      return jobs.catchupPlan(door.id, sections);
    }
    throw new HttpError(404, 'Not found');
  });
}

/** Handles a POST; returns the JSON to send. `orders` reads the order forms. */
function post(jobs, orders, ep, b, need = () => { }) {
  if (!jobs || !jobs.ok) throw new HttpError(503, 'Jobs are unavailable right now. Ask whoever looks after the Portal.');
  const dept = str(b.dept), who = str(b.who);
  const withDoor = id => ({ ok: true, door: jobs.door(id) });
  const guided = jobs.settings().guided;
  return wrap(() => {
    if (ep === 'jobs/add') {
      if (!orders) throw new HttpError(404, 'Not found');
      const input = doorFromOrder(orders.find(str(b.rel)), b.choices || {});
      if (jobs.numbers().includes(input.number.toLowerCase())) throw new HttpError(409, `Door ${input.number} is already in the shop`);
      return withDoor(addDoor(jobs, input, guided, dept, who));
    }
    if (ep === 'jobs/new') {
      const number = str(b.number).trim();
      if (!number) throw new HttpError(400, 'A door needs a number');
      if (jobs.numbers().includes(number.toLowerCase())) throw new HttpError(409, `Door ${number} is already in the shop`);
      const input = doorFromOrder({ door: number, path: '', f: { customer: str(b.customer), project: str(b.project), ship: str(b.shipDate) } }, b.choices || {});
      if (b.needs && typeof b.needs === 'object') input.needs = b.needs;
      return withDoor(addDoor(jobs, input, guided, dept, who));
    }
    if (ep === 'jobs/add-all') {
      if (!orders) throw new HttpError(404, 'Not found');
      const have = new Set(jobs.numbers()), added = [], skipped = [];
      for (const o of orders.list()) {
        if (o.error || !o.door) { skipped.push({ name: o.name, why: o.error || 'No door number' }); continue; }
        if (have.has(o.door.toLowerCase())) continue;
        try { addDoor(jobs, doorFromOrder(o, b.choices || {}), guided, dept, who); have.add(o.door.toLowerCase()); added.push(o.door); }
        catch (e) { skipped.push({ name: o.name, why: e.message }); }
      }
      return { ok: true, added, skipped };
    }
    // ---- what the floor does all day: set a cell, comment, archive
    if (ep === 'jobs/cell') { const auto = jobs.setCell(str(b.id), b.field, b.value, dept, who); return { ...withDoor(str(b.id)), auto }; }
    if (ep === 'jobs/cells') { jobs.setCells(Array.isArray(b.changes) ? b.changes : [], dept, who); return { ok: true }; }
    if (ep === 'jobs/comment') { jobs.addComment(str(b.id), str(b.text), dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/archive') { jobs.setArchived(str(b.id), b.on !== false, dept, who); return { ok: true }; }
    // ---- the board's setup is for admins
    if (ep.startsWith('jobs/field/') || ep === 'jobs/labels/save' || ep === 'jobs/views/save' || ep === 'jobs/rules/save' || ep === 'jobs/template' || ep === 'jobs/settings') {
      need('board.edit');
      if (ep === 'jobs/field/add') return { ok: true, id: jobs.addField(str(b.name), str(b.kind), dept, who) };
      if (ep === 'jobs/field/rename') { jobs.renameField(b.id, str(b.name), dept, who); return { ok: true }; }
      if (ep === 'jobs/field/delete') { jobs.deleteField(b.id, dept, who); return { ok: true }; }
      if (ep === 'jobs/labels/save') { jobs.saveLabels(b.field, b.labels, dept, who); return { ok: true }; }
      if (ep === 'jobs/views/save') { jobs.saveViews(b.views, dept, who); return { ok: true }; }
      if (ep === 'jobs/template') return { ok: true, ...jobs.applyDoorShopTemplate(dept, who) };
      if (ep === 'jobs/rules/save') { jobs.saveRules(b.rules, dept, who); return { ok: true }; }
      if (ep === 'jobs/settings') { if (typeof b.guided === 'boolean') jobs.setGuided(b.guided, dept, who); return { ok: true, ...jobs.settings() }; }
    }
    if (ep === 'jobs/correction') { jobs.addCorrection(str(b.id), { reason: str(b.reason), minutes: b.minutes, note: str(b.note), station: str(b.station) }, dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/catchup') {
      const door = jobs.door(str(b.id)), rel = String(door.sourcePath || '').replace(/^Door Orders\//, '');
      if (!orders || !rel) throw new HttpError(400, 'This door has no order form to read');
      const plan = jobs.catchupPlan(door.id, orders.parts(rel)), applied = [];
      for (const st of plan.steps) if (!st.already) { jobs.setCell(door.id, st.field, st.label, dept, who); applied.push(st.column); }
      return { ...withDoor(door.id), applied };
    }
    if (ep === 'jobs/needs') { jobs.setNeeds(str(b.id), b.needs || {}, dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/note') { jobs.setNote(str(b.id), str(b.note), dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/check') { jobs.setCheck(str(b.id), str(b.item), b.done !== false, dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/ready') { jobs.setComponentReady(str(b.id), str(b.kind), b.ready !== false, dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/release') { jobs.release(str(b.id), dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/step') { jobs.complete(str(b.id), str(b.step), dept, who); return withDoor(str(b.id)); }
    if (ep === 'jobs/undo') { jobs.undo(str(b.id), dept, who, str(b.step)); return withDoor(str(b.id)); }
    if (ep === 'jobs/repair') {
      jobs.openDetour(str(b.id), { toDept: str(b.toDept), reason: str(b.reason), rush: b.rush !== false }, dept, who);
      return withDoor(str(b.id));
    }
    if (ep === 'jobs/repair-done') {
      jobs.closeDetour(Number(b.detour), dept, who);
      return { ok: true };
    }
    throw new HttpError(404, 'Not found');
  });
}

module.exports = { get, post, REPAIR_REASONS };
