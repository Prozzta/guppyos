'use strict';
/**
 * ELECTRON-RMSYNC-REAPER-108: the probe of worktree-reaper-link-safe-mutants.cjs. It reaps one
 * fixture with scripts/worktree-reaper.cjs as it is on disk now, in the installed Guppy.exe as
 * Node, and counts the files left in each folder a junction pointed at.
 *
 * It lives here and not in the census because a census runner writes no file itself (MUTANT-JOURNAL
 * NO-BYPASS in test-runner-glob): the only writes here are the fixture's own files, all under one
 * fresh folder that mkdtemp makes in the temp folder. No file of the repo is written.
 */
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHILD = path.join(__dirname, '..', 'worktree-reaper-link-safe-child.cjs');
const VICTIMS = ['top', 'nested'];
const VICTIM_FILES = ['precious.txt', 'sub/b.txt'];

/**
 * `guppy` is installedGuppy()'s result. Returns { left: { top, nested }, out } or { why }.
 * The fixture is removed afterwards, its links first and each as a link.
 */
function probe(guppy) {
  if (guppy.skip) return { why: guppy.skip };
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reaper-mutant-probe-'));
  const tree = path.join(base, 'work', 'old-tree');
  const links = [path.join(tree, 'node_modules'), path.join(tree, 'src', 'deep', 'assets')];
  try {
    VICTIMS.forEach((name, i) => {
      const d = path.join(base, 'live', name);
      fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(d, 'precious.txt'), `live ${name}`); fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'b');
      fs.mkdirSync(path.dirname(links[i]), { recursive: true });
      fs.symlinkSync(d, links[i], 'junction');
    });
    fs.writeFileSync(path.join(tree, 'a.txt'), 'a');
    const r = child.spawnSync(guppy.exe, [CHILD, 'real', base], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (r.status !== 0) return { why: `probe child exit ${r.status}: ${String(r.stderr || r.stdout || r.error).trim().slice(0, 300)}` };
    const left = {};
    for (const name of VICTIMS) left[name] = VICTIM_FILES.filter((rel) => fs.existsSync(path.join(base, 'live', name, rel))).length;
    return { left, out: String(r.stdout).trim().slice(0, 300) };
  } finally {
    // Links first, each as a link, wherever the reap left the tree (in place or as a tombstone).
    const work = path.join(base, 'work');
    for (const top of fs.existsSync(work) ? fs.readdirSync(work) : []) {
      for (const rel of [['node_modules'], ['src', 'deep', 'assets']]) {
        const p = path.join(work, top, ...rel);
        let st = null; try { st = fs.lstatSync(p); } catch { /* gone */ }
        if (st && st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } }
      }
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const probeLine = (p) => (p.why ? `no result (${p.why})` : VICTIMS.map((n) => `live/${n} ${p.left[n]} of ${VICTIM_FILES.length} files left`).join(', '));

module.exports = { probe, probeLine, VICTIMS, VICTIM_FILES };
