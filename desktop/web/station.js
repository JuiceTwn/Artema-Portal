(() => {
  // Station: the floor's view. One board tab at a time (a tab is a station), as a short queue of big cards in ship-date order.
  // The first card is "next up"; the status buttons are big, "Done" is one tap, and "Stuck" is two taps (a reason from a list).
  // It only uses the Board's own calls, so it needs nothing new on the server.
  const { $, $$, esc, icon, api, toast, S, views, q } = window.Portal;
  const K = window.Portal.jobs.kit;
  const hexOf = (cfg, key) => (cfg.palette && cfg.palette[key]) || '#7e8499';
  const STUCK_WHY = ['Waiting on a part', 'Defect', 'Unclear drawing or order', 'Machine down', 'Other'];

  const labelOf = (f, d) => { const c = d.cells[f.id]; return c && c.label != null ? f.labels.find(l => l.id === c.label) || null : null; };
  const stationFields = (view, cfg) => view.cols.filter(k => k[0] === '#').map(k => cfg.fields.find(f => '#' + f.id === k)).filter(f => f && f.kind === 'status');
  /** This station's work on a door is finished when every status column in the tab holds a "counts as done" label. */
  const finished = (d, fields) => fields.length > 0 && fields.every(f => (labelOf(f, d) || {}).done);
  const stuck = (d, fields) => fields.some(f => (labelOf(f, d) || {}).attn);
  const seenKey = id => 'artema.seen.' + id;
  function seenSet(view, doors) {
    let raw = K.store.get(seenKey(view.id));
    if (raw === null) { K.store.set(seenKey(view.id), JSON.stringify(doors.map(d => d.id))); return new Set(doors.map(d => d.id)); }          // first visit: nothing is "new"
    try { return new Set(JSON.parse(raw)); } catch { return new Set(); }
  }
  const markSeen = (view, id) => { let s; try { s = new Set(JSON.parse(K.store.get(seenKey(view.id)) || '[]')); } catch { s = new Set(); } s.add(id); K.store.set(seenKey(view.id), JSON.stringify([...s])); };

  async function load(force) {
    if (!force && (document.querySelector('dialog.pick[open]') || $('#pop'))) return;
    const cfg = await api('jobs/board');
    K.applyGuided(cfg.guided);
    const want = S.stationTab || K.store.get('artema.stationtab');
    const view = cfg.views.find(v => String(v.id) === String(want)) || cfg.views[0];
    const snap = JSON.stringify([cfg, view && view.id, S.stationShowDone]);
    if (!force && snap === S.stationSnap) return;
    S.stationSnap = snap; S.cfg = cfg;
    render(cfg, view);
  }
  views.station = load;
  const redraw = () => { S.stationSnap = ''; load(true).catch(e => toast(e.message, true)); };

  function render(cfg, view) {
    const host = $('#station');
    if (!view) { host.innerHTML = `<div class="empty"><div class="ring">${icon('board')}</div><h3>No stations yet</h3><div>An admin sets them up from the Board (Customize).</div></div>`; return; }
    const fields = stationFields(view, cfg), seen = seenSet(view, cfg.doors);
    const forms = view.cols.filter(k => k.startsWith('f:')).map(k => K.FORM && K.FORM[k.slice(2)]).filter(Boolean).slice(0, 3);
    const here = cfg.doors.filter(d => K.atStation(d, view, cfg));          // a tab can show one station only
    const open = here.filter(d => !finished(d, fields));
    const doneN = here.length - open.length;
    const key = d => (d.shipDate && /^\d{4}-\d{2}-\d{2}$/.test(d.shipDate) ? d.shipDate : '9999');
    open.sort((a, b) => key(a).localeCompare(key(b)) || K.nat(a.number, b.number));
    const att = open.filter(d => stuck(d, fields)).length;

    const card = (d, i) => {
      const due = K.due(d.shipDate), isNew = !seen.has(d.id);
      const rows = fields.map(f => {
        const l = labelOf(f, d), hex = l ? hexOf(cfg, l.color) : '';
        const doneLabel = f.labels.find(x => x.done);
        const isDone = l && l.done;
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
        <div class="st-rows">${rows || '<div class="faint">This tab has no status columns. Ask an admin to add one.</div>'}</div>
        <div class="st-foot"><button class="st-stuck" data-stuck="${d.id}">${icon('alert')}Stuck</button><button class="st-more" data-open="${d.id}">Details</button></div>
      </article>`;
    };

    const doneList = S.stationShowDone ? here.filter(d => finished(d, fields)).map(d => `<span class="st-chip">${esc(d.number)}</span>`).join('') : '';
    host.innerHTML = `<div class="st-head"><h1>Station</h1>
        <div class="st-sum">${open.length} to do${att ? ` · <b class="red">${att} stuck</b>` : ''}</div></div>
      <div class="st-tabs" role="tablist">${cfg.views.map(v => `<button class="${v.id === view.id ? 'on' : ''}" data-tab="${v.id}">${esc(v.name)}</button>`).join('')}</div>
      ${open.length ? `<div class="st-list">${open.map(card).join('')}</div>`
        : `<div class="empty"><div class="ring">${icon('check')}</div><h3>You're all caught up</h3><div>Nothing is waiting here. New doors show up by themselves.</div></div>`}
      ${doneN ? `<button class="link st-donebtn" id="st-done">${S.stationShowDone ? 'Hide' : 'Show'} ${doneN} finished door${doneN === 1 ? '' : 's'}</button>${doneList ? `<div class="st-chips">${doneList}</div>` : ''}` : ''}`;

    $$('#station [data-tab]').forEach(b => b.onclick = () => { S.stationTab = b.dataset.tab; K.store.set('artema.stationtab', b.dataset.tab); redraw(); });
    const sd = $('#st-done'); if (sd) sd.onclick = () => { S.stationShowDone = !S.stationShowDone; redraw(); };
    const door = id => cfg.doors.find(x => String(x.id) === String(id));
    const see = id => { markSeen(view, Number(id)); };
    $$('#station [data-open]').forEach(b => b.onclick = () => { see(b.dataset.open); K.openDoor(b.dataset.open); });
    $$('#station [data-pick]').forEach(b => b.onclick = () => {
      const id = b.closest('.st-card').dataset.id; see(id);
      const f = cfg.fields.find(x => String(x.id) === b.dataset.pick), d = door(id);
      if (d && f) K.editCell(b, d, f, cfg);
    });
    $$('#station [data-done]').forEach(b => b.onclick = () => setLabel(b, door(b.closest('.st-card').dataset.id), cfg.fields.find(x => String(x.id) === b.dataset.done), Number(b.dataset.label), view, cfg));
    $$('#station [data-stuck]').forEach(b => b.onclick = () => flagStuck(door(b.dataset.stuck), fields, view));
  }

  /** One tap: set the status to its "done" label. If a rule then moves the door on, say so; Undo takes back both. */
  async function setLabel(btn, d, f, labelId, view, cfg) {
    if (!d || !f) return;
    const before = d.cells[f.id] && d.cells[f.id].label != null ? d.cells[f.id].label : null;
    markSeen(view, d.id);
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
  async function flagStuck(d, fields, view) {
    if (!d) return;
    const f = fields.find(x => !(labelOf(x, d) || {}).done && x.labels.some(l => l.attn)) || fields.find(x => x.labels.some(l => l.attn));
    const res = await K.modal({
      title: `${d.number} is stuck`, ok: 'Tell the office',
      html: `<p>Pick what's wrong. The office will see it on the Board right away.</p>${K.choiceHtml('why', STUCK_WHY.map(r => [r, r]), '')}<input class="field" id="stk-more" placeholder="Anything else? (optional)" autocomplete="off" maxlength="200">`,
      mount: K.wireChoices,
      collect: el => { const why = K.chosen(el, 'why'), more = $('#stk-more', el).value.trim(); if (!why && !more) { toast('Pick what is wrong', true); return undefined; } return [why, more].filter(Boolean).join(': '); },
    });
    if (!res) return;
    markSeen(view, d.id);
    await K.act(null, async () => {
      if (f) await K.post('cell', { id: d.id, field: f.id, value: f.labels.find(l => l.attn).id });
      await K.post('comment', { id: d.id, text: 'Stuck: ' + res });
      toast(`${d.number}: the office has been told`);
    });
  }
})();
