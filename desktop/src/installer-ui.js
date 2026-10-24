'use strict';
/**
 * The window shown while the app installs itself the first time it runs: one self-contained page, no network.
 * The app drives it by calling window.setStatus({ step, pct, text, bytes }) from the main process.
 */
const STEPS = ['Closing older versions', 'Installing program files', 'Adding shortcuts', 'Starting up'];

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function splashHtml({ name, version, logo }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
  body { font: 13px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: #f6efe6; -webkit-user-select: none; user-select: none; }
  .card { position: absolute; inset: 0; border-radius: 20px; overflow: hidden; border: 1px solid rgba(251, 238, 223, .14); -webkit-app-region: drag;
    background: radial-gradient(520px 300px at 0% -10%, rgba(123, 37, 40, .55), transparent 65%), radial-gradient(420px 260px at 105% 110%, rgba(204, 125, 20, .22), transparent 60%), #0a0b0f; }
  .glow { position: absolute; width: 320px; height: 320px; right: -110px; top: -120px; border-radius: 50%;
    background: conic-gradient(from 0deg, rgba(204, 125, 20, 0), rgba(204, 125, 20, .35), rgba(168, 52, 58, .4), rgba(204, 125, 20, 0)); filter: blur(34px); animation: spin 7s linear infinite; }
  .top { position: relative; padding: 30px 34px 0; display: flex; align-items: center; justify-content: space-between; }
  .top img { height: 22px; display: block; animation: rise .7s cubic-bezier(.2, .8, .2, 1) both; }
  .ver { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: rgba(246, 239, 230, .45); font-weight: 600; }
  h1 { position: relative; margin: 26px 34px 2px; font-size: 24px; font-weight: 600; letter-spacing: .005em; animation: rise .7s .08s cubic-bezier(.2, .8, .2, 1) both; }
  .sub { position: relative; margin: 0 34px; color: rgba(246, 239, 230, .56); animation: rise .7s .14s cubic-bezier(.2, .8, .2, 1) both; }
  .steps { position: relative; margin: 22px 34px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 9px 18px; }
  .step { display: flex; align-items: center; gap: 10px; color: rgba(246, 239, 230, .38); transition: color .3s; font-weight: 500; }
  .step .mark { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid rgba(246, 239, 230, .25); display: grid; place-items: center; flex: none; transition: all .3s; position: relative; }
  .step.active { color: #f6efe6; }
  .step.active .mark { border-color: rgba(204, 125, 20, .35); border-top-color: #e39a2f; animation: spin .8s linear infinite; }
  .step.done { color: rgba(246, 239, 230, .75); }
  .step.done .mark { background: #cc7d14; border-color: #cc7d14; }
  .step.done .mark::after { content: ""; width: 4px; height: 8px; border: solid #1a1106; border-width: 0 2px 2px 0; transform: rotate(45deg) translate(-1px, -1px); }
  .foot { position: absolute; left: 34px; right: 34px; bottom: 26px; }
  .bar { height: 6px; border-radius: 6px; background: rgba(251, 238, 223, .1); overflow: hidden; position: relative; }
  .bar i { display: block; height: 100%; width: 0; border-radius: 6px; background: linear-gradient(90deg, #a8343a, #cc7d14 60%, #e39a2f); transition: width .25s ease-out; position: relative; overflow: hidden; }
  .bar i::after { content: ""; position: absolute; inset: 0; background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, .45) 50%, transparent 70%); transform: translateX(-100%); animation: sheen 1.4s ease-in-out infinite; }
  .line { display: flex; justify-content: space-between; margin-top: 10px; font-size: 12px; color: rgba(246, 239, 230, .56); }
  .line b { color: #f6efe6; font-weight: 600; font-variant-numeric: tabular-nums; }
  .err .bar i { background: #ef6a63; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes sheen { to { transform: translateX(100%); } }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
</style></head><body>
<div class="card" id="card"><div class="glow"></div>
  <div class="top">${logo ? `<img src="${logo}" alt="Artema">` : '<b>ARTEMA</b>'}<span class="ver">${version ? 'Version ' + esc(version) : ''}</span></div>
  <h1>Installing ${esc(name)}</h1>
  <p class="sub" id="sub">Setting things up on this computer. This only takes a moment.</p>
  <div class="steps">${STEPS.map((s, i) => `<div class="step" id="s${i}"><span class="mark"></span>${esc(s)}</div>`).join('')}</div>
  <div class="foot"><div class="bar"><i id="bar"></i></div><div class="line"><span id="text">Getting ready…</span><b id="pct">0%</b></div></div>
</div>
<script>
  window.setStatus = function (s) {
    for (var i = 0; i < ${STEPS.length}; i++) { var el = document.getElementById('s' + i); el.className = 'step' + (i < s.step || s.done ? ' done' : i === s.step ? ' active' : ''); }
    var p = Math.max(0, Math.min(100, Math.round(s.pct || 0)));
    document.getElementById('bar').style.width = p + '%';
    document.getElementById('pct').textContent = s.done ? 'Done' : p + '%';
    if (s.text) document.getElementById('text').textContent = s.text;
    if (s.sub) document.getElementById('sub').textContent = s.sub;
    if (s.error) document.getElementById('card').classList.add('err');
  };
  window.setStatus({ step: 0, pct: 2 });
</script></body></html>`;
}

module.exports = { splashHtml, STEPS };
