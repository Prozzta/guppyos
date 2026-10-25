'use strict';
/**
 * CLAIMS-90 Phase 3: read the snapshot's MAC key through the product's own SafeStorageKeyProvider.
 * safeStorage needs a READY Electron app (not Electron as Node), so this runs as a windowless
 * Electron main script, with userData set to the sandbox COPY of the snapshot's user data (its
 * Local State holds the os_crypt key that safeStorage uses). It creates no window.
 *
 *   electron key-unwrap.cjs <tree> <userDataCopy>   -> stdout: the key, base64, one line; exit 0
 *
 * The key leaves only on stdout (a pipe to run.cjs) and is never written to a file.
 */
const path = require('node:path');
const { app, safeStorage } = require('electron');

const [tree, userData] = process.argv.slice(-2);
app.setPath('userData', userData);
app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    const loadTs = require(path.join(tree, 'test', 'load-ts.cjs'));
    const { SafeStorageKeyProvider, MAC_KEY_FILE } = loadTs(path.join(tree, 'src', 'main', 'claims', 'keyProvider.ts'));
    const r = new SafeStorageKeyProvider(path.join(userData, MAC_KEY_FILE), safeStorage).load();
    if (!r.ok) { process.stderr.write(`key: ${r.reason}\n`); app.exit(4); return; }
    process.stdout.write(`${r.key.toString('base64')}\n`, () => app.exit(0));
  } catch (e) {
    process.stderr.write(`key: ${String(e && e.message || e).slice(0, 300)}\n`);
    app.exit(5);
  }
});
