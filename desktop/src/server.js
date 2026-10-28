'use strict';
const fs = require('fs');
const https = require('https');
const {
  APP_NAME, VERSION, HttpError, lanIp, sendJson, readBody, mimeOf, serveStatic, sendError, guardRequest, cleanName, log,
} = require('./util');
const { FailLimiter, parseCookies, sessionCookie, joinProof, normPin, prettyPin, safeEqual, COOKIE, PORTAL_HEADERS } = require('./security');
const { can, canAssign, isRole, rank } = require('./roles');
const { DEPARTMENTS, departmentOf } = require('./departments');
const { renderWorkOrder } = require('./workorder');
const jobsApi = require('./jobs-api');

// With no role store (a caller that doesn't pass one) nobody is promoted: every joined computer is `general`.
const NO_ROLES = { get: () => 'general', set() { throw new HttpError(503, 'Roles are unavailable right now'); }, forget() { }, all: () => ({}) };

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const bearer = req => { const h = String(req.headers.authorization || ''); return /^Bearer /i.test(h) ? h.slice(7).trim() : ''; };
const headerName = req => { try { return cleanName(decodeURIComponent(req.headers['x-device'] || '')); } catch { return ''; } };

/**
 * The main computer's web server: the Portal UI plus the JSON/file API the sync agents use. Always https.
 *
 * Who may do what:
 *  - anyone on the network: load the Portal pages, ask who we are (/api/info), and try to join with the PIN
 *  - a joined computer or a signed-in browser: files, devices and activity, plus whatever its role allows (see roles.js)
 *  - this computer itself (loopback): everything, as role `dev`
 *
 * hooks: { tls: {key, cert, fingerprint}, getPin(), rotatePin(), trustLoopback(), reveal(full), roles: RoleStore, update: UpdateSource }
 */
