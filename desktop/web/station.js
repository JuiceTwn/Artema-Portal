(() => {
  // Station: the floor's view. A computer remembers the station (or stations) it works at and opens straight to that queue: big cards in
  // ship-date order, the first marked "next up", one-tap Done, two-tap Stuck. Nothing else is on screen. Switching is one small button.
  // On such a computer the menu is trimmed to Home and Station, with the rest behind "More". Office computers see everything as before.
  // It only uses the Board's own calls, so it needs nothing new on the server.
  const { $, $$, esc, icon, api, toast, S, views } = window.Portal;
  const K = window.Portal.jobs.kit;
  const hexOf = (cfg, key) => (cfg.palette && cfg.palette[key]) || '#7e8499';
  const STUCK_WHY = ['Waiting on a part', 'Defect', 'Unclear drawing or order', 'Machine down', 'Other'];
  /** The department a station records its changes under, when this computer has not chosen one (the portal's departments are fixed). */
  const DEPT_FOR = [[/rail & stile \(cliff\)/i, 'Rail & Stile'], [/cutting|cnc|frame filling|verification/i, 'Frame Prep'], [/paint/i, 'Paint'], [/assembly|wrapping|qc/i, 'Assembly'], [/shipping/i, 'Shipping'], [/panel/i, 'Office']];

  const textFields = (view, cfg) => view.cols.filter(k => k[0] === '#').map(k => cfg.fields.find(f => '#' + f.id === k)).filter(f => f && f.kind === 'text');
  const labelOf = (f, d) => { const c = d.cells[f.id]; return c && c.label != null ? f.labels.find(l => l.id === c.label) || null : null; };
  const stationFields = (view, cfg) => view.cols.filter(k => k[0] === '#').map(k => cfg.fields.find(f => '#' + f.id === k)).filter(f => f && f.kind === 'status');
  /** A tab's work on a door is finished when every status column in the tab holds a "counts as done" label. */
  const finished = (d, fields) => fields.length > 0 && fields.every(f => (labelOf(f, d) || {}).done);
  const stuck = (d, fields) => fields.some(f => (labelOf(f, d) || {}).attn);
  /** The doors waiting at one tab (station). */
  const waiting = (view, cfg) => { const fields = stationFields(view, cfg); return cfg.doors.filter(d => K.atTab(d, view, cfg) && !finished(d, fields)); };

  // ---------- which stations does this computer work at? ----------
  const KEY = 'artema.stations';
  const local = () => { try { const a = JSON.parse(K.store.get(KEY) || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
  /** Stations an admin assigned to this computer (Computers screen). They win over what was picked here, and a Switch only lasts until the page is reopened. */
  const assigned = () => ((S.me && S.me.stations) || []).map(String);
  const mine = () => (S.stationTemp && S.stationTemp.length ? S.stationTemp : assigned().length ? assigned() : local());
  const remember = ids => { K.store.set(KEY, JSON.stringify(ids)); K.store.set('artema.seen.st', ''); applySimple(); };
  /** On a computer with stations the menu is just Home and Station; everything else is behind "More". */
  function applySimple() {
    document.body.classList.toggle('simple', mine().length > 0);
    const t = $('#more-toggle'); if (t) t.setAttribute('aria-expanded', document.body.classList.contains('more'));
  }
  applySimple();
  const oldStart = window.Portal.jobs.startView;
  window.Portal.jobs.startView = () => { applySimple(); return mine().length ? 'station' : oldStart(); };
  const more = $('#more-toggle'); if (more) more.onclick = () => { document.body.classList.toggle('more'); applySimple(); };

  const seenIds = doors => {
    const raw = K.store.get('artema.seen.st');
    if (!raw) { K.store.set('artema.seen.st', JSON.stringify(doors.map(d => d.id))); return new Set(doors.map(d => d.id)); }          // first look: nothing is "new"
    try { return new Set(JSON.parse(raw)); } catch { return new Set(); }
  };
  const markSeen = id => { let s; try { s = new Set(JSON.parse(K.store.get('artema.seen.st') || '[]')); } catch { s = new Set(); } s.add(Number(id)); K.store.set('artema.seen.st', JSON.stringify([...s])); };

  async function load(force) {
    if (!force && (document.querySelector('dialog.pick[open]') || $('#pop'))) return;
    try { S.me = await api('me'); } catch { /* keep what we know */ }          // an admin may have just assigned this computer
    applySimple();
    const cfg = await api('jobs/board');
    K.applyGuided(cfg.guided);
    const snap = JSON.stringify([cfg, mine(), S.stationPicking, S.stationShowDone]);
    if (!force && snap === S.stationSnap) return;
    S.stationSnap = snap; S.cfg = cfg;
    const known = new Set(cfg.views.map(v => String(v.id)));
    const chosen = mine().filter(id => known.has(id));
    if (!chosen.length || S.stationPicking) renderPicker(cfg, chosen); else render(cfg, cfg.views.filter(v => chosen.includes(String(v.id))));
  }
  views.station = load;
  const redraw = () => { S.stationSnap = ''; load(true).catch(e => toast(e.message, true)); };

  // ---------- choosing stations ----------
  function renderPicker(cfg, chosen) {
    const pick = new Set(chosen);
    const opts = cfg.views.filter(v => stationFields(v, cfg).length);          // a tab with no status columns is not a place anyone works
    const host = $('#station');
    const draw = () => {
      host.innerHTML = `<div class="st-pick"><h1>Where are you working?</h1><div class="st-sub">${assigned().length ? 'Tap the station you are covering. This is just for now: when this computer is reopened it goes back to the one an admin gave it.' : 'Tap your station. If you do more than one, tap them all. This computer remembers it, and you will see only that.'}</div>
        <div class="st-grid">${opts.map(v => { const n = waiting(v, cfg).length; return `<button class="st-opt${pick.has(String(v.id)) ? ' on' : ''}" data-v="${v.id}"><b>${esc(v.name)}</b><span>${n ? n + ' waiting' : 'nothing waiting'}</span></button>`; }).join('')}</div>
        ${opts.length ? '' : '<div class="empty-note">No stations yet. An admin sets them up from the Board (Customize).</div>'}
        <div class="st-pick-foot"><button class="btn primary big" id="st-go"${pick.size ? '' : ' disabled'}>${icon('check')}Use ${pick.size > 1 ? 'these stations' : 'this station'}</button>
          ${chosen.length ? '<button class="link" id="st-cancel">Never mind</button>' : ''}${assigned().length ? '' : '<button class="link" id="st-office">I\'m in the office: show me everything</button>'}</div></div>`;
      $$('#station [data-v]').forEach(b => b.onclick = () => { const k = b.dataset.v; pick.has(k) ? pick.delete(k) : pick.add(k); draw(); });
      $('#st-go').onclick = () => {
        if (assigned().length) S.stationTemp = [...pick]; else remember([...pick]);
        if (!K.myDept()) { const names = opts.filter(v => pick.has(String(v.id))).map(v => v.name).join(' '); const hit = DEPT_FOR.find(([re]) => re.test(names)); if (hit) K.store.set('artema.jobdept', hit[1]); }          // one less question on a shared computer
        S.stationPicking = false; redraw();
      };
      if ($('#st-cancel')) $('#st-cancel').onclick = () => { S.stationPicking = false; redraw(); };
      if ($('#st-office')) $('#st-office').onclick = () => { remember([]); S.stationPicking = false; window.Portal.setView('board'); };
    };
    draw();
  }

  // ---------- admins: give a computer its stations (Computers screen) ----------
  /** Opens a picker of stations for one computer and saves the choice. Resolves to true when something was saved. */
  async function assignStations({ id, name, current, choices }) {
    const pick = new Set(current.map(String));
    const res = await K.modal({
      title: `Where does ${name} work?`, ok: 'Save', wide: true,
      html: '<div id="as-body"></div>',
      mount: el => {
        const host = $('#as-body', el);
        const draw = () => {
          host.innerHTML = `<p>It will open on these stations and show only them. Leave all off to let whoever uses it choose.</p>
            <div class="st-grid">${choices.map(c => `<button type="button" class="st-opt${pick.has(String(c.id)) ? ' on' : ''}" data-v="${c.id}"><b>${esc(c.name)}</b></button>`).join('')}</div>`;
          $$('[data-v]', host).forEach(b => b.onclick = () => { const k = b.dataset.v; pick.has(k) ? pick.delete(k) : pick.add(k); draw(); });
        };
        draw();
      },
      collect: () => [...pick].map(Number),
    });
    if (!res) return false;
    try { await api('devices/stations', { id, stations: res }); toast(res.length ? `${name} now opens on ${res.map(i => (choices.find(c => c.id === i) || {}).name).join(', ')}` : `${name} has no station`); return true; } catch (e) { toast(e.message, true); return false; }
  }
  window.Portal.jobs.assignStations = assignStations;

  // ---------- the order form's parts: what to cut, and what has been done to each ----------
  /** What the expanded card tells you about the order, in the order a person reads it. */
  const DETAIL_KEYS = ['frameOptions', 'size', 'series', 'ptype', 'swing', 'hinges', 'prepping', 'frame', 'jamb', 'sill', 'brickmold', 'extFinish', 'intFinish', 'frameOut', 'frameIn', 'paintFormula', 'glass', 'handle', 'hardware', 'po', 'orderNo'];
  const STAGE_SHORT = { cut: 'Cut', prep: 'Prep', filled: 'Filled', paintprep: 'Paint prep', painted: 'Painted', quality: 'Quality' };
  /** Same spelling rules as the server, so a part is found whichever way it was typed. */
  const partKey = name => String(name || '').toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim().slice(0, 80);
  function partsHtml(r, info) {
    if (!r.sections || !r.sections.length) return `<div class="faint">${esc(r.note || 'No parts found on the order form.')}</div>`;
    return `<div class="pt-head">Parts and sizes <span>tap a part to see what it looks like and where it is</span></div>` + r.sections.map(sec => `<div class="pt-sec"><h4>${esc(sec.title || 'Parts')}</h4>${sec.parts.map(p => {
      const pi = info[partKey(p.name.replace(/ \([^)]*\)$/, ''))] || info[partKey(p.name)];
      return `<button class="pt-row" data-part="${esc(p.name.replace(/ \([^)]*\)$/, ''))}"><span class="pt-n">${esc(p.name)}${pi && pi.image ? '<em class="pt-ph" title="Has a picture">▣</em>' : ''}${pi && pi.location ? `<small>${esc(pi.location)}</small>` : ''}</span><span class="pt-l">${esc(p.length || '')}</span><span class="pt-q">× ${p.qty}</span><span class="pt-p" title="Paint numbers">${p.paint ? '#' + esc(p.paint) : ''}</span>
        <span class="pt-d">${Object.keys(sec.parts[0].done).filter(k => k !== 'quality').map(k => `<i class="${p.done[k] ? 'on' : ''}">${esc(STAGE_SHORT[k] || k)}</i>`).join('')}</span></button>`;
    }).join('')}</div>`).join('');
  }

  // ---------- what a component looks like, and where it is kept ----------
  const canEditParts = () => !!(S.me && S.me.partsEdit);
  /** A picture the office chose, shrunk to a small JPEG so it stays light to store and quick to show. */
  function shrink(file, max = 900) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        let q = 0.85, out = c.toDataURL('image/jpeg', q);
        while (out.length > 520000 && q > 0.4) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
        out.length > 580000 ? rej(new Error('That picture is too big. Try a smaller one.')) : res(out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That file is not a picture')); };
      img.src = url;
    });
  }
  /** The popup for one component: its picture and where it is. Admins and the office can change both from here. */
  async function partDialog(name) {
    let info; try { info = await api('jobs/partinfo?name=' + encodeURIComponent(name)); } catch (e) { toast(e.message, true); return; }
    const edit = canEditParts();
    const again = await K.modal({
      title: name, ok: edit ? 'Edit' : 'Close', noCancel: !edit, wide: true,
      html: `<div class="pi-view">${info.image ? `<img class="pi-img" src="${esc(info.image)}" alt="${esc(name)}">` : `<div class="pi-none">No picture yet${edit ? '. Tap Edit to add one.' : ''}</div>`}
        <div class="pi-where"><i>Where it is</i><b>${info.location ? esc(info.location) : '<span class="faint">Not set</span>'}</b></div>
        ${info.updated_at ? `<div class="faint pi-by">Updated ${esc(window.Portal.ago(info.updated_at).toLowerCase())}${info.updated_by ? ' by ' + esc(info.updated_by) : ''}</div>` : ''}</div>`,
      collect: () => true,
    });
    if (again && edit) await editPartInfo(name, info);
  }
  async function editPartInfo(name, info) {
    let image;          // undefined keeps the current one, '' removes it
    const res = await K.modal({
      title: `${name}: picture and place`, ok: 'Save', wide: true,
      html: `<div class="pk-label">Where is it kept?</div><input class="field" id="pi-loc" maxlength="120" placeholder="Rack 3, shelf B" value="${esc(info.location || '')}" autocomplete="off">
        <div class="pk-label">Picture</div><div class="pi-edit"><div id="pi-prev">${info.image ? `<img class="pi-img" src="${esc(info.image)}" alt="">` : '<div class="pi-none">No picture</div>'}</div>
        <div class="pi-btns"><label class="btn">Choose a picture<input type="file" id="pi-file" accept="image/*" hidden></label><span class="faint">or paste one (Ctrl+V)</span>${info.image ? '<button type="button" class="btn danger" id="pi-rm">Remove picture</button>' : ''}</div></div>`,
      mount: el => {
        const show = url => { $('#pi-prev', el).innerHTML = url ? `<img class="pi-img" src="${url}" alt="">` : '<div class="pi-none">No picture</div>'; };
        const take = async f => { try { image = await shrink(f); show(image); } catch (e) { toast(e.message, true); } };
        $('#pi-file', el).onchange = e => { if (e.target.files[0]) take(e.target.files[0]); };
        const rm = $('#pi-rm', el); if (rm) rm.onclick = () => { image = ''; show(''); };
        el.closest('dialog').addEventListener('paste', e => { const f = [...(e.clipboardData && e.clipboardData.files || [])].find(x => x.type.startsWith('image/')); if (f) { e.preventDefault(); take(f); } });
      },
      collect: el => ({ location: $('#pi-loc', el).value.trim() }),
    });
    if (!res) return;
    try { await K.post('partinfo/save', { name, location: res.location, ...(image !== undefined ? { image } : {}) }); S.partInfoMap = null; toast(`${name}: saved`); S.stationSnap = ''; redraw(); } catch (e) { toast(e.message, true); }
  }

  // ---------- the queue ----------
  function render(cfg, chosen) {
    const host = $('#station');
    S.stationOpen = S.stationOpen || new Set();
    const byDoor = new Map();
    for (const v of chosen) for (const d of waiting(v, cfg)) { const e = byDoor.get(d.id) || { d, tabs: [], fields: [], texts: [] }; e.tabs.push(v); for (const f of stationFields(v, cfg)) if (!e.fields.includes(f)) e.fields.push(f); for (const f of textFields(v, cfg)) if (!e.texts.includes(f)) e.texts.push(f); byDoor.set(d.id, e); }
    const key = d => (d.shipDate && /^\d{4}-\d{2}-\d{2}$/.test(d.shipDate) ? d.shipDate : '9999');
    const paints = chosen.some(v => v.cols.some(k => ['f:extFinish', 'f:intFinish', 'f:frameOut', 'f:frameIn'].includes(k)));
    const byColour = paints && K.store.get('artema.st.colour') === '1';
    /** What a door is painted: the colours on its order form, so doors with the same colours can be done together (fewer changeovers). */
    const colourOf = d => { const f = d.form || {}; return [...new Set([f.extFinish, f.intFinish, f.frameOut, f.frameIn].filter(Boolean))].join(' / ') || 'No colour on the order form'; };
    const open = [...byDoor.values()].sort((a, b) => (byColour ? colourOf(a.d).localeCompare(colourOf(b.d)) : 0) || key(a.d).localeCompare(key(b.d)) || K.nat(a.d.number, b.d.number));
    const seen = seenIds(open.map(e => e.d)), att = open.filter(e => stuck(e.d, e.fields)).length;
    const doneDoors = chosen.flatMap(v => cfg.doors.filter(d => K.atTab(d, v, cfg) && finished(d, stationFields(v, cfg))));

    const card = (e, i) => {
      const { d, fields } = e, due = K.due(d.shipDate), isNew = !seen.has(d.id);
      const rows = fields.map(f => {
        const l = labelOf(f, d), hex = l ? hexOf(cfg, l.color) : '';
        const doneLabel = f.labels.find(x => x.done), isDone = l && l.done;
        return `<div class="st-row"><span class="st-fn">${esc(f.name)}</span>
          <button class="st-cur${l ? '' : ' blank'}" data-pick="${f.id}"${l ? ` style="background:${hex};color:${K.inkOn(hex)}"` : ''}>${esc(l ? l.name : 'Not started')}</button>
          ${doneLabel && !isDone ? `<button class="st-done" data-done="${f.id}" data-label="${doneLabel.id}">${icon('check')}${esc(doneLabel.name)}</button>` : isDone ? `<span class="st-ok">${icon('check')}</span>` : ''}</div>`;
      }).join('');
      const trows = (e.texts || []).map(f => { const v = (d.cells[f.id] || {}).value || ''; return `<div class="st-row"><span class="st-fn">${esc(f.name)}</span><button class="st-cur st-text${v ? '' : ' blank'}" data-pick="${f.id}">${esc(v || 'Set')}</button></div>`; }).join('');
      const cart = (e.texts || []).map(f => (d.cells[f.id] || {}).value).find(Boolean);
      const details = DETAIL_KEYS.map(k => { const fm = K.FORM && K.FORM[k]; const v = fm && d.form ? fm[1](d.form) : ''; return v ? `<span><i>${esc(fm[0])}</i>${esc(v)}</span>` : ''; }).join('');
      const open = S.stationOpen.has(String(d.id));
      return `<article class="st-card${i === 0 ? ' first' : ''}${stuck(d, fields) ? ' stuck' : ''}${open ? ' open' : ''}" data-id="${d.id}">
        <div class="st-top" role="button" tabindex="0" aria-expanded="${open}" title="Tap to see the order, notes and parts">${i === 0 ? '<span class="st-next">NEXT UP</span>' : ''}${isNew ? '<span class="st-new">NEW</span>' : ''}
          <b class="st-num">${esc(d.number)}</b><span class="st-cust">${esc(d.customer || '')}</span>
          ${d.form && d.form.orderNotes ? `<span class="st-badge" title="This order has notes">${icon('alert')}Notes</span>` : ''}${cart ? `<span class="st-badge cart">Cart ${esc(cart)}</span>` : ''}
          <span class="due ${due.cls}">${esc(K.dueText(d.shipDate))}</span><span class="st-chev" aria-hidden="true"></span></div>
        <div class="st-rows">${rows || '<div class="faint">This station has no status column. Ask an admin to add one.</div>'}</div>
        <div class="st-foot"><button class="st-stuck" data-stuck="${d.id}">${icon('alert')}Stuck</button></div>
        <div class="st-detail">
          ${details ? `<div class="st-info">${details}</div>` : ''}
          ${d.form && d.form.orderNotes ? `<div class="st-onotes"><i>From the order form</i>${esc(d.form.orderNotes)}</div>` : ''}
          ${d.notes ? `<div class="st-note">${esc(d.notes)}</div>` : ''}
          ${trows ? `<div class="st-rows">${trows}</div>` : ''}
          <div class="st-parts" id="parts-${d.id}"></div>
          <div class="st-links"><button class="link" data-fix="${d.id}">Log a correction</button><button class="link" data-open="${d.id}">Everything about this door</button></div>
        </div>
      </article>`;
    };
    const doneList = S.stationShowDone ? doneDoors.map(d => `<span class="st-chip">${esc(d.number)}</span>`).join('') : '';
    host.innerHTML = `<div class="st-head"><div><h1>${esc(chosen.map(v => v.name).join(' + '))}</h1>
        <div class="st-sum">${open.length ? `${open.length} to do` : 'Nothing waiting'}${att ? ` · <b class="red">${att} stuck</b>` : ''}</div></div>
        <span class="grow"></span>${paints ? `<button class="st-switch${byColour ? ' on' : ''}" id="st-colour" aria-pressed="${byColour}">Group by colour</button>` : ''}<button class="st-switch" id="st-switch">${icon('swap')}Switch</button></div>
      ${open.length ? `<div class="st-list">${open.map((e, i) => (byColour && (i === 0 || colourOf(open[i - 1].d) !== colourOf(e.d)) ? `<div class="st-group"><b>${esc(colourOf(e.d))}</b><span>${open.filter(x => colourOf(x.d) === colourOf(e.d)).length} door${open.filter(x => colourOf(x.d) === colourOf(e.d)).length === 1 ? '' : 's'}</span></div>` : '') + card(e, i)).join('')}</div>`
        : `<div class="empty"><div class="ring">${icon('check')}</div><h3>You're all caught up</h3><div>New doors show up here by themselves.</div></div>`}
      ${doneDoors.length ? `<button class="link st-donebtn" id="st-done">${S.stationShowDone ? 'Hide' : 'Show'} ${doneDoors.length} finished door${doneDoors.length === 1 ? '' : 's'}</button>${doneList ? `<div class="st-chips">${doneList}</div>` : ''}` : ''}`;

    $('#st-switch').onclick = () => { S.stationPicking = true; redraw(); };
    if ($('#st-colour')) $('#st-colour').onclick = () => { K.store.set('artema.st.colour', byColour ? '0' : '1'); redraw(); };
    const stationName = chosen.map(v => v.name).join(' + ');
    $$('#station [data-fix]').forEach(b => b.onclick = () => { const d = byDoor.get(Number(b.dataset.fix)).d; markSeen(d.id); K.logCorrection(d, stationName); });
    // a card is compact; tapping its top opens it in place into the full description
    const loadParts = async id => {
      const host = $('#parts-' + id); if (!host || host.dataset.loaded === '1') return;
      host.innerHTML = '<div class="faint">Reading the order form…</div>';
      try {
        if (!S.partInfoMap) { S.partInfoMap = {}; for (const x of (await api('jobs/partinfo/list')).items) S.partInfoMap[x.key] = x; }
        host.innerHTML = partsHtml(await api('jobs/parts?id=' + id), S.partInfoMap); host.dataset.loaded = '1';
        $$('[data-part]', host).forEach(b => b.onclick = () => partDialog(b.dataset.part));
      } catch (e) { host.innerHTML = `<div class="faint">${esc(e.message)}</div>`; }
    };
    const toggle = card => {
      const id = card.dataset.id, on = !card.classList.contains('open');
      card.classList.toggle('open', on); $('.st-top', card).setAttribute('aria-expanded', on);
      on ? S.stationOpen.add(id) : S.stationOpen.delete(id);
      if (on) { markSeen(id); loadParts(id); }
    };
    $$('#station .st-card').forEach(card => {
      const top = $('.st-top', card);
      top.onclick = e => { if (!e.target.closest('button')) toggle(card); };
      top.onkeydown = e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === top) { e.preventDefault(); toggle(card); } };
      if (S.stationOpen.has(card.dataset.id)) loadParts(card.dataset.id);
    });
    $$('#station [data-open]').forEach(b => b.onclick = () => { markSeen(b.dataset.open); K.openDoor(b.dataset.open); });
    $$('#station [data-pick]').forEach(b => b.onclick = () => {
      const id = b.closest('.st-card').dataset.id; markSeen(id);
      const f = cfg.fields.find(x => String(x.id) === b.dataset.pick), d = door(id);
      if (d && f) K.editCell(b, d, f, cfg);
    });
    $$('#station [data-done]').forEach(b => b.onclick = () => setLabel(b, door(b.closest('.st-card').dataset.id), cfg.fields.find(x => String(x.id) === b.dataset.done), Number(b.dataset.label), cfg));
    $$('#station [data-stuck]').forEach(b => b.onclick = () => { const e = byDoor.get(Number(b.dataset.stuck)); flagStuck(e.d, e.fields); });
  }

  /** One tap: set the status to its "done" label. If a rule then moves the door on, say so; Undo takes back both. */
  async function setLabel(btn, d, f, labelId, cfg) {
    if (!d || !f) return;
    const before = d.cells[f.id] && d.cells[f.id].label != null ? d.cells[f.id].label : null;
    markSeen(d.id);
    await K.act(btn, async () => {
      const res = await K.post('cell', { id: d.id, field: f.id, value: labelId }), auto = (res && res.auto) || [];
      const name = (fid, lid) => { const fl = cfg.fields.find(x => x.id === fid); const l = fl && fl.labels.find(x => x.id === lid); return l ? l.name : ''; };
      const moved = auto.filter(a => a.after !== null).map(a => `${a.name}: ${name(a.field, a.after)}`);
      K.undoToast(`${d.number}: ${f.name} done${moved.length ? ' · ' + moved.join(', ') : ''}`, async () => {
        await K.post('cells', { changes: [{ id: d.id, field: f.id, value: before }, ...auto.map(a => ({ id: a.door, field: a.field, value: a.before }))] });
        K.afterChange();
      });
    });
  }

  /** Two taps: pick why, and the door is marked Stuck with the reason left as an update for the office. */
  async function flagStuck(d, fields) {
    if (!d) return;
    const f = fields.find(x => !(labelOf(x, d) || {}).done && x.labels.some(l => l.attn)) || fields.find(x => x.labels.some(l => l.attn));
    const res = await K.modal({
      title: `${d.number} is stuck`, ok: 'Tell the office',
      html: `<p>Pick what's wrong. The office will see it on the Board right away.</p>${K.choiceHtml('why', STUCK_WHY.map(r => [r, r]), '')}<input class="field" id="stk-more" placeholder="Anything else? (optional)" autocomplete="off" maxlength="200">`,
      mount: K.wireChoices,
      collect: el => { const why = K.chosen(el, 'why'), more = $('#stk-more', el).value.trim(); if (!why && !more) { toast('Pick what is wrong', true); return undefined; } return [why, more].filter(Boolean).join(': '); },
    });
    if (!res) return;
    markSeen(d.id);
    await K.act(null, async () => {
      if (f) await K.post('cell', { id: d.id, field: f.id, value: f.labels.find(l => l.attn).id });
      await K.post('comment', { id: d.id, text: 'Stuck: ' + res });
      toast(`${d.number}: the office has been told`);
    });
  }
})();
