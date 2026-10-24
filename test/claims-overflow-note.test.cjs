'use strict';
require('./tools/own-job.cjs');
// @heavy-lock live: sustained work (about 36 s in the 1.1.91 FULL). HEAVY-LOCK-LIVE-FILE-192: one run of this file takes the heavy slot.
// CL-OVERFLOW-NOTE: when the claims briefing omits claims, the agent is always told. The packer used
// the whole budget for claims and history pointers, then appended the overflow note and "+N more"
// only if they still fit: at the live budget (2,772) they seldom did, so overflow went unannounced.
// The packer now reserves their cost up front. Synthetic claims only; no hive, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const V = loadTs('src/main/claims/views.ts');

const claim = (id, text, extra = {}) => ({ v: 1, id, at: '2026-01-01', wt: '2026-01-01', agent: 'a', prev: '', mac: id,
  t: 'claim', kind: 'fact', text, source: 'self', ...extra });
const stateFor = (records) => ({ v: 1, agent: 'a', registryHash: '', ledgerHead: '', conflicts: [], claims: Object.fromEntries(
  records.filter(r => r.t === 'claim').map(r => [r.id, { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: r.pin === true, reasons: [] }])) });

/** The CL-BRIEF-STARTUP fixture: pins, lessons, keyed values with supersession, flags. */
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
const digest = (x) => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0, 16);
// Jim's counter assumptions: WordPiece (additive over '\n', separator 0), length (additive), ceil4
// (NO_TOKENS, sub-additive), and an additive counter whose separator costs 51.
const COUNTERS = {
  words: (s) => s.split(/\s+/).filter(Boolean).length,
  length: (s) => s.length,
  ceil4: (s) => Math.ceil(s.length / 4),
  heavySep: (s) => s.length + 50 * (s.split('\n').length - 1),
};
const omittedOf = (out) => out.receipt.excluded.filter((x) => x.reason === 'budget' || x.reason === 'tier-share').length;
const noteFor = (omitted, budget) => `⚠ Working set omitted ${omitted} claim(s) at the ${budget}-token budget.`;
// The smallest budget that can carry the note: the header, the note and "+N more" alone.
const minimumFor = (fn, agent, omitted, budget) => fn([`# Memory working set — ${agent}`, noteFor(omitted, budget), `+${omitted} more`].join('\n'));

function sweep(n, fn, budgets) {
  const { records, state, view } = fixture(n);
  const views = V.createClaimViews(records, fn);
  const rows = { overflow: 0, none: 0 };
  for (const b of budgets) {
    const out = views.buildWorkingSet(state, view, b);
    const omitted = omittedOf(out);
    assert.equal(out.receipt.used, fn(out.text), `budget ${b}: receipt.used is the count of the text`);
    assert.ok(out.receipt.used <= b, `budget ${b}: used ${out.receipt.used} is within the budget`);
    const lines = out.text.split('\n');
    if (!omitted) {
      rows.none++;
      assert.ok(!lines.some((l) => l.startsWith('⚠ Working set omitted') || /^\+\d+ more$/.test(l)), `budget ${b}: no note without overflow`);
      continue;
    }
    rows.overflow++;
    if (b < minimumFor(fn, state.agent, omitted, b)) continue;
    assert.deepEqual(lines.slice(-2), [noteFor(omitted, b), `+${omitted} more`], `budget ${b}: ${omitted} omitted, the note and "+N more" end the briefing`);
    assert.equal(out.receipt.warnings.at(-1), noteFor(omitted, b).slice(2), `budget ${b}: the note is the receipt's warning`);
  }
  return rows;
}
const range = (from, to, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

for (const [name, fn] of Object.entries(COUNTERS)) {
  test(`CL-OVERFLOW-NOTE: at every budget of at least the minimum where claims are dropped, the note and "+N more" are present and within budget (${name})`, () => {
    const small = sweep(120, fn, range(150, 4000));
    const large = sweep(400, fn, range(500, 12000, 13));
    assert.ok(small.overflow > 1000 && large.overflow > 500, `the sweeps overflow: ${JSON.stringify({ small, large })}`);
    if (name === 'words') assert.ok(small.none > 0, `the 120-claim sweep also reaches budgets with no overflow: ${JSON.stringify(small)}`);
  });
}

test('CL-OVERFLOW-NOTE: below the minimum budget the note goes in alone if it fits, and at every budget of at least the header nothing goes past the budget', () => {
  const fn = COUNTERS.length;
  const { records, state, view } = fixture(60);
  const views = V.createClaimViews(records, fn);
  const header = fn(`# Memory working set — ${state.agent}`);
  let noteOnly = 0; let moreOnly = 0;
  for (let b = header; b <= 260; b++) {
    const out = views.buildWorkingSet(state, view, b);
    const omitted = omittedOf(out);
    assert.ok(out.receipt.used <= b, `budget ${b}: used ${out.receipt.used}`);
    const lines = out.text.split('\n');
    if (omitted && lines.at(-1) === noteFor(omitted, b)) noteOnly++;
    // Too small for the note, the short "+N more" still says that claims were left out.
    if (omitted && lines.at(-1) === `+${omitted} more` && !lines.includes(noteFor(omitted, b))) moreOnly++;
  }
  assert.ok(noteOnly > 0, 'some budget is too small for "+N more" but carries the note');
  assert.ok(moreOnly > 0, 'some budget is too small for the note but carries "+N more"');
});

test('CL-OVERFLOW-NOTE: the live budget 2,772 (WordPiece-like counter) now ends with the note; before, it ended on a history pointer', () => {
  const { records, state, view } = fixture(400);
  const out = V.createClaimViews(records, COUNTERS.words).buildWorkingSet(state, view, 2772);
  assert.equal(out.receipt.used, 2772);
  assert.equal(omittedOf(out), 280);
  assert.deepEqual(out.text.split('\n').slice(-2), ['⚠ Working set omitted 280 claim(s) at the 2772-token budget.', '+280 more']);
  // 50d18f14 kept the same 87 claims and two more history pointers, and told the agent nothing.
  assert.equal(out.receipt.included.length, 87);
});

test('CL-OVERFLOW-NOTE: byte-identical to 50d18f14 when nothing overflows, and when the note already fitted', () => {
  // Digests taken from guppy/claims-brief-startup @50d18f14 (text and receipt).
  const { records, state, view } = fixture(60);
  const got = Object.fromEntries(Object.entries(COUNTERS).map(([name, fn]) => {
    const out = V.createClaimViews(records, fn).buildWorkingSet(state, view, 100_000);
    assert.equal(omittedOf(out), 0, `${name}: nothing overflows`);
    return [name, digest(out)];
  }));
  assert.deepEqual(got, { words: '089479b4d70d3123', length: '2ebcb2782174449d', ceil4: '1327bb28566ccc75', heavySep: 'cdb87f283060384c' });
  const f400 = fixture(400);
  const out = V.createClaimViews(f400.records, COUNTERS.ceil4).buildWorkingSet(f400.state, f400.view, 2772);
  assert.equal(digest(out), '6259df1c273adc02', 'ceil4 at 2,772: the note already fitted after the full pack, so that pack is kept');
});
