'use strict';
// Builds the two editions of Artema Portal from the same source:  node scripts/dist.js [server|client|all]
//   client -> dist/client/Artema-Portal-<version>-win.zip          connects to the main computer, can never be it
//   server -> dist/server/Artema-Portal-Server-<version>-win.zip   always the main computer, sets itself up, never joins
// The server build also carries the client app of the same version (resources/update). Install a new server and every connected
// computer updates itself from it, so the server build always builds the client first.
// Set ARTEMA_VERSION to stamp a test version (for example 1.0.1-test.3) without touching package.json.
const fs = require('fs');
const path = require('path');
const { build, Platform } = require('electron-builder');
const pkg = require('../package.json');
const { buildManifest, validateManifest } = require('../src/update');

const which = process.argv[2] || 'all';
if (!['server', 'client', 'all'].includes(which)) { console.error('Usage: node scripts/dist.js [server|client|all]'); process.exit(2); }
const editions = ['client', ...(which === 'client' ? [] : ['server'])];
const version = process.env.ARTEMA_VERSION || pkg.version;
const electron = require('electron/package.json').version;
const root = path.join(__dirname, '..');
const clientApp = path.join(root, 'dist', 'client', 'win-unpacked', 'resources', 'app');

/** Copies the freshly built client app into the server build and describes it, just before the server is zipped. */
async function embedClient(context) {
  const dest = path.join(context.appOutDir, 'resources', 'update');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(clientApp, path.join(dest, 'app'), { recursive: true });
  const manifest = await buildManifest(path.join(dest, 'app'), { version, edition: 'client', electron });
  const bad = validateManifest(manifest);
  if (bad) throw new Error(`the client update is not valid: ${bad}`);
  const shipped = JSON.parse(fs.readFileSync(path.join(dest, 'app', 'package.json'), 'utf8'));
  if (shipped.artemaEdition !== 'client' || shipped.version !== version) throw new Error('the embedded app is not the client build of this version');
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest));
  console.log(`  • update payload: client ${version}, ${manifest.files.length} files`);
}

(async () => {
  for (const edition of editions) {
    const server = edition === 'server';
    await build({
      targets: Platform.WINDOWS.createTarget('zip'),
      config: {
        ...pkg.build,
        appId: server ? 'com.artema.portal.server' : 'com.artema.portal',
        productName: server ? 'Artema Portal Server' : 'Artema Portal',
        artifactName: (server ? 'Artema-Portal-Server' : 'Artema-Portal') + '-${version}-win.zip',
        directories: { output: `dist/${edition}` },
        extraMetadata: { version, artemaEdition: edition },
        ...(server ? { afterPack: embedClient } : {}),
      },
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
