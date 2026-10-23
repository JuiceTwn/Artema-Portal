'use strict';
const fs = require('fs');
const https = require('https');
const {
  APP_NAME, VERSION, HttpError, lanIp, sendJson, readBody, mimeOf, serveStatic, sendError, guardRequest, cleanName, log,
} = require('./util');
const { FailLimiter, parseCookies, sessionCookie, joinProof, normPin, prettyPin, safeEqual, COOKIE, PORTAL_HEADERS } = require('./security');
const { can, canAssign, isRole, rank } = require('./roles');

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
 * hooks: { tls: {key, cert, fingerprint}, getPin(), rotatePin(), trustLoopback(), reveal(full), roles: RoleStore }
 */
function createPortalServer(store, port, webDir, hooks = {}) {
  const tls = hooks.tls;
  const roles = hooks.roles || NO_ROLES;
  const trustLoopback = () => (hooks.trustLoopback ? hooks.trustLoopback() : true);
  const pinGuess = new FailLimiter(10, 10 * 60 * 1000);          // 10 wrong PINs from one address, then a 10-minute pause

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
        const base = { app: APP_NAME, version: VERSION, id: store.instanceId, name: store.hostName, port, tls: true };
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
        if (ep === 'me') return sendJson(res, { kind: auth.kind, name: auth.name, role: auth.role });
        if (ep === 'list') return sendJson(res, { path: store.safe(q.path).rel, items: store.list(q.path) });
        if (ep === 'tree') return sendJson(res, { items: store.tree() });
        if (ep === 'search') return sendJson(res, { items: store.search(q.q) });
        if (ep === 'devices') return sendJson(res, { devices: store.deviceList().map(d => ({ ...d, role: d.host ? 'dev' : roles.get(d.id) })), address: `${lanIp()}:${port}` });
        if (ep === 'activity') return sendJson(res, { items: store.activity.slice(-60).reverse() });
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
