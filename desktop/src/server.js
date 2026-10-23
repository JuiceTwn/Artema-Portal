'use strict';
const fs = require('fs');
const http = require('http');
const {
  APP_NAME, VERSION, HttpError, lanIp, sendJson, readBody, mimeOf, serveStatic, sendError, guardRequest,
} = require('./util');

const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

/** The main computer's web server: the Portal UI plus the JSON/file API the sync agents use. */
function createPortalServer(store, port, webDir, hooks = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      guardRequest(req);
      const u = new URL(req.url, 'http://x');
      const q = Object.fromEntries(u.searchParams);
      const who = (() => { try { return decodeURIComponent(req.headers['x-device'] || '').trim().slice(0, 60) || 'Someone'; } catch { return 'Someone'; } })();
      const did = req.headers['x-device-id'];
      if (did) store.touch(did);

      if (!u.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'Not found');
        return serveStatic(res, webDir, u.pathname, 'index.html');
      }
      const ep = u.pathname.slice(5);

      if (req.method === 'GET') {
        if (ep === 'info') return sendJson(res, { app: APP_NAME, version: VERSION, id: store.instanceId, name: store.hostName, ip: lanIp(), port, folder: store.root, local: isLoopback(req) });
        if (ep === 'list') return sendJson(res, { path: store.safe(q.path).rel, items: store.list(q.path) });
        if (ep === 'tree') return sendJson(res, { items: store.tree() });
        if (ep === 'search') return sendJson(res, { items: store.search(q.q) });
        if (ep === 'devices') return sendJson(res, { devices: store.deviceList(), address: `${lanIp()}:${port}` });
        if (ep === 'activity') return sendJson(res, { items: store.activity.slice(-60).reverse() });
        if (ep === 'file') return sendFile(req, res, store, q);
      } else if (req.method === 'PUT' && ep === 'file') {
        const { rel } = store.safe(q.path);
        const length = parseInt(req.headers['content-length'] || '0', 10);
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
        if (ep === 'register') return sendJson(res, { ok: true, id: store.register(b.name, req.socket.remoteAddress, b.id, b.tag) });
        if (ep === 'devices/remove') { store.removeDevice(b.id); return sendJson(res, { ok: true }); }
        if (ep === 'devices/tag') { store.setTag(b.id, b.tag); return sendJson(res, { ok: true }); }
        if (ep === 'reveal') {
          if (!isLoopback(req)) throw new HttpError(403, 'Only available on the main computer');
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
  return server;
}

function sendFile(req, res, store, q) {
  const { full, rel } = store.safe(q.path);
  let st;
  try { st = fs.statSync(full); } catch { throw new HttpError(404, 'Not found'); }
  if (!st.isFile()) throw new HttpError(404, 'Not found');
  const name = rel.split('/').pop();
  const ctype = mimeOf(name);
  const inline = q.inline === '1' && /^(image\/|application\/pdf|text\/)/.test(ctype);
  res.writeHead(200, {
    'Content-Type': ctype, 'Content-Length': st.size, 'Cache-Control': 'no-cache',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  if (req.method === 'HEAD') return res.end();
  require('stream').pipeline(fs.createReadStream(full), res, () => { /* client left or file vanished: both ends already closed */ });
}

module.exports = { createPortalServer };
