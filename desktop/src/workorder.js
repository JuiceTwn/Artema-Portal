'use strict';
/**
 * The work order: one door's details laid out as a clean one-page sheet, for the screen and for PDF.
 * It is made from a summary (orders.js), never from the spreadsheet itself, and it is always the whole order: a department's view
 * only decides which sections come first and large; everything else is still on the page, smaller (the shop works in the open).
 * The result is one self-contained HTML document: no scripts, no outside files.
 */
const fs = require('fs');
const path = require('path');
const { DEPARTMENTS } = require('./departments');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** [label shown, key in the summary]. */
const SECTIONS = {
  panel: { title: 'Door panel', rows: [['Panel series', 'series'], ['Type', 'ptype'], ['Size (W × H)', 'size'], ['Swing', 'swing']] },
  hinges: { title: 'Hinges', rows: [['Hinge side', 'hingeSide'], ['Finish', 'hingeFinish'], ['Type', 'hingeType'], ['Quantity', 'hingeQty']] },
  lock: { title: 'Lock prepping', rows: [['Deadbolt prep', 'deadbolt'], ['Multipoint lock', 'multipoint'], ['MP lock on passive panel', 'mpPassive'], ['Dummy handle', 'dummy']] },
  frame: { title: 'Frame', rows: [['Frame options', 'frameOptions'], ['Frame type', 'frameType'], ['Grain texture', 'grain'], ['Door frame size', 'doorFrame'], ['Overall frame size', 'overallFrame'], ['Finished frame size', 'finishedFrame'], ['Jamb thickness', 'jamb'], ['Shim thickness', 'shim'], ['Brickmold', 'brickSize'], ['Brickmold type', 'brickType'], ['Brickmold accessories', 'brickAcc'], ['Transom frame', 'transom']] },
  sill: { title: 'Sill', rows: [['Sill type', 'sillType'], ['Sill depth', 'sillDepth'], ['Sill options', 'sillOptions'], ['Sill colour', 'sillColour']] },
  colour: { title: 'Finish & colour', rows: [['Panel exterior', 'extFinish'], ['Panel interior', 'intFinish'], ['Frame colour out', 'frameOut'], ['Frame colour in', 'frameIn'], ['Sill colour', 'sillColour'], ['Weatherstrip', 'weather'], ['Strike finish', 'strike'], ['Hinge finish', 'hingeFinish']] },
  glass: { title: 'Glass', rows: [['Main door glass size', 'glassSize'], ['Glass style or code', 'glassStyle'], ['Glass options', 'glassOptions'], ['Glass frame type', 'glassFrame'], ['Sidelight type', 'sidelight']] },
  hardware: { title: 'Handle & hardware', rows: [['Handle style', 'handleStyle'], ['Lever style', 'lever'], ['Handle finish', 'handleFinish'], ['Hardware options', 'hardware'], ['Dummy handle', 'dummy']] },
  order: { title: 'Order', rows: [['Customer', 'customer'], ['Project', 'project'], ['PO number', 'po'], ['Order number', 'orderNo'], ['Order date', 'orderDate'], ['Target ship date', 'ship'], ['Net price', 'price']] },
};
/** What each department works from, in the order it reads it. */
const FOCUS = {
  CNC: ['panel', 'hinges', 'lock'],
  'Frame Prep': ['frame', 'sill', 'hinges'],
  Paint: ['colour'],
  Assembly: ['panel', 'glass', 'hardware', 'hinges'],
  Office: ['order'],
};
const ALL = ['panel', 'hinges', 'lock', 'frame', 'sill', 'colour', 'glass', 'hardware', 'order'];

let logo = null;
function logoUri() {
  if (logo === null) {
    try { logo = 'data:image/webp;base64,' + fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'logo-light.webp')).toString('base64'); } catch { logo = ''; }
  }
  return logo;
}

