'use strict';
require('./tools/own-job.cjs');

/**
 * ELECTRON-RMSYNC-AGENT-WRITABLE-108, MUST 1 of Jim's audit of 2edbe77f: a link planted WHILE a
 * folder is being removed is never followed.
 *
 * The other rm tests plant a link once, before the call. That cannot see this: under Electron 45
 * a recursive rmSync follows any junction that appears while it runs, so a remover that checks for
 * links and then calls it loses to an agent that plants in a loop. Measured by Jim on 2edbe77f,
 * Electron 45.3.0: the victim lost files in 136 of 164 runs.
 *
 * Here an agent process plants junctions to a victim at <dir>/a/j and <dir>/a/b/j with a random
 * 0 to 3 ms wait between tries, while this side fills <dir>/a/b with 40 files and removes <dir>,
 * RUNS times, with fsSafeRemove's safeRemoveTreeSync and then with its async safeRemoveTree. Both
 * run in the installed Guppy.exe as Node, where the fault is. The victim must keep every file in
 * every run. A run where the remover throws (refused, ENOTEMPTY: the agent planted after the
 * folder was read) is fine: it failed closed.
 *
 * The swap this planter does not make (a real folder renamed away and a junction of the same name
 * put there between two steps of the delete) is test/fs-remove-gap.test.cjs; the remover is the
 * fs-handle addon's removeTree since FS-REMOVE-READDIR-GAP-108, which closes both.
 *
 * Red on the remover as at 2edbe77f (a link check, then a recursive rmSync).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUNS = 60;
const jail = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rmsync-jitter-'));
// The runner jails LOCALAPPDATA; the shared helper finds the installed app read-only or gives a skip reason.
const guppy = require('./tools/installed-guppy.cjs').installedGuppy();
const exe = guppy.exe;

// The jail can hold junctions when a run stops half way: remove them as links before the folder.
test.after(() => {
  const walk = (p) => {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } return; }
    if (st.isDirectory()) for (const nm of fs.readdirSync(p)) walk(path.join(p, nm));
  };
  walk(jail);
  fs.rmSync(jail, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

for (const mode of ['sync', 'async']) {
  const name = mode === 'sync' ? 'safeRemoveTreeSync' : 'safeRemoveTree';
  test(`${name}: an agent planting junctions during the remove never costs the victim a file (Electron as Node, ${RUNS} runs)`, { skip: guppy.skip }, (t) => {
    const base = path.join(jail, mode);
    fs.mkdirSync(base, { recursive: true });
    assert.equal(fs.existsSync(exe), true, `installed Guppy executable missing: ${exe}`);
    const r = child.spawnSync(exe, [path.join(__dirname, 'electron-rmsync-jitter-child.cjs'), 'race', mode, base, String(RUNS)],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: jail, USERPROFILE: jail }, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    assert.equal(r.status, 0, `child exit ${r.status}: ${r.stderr || r.stdout}`);
    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, true, res.error);
    assert.match(res.electron, /^\d+\./, 'the child really ran in Electron');
    t.diagnostic(`${name}: ${JSON.stringify(res.out)}`);
    assert.equal(res.out.runs, RUNS, 'every run happened');
    assert.ok(res.out.planted >= RUNS, `the agent really planted during the runs (${res.out.planted} junctions)`);
    assert.equal(res.out.losses, 0, `THE VICTIM LOST FILES IN ${res.out.losses} OF ${res.out.runs} RUNS: ${JSON.stringify(res.out)}`);
  });
}
