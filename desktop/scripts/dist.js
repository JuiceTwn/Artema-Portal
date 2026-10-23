'use strict';
// Builds the two editions of Artema Portal from the same source:  node scripts/dist.js [server|client|all]
//   server -> dist/server/Artema-Portal-Server-<version>-win.zip   always the main computer, sets itself up, never joins
//   client -> dist/client/Artema-Portal-<version>-win.zip          connects to the main computer, can never be it
// Set ARTEMA_VERSION to stamp a test version (for example 1.0.1-test.3) without touching package.json.
const { build, Platform } = require('electron-builder');
const pkg = require('../package.json');

const which = process.argv[2] || 'all';
const editions = which === 'all' ? ['server', 'client'] : [which];
if (!editions.every(e => e === 'server' || e === 'client')) { console.error('Usage: node scripts/dist.js [server|client|all]'); process.exit(2); }
const version = process.env.ARTEMA_VERSION || pkg.version;

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
      },
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
