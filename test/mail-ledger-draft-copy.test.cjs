'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-LEDGER-DRAFT-COPY-108: a ledger transition no longer copies `{...prev.entries}`; versions
 * share an entries store (src/main/mailLedger.ts, "entries store").
 *
 * The oracle is the same module with `storeAfter` replaced by the old copy: every new version gets
 * a full copy of the previous entries and writes into it, which is exactly the old Draft. The same
 * random walk runs on both (every pure transition, branching from older versions, reload, migration,
 * rebuild), and each step's result, the document text, the key order and every older version kept
 * along the way must be equal. The walk reads `doc.entries` at different rates, because reading it is
 * what builds a version's plain object.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REL = 'src/main/mailLedger.ts';
const L = loadTs(REL);
const SRC = fs.readFileSync(path.join(__dirname, '..', REL), 'utf8');
const HEAD = 'function storeAfter(prev: EntryStore): EntryStore {';
assert.equal(SRC.split(HEAD).length, 2, 'storeAfter is defined once');
const O = loadTs.fromText(REL, SRC.replace(HEAD, `${HEAD}\n  { const o = { ...storeEntries(prev) }; return { base: o, log: null, len: 0, mat: o }; }`));
const T0 = Date.parse('2026-11-17T10:00:00.000Z');

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SENDERS = ['s1', 's2', 's3', 's4'];
const FROMS = ['god-1', 'jim-1'];

/** The same change on both sides; ids come from the oracle's doc so the new side is never read. */
function randomStep(pair, rand, now, n) {
  const ids = Object.keys(pair.o.entries);
  const pick = () => ids[Math.floor(rand() * ids.length)];
  const some = () => ids.filter(() => rand() < 0.25);
  const epoch = `e${1 + Math.floor(rand() * 3)}`;
  const r0 = rand();
  // Some ids are all digits (they sort first in key order) or another message's sender_id.
  const id = r0 < 0.1 ? SENDERS[Math.floor(rand() * SENDERS.length)] : r0 < 0.2 ? String(n) : `m${n}`;
  const msg = { id, from: FROMS[Math.floor(rand() * FROMS.length)], act: rand() < 0.4 ? 'request' : 'inform', subject: 'subj', body: `b${n % 3}`, ...(rand() < 0.6 ? { sender_id: SENDERS[Math.floor(rand() * SENDERS.length)] } : {}) };
  const sub = some();
  const one = pick();
  const ref = rand() < 0.5 ? SENDERS[Math.floor(rand() * SENDERS.length)] : one;
  const flag = rand() < 0.5;
  const k = Math.floor(rand() * 22);
  const run = (M, doc) => {
    switch (k) {
      case 0: case 1: case 2: case 3: return M.applyDelivered(doc, msg, now);
      case 4: return M.applyWorkOrder(doc, msg, now);
      case 5: return M.applyWorkOrderLeftover(doc, msg, now);
      case 6: return M.applyClaimSurfacing(doc, sub, epoch, 'hook', now);
      case 7: return M.applyConfirmSurfaced(doc, sub, epoch, 'evidence', now);
      case 8: return M.applyMarkActed(doc, sub, epoch, now);
      case 9: return M.applyReinject(doc, sub, epoch, 'hook', now);
      case 10: return M.applyRedeliver(doc, sub, 'test', now);
      case 11: return M.applyLegacyActed(doc, sub, flag ? 'legacy-read' : 'legacy-move', now);
      case 12: return one ? M.applyBodyMissing(doc, one, 'gone', now) : null;
      case 13: return one ? M.applyParseFailed(doc, one, 'sig', now) : null;
      case 14: return one ? M.applyReappeared(doc, one, now) : null;
      case 15: return M.applyCloseEpoch(doc, epoch, flag ? 'normal' : 'abnormal', now);
      case 16: return ref ? M.applyReplied(doc, ref, `r${n}`, now, FROMS[n % 2], flag ? 'done' : 'inform') : null;
      case 17: return ref ? M.applyCloseObligation(doc, ref, now, M.askCloseReason('requester', 'test')) : null;
      case 18: return M.applyRestartRecovery(doc, now);
      case 19: return M.applyPrune(doc, now, 2000);
      case 20: return M.applySetAside(doc, sub, flag, now);
      default: return M.applyChannelOverride(doc, flag ? { mode: 'legacy-read', reason: 'x', since: now } : null);
    }
  };
  const so = run(O, pair.o);
  const sl = run(L, pair.l);
  if (!so) return { pair, kind: 'none' };
  // The step's result: same ids changed, same rows, same events (entry objects compared by value).
  assert.deepEqual(sl.changed, so.changed, `step ${n} kind ${k}: changed`);
  assert.deepEqual(sl.logs, so.logs, `step ${n} kind ${k}: rows`);
  assert.deepEqual(sl.events, so.events, `step ${n} kind ${k}: events`);
  assert.deepEqual(sl.archive, so.archive, `step ${n} kind ${k}: archive`);
  return { pair: { l: sl.doc, o: so.doc }, kind: `k${k}` };
}

