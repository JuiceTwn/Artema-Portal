'use strict';
/**
 * Swaps in a staged update after the app has quit, starts the new version, and puts the old one back if the new one crashes.
 *
 * The app copies this file to a temporary place and runs it with the Electron program acting as plain Node
 * (ELECTRON_RUN_AS_NODE), so it never lives inside the folder it is about to replace. It uses nothing but Node's own modules.
 * Argument: one JSON object { pid, appDir, stageDir, oldDir, exe, args, version, logFile }.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const job = JSON.parse(process.argv[2]);
const { pid, appDir, stageDir, oldDir, exe, args = [], version, logFile } = job;
const watchMs = job.watchMs || 20000;          // how long the new version has to prove it can start (shortened by tests)
const markerPath = appDir + '.update.json', failedDir = appDir + '.failed';

const say = m => { try { fs.appendFileSync(logFile, `${new Date().toISOString().slice(0, 19).replace('T', ' ')}  ${m}\n`); } catch { /* logging must never stop an update */ } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const rm = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ } };

/** Antivirus and Explorer briefly hold files after an app quits: try again for a while before giving up. */
async function retry(fn, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return fn(); } catch (e) {
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(e.code) || Date.now() > end) throw e;
      await sleep(500);
    }
  }
}

function launch() {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', env, cwd: path.dirname(exe) });
  child.on('error', e => say(`could not start ${exe}: ${e.message}`));
  child.unref();
  return child;
}

(async () => {
  say(`update to ${version}: waiting for the app (pid ${pid}) to close`);
  for (let i = 0; i < 120 && alive(pid); i++) await sleep(500);
  if (alive(pid)) { say('the app did not close; nothing was changed'); return; }

  // The app itself, plus any other folders that must change with it (the server also swaps the client payload it hands out).
  const swaps = [{ dir: appDir, stage: stageDir, old: oldDir }, ...(job.extra || [])];
  for (const s of swaps) rm(s.old);
  rm(failedDir);
  const moved = [];
  /** Puts every folder swapped so far back as it was. The new main app is kept as `.failed` when asked, so a crash can be looked at. */
  const restore = keepFailed => {
    const errors = [];
    for (const s of [...moved].reverse()) {
      try {
        if (s.live) { if (keepFailed && s.dir === appDir) fs.renameSync(s.dir, failedDir); else rm(s.dir); }
        fs.renameSync(s.old, s.dir);
      } catch (e) { errors.push(e.message); }
    }
    return errors;
  };
  for (const s of swaps) {
    try { await retry(() => fs.renameSync(s.dir, s.old)); } catch (e) {
      say(`could not move ${path.basename(s.dir)} aside (${e.message}); starting the old version again unchanged`);
      restore(false); launch(); return;
    }
    s.live = false; moved.push(s);
    try { fs.renameSync(s.stage, s.dir); s.live = true; } catch (e) {
      say(`could not put the new ${path.basename(s.dir)} in place (${e.message}); putting the old one back`);
      const errors = restore(false);
      if (errors.length) say(`could not restore everything: ${errors.join('; ')}`);
      launch(); return;
    }
  }
  rm(markerPath);

  let exit = null;
  const child = launch();
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  for (let waited = 0; waited < watchMs && !exit; waited += 250) await sleep(250);          // time to prove it can start

  if (exit && (exit.code !== 0)) {
    say(`version ${version} stopped straight away (${exit.signal || 'exit code ' + exit.code}); going back to the old version`);
    const errors = restore(true);
    if (errors.length) say(`could not go back: ${errors.join('; ')}`); else launch();
    return;
  }
  say(`version ${version} is running`);
  for (const s of swaps) rm(s.old);
  for (const p of job.cleanup || []) rm(p);
})().catch(e => say(`update helper failed: ${e && e.stack || e}`));
