'use strict';
// Headless test for door orders: finds the CNC fields on an order form by their labels, previews the sheet, and serves both over the API.
const fs = require('fs'), os = require('os'), path = require('path');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.ARTEMA_DEFAULT_PORT = '18599';
process.env.ARTEMA_UDP_PORT = '41596';
const XLSX = require('xlsx');
const { Core } = require('../src/core');
const { Orders } = require('../src/orders');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'artema-orders-e2e-'));
const fails = [];
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  ' + JSON.stringify(extra) : '')); if (!cond) fails.push(name); };

/** An order form laid out like the real one: labels on the left, values beside them, a print area, some merged cells. */
function makeForm(file, { door = '26-611', rowShift = 0, ext = 'xlsx' } = {}) {
  const ws = {};
  const put = (a, v) => { ws[a] = { t: typeof v === 'number' ? 'n' : 's', v, w: String(v) }; };
  const r = n => n + rowShift;
  put('I' + r(4), 'Customer Name:'); put('J' + r(4), 'Evolve Windows & Doors');
  put('I' + r(5), 'Tag Name:'); put('J' + r(5), 'Pinnacle - Town Houses');
  put('I' + r(45), 'Door Number:'); put('J' + r(45), door);
  put('B' + r(19), 'Panel Swing:'); put('E' + r(19), 'Inswing');
  put('B' + r(20), 'Hinge Side:'); put('E' + r(20), 'RH');
  put('B' + r(21), 'Hinge Finish:'); put('E' + r(21), 'Flat Black Self Closing');
  put('B' + r(22), 'Hinge Quantity:'); put('E' + r(22), '4');
  put('B' + r(39), 'Deadbolt Prepping'); put('E' + r(39), '2 1/8 (2 3/8 BS) 5 1/2"');
  put('B' + r(40), 'Multi-point lock type:'); put('E' + r(40), '-');
  put('I' + r(19), 'Panel Series'); put('J' + r(19), 'Richersons Smooth skin');
  put('I' + r(20), 'Panel type:'); put('J' + r(20), 'flush');
  put('I' + r(21), 'Panel Width:'); put('J' + r(21), '35  3/4 ');
  put('I' + r(22), 'Panel Height:'); put('J' + r(22), '83      ');
  put('I' + r(31), 'Panel type:'); put('J' + r(31), 'sidelight panel (must not win)');
  put('N' + r(18), 'Hinge Type'); put('N' + r(19), 0);
  put('AA3', 'a lookup list that is not part of the printed form');
  ws['!ref'] = 'A1:AM70'; ws['!merges'] = [{ s: { r: 3, c: 8 }, e: { r: 3, c: 9 } }];
  const p = XLSX.utils.aoa_to_sheet([['Qty', 'Part'], [1, 'Stile']]);
  const wb = { SheetNames: ['Main Order Form', 'Parts List', 'Empty'], Sheets: { 'Main Order Form': ws, 'Parts List': p, Empty: {} }, Workbook: { Names: [{ Name: '_xlnm.Print_Area', Ref: "'Main Order Form'!$B$4:$K$64", Sheet: 0 }] } };
  XLSX.writeFile(wb, file, { bookType: ext });
}

