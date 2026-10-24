'use strict';
/** Just enough semantic versioning to order our own releases, including test ones like 1.0.1-test.4. */
function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v == null ? '' : v).trim());
  return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}
const valid = v => parse(v) !== null;

/** -1 if a < b, 0 if equal, 1 if a > b. A release is newer than its own test builds (1.0.1 > 1.0.1-test.9). Throws on text that isn't a version. */
function compare(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;           // numbers sort before words
    return p < q ? -1 : 1;
  }
  return 0;
}

module.exports = { parse, valid, compare };
