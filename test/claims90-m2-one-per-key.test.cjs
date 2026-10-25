'use strict';
/**
 * CLAIMS-90 M2 (rework after Jim's audit): one row per CLAIM in the live search view, its best-ranked
 * matched part, with the count of the superseded claims behind it along its own supersession chain.
 * The pure collapse (store.ts onePerClaim) over fake rows, the output line (format.ts), the redacted
 * JSON field (engine.ts redactHit) and the supersession link on claim chunks (chunks.ts chunksFor).
 * No SQLite: the DB-backed walk, the chain count and the schema upgrade are exercised by the Electron
 * scenario `m2keys` (claims90-m2-keys.test.cjs).
 * HOME and USERPROFILE are jailed before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-c90m2-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const ROOT = path.join(__dirname, '..');
const { onePerClaim } = loadTs(path.join(ROOT, 'src/main/nativeMemory/store.ts'));
const { formatSearch } = loadTs(path.join(ROOT, 'src/main/nativeMemory/format.ts'));
const { redactHit } = loadTs(path.join(ROOT, 'src/main/nativeMemory/engine.ts'));
const { chunksFor } = loadTs(path.join(ROOT, 'src/main/claims/chunks.ts'));

/** A search row as store.search reads it (claim rows carry claim_id and a part; markdown rows neither). */
const claimRow = (id, part = 0) => ({ chunk_id: Number(`${id.slice(-1)}${part}`), wing: 'a1', claim_id: `c-${id}`, claim_part: part, content: `${id} part ${part}` });
const mdRow = (n) => ({ chunk_id: 900 + n, wing: 'a1', claim_id: null, claim_part: null, content: `md ${n}` });
const cands = (...rows) => rows.map((r, i) => ({ f: { id: r.chunk_id, score: 1 / (i + 1) }, r }));
const ids = (out) => out.map((o) => o.r.claim_id ?? `md${o.r.chunk_id - 900}`);

test('M2: a claim retrieved by several parts is one row, its best-ranked MATCHED part (never swapped for part 0)', () => {
  const out = onePerClaim(cands(claimRow('long', 2), claimRow('other'), claimRow('long', 0), claimRow('long', 1)), 10, () => 0);
  assert.deepEqual(ids(out), ['c-long', 'c-other'], 'MUTANT: the later parts of the same claim are skipped');
  assert.equal(out[0].r.claim_part, 2, 'MUTANT: the part that matched best is the row, not part 0');
  assert.equal(out[0].r.content, 'long part 2');
});

test('M2: same-key claims are separate rows (no key collapse: Jim\'s audit), and markdown rows pass through', () => {
  const a = { ...claimRow('k6'), ckey: 'release.legacy' };
  const b = { ...claimRow('k7'), ckey: 'release.legacy' };
  const out = onePerClaim(cands(a, mdRow(1), b, mdRow(2)), 10, () => 0);
  assert.deepEqual(ids(out), ['c-k6', 'md1', 'c-k7', 'md2'], 'MUTANT: two live claims under one key both stay; markdown rows are kept in rank order');
});

test('M2: the collapse stops at k rows, counted after collapsing', () => {
  const out = onePerClaim(cands(claimRow('a', 0), claimRow('a', 1), claimRow('b'), claimRow('c'), claimRow('d')), 3, () => 0);
  assert.deepEqual(ids(out), ['c-a', 'c-b', 'c-c'], 'MUTANT: k counts rows shown, not candidates walked');
});

test('M2: priors come from the injected chain lookup, per row; markdown rows carry 0', () => {
  const out = onePerClaim(cands(claimRow('k3'), mdRow(1), claimRow('o1')), 10, (r) => (r.claim_id === 'c-k3' ? 2 : 0));
  assert.deepEqual(out.map((o) => o.priors), [2, 0, 0], 'MUTANT: the chain count is asked for every claim row');
});

test('M2: the live text says how many prior versions the claim supersedes; nothing when there are none', () => {
  const hit = (priors) => ({ chunkId: 1, wing: 'a1', room: 'memory', source: 'claim', content: 'decision · release.current · 2026-10-03\nthe release current is 1.1.100', cosineSim: 0.5, bm25: 1, score: 1,
    claim: { id: 'c-k3', status: 'live', kind: 'decision', key: 'release.current', at: '2026-10-03T10:00:00.000Z' }, ...(priors === undefined ? {} : { priors }) });
  const text = formatSearch('release current', { full: true }, [hit(2)]);
  assert.match(text, /Versions: 2 prior version\(s\) this claim supersedes; --history shows them\./, 'MUTANT: the priors line');
  assert.doesNotMatch(text, /Found via/, 'the key-collapse line of 4cd2fa3f is gone');
  assert.doesNotMatch(formatSearch('release current', { full: true }, [hit(0)]), /Versions:/, 'no line for a claim with no priors');
  assert.doesNotMatch(formatSearch('release current', { full: true }, [hit(undefined)]), /Versions:/, 'no line outside the live view');
});

test('M2: redactHit carries priors (a count, no content) only when the hit has it', () => {
  const base = { chunkId: 1, wing: 'a1', room: 'memory', source: 'claim', content: 'secret', cosineSim: 0.5, bm25: 1, score: 1, claim: { id: 'c-k3', status: 'live', kind: 'fact', key: 'k', at: '' } };
  const r = redactHit({ ...base, priors: 2 });
  assert.equal(r.priors, 2, 'MUTANT: priors is in the redacted JSON');
  assert.equal(r.content, undefined, 'never content');
  assert.equal('priors' in redactHit(base), false, 'absent when the hit has none (history / all mode)');
});

test('M2: chunksFor carries the supersession link of the claim state onto every part', () => {
  const rec = (id, text, extra = {}) => ({ v: 1, id, t: 'claim', kind: 'fact', text, source: 'legacy', at: '2026-10-03T10:00:00.000Z', wt: '2026-10-03T10:00:00.000Z', agent: 'a1', prev: '', mac: '', ...extra });
  const st = (id, status, supersededBy) => ({ id, status, ...(supersededBy ? { supersededBy } : {}), sightings: 0, firstAt: '', lastAt: '', pinned: false, reasons: [] });
  const long = Array.from({ length: 140 }, (_, i) => `pelican lighthouse ${i}`).join(' ');
  const out = chunksFor([rec('c-old', 'the value was 7'), rec('c-new', long, { key: 'k' })],
    { v: 1, agent: 'a1', registryHash: '', ledgerHead: '', conflicts: [], claims: { 'c-old': st('c-old', 'superseded', 'c-new'), 'c-new': st('c-new', 'live') } });
  assert.equal(out.find((c) => c.claimId === 'c-old').supersededBy, 'c-new', 'MUTANT: the link is on the chunk');
  const parts = out.filter((c) => c.claimId === 'c-new');
  assert.ok(parts.length >= 2, `the long claim has ${parts.length} parts`);
  assert.ok(parts.every((c) => c.supersededBy === null), 'a live claim carries null on every part');
});
