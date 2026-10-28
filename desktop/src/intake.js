'use strict';
/**
 * From a door order form to a door in the shop. The form (orders.js) stays the source of the details; this only picks out what the
 * flow needs and asks the office three things the form does not say: where the frame, the panel and the rail & stile come from.
 */
const { HttpError } = require('./util');

/** Where each component comes from. 'inhouse' = made by the shop's own provider; 'bought' = an outside supplier; 'none' = this door has none. */
const SOURCES = {
  frame: { inhouse: ['internal', 'Frame Prep'], bought: ['external', 'Supplier'] },
  panel: { inhouse: ['internal', 'Panel Assembly'], bought: ['external', 'Supplier'] },
  rail_stile: { inhouse: ['internal', 'Rail & Stile'], bought: ['external', 'Supplier'] },
};
const DEFAULT_CHOICES = { frame: 'inhouse', panel: 'inhouse', rail_stile: 'none' };

/** A date as written on a form ("11/20/2026", "Nov 20, 2026", "2026-11-20") as yyyy-mm-dd so doors sort by it; anything unreadable is kept as written. */
function normDate(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  let y, m, d, x;
  if ((x = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})$/.exec(t))) {
    let a = +x[1], b = +x[2]; y = +x[3]; if (y < 100) y += 2000;
    if (a > 12 && b <= 12) { d = a; m = b; } else { m = a; d = b; }          // North American order unless the first number can't be a month
  } else {
    const ms = Date.parse(t + ' 12:00');
    if (!Number.isFinite(ms)) return t.slice(0, 20);
    const dt = new Date(ms); y = dt.getFullYear(); m = dt.getMonth() + 1; d = dt.getDate();
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return t.slice(0, 20);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** `summary` is from Orders.summary(); `choices` says where each component comes from. Returns what JobStore.createDoor takes. */
function doorFromOrder(summary, choices = {}) {
  if (!summary || summary.error) throw new HttpError(400, (summary && summary.error) || 'That is not an order form');
  const door = String(summary.door || '').trim();
  if (!door) throw new HttpError(400, 'This form has no door number, so it cannot be added');
  const f = summary.f || {}, pick = { ...DEFAULT_CHOICES, ...choices }, components = [];
  for (const kind of Object.keys(SOURCES)) {
    const how = pick[kind];
    if (how === 'none') continue;
    const s = SOURCES[kind][how];
    if (!s) throw new HttpError(400, `Unknown choice for ${kind}`);
    components.push({ kind, sourceKind: s[0], source: s[1] });
  }
  return { number: door, project: f.project || '', customer: f.customer || '', shipDate: normDate(f.ship), sourcePath: summary.path || '', components };
}

module.exports = { doorFromOrder, normDate, DEFAULT_CHOICES };
