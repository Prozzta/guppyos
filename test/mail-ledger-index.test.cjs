'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-LEDGER-SCANS-108: the mail ledger's query index (src/main/mailLedger.ts, `LedgerIndex`).
 *
 * classifyIncoming, resolveEntries / applyReplied (sender_id aliases) and backlogEntries read an
 * index instead of scanning every entry. Each result must be exactly what the full scan gives:
 * the same entry objects in the same order. This test checks that after every kind of ledger change
 * (every pure transition, prune, withdraw/close, archive/acted, rebuild, migration, a reload from
 * disk), for the newest version and for older versions kept around, and with the queries run
 * often, rarely or not at all between changes. It also checks the index is carried over between
 * versions rather than rebuilt (the point of the card), and that every in-place write in the file
 * drops the index.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const L = loadTs('src/main/mailLedger.ts');
const T0 = Date.parse('2026-11-17T10:00:00.000Z');

// ——— the full scans, as the code read before the index

const bySeq = (a, b) => a.seq - b.seq || a.deliveredAt - b.deliveredAt;
const scanBacklog = (doc) => Object.values(doc.entries).filter((e) => e.state !== 'acted').sort(bySeq);
const scanResolve = (doc, ref) => (doc.entries[ref] ? [doc.entries[ref]] : Object.values(doc.entries).filter((e) => e.senderId === ref).sort(bySeq));
function scanClassify(doc, msg, readExisting) {
  const content = L.mailContentHash(msg.subject ?? '', msg.body ?? '');
  const inLedger = [doc.entries[msg.id], ...Object.values(doc.entries).filter((e) => e.senderId === msg.id && e.id !== msg.id)].filter(Boolean);
  for (const e of inLedger) {
    if (e.from === msg.from && typeof e.contentHash === 'string' && e.contentHash === content) return { kind: 'dup', existingId: e.id };
  }
  if (inLedger.length) return { kind: 'conflict', reason: 'ledger' };
  const found = readExisting(msg.id);
  if (found === null) return { kind: 'free' };
  if (found === 'unreadable') return { kind: 'conflict', reason: 'unreadable' };
  if (String(found.from) === msg.from && L.mailContentHash(found.subject ?? '', found.body ?? '') === content) return { kind: 'dup', existingId: msg.id };
  return { kind: 'conflict', reason: 'file' };
}

