'use strict';
/**
 * Door order forms: the Excel order form for one door (file name like "Door 26-611.xlsm", door number yy-xxx), read where it lives.
 *
 * Nothing is copied into a database yet: the shared "Door Orders" folder is the source of truth, and each form is read on demand
 * (and remembered until the file changes). Three things are built from a form:
 *  - summary(): every detail the departments need, as plain text, found by the label printed on the form ("Hinge Side:")
 *               rather than by cell address, so a form that moves a row still reads right
 *  - sheet():   the original sheet as people see it in Excel, to scroll and read
 *  - the work order (workorder.js) is laid out from a summary
 */
const fs = require('fs');
const path = require('path');
const { HttpError, ignored } = require('./util');

const FOLDER = 'Door Orders';
const EXT = /\.(xlsx|xlsm|xls)$/i;
const MAX_FILES = 500, MAX_BYTES = 25 * 1024 * 1024;
const LABEL_ROWS = 100, LABEL_COLS = 45;
const PREVIEW_ROWS = 150, PREVIEW_COLS = 40;

const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
/** Blank cells in the form read "-", 0 or FALSE: all of those mean "nothing here". */
const isBlank = v => v === '' || /^(-+|0|0\.0+|false|n\/?a)$/i.test(v);

/**
 * Every detail read from a form: key -> the label printed on it. `multi` joins several cells beside the label (a size is two
 * cells); `below` takes the cell under the label. When a label appears twice (the sidelight repeats "Panel type") the top one wins.
 */
const FIELDS = {
  // the order
  customer: ['Customer Name'], project: ['Tag Name'], po: ['PO#'], orderDate: ['Order Date'], ship: ['Target Ship Date'],
  orderNo: ['Order Number'], price: ['Net Price'],
  // the door panel
  series: ['Panel Series'], ptype: ['Panel type'], width: ['Panel Width'], height: ['Panel Height'], swing: ['Panel Swing'],
  extFinish: ['Panel exterior finish'], intFinish: ['Panel interior finish'],
  // hinges and locks
  hingeSide: ['Hinge Side'], hingeFinish: ['Hinge Finish'], hingeType: ['Hinge Type', { below: true }], hingeQty: ['Hinge Quantity'],
  deadbolt: ['Deadbolt Prepping'], multipoint: ['Multi-point lock type'], mpPassive: ['MP lock on Passive panel'], dummy: ['Dummy Handle?'],
  // the frame
  frameOptions: ['Frame Options'], frameType: ['Frame Type'], grain: ['Grain Texture'],
  doorFrame: ['Door Frame Size', { multi: true }], overallFrame: ['Overall Frame Size', { multi: true }], finishedFrame: ['Finished Frame Size', { multi: true }],
  jamb: ['Jamb Thickness'], shim: ['Shim Thickness'], brickSize: ['Brickmold Size', { multi: true }], brickType: ['Brickmold Type'], brickAcc: ['BM Accessories'],
  sillType: ['Sill Type'], sillDepth: ['Sill Depth'], sillOptions: ['Sill Options'], sillColour: ['Sill Colour'], transom: ['Transom Frame Options'],
  // colour
  frameOut: ['Frame colour out'], frameIn: ['Frame colour in'], weather: ['Weatherstrip Colour'], strike: ['Strike Finish'],
  // glass and hardware
  glassSize: ['Main Door glass size'], glassStyle: ['Glass style or code'], glassOptions: ['Glass options'], glassFrame: ['Glass frame type'],
  sidelight: ['Sidelight type'], handleStyle: ['Handle style'], lever: ['Lever style'], handleFinish: ['Handle finish'], hardware: ['Hardware Options'],
};

const norm = s => clean(s).toLowerCase().replace(/[:?]+$/, '').trim();

function cellText(ws, r, c, XLSX) {
  const cell = ws[XLSX.utils.encode_cell({ r, c })];
  return cell ? clean(cell.w != null ? cell.w : cell.v) : '';
}

/** Every label on the first rows of the form, found once: lower-case label text -> [{ r, c }] top to bottom. */
function indexLabels(ws, XLSX) {
  const idx = new Map();
  for (let r = 0; r < LABEL_ROWS; r++) for (let c = 0; c < LABEL_COLS; c++) {
    const t = norm(cellText(ws, r, c, XLSX));
    if (!t || t.length > 40) continue;
    if (!idx.has(t)) idx.set(t, []);
    idx.get(t).push({ r, c });
  }
  return idx;
}

/** The value printed beside a label: the next filled cell to its right (a few cells for a label in the left block, one in the right block). */
function valueOf(ws, idx, label, XLSX, { below = false, multi = false } = {}) {
  const at = (idx.get(norm(label)) || [])[0];
  if (!at) return '';
  if (below) return cellText(ws, at.r + 1, at.c, XLSX);
  const span = at.c <= 2 ? (multi ? 5 : 3) : 1;
  const found = [];
  for (let k = 1; k <= span; k++) {
    const t = cellText(ws, at.r, at.c + k, XLSX);
    if (t && !isBlank(t)) { found.push(t); if (!multi) break; }
  }
  return multi ? found.join(' × ') : (found[0] || cellText(ws, at.r, at.c + 1, XLSX));
}

const doorFromName = name => { const m = /(\d{2}-\d{1,4})/.exec(name); return m ? m[1] : ''; };

class Orders {
  /** `root` is the Portal's shared folder. `xlsx` is passed in so the (large) library is only loaded when orders are used. */
  constructor(root, xlsx) { this.root = root; this.XLSX = xlsx; this.cache = new Map(); }
  get dir() { return path.join(this.root, FOLDER); }

