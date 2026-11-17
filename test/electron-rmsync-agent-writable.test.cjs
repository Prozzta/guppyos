'use strict';
require('./tools/own-job.cjs');

/**
 * ELECTRON-RMSYNC-AGENT-WRITABLE-108: the recursive removes in src/main that an agent can aim.
 *
 * Under Electron 45 a recursive rmSync deletes THROUGH a Windows junction (RUNTIME PIN in
 * electron-rmsync-link-safe.test.cjs). store.ts finishPurgeSwap removed
 * agents/<id>/memory/claims.purge-old that way on every read of the agent's ledger: an agent that
 * made that name a junction had the app empty whatever folder it pointed at. Plain Node removes
 * the link only, so each site runs twice on the same fixture: in this process, and in the
 * installed Guppy.exe as Node (electron-rmsync-agent-writable-child.cjs).
 *
 *   store.ts finishPurgeSwap   claims.purge-old and claims.purge-new, on a ledger read
 *   store.ts backupIfDue       a left-over `<day>.tmp-<pid>`
 *   kg-core.cjs removeDoc      a doc folder that is a link, and a link inside a real one
 *
 * The other converted sites (store.ts purgeNow, hive.ts x3, claims/migrate.ts, memoryRollover.ts,
 * userDataMigration.ts, skills.ts install cleanup) need a whole hive or a private function to
 * reach; test/recursive-rm-census.test.cjs holds them, and every site here, by source.
 *
 * HOME is a temp jail before any product code loads; every fixture, and every folder a link
 * points at, is inside it.
 *
 * MUTANTS (the recursive rmSync put back; the census fails for every one as well):
 *   B1 store.ts finishPurgeSwap, purge-old   -> purge-swap, Electron
 *   B2 store.ts finishPurgeSwap, purge-new   -> purge-swap, Electron
 *   B3 store.ts backupIfDue                  -> backup-tmp, Electron
 *   B4 kg-core.cjs removeDoc                 -> kg-remove, Electron
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const jail = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rmsync-agent-writable-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = jail; process.env.USERPROFILE = jail;
assert.equal(os.homedir(), jail, 'HOME must be jailed before any product code loads');
const { run, DAY } = require('./electron-rmsync-agent-writable-child.cjs');

// The jail holds junctions when a test fails half way: remove them as links before the folder.
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(jail);
  fs.rmSync(jail, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'junction'); };
/** A folder the site has no business in (the victim): a file, and a file in a subfolder. */
const live = (base, name) => {
  const d = path.join(base, 'live', name);
  write(path.join(d, 'precious.txt'), `live ${name}`); write(path.join(d, 'sub', 'b.txt'), 'b');
  return d;
};
const assertLive = (base, names) => {
  for (const name of names) {
    const d = path.join(base, 'live', name);
    assert.deepEqual(fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((f) => f.split(path.sep).join('/')).sort() : 'gone',
      ['precious.txt', 'sub', 'sub/b.txt'], `THE LINK TARGET live/${name} SURVIVES WITH EVERYTHING IN IT`);
    assert.equal(fs.readFileSync(path.join(d, 'precious.txt'), 'utf8'), `live ${name}`);
  }
};
/** True when nothing is at `p`, not even a link whose target is gone. */
const gone = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) === undefined;

/** site -> { build(base), check(base, out) }. build makes the fixture; check is what must hold after. */
const SITES = {
  'purge-swap': {
    build(base) {
      // Jim's probe shape: a claims folder, and beside it a purge-old that is a junction to a victim.
      const claims = (a) => path.join(base, 'hive', 'agents', a, 'memory', 'claims');
      fs.mkdirSync(claims('evil'), { recursive: true });
      link(live(base, 'old'), `${claims('evil')}.purge-old`);
      // The same for purge-new, which is dropped when the claims folder is there.
      fs.mkdirSync(claims('other'), { recursive: true });
      link(live(base, 'new'), `${claims('other')}.purge-new`);
    },
    check(base, out) {
      const claims = (a) => path.join(base, 'hive', 'agents', a, 'memory', 'claims');
      assert.deepEqual(out, { failed: [] }, 'the swap clean-up did not fail');
      assert.equal(gone(`${claims('evil')}.purge-old`), true, 'purge-old is gone, as a link');
      assert.equal(gone(`${claims('other')}.purge-new`), true, 'purge-new is gone, as a link');
      for (const a of ['evil', 'other']) assert.equal(fs.statSync(claims(a)).isDirectory(), true, `${a}'s claims folder stays`);
      assertLive(base, ['old', 'new']);
    }
  },
  'backup-tmp': {
    build(base) {
      write(path.join(base, 'hive', 'agents', 'evil', 'memory', 'claims', '2026-11.jsonl'), '{"segment":1}\n');
      live(base, 'backup');   // the child links `<day>.tmp-<its pid>` to this
    },
    check(base, out) {
      const day = path.join(base, 'hive', 'backups', 'claims', 'evil', DAY);
      assert.deepEqual(out, { made: true, failed: [] }, 'the backup was made');
      assert.equal(fs.lstatSync(day).isSymbolicLink(), false, 'the day folder is a real folder');
      assert.deepEqual(fs.readdirSync(day), ['2026-11.jsonl'], 'it holds the segment and nothing else');
      assert.deepEqual(fs.readdirSync(path.dirname(day)), [DAY], 'no temp folder is left');
      assertLive(base, ['backup']);
    }
  },
  'kg-remove': {
    build(base) {
      const docs = path.join(base, 'kg', 'docs');
      link(live(base, 'doc'), path.join(docs, 'linked'));
      write(path.join(docs, 'real', 'meta.json'), '{}'); write(path.join(docs, 'real', 'text.md'), 'text');
      write(path.join(docs, 'real', 'parts', 'a.txt'), 'a');
      link(live(base, 'inner'), path.join(docs, 'real', 'parts', 'assets'));
      write(path.join(docs, 'kept', 'meta.json'), '{}');
    },
    check(base, out) {
      const docs = path.join(base, 'kg', 'docs');
      assert.deepEqual(out, { linked: true, real: true });
      assert.deepEqual(fs.readdirSync(docs), ['kept'], 'both docs are gone, another doc stays');
      assertLive(base, ['doc', 'inner']);
    }
  }
};

const exe = process.env.GUPPY_PACKAGED_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Guppy', 'Guppy.exe');

for (const [site, { build, check }] of Object.entries(SITES)) {
  test(`${site}: links are removed as links, their targets survive (this process)`, () => {
    const base = path.join(jail, `${site}-node`);
    build(base);
    check(base, run(site, base));
  });

  test(`${site}: links are removed as links, their targets survive, in the installed Electron as Node`, { skip: process.platform !== 'win32' }, () => {
    const base = path.join(jail, `${site}-electron`);
    build(base);
    assert.equal(fs.existsSync(exe), true, `installed Guppy executable missing: ${exe}`);
    const r = child.spawnSync(exe, [path.join(__dirname, 'electron-rmsync-agent-writable-child.cjs'), site, base],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `child exit ${r.status}: ${r.stderr || r.stdout}`);
    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, true, res.error);
    assert.match(res.electron, /^\d+\./, 'the child really ran in Electron');
    check(base, res.out);
  });
}
