'use strict';
/**
 * ELECTRON-RMSYNC-REAPER-108, FS-REMOVE-READDIR-GAP-108: runs scripts/worktree-reaper.cjs
 * applyReap on one fixture folder. Required by worktree-reaper-link-safe.test.cjs (this process),
 * and run by it in the installed Guppy.exe as Node. `variant`:
 *   real      the script as it is: the tree is deleted by the fs-handle addon's removeTree
 *   no-addon  the script with a remover that found no build: the tree must be kept, not walked
 */
const os = require('node:os');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'scripts', 'worktree-reaper.cjs');
const NO_ADDON = { removeTree: null, reason: 'test: no build' };

/** Reap `<base>/work/old-tree` (a plain folder: no git is run). */
function run(variant, base) {
  const tmp = path.resolve(os.tmpdir());
  if (!path.resolve(base).startsWith(tmp + path.sep)) throw new Error(`the fixture is not under the temp folder (${base}); refusing to run`);
  if (variant !== 'real' && variant !== 'no-addon') throw new Error(`unknown variant ${variant}`);
  const R = require(SRC);
  const work = path.join(base, 'work');
  const plan = [{ name: 'old-tree', path: path.join(work, 'old-tree'), kind: 'folder', action: 'reap', reason: 'test' }];
  return R.applyReap(plan, { root: work, now: 1700000000000, exes: () => [], ...(variant === 'no-addon' ? { remover: NO_ADDON } : {}) });
}

module.exports = { run, SRC, NO_ADDON };

if (require.main === module) {
  if (!process.versions.electron) { console.error('this child runs in Electron as Node only'); process.exit(64); }
  let res;
  try { res = { ok: true, electron: process.versions.electron, out: run(process.argv[2], process.argv[3]) }; }
  catch (e) { res = { ok: false, error: String(e && e.stack || e) }; }
  console.log(JSON.stringify(res));
}
