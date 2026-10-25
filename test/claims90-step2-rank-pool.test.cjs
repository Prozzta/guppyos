'use strict';
/**
 * CLAIMS-90 R2 step 2 (Jim 595cc6, god e91938):
 *  (1) the `get:` pointer costs no hit a character: it is one footer line after the hits, outside the hit budget,
 *      once per key; a rank fuzz (claim chunks, 1-5 all-live hits on one key, text <= 250 and <= 400) on seed 7 and a
 *      fresh seed has no cell below a6116736 (the pinned baseline from test/tools/claims90-rank-fuzz.cjs --table);
 *  (2) the RRF candidate pool is sized from the caller's k, never from the stale over-fetch: a search with no
 *      superseded hit prints byte for byte the same with T3 on and off; with one, ON differs only by that row.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const F = loadTs('src/main/nativeMemory/format.ts');
const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
const { TOOL_OUTPUT_CAP_DEFAULT } = loadTs('src/main/toolOutputCondense.ts');
const { fuzz, below } = require('./tools/claims90-rank-fuzz.cjs');
const BASE = require('./fixtures/claims90-rank-fuzz-a6116736.json');

const hit = (i, content, claim, extra = {}) => ({ chunkId: i, wing: 'a1', room: 'memory', source: 'agents/a1/claims.jsonl', content, cosineSim: 0.4, bm25: 0.9, score: 0.9 - i / 1000, claim, ...extra });
const meta = (id, key, status = 'live') => ({ id, status, kind: 'fact', key, at: '2026-10-03T10:00:00.000Z' });
const lines = (t) => t.replace(/\n$/, '').split('\n');

test('step 2 rank fuzz: no n<=5 cell below a6116736 on seed 7 and a fresh seed (whole hit shown; probe term shown)', () => {
  assert.deepEqual(Object.keys(BASE.seeds).sort(), ['7', '9091']);
  for (const [seed, base] of Object.entries(BASE.seeds)) {
    const head = fuzz(F, Number(seed), BASE.trials, [250, 400], [1, 2, 3, 4, 5]);
    assert.deepEqual(below(head, base), [], `MUTANT: seed ${seed}: the pointer costs the lower ranks`);
  }
});

test('step 2 pointer: no meta line carries it; ONE `get:` footer after the hits, each shown key once in printed order, within COMPACT_GET_MAX and the condenser cap', () => {
  assert.ok(F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX < TOOL_OUTPUT_CAP_DEFAULT, 'hits + footer stay under the condenser cap');
  const hits = [hit(1, 'fact · k.a · 2026-10-03\nalpha one', meta('c1', 'k.a')), hit(2, 'fact · k.b · 2026-10-03\nalpha two', meta('c2', 'k.b')),
    hit(3, 'fact · k.a · 2026-10-03\nalpha three', meta('c3', 'k.a')), hit(4, 'a note without a key', null, { source: 'agents/a1/memory.md' })];
  const L = lines(F.formatSearch('alpha', {}, hits));
  assert.ok(L.filter((l) => /^\[\d+\] /.test(l)).every((l) => !l.includes('memory get')), 'MUTANT: a meta line pays for the pointer');
  assert.equal(L.filter((l) => l.includes('memory get')).length, 1, 'one pointer line');
  assert.equal(L[L.length - 1], 'get: memory get k.a · memory get k.b', 'MUTANT: the footer is missing, repeats a key or is out of order');
  const md = lines(F.formatSearch('note', {}, [hits[3]]));
  assert.ok(!md.some((l) => l.includes('memory get')), 'markdown only: no key, no footer');
  const many = Array.from({ length: 12 }, (_, i) => hit(i + 1, `fact · card.some-long-card-name-${i}.state · 2026-10-03\nalpha`, meta(`c${i}`, `card.some-long-card-name-${i}.state`)));
  const t = F.formatSearch('alpha', {}, many);
  const foot = lines(t).pop();
  assert.ok(foot.startsWith('get: memory get card.some-long-card-name-0.state') && foot.length + 1 <= F.COMPACT_GET_MAX, `footer fits: ${foot.length}`);
  assert.ok(t.length < TOOL_OUTPUT_CAP_DEFAULT, `${t.length}`);
});

test('step 2 T3 pool: the store pool is sized from the caller k (poolK); no superseded hit -> ON and OFF print the same bytes; one -> ON differs only by that row', async () => {
  const saved = process.env.C90_HIDE_STALE;
  const calls = [];
  let sup = null;
  // A pool-sensitive store: like RRF, the fused order of the top hits depends on how many candidates were fused.
  const store = { search: (o) => {
    calls.push(o);
    const cand = Math.max(4 * Math.max(1, Math.min(100, Math.floor(o.poolK ?? o.k))), 40);
    const ids = Array.from({ length: 60 }, (_, i) => i + 1).sort((a, b) => ((a * cand) % 61) - ((b * cand) % 61) || a - b);
    return ids.slice(0, o.k).map((i) => hit(i, `fact · k.${i} · 2026-10-03\nvalue ${i}`, meta(`c${i}`, `k.${i}`, i === sup ? 'superseded' : 'live')));
  } };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-step2-'));
  const eng = new MemoryEngine({ hiveRoot: root, store, embedder: { loaded: true, embed: async (x) => x.map(() => new Float32Array(384)), unload: async () => {} },
    countTokens: (x) => x.split(/\s+/).length, mode: () => 'native', watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : { ms }), clearTimer: () => {} });
  const run = async (on) => { process.env.C90_HIDE_STALE = on ? '1' : '0'; return eng.search({ query: 'value', results: 10 }); };
  try {
    const on = await run(true);
    assert.equal(calls[0].k, 20, 'ON over-fetches 2k');
    assert.equal(calls[0].poolK, 10, 'MUTANT: the pool is sized from the over-fetched k');
    const off = await run(false);
    assert.equal(on.text, off.text, 'no superseded hit: byte for byte the same');
    sup = off.json[3].chunkId;
    const on2 = (await run(true)).json.map((h) => h.chunkId);
    const off2 = (await run(false)).json.map((h) => h.chunkId);
    assert.deepEqual(on2.slice(0, 9), off2.filter((i) => i !== sup), 'ON = OFF without the superseded row, in the same order');
    assert.ok(!off2.slice(0, 10).includes(on2[9]), 'then the next hit the over-fetch brings');
    // The store side (no sqlite under node --test): its pool reads poolK, else k.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/nativeMemory/store.ts'), 'utf8');
    assert.match(src, /const cand = Math\.max\(4 \* Math\.max\(1, Math\.min\(100, Math\.floor\(o\.poolK \?\? k\)\)\), 40\);/, 'MUTANT: the store sizes the pool from the over-fetched k');
  } finally {
    if (saved === undefined) delete process.env.C90_HIDE_STALE; else process.env.C90_HIDE_STALE = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
