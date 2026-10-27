'use strict';
/**
 * CLAIMS-SYNC-SLICE-APPLY: a floor's first derived sync carries every derived claim (~11.6k chunks
 * on the Human's floor: minutes of embedding, one per queue step), and the engine used to apply
 * them all in ONE step at the end, so search held none of them until then. Now a wing with nothing
 * to replace applies in slices of whole claims (engine.ts CLAIMS_APPLY_SLICE), each slice its own
 * transaction and queue step: a search sees the first slice within seconds. The final step keeps
 * the purge drops, status and room changes, the head row, the embed-version meta and the markdown
 * swap; a crash before it leaves no head and the next sync re-plans by content sha, embedding only
 * what is missing. A wing whose markdown is still indexed keeps the all-at-once apply (Jim's
 * MUST-1: search sees the markdown or the claims, never neither; test/claims-midrun-gap.test.cjs).
 * Scenarios run under Electron through the C4 drill runner: test/claims-slice-apply/scenarios.cjs.
 * It fails (never skips) when Electron is missing. Invented text only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.join(__dirname, '..');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-slice-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const { runDrill } = require('./claims-drill/runner.cjs');
const SCRIPT = path.join(__dirname, 'claims-slice-apply', 'scenarios.cjs');

let n = 0;
async function scenario(name, args = {}) {
  const dir = path.join(JAIL, `${name}-${++n}`);
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const res = await runDrill({ tree: REPO, hive, home: path.join(dir, 'home'), script: SCRIPT, needModel: false, args: { scenario: name, ...args }, timeoutMs: 180_000 });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2).slice(0, 3000));
  return res;
}

test('sliceClaimParts: slices of whole claims, in order, a multi-part claim never split', () => {
  const { sliceClaimParts, CLAIMS_APPLY_SLICE } = loadTs('src/main/nativeMemory/engine.ts');
  assert.ok(CLAIMS_APPLY_SLICE >= 16 && CLAIMS_APPLY_SLICE <= 256, `a slice is seconds of embedding, not minutes: ${CLAIMS_APPLY_SLICE}`);
  const p = (claimId, part) => ({ claimId, part });
  assert.deepEqual(sliceClaimParts([], 2), []);
  const parts = [p('a', 0), p('b', 0), p('b', 1), p('c', 0), p('d', 0), p('d', 1), p('d', 2), p('e', 0)];
  const slices = sliceClaimParts(parts, 2);
  assert.deepEqual(slices.map((s) => s.map((x) => `${x.claimId}${x.part}`)), [['a0', 'b0', 'b1'], ['c0', 'd0', 'd1', 'd2'], ['e0']]);
  assert.deepEqual(slices.flat(), parts, 'every part once, in the plan order');
  assert.equal(sliceClaimParts(parts, 100).length, 1, 'a plan within one slice is one slice (the all-at-once shape)');
  // a claim larger than the slice stays whole
  assert.deepEqual(sliceClaimParts([p('x', 0), p('x', 1), p('x', 2), p('y', 0)], 1).map((s) => s.length), [3, 1]);
});

test('a slice is visible to search before the final step: the search behind the first apply finds the first claims while the sync still runs', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('visible');
  const s = JSON.stringify(r);
  assert.equal(r.res.embedded, r.n, s);
  assert.equal(r.embedCalls, r.n, 'one embed call per part, nothing twice');
  assert.equal(r.applies.length, Math.ceil(r.n / r.slice) + 1, `one apply per slice plus the final step: ${s}`);
  const partial = r.applies.slice(0, -1);
  assert.ok(partial.every((a) => a.partial && a.add > 0 && a.add <= r.slice), `every slice is a partial apply of at most ${r.slice} claims: ${s}`);
  assert.equal(partial.reduce((t, a) => t + a.add, 0), r.n, s);
  const last = r.applies[r.applies.length - 1];
  assert.deepEqual({ add: last.add, drop: last.drop, partial: last.partial }, { add: 0, drop: 0, partial: false }, `the final step is the head-row step: ${s}`);
  assert.equal(r.applies[0].behind.first, true, `the search queued behind the FIRST slice finds claim 0: ${s}`);
  assert.equal(r.applies[0].behind.settled, false, `and it answered before the sync resolved: ${s}`);
  assert.equal(partial[1].behind.settled, false, s);
  assert.ok(Object.values(r.found).every(Boolean), `after the sync every sampled claim is found: ${s}`);
  assert.equal(r.claimRows, r.n, s);
  assert.equal(r.head, 'h', `the final step wrote the head row: ${s}`);
  assert.equal(r.embedVersion, r.expectVersion, s);
});

test('a crash mid-way keeps the applied slices (no head row); the next sync embeds only what is missing and finishes', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('crash');
  const s = JSON.stringify(r);
  assert.match(String(r.crashed.error), /embedder died/, s);
  assert.equal(r.crashed.applies, 1, `the first slice was applied, the second never: ${s}`);
  assert.equal(r.crashed.firstFound, true, `the first slice stays searchable after the crash: ${s}`);
  assert.equal(r.crashed.lastFound, false, s);
  assert.equal(r.crashed.claimRows, r.slice, s);
  assert.equal(r.crashed.head, '', `no head row until the final step (the source row exists for its chunks): ${s}`);
  assert.equal(r.crashed.embedVersion, String(2), 'a fresh wing marks its recipe with its first slice, so the re-plan does not re-embed it');
  // the re-plan (by content sha, never by head) embeds only the missing claims
  assert.equal(r.res2.embedded, r.n - r.slice, `the next sync embeds the rest only: ${s}`);
  assert.equal(r.embedCalls2, r.n - r.slice, s);
  assert.equal(r.res2.dropped, 0, s);
  assert.equal(r.applies2, Math.ceil((r.n - r.slice) / r.slice) + 1, s);
  assert.ok(Object.values(r.found).every(Boolean), `every sampled claim is found after the second sync: ${s}`);
  assert.equal(r.head, 'h', s);
  assert.equal(r.claimRows, r.n, s);
  assert.equal(r.chunkRows, r.n, 'no claim indexed twice');
  assert.deepEqual(r.res3, { embedded: 0, dropped: 0, statusChanges: 0, roomChanges: 0 }, `a third sync is a no-op: ${s}`);
});

test('MUST-1: a wing whose markdown is indexed keeps the all-at-once apply: markdown during the embeds, one apply, claims and no markdown behind it', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('markdown');
  const s = JSON.stringify(r);
  assert.ok(r.mdBefore > 0, `the markdown note is indexed before the ledger exists: ${s}`);
  assert.ok(r.n > r.slice, s);
  assert.equal(r.res.embedded, r.n, s);
  assert.equal(r.applies.length, 1, `ONE apply for a wing with markdown to replace, however many claims: ${s}`);
  assert.equal(r.applies[0].partial, false, s);
  assert.equal(r.applies[0].add, r.n, s);
  assert.ok(r.during, 'a search ran during the embeds');
  assert.ok(r.during.md > 0, `during the embeds the markdown is still found: ${s}`);
  assert.equal(r.during.claims, 0, `and no claim yet (never both): ${s}`);
  assert.equal(r.applies[0].behind.md, 0, `behind the apply the markdown is gone: ${s}`);
  assert.ok(r.applies[0].behind.claims > 0, `and the claims are in: ${s}`);
  assert.equal(r.after.md, 0, s);
  assert.ok(r.after.claims > 0, s);
  assert.equal(r.mdIndexed, false, s);
  assert.equal(r.head, 'h', s);
});