/** A reload from disk, a migration or a rebuild, on both sides from the same files. */
function reload(pair, rand, now) {
  const r = rand();
  if (r < 0.4) { const t = JSON.stringify(pair.o); return { l: JSON.parse(t), o: JSON.parse(t) }; }
  const files = Object.values(pair.o.entries).map((e) => ({ id: e.id, mtimeMs: e.deliveredAt, msg: { id: e.id, from: e.from, act: e.act, subject: e.subject, body: 'a', ...(e.senderId ? { sender_id: e.senderId } : {}) } }));
  if (r < 0.7) return { l: L.migrateFromInbox(pair.o.agentId, files, now), o: O.migrateFromInbox(pair.o.agentId, files, now) };
  const half = files.length >> 1;
  const input = { inbox: files.slice(0, half), done: files.slice(half), logRows: [] };
  return { l: L.rebuildLedger(pair.o.agentId, input, now), o: O.rebuildLedger(pair.o.agentId, input, now) };
}

/** Whole-document equality: the text (key order included), the key order, and the file writer's text. */
function sameDoc(pair, what) {
  assert.equal(JSON.stringify(pair.l), JSON.stringify(pair.o), `${what}: document text`);
  assert.deepEqual(Object.keys(pair.l.entries), Object.keys(pair.o.entries), `${what}: key order`);
  assert.equal([...L.ledgerTextChunks(pair.l, 512)].join(''), [...O.ledgerTextChunks(pair.o, 512)].join(''), `${what}: file text`);
}

/** Point lookups, without building the new side's entries object. */
function samePoints(pair, rand, what) {
  const ids = Object.keys(pair.o.entries);
  for (const id of [...ids.filter(() => rand() < 0.05), 'absent-x', '17', 's1']) {
    const want = Object.prototype.hasOwnProperty.call(pair.o.entries, id) ? pair.o.entries[id] : undefined;
    assert.deepEqual(L.entryOf(pair.l, id), want, `${what}: entry ${id}`);
  }
}

for (const [seed, readRate] of [[11, 1], [12, 0.2], [13, 0.02], [14, 0]]) {
  test(`every version equals the old copy-per-change ledger (seed ${seed}, entries read on ${readRate * 100}% of steps)`, () => {
    const rand = rng(seed);
    let pair = { l: L.emptyLedger('andy-1'), o: O.emptyLedger('andy-1') };
    let now = T0;
    const kept = [];
    const kinds = new Set();
    for (let n = 0; n < 900; n++) {
      now += Math.floor(rand() * 300);
      if (rand() < 0.02) { pair = reload(pair, rand, now); kinds.add('reload'); continue; }
      // Branch: a change made from an older version (two versions grow from one store).
      const branch = kept.length && rand() < 0.06 ? kept[Math.floor(rand() * kept.length)] : null;
      const step = randomStep(branch ? branch.pair : pair, rand, now, n);
      kinds.add(branch ? 'branch' : step.kind);
      if (!branch || rand() < 0.5) pair = step.pair;
      samePoints(pair, rand, `step ${n}`);
      if (rand() < readRate) sameDoc(pair, `step ${n}`);
      if (rand() < 0.08) kept.push({ pair, text: JSON.stringify(pair.o) });
      if (kept.length && rand() < 0.05) {
        const k = kept[Math.floor(rand() * kept.length)];
        samePoints(k.pair, rand, `step ${n}, an older version`);
        if (rand() < 0.5) sameDoc(k.pair, `step ${n}, an older version`);
      }
    }
    sameDoc(pair, 'final');
    // Published versions are never written: every kept version still reads as it did when kept.
    for (const k of kept) {
      assert.equal(JSON.stringify(k.pair.o), k.text, 'the oracle kept version is unchanged');
      sameDoc(k.pair, 'kept');
    }
    assert.ok(kinds.size >= 24, `the walk reached ${kinds.size} kinds of change: ${[...kinds].join(', ')}`);
  });
}

test('a delivery shares the previous version\'s entries: no copy, one write appended, nothing built', () => {
  let doc = L.emptyLedger('andy-1');
  for (let i = 0; i < 3000; i++) doc = L.applyDelivered(doc, { id: `m${i}`, from: 'god-1', subject: 's', body: 'b' }, T0 + i).doc;
  void doc.entries; // a plain version to start from (the file writer reads it this way)
  const built = L.entryStoreStats.built;
  const before = L.__entryStoreForTest(doc);
  assert.equal(before.built, true);
  let next = doc;
  for (let i = 0; i < 100; i++) next = L.applyDelivered(next, { id: `x${i}`, from: 'god-1', subject: 's', body: 'b' }, T0 + 5000 + i).doc;
  const after = L.__entryStoreForTest(next);
  assert.ok(after.base === before.base, 'the new version reads the old entries object, it does not copy it');
  assert.equal(after.len, 100, 'one write per delivery');
  assert.equal(L.entryStoreStats.built, built, 'no entries object was built by the deliveries');
  assert.equal(L.entryOf(next, 'x99').id, 'x99');
  assert.equal(L.entryOf(doc, 'x99'), undefined, 'the older version does not see the newer write');
  assert.equal(Object.keys(next.entries).length, 3100);
  assert.equal(Object.keys(doc.entries).length, 3000);
});

