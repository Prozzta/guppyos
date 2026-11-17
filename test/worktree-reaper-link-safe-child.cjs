'use strict';
/**
 * ELECTRON-RMSYNC-REAPER-108: runs scripts/worktree-reaper.cjs applyReap on one fixture folder.
 * Required by worktree-reaper-link-safe.test.cjs (this process), and run by it in the installed
 * Guppy.exe as Node. `variant`:
 *   real       the script as it is
 *   no-prepass the script with its removeLinks pre-pass taken out (compiled from text, no file
 *              written): the tree delete alone must still never follow a link
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const SRC = path.join(__dirname, '..', 'scripts', 'worktree-reaper.cjs');
const PREPASS = 'links = removeLinks(tomb, ops);';

function load(variant) {
  if (variant === 'real') return require(SRC);
  if (variant !== 'no-prepass') throw new Error(`unknown variant ${variant}`);
  const source = fs.readFileSync(SRC, 'utf8');
  if (source.split(PREPASS).length - 1 !== 1) throw new Error('the removeLinks pre-pass line is not there exactly once');
  const m = new Module(SRC, module);
  m.filename = SRC; m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(source.replace(PREPASS, () => 'links = 0;'), SRC);
  return m.exports;
}

/** Reap `<base>/work/old-tree` (a plain folder: no git is run). */
function run(variant, base) {
  const tmp = path.resolve(os.tmpdir());
  if (!path.resolve(base).startsWith(tmp + path.sep)) throw new Error(`the fixture is not under the temp folder (${base}); refusing to run`);
  const R = load(variant);
  const work = path.join(base, 'work');
  const plan = [{ name: 'old-tree', path: path.join(work, 'old-tree'), kind: 'folder', action: 'reap', reason: 'test' }];
  return R.applyReap(plan, { root: work, now: 1700000000000, exes: () => [] });
}

module.exports = { run, SRC, PREPASS };

if (require.main === module) {
  if (!process.versions.electron) { console.error('this child runs in Electron as Node only'); process.exit(64); }
  let res;
  try { res = { ok: true, electron: process.versions.electron, out: run(process.argv[2], process.argv[3]) }; }
  catch (e) { res = { ok: false, error: String(e && e.stack || e) }; }
  console.log(JSON.stringify(res));
}
