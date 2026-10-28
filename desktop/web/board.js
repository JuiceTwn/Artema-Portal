(() => {
  // The Board: one row per door, columns chosen by the tab you are on. Status columns are coloured dropdowns anyone can set with a tap;
  // admins edit the labels, the columns and the tabs ("Customize"). The guided steps (jobs.js) are an optional layer, off by default.
  const { $, $$, esc, icon, api, toast, S, views, q } = window.Portal;
  const K = window.Portal.jobs.kit;
  const isAdmin = () => ['admin', 'dev'].includes(S.me && S.me.role);
  const hexOf = (cfg, key) => (cfg.palette && cfg.palette[key]) || '#7e8499';

  // ---------- the columns a tab can show ----------
  const BUILTIN = { door: 'Door', updates: 'Updates', files: 'Order form', ship: 'Ships', customer: 'Customer', notes: 'Notes', at: 'Where it is now', where: 'Where it is (guided steps)', next: 'Next step (guided steps)', flags: 'Needs a look (guided steps)' };
  const GUIDED_ONLY = ['where', 'next', 'flags'];
  /** Details read from the order form, so a department can see what it works from beside its statuses. */
  const FORM = {
    series: ['Panel series', f => f.series], ptype: ['Panel type', f => f.ptype], size: ['Size', f => f.size], swing: ['Swing', f => K.both(f.swing, f.hingeSide)],
    hinges: ['Hinges', f => K.both(f.hingeQty && f.hingeQty + '×', f.hingeFinish)], prepping: ['Prepping', f => K.both(f.deadbolt && 'DB ' + f.deadbolt, f.multipoint && 'MP ' + f.multipoint)],
    frame: ['Frame', f => K.both(f.frameType, f.doorFrame)], jamb: ['Jamb', f => f.jamb], sill: ['Sill', f => K.both(f.sillType, f.sillDepth)], brickmold: ['Brickmold', f => K.both(f.brickSize, f.brickType)],
    extFinish: ['Panel out', f => f.extFinish], intFinish: ['Panel in', f => f.intFinish], frameOut: ['Frame out', f => f.frameOut], frameIn: ['Frame in', f => f.frameIn],
    sillColour: ['Sill colour', f => f.sillColour], hingeFinish: ['Hinge finish', f => f.hingeFinish], glass: ['Glass', f => K.both(f.glassSize, f.glassStyle)],
    handle: ['Handle', f => K.both(f.handleStyle, f.lever)], hardware: ['Hardware', f => f.hardware], po: ['PO', f => f.po], frameOptions: ['Configuration', f => f.frameOptions], paintFormula: ['Paint formula', f => f.paintFormula], orderNo: ['Order #', f => f.orderNo], tag: ['Project name', f => f.project],
  };
  const colLabel = (key, cfg) => {
    if (BUILTIN[key]) return BUILTIN[key];
    if (key.startsWith('f:')) return (FORM[key.slice(2)] || [key.slice(2)])[0] + ' (from the order form)';
    const f = cfg.fields.find(x => '#' + x.id === key); return f ? f.name : 'Missing column';
  };

  /**
   * A tab shows the doors whose statuses meet its conditions: { field, test: 'label' | 'finished', label?, not }. That is how a door turns up
   * on the next station's tab by itself: Paint shows a door once Paint Prep is finished and Paint is not.
   */
  const condHolds = (c, d, cfg) => {
    const f = cfg.fields.find(x => x.id === c.field); if (!f) return true;
    const cell = d.cells[c.field], l = cell && cell.label != null ? f.labels.find(x => x.id === cell.label) : null;
    const fin = fid => { const ff = cfg.fields.find(x => x.id === fid), cc = d.cells[fid], ll = ff && cc && cc.label != null ? ff.labels.find(x => x.id === cc.label) : null; return !!(ll && ll.done); };
    return (c.test === 'finished' ? [c.field, ...(c.with || [])].every(fin) : !!l && l.id === c.label) !== !!c.not;
  };
  const atTab = (d, view, cfg) => (view.filter || []).every(c => condHolds(c, d, cfg));
  window.Portal.jobs.kit.atTab = atTab;
  /** Where a door is right now: the tabs (with conditions) that show it. */
  const whereIs = (d, cfg) => cfg.views.filter(v => (v.filter || []).length && atTab(d, v, cfg)).map(v => v.name);
  const labelOf = (f, d) => { const c = d.cells[f.id]; return c && c.label != null ? f.labels.find(l => l.id === c.label) || null : null; };
  /** A date as a coloured pill: red when past, orange when within three days, blue otherwise. */
  const datePill = value => {
    const i = K.due(value), col = i.days === null ? '#579bfc' : i.days < 0 ? '#e8687c' : i.days <= 3 ? '#fdab61' : '#579bfc';
    return `<span class="pill" style="background:${col};color:${K.inkOn(col)}">${esc(K.dueText(value))}</span>`;
  };

  function fieldCol(f, cfg) {
    if (f.kind === 'status') {
      return { label: f.name, cls: 'c-st', sort: (a, b) => { const pos = d => { const l = labelOf(f, d); return l ? f.labels.indexOf(l) : 999; }; return pos(a) - pos(b); },
        cell: d => {
          const l = labelOf(f, d), attr = `data-pop="1" data-field="${f.id}"`;
          return l ? { h: esc(l.name), cls: 'stc', style: `background:${hexOf(cfg, l.color)};color:${K.inkOn(hexOf(cfg, l.color))}`, attr } : { h: '', cls: 'stc blank', attr };
        } };
    }
    if (f.kind === 'date') {
      return { label: f.name, cls: 'c-dt', sort: (a, b) => ((a.cells[f.id] || {}).value || '9999').localeCompare((b.cells[f.id] || {}).value || '9999'),
        cell: d => { const v = (d.cells[f.id] || {}).value; return { h: v ? datePill(v) : '<span class="faint">—</span>', cls: 'dt', attr: `data-pop="1" data-field="${f.id}"` }; } };
    }
    return { label: f.name, cls: 'c-tx', sort: (a, b) => K.nat((a.cells[f.id] || {}).value || '', (b.cells[f.id] || {}).value || ''),
      cell: d => { const v = (d.cells[f.id] || {}).value || ''; return { h: v ? `<span class="tx">${esc(v)}</span>` : '<span class="faint add">+</span>', cls: 'g-text', attr: `data-id="${d.id}" data-field="${f.id}" data-val="${esc(v)}"` }; } };
  }
  function colFor(key, cfg) {
    if (GUIDED_ONLY.includes(key) && !cfg.guided) return null;
    switch (key) {
      case 'door': return K.doorCol;
      case 'updates': return { label: '', cls: 'c-ico', sort: (a, b) => a.commentCount - b.commentCount,
        cell: d => `<button class="bub${d.commentCount ? ' has' : ''}" data-comments="${d.id}" aria-label="Updates for ${esc(d.number)}">${icon('chat')}${d.commentCount ? `<i>${d.commentCount}</i>` : ''}</button>` };
      case 'files': return K.filesCol;
      case 'ship': return K.dueCell;
      case 'customer': return K.custCol;
      case 'notes': return K.notesCol;
      case 'at': return { label: 'Where it is', cls: 'c-tx', sort: (a, b) => K.nat(whereIs(a, cfg).join(), whereIs(b, cfg).join()), cell: d => { const w = whereIs(d, cfg); return w.length ? `<span class="tx">${esc(w.join(', '))}</span>` : '<span class="faint">—</span>'; } };
      case 'where': return K.stageCol;
      case 'next': return K.nextCol;
      case 'flags': return K.flagsCol;
      default:
        if (key.startsWith('f:')) {
          const fm = FORM[key.slice(2)]; if (!fm) return null;
          return { label: fm[0], cls: 'c-f', sort: (a, b) => K.nat(a.form ? fm[1](a.form) || '' : '', b.form ? fm[1](b.form) || '' : ''), cell: d => { const v = d.form ? fm[1](d.form) : ''; return v ? `<span class="fv">${esc(v)}</span>` : '<span class="faint">—</span>'; } };
        }
        if (key[0] === '#') { const f = cfg.fields.find(x => '#' + x.id === key); return f ? fieldCol(f, cfg) : null; }
        return null;
    }
  }
  /** A door needs a look when a label flagged "needs a look" is set, its ship date has passed, or (guided steps) it is on hold. */
  const needsLook = (d, cfg) => cfg.fields.some(f => f.kind === 'status' && (labelOf(f, d) || {}).attn) || (K.due(d.shipDate).days !== null && K.due(d.shipDate).days < 0) || (cfg.guided && (d.status === 'repair' || d.waitingOn.length > 0));

  // ---------- the board ----------
  async function loadBoard(force) {
    if (!force && (K.editing() || $('#pop') || (document.activeElement && document.activeElement.id === 'bd-q') || document.querySelector('dialog.pick[open]'))) return;          // never redraw under someone mid-edit
    const cfg = await api('jobs/board' + (S.showArchived ? '?archived=1' : ''));
    K.applyGuided(cfg.guided);
    const snap = JSON.stringify([cfg, S.boardQ, S.boardAttn, S.boardTab, S.sort, K.density(), S.showArchived]);
    if (!force && snap === S.boardSnap) return;
    S.boardSnap = snap; S.cfg = cfg;
    renderBoard(cfg);
  }
  views.board = loadBoard;
  const redraw = () => { S.boardSnap = ''; loadBoard(true).catch(e => toast(e.message, true)); };

  function currentView(cfg) {
    const want = S.boardTab || K.store.get('artema.boardtab');
    return cfg.views.find(v => String(v.id) === String(want)) || cfg.views[0];
  }
  function renderBoard(cfg) {
    const view = currentView(cfg), name = 'board' + view.id;
    let cols = view.cols.map(k => colFor(k, cfg)).filter(Boolean);
    if (!cfg.doors.some(d => d.sourcePath)) cols = cols.filter(c => c !== K.filesCol);
    const term = (S.boardQ || '').toLowerCase().trim();
    const doors = cfg.doors.filter(d => atTab(d, view, cfg) && (!term || [d.number, d.customer, d.project, d.notes].join(' ').toLowerCase().includes(term)) && (!S.boardAttn || needsLook(d, cfg)));
    const dateIdx = cols.findIndex(c => c.cls === 'c-dt'), shipIdx = cols.indexOf(K.dueCell);
    const rows = K.sortRows(name, cols, doors, { i: dateIdx >= 0 ? dateIdx : shipIdx >= 0 ? shipIdx : 0, dir: 1 });
    const mine = cfg.doors.filter(d => atTab(d, view, cfg)), total = mine.length, attn = mine.filter(d => needsLook(d, cfg)).length;

    $('#board').innerHTML = `<div class="head"><div><div class="crumbs"><button>Board</button></div><div class="sub">${S.showArchived ? 'Archived doors' : `${total} door${total === 1 ? '' : 's'} in the shop`}${attn && !S.showArchived ? ` · <b class="red">${attn} need${attn === 1 ? 's' : ''} a look</b>` : ''}</div></div>
        <div class="head-actions"><button class="btn primary" id="bd-new">${icon('plus')}New door</button></div></div>
      <div class="bd-tabs">${cfg.views.length > 6
        ? `<select class="bd-select" id="bd-view" aria-label="Which view">${cfg.views.map(v => `<option value="${v.id}"${v.id === view.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`
        : cfg.views.map(v => `<button class="${v.id === view.id ? 'on' : ''}" data-tab="${v.id}">${esc(v.name)}</button>`).join('')}${isAdmin() ? `<button class="gear" id="bd-cz">${icon('gear')}Customize</button>` : ''}</div>
      <div class="bd-tools"><label class="search bd-search">${icon('search')}<input id="bd-q" placeholder="Find a door, customer, project or note" autocomplete="off" spellcheck="false" value="${esc(S.boardQ || '')}"></label>
        <button class="bd-attn${S.boardAttn ? ' on' : ''}" id="bd-attn">${icon('alert')}Needs a look${attn ? ` (${attn})` : ''}</button>
        <button class="bd-attn" id="bd-rework">${icon('wrench')}Rework</button>
        <button class="bd-attn${S.showArchived ? ' on2' : ''}" id="bd-arch">${S.showArchived ? 'Back to the board' : 'Archived'}</button>
        <span class="grow"></span>${K.densityBar('board')}</div>
      ${doors.length ? K.tableHtml(name, cols, rows) : `<div class="empty"><div class="ring">${icon('board')}</div><h3>${term || S.boardAttn ? 'Nothing matches' : S.showArchived ? 'Nothing archived' : 'No doors yet'}</h3><div>${term || S.boardAttn ? 'Try fewer words, or turn off “Needs a look”.' : S.showArchived ? 'Archived doors are kept here.' : 'Add doors from the Excel order forms, or press New door.'}</div>${!term && !S.boardAttn && !S.showArchived ? `<button class="btn primary big" id="bd-forms">${icon('door')}Add from order forms</button>` : ''}</div>`}`;

    $$('#board [data-tab]').forEach(b => b.onclick = () => { S.boardTab = b.dataset.tab; K.store.set('artema.boardtab', b.dataset.tab); redraw(); });
    if ($('#bd-view')) $('#bd-view').onchange = e => { S.boardTab = e.target.value; K.store.set('artema.boardtab', e.target.value); redraw(); };
    const inp = $('#bd-q');
    inp.oninput = () => { S.boardQ = inp.value; S.boardSnap = ''; const pos = inp.selectionStart; loadBoard(true).then(() => { const n = $('#bd-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
    $('#bd-attn').onclick = () => { S.boardAttn = !S.boardAttn; redraw(); };
    $('#bd-rework').onclick = () => reworkReport();
    $('#bd-arch').onclick = () => { S.showArchived = !S.showArchived; redraw(); };
    $('#bd-new').onclick = () => newDoor(cfg);
    if ($('#bd-forms')) $('#bd-forms').onclick = () => window.Portal.setView('orders');
    if ($('#bd-cz')) $('#bd-cz').onclick = () => customize(view.id);
    K.wireDensity('board', redraw);
    K.wireTable(name, '#board', redraw);
    // cells: a status or date opens its palette, a text edits in place, the bubble opens the door's updates
    $$('#board td[data-pop]').forEach(td => td.onclick = e => {
      e.stopPropagation();
      const d = cfg.doors.find(x => String(x.id) === td.closest('tr').dataset.id), f = cfg.fields.find(x => String(x.id) === td.dataset.field);
      if (d && f) editCell(td, d, f, cfg);
    });
    $$('#board td.g-text').forEach(td => td.onclick = e => { e.stopPropagation(); K.editText(td, td.dataset.val || '', v => K.post('cell', { id: td.dataset.id, field: td.dataset.field, value: v }), 'Type here'); });
    $$('#board [data-comments]').forEach(b => b.onclick = e => { e.stopPropagation(); K.openDoor(b.dataset.comments, { comments: true }).catch(err => toast(err.message, true)); });
  }

  // ---------- setting a cell: a coloured palette, one tap ----------
  function closePop() { const p = $('#pop'); if (p) p.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey, true); }
  function outside(e) { const p = $('#pop'); if (p && !p.contains(e.target)) closePop(); }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closePop(); } }
  /** Opens the palette (status), date picker or text box for one door's cell, next to `anchor`. */
  function editCell(anchor, door, field, cfg) {
    closePop();
    const pop = document.createElement('div'); pop.id = 'pop'; pop.className = 'pop';
    const cur = door.cells[field.id] || {};
    const set = async value => {
      closePop();
      try { await K.post('cell', { id: door.id, field: field.id, value }); } catch (e) { toast(e.message, true); }
      K.afterChange();
    };
    const head = `<div class="pop-t"><b>${esc(field.name)}</b><span>${esc(door.number)}</span></div>`;
    if (field.kind === 'status') {
      pop.innerHTML = `${head}<div class="pal">${field.labels.map(l => `<button class="lab${cur.label === l.id ? ' on' : ''}" data-l="${l.id}" style="background:${hexOf(cfg, l.color)};color:${K.inkOn(hexOf(cfg, l.color))}">${esc(l.name)}</button>`).join('')}</div>
        <div class="pop-f">${cur.label != null ? '<button class="link" data-clear>Clear</button>' : '<span></span>'}${isAdmin() ? '<button class="link" data-edit>Edit labels</button>' : ''}</div>`;
    } else if (field.kind === 'date') {
      pop.innerHTML = `${head}<input type="date" class="field" id="pop-in" value="${esc(cur.value || '')}"><div class="pop-f"><button class="link" data-clear>Clear</button></div>`;
    } else {
      pop.innerHTML = `${head}<input class="field" id="pop-in" maxlength="200" value="${esc(cur.value || '')}" placeholder="Type here"><div class="pop-f"><button class="link" data-clear>Clear</button><button class="btn primary" data-save>Save</button></div>`;
    }
    document.body.append(pop);
    $$('[data-l]', pop).forEach(b => b.onclick = () => set(Number(b.dataset.l)));
    const clear = $('[data-clear]', pop); if (clear) clear.onclick = () => set(field.kind === 'status' ? null : '');
    const ed = $('[data-edit]', pop); if (ed) ed.onclick = () => { closePop(); editLabels(field, cfg); };
    const inp = $('#pop-in', pop);
    if (inp) {
      if (field.kind === 'date') inp.onchange = () => set(inp.value);
      else { $('[data-save]', pop).onclick = () => set(inp.value.trim()); inp.onkeydown = e => { if (e.key === 'Enter') set(inp.value.trim()); }; }
      inp.focus();
    }
    // place it by the cell, kept on screen
    const r = anchor.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    pop.style.top = Math.max(8, r.bottom + 6 + h > innerHeight - 8 ? r.top - h - 6 : r.bottom + 6) + 'px';
    setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', onKey, true); }, 0);
  }
  window.Portal.jobs.kit.editCell = editCell;
  window.Portal.jobs.kit.FORM = FORM;

  // ---------- a new door by hand ----------
  async function newDoor(cfg) {
    const m = await K.meta();
    const how = [['inhouse', 'Made here'], ['bought', 'Bought']];
    const row = (n, l, o) => `<div class="pk-row"><div class="pk-label">${l}</div>${K.choiceHtml(n, o, m.defaults[n])}</div>`;
    const res = await K.modal({
      title: 'New door', ok: 'Add door',
      html: `<div class="pk-label">Door number</div><input class="field" id="nd-num" placeholder="26-611" autocomplete="off" maxlength="40">
        <div class="pk-label">Customer</div><input class="field" id="nd-cust" autocomplete="off" maxlength="120">
        <div class="pk-label">Ship date</div><input type="date" class="field" id="nd-ship">
        ${cfg.needs ? `<div class="pk-label">What does this door need?</div><div class="nd-needs">${cfg.needs.tracks.map(t => `<label class="pk-check"><input type="checkbox" data-need="${t.key}"${t.key === 'rs' ? '' : ' checked'}> ${esc(t.name)}</label>`).join('')}</div>` : ''}
        ${cfg.guided ? `<p class="pk-note">Guided steps are on, so say where the parts come from.</p>${row('frame', 'Frame', how)}${row('panel', 'Panel', how)}${row('rail_stile', 'Rail & stile', [...how, ['none', 'Not needed']])}` : ''}`,
      mount: el => { K.wireChoices(el); setTimeout(() => $('#nd-num', el).focus(), 50); },
      collect: el => {
        const number = $('#nd-num', el).value.trim();
        if (!number) { toast('Type the door number', true); return undefined; }
        return { number, needs: cfg.needs ? Object.fromEntries($$('[data-need]', el).map(x => [x.dataset.need, x.checked])) : undefined, customer: $('#nd-cust', el).value.trim(), shipDate: $('#nd-ship', el).value, choices: cfg.guided ? { frame: K.chosen(el, 'frame'), panel: K.chosen(el, 'panel'), rail_stile: K.chosen(el, 'rail_stile') } : {} };
      },
    });
    if (!res) return;
    try { const r = await K.post('new', res); toast(`Door ${res.number} added`); redraw(); K.openDoor(r.door.id); } catch (e) { toast(e.message, true); }
  }

  // ---------- admins: editing a status column's labels ----------
  async function editLabels(field, cfg) {
    let rows = field.labels.map(l => ({ ...l })), openPal = -1;
    const paletteKeys = Object.keys(cfg.palette);
    const draw = body => {
      const host = $('#lb', body);
      host.innerHTML = `${rows.map((l, i) => `<div class="lb-row" data-i="${i}">
          <button type="button" class="lb-sw" data-act="sw" aria-label="Pick a colour" style="background:${hexOf(cfg, l.color)}"></button>
          <input class="lb-name" value="${esc(l.name)}" maxlength="40" placeholder="Label name" style="background:${hexOf(cfg, l.color)};color:${K.inkOn(hexOf(cfg, l.color))}">
          <label class="lb-flag" title="Reports count this label as finished"><input type="checkbox" data-k="done"${l.done ? ' checked' : ''}>Done</label>
          <label class="lb-flag" title="Doors with this label are flagged Needs a look"><input type="checkbox" data-k="attn"${l.attn ? ' checked' : ''}>Needs a look</label>
          <button type="button" class="lb-b" data-act="up" aria-label="Move up"${i === 0 ? ' disabled' : ''}>▲</button><button type="button" class="lb-b" data-act="down" aria-label="Move down"${i === rows.length - 1 ? ' disabled' : ''}>▼</button><button type="button" class="lb-b del" data-act="del" aria-label="Delete this label">×</button></div>
          ${openPal === i ? `<div class="lb-pal">${paletteKeys.map(k => `<button type="button" data-act="col" data-c="${k}" style="background:${hexOf(cfg, k)}" aria-label="${k}"></button>`).join('')}</div>` : ''}`).join('')}
        <button type="button" class="btn" data-act="add">${icon('plus')}Add a label</button>`;
    };
    const res = await K.modal({
      title: `Labels for “${field.name}”`, ok: 'Save labels', wide: true,
      html: `<p>These are the choices in the dropdown. Doors keep their label if you rename or recolour it; deleting a label leaves those doors blank.</p><div id="lb"></div>`,
      mount: body => {
        draw(body);
        const host = $('#lb', body);
        host.addEventListener('input', e => { const row = e.target.closest('.lb-row'); if (!row) return; const l = rows[+row.dataset.i]; if (e.target.classList.contains('lb-name')) l.name = e.target.value; else if (e.target.dataset.k) l[e.target.dataset.k] = e.target.checked; });
        host.addEventListener('click', e => {
          const b = e.target.closest('[data-act]'); if (!b) return;
          const row = b.closest('.lb-row'), i = row ? +row.dataset.i : -1, act = b.dataset.act;
          if (act === 'sw') openPal = openPal === i ? -1 : i;
          else if (act === 'col') { rows[openPal].color = b.dataset.c; openPal = -1; }
          else if (act === 'up' && i > 0) { [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]; openPal = -1; }
          else if (act === 'down' && i < rows.length - 1) { [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]]; openPal = -1; }
          else if (act === 'del') { rows.splice(i, 1); openPal = -1; }
          else if (act === 'add') { rows.push({ name: '', color: paletteKeys[rows.length % paletteKeys.length], done: false, attn: false }); openPal = -1; }
          draw(body);
          if (act === 'add') { const ins = $$('.lb-name', body); ins[ins.length - 1].focus(); }
        });
      },
      collect: () => {
        if (rows.some(l => !l.name.trim())) { toast('Every label needs a name', true); return undefined; }
        return rows.map(l => ({ id: l.id, name: l.name.trim(), color: l.color, done: !!l.done, attn: !!l.attn }));
      },
    });
    if (!res) return false;
    try { await K.post('labels/save', { field: field.id, labels: res }); toast('Labels saved'); } catch (e) { toast(e.message, true); return false; }
    K.afterChange();
    return true;
  }

  // ---------- rework: what had to be fixed, where, and what it cost ----------
  async function reworkReport() {
    let r; try { r = await api('jobs/corrections?days=30'); } catch (e) { toast(e.message, true); return; }
    const hrs = m => (m >= 90 ? (m / 60).toFixed(1) + ' h' : m + ' min');
    const list = (rows, empty) => rows.length ? `<ul class="fix-list">${rows.map(x => `<li><b>${esc(x.name)}</b><span>${x.count} correction${x.count === 1 ? '' : 's'} · ${hrs(x.minutes)}</span></li>`).join('')}</ul>` : `<div class="dr-note">${empty}</div>`;
    await K.modal({
      title: 'Rework, last 30 days', ok: 'Close', noCancel: true, wide: true,
      html: r.total.count ? `<p><b>${r.total.count}</b> correction${r.total.count === 1 ? '' : 's'} on <b>${r.total.doors}</b> door${r.total.doors === 1 ? '' : 's'}, <b>${hrs(r.total.minutes)}</b> of fixing.</p>
        <h3 class="cz-h">By what was fixed</h3>${list(r.byReason)}<h3 class="cz-h">By station</h3>${list(r.byStation)}
        <h3 class="cz-h">Latest</h3><ul class="fix-list">${r.recent.map(c => `<li><b>${esc(c.number)} · ${esc(c.reason)}${c.minutes ? ' · ' + c.minutes + ' min' : ''}</b><span>${esc([c.station || c.dept, c.who].filter(Boolean).join(' · '))}${c.note ? ' · ' + esc(c.note) : ''}</span></li>`).join('')}</ul>`
        : '<div class="empty-note">Nothing has been logged yet. When something is fixed, tap “Log a correction” on the door or its station card.</div>',
    });
  }

  // ---------- admins: automations ----------
  const DO_LABEL = { set: 'Set a status', next: 'Move a status to its next label', comment: 'Add an update', archive: 'Archive the door' };
  /** A rule as a sentence, for the list. */
  function sayRule(r, cfg) {
    const f = id => (cfg.fields.find(x => x.id === id) || { name: '?', labels: [] });
    const l = (fid, id) => (f(fid).labels.find(x => x.id === id) || { name: '?' }).name;
    const when = r.when.kind === 'added' ? 'a door is added' : `${f(r.when.field).name} ${r.when.label === null ? 'changes' : 'becomes ' + l(r.when.field, r.when.label)}`;
    const cond = r.if.length ? ', and ' + r.if.map(c => (c.with && c.with.length ? `${[c.field, ...c.with].map(x => f(x).name).join(' and ')} ${c.not ? 'are not all finished' : 'are all finished'}` : `${f(c.field).name} ${MODE[modeOf(c)]}${c.test === 'finished' ? '' : ' ' + l(c.field, c.label)}`)).join(' and ') : '';
    const then = r.then.map(a => a.do === 'set' ? `set ${f(a.field).name} to ${a.label === null ? 'empty' : l(a.field, a.label)}` : a.do === 'next' ? `move ${f(a.field).name} on` : a.do === 'comment' ? 'add an update' : 'archive it').join(', ');
    return `When ${when}${cond}: ${then}.`;
  }
  async function editRules(cfg) {
    let rows = (cfg.rules || []).map(r => JSON.parse(JSON.stringify(r)));
    for (;;) {
      const status = cfg.fields.filter(f => f.kind === 'status');
      const fOpts = sel => status.map(f => `<option value="${f.id}"${f.id === sel ? ' selected' : ''}>${esc(f.name)}</option>`).join('');
      const lOpts = (fid, sel, any) => `${any ? `<option value=""${sel === null ? ' selected' : ''}>${any}</option>` : ''}${((status.find(f => f.id === fid) || { labels: [] }).labels).map(l => `<option value="${l.id}"${l.id === sel ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}`;
      const draw = body => {
        const keep = body.closest('.pk-body'), top = keep ? keep.scrollTop : 0;
        body.innerHTML = `${!status.length ? '<div class="empty-note">Rules work on status columns. Add one first (Customize, Your columns).</div>' : ''}
          ${rows.map((r, i) => `<div class="rl${r.enabled ? '' : ' off'}" data-i="${i}">
            <div class="rl-h"><input class="field" data-k="name" value="${esc(r.name)}" maxlength="60" aria-label="Rule name" placeholder="Name this rule"><label class="pk-check"><input type="checkbox" data-k="enabled"${r.enabled ? ' checked' : ''}> On</label>
              <button type="button" class="btn" data-act="up"${i === 0 ? ' disabled' : ''} aria-label="Move up">▲</button><button type="button" class="btn" data-act="down"${i === rows.length - 1 ? ' disabled' : ''} aria-label="Move down">▼</button><button type="button" class="btn danger" data-act="del">Delete</button></div>
            <div class="rl-s"><b>When</b><select data-k="wk"><option value="cell"${r.when.kind === 'cell' ? ' selected' : ''}>a status changes</option><option value="added"${r.when.kind === 'added' ? ' selected' : ''}>a door is added</option></select>
              ${r.when.kind === 'cell' ? `<select data-k="wf">${fOpts(r.when.field)}</select><span>becomes</span><select data-k="wl">${lOpts(r.when.field, r.when.label, 'anything')}</select>` : ''}</div>
            ${r.if.map((c, j) => `<div class="rl-s" data-j="${j}"><b>${j ? 'and' : 'If'}</b><select data-k="cf">${fOpts(c.field)}</select><select data-k="cn">${Object.keys(MODE).map(k => `<option value="${k}"${k === modeOf(c) ? ' selected' : ''}>${MODE[k]}</option>`).join('')}</select>${c.test === 'finished' ? '' : `<select data-k="cl">${lOpts(c.field, c.label)}</select>`}<button type="button" class="btn" data-act="rmif" aria-label="Remove condition">${icon('x')}</button></div>`).join('')}
            ${r.if.length < 3 ? '<div class="rl-s"><button type="button" class="link" data-act="addif">+ Only if…</button></div>' : ''}
            ${r.then.map((a, j) => `<div class="rl-s" data-j="${j}"><b>${j ? 'and' : 'Then'}</b><select data-k="do">${Object.keys(DO_LABEL).map(k => `<option value="${k}"${a.do === k ? ' selected' : ''}>${DO_LABEL[k]}</option>`).join('')}</select>
              ${a.do === 'set' ? `<select data-k="af">${fOpts(a.field)}</select><span>to</span><select data-k="al">${lOpts(a.field, a.label)}<option value="__clear"${a.label === null ? ' selected' : ''}>(empty)</option></select>` : ''}
              ${a.do === 'next' ? `<select data-k="af">${fOpts(a.field)}</select>` : ''}
              ${a.do === 'comment' ? `<input class="field" data-k="at" value="${esc(a.text || '')}" maxlength="200" placeholder="What the update says">` : ''}
              <button type="button" class="btn" data-act="rmthen" aria-label="Remove action"${r.then.length < 2 ? ' disabled' : ''}>${icon('x')}</button></div>`).join('')}
            ${r.then.length < 5 ? '<div class="rl-s"><button type="button" class="link" data-act="addthen">+ Also do…</button></div>' : ''}
            <div class="rl-say">${esc(sayRule(r, cfg))}</div></div>`).join('')}
          <button type="button" class="btn primary" data-act="add"${status.length ? '' : ' disabled'}>${icon('plus')}New rule</button>`;
        if (keep) keep.scrollTop = top;
      };
      const blank = () => { const f = status[0], l = f.labels[0]; return { name: 'New rule', enabled: true, when: { kind: 'cell', field: f.id, label: l ? l.id : null }, if: [], then: [{ do: 'set', field: f.id, label: l ? l.id : null }] }; };
      const firstLabel = fid => ((status.find(f => f.id === fid) || { labels: [] }).labels[0] || { id: null }).id;
      const wire = body => {
        draw(body);
        body.addEventListener('click', async e => {
          const b = e.target.closest('[data-act]'); if (!b) return;
          const rowEl = b.closest('.rl'), i = rowEl ? +rowEl.dataset.i : -1, r = rows[i], jEl = b.closest('[data-j]'), j = jEl ? +jEl.dataset.j : -1, a = b.dataset.act;
          if (a === 'add') rows.push(blank());
          else if (a === 'del') rows.splice(i, 1);
          else if (a === 'up') [rows[i - 1], rows[i]] = [rows[i], rows[i - 1]];
          else if (a === 'down') [rows[i + 1], rows[i]] = [rows[i], rows[i + 1]];
          else if (a === 'addif') { const f = status[0]; r.if.push({ field: f.id, test: 'label', label: firstLabel(f.id), not: false }); }
          else if (a === 'rmif') r.if.splice(j, 1);
          else if (a === 'addthen') { const f = status[0]; r.then.push({ do: 'set', field: f.id, label: firstLabel(f.id) }); }
          else if (a === 'rmthen') r.then.splice(j, 1);
          else return;
          draw(body);
        });
        body.addEventListener('input', e => { const t = e.target, el = t.closest('.rl'); if (!el) return; const r = rows[+el.dataset.i]; if (t.dataset.k === 'name') r.name = t.value; else if (t.dataset.k === 'at') r.then[+t.closest('[data-j]').dataset.j].text = t.value; });
        body.addEventListener('change', e => {
          const t = e.target, el = t.closest('.rl'); if (!el || t.tagName === 'BUTTON') return;
          const r = rows[+el.dataset.i], jEl = t.closest('[data-j]'), j = jEl ? +jEl.dataset.j : -1, k = t.dataset.k, v = t.value;
          if (k === 'enabled') r.enabled = t.checked;
          else if (k === 'wk') { if (v === 'added') r.when = { kind: 'added' }; else { const f = status[0]; r.when = { kind: 'cell', field: f.id, label: null }; } }
          else if (k === 'wf') r.when = { kind: 'cell', field: +v, label: null };
          else if (k === 'wl') r.when.label = v === '' ? null : +v;
          else if (k === 'cf') r.if[j] = fromMode(modeOf(r.if[j]), +v, firstLabel(+v), (r.if[j].with || []).filter(x => x !== +v));
          else if (k === 'cn') r.if[j] = fromMode(v, r.if[j].field, r.if[j].label !== undefined ? r.if[j].label : firstLabel(r.if[j].field), r.if[j].with);
          else if (k === 'cl') r.if[j].label = +v;
          else if (k === 'do') { const f = status[0]; r.then[j] = v === 'set' ? { do: 'set', field: f.id, label: firstLabel(f.id) } : v === 'next' ? { do: 'next', field: f.id } : v === 'comment' ? { do: 'comment', text: '' } : { do: 'archive' }; }
          else if (k === 'af') r.then[j] = r.then[j].do === 'set' ? { do: 'set', field: +v, label: firstLabel(+v) } : { do: 'next', field: +v };
          else if (k === 'al') r.then[j].label = v === '__clear' ? null : +v;
          draw(body);
        });
      };
      const res = await K.modal({ title: 'Automations', ok: 'Save', wide: true, html: '<div id="rl-body"></div>', mount: el => wire($('#rl-body', el)), collect: () => rows });
      if (!res) return false;
      try { await K.post('rules/save', { rules: res }); toast('Automations saved'); return true; } catch (err) { toast(err.message, true); rows = res; }          // keep what was typed and let them fix it
    }
  }

  // ---------- admins: customize the board ----------
  /** Tabs, the columns on each, the columns you have made, and the one switch for the guided steps. Every change applies at once. */
  const MODE = { is: 'is', isnot: 'is not', fin: 'is finished', unfin: 'is not finished' };
  const modeOf = c => (c.test === 'finished' ? (c.not ? 'unfin' : 'fin') : c.not ? 'isnot' : 'is');
  const fromMode = (m, field, label, more) => (m === 'fin' || m === 'unfin' ? { field, ...(more && more.length ? { with: more } : {}), test: 'finished', not: m === 'unfin' } : { field, test: 'label', label, not: m === 'isnot' });
  async function customize(startViewId) {
    if (!await K.ensureDept()) return;
    let cfg = await api('jobs/board'), viewId = startViewId, body = null;
    const act = async (ep, payload) => {
      try { await K.post(ep, payload); } catch (e) { toast(e.message, true); }
      cfg = await api('jobs/board'); draw();
    };
    const saveViews = (mutate) => {
      const list = cfg.views.map(v => ({ id: v.id, name: v.name, cols: [...v.cols] }));          // no filter sent: the server keeps each tab's own
      mutate(list);
      return act('views/save', { views: list });
    };
    const addable = view => {
      const have = new Set(view.cols), opt = (k, l) => (have.has(k) ? '' : `<option value="${esc(k)}">${esc(l)}</option>`);
      const builtin = Object.keys(BUILTIN).filter(k => k !== 'door' && (cfg.guided || !GUIDED_ONLY.includes(k))).map(k => opt(k, BUILTIN[k])).join('');
      const form = Object.keys(FORM).map(k => opt('f:' + k, FORM[k][0])).join('');
      const mine = cfg.fields.map(f => opt('#' + f.id, f.name)).join('');
      return `${builtin ? `<optgroup label="Built in">${builtin}</optgroup>` : ''}${mine ? `<optgroup label="Your columns">${mine}</optgroup>` : ''}${form ? `<optgroup label="Details from the order form">${form}</optgroup>` : ''}`;
    };
    const statusFields = () => cfg.fields.filter(f => f.kind === 'status');
    const filterRow = (c, i) => {
      const f = cfg.fields.find(x => x.id === c.field) || { labels: [] }, m = modeOf(c);
      return `<div class="rl-s" data-i="${i}"><select data-fk="field" aria-label="Column">${statusFields().map(x => `<option value="${x.id}"${x.id === c.field ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <select data-fk="mode" aria-label="Test">${Object.keys(MODE).map(k => `<option value="${k}"${k === m ? ' selected' : ''}>${MODE[k]}</option>`).join('')}</select>
        ${m === 'is' || m === 'isnot' ? `<select data-fk="label" aria-label="Label">${f.labels.map(l => `<option value="${l.id}"${l.id === c.label ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select>` : `${(c.with || []).map(w => `<span class="chip">${esc((cfg.fields.find(x => x.id === w) || { name: '?' }).name)}<button type="button" data-act="rmwith" data-i="${i}" data-w="${w}" aria-label="Remove">${icon('x')}</button></span>`).join('')}<select data-fk="with" aria-label="Also"><option value="">+ and also…</option>${statusFields().filter(x => x.id !== c.field && !(c.with || []).includes(x.id)).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>`}
        <button type="button" class="btn" data-act="rmfilter" data-i="${i}" aria-label="Remove condition">${icon('x')}</button></div>`;
    };
    function draw() {
      if (!body) return;
      const view = cfg.views.find(v => v.id === viewId) || cfg.views[0]; viewId = view.id;
      const keep = $('.pk-body', body.closest('dialog')); const top = keep ? keep.scrollTop : 0;
      body.innerHTML = `
        <h3 class="cz-h">Tabs</h3>
        <div class="cz-tabs">${cfg.views.length > 6
          ? `<select class="bd-select" id="cz-tabsel" aria-label="Which tab to edit">${cfg.views.map(v => `<option value="${v.id}"${v.id === view.id ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`
          : cfg.views.map(v => `<button type="button" class="cz-tab${v.id === view.id ? ' on' : ''}" data-act="tab" data-id="${v.id}">${esc(v.name)}</button>`).join('')}<button type="button" class="cz-tab add" data-act="newtab">+ New tab</button></div>
        <div class="cz-view">
          <div class="cz-name"><input class="field" id="cz-vname" value="${esc(view.name)}" maxlength="40" aria-label="Tab name"><button type="button" class="btn danger" data-act="deltab"${cfg.views.length < 2 ? ' disabled' : ''}>Delete this tab</button></div>
          <div class="pk-label">Which doors this tab shows</div>
          ${(view.filter || []).length ? '' : '<div class="dr-note">Every door. Add a condition to show only some, for example only doors whose Paint Prep is finished and Paint is not.</div>'}
          ${(view.filter || []).map((c, i) => filterRow(c, i)).join('')}
          <div class="rl-s"><button type="button" class="link" data-act="addfilter">+ Only doors where…</button></div>
          <div class="pk-label">Columns on this tab, left to right</div>
          ${view.cols.map((k, i) => `<div class="cz-col"><span>${esc(colLabel(k, cfg))}</span>${k === 'door' ? '<i>always first</i>' : `<span class="cz-b"><button type="button" data-act="mup" data-i="${i}" aria-label="Move left"${i <= 1 ? ' disabled' : ''}>▲</button><button type="button" data-act="mdown" data-i="${i}" aria-label="Move right"${i === view.cols.length - 1 ? ' disabled' : ''}>▼</button><button type="button" class="del" data-act="mrm" data-i="${i}" aria-label="Take off this tab">×</button></span>`}</div>`).join('')}
          <div class="cz-add"><select id="cz-addsel" aria-label="Add a column"><option value="">Add a column to this tab…</option>${addable(view)}</select><button type="button" class="btn" data-act="addcol">Add</button></div>
        </div>
        <h3 class="cz-h">Your columns</h3>
        <div class="dr-note">Status columns are dropdowns of coloured labels. Taking a column off a tab only hides it there; deleting it removes it and its values everywhere.</div>
        ${cfg.fields.map(f => `<div class="cz-field"><input class="field" data-act="rename" data-id="${f.id}" value="${esc(f.name)}" maxlength="40" aria-label="Column name"><span class="kind">${{ status: 'Status', date: 'Date', text: 'Text' }[f.kind]}</span>${f.kind === 'status' ? `<button type="button" class="btn" data-act="labels" data-id="${f.id}">Edit labels</button>` : '<span></span>'}<button type="button" class="btn danger" data-act="delfield" data-id="${f.id}" data-name="${esc(f.name)}">Delete</button></div>`).join('') || '<div class="dr-note">No columns yet.</div>'}
        <div class="cz-field new"><input class="field" id="cz-newname" placeholder="New column name" maxlength="40"><select id="cz-newkind" aria-label="Kind of column"><option value="status">Status (dropdown)</option><option value="date">Date</option><option value="text">Text</option></select><button type="button" class="btn primary" data-act="addfield">Add column</button></div>
        <h3 class="cz-h">Automations</h3>
        <div class="dr-note">Tabs already pull a door in when the steps before it are done. Rules do the rest: set a status, add an update, or take a door off the board when something happens.</div>
        <button type="button" class="btn" data-act="template">Set up the door shop flow</button>
        <button type="button" class="btn" data-act="rules">${icon('gear')}Automations (${(cfg.rules || []).length})</button>
        <h3 class="cz-h">Guided steps</h3>
        <label class="pk-check"><input type="checkbox" id="cz-guided"${cfg.guided ? ' checked' : ''}> Turn on guided steps (My work, the parts checklist, sending a door back for repair)</label>
        <div class="dr-note">Optional. Off is the normal way to run the board: everyone just sets the status columns.</div>`;
      const sc = $('.pk-body', body.closest('dialog')); if (sc) sc.scrollTop = top;
    }
    const onClick = async e => {
      const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT') return;
      const view = cfg.views.find(v => v.id === viewId) || cfg.views[0], i = +b.dataset.i, a = b.dataset.act;
      if (a === 'tab') { viewId = +b.dataset.id; draw(); }
      else if (a === 'newtab') { await saveViews(l => l.push({ name: 'New tab', cols: ['door', 'ship', 'customer', 'notes'] })); viewId = cfg.views[cfg.views.length - 1].id; draw(); }
      else if (a === 'deltab') { if (await window.Portal.ask({ title: `Delete the “${view.name}” tab?`, text: 'Only the tab goes. The doors and their values stay.', ok: 'Delete', danger: true })) { await saveViews(l => l.splice(l.findIndex(v => v.id === view.id), 1)); viewId = cfg.views[0].id; draw(); } }
      else if (a === 'mup') saveViews(l => { const c = l.find(v => v.id === view.id).cols; [c[i - 1], c[i]] = [c[i], c[i - 1]]; });
      else if (a === 'mdown') saveViews(l => { const c = l.find(v => v.id === view.id).cols; [c[i + 1], c[i]] = [c[i], c[i + 1]]; });
      else if (a === 'mrm') saveViews(l => { l.find(v => v.id === view.id).cols.splice(i, 1); });
      else if (a === 'addcol') { const v = $('#cz-addsel', body).value; if (v) saveViews(l => l.find(x => x.id === view.id).cols.push(v)); }
      else if (a === 'addfilter') { const f = statusFields()[0]; if (!f) { toast('Add a status column first', true); return; } saveViews(l => { const v = l.find(x => x.id === view.id); v.filter = [...(view.filter || []), fromMode('fin', f.id)]; }); }
      else if (a === 'rmwith') saveViews(l => { l.find(x => x.id === view.id).filter = (view.filter || []).map((c, k) => (k === i ? { ...c, with: (c.with || []).filter(x => x !== +b.dataset.w) } : c)); });
      else if (a === 'rmfilter') saveViews(l => { l.find(x => x.id === view.id).filter = (view.filter || []).filter((_, k) => k !== i); });
      else if (a === 'template') {
        if (!await window.Portal.ask({ title: 'Set up the door shop flow?', text: 'Adds a status column for each step (cutting, CNC, filling, panel received, verification, paint prep, paint, assembly, wrapping, QC, shipping), a tab for each station that shows a door once the steps before it are done, and a rule that takes shipped doors off the board. Doors then say which parts they need (frame, panel, rail & stile). Your existing columns stay; CNC Frame and CNC Panel only get an extra “Not needed” label.', ok: 'Set it up' })) return;
        try { const r = await K.post('template', {}); toast(`Added ${r.columns.length} columns, ${r.tabs.length} tabs and ${r.rules.length} rules`); } catch (err) { toast(err.message, true); }
        cfg = await api('jobs/board'); draw();
      }
      else if (a === 'rules') { await editRules(cfg); cfg = await api('jobs/board'); draw(); }
      else if (a === 'labels') { const f = cfg.fields.find(x => String(x.id) === b.dataset.id); if (await editLabels(f, cfg)) { cfg = await api('jobs/board'); draw(); } }
      else if (a === 'delfield') { if (await window.Portal.ask({ title: `Delete “${b.dataset.name}”?`, text: 'The column and every door’s value in it are removed. This cannot be undone.', ok: 'Delete column', danger: true })) act('field/delete', { id: b.dataset.id }); }
      else if (a === 'addfield') { const n = $('#cz-newname', body).value.trim(); if (!n) { toast('Give the column a name', true); return; } act('field/add', { name: n, kind: $('#cz-newkind', body).value }); }
    };
    const onChange = e => {
      const t = e.target;
      if (t.id === 'cz-tabsel') { viewId = +t.value; draw(); return; }
      if (t.dataset.fk) {
        const view = cfg.views.find(v => v.id === viewId), i = +t.closest('[data-i]').dataset.i, row = t.closest('[data-i]'), g = k => $(`[data-fk="${k}"]`, row);
        const field = +g('field').value, f = cfg.fields.find(x => x.id === field), m = g('mode').value;
        const old = (view.filter || [])[i] || {}, more = t.dataset.fk === 'with' ? (t.value ? [...(old.with || []), +t.value] : old.with || []) : (old.with || []).filter(x => x !== field);
        const label = t.dataset.fk === 'label' ? +t.value : t.dataset.fk === 'field' ? (f.labels[0] || {}).id : (g('label') ? +g('label').value : (f.labels[0] || {}).id);
        saveViews(l => { l.find(x => x.id === view.id).filter = (view.filter || []).map((c, k) => (k === i ? fromMode(m, field, label, more) : c)); });
        return;
      }
      if (t.id === 'cz-vname') { const view = cfg.views.find(v => v.id === viewId); const n = t.value.trim(); if (n && n !== view.name) saveViews(l => { l.find(v => v.id === view.id).name = n; }); else t.value = view.name; }
      else if (t.dataset.act === 'rename') { const f = cfg.fields.find(x => String(x.id) === t.dataset.id), n = t.value.trim(); if (n && n !== f.name) act('field/rename', { id: f.id, name: n }); else t.value = f.name; }
      else if (t.id === 'cz-guided') act('settings', { guided: t.checked }).then(() => K.resetMeta());
    };
    await K.modal({
      title: 'Customize the board', ok: 'Done', noCancel: true, wide: true, html: '<div id="cz"></div>',
      mount: el => { body = $('#cz', el); draw(); body.addEventListener('click', onClick); body.addEventListener('change', onChange); },
    });
    S.boardSnap = ''; S.workSnap = ''; loadBoard(true).catch(() => { });
  }
})();