function createPortalServer(store, port, webDir, hooks = {}) {
  const tls = hooks.tls;
  const roles = hooks.roles || NO_ROLES;
  const trustLoopback = () => (hooks.trustLoopback ? hooks.trustLoopback() : true);
  const pinGuess = new FailLimiter(10, 10 * 60 * 1000);          // 10 wrong PINs from one address, then a 10-minute pause

  /** The tabs a computer can be assigned to (none when jobs are unavailable). */
  const stationChoices = () => { try { return hooks.jobs && hooks.jobs.ok ? hooks.jobs.stationChoices() : []; } catch { return []; } };
  function authenticate(req) {
    if (isLoopback(req) && trustLoopback()) return { kind: 'host', name: store.hostName, role: 'dev' };
    const a = store.authToken(bearer(req) || parseCookies(req.headers.cookie)[COOKIE]);
    // looked up on every request, so a role change (or removal) takes effect straight away
    return a ? { ...a, role: a.kind === 'device' ? roles.get(a.id) : 'general' } : a;
  }
  function joinAllowed(b) {
    const pin = hooks.getPin && hooks.getPin();
    if (!pin) return false;
    if (typeof b.proof === 'string') return safeEqual(b.proof, joinProof(pin, tls.fingerprint));
    if (typeof b.pin === 'string') return safeEqual(normPin(b.pin), normPin(pin));
    return false;
  }

  const server = https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      for (const [k, v] of Object.entries(PORTAL_HEADERS)) res.setHeader(k, v);
      guardRequest(req);
      const u = new URL(req.url, 'https://x');
      const q = Object.fromEntries(u.searchParams);

      if (!u.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Not found');
        return serveStatic(res, webDir, u.pathname, 'index.html');
      }
      const ep = u.pathname.slice(5);
      const auth = authenticate(req);

      // ---- the two things a stranger may do
      if (req.method === 'GET' && ep === 'info') {
        const base = { app: APP_NAME, version: VERSION, app_version: hooks.appVersion || '', id: store.instanceId, name: store.hostName, port, tls: true };
        return sendJson(res, auth ? { ...base, ip: lanIp(), folder: auth.kind === 'host' ? store.root : undefined, local: auth.kind === 'host' } : base);
      }
      if (req.method === 'POST' && ep === 'register') {
        const ip = req.socket.remoteAddress || '';
        if (pinGuess.retryAfter(ip)) throw new HttpError(429, 'Too many wrong PINs. Wait a few minutes and try again.');
        const b = await readBody(req);
        if (!joinAllowed(b)) {
          pinGuess.fail(ip);
          log(`join refused: wrong PIN from ${ip}`);
          throw new HttpError(403, 'That PIN is not right');
        }
        pinGuess.clear(ip);
        if (b.web === true) {
          const name = cleanName(b.name, 40) || 'Guest';
          return sendJson(res, { ok: true, name }, 200, { 'Set-Cookie': sessionCookie(store.createWebSession(name)) });
        }
        const { id, token } = store.register(b.name, ip, b.id, b.tag);
        log(`computer joined: ${cleanName(b.name, 40)} from ${ip}`);
        return sendJson(res, { ok: true, id, token });
      }

      // ---- everything else needs a signed-in computer or browser
      if (!auth) throw new HttpError(401, 'Sign in required');
      const who = (auth.kind === 'host' ? headerName(req) : '') || auth.name || 'Someone';
      if (auth.id) store.touch(auth.id);
      const need = action => { if (!can(auth.role, action)) throw new HttpError(403, "This computer's role doesn't allow that"); };

      if (req.method === 'GET') {
        if (ep === 'me') {
          const ok = new Set(stationChoices().map(c => c.id));
          return sendJson(res, { kind: auth.kind, name: auth.name, role: auth.role, tag: (auth.id && store.devices[auth.id] && store.devices[auth.id].tag) || '', stations: ((auth.id && store.devices[auth.id] && store.devices[auth.id].stations) || []).filter(x => ok.has(x)) });
        }
        if (ep.startsWith('orders')) {
          if (!hooks.orders) throw new HttpError(404, 'Not found');
          if (ep === 'orders') return sendJson(res, { items: hooks.orders.list(), departments: DEPARTMENTS, inShop: hooks.jobs && hooks.jobs.ok ? hooks.jobs.numbers() : [] });
          if (ep === 'orders/sheet') return sendJson(res, hooks.orders.sheet(String(q.path || ''), String(q.sheet || '')));
          if (ep === 'orders/workorder' || ep === 'orders/pdf') {
            const order = hooks.orders.find(String(q.path || '')), dept = departmentOf(q.dept) || 'Office';
            if (order.error) throw new HttpError(400, order.error);
            const html = renderWorkOrder(order, dept);
            if (ep === 'orders/workorder') {
              // a page of our own, shown inside the Portal: no scripts, nothing from outside
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'" });
              return res.end(html);
            }
            if (!hooks.renderPdf) throw new HttpError(501, 'Making a PDF works in the installed app. Use Print instead.');
            const pdf = await hooks.renderPdf(html);
            const name = `Work order ${order.door || 'door'} - ${dept}.pdf`;
            res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
            return res.end(pdf);
          }
        }
        if (ep.startsWith('jobs/')) return sendJson(res, jobsApi.get(hooks.jobs, hooks.orders, ep, q));
        if (ep === 'list') return sendJson(res, { path: store.safe(q.path).rel, items: store.list(q.path) });
        if (ep === 'tree') return sendJson(res, { items: store.tree() });
        if (ep === 'search') return sendJson(res, { items: store.search(q.q) });
        if (ep === 'devices') {
          const choices = stationChoices();
          const ok = new Set(choices.map(c => c.id));
          return sendJson(res, { departments: DEPARTMENTS, stationChoices: choices, devices: store.deviceList().map(d => ({ ...d, stations: (d.stations || []).filter(x => ok.has(x)), role: d.host ? 'dev' : roles.get(d.id) })), address: `${lanIp()}:${port}` });
        }
        if (ep === 'devices/history') {
          need('devices.role');
          const names = Object.fromEntries(store.deviceList().map(d => [d.id, d.name]));
          return sendJson(res, { items: roles.history ? roles.history(30).map(h => ({ ...h, name: names[h.device_id] || 'Removed computer' })) : [] });
        }
        if (ep === 'server/update') {
          need('server.update');
          return sendJson(res, hooks.serverUpdate ? hooks.serverUpdate.status() : { state: 'unavailable', message: 'Updating from GitHub works in the installed server app.', hasToken: false });
        }
        if (ep === 'activity') return sendJson(res, { items: store.activity.slice(-60).reverse() });
        if (ep === 'update/manifest' || ep === 'update/file') {
          // the client app this server was built with; any joined computer may ask for it
          const m = hooks.update && hooks.update.manifest();
          if (!m) throw new HttpError(404, 'No update');
          if (ep === 'update/manifest') { if (auth.id) store.setVersion(auth.id, q.v); return sendJson(res, m); }
          const f = hooks.update.file(String(q.path || ''));
          if (!f) throw new HttpError(404, 'Not found');
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size });
          fs.createReadStream(f.full).on('error', () => res.destroy()).pipe(res);
          return;
        }
        if (ep === 'file') return sendFile(req, res, store, q);
        if (ep === 'pin') {
          need('pin.view');
          return sendJson(res, { pin: prettyPin(hooks.getPin()) });
        }
      } else if (req.method === 'PUT' && ep === 'file') {
        const { rel } = store.safe(q.path);
        if (!/^\d+$/.test(String(req.headers['content-length'] || ''))) throw new HttpError(411, 'Length required');
        const length = parseInt(req.headers['content-length'], 10);
        const mtime = /^\d+$/.test(q.mtime || '') ? parseInt(q.mtime, 10) : null;
        try {
          await store.putFile(rel, req, length, mtime, who, req.headers['x-expect']);
        } catch (e) {
          req.resume();
          throw e;
        }
        return sendJson(res, { ok: true });
      } else if (req.method === 'POST') {
        const b = await readBody(req);
        if (ep.startsWith('jobs/')) return sendJson(res, jobsApi.post(hooks.jobs, hooks.orders, ep, b, need));
        if (ep === 'mkdir') { store.mkdir(b.path, who); return sendJson(res, { ok: true }); }
        if (ep === 'delete') { store.delete(b.path, who); return sendJson(res, { ok: true }); }
        if (ep === 'move') { store.move(b.from, b.to, who); return sendJson(res, { ok: true }); }
        // changing who is on the network is for admins; nobody can touch a computer ranked above their own
        if (ep === 'devices/remove') {
          need('devices.remove');
          if (rank(roles.get(String(b.id))) > rank(auth.role)) throw new HttpError(403, "This computer's role doesn't allow that");
          store.removeDevice(String(b.id)); roles.forget(String(b.id));
          return sendJson(res, { ok: true });
        }
        if (ep === 'devices/department') {
          need('devices.tag');          // departments are handed out like access levels: by admins and the main computer
          const dept = b.dept ? departmentOf(b.dept) : '';
          if (b.dept && !dept) throw new HttpError(400, 'Unknown department');
          if (!store.devices[String(b.id)]) throw new HttpError(404, 'Not found');
          store.setTag(String(b.id), dept);
          log(`department: ${store.devices[String(b.id)].name} is now ${dept || 'none'} (set by ${who})`);
          return sendJson(res, { ok: true, department: dept });
        }
        if (ep === 'devices/stations') {
          need('devices.tag');          // like departments: handed out by admins and the main computer
          const id = String(b.id), d = store.devices[id];
          if (!d) throw new HttpError(404, 'Not found');
          const ok = new Set(stationChoices().map(c => c.id)), ids = (Array.isArray(b.stations) ? b.stations : []).map(Number);
          if (!ids.every(x => ok.has(x))) throw new HttpError(400, 'Unknown station');
          store.setStations(id, ids);
          log(`stations: ${d.name} now opens on ${ids.length ? stationChoices().filter(c => ids.includes(c.id)).map(c => c.name).join(', ') : 'nothing in particular'} (set by ${who})`);
          return sendJson(res, { ok: true, stations: ids });
        }
        if (ep === 'devices/tag') { need('devices.tag'); store.setTag(String(b.id), b.tag); return sendJson(res, { ok: true }); }
        if (ep === 'devices/role') {
          need('devices.role');
          const id = String(b.id), role = String(b.role);
          if (!isRole(role)) throw new HttpError(400, 'Role must be general, admin or dev');
          if (id === 'host' || !store.devices[id]) throw new HttpError(404, 'Not found');
          if (!canAssign(auth.role, roles.get(id), role)) throw new HttpError(403, "This computer's role doesn't allow that");
          roles.set(id, role, who);
          log(`role: ${store.devices[id].name} is now ${role} (set by ${who})`);
          return sendJson(res, { ok: true, role });
        }
        if (ep.startsWith('server/update/')) {
          need('server.update');
          const su = hooks.serverUpdate;
          if (!su) throw new HttpError(400, 'Updating from GitHub works in the installed server app.');
          if (ep === 'server/update/check') return sendJson(res, await su.check());
          if (ep === 'server/update/install') return sendJson(res, su.install());
          if (ep === 'server/update/token') return sendJson(res, await su.setToken(String(b.token || '').trim()));
        }
        if (ep === 'pin/rotate') {
          need('pin.rotate');
          return sendJson(res, { ok: true, pin: prettyPin(hooks.rotatePin()) });
        }
        if (ep === 'reveal') {
          need('files.reveal');
          const { full } = store.safe(b.path);
          if (hooks.reveal) hooks.reveal(full);
          return sendJson(res, { ok: true });
        }
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      sendError(res, e);
    }
  });
  server.requestTimeout = 0;            // big CAD files can take longer than Node's default 5 minutes to upload
  server.headersTimeout = 60000;
  server.on('tlsClientError', () => { /* a probe, a plain-http client or a wrong certificate: nothing to do */ });
  return server;
}

function sendFile(req, res, store, q) {
  const { full, rel } = store.safe(q.path);
  let st;
  try { st = fs.statSync(full); } catch { throw new HttpError(404, 'Not found'); }
  if (!st.isFile()) throw new HttpError(404, 'Not found');
  const name = rel.split('/').pop();
  const ctype = mimeOf(name);
  // SVG can carry scripts: it is only ever shown as a picture inside our own pages, never opened as a page of its own
  const inline = q.inline === '1' && /^(image\/(?!svg)|application\/pdf|text\/)/.test(ctype);
  // Whatever people upload is data: it may display, but it can never run anything on the Portal's own origin
  if (ctype === 'application/pdf') res.removeHeader('Content-Security-Policy');       // the browser's PDF viewer needs to run
  else res.setHeader('Content-Security-Policy', 'sandbox');
  res.writeHead(200, {
    'Content-Type': ctype, 'Content-Length': st.size, 'Cache-Control': 'private, no-cache',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  if (req.method === 'HEAD') return res.end();
  require('stream').pipeline(fs.createReadStream(full), res, () => { /* client left or file vanished: both ends already closed */ });
}

module.exports = { createPortalServer };
