'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFile } = require('child_process');

const APP_NAME = 'Artema Portal';
const VERSION = '1.0.0';

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
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

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

// ---- tiny http client (streams in both directions)
function request(method, urlStr, { headers = {}, body = null, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({ method, hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers, agent: false }, resolve);
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
function readAll(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}
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
function sendJson(res, obj, status = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length, 'Cache-Control': 'no-cache',
    ...(status >= 400 ? { Connection: 'close' } : {}),
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
  const rel = urlPath === '/' || urlPath === '' ? defaultPage : decodeURIComponent(urlPath.replace(/^\/+/, ''));
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
  APP_NAME, VERSION, HttpError, BAD_CHARS, ignored, readJson, writeJson, setLogFile, log, hide, lanIp, sleep,
  request, readAll, jsonRequest, guardRequest, sendJson, readBody, mimeOf, serveStatic, sendError,
};
