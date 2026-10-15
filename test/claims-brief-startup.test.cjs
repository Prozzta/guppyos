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
  // Each rebuild measures only its joined text, overflow note and "+N more" again (a few calls; one
  // or two more when the note's room is reserved and the omitted count changes its digits).
  assert.ok(count.calls - first <= 6 * 8, `six rebuilds made ${count.calls - first} new tokenizer calls`);
});

test('CL-BRIEF-STARTUP cause 1: same text and receipt as before the fix (golden), and used = the count of the text', () => {
  const { records, state, view } = fixture(400);
  // CL-OVERFLOW-NOTE: all eight overflow, and in all eight 50d18f14 left the overflow note out; the
  // goldens moved once, to the packs that reserve room for the note and "+N more".
  const golden = { words3000: '7b016f13a5c8e98a', words700: 'a60ceca2370330fe', length9000: '911140b22bf48b3a', length2500: '17668b1c1a853d6b',
    heavySep9000: 'bb87869429961215', heavySep6000: '755d107e075bde6e', heavySep4000: '05c315f3a1617b99', heavySep2500: '1f1f2a9256503fe4' };
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
  // CL-OVERFLOW-NOTE: all four overflow without the note at 50d18f14; these are the packs with it.
  assert.deepEqual(got, ['ee06f0737d376b6c', '124903369d8f7f35', 'b1279077463c4ed9', '67736da889316968'], 'same as before the fix, plus the overflow note');
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

test('CL-BRIEF-STARTUP (Jim NIT): receipt.used is the count of the text with a non-additive counter even when nothing overflows', () => {
  // With no overflow note the running sum is never re-measured, so only the receipt's own count is right.
  const ceil4 = (s) => Math.ceil(s.length / 4);
  const { records, state, view } = fixture(60);
  const out = V.createClaimViews(records, ceil4).buildWorkingSet(state, view, 100_000);
  assert.equal(out.receipt.excluded.filter((x) => x.reason === 'budget' || x.reason === 'tier-share').length, 0, 'nothing overflows');
  assert.equal(out.receipt.used, ceil4(out.text));
});

test('CL-BRIEF-STARTUP (Jim NIT): no budget lets a history pointer (or any line) take the text one token past the cap', () => {
  const { records, state, view } = fixture(120);
  const views = V.createClaimViews(records, (s) => s.length);
  let pointersAtCap = 0;
  for (let b = 300; b <= 4000; b++) {
    const out = views.buildWorkingSet(state, view, b);
    assert.ok(out.receipt.used <= b, `budget ${b}: used ${out.receipt.used}`);
    // CL-OVERFLOW-NOTE: an overflowing briefing ends with the note and "+N more"; the packed lines end before them.
    const packed = out.text.split('\n').filter((l) => !l.startsWith('⚠ Working set omitted') && !/^\+\d+ more$/.test(l));
    if (out.receipt.used === b && / history: memory\.md#/.test(packed.at(-1))) pointersAtCap++;
  }
  assert.ok(pointersAtCap > 0, 'some budget ends exactly at the cap on a history pointer (the boundary is exercised)');
});