(async () => {
  const cores = [];
  try {
    const root = path.join(T, 'share'), dir = path.join(root, 'Door Orders');
    fs.mkdirSync(path.join(dir, 'Archive'), { recursive: true });
    makeForm(path.join(dir, 'Door 26-611.xlsx'));
    makeForm(path.join(dir, 'Archive', 'Door 26-612.xlsx'), { door: '26-612', rowShift: 3 });
    fs.writeFileSync(path.join(dir, '~$Door 26-611.xlsx'), 'excel lock file');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a form');
    fs.writeFileSync(path.join(dir, 'Door 26-613.xlsx'), 'this is not a spreadsheet');

    const o = new Orders(root, XLSX);
    const list = o.list();
    check('only spreadsheets are listed: no lock files, no text files, subfolders included', list.map(x => x.name).sort().join() === 'Door 26-611.xlsx,Door 26-612.xlsx,Door 26-613.xlsx', list.map(x => x.name));
    const a = list.find(x => x.door === '26-611');
    check('the CNC fields are read from their labels', a && a.f.series === 'Richersons Smooth skin' && a.f.ptype === 'flush' && a.f.swing === 'Inswing' && a.f.hingeSide === 'RH' && a.f.hingeFinish === 'Flat Black Self Closing' && a.f.hingeQty === '4' && a.f.deadbolt === '2 1/8 (2 3/8 BS) 5 1/2"', a);
    check('sizes are tidied (extra spaces removed)', a.f.width === '35 3/4' && a.f.height === '83', a);
    check('"-" and 0 mean nothing there', a.f.multipoint === '' && a.f.hingeType === '', a);
    check('the first "Panel type" wins, not the sidelight one', a.f.ptype === 'flush');
    const b = list.find(x => x.door === '26-612');
    check('sizes and sections are joined up', a.f.size === '35 3/4 \u00d7 83' && a.f.doorFrame === '' && a.f.project === 'Pinnacle - Town Houses', a.f);
    check('a form whose rows moved down still reads right', b && b.f.swing === 'Inswing' && b.f.series === 'Richersons Smooth skin' && b.f.hingeQty === '4', b);
    check('the customer and door number come from the form', a.f.customer === 'Evolve Windows & Doors' && a.door === '26-611');
    const bad = list.find(x => x.name === 'Door 26-613.xlsx');
    check('a file that is not a spreadsheet is reported, not fatal', bad && bad.error && bad.door === '26-613', bad);

    const s = o.sheet('Door 26-611.xlsx');
    check('the preview shows the print area only (no lookup lists)', s.rows.length === 42 && s.rows[0].length === 10 && !s.rows.flat().some(v => /lookup list/.test(v)), [s.rows.length, s.rows[0] && s.rows[0].length]);
    check('the preview lists the real sheets, not empty ones', s.sheets.join() === 'Main Order Form,Parts List', s.sheets);
    check('merged cells are described', s.merges.length === 1 && s.merges[0].cs === 2, s.merges);
    check('another sheet can be previewed', o.sheet('Door 26-611.xlsx', 'Parts List').rows[1].join() === '1,Stile');
    let err = null; try { o.sheet('../../secret.xlsx'); } catch (e) { err = e; }
    check('a path outside the Door Orders folder is refused', err && err.status === 400, err && err.message);
    try { o.sheet('notes.txt'); err = null; } catch (e) { err = e; }
    check('only spreadsheets can be previewed', err && err.status === 400);

    // ---- the work order
    const { renderWorkOrder } = require('../src/workorder');
    const html = renderWorkOrder(a, 'CNC');
    check('the work order is one self-contained page: no scripts, no outside files', /^<!doctype html>/.test(html) && !/<script|https?:\/\//i.test(html.replace(/data:image\/webp;base64,[A-Za-z0-9+/=]+/, '')), html.slice(0, 80));
    check('it leads with the door, the customer and the department', /26-611/.test(html) && /Evolve Windows &amp; Doors/.test(html) && /Work order/.test(html) && />CNC</.test(html));
    check('the CNC view puts panel, hinges and lock prepping first', html.indexOf('Door panel') < html.indexOf('Hinges') && html.indexOf('Hinges') < html.indexOf('Lock prepping') && /Richersons Smooth skin/.test(html) && /2 1\/8 \(2 3\/8 BS\)/.test(html));
    check('other departments get their own focus, and the rest is still on the page', renderWorkOrder(a, 'Paint').indexOf('Finish &amp; colour') < renderWorkOrder(a, 'Paint').indexOf('Also on this order') && /Door panel/.test(renderWorkOrder(a, 'Paint').split('Also on this order')[1]));
    check('text from a spreadsheet cannot break out of the page', !/<img src=x/.test(renderWorkOrder({ ...a, f: { ...a.f, customer: '<img src=x onerror=alert(1)>' } }, 'Office')));
    check('an unknown department is read as Office', />Office</.test(renderWorkOrder(a, 'Plumbing')));

    // ---- over the API, as a joined computer tagged CNC
    const mk = tag => { fs.mkdirSync(path.join(T, tag, 'desk'), { recursive: true }); const c = new Core({ dataDir: path.join(T, tag, 'data'), webDir: path.join(__dirname, '..', 'web'), desktopDir: path.join(T, tag, 'desk'), hooks: {} }); c.trustLoopback = false; cores.push(c); return c; };
    const H = mk('host'), C = mk('cnc');
    for (const c of cores) await c.startLocalServer(0);
    await H.setupHost('Host', 18501);
    fs.mkdirSync(path.join(H.folder, 'Door Orders'), { recursive: true });
    makeForm(path.join(H.folder, 'Door Orders', 'Door 26-611.xlsx'));
    await C.join('127.0.0.1:18501', 'Big CNC', H.getPin());
    const call = async ep => { const r = await fetch('https://127.0.0.1:18501/api/' + ep, { headers: { Authorization: 'Bearer ' + C.secret('device_token'), 'X-Device': 'test' } }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    let r = await call('orders');
    check('a joined computer can list the door orders', r.status === 200 && r.body.items.length === 1 && r.body.items[0].f.hingeSide === 'RH', r);
    r = await call('orders/sheet?path=' + encodeURIComponent('Door 26-611.xlsx'));
    check('...and open the sheet', r.status === 200 && r.body.rows.length > 10 && r.body.sheets.includes('Parts List'), r.status);
    check('...and a path that escapes is refused', (await call('orders/sheet?path=' + encodeURIComponent('../config.json'))).status === 400);
    const post = async (who, ep, body) => { H.trustLoopback = who === 'host'; try { const r = await fetch('https://127.0.0.1:18501/api/' + ep, { method: 'POST', headers: { ...(who === 'host' ? {} : { Authorization: 'Bearer ' + C.secret('device_token') }), 'X-Device': 'test', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; } finally { H.trustLoopback = false; } };
    const id = C.cfg.device_id;
    check('a general computer cannot hand out departments', (await post(C, 'devices/department', { id, dept: 'Paint' })).status === 403);
    check('the main computer can', (await post('host', 'devices/department', { id, dept: 'frame prep' })).status === 200 && (await call('me')).body.tag === 'Frame Prep');
    check('an unknown department is refused', (await post('host', 'devices/department', { id, dept: 'Plumbing' })).status === 400);
    check('a department can be cleared', (await post('host', 'devices/department', { id, dept: '' })).status === 200 && (await call('me')).body.tag === '');
    check('the page is told which departments exist', (await call('devices')).body.departments.join() === 'CNC,Frame Prep,Paint,Assembly,Office');
    await post('host', 'devices/role', { id, role: 'admin' });
    check('an admin computer can hand out departments too', (await post(C, 'devices/department', { id, dept: 'CNC' })).status === 200 && (await call('me')).body.tag === 'CNC');
    r = await fetch('https://127.0.0.1:18501/api/orders/workorder?path=' + encodeURIComponent('Door 26-611.xlsx') + '&dept=CNC', { headers: { Authorization: 'Bearer ' + C.secret('device_token') } });
    const page = await r.text();
    check('the work order page is served for framing, with a locked-down policy', r.status === 200 && /text\/html/.test(r.headers.get('content-type')) && /default-src 'none'/.test(r.headers.get('content-security-policy')) && r.headers.get('x-frame-options') === 'SAMEORIGIN' && /26-611/.test(page));
    r = await fetch('https://127.0.0.1:18501/api/orders/pdf?path=' + encodeURIComponent('Door 26-611.xlsx'), { headers: { Authorization: 'Bearer ' + C.secret('device_token') } });
    check('a PDF is only made where the app can print one (here it says so)', r.status === 501);
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of cores) { try { await c.shutdown(); } catch { /* already stopped */ } }
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
