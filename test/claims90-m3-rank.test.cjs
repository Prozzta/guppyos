'use strict';
/**
 * CLAIMS-90 M3 (ranking, Jim's fix 1 + 2 targets): (S2) the compact window anchors on the MOST SPECIFIC matched
 * query term (a sha, version, card id or claim id over a dotted key over a word), so a topic word at the head of
 * a chunk no longer pulls the window off the value the query names; and a key-aware lift: inside each status
 * group of the compact list, a hit the query names (its whole key, a card id segment of it, its claim id, or a
 * sha / version / card id in its content) comes first. A plain word never lifts; a prior never crosses above the
 * current value of its key; `--full` keeps the store order. Pure functions, no store.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const F = loadTs('src/main/nativeMemory/format.ts');

const hit = (i, content, claim, extra = {}) => ({ chunkId: i, wing: 'a1', room: 'memory', source: 'agents/a1/claims.jsonl', content, cosineSim: 0.4, bm25: 0.9, score: 0.9 - i / 1000, claim, ...extra });
const meta = (id, key, kind = 'fact', status = 'live') => ({ id, status, kind, key, at: '2026-10-03T10:00:00.000Z' });
const md = (i, content) => hit(i, content, null, { source: `agents/a1/memory-${i}.md` });
const lines = (t) => t.replace(/\n$/, '').split('\n');
const block = (text, n) => { const ls = lines(text); const a = ls.findIndex((l) => l.startsWith(`[${n}] `)); assert.ok(a >= 0, `hit [${n}] shown`); let b = a + 1; while (b < ls.length && ls[b].startsWith('    ')) b++; return { meta: ls[a], body: ls.slice(a + 1, b).map((l) => l.slice(6)) }; };  // M3: `    | ` before each body line
const metas = (text) => lines(text).filter((l) => /^\[\d+\] /.test(l)).map((l) => l.replace(/^\[\d+\] /, ''));
const filler = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}word${i}`).join(' ');
const SHA = 'f00dcafe1234567890abcdef1234567890abcdef';

test('M3 termSpecificity: sha, version, card id and claim id are 3; a dotted key is 2; a word is 1', () => {
  for (const t of ['f00dcafe', SHA, '1.1.102', '1.2.3.4', 'claims-90', 'gate-178', 'c-0000000000a3']) assert.equal(F.termSpecificity(t), 3, t);
  for (const t of ['release.tip', 'card.claims-90', 'k.0.keyword', '1.1']) assert.equal(F.termSpecificity(t), 2, t);
  for (const t of ['release', 'tip', 'f00dca', 'claims-', 'c-abc', 'x-1y']) assert.equal(F.termSpecificity(t), 1, t);
});

test('M3 S2: the window anchors on the most specific matched term, the earliest among equals (MUTANT: the earliest term)', () => {
  const content = `release ${filler(60, 'v')} the tip is ${SHA} done`;
  const sha = F.windowContent(content, `release ${SHA.slice(0, 8)}`, 120, 'window');
  assert.ok(sha.text.includes('f00dcafe'), `MUTANT: the sha must be in the window, got ${sha.text}`);
  const ver = F.windowContent(`release ${filler(60, 'v')} cut 1.1.102 shipped`, 'release 1.1.102', 120, 'window');
  assert.ok(ver.text.includes('1.1.102'), ver.text);
  const key = F.windowContent(`release ${filler(60, 'v')} key release.tip holds`, 'release release.tip', 120, 'window');
  assert.ok(key.text.includes('release.tip'), `a dotted key beats a word: ${key.text}`);
  // Two plain words: the earliest anchors, as before M3.
  const plain = F.windowContent(`alpha ${filler(60, 'v')} beta end`, 'beta alpha', 120, 'window');
  assert.ok(plain.text.startsWith('alpha') || plain.text.startsWith('…alpha'), `the earliest of two words anchors: ${plain.text}`);
  assert.ok(!plain.text.includes('beta'), plain.text);
  // 'auto' still keeps the whole content when it fits and the head when the anchor sits in it.
  assert.deepEqual(F.windowContent('short f00dcafe text', 'f00dcafe', 100), { text: 'short f00dcafe text', clipped: false });
});

test('M3 S2 end to end: a prior hit at rank 3 of 5 shows the sha the query names next to a head word (MUTANT: the head word wins the window)', () => {
  const hits = [0, 1, 2, 3, 4].map((i) => hit(10 + i, `fact · k.tip.${i} · 2026-10-03\nrelease ${filler(45, `v${i}`)}${i === 2 ? ` tip ${SHA} cut` : ''} ${filler(10, `w${i}`)}`, meta(`c-00000000000${i}`, `k.tip.${i}`, 'fact', 'superseded')));
  const out = F.formatSearch(`release ${SHA.slice(0, 8)}`, {}, hits);
  // The sha names hit 3, so it is lifted to [1]; its window holds the sha.
  const b = block(out, 1);
  assert.match(b.meta, /k\.tip\.2/, 'the hit the sha names is first');
  assert.ok(b.body.join(' ').includes('f00dcafe'), `MUTANT: sha shown, got ${b.body.join(' ')}`);
  // The same shape with no lift (query names nothing specific: the sha cut to 6 hex) keeps rank 3 and still windows on the sha? No: a 6-hex
  // run is a word, so the earliest term wins; that is the pre-M3 rule and is pinned above. Here the order is pinned.
  assert.deepEqual(metas(F.formatSearch('release', {}, hits)).map((m) => m.split(' · ')[2]), ['k.tip.0', 'k.tip.1', 'k.tip.2', 'k.tip.3', 'k.tip.4']);
});

test('M3 lift: the whole key, a card id segment, the claim id, a sha or a version in the content lift a hit inside its group (MUTANT: store order)', () => {
  const hits = [
    hit(1, 'fact · release.tip · 2026-10-03\nthe tip is 1111aaaa and that is all', meta('c-0000000000a1', 'release.tip')),
    hit(2, 'fact · card.claims-90 · 2026-10-03\nthe card note says the probe runs', meta('c-0000000000a2', 'card.claims-90')),
    hit(3, 'fact · release.current · 2026-10-03\nthe current build is 1.1.102 since noon', meta('c-0000000000a3', 'release.current')),
    hit(4, `fact · - · 2026-10-03\nunkeyed note with the sha ${SHA} in it`, meta('c-0000000000a4', null)),
    hit(5, 'fact · other.key · 2026-10-03\nnothing named here at all', meta('c-0000000000a5', 'other.key'))
  ];
  const keys = (q) => F.rankHits(q, hits).map((h) => h.claim.id.slice(-2));
  assert.deepEqual(keys('release.tip value'), ['a1', 'a2', 'a3', 'a4', 'a5'], 'already first');
  assert.deepEqual(keys('CLAIMS-90 status'), ['a2', 'a1', 'a3', 'a4', 'a5'], 'MUTANT: a card id names card.<id>');
  assert.deepEqual(keys('what is release.current'), ['a3', 'a1', 'a2', 'a4', 'a5'], 'the whole dotted key');
  assert.deepEqual(keys('c-0000000000a5'), ['a5', 'a1', 'a2', 'a3', 'a4'], 'the claim id');
  assert.deepEqual(keys(`where is ${SHA.slice(0, 10)}`), ['a4', 'a1', 'a2', 'a3', 'a5'], 'MUTANT: a sha in the content');
  assert.deepEqual(keys('build 1.1.102'), ['a3', 'a1', 'a2', 'a4', 'a5'], 'MUTANT: a version in the content');
  assert.deepEqual(keys('other.key c-0000000000a4'), ['a4', 'a5', 'a1', 'a2', 'a3'], 'two named hits keep their order among themselves');
  // The compact view prints that order: the named hit is [1].
  assert.match(block(F.formatSearch('CLAIMS-90 status', {}, hits), 1).meta, /card\.claims-90/);
});

test('M3 lift limits: a plain word never lifts (even a key segment), a prior never crosses above the live value of its key, markdown stays behind current claims (MUTANT: segment words lift)', () => {
  const hits = [
    hit(1, 'fact · other.key · 2026-10-03\nnothing named here at all', meta('c-0000000000a1', 'other.key')),
    hit(2, 'fact · release.tip · 2026-10-01\nthe old tip was 0000dead', meta('c-0000000000a2', 'release.tip', 'fact', 'superseded')),
    md(3, '## CLAIMS-90 notes\nthe card note in markdown names claims-90 too'),
    hit(4, 'fact · release.tip · 2026-10-03\nthe tip is 1111aaaa now', meta('c-0000000000a4', 'release.tip')),
    hit(5, 'fact · release.tip · 2026-10-02\nthe tip may be 2222bbbb', meta('c-0000000000a5', 'release.tip', 'fact', 'superseded?'))
  ];
  const ids = (q) => F.rankHits(q, hits).map((h) => h.chunkId);
  assert.deepEqual(ids('tip release'), [1, 4, 3, 2, 5], 'MUTANT: plain words (even key segments) keep the currentFirst order');
  assert.deepEqual(ids('tip release'), F.currentFirst(hits).map((h) => h.chunkId));
  assert.deepEqual(ids('release.tip now'), [4, 1, 3, 2, 5], 'MUTANT: the live value first; the prior and prior? stay in the prior group, named ones first there');
  assert.deepEqual(ids('CLAIMS-90'), [1, 4, 3, 2, 5], 'a card id in markdown lifts inside the markdown group only (it is alone there)');
  const mixed = [...hits, md(6, '## plain\nno names here')];
  assert.deepEqual(F.rankHits('CLAIMS-90', [mixed[5], ...mixed.slice(0, 5)]).map((h) => h.chunkId), [1, 4, 3, 6, 2, 5], 'MUTANT: the named markdown hit moves ahead of the other markdown hit, not ahead of a claim');
  // The compact view: the live release.tip is [1], the prior of the same key is never above it.
  const ms = metas(F.formatSearch('release.tip now', {}, hits));
  assert.match(ms[0], /^current · fact · release\.tip/);
  assert.ok(ms.findIndex((m) => m.startsWith('prior · fact · release.tip')) > 0);
});

test('M3: --full keeps the store order (the lift is the compact view only)', () => {
  const hits = [
    hit(1, 'fact · other.key · 2026-10-03\nnothing named', meta('c-0000000000a1', 'other.key')),
    hit(2, 'fact · release.tip · 2026-10-03\nthe tip is 1111aaaa', meta('c-0000000000a2', 'release.tip'))
  ];
  const full = F.formatSearch('release.tip', { full: true }, hits);
  assert.ok(full.indexOf('c-0000000000a1') < full.indexOf('c-0000000000a2'));
  assert.match(block(F.formatSearch('release.tip', {}, hits), 1).meta, /release\.tip/);
});
