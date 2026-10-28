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

  // ---------- the queue ----------
  function render(cfg, chosen) {
    const host = $('#station');
    const byDoor = new Map();
    for (const v of chosen) for (const d of waiting(v, cfg)) { const e = byDoor.get(d.id) || { d, tabs: [], fields: [] }; e.tabs.push(v); for (const f of stationFields(v, cfg)) if (!e.fields.includes(f)) e.fields.push(f); byDoor.set(d.id, e); }
    const key = d => (d.shipDate && /^\d{4}-\d{2}-\d{2}$/.test(d.shipDate) ? d.shipDate : '9999');
    const open = [...byDoor.values()].sort((a, b) => key(a.d).localeCompare(key(b.d)) || K.nat(a.d.number, b.d.number));
    const seen = seenIds(open.map(e => e.d)), att = open.filter(e => stuck(e.d, e.fields)).length;
    const forms = [...new Set(chosen.flatMap(v => v.cols.filter(k => k.startsWith('f:'))))].map(k => K.FORM && K.FORM[k.slice(2)]).filter(Boolean).slice(0, 3);
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
      const info = forms.map(([name, fn]) => { const v = d.form ? fn(d.form) : ''; return v ? `<span><i>${esc(name)}</i>${esc(v)}</span>` : ''; }).join('');
      return `<article class="st-card${i === 0 ? ' first' : ''}${stuck(d, fields) ? ' stuck' : ''}" data-id="${d.id}">
        <div class="st-top">${i === 0 ? '<span class="st-next">NEXT UP</span>' : ''}${isNew ? '<span class="st-new">NEW</span>' : ''}
          <b class="st-num">${esc(d.number)}</b><span class="st-cust">${esc(d.customer || '')}</span>
          <span class="due ${due.cls}">${esc(K.dueText(d.shipDate))}</span></div>
        ${info ? `<div class="st-info">${info}</div>` : ''}
        ${d.notes ? `<div class="st-note">${esc(d.notes)}</div>` : ''}
        ${d.form && d.form.orderNotes ? `<div class="st-onotes"><i>From the order form</i>${esc(d.form.orderNotes)}</div>` : ''}
        <div class="st-rows">${rows || '<div class="faint">This station has no status column. Ask an admin to add one.</div>'}</div>
        <div class="st-foot"><button class="st-stuck" data-stuck="${d.id}">${icon('alert')}Stuck</button><button class="st-more" data-open="${d.id}">Details</button></div>
      </article>`;
    };
    const doneList = S.stationShowDone ? doneDoors.map(d => `<span class="st-chip">${esc(d.number)}</span>`).join('') : '';
    host.innerHTML = `<div class="st-head"><div><h1>${esc(chosen.map(v => v.name).join(' + '))}</h1>
        <div class="st-sum">${open.length ? `${open.length} to do` : 'Nothing waiting'}${att ? ` · <b class="red">${att} stuck</b>` : ''}</div></div>
        <button class="st-switch" id="st-switch">${icon('swap')}Switch</button></div>
      ${open.length ? `<div class="st-list">${open.map(card).join('')}</div>`
        : `<div class="empty"><div class="ring">${icon('check')}</div><h3>You're all caught up</h3><div>New doors show up here by themselves.</div></div>`}
      ${doneDoors.length ? `<button class="link st-donebtn" id="st-done">${S.stationShowDone ? 'Hide' : 'Show'} ${doneDoors.length} finished door${doneDoors.length === 1 ? '' : 's'}</button>${doneList ? `<div class="st-chips">${doneList}</div>` : ''}` : ''}`;

    $('#st-switch').onclick = () => { S.stationPicking = true; redraw(); };
    const sd = $('#st-done'); if (sd) sd.onclick = () => { S.stationShowDone = !S.stationShowDone; redraw(); };
    const door = id => cfg.doors.find(x => String(x.id) === String(id));
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
