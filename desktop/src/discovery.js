'use strict';
const dgram = require('dgram');
const os = require('os');
const { APP_NAME } = require('./util');

const UDP_PORT = parseInt(process.env.ARTEMA_UDP_PORT, 10) || 41234;     // env override is for automated tests, so they never hear a real Portal

function broadcastAddrs() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip = i.address.split('.').map(Number), m = i.netmask.split('.').map(Number);
      out.add(ip.map((b, k) => b | (~m[k] & 255)).join('.'));
    }
  }
  return [...out];
}
function sendAll(sock, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  for (const a of broadcastAddrs()) sock.send(buf, UDP_PORT, a, () => { });
}

/** Run by the main computer: answers "is anyone there?" and announces itself every few seconds. */
class Beacon {
  constructor(infoFn, onPeer) { this.infoFn = infoFn; this.onPeer = onPeer; this.sock = null; this.timer = null; }
  start() {
    const s = this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => { });                                  // discovery is best-effort; TCP scan is the fallback
    s.on('message', (msg, rinfo) => {
      let m; try { m = JSON.parse(msg.toString()); } catch { return; }
      if (m.app !== APP_NAME) return;
      if (m.t === 'probe') s.send(Buffer.from(JSON.stringify({ t: 'here', ...this.infoFn() })), rinfo.port, rinfo.address, () => { });
      else if (m.t === 'here') this.onPeer({ ...m, address: rinfo.address });
    });
    s.bind(UDP_PORT, () => { try { s.setBroadcast(true); } catch { /* ignore */ } this.announce(); });
    this.timer = setInterval(() => this.announce(), 5000);
  }
  announce() { if (this.sock) sendAll(this.sock, { t: 'here', ...this.infoFn() }); }
  stop() { clearInterval(this.timer); try { this.sock.close(); } catch { /* already closed */ } this.sock = null; }
}

/** Shout once and collect everyone who answers. */
function probeUdp(ms = 1500) {
  return new Promise(resolve => {
    const found = new Map();
    let s;
    try { s = dgram.createSocket('udp4'); } catch { return resolve([]); }
    s.on('error', () => { });
    s.on('message', (msg, rinfo) => {
      try {
        const m = JSON.parse(msg.toString());
        if (m.app === APP_NAME && m.t === 'here') found.set(m.id || rinfo.address, { address: `${rinfo.address}:${m.port}`, name: m.name, id: m.id });
      } catch { /* not ours */ }
    });
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch { /* ignore */ }
      sendAll(s, { t: 'probe', app: APP_NAME });
      setTimeout(() => { try { s.close(); } catch { /* closed */ } resolve([...found.values()]); }, ms);
    });
  });
}

module.exports = { Beacon, probeUdp, UDP_PORT };
