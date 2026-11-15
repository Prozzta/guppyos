'use strict';
require('./tools/own-job.cjs');

/**
 * SCALE-ROLLOUT-NEWEST (Jim's STARTUP-SCALE-YEAR audit, A15; god 4e1810).
 *
 * The 15 s liveness beat probed every non-idle Codex agent's rollout, and each probe walked every dated folder and
 * statted every rollout the home ever had. RolloutIndex keeps the answer of findNewestRollout(home) per home:
 *  - a repeat call re-lists only the newest spine and restats only the current newest and the REGISTERED session's
 *    file (codex resume appends to the old file, in an old folder);
 *  - every ROLLOUT_FULL_WALK_MS (10 min) the home gets the exact full walk, so the one edge it cannot see (a
 *    non-registered old file written again) self-heals.
 * Temp CODEX_HOME trees only. File mtimes are set with utimesSync, so nothing depends on the clock tick.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const { findNewestRollout, RolloutIndex, ROLLOUT_FULL_WALK_MS } = loadTs('src/main/codexRolloutCapacity.ts');
const { CodexRolloutLifecycleSource } = loadTs('src/main/codexRolloutLifecycle.ts');

const BASE = Date.parse('2026-01-01T00:00:00Z') / 1000;   // seconds; utimes takes seconds

function mkHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-scale-rollout-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const dayDir = (home, d) => path.join(home, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'));
function addRollout(home, dayIndex, id, mtimeSec) {
  const d = new Date(Date.UTC(2026, 0, 1) + dayIndex * 86400000);
  const dir = dayDir(home, d);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${d.toISOString().slice(0, 10)}T10-00-00-${id}.jsonl`);
  fs.writeFileSync(file, '{"type":"session_meta"}\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return file;
}
const touch = (file, mtimeSec) => fs.utimesSync(file, mtimeSec, mtimeSec);

/** Records the paths the fs calls in `names` were given while `fn` runs. */
function spyFs(names, fn) {
  const seen = Object.fromEntries(names.map((n) => [n, []]));
  const real = {};
  for (const n of names) {
    real[n] = fs[n];
    fs[n] = function spied(p, ...rest) { seen[n].push(path.resolve(String(p))); return real[n].call(this, p, ...rest); };
  }
  try { return { result: fn(), seen }; } finally { for (const n of names) fs[n] = real[n]; }
}

test('a repeat call stats no old rollout and lists only the newest spine (fs spy)', (t) => {
  const home = mkHome(t);
  const files = [];
  let m = BASE;
  for (let day = 0; day < 40; day++) for (let k = 0; k < 3; k++) files.push(addRollout(home, day, `s${day}-${k}`, m += 60));
  const registered = files[5];                      // an old session the agent resumed
  const idx = new RolloutIndex(() => 0);
  const newest = files[files.length - 1];
  assert.equal(idx.newest(home, `s1-2`), newest, 'first call: the full walk');

  const second = spyFs(['statSync', 'readdirSync', 'openSync', 'readFileSync', 'existsSync'], () => idx.newest(home, 's1-2'));
  assert.equal(second.result, newest);
  assert.deepEqual([...second.seen.statSync].sort(), [newest, registered].map((p) => path.resolve(p)).sort(),
    'only the current newest and the registered session file are statted');
  const spine = [path.join(home, 'sessions'), path.join(home, 'sessions', '2026'), path.join(home, 'sessions', '2026', '02'), path.join(home, 'sessions', '2026', '02', '09')].map((p) => path.resolve(p));
  assert.deepEqual(second.seen.readdirSync, spine, 'only the newest year/month/day are re-listed');
  assert.deepEqual(second.seen.openSync, [], 'no rollout is opened');
  assert.deepEqual(second.seen.readFileSync, [], 'no rollout is read');

  // A new rollout today: statted once when it appears; nothing old.
  const fresh = addRollout(home, 39, 'new-today', m += 60);
  const third = spyFs(['statSync'], () => idx.newest(home, 's1-2'));
  assert.equal(third.result, fresh);
  assert.deepEqual([...third.seen.statSync].sort(), [fresh, newest, registered].map((p) => path.resolve(p)).sort());

  // A new day folder (a new month, too): only the new spine is listed.
  const nextMonth = addRollout(home, 59, 'march', m += 60);
  const fourth = spyFs(['statSync', 'readdirSync'], () => idx.newest(home, 's1-2'));
  assert.equal(fourth.result, nextMonth);
  assert.deepEqual([...fourth.seen.statSync].sort(), [nextMonth, fresh, registered].map((p) => path.resolve(p)).sort());
  assert.ok(fourth.seen.readdirSync.every((p) => !p.includes(`${path.sep}02${path.sep}0`) && !p.includes(`${path.sep}01${path.sep}`)), `no old folder re-listed: ${fourth.seen.readdirSync}`);
});

