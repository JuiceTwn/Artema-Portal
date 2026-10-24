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
    check('the CNC fields are read from their labels', a && a.series === 'Richersons Smooth skin' && a.type === 'flush' && a.swing === 'Inswing' && a.hingeSide === 'RH' && a.hingeFinish === 'Flat Black Self Closing' && a.hingeQty === '4' && a.deadbolt === '2 1/8 (2 3/8 BS) 5 1/2"', a);
    check('sizes are tidied (extra spaces removed)', a.width === '35 3/4' && a.height === '83', a);
    check('"-" and 0 mean nothing there', a.multipoint === '' && a.hingeType === '', a);
    check('the first "Panel type" wins, not the sidelight one', a.type === 'flush');
    const b = list.find(x => x.door === '26-612');
    check('a form whose rows moved down still reads right', b && b.swing === 'Inswing' && b.series === 'Richersons Smooth skin' && b.hingeQty === '4', b);
    check('the customer and door number come from the form', a.customer === 'Evolve Windows & Doors' && a.door === '26-611');
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
    check('a joined computer can list the door orders', r.status === 200 && r.body.items.length === 1 && r.body.items[0].hingeSide === 'RH', r);
    r = await call('orders/sheet?path=' + encodeURIComponent('Door 26-611.xlsx'));
    check('...and open the sheet', r.status === 200 && r.body.rows.length > 10 && r.body.sheets.includes('Parts List'), r.status);
    check('...and a path that escapes is refused', (await call('orders/sheet?path=' + encodeURIComponent('../config.json'))).status === 400);
    H.store.setTag(C.cfg.device_id, 'CNC');
    check('the computer\'s department tag is available to the page', (await call('me')).body.tag === 'CNC');
  } catch (e) { console.log('TEST CRASH', e); fails.push('crash'); }
  for (const c of cores) { try { await c.shutdown(); } catch { /* already stopped */ } }
  console.log('\nFAILED:', fails.length ? fails : 'none'); console.log('temp:', T);
  process.exit(fails.length ? 1 : 0);
})();
