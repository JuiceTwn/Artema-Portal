(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = n => `<svg class="i"><use href="#i-${n}"/></svg>`;

  const views = {};          // extra screens (jobs.js) register a loader here: views.work = async force => { ... }
  const S = { path: '', items: [], sel: null, view: 'home', q: '', who: '', info: null, snapshot: '', results: null };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } },
  };

  // ---------- api ----------
  const hdrs = () => ({ 'X-Device': encodeURIComponent(S.who || 'Someone') });
  async function api(path, body, retried) {
    const opt = body === undefined ? { headers: hdrs() } :
      { method: 'POST', headers: { ...hdrs(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch('/api/' + path, opt);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && !retried) { await login(); return api(path, body, true); }
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }

  // ---------- signing in (browsers; computers that joined carry their own sign-in, and the main computer needs none) ----------
  let loginPromise = null, loginPausedUntil = 0;
  function login() {
    if (Date.now() < loginPausedUntil) return Promise.reject(new Error('Sign-in needed'));
    if (!loginPromise) {
      loginPromise = (async () => {
        for (;;) {
          const pin = await ask({ title: 'Enter the PIN', text: 'The PIN is shown on the main computer, under Setup and status. Ask whoever looks after the Portal.', value: '', ok: 'Sign in' });
          if (pin === null) { loginPausedUntil = Date.now() + 30000; throw new Error('Sign-in needed'); }
          const r = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device': encodeURIComponent(S.who || 'Guest') }, body: JSON.stringify({ web: true, name: S.who || 'Guest', pin }) });
          if (r.ok) return;
          const d = await r.json().catch(() => ({}));
          toast(d.error || "That PIN isn't right", true);
        }
      })().finally(() => { loginPromise = null; });
    }
    return loginPromise;
  }
  const q = p => encodeURIComponent(p);
  const fileUrl = (p, inline) => `/api/file?path=${q(p)}${inline ? '&inline=1' : ''}`;

  // a picture that can't load just falls back to its label (done here because the page's security policy forbids inline handlers)
  document.addEventListener('error', e => { const t = e.target; if (t && t.tagName === 'IMG' && t.closest && t.closest('.tile.img')) t.remove(); }, true);

  // ---------- formatting ----------
  const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(1) + ' GB';
  function ago(t) {
    const d = Math.max(0, Date.now() / 1000 - t);
    if (d < 45) return 'Just now';
    if (d < 3600) return Math.round(d / 60) + ' min ago';
    if (d < 86400) return Math.round(d / 3600) + ' hr ago';
    const dt = new Date(t * 1000), now = new Date();
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: dt.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  const ext = n => (n.includes('.') ? n.split('.').pop() : '').toLowerCase();
  const KINDS = {
    cad: ['dxf', 'dwg', 'dwf', 'step', 'stp', 'igs', 'iges', 'stl', 'skp', '3dm'],
    pdf: ['pdf'],
    img: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'heic'],
    prog: ['mpr', 'mprx', 'xcs', 'cix', 'nc', 'tap', 'gcode', 'cnc', 'ptp', 'pgm'],
    sheet: ['xls', 'xlsx', 'csv', 'ods'],
  };
  const kindOf = n => { const e = ext(n); return Object.keys(KINDS).find(k => KINDS[k].includes(e)) || 'other'; };
  function tile(it, big) {
    if (it.dir) return `<div class="tile folder">${icon('folder')}</div>`;
    const k = kindOf(it.name), e = ext(it.name).slice(0, 4).toUpperCase() || 'FILE';
    if (k === 'img') return `<div class="tile img">${big ? '' : `<img loading="lazy" src="${fileUrl(it.path, true)}" alt="">`}${e}</div>`;
    return `<div class="tile ${k}">${e}</div>`;
  }
  const initials = n => n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avatar = n => `<div class="avatar" style="background:hsl(${hue(n)} 45% 42%)">${esc(initials(n))}</div>`;

  // ---------- toasts / dialogs ----------
  function toast(msg, bad) {
    const t = document.createElement('div');
    t.className = 'toast' + (bad ? ' bad' : '');
    t.textContent = msg;
    document.body.append(t);
    setTimeout(() => t.remove(), 3200);
  }
  function ask({ title, text = '', value = null, ok = 'OK', danger = false }) {
    return new Promise(res => {
      const d = $('#dlg'), inp = $('#dlg-input'), okb = $('#dlg-ok');
      $('#dlg-title').textContent = title;
      $('#dlg-text').textContent = text;
      $('#dlg-text').style.display = text ? '' : 'none';
      inp.style.display = value === null ? 'none' : '';
      inp.value = value ?? '';
      okb.textContent = ok;
      okb.classList.toggle('danger', danger);
      okb.classList.toggle('primary', !danger);
      const done = v => { d.close(); cleanup(); res(v); };
      const onOk = e => { e.preventDefault(); done(value === null ? true : inp.value.trim() || null); };
      const onCancel = () => done(null);
      const cleanup = () => { $('#dlg-form').removeEventListener('submit', onOk); $('#dlg-cancel').removeEventListener('click', onCancel); d.removeEventListener('cancel', onCancel); };
      $('#dlg-form').addEventListener('submit', onOk);
      $('#dlg-cancel').addEventListener('click', onCancel);
      d.addEventListener('cancel', onCancel);
      d.showModal();
      if (value !== null) { inp.focus(); inp.select(); }
    });
  }

  // ---------- who am I ----------
  async function initWho() {
    const params = new URLSearchParams(location.search);
    if (params.get('as')) { store.set('artema.who', params.get('as')); history.replaceState(null, '', location.pathname); }
    S.who = store.get('artema.who') || '';
    if (!S.who && S.info?.local) { S.who = S.info.name; store.set('artema.who', S.who); }
    if (!S.who) {
      const v = await ask({ title: 'Welcome to Artema Portal', text: "What should we call you? It's shown next to the files you add.", value: '', ok: 'Continue' });
      S.who = v || 'Guest';
      store.set('artema.who', S.who);
    }
    $('#who-text').textContent = S.who;
  }
  $('#who-change').onclick = async () => {
    const v = await ask({ title: 'Your name', value: S.who, ok: 'Save' });
    if (v) { S.who = v; store.set('artema.who', v); $('#who-text').textContent = v; }
  };

  // ---------- navigation ----------
  function setView(v) {
    S.view = v;
    $('.top').style.display = v === 'files' ? '' : 'none';          // search, New folder and Upload only make sense among the files
    $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v && !b.closest('.quick')));
    $$('.view').forEach(el => el.hidden = el.id !== 'view-' + v);
    if (v !== 'files') { closeDetail(); S.drawer = null; }
    if (v !== 'orders') S.order = null;
    refresh(true);
  }
  $$('[data-view]').forEach(b => b.onclick = () => { clearSearch(); setView(b.dataset.view); });
  function go(path) { clearSearch(); S.path = path; S.sel = null; closeDetail(); setView('files'); }

  function clearSearch() { S.q = ''; S.results = null; $('#q').value = ''; }

  // ---------- files view ----------
  async function loadFiles(force) {
    const data = S.results ? { items: S.results } : await api('list?path=' + q(S.path));
    const snap = JSON.stringify(data.items);
    if (!force && snap === S.snapshot) return;
    S.snapshot = snap;
    S.items = data.items;
    if (S.sel && !S.items.find(i => i.path === S.sel.path)) { S.sel = null; closeDetail(); }
    renderFiles();
  }
  function renderCrumbs() {
    if (S.results) return `<button>Results for “${esc(S.q)}”</button>`;
    const parts = S.path ? S.path.split('/') : [];
    let acc = '', html = `<button data-go="">All files</button>`;
    parts.forEach(p => { acc += (acc ? '/' : '') + p; html += `<span class="sep">/</span><button data-go="${esc(acc)}">${esc(p)}</button>`; });
    return html;
  }
  function renderFiles() {
    $('#crumbs').innerHTML = renderCrumbs();
    $$('#crumbs [data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
    const n = S.items.length, folders = S.items.filter(i => i.dir).length;
    $('#files-sub').textContent = S.results ? `${n} match${n === 1 ? '' : 'es'}` : n ? `${n - folders} file${n - folders === 1 ? '' : 's'}${folders ? `, ${folders} folder${folders === 1 ? '' : 's'}` : ''}` : '';
    const ha = $('#host-actions');
    ha.innerHTML = S.info?.local && !S.results ? `<button class="btn" id="btn-reveal">${icon('open')}Show in Explorer</button>` : '';
    if ($('#btn-reveal')) $('#btn-reveal').onclick = () => api('reveal', { path: S.path }).catch(e => toast(e.message, true));

    const el = $('#list');
    if (!n) {
      el.innerHTML = S.results
        ? `<div class="empty"><div class="ring">${icon('search')}</div><h3>Nothing found</h3><div>Try fewer words, or part of a name like “door” or “dxf”.</div></div>`
        : `<div class="empty"><div class="ring">${icon('upload')}</div><h3>Nothing here yet</h3><div>Drag files in, or press Upload.</div><button class="btn primary big" id="empty-up">${icon('upload')}Upload files</button></div>`;
      if ($('#empty-up')) $('#empty-up').onclick = () => $('#file').click();
      return;
    }
    el.innerHTML = `<div class="table"><div class="row th"><div>Name</div><div class="c-by">Added by</div><div class="c-date">Modified</div><div class="num">Size</div></div>${S.items.map(rowHtml).join('')}</div>`;
    $$('.row.item', el).forEach(r => {
      const it = S.items[+r.dataset.i];
      r.onclick = () => it.dir ? go(it.path) : select(it);
    });
  }
  function rowHtml(it, i) {
    const where = S.results ? it.path.split('/').slice(0, -1).join(' / ') : '';
    return `<div class="row item${S.sel?.path === it.path ? ' sel' : ''}" data-i="${i}">
      <div class="cell-name">${tile(it)}<div class="t"><div class="n">${esc(it.name)}</div>${where ? `<div class="p">${esc(where)}</div>` : ''}</div></div>
      <div class="muted c-by">${esc(it.by || (it.dir ? '' : '—'))}</div>
      <div class="muted c-date">${ago(it.mtime)}</div>
      <div class="muted num">${it.dir ? '' : fmtSize(it.size)}</div></div>`;
  }

  // ---------- details panel ----------
  function select(it) { S.sel = it; renderFiles(); openDetail(it); }
  function openDetail(it) {
    const k = kindOf(it.name);
    const prev = k === 'img' ? `<img src="${fileUrl(it.path, true)}" alt="">` : tile(it, true);
    const folder = it.path.split('/').slice(0, -1).join(' / ') || 'All files';
    $('#detail-in').innerHTML = `
      <button class="close" id="d-close" aria-label="Close">${icon('x')}</button>
      <div class="preview">${prev}</div>
      <h2>${esc(it.name)}</h2>
      <dl class="facts">
        <dt>Size</dt><dd>${fmtSize(it.size)}</dd>
        <dt>Modified</dt><dd>${new Date(it.mtime * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        <dt>Added by</dt><dd>${esc(it.by || 'Unknown')}</dd>
        <dt>Location</dt><dd>${esc(folder)}</dd>
      </dl>
      <div class="actions">
        <a class="btn primary big" href="${fileUrl(it.path)}" download>${icon('download')}Download</a>
        <div class="pair"><button class="btn" id="d-rename">${icon('pencil')}Rename</button><button class="btn danger" id="d-del">${icon('trash')}Delete</button></div>
      </div>`;
    $('#app').classList.add('has-detail');
    $('#d-close').onclick = () => { S.sel = null; closeDetail(); renderFiles(); };
    $('#d-rename').onclick = () => renameItem(it);
    $('#d-del').onclick = () => deleteItem(it);
  }
  function closeDetail() { $('#app').classList.remove('has-detail'); }
  async function renameItem(it) {
    const v = await ask({ title: 'Rename', value: it.name, ok: 'Save' });
    if (!v || v === it.name) return;
    const dir = it.path.split('/').slice(0, -1).join('/');
    try { await api('move', { from: it.path, to: (dir ? dir + '/' : '') + v }); S.sel = null; closeDetail(); await loadFiles(true); }
    catch (e) { toast(e.message, true); }
  }
  async function deleteItem(it) {
    const ok = await ask({ title: `Delete “${it.name}”?`, text: 'It will disappear from every computer. The main computer keeps a safety copy for a while.', ok: 'Delete', danger: true });
    if (!ok) return;
    try { await api('delete', { path: it.path }); S.sel = null; closeDetail(); await loadFiles(true); toast('Deleted'); }
    catch (e) { toast(e.message, true); }
  }

  $('#btn-new').onclick = async () => {
    const v = await ask({ title: 'New folder', value: '', ok: 'Create' });
    if (!v) return;
    try { await api('mkdir', { path: (S.path ? S.path + '/' : '') + v }); await loadFiles(true); loadQuick(); }
    catch (e) { toast(e.message, true); }
  };

  // ---------- search ----------
  let st;
  $('#q').addEventListener('input', e => {
    clearTimeout(st);
    const v = e.target.value.trim();
    st = setTimeout(async () => {
      S.q = v;
      if (S.view !== 'files') setView('files');
      if (!v) { S.results = null; closeDetail(); return loadFiles(true); }
      try { S.results = (await api('search?q=' + q(v))).items; S.snapshot = ''; await loadFiles(true); } catch (err) { toast(err.message, true); }
    }, 160);
  });
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); }
    if (e.key === 'Escape') {
      if (document.activeElement === $('#q')) { clearSearch(); $('#q').blur(); loadFiles(true); }
      else if (S.sel) { S.sel = null; closeDetail(); renderFiles(); }
    }
  });

  // ---------- search extras ----------
  const syncSearchUi = () => { $('#q-clear').hidden = !$('#q').value; $('#q').placeholder = innerWidth <= 820 ? 'Search files' : 'Search drawings, files, folders'; };
  $('#q').addEventListener('input', syncSearchUi); window.addEventListener('resize', syncSearchUi); syncSearchUi();
  $('#q-clear').onclick = () => { clearSearch(); syncSearchUi(); loadFiles(true); $('#q').focus(); };
  $('#scrim').onclick = () => { if (S.drawer) { S.drawer = null; closeDetail(); } else { S.sel = null; closeDetail(); renderFiles(); } };
  // ---------- uploads ----------
  const queue = []; let active = 0, uploadedAny = false;
  function enqueue(entries) {
    entries.forEach(e => queue.push(e));
    pump();
  }
  function pump() {
    while (active < 3 && queue.length) {
      const { file, path } = queue.shift();
      active++;
      uploadOne(file, path).finally(() => {
        active--; uploadedAny = true; pump();
        if (!active && !queue.length) { loadFiles(true); loadQuick(); }
      });
    }
  }
  function uploadOne(file, path) {
    const el = document.createElement('div');
    el.className = 'up';
    el.innerHTML = `<div class="l"><span>${esc(file.name)}</span><span>0%</span></div><div class="bar"><i></i></div>`;
    $('#tray').append(el);
    return new Promise(res => {
      const x = new XMLHttpRequest();
      x.open('PUT', `/api/file?path=${q(path)}&mtime=${Math.floor(file.lastModified / 1000)}`);
      x.setRequestHeader('X-Device', encodeURIComponent(S.who || 'Someone'));
      x.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const p = Math.round(e.loaded / e.total * 100);
        $('i', el).style.width = p + '%'; $('.l span:last-child', el).textContent = p + '%';
      };
      x.onload = () => {
        const ok = x.status < 300;
        el.classList.add(ok ? 'done' : 'fail');
        $('.l span:last-child', el).textContent = ok ? 'Done' : 'Failed';
        setTimeout(() => el.remove(), ok ? 3000 : 8000);
        res();
      };
      x.onerror = () => { el.classList.add('fail'); $('.l span:last-child', el).textContent = 'Failed'; setTimeout(() => el.remove(), 8000); res(); };
      x.send(file);
    });
  }
  const targetPath = name => (S.results ? '' : S.path ? S.path + '/' : '') + name;
  $('#btn-up').onclick = () => $('#file').click();
  $('#file').onchange = e => { enqueue([...e.target.files].map(f => ({ file: f, path: targetPath(f.name) }))); e.target.value = ''; };

  // drag and drop, folders included
  let depth = 0;
  const drop = $('#drop');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#drop-to').textContent = 'Into ' + (S.path || 'All files'); drop.classList.add('on'); });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; drop.classList.remove('on'); } });
  window.addEventListener('drop', async e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; drop.classList.remove('on');
    const items = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
    const out = [];
    const walk = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((ok, no) => entry.file(ok, no));
        out.push({ file, path: targetPath(prefix + entry.name) });
      } else {
        const reader = entry.createReader();
        let batch;
        do { batch = await new Promise((ok, no) => reader.readEntries(ok, no)); for (const c of batch) await walk(c, prefix + entry.name + '/'); } while (batch.length);
      }
    };
    if (items.length) for (const it of items) await walk(it, ''); else [...e.dataTransfer.files].forEach(f => out.push({ file: f, path: targetPath(f.name) }));
    if (out.length) enqueue(out);
  });

  // ---------- quick access ----------
  async function loadQuick() {
    try {
      const { items } = await api('list?path=');
      $('#quick').innerHTML = items.filter(i => i.dir).map(i => `<button class="nav" data-q="${esc(i.path)}">${icon('folder')}${esc(i.name)}</button>`).join('');
      $$('#quick [data-q]').forEach(b => b.onclick = () => go(b.dataset.q));
    } catch { }
  }

  // ---------- activity ----------
  const VERB = { added: 'added', updated: 'updated', deleted: 'deleted', renamed: 'renamed to', 'created folder': 'created folder' };
  async function loadActivity() {
    const { items } = await api('activity');
    $('#feed').innerHTML = items.length ? `<div class="feed">${items.map((e, i) => `
      <div class="ev" data-i="${i}">${avatar(e.who)}<div class="t"><div><b>${esc(e.who)}</b> ${VERB[e.action] || esc(e.action)} <b>${esc(e.path.split('/').pop())}</b></div>
      <div class="muted">${esc(e.path.split('/').slice(0, -1).join(' / ') || 'All files')}</div></div><div class="when">${ago(e.t)}</div></div>`).join('')}</div>`
      : `<div class="empty"><div class="ring">${icon('activity')}</div><h3>Quiet so far</h3><div>Uploads and changes will show up here.</div></div>`;
    $$('#feed .ev').forEach(r => r.onclick = () => { const e = items[+r.dataset.i]; if (e.action !== 'deleted') go(e.path.split('/').slice(0, -1).join('/')); });
  }

  // ---------- home ----------
  // The first screen: a greeting, four big buttons, and the doors in the shop. Nothing here needs explaining.
  const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
  async function loadHome(force) {
    let items = [], line = null;
    try { items = (await api('orders')).items; } catch (e) { if (!S.homeSnap) throw e; }
    try { line = await window.Portal.jobs.homeLine(); } catch { /* jobs unavailable: the other tiles still work */ }
    const snap = JSON.stringify([items, S.who, S.me && S.me.tag, line]);
    if (!force && snap === S.homeSnap) return;
    S.homeSnap = snap; S.orderItems = items;
    const good = items.filter(o => !o.error), tag = S.me && S.me.tag;
    const first = (S.who || '').trim().split(/\s+/)[0];
    const tiles = [
      ['work', 'work', 'My work', line ? line.text : 'What to do next', line && line.color || '#1f8f55'],
      ['board', 'board', 'Board', 'Every door, start to finish', '#c9760f'],
      ['orders', 'door', 'Door orders', good.length ? good.length + ' order form' + (good.length === 1 ? '' : 's') : 'Work orders for every department', '#b5373d'],
      ['files', 'files', 'Files', 'Drawings, programs and folders', '#3d63c9'],
    ].map(([v, ic, t, s, c]) => `<button class="bt" data-go-view="${v}" style="--c:${c}"><span class="bi">${icon(ic)}</span><span><b>${t}</b><span>${esc(s)}</span></span></button>`).join('');
    const recent = good.slice(0, 6).map(o => `<button class="dr" data-door="${esc(o.rel)}"><span class="doorpill">${esc(o.door || '?')}</span><span class="t"><b>${esc(both(o.f && o.f.customer, o.f && o.f.project) || o.name)}</b>${o.f && o.f.ship ? `<span>Ships ${esc(o.f.ship)}</span>` : ''}</span><span class="go">${icon('open')}</span></button>`).join('');
    $('#home').innerHTML = `<div class="hello"><h1>${greeting()}${first ? ', ' + esc(first) : ''}</h1><div class="sub">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${tag ? ' · ' + esc(tag) : ''}</div></div>
      <div class="big-tiles">${tiles}</div>
      <div class="home-links"><button data-go-view="activity">${icon('activity')}What's new</button><button data-go-view="computers">${icon('monitor')}Computers</button></div>
      ${recent ? `<div class="section-h"><h2>Doors in the shop</h2><button data-go-view="orders">See all</button></div><div class="doors">${recent}</div>` : ''}`;
    $$('#home [data-go-view]').forEach(b => b.onclick = () => setView(b.dataset.goView));
    $$('#home [data-door]').forEach(b => b.onclick = () => {
      const o = good.find(x => x.rel === b.dataset.door);
      setView('orders');
      if (o) openOrder(o);
    });
  }

  // ---------- door orders ----------
  // The order forms in the shared "Door Orders" folder. Every department sees the same orders, with the columns it works from
  // first; opening a door shows a clean work order (the same page that becomes the PDF) or, on request, the original Excel sheet.
  const DEPTS = ['CNC', 'Frame Prep', 'Paint', 'Assembly', 'Office'];
  const DCOL = { CNC: '#3d63c9', 'Frame Prep': '#1f8f55', Paint: '#c23a82', Assembly: '#c9760f', Office: '#6b6058' };
  const dash = v => (v ? esc(v) : '<span class="faint">\u2014</span>');
  const both = (a, b) => [a, b].filter(Boolean).join(' \u00b7 ');
  const COLS = {
    CNC: [['Panel series', f => f.series], ['Type', f => f.ptype], ['Size (W \u00d7 H)', f => f.size], ['Swing', f => f.swing], ['Hinge side', f => f.hingeSide],
      ['Hinges', f => (f.hingeQty || f.hingeFinish || f.hingeType ? '<b>' + esc(f.hingeQty || '?') + '</b> \u00d7 ' + (both(f.hingeFinish, f.hingeType) ? esc(both(f.hingeFinish, f.hingeType)) : '\u2014') : ''), true],
      ['Prepping', f => [f.deadbolt && 'DB prep ' + esc(f.deadbolt), f.multipoint && 'Multipoint ' + esc(f.multipoint)].filter(Boolean).join('<br>'), true]],
    'Frame Prep': [['Frame type', f => f.frameType], ['Door frame size', f => f.doorFrame], ['Jamb', f => f.jamb], ['Sill', f => both(f.sillType, f.sillDepth)], ['Brickmold', f => both(f.brickSize, f.brickType)], ['Hinges', f => both(f.hingeQty && f.hingeQty + ' hinges', f.hingeSide)]],
    Paint: [['Panel exterior', f => f.extFinish], ['Panel interior', f => f.intFinish], ['Frame out', f => f.frameOut], ['Frame in', f => f.frameIn], ['Sill colour', f => f.sillColour], ['Hinge finish', f => f.hingeFinish]],
    Assembly: [['Panel', f => both(f.series, f.ptype)], ['Size (W \u00d7 H)', f => f.size], ['Glass', f => both(f.glassSize, f.glassStyle)], ['Handle', f => both(f.handleStyle, f.lever)], ['Hardware', f => f.hardware], ['Swing', f => both(f.swing, f.hingeSide)]],
    Office: [['Customer', f => f.customer], ['Project', f => f.project], ['PO', f => f.po], ['Order #', f => f.orderNo], ['Ordered', f => f.orderDate], ['Ship date', f => f.ship], ['Price', f => f.price]],
  };
  const myDept = () => (DEPTS.includes(S.me && S.me.tag) ? S.me.tag : 'Office');
  const curDept = () => S.dept || myDept();
  const deptTabs = (id, on) => '<div class="stabs dtabs" id="' + id + '">' + DEPTS.map(d => '<button class="' + (d === on ? 'on' : '') + '" style="--dc:' + DCOL[d] + '" data-dept="' + esc(d) + '">' + esc(d) + (d === myDept() && S.me && S.me.tag ? '<i>yours</i>' : '') + '</button>').join('') + '</div>';

  async function loadOrders(force) {
    if (S.order) return;                                   // someone is reading an order: leave it alone
    const { items, inShop = [] } = await api('orders');
    if (S.order) return;                                   // one was opened while this was loading
    S.inShop = new Set(inShop);
    const snap = JSON.stringify([items, inShop]);
    if (!force && snap === S.ordersSnap) return;
    S.ordersSnap = snap; S.orderItems = items;
    renderOrders();
  }
  const inShop = o => !!(o.door && S.inShop && S.inShop.has(o.door.toLowerCase()));
  const shopBadge = o => (o.error || !o.door ? '' : inShop(o) ? '<span class="shopbadge in">In the shop</span>' : '<span class="shopbadge new">Not added</span>');
  function renderOrders() {
    const items = S.orderItems || [], dept = curDept(), cols = COLS[dept];
    $('#orders-crumbs').innerHTML = '<button>Door orders</button>';
    $('#orders-sub').textContent = items.length ? items.length + ' door' + (items.length === 1 ? '' : 's') + ' \u00b7 showing what ' + dept + ' needs' : 'Pick a department below to see what it needs';
    $('#orders-actions').innerHTML = '';
    if (!items.length) {
      $('#orders').innerHTML = `<div class="empty"><div class="ring">${icon('door')}</div><h3>No door orders yet</h3><div>Put the Excel order forms in the <b>Door Orders</b> folder and they show up here.</div><button class="btn primary big" id="orders-open">${icon('folder')}Open the folder</button></div>`;
      $('#orders-open').onclick = () => go('Door Orders');
      return;
    }
    const grid = 'grid-template-columns: minmax(0, 1.25fr) ' + cols.map(c => (c[2] ? 'minmax(0, 1.6fr)' : 'minmax(0, 1fr)')).join(' ');
    const head = '<div class="orow oth" style="' + grid + '"><div>Door</div>' + cols.map(c => '<div>' + esc(c[0]) + '</div>').join('') + '</div>';
    const rows = items.map((o, i) => {
      if (o.error) return '<div class="orow item" style="' + grid + '" data-i="' + i + '"><div class="door">' + dash(o.door || o.name) + '</div><div class="bad" style="grid-column: 2 / -1">' + esc(o.error) + '</div></div>';
      const sub = dept === 'Office' ? (o.f.ship ? 'Ships ' + o.f.ship : '') : (o.f.customer || '');
      return '<div class="orow item" style="' + grid + '" data-i="' + i + '" tabindex="0"><div class="door"><span class="doorpill">' + esc(o.door || '?') + '</span>' + shopBadge(o) + '<span class="muted sm">' + esc(sub) + '</span></div>'
        + cols.map(c => '<div data-l="' + esc(c[0]) + '">' + (c[2] ? (c[1](o.f) || dash('')) : dash(c[1](o.f))) + '</div>').join('') + '</div>';
    }).join('');
    const fresh = items.filter(o => !o.error && o.door && !inShop(o)).length;
    const addbar = fresh ? '<div class="addbar"><div><b>' + fresh + (fresh === 1 ? ' order form is' : ' order forms are') + ' not in the shop yet.</b><span>Add ' + (fresh === 1 ? 'it' : 'them') + ' so the departments see the work.</span></div><button class="btn primary" id="add-all">' + icon('plus') + 'Add to the shop</button></div>' : '';
    $('#orders').innerHTML = addbar + deptTabs('dtabs', dept) + '<div class="otable" style="--dc:' + DCOL[dept] + '">' + head + rows + '</div>';
    if (fresh) $('#add-all').onclick = () => window.Portal.jobs.addForms(null);
    $$('#dtabs [data-dept]').forEach(b => b.onclick = () => { S.dept = b.dataset.dept; renderOrders(); });
    $$('#orders .orow.item').forEach(r => {
      const o = items[+r.dataset.i];
      const open = () => openOrder(o);
      r.onclick = open; r.onkeydown = e => { if (e.key === 'Enter') open(); };
    });
  }
  /** One door: the work order for a department, or the original sheet. */
  async function openOrder(o, mode, sheet) {
    S.order = o; S.orderMode = mode || 'workorder';
    const dept = curDept();
    $('#orders-crumbs').innerHTML = '<button id="oc-back">Door orders</button><span class="sep">/</span><button>' + esc(o.door || o.name) + '</button>';
    $('#oc-back').onclick = () => { S.order = null; loadOrders(true).catch(e => toast(e.message, true)); };
    $('#orders-sub').textContent = both(o.f && o.f.customer, o.f && o.f.project);
    const wo = 'path=' + q(o.rel) + '&dept=' + q(dept);
    const shopBtn = o.error || !o.door ? '' : inShop(o) ? `<button class="btn" id="o-shop">${icon('work')}Open in the shop</button>` : `<button class="btn primary" id="o-shop">${icon('plus')}Add to the shop</button>`;
    $('#orders-actions').innerHTML = S.orderMode === 'workorder'
      ? `${shopBtn}<button class="btn" id="o-sheet">${icon('files')}Original sheet</button><button class="btn" id="o-print">Print</button><a class="btn primary" href="/api/orders/pdf?${wo}" download>${icon('download')}Save as PDF</a>`
      : `<button class="btn primary" id="o-wo">${icon('back')}Back to work order</button><a class="btn" href="${fileUrl('Door Orders/' + o.rel)}" download>${icon('download')}Download Excel</a>`;
    if (S.orderMode === 'workorder') {
      $('#orders').innerHTML = deptTabs('wtabs', dept) + '<iframe class="wo-frame" id="wo-frame" title="Work order" src="/api/orders/workorder?' + wo + '"></iframe>';
      $$('#wtabs [data-dept]').forEach(b => b.onclick = () => { S.dept = b.dataset.dept; openOrder(o); });
      if ($('#o-shop')) $('#o-shop').onclick = () => (inShop(o) ? window.Portal.jobs.openDoor(o.door) : window.Portal.jobs.addForms([o.rel]));
      $('#o-sheet').onclick = () => openOrder(o, 'sheet');
      $('#o-print').onclick = () => { try { $('#wo-frame').contentWindow.print(); } catch { toast("Printing isn't available here. Use Download PDF.", true); } };
      return;
    }
    $('#o-wo').onclick = () => openOrder(o);
    $('#orders').innerHTML = '<div class="empty"><div>Opening\u2026</div></div>';
    try {
      const d = await api('orders/sheet?path=' + q(o.rel) + '&sheet=' + q(sheet || ''));
      if (S.order !== o) return;
      const covered = new Set(), spans = new Map();
      d.merges.forEach(m => { spans.set(m.r + ',' + m.c, m); for (let r = 0; r < m.rs; r++) for (let c = 0; c < m.cs; c++) if (r || c) covered.add((m.r + r) + ',' + (m.c + c)); });
      const body = d.rows.map((row, r) => '<tr>' + row.map((v, c) => {
        const k = r + ',' + c; if (covered.has(k)) return '';
        const m = spans.get(k);
        return '<td' + (m && m.rs > 1 ? ' rowspan="' + m.rs + '"' : '') + (m && m.cs > 1 ? ' colspan="' + m.cs + '"' : '') + '>' + esc(v) + '</td>';
      }).join('') + '</tr>').join('');
      $('#orders').innerHTML = '<div class="stabs">' + d.sheets.map(n => '<button class="' + (n === d.name ? 'on' : '') + '" data-sheet="' + esc(n) + '">' + esc(n) + '</button>').join('') + '</div><div class="sheet-wrap"><table class="sheet">' + body + '</table></div>';
      $$('#orders [data-sheet]').forEach(b => b.onclick = () => openOrder(o, 'sheet', b.dataset.sheet));
    } catch (e) { $('#orders').innerHTML = '<div class="empty"><h3>Couldn\'t open this form</h3><div>' + esc(e.message) + '</div></div>'; }
  }

  // ---------- computers ----------
  // Mirrors roles.js: general < admin < dev, and nobody changes a computer, or hands out a role, above their own.
  const ROLES = [['general', 'General', 'Files and the shop floor'], ['admin', 'Admin', 'Also manages computers and the PIN'], ['dev', 'Dev', 'Full control, including this computer']];
  const rankOf = r => ROLES.findIndex(x => x[0] === r);
  const roleName = r => (ROLES[rankOf(r)] || ROLES[0])[1];
  const canAssignRole = (by, cur, next) => rankOf(by) >= 1 && rankOf(next) <= rankOf(by) && rankOf(cur) <= rankOf(by);
  const roleSelect = (d, me) => `<select class="role-sel r-${d.role}" data-role="${esc(d.id)}" data-name="${esc(d.name)}" data-cur="${d.role}" aria-label="Access level for ${esc(d.name)}"${ROLES.some(r => canAssignRole(me, d.role, r[0]) && r[0] !== d.role) ? '' : ' disabled'}>${
    ROLES.map(([k, label]) => `<option value="${k}"${k === d.role ? ' selected' : ''}${canAssignRole(me, d.role, k) ? '' : ' disabled'}>${label}</option>`).join('')}</select>`;

  // The main computer's own software, updated from the private GitHub repository. Only the main computer's "dev" level sees it.
  function updatePanel(su) {
    const busy = ['checking', 'downloading', 'ready'].includes(su.state);
    const bar = su.state === 'downloading' ? `<div class="bar"><i style="width:${su.progress || 0}%"></i></div>` : '';
    const line = { none: `You’re up to date.${su.checked ? ` Checked ${ago(su.checked / 1000)}.` : ''}`, idle: 'Not checked yet.' }[su.state] || su.message;
    const notes = su.state === 'available' && su.notes ? `<div class="notes muted sm">${esc(su.notes)}</div>` : '';
    return `<div class="panel upd"><div class="panel-h"><h3>Server software</h3><span class="muted sm">${su.current ? 'v' + esc(su.current) : ''}</span></div>
      <div class="upd-line ${su.state === 'error' || su.state === 'blocked' ? 'bad' : su.state === 'available' ? 'good' : ''}">${esc(line || '')}</div>${bar}${notes}
      <div class="upd-btns">
        ${su.state === 'unavailable' ? '' : `${su.state === 'available' ? `<button class="btn primary" id="su-install">Install v${esc(su.latest)}</button>` : `<button class="btn" id="su-check"${busy || !su.hasToken ? ' disabled' : ''}>Check now</button>`}
        <button class="btn" id="su-token"${busy ? ' disabled' : ''}>${su.hasToken ? 'New token' : 'Connect GitHub'}</button>${su.hasToken ? `<button class="btn danger" id="su-untoken"${busy ? ' disabled' : ''}>Disconnect</button>` : ''}`}
      </div>
      <div class="muted sm">After the server updates, connected computers update themselves.</div></div>`;
  }

  async function loadComputers() {
    const { devices, address, departments = [] } = await api('devices');
    if (document.activeElement?.matches?.('.role-sel')) return;          // don't pull a dropdown away while someone is choosing
    const me = S.role = (await api('me')).role;
    const manage = rankOf(me) >= 1;           // admins and the main computer run the suite; everyone else just sees who is connected
    const host = !!S.info?.local;
    $('#pc-count').textContent = devices.length;
    $('#suite-title').textContent = manage ? 'Control suite' : 'Computers';
    $('#suite-sub').textContent = manage ? 'Who is connected, which department each computer is in, and what it is allowed to do' : 'Everything connected to this Portal';

    const joined = devices.filter(d => !d.host);
    const count = r => joined.filter(d => d.role === r).length;
    const tiles = [
      ['Connected', `${devices.filter(d => d.online).length}<small> / ${devices.length}</small>`, 'online now', '#1f8f55'],
      ['General', count('general'), 'shop floor', '#6b6058'],
      ['Admin', count('admin'), 'manage computers', '#c9760f'],
      ['Dev', count('dev') + (devices.some(d => d.host) ? 1 : 0), 'full control', '#8f2c30'],
    ].map(([k, v, s, c]) => `<div class="tile-stat" style="--sc:${c}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');

    const rows = devices.map(d => `
      <div class="trow${d.online ? '' : ' off'}">
        <div class="who"><div class="pc">${icon('monitor')}</div><div class="nm"><b>${esc(d.name)}</b>${d.host ? '<span class="badge">Main</span>' : ''}
          <div class="muted sm">${esc(d.ip || '')}${d.version ? ` · v${esc(d.version)}` : ''}</div></div></div>
        <div class="state"><span class="dot ${d.online ? '' : 'idle'}"></span>${d.online ? 'Online' : d.last ? 'Seen ' + ago(d.last) : 'Offline'}</div>
        <div class="lvl">${d.host ? '<span class="rolechip r-dev">Dev</span>' : manage ? roleSelect(d, me) : `<span class="rolechip r-${d.role}">${roleName(d.role)}</span>`}</div>
        <div class="lvl">${d.host ? '<span class="muted sm">Main computer</span>' : manage ? `<select class="role-sel dept-sel" data-deptof="${esc(d.id)}" data-name="${esc(d.name)}" data-cur="${esc(d.tag || '')}" aria-label="Department for ${esc(d.name)}"><option value="">No department</option>${departments.map(x => `<option value="${esc(x)}"${x === d.tag ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select>` : d.tag ? `<span class="tagchip">${esc(d.tag)}</span>` : '<span class="muted sm">\u2014</span>'}</div>
        <div class="acts">${d.host || !manage || rankOf(d.role) > rankOf(me) ? '' : `<button class="btn danger" data-rm="${esc(d.id)}" data-name="${esc(d.name)}">${icon('trash')}Remove</button>`}</div>
      </div>`).join('');

    let pin = '', hist = [], su = null;
    if (me === 'dev') { try { su = await api('server/update'); } catch { /* shown next time */ } }
    if (manage) {
      try { pin = (await api('pin')).pin; } catch { /* shown next time */ }
      try { hist = (await api('devices/history')).items; } catch { /* shown next time */ }
    }
    const levels = ROLES.map(([k, l, s]) => `<li><span class="rolechip r-${k}">${l}</span> ${s}</li>`).join('');
    $('#suite').innerHTML = `
      ${manage ? `<div class="stats">${tiles}</div>` : ''}
      <div class="suite-grid">
        <div class="panel">
          <div class="panel-h"><h3>Computers</h3><span class="muted sm">${manage ? 'Change a computer’s access level from its menu' : ''}</span></div>
          <div class="ttable">${rows}</div>
        </div>
        <div class="side-col">
          <div class="panel add"><h3>Add a computer</h3>
            <div class="addr"><code id="addr">${esc(address)}</code><button class="btn" id="copy-addr">${icon('copy')}Copy</button></div>
            ${pin ? `<div class="addr" style="margin-top:10px"><code id="pin">${esc(pin)}</code><button class="btn" id="new-pin">New PIN</button></div>` : ''}
            <ol><li>On the new computer, open <b>Start Artema Portal</b>.</li><li>Choose <b>Connect to the main computer</b>.</li><li>It finds this one automatically${pin ? '. Enter the PIN above when it asks' : ', then asks for the PIN shown on the main computer'}.</li></ol></div>
          ${su ? updatePanel(su) : ''}
          ${manage ? `<div class="panel"><h3>Access levels</h3><ul class="levels">${levels}</ul>
            <div class="muted sm">New computers start as General. ${host ? '' : 'You can’t grant a level above your own. '}Changes apply immediately.</div></div>
          <div class="panel"><h3>Recent changes</h3>${hist.length ? `<ul class="hist">${hist.slice(0, 8).map(h => `<li><b>${esc(h.name)}</b> ${roleName(h.old_role)} → ${roleName(h.new_role)}<span class="muted sm">${ago(h.at)}${h.by ? ' · ' + esc(h.by) : ''}</span></li>`).join('')}</ul>` : '<div class="muted sm">No access changes yet.</div>'}</div>` : ''}
        </div>
      </div>`;
    $('#copy-addr').onclick = async () => { try { await navigator.clipboard.writeText(address); toast('Address copied'); } catch { toast(address); } };
    if ($('#new-pin')) $('#new-pin').onclick = async () => {
      if (await ask({ title: 'Make a new PIN?', text: 'Computers that are already connected keep working. The old PIN stops working, and anyone signed in through a web browser will need the new one.', ok: 'New PIN', danger: true })) {
        try { await api('pin/rotate', {}); loadComputers(); } catch (e) { toast(e.message, true); }
      }
    };
    if ($('#su-check')) $('#su-check').onclick = async () => { try { await api('server/update/check', {}); } catch (e) { toast(e.message, true); } loadComputers(); };
    if ($('#su-install')) $('#su-install').onclick = async () => {
      if (!await ask({ title: `Install version ${su.latest}?`, text: 'The server downloads it, then restarts. Files stay where they are. Connected computers reconnect on their own and then update themselves, one by one.', ok: 'Install and restart' })) return;
      try { await api('server/update/install', {}); } catch (e) { toast(e.message, true); }
      loadComputers();
    };
    if ($('#su-token')) $('#su-token').onclick = async () => {
      const v = await ask({ title: 'Connect to GitHub', text: (su.hasToken ? 'A token is saved. Paste a new one to replace it. ' : '') + 'Use a fine-grained GitHub token that can read this repository’s contents (read-only). It stays on this computer and is only sent to GitHub.', value: '', ok: 'Save' });
      if (!v) return;
      try { const r = await api('server/update/token', { token: v }); toast(r.state === 'error' ? r.message : 'Connected to GitHub', r.state === 'error'); } catch (e) { toast(e.message, true); }
      loadComputers();
    };
    if ($('#su-untoken')) $('#su-untoken').onclick = async () => {
      if (!await ask({ title: 'Disconnect from GitHub?', text: 'The saved token is deleted from this computer. You can connect again later.', ok: 'Disconnect', danger: true })) return;
      try { await api('server/update/token', { token: '' }); } catch (e) { toast(e.message, true); }
      loadComputers();
    };
    $$('[data-role]').forEach(sel => sel.onchange = async () => {
      const { role: id, name, cur } = sel.dataset, next = sel.value;
      const up = rankOf(next) > rankOf(cur);
      const ok = await ask({ title: `Make ${name} ${roleName(next)}?`, text: up ? `${name} will be able to do more: ${ROLES[rankOf(next)][2].toLowerCase()}.` : `${name} will lose some access straight away.`, ok: 'Change', danger: !up });
      if (!ok) { sel.value = cur; return; }
      try { await api('devices/role', { id, role: next }); toast(`${name} is now ${roleName(next)}`); } catch (e) { toast(e.message, true); }
      loadComputers();
    });
    $$('[data-deptof]').forEach(sel => sel.onchange = async () => {
      const { deptof: id, name } = sel.dataset;
      try { await api('devices/department', { id, dept: sel.value }); toast(sel.value ? `${name} is now in ${sel.value}` : `${name} has no department`); } catch (e) { toast(e.message, true); }
      loadComputers();
    });
    $$('[data-rm]').forEach(b => b.onclick = async () => {
      if (await ask({ title: `Remove ${b.dataset.name}?`, text: 'That computer will stop syncing until it connects again.', ok: 'Remove', danger: true })) {
        try { await api('devices/remove', { id: b.dataset.rm }); loadComputers(); } catch (e) { toast(e.message, true); }
      }
    });
  }

  // ---------- refresh loop ----------
  async function refresh(force) {
    try {
      if (S.view === 'home') await loadHome(force);
      else if (S.view === 'files') await loadFiles(force);
      else if (S.view === 'activity') await loadActivity();
      else if (S.view === 'orders') await loadOrders(force);
      else if (views[S.view]) await views[S.view](force);
      else await loadComputers();
      setConn(true);
    } catch { setConn(false); }
  }
  function setConn(ok) {
    $('#conn-dot').classList.toggle('off', !ok);
    $('#conn-text').textContent = ok ? 'Connected' : 'Offline';
    $('#banner').hidden = ok;
  }
  setInterval(() => { if (!document.hidden && !$('#dlg').open && !queue.length && !active && !S.results) refresh(false); }, 3000);

  // ---------- start ----------
  /** Opens one door's order form (by its path inside Door Orders), from anywhere. */
  async function showOrder(rel) {
    S.order = null;
    setView('orders');
    await loadOrders(true);
    const o = (S.orderItems || []).find(x => x.rel === rel);
    if (o) openOrder(o);
  }
  window.Portal = { $, $$, esc, icon, api, toast, ask, S, setView, closeDetail, ago, views, refresh, q, go, showOrder };
  window.addEventListener('DOMContentLoaded', async () => {
    try { S.info = await api('info'); } catch { setConn(false); }
    await initWho();
    let me = null;
    try { me = await api('me'); S.me = me; S.info = await api('info'); } catch { setConn(false); }          // signs in first if this browser has to
    api('devices').then(d => $('#pc-count').textContent = d.devices.length).catch(() => { });
    loadQuick();
    setView(window.Portal.jobs ? window.Portal.jobs.startView() : 'home');          // a computer whose department is known opens on its work
  });
})();