test('the lifecycle probe on an unchanged home stats only the newest and the registered file, and opens nothing', (t) => {
  const home = mkHome(t);
  let m = BASE;
  const files = [];
  for (let day = 0; day < 20; day++) files.push(addRollout(home, day, `s${day}`, m += 60));
  const src = new CodexRolloutLifecycleSource(new RolloutIndex(() => 0));
  assert.equal(src.probe(home, 's3').ok, true);
  const again = spyFs(['statSync', 'openSync'], () => src.probe(home, 's3'));
  assert.equal(again.result.ok, true);
  assert.deepEqual([...new Set(again.seen.statSync)].sort(), [files[19], files[3]].map((p) => path.resolve(p)).sort());
  assert.deepEqual(again.seen.openSync, [], 'an unchanged newest is not re-read');
  const ts = spyFs(['statSync'], () => src.threadSettingsAt(home, 's3'));
  assert.deepEqual([...new Set(ts.seen.statSync)].sort(), [files[19], files[3]].map((p) => path.resolve(p)).sort());
});

test('the registered session resumed in an old folder is the newest on the very next call', (t) => {
  const home = mkHome(t);
  let m = BASE;
  const files = [];
  for (let day = 0; day < 10; day++) files.push(addRollout(home, day, `s${day}`, m += 60));
  const idx = new RolloutIndex(() => 0);
  assert.equal(idx.newest(home, 's2'), files[9]);
  touch(files[2], m += 60);                          // codex resume s2: appends to the day-2 file
  assert.equal(idx.newest(home, 's2'), files[2]);
  assert.equal(findNewestRollout(home), files[2]);
  // And it stays the newest while it is written (it is now the current newest, too).
  touch(files[2], m += 60);
  assert.equal(idx.newest(home, 's9'), files[2]);
});

test('god 4e1810 edge: an old NON-registered file written again is picked up by the 10-minute exact walk', (t) => {
  const home = mkHome(t);
  let m = BASE;
  const files = [];
  for (let day = 0; day < 10; day++) files.push(addRollout(home, day, `s${day}`, m += 60));
  let now = 1_000_000;
  const idx = new RolloutIndex(() => now);
  assert.equal(ROLLOUT_FULL_WALK_MS, 600_000, 'the period is 10 minutes');
  assert.equal(idx.newest(home, 's9'), files[9]);
  touch(files[4], m += 60);                          // a manual `codex resume s4` in this home: not registered
  assert.equal(findNewestRollout(home), files[4]);
  now += 600_000 - 1;
  assert.equal(idx.newest(home, 's9'), files[9], 'inside the period the cached answer stands (bounded drift)');
  now += 1;
  assert.equal(idx.newest(home, 's9'), files[4], 'at 10 minutes the exact walk finds it');
  // The walk restarts the period.
  touch(files[6], m += 60);
  now += 600_000 - 1;
  assert.equal(idx.newest(home, 's9'), files[4]);
  now += 1;
  assert.equal(idx.newest(home, 's9'), files[6]);
});

test('forget(home) drops the index: the next probe is the exact walk', (t) => {
  const home = mkHome(t);
  let m = BASE;
  const files = [];
  for (let day = 0; day < 6; day++) files.push(addRollout(home, day, `s${day}`, m += 60));
  const src = new CodexRolloutLifecycleSource(new RolloutIndex(() => 0));
  assert.equal(src.probe(home, 's5').ok, true);
  touch(files[1], m += 60);
  src.forget(home);
  const s = spyFs(['statSync'], () => src.probe(home, 's5'));
  assert.ok(s.seen.statSync.includes(path.resolve(files[0])), 'every rollout statted again');
  const idx = new RolloutIndex(() => 0);
  assert.equal(idx.newest(home), files[1]);
});