/** The same entry objects, in the same order. */
function sameEntries(got, want, what) {
  assert.equal(got.length, want.length, `${what}: ${got.length} entries, the scan has ${want.length}`);
  for (let i = 0; i < want.length; i++) assert.ok(got[i] === want[i], `${what}: entry ${i} is ${got[i] && got[i].id}, the scan has ${want[i].id}`);
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const SENDERS = ['s1', 's2', 's3', 's4'];
const FROMS = ['god-1', 'jim-1'];
const BODIES = ['a', 'b', 'c'];

/** Compare every indexed query on `doc` with the scan, for a spread of references. */
function checkAll(doc, rand, what) {
  sameEntries(L.backlogEntries(doc), scanBacklog(doc), `${what} backlog`);
  const ids = Object.keys(doc.entries);
  const refs = [...SENDERS, 'fresh-x', ...ids.slice(-4), ids[Math.floor(rand() * ids.length)]].filter(Boolean);
  for (const ref of refs) {
    sameEntries(L.resolveEntries(doc, ref), scanResolve(doc, ref), `${what} resolve ${ref}`);
    assert.deepEqual(L.aliasesIn(doc, ref).sort(), [...new Set([ref, ...scanResolve(doc, ref).flatMap((e) => [e.id, ...(e.senderId ? [e.senderId] : [])])])].sort(), `${what} aliases ${ref}`);
    for (const from of FROMS) {
      for (const body of BODIES) {
        const m = { id: ref, from, subject: 'subj', body };
        const read = (id) => (id === 'fresh-x' ? { from: 'god-1', subject: 'subj', body: 'a' } : null);
        assert.deepEqual(L.classifyIncoming(doc, m, read), scanClassify(doc, m, read), `${what} classify ${ref}/${from}/${body}`);
      }
    }
  }
}

/** One random change, through the same function the product uses for it. */
function randomStep(doc, rand, now, n) {
  const ids = Object.keys(doc.entries);
  const pick = () => ids[Math.floor(rand() * ids.length)];
  const some = () => ids.filter(() => rand() < 0.25);
  const epoch = `e${1 + Math.floor(rand() * 3)}`;
  const msg = () => {
    const r = rand();
    // Some message ids are another message's sender_id, so the exact id and the alias both match.
    // Some are all digits ("17"; MAIL_ID_RE accepts them): integer-like keys sort first in key
    // order, so an index that appended them would order a sender's ids wrongly (Jim S1).
    const id = r < 0.1 ? SENDERS[Math.floor(rand() * SENDERS.length)] : r < 0.2 ? String(n) : `m${n}`;
    return {
      id, from: FROMS[Math.floor(rand() * FROMS.length)], act: rand() < 0.4 ? 'request' : 'inform',
      subject: 'subj', body: BODIES[Math.floor(rand() * BODIES.length)],
      ...(rand() < 0.6 ? { sender_id: SENDERS[Math.floor(rand() * SENDERS.length)] } : {})
    };
  };
  switch (Math.floor(rand() * 22)) {
    case 0: case 1: case 2: case 3: return { doc: L.applyDelivered(doc, msg(), now).doc, kind: 'delivered' };
    case 4: return { doc: L.applyWorkOrder(doc, msg(), now).doc, kind: 'work-order' };
    case 5: return { doc: L.applyWorkOrderLeftover(doc, msg(), now).doc, kind: 'work-order-leftover' };
    case 6: return { doc: L.applyClaimSurfacing(doc, some(), epoch, 'hook', now).doc, kind: 'claim-surfacing' };
    case 7: return { doc: L.applyConfirmSurfaced(doc, some(), epoch, 'evidence', now).doc, kind: 'confirm-surfaced' };
    case 8: return { doc: L.applyMarkActed(doc, some(), epoch, now).doc, kind: 'acted (archive)' };
    case 9: return { doc: L.applyReinject(doc, some(), epoch, 'hook', now).doc, kind: 'reinject' };
    case 10: return { doc: L.applyRedeliver(doc, some(), 'test', now).doc, kind: 'redeliver' };
    case 11: return { doc: L.applyLegacyActed(doc, some(), rand() < 0.5 ? 'legacy-read' : 'legacy-move', now).doc, kind: 'legacy-acted (archive)' };
    case 12: return { doc: ids.length ? L.applyBodyMissing(doc, pick(), 'gone', now).doc : doc, kind: 'body-missing' };
    case 13: return { doc: ids.length ? L.applyParseFailed(doc, pick(), 'sig', now).doc : doc, kind: 'parse-failed' };
    case 14: return { doc: ids.length ? L.applyReappeared(doc, pick(), now).doc : doc, kind: 'reappeared' };
    case 15: return { doc: L.applyCloseEpoch(doc, epoch, rand() < 0.5 ? 'normal' : 'abnormal', now).doc, kind: 'close-epoch' };
    case 16: {
      const ref = rand() < 0.5 ? SENDERS[Math.floor(rand() * SENDERS.length)] : pick();
      return { doc: ref ? L.applyReplied(doc, ref, `r${n}`, now, FROMS[Math.floor(rand() * FROMS.length)], rand() < 0.5 ? 'done' : 'inform').doc : doc, kind: 'replied (replace)' };
    }
    case 17: {
      const ref = rand() < 0.5 ? SENDERS[Math.floor(rand() * SENDERS.length)] : pick();
      return { doc: ref ? L.applyCloseObligation(doc, ref, now, L.askCloseReason('requester', 'test')).doc : doc, kind: 'close (withdraw)' };
    }
    case 18: return { doc: L.applyRestartRecovery(doc, now).doc, kind: 'restart-recovery' };
    case 19: return { doc: L.applyPrune(doc, now, 2000).doc, kind: 'prune' };
    case 20: return { doc: L.applySetAside(doc, some(), rand() < 0.5, now).doc, kind: 'set-aside' };
    default: return { doc: L.applyChannelOverride(doc, rand() < 0.5 ? { mode: 'legacy-read', reason: 'x', since: now } : null).doc, kind: 'channel' };
  }
}

/** Replace the document the way the I/O shell does: a reload from disk, a rebuild, a migration. */
function reload(doc, rand, now) {
  const r = rand();
  if (r < 0.4) return { doc: JSON.parse(JSON.stringify(doc)), kind: 'reload' };
  const files = Object.values(doc.entries).map((e) => ({ id: e.id, mtimeMs: e.deliveredAt, msg: { id: e.id, from: e.from, act: e.act, subject: e.subject, body: 'a', ...(e.senderId ? { sender_id: e.senderId } : {}) } }));
  if (r < 0.7) return { doc: L.migrateFromInbox(doc.agentId, files, now), kind: 'migrate' };
  const half = files.length >> 1;
  return { doc: L.rebuildLedger(doc.agentId, { inbox: files.slice(0, half), done: files.slice(half), logRows: [] }, now), kind: 'rebuild' };
}

for (const [seed, queryRate] of [[1, 1], [2, 0.3], [3, 0.05], [4, 0.6]]) {
  test(`every indexed query equals the full scan after every change (seed ${seed}, queried ${queryRate * 100}% of steps)`, () => {
    const rand = rng(seed);
    let doc = L.emptyLedger('andy-1');
    let now = T0;
    const kept = [];
    const kinds = new Set();
    for (let n = 0; n < 700; n++) {
      now += Math.floor(rand() * 300);
      const step = rand() < 0.02 ? reload(doc, rand, now) : randomStep(doc, rand, now, n);
      doc = step.doc;
      kinds.add(step.kind);
      if (rand() < queryRate) checkAll(doc, rand, `step ${n} (${step.kind})`);
      if (rand() < 0.1) kept.push(doc);
      // An older version must still read right after newer ones were made from it.
      if (kept.length && rand() < 0.1) checkAll(kept[Math.floor(rand() * kept.length)], rand, `step ${n}, an older version`);
    }
    checkAll(doc, rand, 'final');
    for (const d of kept) checkAll(d, rand, 'kept');
    assert.ok(kinds.size >= 22, `the walk reached ${kinds.size} kinds of change: ${[...kinds].join(', ')}`);
  });
}

test('the returned backlog belongs to the caller: changing it changes no later result', () => {
  let doc = L.emptyLedger('andy-1');
  for (let i = 0; i < 5; i++) doc = L.applyDelivered(doc, { id: `m${i}`, from: 'god-1', subject: 's', body: `b${i}` }, T0 + i).doc;
  const first = L.backlogEntries(doc);
  first.length = 0;
  sameEntries(L.backlogEntries(doc), scanBacklog(doc), 'after the caller emptied its copy');
});

test('the index is carried from version to version: the router loop and fleet writes never rescan', () => {
  let doc = L.emptyLedger('god-1');
  let now = T0;
  for (let i = 0; i < 1500; i++) doc = L.applyDelivered(doc, { id: `m${i}`, from: 'jim-1', subject: 's', body: `b${i}`, ...(i % 7 === 0 ? { sender_id: `snd${i % 5}` } : {}) }, ++now).doc;
  L.classifyIncoming(doc, { id: 'warm', from: 'x', subject: 's', body: 'b' }, () => null);
  L.backlogEntries(doc);
  const before = { ...L.ledgerIndexStats };
  for (let i = 0; i < 300; i++) {
    const m = { id: `n${i}`, from: 'jim-1', subject: 's', body: `c${i}`, ...(i % 3 === 0 ? { sender_id: `snd${i % 5}` } : {}) };
    assert.deepEqual(L.classifyIncoming(doc, m, () => null), scanClassify(doc, m, () => null));
    doc = L.applyDelivered(doc, m, ++now).doc;
    if (i % 10 === 0) doc = L.applyMarkActed(L.applyConfirmSurfaced(L.applyClaimSurfacing(doc, [`m${i}`, `n${i}`], `ep${i}`, 'hook', ++now).doc, [`m${i}`, `n${i}`], `ep${i}`, 'evidence', ++now).doc, [`m${i}`, `n${i}`], `ep${i}`, ++now).doc;
    if (i % 25 === 0) doc = L.applyReplied(doc, `snd${i % 5}`, `r${i}`, ++now, 'jim-1', 'done').doc;
    if (i % 5 === 0) sameEntries(L.backlogEntries(doc), scanBacklog(doc), `fleet write ${i}`);
  }
  assert.deepEqual({ ...L.ledgerIndexStats }, before, 'no query rebuilt an index by a full scan');
});

test('every write to an entries object in mailLedger.ts goes through a writer that drops the index', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'mailLedger.ts'), 'utf8');
  // LAG-LEDGER-DRAFT-COPY-108: entries live in a store shared between versions; storeSet is its
  // only writer, and every caller drops the index of the store it writes first.
  const assigns = src.match(/entries\[[^\]]+\]\s*=(?!=)/g) || [];
  const deletes = src.match(/delete\s+[\w.]*entries\[/g) || [];
  assert.deepEqual(assigns, [], 'no code assigns into an entries object');
  assert.equal(deletes.length, 0, 'no code deletes from an entries object');
  const matWrites = src.match(/\.mat\[[^\]]+\]\s*=(?!=)|delete\s+[\w.]*\.mat\[/g) || [];
  assert.equal(matWrites.length, 2, 'only storeSet writes into a built entries object');
  const calls = src.match(/storeSet\(/g) || [];
  assert.equal(calls.length, 4, 'storeSet is defined once and called by Draft.put, Draft.remove and putInPlace');
  assert.match(src, /put\(entry: MailEntry\): void \{\s*dropIndex\(this\.store\);/, 'Draft.put drops the index first');
  assert.match(src, /remove\(id: string\): void \{\s*dropIndex\(this\.store\);/, 'Draft.remove drops the index first');
  assert.match(src, /function putInPlace\(doc: MailLedgerDoc, entry: MailEntry\): void \{\s*const s = storeOf\(doc\);\s*dropIndex\(s\);/, 'putInPlace drops the index first');
  assert.doesNotMatch(src, /Object\.values\([\w.]*entries\)\.filter\(\(e\) => e\.senderId ===/, 'no sender_id query scans the entries');
});
