'use strict';
/**
 * CLAIM-LEDGER W3 gates on the real store (the app's better-sqlite3 + sqlite-vec under Electron as
 * Node, through the C4 drill runner: sandbox hive, jailed home, allow-list env):
 *   G3.1 no leak (random corpora x 1,000 queries, both branches)   G3.1b no leak after a change
 *   G3.1c the cap (N >> k hidden nearest)                            G3.3 disposable
 *   G3.4 the flip (three patterns out, claims in; and back)          append-only claims; R5 candidates
 * It fails (never skips) when Electron is missing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-w3-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const { runDrill } = require('./claims-drill/runner.cjs');
const TREE = path.join(__dirname, '..');
const SCRIPT = path.join(__dirname, 'claims-w3', 'scenarios.cjs');

let n = 0;
async function scenario(name, args = {}) {
  const dir = path.join(JAIL, `${name}-${++n}`);
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const res = await runDrill({ tree: TREE, hive, home: path.join(dir, 'home'), script: SCRIPT, needModel: false, args: { scenario: name, ...args } });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2).slice(0, 3000));
  return res;
}

test('G3.1 no leak: 3 random corpora x 1,000 queries; no superseded, retracted or purged claim by default, in either branch', { timeout: 10 * 60_000 }, async () => {
  const r = await scenario('noleak');
  assert.equal(r.corpora, 3);
  assert.ok(r.queries >= 1000, `${r.queries} queries`);
  assert.deepEqual(r.leaks, [], 'no hidden claim returned by default');
  assert.ok(r.liveClaimHits > 100 && r.mdHits > 100, `the queries do hit (live claims ${r.liveClaimHits}, markdown ${r.mdHits})`);
  assert.ok(r.historyHits > r.liveClaimHits, '--history shows more');
  assert.equal(r.historyGone, 0, '--history never shows a purged claim');
  assert.ok(r.allGoneHits > 0, '--all does');
});

test('G3.1b no leak after a change: R2, R3, R4, soft supersede and a multi-part claim are hidden at once, in both branches; never re-embedded', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('later');
  for (const [id, b] of Object.entries(r.before)) assert.deepEqual(b, { fast: true, filtered: true }, `${id} is found while live`);
  for (const [id, a] of Object.entries(r.after)) {
    assert.equal(a.fast, false, `${id} (${a.cause}): not in the KNN fast path`);
    assert.equal(a.filtered, false, `${id} (${a.cause}): not in the filtered exact scan`);
    assert.equal(a.statusChanges, 1);
  }
  assert.ok(r.parts >= 2, 'the long claim really has several parts');
  assert.equal(r.reEmbedded, 0, 'a status change never re-embeds');
  assert.deepEqual(r.history[0], ['c-000000000001', 'superseded'], '--history still finds it first, marked');
});

test('G3.1c the cap: the 590 nearest are hidden; both branches still return k live results', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('cap');
  assert.equal(r.fast.length, 5); assert.equal(r.filtered.length, 5);
  assert.ok(r.fast.every((s) => s === 'live') && r.filtered.every((s) => s === 'live'), JSON.stringify(r));
  assert.ok(r.fastLiveEpsilon >= 1, 'the live near neighbours are what comes back');
  // Jim S-a: the vector branch alone still yields k live hits (pins the in-KNN vis filter and the vec0 vis update).
  for (const [when, v] of [['vis at insert', r.vecAtInsert], ['vis after a status change', r.vecAfterChange]]) {
    for (const branch of ['fast', 'filtered']) {
      assert.equal(v[branch].length, 5, `${when}, ${branch}: k hits`);
      assert.deepEqual(v[branch].filter(([st, fromVec]) => st !== 'live' || !fromVec), [], `${when}, ${branch}: every hit is live and from the vector branch ${JSON.stringify(v[branch])}`);
    }
  }
  assert.equal(r.statusChanges, 590); assert.equal(r.reEmbedded, 0);
});

test('G3.3 disposable: delete the index, rebuild, identical results', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('disposable');
  assert.equal(r.identical, true);
  assert.deepEqual(r.a, { ...r.b, generation: r.a.generation });
  assert.ok(r.sample.length > 0);
});

test('G3.4 the flip: at reader the three patterns have 0 chunks and claims are in; a flip back restores them and removes the claims', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('flip');
  assert.ok(r.shadow.excluded >= 3 && r.shadow.claims === 0, `shadow: markdown in, no claims ${JSON.stringify(r.shadow)}`);
  assert.match(r.shadowSync, /not indexed for a1 \(level shadow\)/);
  assert.equal(r.reader.excluded, 0, 'reader: 0 chunks from memory.md, memory-archive-*.md, memory-ledger-export-*.md');
  assert.ok(r.reader.notes > 0 && r.reader.other > 0, 'other sources and agents untouched');
  assert.equal(r.reader.claims, 1);
  assert.ok(r.flippedRemoved >= 3, 'the flip was a removal');
  assert.equal(r.searchMem, 1); assert.equal(r.mdMem, 0, 'search finds the claim, not memory.md');
  assert.ok(r.flippedBack.excluded >= 3, 'flip back: the three patterns return');
  assert.equal(r.flippedBack.claims, 0); assert.equal(r.flippedBack.claimChunks, 0); assert.equal(r.flippedBack.statuses, 0);
});

test('claims is append-only in the index (triggers); claim_status is mutable; a resync is idempotent', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('appendOnly');
  assert.match(r.update, /append-only/);
  assert.match(r.delete, /append-only/);
  assert.equal(r.statusUpdate, 'ok');
  assert.equal(r.claims, 1);
  assert.equal(r.schema, '2');
  assert.deepEqual(r.again, { embedded: 0, dropped: 0, statusChanges: 1 }, 'a hand-edited status is restored from the ledger, without a re-embed');
  assert.deepEqual(r.again2, { embedded: 0, dropped: 0, statusChanges: 0 }, 'then a resync is a no-op');
});

test('R5 candidates: same agent, live, cosine >= tau2, not the claim itself, not on the same key', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('r5');
  assert.deepEqual(r.plain.map((x) => x.b).sort(), ['c-00000000000b', 'c-00000000000c', 'c-000000000010']);
  assert.ok(r.plain.every((x) => x.cosine >= 0.9));
  assert.deepEqual(r.keyed.map((x) => x.b).sort(), ['c-00000000000a', 'c-00000000000b'], 'c-...c shares release.window: a typed-slot match is R2, not R5');
  assert.deepEqual(r.unknown, []);
});

// — W3 audit fixes (Jim CL-W3-AUDIT 4a2c6e3c) —

test('W3-1 (a): a manifest flip then a sync with NO backfill leaves 0 chunks from the three patterns; search finds only the claim', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('flipLive');
  assert.ok(r.before >= 3);
  assert.equal(r.after, 0);
  assert.ok(r.hits.includes('claim:c-000000000001'));
  assert.deepEqual(r.hits.filter((h) => /memory(-archive-.*|-ledger-export-.*)?\.md$/.test(h)), [], 'no replaced markdown beside the claim');
  assert.ok(r.notes > 0, 'other sources untouched');
});

test('W3-1 (b): the Settings level on a running worker: raise swaps in claims, a drop to shadow brings memory.md back and hides the claims; a sync carrying the level follows it', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('settingLive');
  assert.ok(r.atShadow.replaced >= 3);
  assert.match(r.refused, /not indexed/);
  assert.equal(r.raise.changed, true);
  assert.deepEqual({ replaced: r.atReader.replaced, claims: r.atReader.claims }, { replaced: 0, claims: 1 });
  assert.ok(r.atReader.hits.includes('claim:c-000000000001'));
  assert.ok(!r.atReader.hits.includes('agents/a1/memory.md'));
  assert.equal(r.drop.changed, true);
  assert.ok(r.backToShadow.replaced >= 3, 'memory.md and the rest are back');
  assert.equal(r.backToShadow.claims, 0, 'the claims are gone');
  assert.ok(!r.backToShadow.hits.some((h) => h.startsWith('claim:')));
  assert.ok(r.backToShadow.hits.includes('agents/a1/memory.md'));
  assert.deepEqual({ replaced: r.followed.replaced, claims: r.followed.claims }, { replaced: 0, claims: 1 }, 'the sync made the engine follow writer first');
});

test('W3-1: a memory-sources.json change on disk reconciles through the watcher, with no sync and no restart', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('manifestWatch');
  assert.equal(r.rootWatched, true);
  assert.deepEqual(r.atReader, { replaced: 0, claims: 1 });
  assert.ok(r.afterWatch.replaced >= 3);
  assert.equal(r.afterWatch.claims, 0);
});

test('Jim A-2 (anchor): a deleted ledger folder of an anchored agent: its markdown stays out, its claims stay, nothing is re-embedded; without the anchor it would swap back', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('anchoredDeleted');
  assert.deepEqual(r.anchored, { replaced: 0, claims: 1, reEmbedded: 0, removed: 0 }, JSON.stringify(r));
  assert.deepEqual(r.viaOp, { changed: true, replaced: 0, claims: 1 }, 'the anchor pushed with the level works the same');
  assert.ok(r.plain.replaced >= 3 && r.plain.claims === 0, `the control: no anchor, the markdown swaps back ${JSON.stringify(r.plain)}`);
});

test('Jim S-b:the claim-ledger op through runWorker\'s dispatch reaches the engine: a new level changes it, a repeat does not, another changes it again', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('workerLedger');
  assert.equal(r.ready, true);
  assert.equal(r.sync.ok, false); assert.match(r.sync.error, /not indexed for a1 \(level off\)/, 'this build implements off: a real worker clamps to it');
  assert.equal(r.op.ok, true, JSON.stringify(r.op)); assert.equal(r.op.json.changed, true);
  assert.equal(r.again.ok, true); assert.equal(r.again.json.changed, false, 'the engine kept the level');
  assert.equal(r.back.ok, true); assert.equal(r.back.json.changed, true);
  assert.equal(r.shutdown.ok, true);
});

test('W3-2: no status row never returned (both branches); an unsent claim is dropped; wake-up carries no claim chunk', { timeout: 5 * 60_000 }, async () => {
  const r = await scenario('gaps');
  for (const branch of ['fast', 'filtered', 'history']) assert.ok(!r.orphan[branch].includes('c-000000000001'), `${branch}: a claim chunk without a status row is never returned`);
  assert.ok(r.orphan.fast.includes('c-000000000002'), 'its neighbour with a status row still is');
  assert.equal(r.wakeHasClaim, false);
  assert.deepEqual(r.unsent, { claims: 0, all: 0, statuses: 0 });
});
