'use strict';
/**
 * MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189, T3 the reproduction (moved here from
 * test/memory-search-deadline-189.test.cjs): the real worker and client search DURING a claims sync
 * on a loaded machine (test/memory-search-deadline/scenario.cjs) against the real 1000 ms indexing
 * budget. It is a wall-clock gate, so it runs in the serial perf lane, after the parallel suite: in
 * the parallel run a suite stall of 600 ms+ timed searches out on top of the drill's own load (Jim,
 * 2026-10-16), which says nothing about the code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'msd-189-t3-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const loadTs = require('../load-ts.cjs');
const { SEARCH_DEADLINE_INDEXING_MS } = loadTs('src/main/nativeMemory/service.ts');
// The warm budget when the failure reproduced; this drill must still exceed that old limit.
const OLD_WARM_MS = 250;
const { runDrill } = require('../claims-drill/runner.cjs');
const TREE = path.join(__dirname, '..', '..');

async function drill(leg) {
  const dir = path.join(JAIL, 'drill');
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const res = await runDrill({ tree: TREE, hive, home: path.join(dir, 'home'), script: path.join(__dirname, '..', 'memory-search-deadline', 'scenario.cjs'), needModel: false, args: { leg }, timeoutMs: 180_000 });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2).slice(0, 3000));
  return res;
}

/** A search that missed the indexing budget ends one of two ways, both on that budget and both
 *  logged (fix A): the client's timer fired (`deadline`), or the worker found the deadline already
 *  passed when the search left its queue and answered it `expired` without running it (fix C). */
const MISSED = new Map([[`memory search timed out after ${SEARCH_DEADLINE_INDEXING_MS} ms`, 'deadline'], ['expired', 'expired']]);

test('T3: searches DURING a claims sync on a loaded machine answer, with hits, inside the indexing budget; a rare machine stall is logged on it (1.1.88: they time out at the then 250 ms warm budget, unlogged)', async () => {
  const r = await drill('index');
  assert.equal(r.bf, 0);
  assert.equal(r.cold.exit, 0, JSON.stringify(r.cold));
  assert.equal(r.synced.ok, true, JSON.stringify(r.synced));
  assert.equal(r.synced.json.embedded, 40);
  assert.ok(r.stepRuns >= 40, 'the sync really embedded step by step');
  assert.ok(r.during.length >= 5, `searches ran during the sync: ${r.during.length}`);
  // A search waits for one step: ~2 steps (~400 ms) of a 1000 ms budget. Only a machine stall of
  // 600 ms+ can make one miss it: allow at most 1 in 10, each on the indexing budget and logged as
  // such. On 1.1.88 (and with the budget mutant) most of them time out at the warm budget (250 ms then).
  const failed = r.during.filter((s) => s.exit !== 0);
  assert.ok(failed.length <= Math.floor(r.during.length / 10), `nearly every search during the sync answered: ${failed.length}/${r.during.length} ${JSON.stringify(failed.slice(0, 3))}`);
  for (const s of failed) assert.ok(MISSED.has(s.error), `a missed search ends on the indexing budget: ${JSON.stringify(s)}`);
  const degraded = r.rows.filter((x) => x.kind === 'native-memory-degraded');
  assert.equal(degraded.length > 0, failed.length > 0, JSON.stringify(degraded));
  assert.deepEqual([...new Set(degraded.map((x) => x.reason))].sort(), [...new Set(failed.map((s) => MISSED.get(s.error)))].sort(), 'each way a search missed is logged as that way');
  for (const x of degraded) assert.deepEqual([x.op, x.budgetMs, x.indexing], ['search', SEARCH_DEADLINE_INDEXING_MS, true], JSON.stringify(x));
  const answered = r.during.filter((s) => s.exit === 0);
  assert.ok(answered.every((s) => s.hits > 0), 'each one with results (markdown before the apply, claims after)');
  const slowest = Math.max(...answered.map((s) => s.ms));
  assert.ok(slowest < SEARCH_DEADLINE_INDEXING_MS, `slowest ${slowest} ms`);
  assert.ok(slowest > OLD_WARM_MS, `vacuity: on this loaded machine a search during the sync takes more than the old warm budget ${OLD_WARM_MS} ms (slowest ${slowest} ms)`);
  assert.ok(r.events.includes('on:claims-sync') && r.events.at(-1).startsWith('off:'), JSON.stringify(r.events));
  console.log(`# during the sync: ${r.during.length} searches (${failed.length} missed: ${failed.map((s) => s.error).join(', ') || 'none'}), slowest answered ${slowest} ms; after: exit ${r.after.exit} in ${r.after.ms} ms`);
});
