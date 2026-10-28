'use strict';
/**
 * The /api/jobs/... calls: what the screens ask the job store (jobs.js), and the few things that start from an order form (intake.js).
 * There are no logins: every change says which department made it (`dept`) and may carry a name typed for that one action (`who`).
 */
const { HttpError } = require('./util');
const { STAGES, STEPS } = require('./workflow');
const { ACTORS } = require('./jobs');
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

const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** Handles a GET; returns the JSON to send. */
function get(jobs, ep, q) {
  if (!jobs || !jobs.ok) throw new HttpError(503, 'Jobs are unavailable right now. Ask whoever looks after the Portal.');
  return wrap(() => {
    if (ep === 'jobs/meta') return { stages: STAGES, steps: STEPS, actors: ACTORS, reasons: REPAIR_REASONS, defaults: DEFAULT_CHOICES };
    if (ep === 'jobs/board') return { doors: jobs.board() };
    if (ep === 'jobs/queue') return jobs.queue(str(q.dept));
    if (ep === 'jobs/door') { const door = jobs.door(str(q.id)); return { door, events: jobs.events(40, door.id) }; }
    throw new HttpError(404, 'Not found');
  });
}

/** Handles a POST; returns the JSON to send. `orders` reads the order forms. */
function post(jobs, orders, ep, b) {
  if (!jobs || !jobs.ok) throw new HttpError(503, 'Jobs are unavailable right now. Ask whoever looks after the Portal.');
  const dept = str(b.dept), who = str(b.who);
  const withDoor = id => ({ ok: true, door: jobs.door(id) });
  return wrap(() => {
    if (ep === 'jobs/add') {
      if (!orders) throw new HttpError(404, 'Not found');
      const input = doorFromOrder(orders.find(str(b.rel)), b.choices || {});
      if (jobs.numbers().includes(input.number.toLowerCase())) throw new HttpError(409, `Door ${input.number} is already in the shop`);
      return withDoor(jobs.createDoor(input, dept || 'Office'));
    }
    if (ep === 'jobs/add-all') {
      if (!orders) throw new HttpError(404, 'Not found');
      const have = new Set(jobs.numbers()), added = [], skipped = [];
      for (const o of orders.list()) {
        if (o.error || !o.door) { skipped.push({ name: o.name, why: o.error || 'No door number' }); continue; }
        if (have.has(o.door.toLowerCase())) continue;
        try { jobs.createDoor(doorFromOrder(o, b.choices || {}), dept || 'Office'); have.add(o.door.toLowerCase()); added.push(o.door); }
        catch (e) { skipped.push({ name: o.name, why: e.message }); }
      }
      return { ok: true, added, skipped };
    }
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