const CSS = `
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #e9e4dc; }
  body { font: 14px/1.4 "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #161922; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { width: 8.5in; min-height: 11in; margin: 0 auto; background: #fff; display: flex; flex-direction: column; overflow: hidden; }
  .band { background: #161922; color: #f6efe6; padding: 16px 40px 14px; display: flex; align-items: center; justify-content: space-between; border-bottom: 5px solid #cc7d14; }
  .band img { height: 26px; display: block; }
  .band .wo { text-align: right; }
  .band .wo small { display: block; font-size: 10px; letter-spacing: .24em; text-transform: uppercase; color: #e39a2f; font-weight: 700; }
  .band .wo b { font-size: 22px; letter-spacing: .02em; font-weight: 600; }
  .head { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding: 20px 40px 14px; }
  .head .num small, .ship small { display: block; font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: #7b2528; font-weight: 700; }
  .head .num h1 { margin: 0; font-size: 42px; line-height: 1.05; letter-spacing: -.01em; }
  .head .num p { margin: 6px 0 0; color: #5a5f6b; font-size: 15px; }
  .ship { text-align: right; flex: none; padding: 10px 16px; border: 1.5px solid #161922; border-radius: 12px; min-width: 190px; }
  .ship b { font-size: 18px; display: block; }
  .ship span { font-size: 12px; color: #5a5f6b; }
  .focus { padding: 0 40px; display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .card { border: 1px solid #ddd5c9; border-top: 4px solid #7b2528; border-radius: 10px; padding: 14px 18px 8px; break-inside: avoid; background: #fffdfa; }
  .card.wide { grid-column: 1 / -1; }
  .card h2 { margin: 0 0 10px; font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: #7b2528; }
  .facts { display: grid; grid-template-columns: repeat(2, 1fr); gap: 2px 20px; }
  .card.wide .facts { grid-template-columns: repeat(3, 1fr); }
  .card.dense .facts { grid-template-columns: repeat(4, 1fr); }
  .card.dense .fact b { font-size: 14px; }
  .fact { padding: 4px 0 7px; border-bottom: 1px solid #efe9df; min-width: 0; }
  .fact small { display: block; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: #8a8f99; font-weight: 600; }
  .fact b { font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
  .fact b.none { color: #b9b4ab; font-weight: 400; }
  .rest { padding: 14px 40px 0; }
  .rest > h2 { margin: 0 0 8px; font-size: 11px; letter-spacing: .2em; text-transform: uppercase; color: #8a8f99; }
  .rest .grid { columns: 3; column-gap: 22px; }
  .rest .sec { break-inside: avoid; margin-bottom: 12px; }
  .rest .sec h3 { margin: 0 0 3px; font-size: 12px; color: #7b2528; font-weight: 700; }
  .rest .row { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; padding: 1px 0; border-bottom: 1px dotted #ddd5c9; }
  .rest .row span { color: #7a7f89; }
  .rest .row b { font-weight: 600; text-align: right; }
  .sign { margin: 10px 40px 14px; padding: 14px 18px; border: 1.5px dashed #b9b4ab; border-radius: 10px; display: flex; gap: 28px; align-items: center; font-size: 12px; color: #5a5f6b; }
  .sign i { flex: 1; border-bottom: 1px solid #161922; height: 18px; }
  .sign .box { width: 18px; height: 18px; border: 1.5px solid #161922; border-radius: 4px; flex: none; }
  .foot { margin: auto 40px 18px; display: flex; justify-content: space-between; font-size: 10px; color: #9a9ea8; border-top: 1px solid #ddd5c9; padding-top: 8px; }
  @media screen { .page { margin: 18px auto; box-shadow: 0 10px 40px rgba(0, 0, 0, .25); } }
  @media print { html, body { background: #fff; } .page { margin: 0; box-shadow: none; min-height: 10.9in; } }
`;

const fact = (label, value) => `<div class="fact"><small>${esc(label)}</small><b${value ? '' : ' class="none"'}>${value ? esc(value) : '—'}</b></div>`;

/** `order` is a summary from orders.js, `dept` one of DEPARTMENTS (anything else is read as Office). */
function renderWorkOrder(order, dept) {
  const d = DEPARTMENTS.includes(dept) ? dept : 'Office';
  const f = order.f || {};
  const focus = FOCUS[d], rest = ALL.filter(k => !focus.includes(k));
  const cards = focus.map((k, i) => {
    const s = SECTIONS[k];
    const wide = s.rows.length > 5 || (focus.length % 2 === 1 && i === focus.length - 1 && focus.length > 1) || focus.length === 1;
    return `<section class="card${wide ? ' wide' : ''}${s.rows.length > 8 ? ' dense' : ''}"><h2>${esc(s.title)}</h2><div class="facts">${s.rows.map(([l, key]) => fact(l, f[key])).join('')}</div></section>`;
  }).join('');
  const others = rest.map(k => {
    const s = SECTIONS[k], rows = s.rows.filter(([, key]) => f[key]);
    return rows.length ? `<div class="sec"><h3>${esc(s.title)}</h3>${rows.map(([l, key]) => `<div class="row"><span>${esc(l)}</span><b>${esc(f[key])}</b></div>`).join('')}</div>` : '';
  }).join('');
  const sub = [f.customer, f.project].filter(Boolean).join('  ·  ');
  const logoSrc = logoUri();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Work order ${esc(order.door)} – ${esc(d)}</title><style>${CSS}</style></head><body>
<div class="page">
  <div class="band">${logoSrc ? `<img src="${logoSrc}" alt="Artema">` : '<b>ARTEMA</b>'}<div class="wo"><small>Work order</small><b>${esc(d)}</b></div></div>
  <div class="head">
    <div class="num"><small>Door number</small><h1>${esc(order.door || order.name)}</h1><p>${esc(sub) || '&nbsp;'}</p></div>
    <div class="ship"><small>Target ship date</small><b>${esc(f.ship) || '—'}</b><span>${[f.po && 'PO ' + f.po, f.orderNo && 'Order ' + f.orderNo].filter(Boolean).map(esc).join(' · ') || '&nbsp;'}</span></div>
  </div>
  <div class="focus">${cards}</div>
  ${others ? `<div class="rest"><h2>Also on this order</h2><div class="grid">${others}</div></div>` : ''}
  ${d === 'Office' ? '' : `<div class="sign"><span class="box"></span><span>Done</span><span>Completed by</span><i></i><span>Date</span><i></i></div>`}
  <div class="foot"><span>Artema Door · ${esc(d)} work order</span><span>${esc(order.name)}</span></div>
</div></body></html>`;
}

module.exports = { renderWorkOrder, SECTIONS, FOCUS };
