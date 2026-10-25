'use strict';
/**
 * CLAIMS-90 M3a (layout probe, after Jim's re-audit): a CURRENT claim hit in `memory search` opens with ONE
 * line `<key>: <current value>` (an unkeyed claim: its first sentence) and the body continues where that
 * line stops: no copy; when the whole claim fits it is printed once with the key prefix. Prior, prior? and
 * markdown hits have no lead. The wake-up working set opens a keyed claim's line with `<key>: `. Search and
 * wake-up output only: the 1400/158 caps still hold and memory.md rendering is unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const F = loadTs('src/main/nativeMemory/format.ts');
const V = loadTs('src/main/claims/views.ts');

const hit = (i, content, claim, extra = {}) => ({ chunkId: i, wing: 'a1', room: 'memory', source: 'agents/a1/claims.jsonl', content, cosineSim: 0.4, bm25: 0.9, score: 0.9 - i / 1000, claim, ...extra });
const meta = (id, key, kind = 'fact', status = 'live') => ({ id, status, kind, key, at: '2026-10-03T10:00:00.000Z' });
const lines = (t) => t.replace(/\n$/, '').split('\n');
const block = (text, n) => { const ls = lines(text); const a = ls.findIndex((l) => l.startsWith(`[${n}] `)); assert.ok(a >= 0, `hit [${n}] shown`); let b = a + 1; while (b < ls.length && ls[b].startsWith('    ')) b++; return { meta: ls[a], body: ls.slice(a + 1, b).map((l) => l.slice(4)) }; };
const count = (s, needle) => s.split(needle).length - 1;

test('M3a: a keyed current claim opens with `<key>: <current value>`; a whole claim that fits is printed once (compact and --full)', () => {
  const h = hit(1, 'decision · release.current · 2026-10-03\nthe narwhal release current is 1.1.100', meta('c-0000000000k3', 'release.current', 'decision'));
  assert.deepEqual(F.leadSplit(h), { lead: 'release.current: the narwhal release current is 1.1.100', rest: '' });
  assert.equal(F.leadLine(h), 'release.current: the narwhal release current is 1.1.100');
  const compact = F.formatSearch('narwhal release current', {}, [h]);
  const b = block(compact, 1);
  assert.match(b.meta, /^\[1\] current · decision · release\.current · 2026-10-03/);
  assert.deepEqual(b.body, ['release.current: the narwhal release current is 1.1.100'], 'MUTANT: the whole claim once, with the key prefix, and no header line');
  assert.equal(count(compact, 'narwhal release current is'), 1, 'MUTANT: no copy of the value');
  const full = F.formatSearch('narwhal release current', { full: true }, [h]);
  const fl = lines(full);
  const at = fl.findIndex((l) => /^      Match:  cosine_sim=/.test(l));
  assert.equal(fl[at + 1], '      release.current: the narwhal release current is 1.1.100', 'MUTANT: --full opens the content with the lead line');
  assert.equal(fl[at + 2], '', 'the blank line and the whole content follow as before');
});

test('M3a: an unkeyed claim leads with its first sentence when clipped; a `##` heading is never the value', () => {
  const h = hit(2, 'fact · - · 2026-10-02\n## Notes\na narwhal note with no key at all. It goes on! And on?', meta('c-0000000000u1', null));
  assert.deepEqual(F.leadSplit(h), { lead: 'a narwhal note with no key at all.', rest: 'It goes on! And on?' }, 'MUTANT: first sentence, heading dropped');
  assert.equal(F.leadLine(hit(3, 'fact · - · 2026-10-02\nno punctuation at all here', meta('c-0000000000u2', null))), 'no punctuation at all here', 'a single sentence without a stop is the whole line');
  assert.equal(F.leadLine(hit(4, 'fact · - · 2026-10-02\n', meta('c-0000000000u3', null))), null, 'no text: no lead line');
  assert.deepEqual(block(F.formatSearch('narwhal note', {}, [h]), 1).body, ['a narwhal note with no key at all. It goes on! And on?'], 'a whole claim that fits is printed once, heading dropped');
  // Clipped: the first sentence is the lead line and the body continues after it.
  const long = hit(5, `fact · - · 2026-10-02\na pelican note with no key. ${Array.from({ length: 300 }, (_, i) => `filler${i}`).join(' ')} the pelican sha is 1234abcd end`, meta('c-0000000000u4', null));
  const body = block(F.formatSearch('pelican sha 1234abcd', {}, [long, hit(6, 'fact · - · 2026-10-02\nother', meta('c-0000000000u5', null))]), 1).body;
  assert.equal(body[0], 'a pelican note with no key.', 'MUTANT: the lead is the first sentence');
  assert.match(body.slice(1).join(' '), /1234abcd/, 'the window after it still shows the match');
});

test('M3a: only a CURRENT hit gets the lead; prior and prior? hits keep their body unchanged (compact and --full)', () => {
  const live = hit(7, 'fact · release.tip · 2026-10-03\ntip is 1111aaaa', meta('c-0000000000new', 'release.tip'));
  const prior = hit(8, 'fact · release.tip · 2026-10-02\ntip is 2222bbbb', meta('c-0000000000old', 'release.tip', 'fact', 'superseded'));
  const unsure = hit(9, 'fact · release.tip · 2026-10-01\ntip is 3333cccc', meta('c-0000000000unc', 'release.tip', 'fact', 'superseded?'));
  assert.equal(F.leadLine(live), 'release.tip: tip is 1111aaaa');
  assert.equal(F.leadLine(prior), null, 'MUTANT: a prior hit has no `key: value` line');
  assert.equal(F.leadLine(unsure), null, 'MUTANT: a prior? hit has no `key: value` line');
  const compact = F.formatSearch('release tip', {}, [live, prior, unsure]);
  assert.deepEqual(block(compact, 1).body, ['release.tip: tip is 1111aaaa']);
  assert.match(block(compact, 2).meta, /^\[2\] prior · /);
  assert.deepEqual(block(compact, 2).body, ['fact · release.tip · 2026-10-02 tip is 2222bbbb'], 'MUTANT: the prior body is the M1 body');
  assert.match(block(compact, 3).meta, /^\[3\] prior\? · /);
  assert.deepEqual(block(compact, 3).body, ['fact · release.tip · 2026-10-01 tip is 3333cccc']);
  assert.equal(count(compact, 'release.tip: '), 1, 'exactly one lead line in the whole output');
  const full = F.formatSearch('release tip', { full: true }, [live, prior, unsure]);
  assert.equal(count(full, 'release.tip: '), 1, 'MUTANT: --full prints the lead on the current hit only');
});

test('M3a: a clipped current hit continues after its lead, no copy; a later part of a long claim leads with the claim lead; markdown unchanged', () => {
  const value = Array.from({ length: 120 }, (_, i) => `pelican lighthouse ${i}`).join(' ');
  const parts = [1, 2, 3].map((i) => hit(10 + i, `fact · release.tip.${i} · 2026-10-03\n${value} the pelican tip sha is 1234abcd${i}`, meta(`c-00000000lon${i}`, `release.tip.${i}`)));
  const md = hit(20, '# Heading\nplain markdown chunk about narwhals', null);
  assert.equal(F.leadLine(md), null);
  const text = F.formatSearch('narwhal', {}, [...parts, md]);
  const b = block(text, 1);
  assert.equal(b.body[0], F.wrap(`release.tip.1: ${value}`, F.COMPACT_LINE_MAX - 4)[0], 'MUTANT: the lead is the first wrapped line of `key: value`');
  const shown = b.body.join(' ').replace(/…$/, '');
  assert.ok(`release.tip.1: ${value} the pelican tip sha is 1234abcd1`.startsWith(shown), 'MUTANT: the body continues where the lead stops, nothing repeated');
  assert.equal(count(text, 'release.tip.1: '), 1);
  assert.deepEqual(block(text, 4).body, ['# Heading plain markdown chunk about narwhals'], 'MUTANT: a markdown hit is unchanged');
  // A later part of a long claim carries the claim lead in its text: the lead line opens with it, the match still shows.
  const part2 = hit(30, 'fact · release.tip · 2026-10-03\npelican lighthouse 0 pelican lighthouse 1 pelican lighthouse 2 …\npelican lighthouse 120 the pelican tip sha is 1234abcd', meta('c-00000000long', 'release.tip'));
  const t2 = F.formatSearch('pelican tip sha 1234abcd', {}, [part2]);
  assert.match(block(t2, 1).body[0], /^release\.tip: pelican lighthouse 0 pelican lighthouse 1 pelican lighthouse 2 … pelican lighthouse 120 the pelican tip sha is 1234abcd$/);
});

test('M3a: the 1400/158 caps hold with leads on every hit (1, 5 and 12 keyed hits, long values); the match stays visible', () => {
  const lorem = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}word${i}`).join(' ');
  for (const n of [1, 5, 12]) {
    const hits = Array.from({ length: n }, (_, i) => hit(10 + i, `fact · k.${i}.${lorem(6, 'key')} · 2026-10-03\n${lorem(60, `v${i}`)}`, meta(`c-000000000${String(i).padStart(3, '0')}`, `k.${i}.${lorem(6, 'key')}`)));
    const text = F.formatSearch('v0word33', {}, hits);
    assert.ok(text.length <= F.COMPACT_MAX_CHARS, `${n} hits: ${text.length} <= ${F.COMPACT_MAX_CHARS}`);
    assert.ok(lines(text).every((l) => l.length <= F.COMPACT_LINE_MAX), `${n} hits: every line <= ${F.COMPACT_LINE_MAX}`);
    const b = block(text, 1);
    assert.match(b.body[0], /^k\.0\.keyword0 /, `${n} hits: MUTANT: the first hit opens with its key`);
    assert.equal(lines(text).filter((l) => /^    k\.0\.keyword0 /.test(l)).length, 1, `${n} hits: the lead exactly once`);
    assert.match(b.body.join(' '), /v0word33/, `${n} hits: MUTANT: the matched term is shown in the hit's block`);
    assert.ok(count(b.body.join(' '), 'v0word1 ') <= 1, `${n} hits: no part of the value is repeated`);
  }
});

test('M3a: the wake-up working set opens a keyed claim line with `<key>: `; unkeyed and memory.md are unchanged', () => {
  const claim = (id, text, extra = {}) => ({ v: 1, id, at: '2026-01-01', wt: '2026-01-01', agent: 'a', prev: '', mac: id, t: 'claim', kind: 'fact', text, source: 'self', ...extra });
  const records = [claim('keyed', 'the release current is 1.1.100', { key: 'release.current' }), claim('plain', 'a note without a key')];
  const state = { v: 1, agent: 'a', registryHash: '', ledgerHead: '', conflicts: [], claims: Object.fromEntries(records.map((r) => [r.id, { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: false, reasons: [] }])) };
  const views = V.createClaimViews(records, (s) => s.length);
  const working = views.buildWorkingSet(state, { flags: {}, counters: {} }, 5000).text;
  assert.match(working, /^- release\.current: the release current is 1\.1\.100 \[status:current\] \[c:keyed\]$/m, 'MUTANT: the keyed line opens with the key');
  assert.match(working, /^- a note without a key \[status:current\] \[c:plain\]$/m, 'an unkeyed line is unchanged');
  const md = views.renderMemoryMd(state, { flags: {}, counters: {} }, 'complete');
  assert.match(md, /^- the release current is 1\.1\.100 \[status:live\] \[c:keyed\]$/m, 'MUTANT: memory.md rendering is unchanged');
  assert.doesNotMatch(md, /release\.current: the release/);
});

test('M3a: on a tight share the lead is shortened, never at the cost of the match: a sha at any char of the value stays visible (hit 3 of 5)', () => {
  const lorem = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}word${i}`).join(' ');
  const sha = 'f00dcafe1234567890abcdef1234567890abcdef';
  for (let at = 0; at <= 120; at++) {
    const hits = Array.from({ length: 5 }, (_, i) => {
      let v = lorem(60, `v${i}`);
      if (i === 2) v = `${v.slice(0, at)} ${sha} ${v.slice(at)}`;
      return hit(10 + i, `fact · k.${i} · 2026-10-03\n${v}`, meta(`c-000000000${String(i).padStart(3, '0')}`, `k.${i}`));
    });
    const text = F.formatSearch('f00dcafe', {}, hits);
    assert.ok(text.length <= F.COMPACT_MAX_CHARS && lines(text).every((l) => l.length <= F.COMPACT_LINE_MAX), `at ${at}: caps`);
    const b = block(text, 3);
    assert.match(b.body.join(' '), /f00dcafe/, `MUTANT: with the sha at char ${at} it is shown in hit [3] (the shortened lead cut it in two: the plain window takes over)`);
    assert.ok(b.body[0].startsWith('k.2: ') || b.body[0].startsWith('…'), `at ${at}: the hit opens with its lead or with the window`);
  }
});
