'use strict';
// Builds both editions and publishes them as a GitHub release, which is what the main computer's "Install" button pulls from:
//   node scripts/publish.js [--notes "what changed"] [--draft]
// Needs the GitHub CLI (gh), signed in with access to the repository. The version is the one in package.json: bump it first
// (the main computer only offers releases newer than what it runs).
//   v<version> carries   Artema-Portal-Server-<version>-win.zip   (the server, with the client app inside it)
//                        Artema-Portal-Server-<version>-win.zip.sha256
//                        Artema-Portal-<version>-win.zip          (for installing a fresh connecting computer by hand)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { version } = require('../package.json');

const arg = n => { const i = process.argv.indexOf(n); return i < 0 ? null : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const root = path.join(__dirname, '..');
const tag = `v${version}`;
const gh = (...a) => execFileSync('gh', a, { cwd: root, encoding: 'utf8' });

try { gh('--version'); } catch { console.error('The GitHub CLI (gh) is needed: https://cli.github.com, then run "gh auth login".'); process.exit(1); }
const exists = spawnSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' }).status === 0;
if (exists) { console.error(`Release ${tag} already exists. Bump "version" in package.json first.`); process.exit(1); }

console.log(`Building ${version}…`);
execFileSync(process.execPath, [path.join(__dirname, 'dist.js'), 'all'], { cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE } });

const server = path.join(root, 'dist', 'server', `Artema-Portal-Server-${version}-win.zip`);
const client = path.join(root, 'dist', 'client', `Artema-Portal-${version}-win.zip`);
for (const f of [server, client]) if (!fs.existsSync(f)) { console.error(`Missing ${f}`); process.exit(1); }
const sum = server + '.sha256';
fs.writeFileSync(sum, crypto.createHash('sha256').update(fs.readFileSync(server)).digest('hex') + '  ' + path.basename(server) + '\n');

const notes = arg('--notes');
console.log(`Publishing ${tag}…`);
console.log(gh('release', 'create', tag, server, sum, client, '--title', `Artema Portal ${version}`, '--notes', typeof notes === 'string' ? notes : `Artema Portal ${version}`, ...(arg('--draft') ? ['--draft'] : [])));
