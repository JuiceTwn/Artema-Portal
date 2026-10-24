'use strict';
/**
 * Tidying that keeps a new version from tripping over an old one.
 * Everything here is deliberately narrow: it only touches Artema Portal's own install folder, its own leftovers, and processes
 * running its own installed program. Nothing in the shared files or the settings is ever touched.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { readJson, writeJson, log, sleep } = require('./util');
const { compare, valid } = require('./version');

/** Removes a file or folder; true only if there was something there to remove. */
const rm = p => { try { if (!fs.existsSync(p)) return false; fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } };

/** Notes which version ran last. `changed` is true on the first run of a different version (an update or a fresh install). */
function noteVersion(dataDir, version) {
  const file = path.join(dataDir, 'last-version.json');
  const prev = readJson(file, {}).version || '';
  if (prev !== version) writeJson(file, { version, at: new Date().toISOString() });
  return { changed: prev !== version, previous: prev };
}

/**
 * Leftovers of an update, cleared once the app is running fine: the old app folder kept for rollback, a staged update that is
 * no newer than what is running, and its marker. A `.failed` folder stays until the next update so a crash can be looked at.
 */
function cleanUpdateLeftovers(appDir, version) {
  const removed = [];
  if (rm(appDir + '.old')) removed.push('old app');
  let staged = null;
  try { staged = JSON.parse(fs.readFileSync(appDir + '.update.json', 'utf8')); } catch { /* none */ }
  const stale = !staged || !valid(staged.version) || !valid(version) || compare(staged.version, version) <= 0;
  if (stale) {
    const a = rm(appDir + '.update'), b = rm(appDir + '.update.json');
    if (a || b) removed.push('stale update');
  }
  if (removed.length) log(`housekeeping: removed ${removed.join(', ')}`);
  return removed;
}

function run(cmd, args) {
  return new Promise(resolve => execFile(cmd, args, { windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve({ err, stdout: String(stdout || '') })));
}

/** Running copies of exactly this installed program: [{ pid, ppid }]. Windows only. */
async function findInstances(exePath, exec = run) {
  if (process.platform !== 'win32') return [];
  const name = path.basename(exePath).replace(/'/g, "''");
  const ps = `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  let rows = [];
  try { const j = JSON.parse(stdout || '[]'); rows = Array.isArray(j) ? j : [j]; } catch { return []; }
  const want = path.resolve(exePath).toLowerCase();
  return rows.filter(r => r && r.ExecutablePath && path.resolve(r.ExecutablePath).toLowerCase() === want).map(r => ({ pid: r.ProcessId, ppid: r.ParentProcessId }));
}

/**
 * Closes any copy of the installed program that is still running (an older version sitting in the tray, say), so a newer one
 * can replace its files. Only processes whose program file is exactly `exePath` are touched, and never this one.
 */
async function stopInstalledCopies(exePath, selfPid = process.pid, exec = run) {
  const found = (await findInstances(exePath, exec)).filter(p => p.pid !== selfPid);
  if (!found.length) return 0;
  const pids = new Set(found.map(p => p.pid));
  const roots = found.filter(p => !pids.has(p.ppid));          // the helper processes go down with their parent
  log(`housekeeping: closing ${roots.length} older running copy(ies) of ${path.basename(exePath)}`);
  for (const r of roots) await exec('taskkill.exe', ['/PID', String(r.pid), '/T', '/F']);
  for (let i = 0; i < 20; i++) {
    if (!(await findInstances(exePath, exec)).some(p => p.pid !== selfPid)) break;
    await sleep(250);
  }
  return roots.length;
}

/**
 * Copies a folder without blocking the program (so an animation stays smooth), reporting progress as it goes.
 * onProgress({ files, totalFiles, bytes, totalBytes }). Links are skipped: an app folder has none.
 */
async function copyTree(src, dest, onProgress = () => { }, parallel = 6) {
  const files = []; let totalBytes = 0;
  const walk = rel => {
    const dir = path.join(src, rel);
    fs.mkdirSync(path.join(dest, rel), { recursive: true });
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) { const size = fs.statSync(path.join(src, r)).size; files.push({ rel: r, size }); totalBytes += size; }
    }
  };
  walk('');
  let next = 0, done = 0, bytes = 0;
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++];
      await fs.promises.copyFile(path.join(src, f.rel), path.join(dest, f.rel));
      done++; bytes += f.size;
      onProgress({ files: done, totalFiles: files.length, bytes, totalBytes });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, files.length || 1) }, worker));
  return { files: files.length, bytes };
}

module.exports = { copyTree, noteVersion, cleanUpdateLeftovers, findInstances, stopInstalledCopies };
