'use strict';
/**
 * HARNESS-CRASHPAD: every Electron MAIN a test launches calls isolateAppPaths(app, sandbox) at the
 * top, before app.whenReady, crashReporter.start or any window.
 *
 * Without it, Electron resolves userData, sessionData and crashDumps from the package name, i.e.
 * the LIVE app's %APPDATA%/munder-difflin. Harness crashes then wrote Crashpad dumps (ptype renderer,
 * "electron-harness") next to the real app's own dumps, and the app's prune (3 kept) deleted real
 * evidence to make room for them (1.1.65-1.1.67). test/harness-crashpad-guard.test.cjs fails if a
 * main does not call this.
 *
 * appData and logs are redirected too, so no default path can resolve outside the sandbox. The
 * paths are re-read and asserted: a harness that is not isolated refuses to run (exit 2).
 *
 * setPath('crashDumps') ALONE IS NOT ENOUGH (verified 2026-09-28): Electron's Crashpad handler is
 * already running on its default database, so a renderer crash in a harness that never calls
 * crashReporter.start() still landed in the live folder (--user-data-dir was the sandbox). The
 * helper therefore starts a local-only reporter (no upload) on the sandboxed crashDumps. A main that
 * starts its own reporter right after (crash-dump-main, pty-quit-main) passes { reporter: false }.
 */
const { join, resolve, relative, isAbsolute } = require('node:path');
const { mkdirSync } = require('node:fs');

function inside(dir, root) {
  const rel = relative(resolve(root), resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isolateAppPaths(app, sandbox, opts = {}) {
  if (!sandbox) {
    process.stderr.write('harness: refusing to run without a sandbox (HARNESS-CRASHPAD)\n');
    process.exit(2);
  }
  const paths = {
    appData: join(sandbox, 'appData'),
    userData: sandbox,
    sessionData: sandbox,
    crashDumps: join(sandbox, 'crashDumps'),
    logs: join(sandbox, 'logs')
  };
  for (const [name, dir] of Object.entries(paths)) {
    mkdirSync(dir, { recursive: true });
    app.setPath(name, dir);
  }
  const outside = Object.keys(paths).filter((name) => !inside(app.getPath(name), sandbox));
  if (outside.length) {
    process.stderr.write(`harness: ${outside.join(', ')} resolved outside the sandbox (HARNESS-CRASHPAD)\n`);
    process.exit(2);
  }
  if (opts.reporter !== false) {
    require('electron').crashReporter.start({ uploadToServer: false, submitURL: '', compress: false });
  }
  return paths;
}

module.exports = { isolateAppPaths, inside };
