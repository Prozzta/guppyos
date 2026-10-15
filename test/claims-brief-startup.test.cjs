'use strict';
// CL-BRIEF-STARTUP: the claims briefing reaches the agent at startup and after a compaction, and its
// log row says what the agent got.
//  - Cause 1: the working set re-tokenized the whole output for every candidate line (quadratic):
//    4.1 s for a 1,023-claim ledger, past the hook shim's 5 s give-up with startup load on top.
//  - Cause 2: the briefing row judged the flush against the 2.5 s mail margin, so a reply the shim
//    printed at 3-4 s was logged as shim-gave-up with printedChars 0.
// Synthetic claims only; no hive, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const V = loadTs('src/main/claims/views.ts');

const claim = (id, text, extra = {}) => ({ v: 1, id, at: '2026-01-01', wt: '2026-01-01', agent: 'a', prev: '', mac: id,
  t: 'claim', kind: 'fact', text, source: 'self', ...extra });
const stateFor = (records) => ({ v: 1, agent: 'a', registryHash: '', ledgerHead: '', conflicts: [], claims: Object.fromEntries(
  records.filter(r => r.t === 'claim').map(r => [r.id, { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: r.pin === true, reasons: [] }])) });

/** A deterministic ledger of `n` claims: pins, lessons, keyed values with supersession, flags. */
function fixture(n) {
  const words = ['heavy', 'lock', 'suite', 'mutant', 'ledger', 'claim', 'tes', 'floor', 'camera', 'shim', 'pipe', 'mail', 'cut', 'release', 'worktree'];
  const records = [];
  for (let i = 0; i < n; i++) {
    const len = 8 + ((i * 7) % 40);
    const text = Array.from({ length: len }, (_, k) => words[(i * 3 + k * 5) % words.length]).join(' ') + ` #${i}`;
    const day = `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`;
    const extra = { at: day, wt: day };
    if (i % 37 === 0) extra.pin = true;
    if (i % 53 === 0) extra.kind = 'lesson';
    if (i % 11 === 0) extra.key = `k.${i % 44}`;
    records.push(claim(`c-${String(i).padStart(4, '0')}`, text, extra));
  }
  const state = stateFor(records);
  for (let i = 0; i < n; i++) if (i % 11 === 0 && i + 44 < n) { state.claims[records[i].id].status = 'superseded'; state.claims[records[i].id].supersededBy = records[i + 44].id; }
  for (let i = 0; i < n; i++) state.claims[records[i].id].lastAt = records[i].at;
  const flags = {}; for (let i = 5; i < n; i += 97) flags[records[i].id] = ['unverified'];
  return { records, state, view: { flags, counters: {} } };
}
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const digest = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
const counting = (fn) => { const c = (s) => { c.calls++; return fn(s); }; c.calls = 0; return c; };

test('CL-BRIEF-STARTUP cause 1: a 1,000-claim working set counts each line about once, not the whole output per line', () => {
  const { records, state, view } = fixture(1000);
  const count = counting(wordCount);
  const views = V.createClaimViews(records, count);
  const out = views.buildWorkingSet(state, view, 3000);
  assert.ok(out.receipt.included.length > 50, 'the fixture fills the budget');
  assert.ok(count.calls <= 1100, `tokenizer calls: ${count.calls} (the quadratic build made several per line)`);
});

test('CL-BRIEF-STARTUP cause 1: the scale-down rebuilds reuse the line counts (one views object, several budgets)', () => {
  const { records, state, view } = fixture(1000);
  const count = counting(wordCount);
  const views = V.createClaimViews(records, count);
  views.buildWorkingSet(state, view, 3000);
  const first = count.calls;
  for (const b of [2400, 1900, 1500, 1200, 1000, 800]) views.buildWorkingSet(state, view, b);
  // Each rebuild measures only its joined text, overflow note and "+N more" again (a few calls).
  assert.ok(count.calls - first <= 6 * 6, `six rebuilds made ${count.calls - first} new tokenizer calls`);
});

test('CL-BRIEF-STARTUP cause 1: same text and receipt as before the fix (golden), and used = the count of the text', () => {
  const { records, state, view } = fixture(400);
  const golden = { words3000: '6c2bcd34d3f37c8c', words700: 'ca396b15876583da', length9000: '771778c898deb705', length2500: '766216b8e3d25f0c',
    heavySep9000: '85fe9f9d2b7d50f0', heavySep6000: 'aa230efbf8595228', heavySep4000: 'd7fde4e2198a4a4e', heavySep2500: 'e9adbfb3a7e775aa' };
  // Additive over '\n' like WordPiece, but each separator costs 51: the running sums must count them.
  const heavySep = (s) => s.length + 50 * (s.split('\n').length - 1);
  const got = {};
  for (const [name, fn, budget] of [['words3000', wordCount, 3000], ['words700', wordCount, 700], ['length9000', (s) => s.length, 9000], ['length2500', (s) => s.length, 2500],
    ['heavySep9000', heavySep, 9000], ['heavySep6000', heavySep, 6000], ['heavySep4000', heavySep, 4000], ['heavySep2500', heavySep, 2500]]) {
    const out = V.createClaimViews(records, fn).buildWorkingSet(state, view, budget);
    assert.equal(out.receipt.used, fn(out.text), `${name}: receipt.used is the count of the delivered text`);
    assert.ok(out.receipt.used <= budget, `${name}: within the budget`);
    got[name] = digest(out);
  }
  assert.deepEqual(got, golden);
});

test('CL-BRIEF-STARTUP cause 1: separators count in T0 too, and a non-additive counter still gets used = the count of the text', () => {
  // 120 short pins, each separator 51: T0's share is not the binding limit, the cap with separators is.
  const pins = Array.from({ length: 120 }, (_, i) => claim(`p-${String(i).padStart(3, '0')}`, `pin ${i}`, { pin: true }));
  const heavySep = (s) => s.length + 50 * (s.split('\n').length - 1);
  // 342 and 426 sit where one more pin fits only if its separator is left out.
  const got = [2000, 1000, 426, 342].map((b) => digest(V.createClaimViews(pins, heavySep).buildWorkingSet(stateFor(pins), { flags: {}, counters: {} }, b)));
  assert.deepEqual(got, ['a77b9d14d1c0d6fc', 'def666edcdb27828', '8b896c09fc55da03', 'e6684fc00661f16a'], 'same as before the fix');
  // ceil(len/4) is not additive over '\n' (WordPiece is): the per-line sums only over-estimate, so the
  // build stays inside the budget, and the receipt is still the count of the joined text.
  const ceil4 = (s) => Math.ceil(s.length / 4);
  const { records, state, view } = fixture(400);
  for (const b of [3000, 1200]) {
    const out = V.createClaimViews(records, ceil4).buildWorkingSet(state, view, b);
    assert.equal(out.receipt.used, ceil4(out.text), `ceil4 ${b}`);
    assert.ok(out.receipt.used <= b && out.receipt.used > b * 0.9, `ceil4 ${b}: ${out.receipt.used}`);
  }
});
