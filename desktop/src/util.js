'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const tls = require('tls');
const { execFile } = require('child_process');

const APP_NAME = 'Artema Portal';
const VERSION = '1.1.0';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
const ignored = name => {
  const n = name.toLowerCase();
  return n.startsWith('.') || n.startsWith('~$') || n === 'desktop.ini' || n === 'thumbs.db' || /\.(tmp|part|crdownload)$/.test(n);
};

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj, mode = 0o644) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode });     // secrets pass 0o600: readable by this user only (no effect on Windows, where the profile folder is already private)
  fs.renameSync(tmp, p);
}

/** A display name that is safe to store and show: no control characters, trimmed, bounded. */
const cleanName = (s, max = 60) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

let logFile = null;
function setLogFile(p) { logFile = p; }
function log(msg) {
  if (!logFile) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1e6) fs.renameSync(logFile, logFile.replace(/\.log$/, '.old.log'));
    fs.appendFileSync(logFile, `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${msg}\n`);
  } catch { /* logging must never break the app */ }
}

function hide(p) {
  if (process.platform === 'win32') execFile('attrib', ['+h', p], { windowsHide: true }, () => { });
}

function lanIp() {
  const found = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) found.push(i.address);
  }
  const rank = a => a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3;
  found.sort((a, b) => rank(a) - rank(b));
  return found[0] || '127.0.0.1';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- tiny http(s) client (streams in both directions)
/**
 * https talks to a main computer's self-signed certificate. There are two ways to trust it:
 *  - `ca`: the exact certificate pinned when this computer joined. Anything else fails the handshake, before a single
 *    byte (the token included) is sent. Host names are not checked: the pinned certificate IS the identity, which is also
 *    why the main computer can change address without breaking anything.
 *  - neither: first contact only (finding a main computer, learning its certificate). Nothing secret is sent that way.
 */
/**
 * An agent that connects only to the one pinned certificate. The check is a plain comparison of the certificate's SHA-256, made
 * as soon as the handshake finishes and BEFORE the request is released, so nothing (the token included) is ever sent to anything
 * else. It does not lean on certificate-chain rules: Electron's TLS library refuses to treat a self-signed server certificate as a
 * trust anchor, which is how pinning with `ca` works in plain Node but fails in the packaged app.
 */
function pinnedAgent(pem) {
  const crypto = require('crypto');
  const sha = der => crypto.createHash('sha256').update(der).digest('hex');
  const want = sha(new crypto.X509Certificate(pem).raw);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (options, cb) => {
    let done = false;
    const finish = (err, sock) => { if (!done) { done = true; cb(err, sock); } };
    const sock = tls.connect({ host: options.hostname || options.host, port: options.port, minVersion: 'TLSv1.2', rejectUnauthorized: false });
    sock.once('secureConnect', () => {
      let got = '';
      try { const c = sock.getPeerCertificate(); got = c && c.raw ? sha(c.raw) : ''; } catch { /* no certificate */ }
      if (got && got === want) finish(null, sock);
      else { sock.destroy(); finish(Object.assign(new Error('the certificate is not the one that was pinned'), { code: 'CERT_MISMATCH' })); }
    });
    sock.once('error', e => finish(e));
    return undefined;          // the connection is handed over through the callback, once it has been checked
  };
  return agent;
}
function request(method, urlStr, { headers = {}, body = null, timeout = 15000, ca = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const secure = u.protocol === 'https:';
    const opts = { method, hostname: u.hostname, port: u.port || (secure ? 443 : 80), path: u.pathname + u.search, headers, agent: false };
    if (secure) {
      opts.minVersion = 'TLSv1.2';
      if (ca) opts.agent = pinnedAgent(ca);          // only the exact certificate that was pinned gets to see this request
      else opts.rejectUnauthorized = false;
    }
    const req = (secure ? https : http).request(opts, resolve);
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (body && typeof body.pipe === 'function') {
      // a file that is locked or vanishes mid-upload must fail this one request, never crash the app
      body.on('error', e => req.destroy(e));
      req.on('close', () => body.destroy());
      body.pipe(req);
    } else req.end(body || undefined);
  });
}
/** The PEM of the certificate on the other end of a response (https only). */
function peerCertPem(res) {
  try { const c = res.socket.getPeerCertificate(true); return c && c.raw ? require('./security').pemFromDer(c.raw) : ''; } catch { return ''; }
}
function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}
const TLS_IDENTITY_ERRORS = new Set([
  'CERT_MISMATCH',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', 'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
]);
async function jsonRequest(method, url, opts = {}) {
  const res = await request(method, url, opts);
  const buf = await readAll(res);
  let data = {};
  try { data = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  if (res.statusCode >= 400) throw Object.assign(new Error(data.error || `HTTP ${res.statusCode}`), { status: res.statusCode });
  return data;
}

// ---- server helpers
/**
 * Keeps other websites from driving the Portal through the visitor's browser.
 * Changes must carry a custom header (a web page can't add one without a permission check the server never grants),
 * and the address used must look like a LAN machine, not an attacker's domain re-pointed at us (DNS rebinding).
 */
function guardRequest(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const lanLike = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host === '[::1]' || !host.includes('.') || host.endsWith('.local');
  if (!lanLike) throw new HttpError(403, 'Not allowed');
  if ((req.method === 'POST' || req.method === 'PUT') && !req.headers['x-device']) throw new HttpError(403, 'Not allowed');
}
function sendJson(res, obj, status = 200, extra = {}) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-store',
    ...(status >= 400 ? { Connection: 'close' } : {}), ...extra,
  });
  res.end(b);
}
function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Bad request')); } });
    req.on('error', reject);
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
const mimeOf = n => MIME[path.extname(n).toLowerCase()] || 'application/octet-stream';

function serveStatic(res, webDir, urlPath, defaultPage) {
  let rel;
  try { rel = urlPath === '/' || urlPath === '' ? defaultPage : decodeURIComponent(urlPath.replace(/^\/+/, '')); } catch { throw new HttpError(400, 'Bad request'); }
  if (rel.includes('\0')) throw new HttpError(400, 'Bad request');
  const full = path.resolve(webDir, rel);
  if (!full.startsWith(path.resolve(webDir) + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw new HttpError(404, 'Not found');
  const data = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': mimeOf(full), 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
  res.end(data);
}
function sendError(res, e) {
  let status = 500, msg = 'Something went wrong';
  if (e instanceof HttpError) { status = e.status; msg = e.message; }
  else if (e && e.code === 'ENOENT') { status = 404; msg = 'Not found'; }
  else if (e && e.code === 'EEXIST') { status = 409; msg = 'That already exists'; }
  else log('handler error: ' + (e && e.stack || e));
  if (res.headersSent) { res.destroy(); return; }
  try { sendJson(res, { error: msg }, status); } catch { res.destroy(); }
}

module.exports = {
  APP_NAME, VERSION, HttpError, BAD_CHARS, ignored, readJson, writeJson, cleanName, setLogFile, log, hide, lanIp, sleep,
  request, peerCertPem, TLS_IDENTITY_ERRORS, readAll, jsonRequest, guardRequest, sendJson, readBody, mimeOf, serveStatic, sendError,
};