test('the write log is bounded: a version past the cap is built into a plain object before the next write', () => {
  let doc = L.emptyLedger('andy-1');
  let maxLen = 0;
  const built = L.entryStoreStats.built;
  for (let i = 0; i < 9000; i++) {
    doc = L.applyDelivered(doc, { id: `m${i}`, from: 'god-1', subject: 's', body: 'b' }, T0 + i).doc;
    maxLen = Math.max(maxLen, L.__entryStoreForTest(doc).len);
  }
  assert.ok(maxLen <= 4096, `log length stayed at most 4096 (max ${maxLen})`);
  assert.ok(L.entryStoreStats.built - built >= 2, 'the cap built plain objects along the way');
  assert.deepEqual(Object.keys(doc.entries), Array.from({ length: 9000 }, (_, i) => `m${i}`));
});

test('the MailLedger point lookup reads the entry without building the version', () => {
  let doc = L.emptyLedger('andy-1');
  for (let i = 0; i < 50; i++) doc = L.applyDelivered(doc, { id: `m${i}`, from: 'god-1', subject: 's', body: 'b' }, T0 + i).doc;
  const built = L.entryStoreStats.built;
  assert.equal(L.entryOf(doc, 'm7').id, 'm7');
  assert.equal(L.entryOf(doc, 'constructor'), undefined, 'own entries only');
  assert.equal(L.__entryStoreForTest(doc).built, false);
  assert.equal(L.entryStoreStats.built, built);
});

test('writing `entries` of a version replaces it, like a plain document', () => {
  let doc = L.emptyLedger('andy-1');
  doc = L.applyDelivered(doc, { id: 'm1', from: 'god-1', subject: 's', body: 'b' }, T0).doc;
  const repl = { m2: { ...doc.entries.m1, id: 'm2' } };
  doc.entries = repl;
  assert.ok(doc.entries === repl);
  assert.equal(L.entryOf(doc, 'm1'), undefined);
  assert.equal(L.entryOf(doc, 'm2').id, 'm2');
  const next = L.applyDelivered(doc, { id: 'm3', from: 'god-1', subject: 's', body: 'c' }, T0 + 1).doc;
  assert.deepEqual(Object.keys(next.entries), ['m2', 'm3']);
});

test('two versions made from one version do not see each other\'s writes', () => {
  const deliver = (doc, id, at) => L.applyDelivered(doc, { id, from: 'god-1', subject: 's', body: 'b' }, T0 + at).doc;
  let v0 = L.emptyLedger('andy-1');
  for (let i = 0; i < 5; i++) v0 = deliver(v0, `m${i}`, i);
  const a = deliver(v0, 'a1', 10);
  const b = deliver(v0, 'b1', 11);   // made from v0 after `a` wrote past v0's part of the log
  const a2 = deliver(a, 'a2', 12);
  const b2 = deliver(b, 'b2', 13);
  for (const [doc, has, not] of [[a2, ['a1', 'a2'], ['b1', 'b2']], [b2, ['b1', 'b2'], ['a1', 'a2']], [v0, [], ['a1', 'a2', 'b1', 'b2']]]) {
    for (const id of has) assert.equal(L.entryOf(doc, id)?.id, id);
    for (const id of not) assert.equal(L.entryOf(doc, id), undefined, `${id} is not in this version`);
    assert.equal(L.__entryStoreForTest(doc).built, false);
  }
  assert.deepEqual(Object.keys(a2.entries), ['m0', 'm1', 'm2', 'm3', 'm4', 'a1', 'a2']);
  assert.deepEqual(Object.keys(b2.entries), ['m0', 'm1', 'm2', 'm3', 'm4', 'b1', 'b2']);
  assert.deepEqual(Object.keys(v0.entries), ['m0', 'm1', 'm2', 'm3', 'm4']);
});

test('a document read from disk whose `entries` is replaced is read from the new object', () => {
  let doc = L.emptyLedger('andy-1');
  doc = L.applyDelivered(doc, { id: 'm1', from: 'god-1', subject: 's', body: 'b' }, T0).doc;
  const plain = JSON.parse(JSON.stringify(doc));
  assert.equal(L.entryOf(plain, 'm1').id, 'm1');
  plain.entries = { m2: { ...plain.entries.m1, id: 'm2' } };
  assert.equal(L.entryOf(plain, 'm1'), undefined);
  assert.equal(L.entryOf(plain, 'm2').id, 'm2');
  const next = L.applyDelivered(plain, { id: 'm3', from: 'god-1', subject: 's', body: 'c' }, T0 + 1).doc;
  assert.deepEqual(Object.keys(next.entries), ['m2', 'm3']);
});
