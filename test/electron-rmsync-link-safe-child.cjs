'use strict';
/**
 * ELECTRON-RMSYNC-LINK-SAFE-108: runs one removal site on a fixture the test built.
 * The test calls run() in its own process (plain Node) and also starts this file with the
 * installed Guppy.exe as Node (ELECTRON_RUN_AS_NODE=1), where a recursive rmSync deletes
 * through a junction. Usage: <exe> electron-rmsync-link-safe-child.cjs <site> <base>
 */
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const SITES = {
  /** skills.ts uninstallSkill: a skill that is a junction, and a real skill holding one. */
  async skills(base) {
    const { uninstallSkill } = loadTs('src/main/skills.ts');
    const proj = path.join(base, 'proj'); const skills = path.join(proj, '.claude', 'skills');
    return {
      linked: await uninstallSkill(path.join(skills, 'linked'), { cwds: [proj] }),
      real: await uninstallSkill(path.join(skills, 'real'), { cwds: [proj] })
    };
  },
  /** index.ts removeWorkerScratch: HIVE_ROOT/agents/<id>. */
  async 'worker-scratch'(base) {
    await loadTs('src/main/linkSafeRemove.ts').removePathLinkSafe(path.join(base, 'hive', 'agents', 'worker-1'));
    return {};
  },
  /** index.ts reset: the hive root, as a real folder and as a junction. */
  async reset(base) {
    const { removePathLinkSafe } = loadTs('src/main/linkSafeRemove.ts');
    await removePathLinkSafe(path.join(base, 'hive'));
    await removePathLinkSafe(path.join(base, 'hive-link'));
    await removePathLinkSafe(path.join(base, 'no-such-hive'));
    return {};
  },
  /** release-worktrees.cjs seedModel (synchronous, the script's own): a left-over seeding folder
   *  and an old cache, both with links. */
  'seed-model'(base) {
    const P = require(path.join(__dirname, '..', 'scripts', 'release-worktrees.cjs'));
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
    const src = path.join(base, 'src-model');
    const cacheDir = path.join(base, 'cache', manifest.model.dir);
    // A seed that was killed leaves `<cacheDir>.seeding-<pid>`; the pid is this process's.
    const tmp = `${cacheDir}.seeding-${process.pid}`;
    fs.mkdirSync(tmp, { recursive: true });
    fs.symlinkSync(path.join(base, 'live', 'stale'), path.join(tmp, 'stale'), 'junction');
    const linkedCache = path.join(base, 'cache-linked', manifest.model.dir);
    return {
      real: P.seedModel(cacheDir, manifest, [src]),
      tmpLeft: fs.existsSync(tmp),
      linked: P.seedModel(linkedCache, manifest, [src]),
      verifyReal: P.verifyModel(cacheDir, manifest),
      verifyLinked: P.verifyModel(linkedCache, manifest)
    };
  }
};

async function run(site, base) {
  if (!Object.hasOwn(SITES, site)) throw new Error(`unknown site: ${site}`);
  return SITES[site](base);
}

module.exports = { run };

if (require.main === module) {
  const [site, base] = process.argv.slice(2);
  if (!site || !base || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(64);
  run(site, base).then(
    (out) => { process.stdout.write(JSON.stringify({ ok: true, electron: process.versions.electron, out })); },
    (error) => { process.stdout.write(JSON.stringify({ ok: false, error: String(error && error.stack || error) })); process.exitCode = 1; }
  );
}
