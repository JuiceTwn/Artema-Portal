'use strict';
/**
 * Security building blocks for the main computer and the sync agents:
 *  - the join PIN (how a new computer proves it is allowed in) and the proof it sends instead of the PIN itself
 *  - device / browser tokens (random, stored only as hashes on the main computer)
 *  - the self-signed TLS certificate that encrypts all traffic, and the fingerprint helpers used to pin it
 *  - a small failed-attempt limiter, cookie parsing, and secrets sealing
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // no I, O, 0, 1: easy to read out loud
const PIN_LENGTH = 10;                                           // 32^10 = 50 bits
const COOKIE = 'artema_token';
const WEB_SESSION_DAYS = 30;

// ---- join PIN
function genPin() {
  let s = '';
  for (let i = 0; i < PIN_LENGTH; i++) s += PIN_ALPHABET[crypto.randomInt(PIN_ALPHABET.length)];
  return s;
}
const normPin = p => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const prettyPin = p => { const n = normPin(p); return n.length === PIN_LENGTH ? `${n.slice(0, 5)}-${n.slice(5)}` : n; };

/** Constant-time string comparison that doesn't leak the length either. */
function safeEqual(a, b) {
  const da = crypto.createHash('sha256').update(String(a)).digest();
  const db = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * What a computer sends to join instead of the PIN: HMAC(PIN, "the fingerprint of the certificate I am talking to").
 * The main computer computes the same thing from its own certificate, so a man in the middle that presents a
 * different certificate can neither learn the PIN nor produce a proof the real main computer will accept.
 */
function joinProof(pin, fingerprint) {
  return crypto.createHmac('sha256', normPin(pin)).update('artema-join-v1|' + String(fingerprint).toLowerCase()).digest('hex');
}

// ---- tokens
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');

// ---- certificates
function fingerprintOfPem(pem) {
  return new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase();
}
const pemFromDer = der => `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;

/**
 * The main computer's certificate. Created once and kept (clients pin it), valid for ten years.
 * The private key is sealed with the operating system's key store when that's available, and is otherwise
 * a file only this user can read.
 */
async function loadOrCreateCert(dir, { seal, unseal, hostnames = [], ips = [] } = {}) {
  const certPath = path.join(dir, 'cert.pem'), keyPath = path.join(dir, 'key.pem'), sealedPath = path.join(dir, 'key.sealed');
  try {
    const cert = fs.readFileSync(certPath, 'utf8');
    let key = null;
    if (fs.existsSync(sealedPath) && unseal) key = unseal(fs.readFileSync(sealedPath, 'utf8'));
    else if (fs.existsSync(keyPath)) key = fs.readFileSync(keyPath, 'utf8');
    if (key && new Date(new crypto.X509Certificate(cert).validTo) > new Date(Date.now() + 30 * 86400e3)) {
      return { cert, key, fingerprint: fingerprintOfPem(cert) };
    }
  } catch { /* none yet, or unreadable: make a new one */ }

  const selfsigned = require('selfsigned');
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }];
  for (const h of hostnames) if (h) altNames.push({ type: 2, value: h });
  for (const ip of ips) if (ip && ip !== '127.0.0.1') altNames.push({ type: 7, ip });
  const now = Date.now();
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Artema Portal' }], {
    keyType: 'ec', curve: 'P-256', algorithm: 'sha256',
    notBeforeDate: new Date(now - 86400e3), notAfterDate: new Date(now + 3650 * 86400e3),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyAgreement: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  });
  fs.mkdirSync(dir, { recursive: true });
  const sealed = seal ? seal(pems.private) : null;
  fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
  if (sealed) { fs.writeFileSync(sealedPath, sealed, { mode: 0o600 }); try { fs.unlinkSync(keyPath); } catch { /* none */ } }
  else { fs.writeFileSync(keyPath, pems.private, { mode: 0o600 }); try { fs.unlinkSync(sealedPath); } catch { /* none */ } }
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprintOfPem(pems.cert) };
}

// ---- brute-force protection
/** Counts failures per key (an IP address). After `max` failures inside the window the key is blocked until it passes. */
class FailLimiter {
  constructor(max = 10, windowMs = 10 * 60 * 1000) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  prune(now) { for (const [k, v] of this.hits) if (now - v.first > this.windowMs) this.hits.delete(k); }
  retryAfter(key) {
    const now = Date.now(), v = this.hits.get(key);
    if (!v || now - v.first > this.windowMs || v.n < this.max) return 0;
    return Math.ceil((v.first + this.windowMs - now) / 1000);
  }
  fail(key) {
    const now = Date.now();
    if (this.hits.size > 500) this.prune(now);
    const v = this.hits.get(key);
    if (!v || now - v.first > this.windowMs) this.hits.set(key, { n: 1, first: now });
    else v.n++;
  }
  clear(key) { this.hits.delete(key); }
}

// ---- http bits
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const sessionCookie = (token, maxAgeSec = WEB_SESSION_DAYS * 86400) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;

/** Headers for the Portal pages: no framing, no sniffing, scripts only from ourselves. */
const PORTAL_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:", "img-src 'self' data: blob:", "connect-src 'self'",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join('; '),
};
/** The set-up pages only ever run on this computer; they need inline script, so they get the lighter set. */
const LOCAL_HEADERS = {
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
};

module.exports = {
  COOKIE, WEB_SESSION_DAYS, genPin, normPin, prettyPin, safeEqual, joinProof, newToken, hashToken,
  fingerprintOfPem, pemFromDer, loadOrCreateCert, FailLimiter, parseCookies, sessionCookie, PORTAL_HEADERS, LOCAL_HEADERS,
};