  /** Makes sure the folder exists, so there is somewhere obvious to drop forms. */
  ensureFolder() { try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* the list will just be empty */ } }

  files() {
    const out = [];
    const walk = (dir, rel, depth) => {
      let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignored(e.name) || e.name.startsWith('~$') || e.isSymbolicLink()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (depth < 3) walk(path.join(dir, e.name), r, depth + 1); }
        else if (EXT.test(e.name) && out.length < MAX_FILES) {
          try { const st = fs.statSync(path.join(dir, e.name)); out.push({ rel: r, name: e.name, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }); } catch { /* vanished */ }
        }
      }
    };
    walk(this.dir, '', 0);
    return out;
  }

  /** Reads a form (cached until the file changes). Returns the workbook and the labels of its first sheet. */
  open(rel) {
    const full = path.join(this.dir, ...String(rel).split('/'));
    if (path.relative(this.dir, full).startsWith('..') || !EXT.test(full)) throw new HttpError(400, 'That is not an order form');
    let st; try { st = fs.statSync(full); } catch { throw new HttpError(404, 'Not found'); }
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    if (st.size > MAX_BYTES) throw new HttpError(400, 'That file is too large to preview');
    const key = full, hit = this.cache.get(key);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
    const wb = this.XLSX.read(fs.readFileSync(full), { type: 'buffer', cellDates: false, bookVBA: false });
    const name = wb.SheetNames.find(n => /order form/i.test(n)) || wb.SheetNames[0];
    const ws = wb.Sheets[name];
    const entry = { mtime: st.mtimeMs, size: st.size, wb, main: name, ws, idx: ws ? indexLabels(ws, this.XLSX) : new Map() };
    if (this.cache.size >= 60) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, entry);
    return entry;
  }

  /** Everything read from one form: { path, rel, name, mtime, size, door, f: { key: text } }, or `error` when it can't be read as an order form. */
  summary(f) {
    const base = { path: `${FOLDER}/${f.rel}`, rel: f.rel, name: f.name, mtime: f.mtime, size: f.size, door: doorFromName(f.name) };
    try {
      const { ws, idx } = this.open(f.rel);
      if (!ws || !(idx.has('panel series') || idx.has('hinge side'))) return { ...base, error: 'This does not look like a door order form' };
      const out = {};
      for (const [key, [label, opts]] of Object.entries(FIELDS)) { const v = valueOf(ws, idx, label, this.XLSX, opts); out[key] = isBlank(v) ? '' : v; }
      out.size = out.width || out.height ? `${out.width || '?'} × ${out.height || '?'}` : '';
      const door = valueOf(ws, idx, 'Door Number', this.XLSX);
      return { ...base, door: door && !isBlank(door) ? door : base.door, f: out };
    } catch (e) { return { ...base, error: 'Could not read this file' }; }
  }

  find(rel) {
    const f = this.files().find(x => x.rel === rel);
    if (!f) throw new HttpError(404, 'Not found');
    return this.summary(f);
  }

  list() {
    this.ensureFolder();
    return this.files().map(f => this.summary(f)).sort((a, b) => String(a.door || a.name).localeCompare(String(b.door || b.name), undefined, { numeric: true }));
  }

  /** One sheet laid out like Excel shows it: its print area when it has one. Text only; the page builds the table. */
  sheet(rel, which) {
    const { wb } = this.open(rel);
    const XLSX = this.XLSX;
    const visible = wb.SheetNames.filter((n, i) => {
      const st = wb.Workbook && wb.Workbook.Sheets && wb.Workbook.Sheets[i];
      const ws = wb.Sheets[n];
      return !(st && st.Hidden) && ws && ws['!ref'] && XLSX.utils.decode_range(ws['!ref']).e.r > 0;
    });
    const name = visible.includes(which) ? which : visible.find(n => /order form/i.test(n)) || visible[0];
    if (!name) throw new HttpError(404, 'This file has no sheets to show');
    const ws = wb.Sheets[name], full = XLSX.utils.decode_range(ws['!ref']);
    let range = full;
    const pa = (wb.Workbook && wb.Workbook.Names || []).find(n => n.Name === '_xlnm.Print_Area' && n.Sheet === wb.SheetNames.indexOf(name) && !/#REF/.test(n.Ref));
    if (pa) { try { range = XLSX.utils.decode_range(pa.Ref.split('!').pop().replace(/\$/g, '')); } catch { range = full; } }
    const e = { r: Math.min(range.e.r, range.s.r + PREVIEW_ROWS - 1), c: Math.min(range.e.c, range.s.c + PREVIEW_COLS - 1) };
    const rows = [];
    for (let r = range.s.r; r <= e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= e.c; c++) row.push(cellText(ws, r, c, XLSX));
      rows.push(row);
    }
    const merges = (ws['!merges'] || []).filter(m => m.s.r >= range.s.r && m.s.c >= range.s.c && m.s.r <= e.r && m.s.c <= e.c)
      .map(m => ({ r: m.s.r - range.s.r, c: m.s.c - range.s.c, rs: Math.min(m.e.r, e.r) - m.s.r + 1, cs: Math.min(m.e.c, e.c) - m.s.c + 1 }));
    while (rows.length && rows[rows.length - 1].every(v => !v)) rows.pop();
    return { sheets: visible, name, rows, merges };
  }
}

module.exports = { Orders, FOLDER, FIELDS };
