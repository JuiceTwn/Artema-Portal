(() => {
  // The jobs screens: which department you are in, "My work", the Board, a door's page, sending a door back for repair, and adding
  // order forms to the shop. There are no logins: every tap is recorded against the department chosen here, nothing more.
  const { $, $$, esc, icon, api, toast, S, setView, closeDetail, ago, views, q } = window.Portal;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } },
  };

  // ---------- the shop's departments, in plain words ----------
  const DCOL = { 'Frame Prep': '#1f8f55', Paint: '#c23a82', Assembly: '#c9760f', Shipping: '#3d63c9', Office: '#6b6058', Skins: '#2a8f9c', 'Panel Assembly': '#7a5ac9', 'Rail & Stile': '#8a6d3b' };
  const DWHAT = { 'Frame Prep': 'Cut, CNC, fill', Paint: 'Paint prep, paint', Assembly: 'Put the door together', Shipping: 'Get it out the door', Office: 'Start doors, check parts', Skins: 'Makes skins for panels', 'Panel Assembly': 'Makes panels', 'Rail & Stile': 'Makes rails and stiles' };
  const PICK_ORDER = ['Frame Prep', 'Paint', 'Assembly', 'Shipping', 'Office', 'Panel Assembly', 'Skins', 'Rail & Stile'];
  const KIND = { frame: 'Frame', panel: 'Panel', rail_stile: 'Rail & stile' };
  const dcol = d => DCOL[d] || '#6b6058';

  // ---------- what the server says the flow is ----------
  let metaP = null;
  const meta = () => (metaP || (metaP = api('jobs/meta').catch(e => { metaP = null; throw e; })));
  const stepInfo = (m, key) => m.steps.find(s => s.key === key);
  const stepLabel = (m, key) => { const s = stepInfo(m, key); return s ? (s.qc ? 'QC' : s.label) : key; };
  /** The words on the button that completes a step: "CNC done", "QC passed", "Shipped". */
  const doneWord = s => (s.key === 'shipping.ship' ? 'Shipped' : s.qc ? 'QC passed' : s.label + ' done');

  // ---------- which department am I in? ----------
  // Remembered by this browser, and changed in one tap. A computer that has a department set by an admin starts in it.
  let actors = ['Frame Prep', 'Paint', 'Assembly', 'Shipping', 'Office', 'Panel Assembly', 'Skins', 'Rail & Stile'];
  meta().then(m => { actors = m.actors; paintDeptLine(); }).catch(() => { });
  const myDept = () => {
    const s = store.get('artema.jobdept');
    if (s && actors.includes(s)) return s;
    const t = S.me && S.me.tag;
    return t && actors.includes(t) ? t : '';
  };
  function setDept(d) { store.set('artema.jobdept', d); S.pickDept = false; S.workSnap = ''; paintDeptLine(); }
  function paintDeptLine() {
    const d = myDept(), el = $('#dept-line');
    if (!el) return;
    el.innerHTML = d ? `<span class="dl-dot" style="background:${dcol(d)}"></span><span>You're in <b>${esc(d)}</b></span><button class="link" id="dept-change">Change</button>`
      : `<button class="link" id="dept-change">Choose your department</button>`;
    $('#dept-change').onclick = () => { S.pickDept = true; S.workSnap = ''; setView('work'); };
  }
  /** A change is always made as a department. If this browser hasn't chosen one yet, ask first. */
  async function ensureDept() {
    if (myDept()) return true;
    const d = await modal({
      title: 'Which department are you in?', ok: 'Continue',
      html: `<p>The Portal records changes by department. Tap yours.</p>${choiceHtml('dept', PICK_ORDER.filter(x => actors.includes(x)).map(x => [x, x, DWHAT[x] || '', dcol(x)]), '')}`,
      mount: wireChoices,
      collect: el => chosen(el, 'dept') || (toast('Tap your department', true), undefined),
    });
    if (!d) return false;
    setDept(d);
    return true;
  }
  async function post(ep, body) {
    if (!await ensureDept()) throw new Error('Choose your department first');
    return api('jobs/' + ep, { dept: myDept(), who: '', ...body });
  }

  // ---------- dates ----------
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** When a door ships, in words, and how urgent that is. Dates arrive as yyyy-mm-dd; anything else is shown as written. */
  function due(shipDate) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(shipDate || '');
    if (!m) return { text: shipDate ? 'Ships ' + shipDate : 'No ship date', cls: shipDate ? '' : 'none', days: null };
    const t = new Date(+m[1], +m[2] - 1, +m[3]), n = new Date(), today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const days = Math.round((t - today) / 86400000), nice = `${MON[+m[2] - 1]} ${+m[3]}`;
    if (days < 0) return { text: `${-days} day${days === -1 ? '' : 's'} late`, cls: 'late', days };
    if (days === 0) return { text: 'Ships today', cls: 'soon', days };
    if (days === 1) return { text: 'Ships tomorrow', cls: 'soon', days };
    if (days <= 7) return { text: `Ships ${nice} · ${days} days`, cls: days <= 3 ? 'soon' : '', days };
    return { text: 'Ships ' + nice, cls: '', days };
  }
  const projectLine = d => (d.project && d.projectTotal > 1 ? `${d.project} · ${d.projectIndex} of ${d.projectTotal}` : d.project && d.projectTotal === 1 ? '' : '');

  // ---------- small pieces ----------
  /** The steps of one department as dots: done, current, still to come. */
  function dots(m, door, dept) {
    const done = new Set(door.completions.map(c => c.step));
    const mine = m.steps.filter(s => s.dept === dept);
    return `<div class="steps">${mine.map(s => {
      const st = done.has(s.key) ? 'done' : door.next && door.next.key === s.key ? 'now' : 'todo';
      return `<span class="stp ${st}"><b class="c">${st === 'done' ? icon('check') : ''}</b><i>${esc(s.qc ? 'QC' : s.label)}</i></span>`;
    }).join('<span class="sline"></span>')}</div>`;
  }
  function undoToast(msg, onUndo) {
    const t = document.createElement('div');
    t.className = 'toast act';
    t.innerHTML = `<span>${esc(msg)}</span><button>${icon('undo')}Undo</button>`;
    document.body.append(t);
    const gone = () => t.remove();
    const timer = setTimeout(gone, 9000);
    t.querySelector('button').onclick = async () => { clearTimeout(timer); gone(); try { await onUndo(); } catch (e) { toast(e.message, true); } };
  }

  /** A dialog with a body of our own. `collect(el)` returns the answer, or undefined to keep the dialog open. Resolves to the answer or null. */
  function modal({ title, html, ok = 'OK', collect, mount }) {
    return new Promise(res => {
      const d = $('#pick'), body = $('#pk-body');
      $('#pk-title').textContent = title;
      body.innerHTML = html;
      $('#pk-ok').textContent = ok;
      if (mount) mount(body);
      const done = v => { d.close(); off(); res(v); };
      const onSubmit = e => { e.preventDefault(); const v = collect ? collect(body) : true; if (v !== undefined) done(v); };
      const onCancel = e => { if (e) e.preventDefault(); done(null); };
      const off = () => { $('#pk-form').removeEventListener('submit', onSubmit); $('#pk-cancel').removeEventListener('click', onCancel); d.removeEventListener('cancel', onCancel); };
      $('#pk-form').addEventListener('submit', onSubmit); $('#pk-cancel').addEventListener('click', onCancel); d.addEventListener('cancel', onCancel);
      d.showModal();
    });
  }
  /** Single-choice buttons inside a dialog: tapping one selects it. */
  const choiceHtml = (name, opts, cur) => `<div class="choices" data-name="${name}">${opts.map(([v, label, sub, col]) => `<button type="button" class="choice${v === cur ? ' on' : ''}" data-v="${esc(v)}"${col ? ` style="--dc:${col}"` : ''}><b>${esc(label)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</button>`).join('')}</div>`;
  const wireChoices = el => $$('.choices', el).forEach(g => $$('.choice', g).forEach(b => b.onclick = () => { $$('.choice', g).forEach(x => x.classList.toggle('on', x === b)); g.dataset.val = b.dataset.v; }));
  const chosen = (el, name) => { const g = $(`.choices[data-name="${name}"]`, el), on = g && $('.choice.on', g); return on ? on.dataset.v : ''; };

  // ---------- which department? ----------
  function renderPicker() {
    const cur = myDept();
    $('#work').innerHTML = `<div class="pk-hero"><h1>Which department are you in?</h1><div class="sub">Tap yours. It decides what you see first, and it is how the Portal knows who did what. You can change it any time.</div></div>
      <div class="dept-grid">${PICK_ORDER.filter(d => actors.includes(d)).map(d => `<button class="dept-btn${d === cur ? ' on' : ''}" data-d="${esc(d)}" style="--dc:${dcol(d)}"><b>${esc(d)}</b><span>${esc(DWHAT[d] || '')}</span></button>`).join('')}</div>`;
    $$('#work [data-d]').forEach(b => b.onclick = () => { setDept(b.dataset.d); S.workSnap = ''; loadWork(true); });
  }

  // ---------- my work ----------
  async function loadWork(force) {
    await meta();
    const dept = myDept();
    if (!dept || S.pickDept) { if (force || S.workSnap !== 'picker') { S.workSnap = 'picker'; renderPicker(); } return; }
    const data = await api('jobs/queue?dept=' + q(dept));
    const snap = JSON.stringify([dept, data]);
    $('#work-count').textContent = data.work.length + data.repairs.length + data.parts.length + data.release.length || '';
    if (!force && snap === S.workSnap) return;
    S.workSnap = snap;
    renderWork(await meta(), data);
  }
  views.work = loadWork;

  function renderWork(m, data) {
    const dept = data.dept, c = dcol(dept);
    const nWork = data.work.length, nRep = data.repairs.length, nParts = data.parts.length, nRel = data.release.length;
    const bits = [];
    if (nRep) bits.push(`<b class="red">${nRep} repair${nRep === 1 ? '' : 's'}</b>`);
    if (nRel) bits.push(`${nRel} to start`);
    if (nParts) bits.push(`${nParts} part${nParts === 1 ? '' : 's'} to ${dept === 'Office' ? 'receive' : 'make'}`);
    if (nWork) bits.push(`${nWork} door${nWork === 1 ? '' : 's'} to do`);
    const head = `<div class="wk-head" style="--dc:${c}"><div><small>You are in</small><h1>${esc(dept)}</h1><div class="wk-sum">${bits.length ? bits.join(' · ') : 'Nothing waiting right now'}</div></div>
      <button class="btn" id="wk-change">${icon('swap')}Change department</button></div>`;

    const repairs = nRep ? `<div class="wk-sec red"><h2>${icon('alert')}Repairs for you</h2>${data.repairs.map(r => `
      <div class="wk-card rep" data-id="${r.door.id}" tabindex="0">
        <div class="wk-top"><span class="doorpill">${esc(r.door.number)}</span><div class="wk-t"><b>${esc(r.reason || 'Needs repair')}</b><span>${esc(r.door.customer || '')}</span></div>${r.rush ? '<span class="rush">RUSH</span>' : ''}</div>
        <div class="wk-meta">Sent back by ${esc(r.from_dept)}, ${esc(ago(r.opened_at).toLowerCase())}${r.opened_by ? ' (' + esc(r.opened_by) + ')' : ''}. It carries on at ${esc(stepLabel(m, r.step))} when you're done.</div>
        <button class="wk-do" data-repair="${r.id}" data-num="${esc(r.door.number)}">${icon('check')}Repair done</button>
      </div>`).join('')}</div>` : '';

    const release = nRel ? `<div class="wk-sec"><h2>Ready to start</h2><div class="wk-sub">Tick the parts as they come in, then start the door.</div>${data.release.map(d => {
      const have = d.checks.filter(x => x.done_at).length, all = have === d.checks.length;
      return `<div class="wk-card" data-id="${d.id}" tabindex="0">
        <div class="wk-top"><span class="doorpill">${esc(d.number)}</span><div class="wk-t"><b>${esc(d.customer || 'No customer')}</b><span>${esc(projectLine(d))}</span></div>${dueChip(d.shipDate)}</div>
        <div class="wk-meta">Parts in: ${have} of ${d.checks.length}${all ? '' : ' · ' + esc(d.checks.filter(x => !x.done_at).map(x => x.item).join(', ')) + ' still to come'}</div>
        ${all ? `<button class="wk-do" data-release="${d.id}" data-num="${esc(d.number)}">${icon('check')}Start this door</button>` : `<button class="wk-do alt" data-open="${d.id}">Check the parts</button>`}
      </div>`;
    }).join('')}</div>` : '';

    const parts = nParts ? `<div class="wk-sec"><h2>${dept === 'Office' ? 'Parts coming from outside' : 'Parts to make'}</h2>${data.parts.map(p => `
      <div class="wk-card" data-id="${p.doorId}" tabindex="0">
        <div class="wk-top"><span class="doorpill">${esc(p.number)}</span><div class="wk-t"><b>${esc(KIND[p.kind] || p.kind)}${p.customer ? ' · ' + esc(p.customer) : ''}</b><span>${dept === 'Office' ? esc(p.source || 'Supplier') + (p.expectedAt ? ' · due ' + esc(p.expectedAt) : '') : ''}</span></div>${dueChip(p.shipDate)}</div>
        <button class="wk-do" data-ready="${p.doorId}" data-kind="${p.kind}" data-num="${esc(p.number)}">${icon('check')}${dept === 'Office' ? (KIND[p.kind] || p.kind) + ' has arrived' : (KIND[p.kind] || p.kind) + ' is ready'}</button>
      </div>`).join('')}</div>` : '';

    const work = nWork ? `<div class="wk-sec"><h2>To do</h2>${data.work.map(d => {
      const wait = d.waitingOn.length;
      return `<div class="wk-card${wait ? ' waiting' : ''}" data-id="${d.id}" tabindex="0">
        <div class="wk-top"><span class="doorpill">${esc(d.number)}</span><div class="wk-t"><b>${esc(d.customer || 'No customer')}</b><span>${esc(projectLine(d))}</span></div>${dueChip(d.shipDate)}</div>
        ${dots(m, d, dept)}
        ${wait ? `<div class="wait">${icon('alert')}Waiting for the ${d.waitingOn.map(k => (KIND[k] || k).toLowerCase()).join(' and ')} to be ready</div>`
          : `<button class="wk-do" data-step="${d.next.key}" data-id="${d.id}" data-num="${esc(d.number)}">${icon('check')}${esc(doneWord(stepInfo(m, d.next.key)))}</button>`}
      </div>`;
    }).join('')}</div>` : '';

    const empty = !nWork && !nRep && !nParts && !nRel ? `<div class="empty"><div class="ring">${icon('check')}</div><h3>You're all caught up</h3><div>Nothing is waiting for ${esc(dept)}. New work shows up here by itself.</div><button class="btn big" data-go-board>${icon('board')}See the whole board</button></div>` : '';

    $('#work').innerHTML = head + repairs + release + parts + work + empty;
    $('#wk-change').onclick = () => { S.pickDept = true; S.workSnap = ''; loadWork(true); };
    const gb = $('#work [data-go-board]'); if (gb) gb.onclick = () => setView('board');
    wireCards('#work');
  }
  const dueChip = shipDate => { const d = due(shipDate); return `<span class="due ${d.cls}">${esc(d.text)}</span>`; };
  /** The same, short enough for a board card. */
  const dueShort = shipDate => {
    const d = due(shipDate);
    const text = d.days === null ? d.text.replace(/^Ships /, '') : d.days < 0 ? d.text : d.days === 0 ? 'Today' : d.days === 1 ? 'Tomorrow' : d.text.replace(/^Ships /, '').replace(/ · .*/, '');
    return `<span class="due ${d.cls}">${esc(text)}</span>`;
  };

  /** Taps on cards: the big button does its one job; anywhere else on the card opens the door. */
  function wireCards(root) {
    $$(root + ' .wk-card').forEach(card => {
      const open = () => openDoor(card.dataset.id);
      card.onclick = e => { if (!e.target.closest('button')) open(); };
      card.onkeydown = e => { if (e.key === 'Enter' && e.target === card) open(); };
    });
    $$(root + ' [data-open]').forEach(b => b.onclick = () => openDoor(b.dataset.open));
    $$(root + ' [data-step]').forEach(b => b.onclick = () => completeStep(b.dataset.id, b.dataset.step, b.dataset.num, b));
    $$(root + ' [data-repair]').forEach(b => b.onclick = () => repairDone(b.dataset.repair, b.dataset.num, b));
    $$(root + ' [data-ready]').forEach(b => b.onclick = () => markReady(b.dataset.ready, b.dataset.kind, b.dataset.num, b));
    $$(root + ' [data-release]').forEach(b => b.onclick = () => releaseDoor(b.dataset.release, b.dataset.num, b));
  }

  // ---------- the actions ----------
  // One tap does it; the way back is Undo for a few seconds, not a question every time.
  async function act(btn, fn) {
    if (btn) btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, true); if (btn) btn.disabled = false; return false; }
    afterChange();
    return true;
  }
  function afterChange() { S.workSnap = ''; S.boardSnap = ''; refreshAll(); }
  const refreshAll = () => { if (views[S.view]) views[S.view](true).catch(() => { }); if (S.drawer) drawDoor(S.drawer, true); };

  async function completeStep(id, step, num, btn) {
    const m = await meta();
    await act(btn, async () => {
      await post('step', { id, step });
      undoToast(`${num}: ${stepInfo(m, step).qc ? 'QC passed' : stepInfo(m, step).label + ' done'}`, async () => { await post('undo', { id, step }); afterChange(); });
    });
  }
  async function repairDone(detour, num, btn) {
    await act(btn, async () => { await post('repair-done', { detour }); toast(`${num}: repair done. It goes back to where it was.`); });
  }
  async function markReady(id, kind, num, btn) {
    await act(btn, async () => {
      await post('ready', { id, kind, ready: true });
      undoToast(`${num}: ${(KIND[kind] || kind).toLowerCase()} ready`, async () => { await post('ready', { id, kind, ready: false }); afterChange(); });
    });
  }
  async function releaseDoor(id, num, btn) {
    await act(btn, async () => { await post('release', { id }); toast(`${num} has started. It's in the first department's list now.`); });
  }
  async function undoLast(door) {
    const last = [...door.completions].reverse().find(c => !c.skipped);
    if (!last) return;
    await act(null, async () => { await post('undo', { id: door.id, step: last.step }); toast('Taken back'); });
  }

  /** Send a door to another department to be fixed. It keeps its place in the flow and comes back to it. */
  async function sendForRepair(door) {
    const m = await meta();
    const depts = PICK_ORDER.filter(d => actors.includes(d) && d !== 'Office');
    const res = await modal({
      title: `Send ${door.number} back for repair`,
      ok: 'Send it',
      html: `<p>It stays where it is in the flow. When the repair is done it goes straight back.</p>
        <div class="pk-label">Who should fix it?</div>${choiceHtml('to', depts.map(d => [d, d, '', dcol(d)]), '')}
        <div class="pk-label">What's wrong?</div>${choiceHtml('why', m.reasons.map(r => [r, r]), '')}
        <input class="field" id="pk-more" placeholder="Anything else to know? (optional)" autocomplete="off" maxlength="200">
        <label class="pk-check"><input type="checkbox" id="pk-rush" checked> Rush: they should do this first</label>`,
      mount: wireChoices,
      collect: el => {
        const to = chosen(el, 'to'), why = chosen(el, 'why'), more = $('#pk-more', el).value.trim();
        if (!to) { toast('Pick who should fix it', true); return undefined; }
        if (!why && !more) { toast("Pick what's wrong, or type it", true); return undefined; }
        return { toDept: to, reason: [why && why !== 'Other' ? why : '', more].filter(Boolean).join(': ') || why, rush: $('#pk-rush', el).checked };
      },
    });
    if (!res) return;
    await act(null, async () => { await post('repair', { id: door.id, ...res }); toast(`${door.number} is on ${res.toDept}'s repair list`); });
  }

  // ---------- one door ----------
  async function openDoor(ref) {
    const { door } = await api('jobs/door?id=' + q(ref));
    S.drawer = String(door.id);
    drawDoor(door.id, true);
  }
  async function drawDoor(id, force) {
    if (String(S.drawer) !== String(id)) return;
    let data;
    try { data = await api('jobs/door?id=' + q(id)); } catch (e) { if (force) toast(e.message, true); return; }
    const snap = JSON.stringify(data);
    if (!force && snap === S.drawerSnap) return;
    S.drawerSnap = snap;
    const m = await meta(), d = data.door, mine = myDept();
    const done = new Map(d.completions.map(c => [c.step, c]));
    const dueI = due(d.shipDate);

    let status;
    if (d.status === 'new') status = `<div class="dr-status new">Not started yet. The office starts it once the parts are in.</div>`;
    else if (d.status === 'done') status = `<div class="dr-status done">${icon('check')}Finished</div>`;
    else if (d.status === 'repair') status = `<div class="dr-status repair">${icon('alert')}Out for repair at ${esc(d.openDetours.map(x => x.to_dept).join(' and '))}. Then it carries on at ${esc(stepLabel(m, d.next.key))}.</div>`;
    else status = `<div class="dr-status now" style="--dc:${dcol(d.next.dept)}"><div><small>${esc(d.next.dept)} · next step</small><b>${esc(d.next.qc ? 'QC' : d.next.label)}</b></div></div>`;

    const steps = m.stages.map(st => {
      const rows = m.steps.filter(s => s.stage === st.id).map(s => {
        const c = done.get(s.key), now = d.next && d.next.key === s.key && d.status !== 'new';
        const state = c ? (c.skipped ? 'skip' : 'done') : now ? 'now' : 'todo';
        const right = c ? (c.skipped ? 'Not needed' : `${esc(ago(c.at))}${c.who ? ' · ' + esc(c.who) : ''}`) : now ? 'Next' : '';
        return `<div class="st ${state}"><span class="st-i">${c && !c.skipped ? icon('check') : ''}</span><span class="st-n">${esc(s.qc ? 'QC' : s.label)}</span><span class="st-r">${right}</span></div>`;
      }).join('');
      return `<div class="st-group"><div class="st-h" style="--dc:${dcol(st.dept)}">${esc(st.dept)}</div>${rows}</div>`;
    }).join('');

    const comps = d.components.length ? `<div class="dr-sec"><h3>Parts</h3>${d.components.map(c => {
      const ready = c.ready_at !== null;
      return `<div class="part ${ready ? 'ok' : ''}"><div><b>${esc(KIND[c.kind] || c.kind)}</b><span>${c.source_kind === 'external' ? 'From ' + esc(c.source || 'a supplier') : 'Made by ' + esc(c.source)}${c.expected_at ? ' · due ' + esc(c.expected_at) : ''}</span></div>
        ${ready ? `<span class="ok">${icon('check')}Ready</span><button class="link" data-unready="${c.kind}">Not ready</button>` : `<span class="wait">Not here yet</span><button class="btn" data-ready="${c.kind}">Mark ready</button>`}</div>`;
    }).join('')}</div>` : '';

    const allIn = d.checks.every(x => x.done_at);
    const checks = d.status === 'new' ? `<div class="dr-sec"><h3>Before it starts</h3><div class="dr-note">Tick each part when it is in the shop.</div>${d.checks.map(x => `
      <button class="chk${x.done_at ? ' on' : ''}" data-check="${esc(x.item)}" data-on="${x.done_at ? 1 : 0}"><span class="box">${x.done_at ? icon('check') : ''}</span>${esc(x.item)}</button>`).join('')}
      <button class="btn primary big full" id="dr-release"${allIn ? '' : ' disabled'}>${icon('check')}${allIn ? 'Start this door' : 'Tick every part to start'}</button></div>` : '';

    const repairs = d.openDetours.length ? `<div class="dr-sec"><h3>Repairs open</h3>${d.openDetours.map(r => `
      <div class="rep-row"><div><b>${esc(r.to_dept)}</b><span>${esc(r.reason || 'Needs repair')} · sent by ${esc(r.from_dept)} ${esc(ago(r.opened_at))}</span></div><button class="btn primary" data-repair-done="${r.id}">Repair done</button></div>`).join('')}</div>` : '';

    const canStep = d.status === 'active' && !d.waitingOn.length;
    const primary = canStep ? `<button class="btn primary big full" data-step="${d.next.key}" style="--dc:${dcol(d.next.dept)}">${icon('check')}${esc(doneWord(stepInfo(m, d.next.key)))}${d.next.dept !== mine && mine !== 'Office' ? ` <small>(${esc(d.next.dept)}'s step)</small>` : ''}</button>`
      : d.status === 'active' && d.waitingOn.length ? `<div class="wait big">${icon('alert')}Waiting for the ${d.waitingOn.map(k => (KIND[k] || k).toLowerCase()).join(' and ')} to be ready</div>` : '';
    const canUndo = d.status !== 'new' && d.completions.some(c => !c.skipped) && !d.openDetours.length;
    const actions = `<div class="actions">${primary}
      ${d.status === 'active' ? `<button class="btn full" id="dr-repair">${icon('wrench')}Send back for repair</button>` : ''}
      <div class="pair">${d.sourcePath ? `<button class="btn" id="dr-wo">${icon('door')}Work order</button>` : ''}${canUndo ? `<button class="btn" id="dr-undo">${icon('undo')}Undo last step</button>` : ''}</div></div>`;

    const history = data.events.length ? `<details class="dr-hist"><summary>History</summary>${data.events.map(e => `<div class="hv"><span>${esc(evText(m, e))}</span><i>${esc(e.dept)} · ${esc(ago(e.at))}</i></div>`).join('')}</details>` : '';

    $('#detail-in').innerHTML = `<button class="close" id="d-close" aria-label="Close">${icon('x')}</button>
      <div class="dr-head"><span class="doorpill big">${esc(d.number)}</span><div><h2>${esc(d.customer || 'No customer')}</h2><div class="muted sm">${esc(projectLine(d))}</div></div></div>
      <div class="dr-due ${dueI.cls}">${esc(dueI.text)}</div>
      ${status}${actions}${repairs}${checks}${comps}
      <div class="dr-sec"><h3>Where it is</h3>${steps}</div>${history}`;
    $('#app').classList.add('has-detail');
    const root = $('#detail-in');
    $('#d-close').onclick = () => { S.drawer = null; closeDetail(); };
    $$('[data-step]', root).forEach(b => b.onclick = () => completeStep(d.id, b.dataset.step, d.number, b));
    $$('[data-check]', root).forEach(b => b.onclick = () => act(b, () => post('check', { id: d.id, item: b.dataset.check, done: b.dataset.on !== '1' })));
    $$('[data-ready]', root).forEach(b => b.onclick = () => markReady(d.id, b.dataset.ready, d.number, b));
    $$('[data-unready]', root).forEach(b => b.onclick = () => act(b, () => post('ready', { id: d.id, kind: b.dataset.unready, ready: false })));
    $$('[data-repair-done]', root).forEach(b => b.onclick = () => repairDone(b.dataset.repairDone, d.number, b));
    if ($('#dr-release')) $('#dr-release').onclick = () => releaseDoor(d.id, d.number, $('#dr-release'));
    if ($('#dr-repair')) $('#dr-repair').onclick = () => sendForRepair(d);
    if ($('#dr-undo')) $('#dr-undo').onclick = () => undoLast(d);
    if ($('#dr-wo')) $('#dr-wo').onclick = () => openWorkOrder(d);
  }
  function evText(m, e) {
    const x = e.data || {};
    switch (e.kind) {
      case 'door.created': return 'Added to the shop';
      case 'door.released': return 'Started';
      case 'step.done': return stepLabel(m, x.step) + ' done' + (e.who ? ' (' + e.who + ')' : '');
      case 'step.undone': return stepLabel(m, x.step) + ' taken back';
      case 'detour.opened': return `Sent to ${x.to} for repair${x.reason ? ': ' + x.reason : ''}`;
      case 'detour.closed': return `Repair at ${x.to} done`;
      case 'component.ready': return (KIND[x.kind] || x.kind) + ' ready';
      case 'component.unready': return (KIND[x.kind] || x.kind) + ' marked not ready';
      case 'check.done': return x.item + ' is in';
      case 'check.undone': return x.item + ' marked not in';
      default: return e.kind;
    }
  }
  /** Jumps to the door's order form in Door orders. */
  async function openWorkOrder(d) {
    S.drawer = null; closeDetail();
    await window.Portal.showOrder(d.sourcePath.replace(/^Door Orders\//, ''));
  }

  // ---------- the board ----------
  async function loadBoard(force) {
    if (!force && document.activeElement && document.activeElement.id === 'bd-q') return;          // don't redraw the page under someone who is typing
    const m = await meta();
    const { doors } = await api('jobs/board');
    const snap = JSON.stringify([doors, S.boardQ, S.boardAttn]);
    if (!force && snap === S.boardSnap) return;
    S.boardSnap = snap;
    renderBoard(m, doors);
  }
  views.board = loadBoard;
  const needsAttention = d => d.status === 'repair' || d.waitingOn.length > 0 || (due(d.shipDate).days !== null && due(d.shipDate).days < 0);

  function renderBoard(m, all) {
    const term = (S.boardQ || '').toLowerCase().trim();
    const doors = all.filter(d => (!term || [d.number, d.customer, d.project].join(' ').toLowerCase().includes(term)) && (!S.boardAttn || needsAttention(d)));
    const cols = [{ id: 'new', title: 'Not started', dept: 'Office', hint: 'Waiting for parts', rows: doors.filter(d => d.status === 'new') },
      ...m.stages.map(st => ({ id: st.id, title: st.dept, dept: st.dept, rows: doors.filter(d => d.status !== 'new' && d.next && d.next.dept === st.dept) }))];
    const total = all.length, attn = all.filter(needsAttention).length;
    $('#board').innerHTML = `<div class="head"><div><div class="crumbs"><button>Board</button></div><div class="sub">${total} door${total === 1 ? '' : 's'} in the shop${attn ? ` · <b class="red">${attn} need${attn === 1 ? 's' : ''} a look</b>` : ''}</div></div></div>
      <div class="bd-tools"><label class="search bd-search">${icon('search')}<input id="bd-q" placeholder="Find a door, customer or project" autocomplete="off" spellcheck="false" value="${esc(S.boardQ || '')}"></label>
        <button class="bd-attn${S.boardAttn ? ' on' : ''}" id="bd-attn">${icon('alert')}Needs a look${attn ? ` (${attn})` : ''}</button></div>
      <div class="bd-cols">${cols.map(c => `<section class="bd-col" style="--dc:${dcol(c.dept)}"><header><b>${esc(c.title)}</b><span class="n">${c.rows.length}</span></header>
        <div class="bd-list">${c.rows.length ? c.rows.map(d => boardCard(m, d)).join('') : `<div class="bd-none">${c.id === 'new' ? 'Nothing waiting' : 'Nothing here'}</div>`}</div></section>`).join('')}</div>`;
    const inp = $('#bd-q');
    inp.oninput = () => { S.boardQ = inp.value; S.boardSnap = ''; const pos = inp.selectionStart; loadBoard(true).then(() => { const n = $('#bd-q'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }); };
    $('#bd-attn').onclick = () => { S.boardAttn = !S.boardAttn; S.boardSnap = ''; loadBoard(true); };
    $$('#board .bd-card').forEach(c => { c.onclick = () => openDoor(c.dataset.id); c.onkeydown = e => { if (e.key === 'Enter') openDoor(c.dataset.id); }; });
  }
  function boardCard(m, d) {
    const badges = [];
    if (d.status === 'repair') badges.push(`<span class="bg red">${icon('wrench')}Repair at ${esc(d.openDetours.map(x => x.to_dept).join(', '))}</span>`);
    if (d.waitingOn.length) badges.push(`<span class="bg amber">Waiting for ${esc(d.waitingOn.map(k => (KIND[k] || k).toLowerCase()).join(', '))}</span>`);
    if (d.status === 'new') { const left = d.checks.filter(x => !x.done_at).length; badges.push(`<span class="bg ${left ? 'amber' : 'green'}">${left ? left + ' part' + (left === 1 ? '' : 's') + ' to come' : 'Ready to start'}</span>`); }
    return `<div class="bd-card${d.status === 'repair' ? ' rep' : ''}" data-id="${d.id}" tabindex="0">
      <div class="bd-r1"><span class="doorpill">${esc(d.number)}</span>${dueShort(d.shipDate)}</div>
      <div class="bd-cu">${esc(d.customer || 'No customer')}</div>
      ${d.project && d.projectTotal > 1 ? `<div class="bd-pr">${esc(d.project)} · ${d.projectIndex} of ${d.projectTotal}</div>` : ''}
      ${d.next && d.status !== 'new' ? `<div class="bd-nx">Next: ${esc(d.next.qc ? 'QC' : d.next.label)}</div>` : ''}${badges.length ? `<div class="bd-bg">${badges.join('')}</div>` : ''}</div>`;
  }

  // ---------- adding order forms to the shop ----------
  /** `rels` is a list of order-form paths, or null for every form that isn't in the shop yet. */
  async function addForms(rels) {
    const items = (S.orderItems || []).filter(o => !o.error && o.door && !(S.inShop && S.inShop.has(o.door.toLowerCase())));
    const list = rels ? items.filter(o => rels.includes(o.rel)) : items;
    if (!list.length) { toast('Those are already in the shop'); return; }
    let saved = {}; try { saved = JSON.parse(store.get('artema.intake') || '{}'); } catch { }
    const m = await meta(), def = { ...m.defaults, ...saved };
    const how = [['inhouse', 'Made here'], ['bought', 'Bought']];
    const row = (name, label, opts) => `<div class="pk-row"><div class="pk-label">${label}</div>${choiceHtml(name, opts, def[name])}</div>`;
    const res = await modal({
      title: list.length === 1 ? `Add door ${list[0].door} to the shop` : `Add ${list.length} doors to the shop`,
      ok: list.length === 1 ? 'Add door' : 'Add doors',
      html: `<p>Where do the parts for ${list.length === 1 ? 'this door' : 'these doors'} come from? The office can change one later.</p>
        ${row('frame', 'Frame', how)}${row('panel', 'Panel', how)}${row('rail_stile', 'Rail & stile', [...how, ['none', 'Not needed']])}
        ${list.length > 1 ? `<div class="pk-list">${list.slice(0, 8).map(o => esc(o.door)).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}</div>` : ''}`,
      mount: wireChoices,
      collect: el => ({ frame: chosen(el, 'frame'), panel: chosen(el, 'panel'), rail_stile: chosen(el, 'rail_stile') }),
    });
    if (!res) return;
    store.set('artema.intake', JSON.stringify(res));
    try {
      if (list.length === 1) {
        const r = await post('add', { rel: list[0].rel, choices: res });
        toast(`Door ${list[0].door} is in the shop`);
        S.order = null; await window.Portal.refresh(true);
        openDoor(r.door.id);
      } else {
        const r = await post('add-all', { choices: res });
        toast(`${r.added.length} door${r.added.length === 1 ? '' : 's'} added${r.skipped.length ? ` · ${r.skipped.length} could not be read` : ''}`, r.added.length === 0);
        S.order = null; await window.Portal.refresh(true);
      }
    } catch (e) { toast(e.message, true); }
  }

  // ---------- home and start ----------
  async function homeLine() {
    const d = myDept();
    if (!d) return { text: 'Choose your department', color: '#1f8f55' };
    const qd = await api('jobs/queue?dept=' + q(d));
    const n = qd.work.length + qd.release.length + qd.parts.length, r = qd.repairs.length;
    const parts = [];
    if (r) parts.push(`${r} repair${r === 1 ? '' : 's'}`);
    if (n) parts.push(`${n} to do`);
    return { text: `${d} · ${parts.length ? parts.join(', ') : 'all caught up'}`, color: dcol(d) };
  }
  const startView = () => { paintDeptLine(); return myDept() ? 'work' : 'home'; };

  setInterval(() => { if (S.drawer && !document.hidden && !$('#dlg').open && !$('#pick').open) drawDoor(S.drawer, false); }, 3000);
  window.Portal.jobs = { addForms, openDoor: ref => openDoor(ref).catch(e => toast(e.message, true)), homeLine, startView };
  paintDeptLine();
})();