test('deleted rollouts: a cached winner is statted before it is returned (newest two deleted at once)', (t) => {
  const home = mkHome(t);
  let m = BASE;
  const files = [];
  for (let day = 0; day < 8; day++) files.push(addRollout(home, day, `s${day}`, m += 60));
  const idx = new RolloutIndex(() => 0);
  assert.equal(idx.newest(home), files[7]);
  fs.rmSync(files[7]); fs.rmSync(files[6]);
  assert.equal(idx.newest(home), files[5]);
  assert.equal(findNewestRollout(home), files[5]);
  fs.rmSync(path.join(home, 'sessions'), { recursive: true, force: true });
  assert.equal(idx.newest(home), null, 'no sessions dir');
  const again = addRollout(home, 2, 'back', m += 60);
  assert.equal(idx.newest(home), again);
});

test('equal mtimes: the first in walk order wins, as in findNewestRollout', (t) => {
  const home = mkHome(t);
  const a = addRollout(home, 3, 'aaa', BASE + 100);
  const idx = new RolloutIndex(() => 0);
  assert.equal(idx.newest(home), a);
  const b = addRollout(home, 3, 'bbb', BASE + 100);   // same day, same mtime, later in the listing
  assert.equal(findNewestRollout(home), a);
  assert.equal(idx.newest(home), a);
  const c = addRollout(home, 4, 'ccc', BASE + 100);   // a later day, same mtime
  assert.equal(findNewestRollout(home), a);
  assert.equal(idx.newest(home), a);
  void b; void c;
});

test('equivalence with findNewestRollout over generated histories (no full walk in between)', (t) => {
  for (const seed of [1, 7, 42, 99]) {
    const home = mkHome(t);
    let r = seed;
    const rand = (n) => { r = (r * 1103515245 + 12345) % 2147483648; return r % n; };
    let m = BASE;
    let day = 0;
    let sid;
    const live = [];
    const idx = new RolloutIndex(() => 0);
    for (let step = 0; step < 150; step++) {
      const op = rand(9);
      const newest = findNewestRollout(home);
      if (op <= 1 || live.length === 0) { day += 1 + rand(20); const id = `n${step}`; live.push({ id, file: addRollout(home, day, id, m += 1 + rand(3)) }); }
      else if (op === 2) { const id = `t${step}`; live.push({ id, file: addRollout(home, day, id, m += rand(2)) }); }   // today, maybe a tie
      else if (op === 3 && newest) touch(newest, m += 1);                                                        // the newest is written
      else if (op === 4) { const pick = live[rand(live.length)]; sid = pick.id; touch(pick.file, m += 1); }      // resume an old session: it becomes the registered one
      else if (op === 5 && newest) { fs.rmSync(newest); live.splice(live.findIndex((x) => x.file === newest), 1); }
      else if (op === 6) { const i = rand(live.length); fs.rmSync(live[i].file); live.splice(i, 1); }
      else if (op === 7 && newest) { const i = rand(live.length); fs.rmSync(live[i].file); live.splice(i, 1); if (fs.existsSync(newest)) { fs.rmSync(newest); live.splice(live.findIndex((x) => x.file === newest), 1); } }
      else if (sid && op === 8) { const reg = live.find((x) => x.id === sid); if (reg) touch(reg.file, m += 1); }   // the registered session is written again
      if (sid && !live.some((x) => x.id === sid)) sid = undefined;
      assert.equal(idx.newest(home, sid), findNewestRollout(home), `seed ${seed} step ${step} op ${op}`);
    }
  }
});

test('wiring: the three main callers pass the registered session, and forget reaches the index', () => {
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /codexLifecycle\.probe\(home, a\.sessionId\)/, 'liveness beat');
  assert.match(index, /codexLifecycle\.threadSettingsAt\(home, hive\.lastSession\(agentId\)\)/, 'threadConfigured');
  assert.match(index, /codexLifecycle\.probe\(home, hive\.lastSession\(agentId\)\)/, 'codexTurnProbe');
  assert.doesNotMatch(index, /codexLifecycle\.(probe|threadSettingsAt)\(home\)/, 'no caller without the hint');
  const life = codeOnly(readSource('src/main/codexRolloutLifecycle.ts'));
  assert.doesNotMatch(life, /findNewestRollout\(/, 'the lifecycle source uses the index, not the full walk');
  assert.match(life, /this\.rollouts\.forget\(codexHome\)/);
});
