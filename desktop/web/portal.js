(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = n => `<svg class="i"><use href="#i-${n}"/></svg>`;

  const S = { path: '', items: [], sel: null, view: 'files', q: '', who: '', info: null, snapshot: '', results: null };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } },
  };

  // ---------- api ----------
  const hdrs = () => ({ 'X-Device': encodeURIComponent(S.who || 'Someone') });
  async function api(path, body) {
    const opt = body === undefined ? { headers: hdrs() } :
      { method: 'POST', headers: { ...hdrs(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch('/api/' + path, opt);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  }
  const q = p => encodeURIComponent(p);
  const fileUrl = (p, inline) => `/api/file?path=${q(p)}${inline ? '&inline=1' : ''}`;

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
    if (k === 'img') return `<div class="tile img">${big ? '' : `<img loading="lazy" src="${fileUrl(it.path, true)}" alt="" onerror="this.remove()">`}${e}</div>`;
    return `<div class="tile ${k}">${e}</div>`;
  }
  const initials = n => n.trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  const hue = n => { let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const avatar = n => `<div class="avatar" style="background:hsl(${hue(n)} 38% 34%)">${esc(initials(n))}</div>`;

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
    $('.search').style.display = v === 'files' ? '' : 'none';
    $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === v && !b.closest('.quick')));
    $$('.view').forEach(el => el.hidden = el.id !== 'view-' + v);
    if (v !== 'files') closeDetail();
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
  $('#scrim').onclick = () => { S.sel = null; closeDetail(); renderFiles(); };
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

  // ---------- computers ----------
  async function loadComputers() {
    const { devices, address } = await api('devices');
    $('#pc-count').textContent = devices.length;
    const cards = devices.map(d => `
      <div class="card"><div class="top-line"><div class="pc">${icon('monitor')}</div>
        <div><h3>${esc(d.name)}</h3>${d.tag ? `<span class="tagchip">${esc(d.tag)}</span>` : ''}<div class="state"><span class="dot ${d.online ? '' : 'idle'}"></span>${d.online ? 'Online' : d.last ? 'Seen ' + ago(d.last) : 'Offline'}</div></div>
        ${d.host ? '<span class="badge">Main</span>' : ''}</div>
        ${d.host ? '' : `<div class="pair2"><button class="btn" data-tag="${esc(d.id)}" data-cur="${esc(d.tag || '')}">${icon('pencil')}Tag</button><button class="btn danger" data-rm="${esc(d.id)}" data-name="${esc(d.name)}">${icon('trash')}Remove</button></div>`}</div>`).join('');
    const addCard = `
      <div class="card add"><h3>Add a computer</h3>
        <div class="addr"><code id="addr">${esc(address)}</code><button class="btn" id="copy-addr">${icon('copy')}Copy</button></div>
        <ol><li>On the new computer, open <b>Start Artema Portal</b>.</li><li>Choose <b>Connect to the main computer</b>.</li><li>It finds this one automatically, or type the address above.</li></ol></div>`;
    $('#cards').innerHTML = cards + addCard;
    $('#copy-addr').onclick = async () => { try { await navigator.clipboard.writeText(address); toast('Address copied'); } catch { toast(address); } };
    $$('[data-tag]').forEach(b => b.onclick = async () => {
      const v = await ask({ title: 'Tag this computer', text: 'A short label like CNC, Office or Edgebander.', value: b.dataset.cur, ok: 'Save' });
      if (v !== null) { try { await api('devices/tag', { id: b.dataset.tag, tag: v }); loadComputers(); } catch (e) { toast(e.message, true); } }
    });
    $$('[data-rm]').forEach(b => b.onclick = async () => {
      if (await ask({ title: `Remove ${b.dataset.name}?`, text: 'That computer will stop syncing until it connects again.', ok: 'Remove', danger: true })) {
        await api('devices/remove', { id: b.dataset.rm }); loadComputers();
      }
    });
  }

  // ---------- refresh loop ----------
  async function refresh(force) {
    try {
      if (S.view === 'files') await loadFiles(force);
      else if (S.view === 'activity') await loadActivity();
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
  (async () => {
    try { S.info = await api('info'); } catch { setConn(false); }
    await initWho();
    api('devices').then(d => $('#pc-count').textContent = d.devices.length).catch(() => { });
    loadQuick();
    refresh(true);
  })();
})();
