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
 * HARNESS-CRASHPAD: isolateAppPaths makes the userData copy the sandbox (userData and sessionData are
 * the copy itself; appData, crashDumps and logs go inside it), before any path is used.
 */
const path = require('node:path');
const { app, safeStorage } = require('electron');
const { isolateAppPaths } = require('../electron-harness/isolate-paths.cjs');

const [tree, userData] = process.argv.slice(-2);
isolateAppPaths(app, userData);
app.disableHardwareAcceleration();
// ELECTRON-EXIT-AV / E45-EXIT-KEYUNWRAP: never call app.exit() synchronously from 'ready' (or any
// callback Electron runs while it is still starting up). 'ready' fires before Chromium's main loop
// runs; an exit from inside it tears down while startup work is still running on Chromium's thread
// pool, and that crashes (0xC0000005 / 0xFFFF7002 on ThreadPoolSingleThreadForegroundBlocking,
// about 1 in 100 runs on the fast error path under load), replacing the code below. Exiting from
// will-quit inside the same call stack crashes just the same. setImmediate runs the exit from
// Node's own loop turn, which Electron drives from a task on the running main loop: measured
// 0/1000 against 106/1000 for the same exit made directly inside a startup callback. Not a delay:
// no timer, just the next loop turn. The code still reaches the parent through app.exit (Electron
// ignores process.exitCode on a normal quit).
function finish(code) {
  setImmediate(() => app.exit(code));
}
app.whenReady().then(() => {
  try {
    const loadTs = require(path.join(tree, 'test', 'load-ts.cjs'));
    const { SafeStorageKeyProvider, MAC_KEY_FILE } = loadTs(path.join(tree, 'src', 'main', 'claims', 'keyProvider.ts'));
    const r = new SafeStorageKeyProvider(path.join(userData, MAC_KEY_FILE), safeStorage).load();
    if (!r.ok) { process.stderr.write(`key: ${r.reason}\n`); finish(4); return; }
    process.stdout.write(`${r.key.toString('base64')}\n`, () => finish(0));
  } catch (e) {
    process.stderr.write(`key: ${String(e && e.message || e).slice(0, 300)}\n`);
    finish(5);
  }
});
