'use strict';
/**
 * CLAIM-LEDGER W3, the parts that need no SQLite: claim chunks (chunksFor), main's verified index
 * sync (ClaimsIndexSync), discovery (the claims source, the three replaced patterns, levels),
 * search validation and the CLI flags, and the claim line in search output.
 * HOME and USERPROFILE are jailed and asserted before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-w3-unit-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const ROOT = path.join(__dirname, '..');
const { chunksFor, withParts, claimHeader, CLAIM_CHUNK_CHARS } = loadTs(path.join(ROOT, 'src/main/claims/chunks.ts'));
const { ClaimsIndexSync, verifiedPrefix } = loadTs(path.join(ROOT, 'src/main/claims/indexSync.ts'));
const { discoverSources, ledgerReplaced, ALLOW_LIST_VERSION } = loadTs(path.join(ROOT, 'src/main/nativeMemory/sources.ts'));
const { validateRequest } = loadTs(path.join(ROOT, 'src/main/nativeMemory/service.ts'));
const { formatSearch } = loadTs(path.join(ROOT, 'src/main/nativeMemory/format.ts'));
const { dbFileFor } = loadTs(path.join(ROOT, 'src/main/nativeMemory/mainWiring.ts'));
const cli = require(path.join(ROOT, 'resources/memory-cli.cjs'));

const rec = (id, text, extra = {}) => ({ v: 1, id, t: 'claim', kind: 'fact', text, source: 'self', at: '2026-10-03T10:00:00.000Z', wt: '2026-10-03T10:00:00.000Z', agent: 'a1', prev: '', mac: `m-${id}`, ...extra });
const state = (ids, status = 'live') => ({ v: 1, agent: 'a1', registryHash: '', ledgerHead: 'head', conflicts: [], claims: Object.fromEntries(ids.map((id) => [id, { id, status: typeof status === 'function' ? status(id) : status, sightings: 0, firstAt: '', lastAt: '', pinned: false, reasons: [] }])) });

test('chunksFor: one claim one chunk with the kind · key · date header; events are not chunks; no state, no chunk', () => {
  const records = [
    rec('c-000000000001', 'the relay uses port 4471', { kind: 'decision', key: 'release.current' }),
    { v: 1, id: 'e-000000000001', t: 'event', ev: 'pin', targets: ['c-000000000001'], by: 'self', at: '2026-10-03T10:00:00.000Z', wt: '2026-10-03T10:00:00.000Z', agent: 'a1', prev: '', mac: '' },
    rec('c-000000000002', 'not derived yet'),
  ];
  const out = chunksFor(records, state(['c-000000000001']));
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'decision · release.current · 2026-10-03\nthe relay uses port 4471');
  assert.deepEqual({ ...out[0], contentSha256: undefined }, { claimId: 'c-000000000001', wing: 'a1', kind: 'decision', ckey: 'release.current', at: '2026-10-03T10:00:00.000Z', status: 'live', content: out[0].content, contentSha256: undefined });
  assert.match(out[0].contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(claimHeader({ kind: 'fact', at: '2026-01-02T00:00:00.000Z' }), 'fact · - · 2026-01-02');
});

test('chunksFor: a long legacy claim becomes several parts with the same claimId, each with the header; statuses carried', () => {
  const long = Array.from({ length: 60 }, (_, i) => `- bullet line ${i} about the widget relay and the crate`).join('\n');
  assert.ok(long.length > 2 * CLAIM_CHUNK_CHARS);
  const out = withParts(chunksFor([rec('c-000000000003', long, { source: 'legacy' })], state(['c-000000000003'], 'superseded')));
  assert.ok(out.length >= 3);
  assert.deepEqual(out.map((c) => c.part), out.map((_, i) => i));
  for (const c of out) {
    assert.equal(c.claimId, 'c-000000000003'); assert.equal(c.status, 'superseded');
    assert.ok(c.content.startsWith('fact · - · 2026-10-03\n'));
    assert.ok(c.content.length <= CLAIM_CHUNK_CHARS + 40, `part of ${c.content.length} characters`);
  }
  const text = out.map((c) => c.content.slice(c.content.indexOf('\n') + 1)).join('\n');
  for (let i = 0; i < 60; i++) assert.ok(text.includes(`bullet line ${i} about`), `line ${i} kept`);
});

test('verifiedPrefix: all on ok; before the break on mac/prev/parse; nothing on a lost key', () => {
  const records = [rec('c-000000000001', 'a'), rec('c-000000000002', 'b'), rec('c-000000000003', 'forged')];
  assert.equal(verifiedPrefix({ records, torn: null, chain: 'ok' }).records.length, 3);
  assert.deepEqual(verifiedPrefix({ records, torn: null, chain: { brokenAt: 'c-000000000003', reason: 'mac' } }).records.map((r) => r.id), ['c-000000000001', 'c-000000000002']);
  assert.deepEqual(verifiedPrefix({ records, torn: null, chain: { brokenAt: '7@123', reason: 'parse' } }).records, []);
  assert.equal(verifiedPrefix({ records, torn: null, chain: { brokenAt: 'c-000000000001', reason: 'key-missing' } }), null);
});

function syncer(over = {}) {
  const sent = []; const logs = []; const timers = [];
  const d = {
    readLedger: () => ({ records: [rec('c-000000000001', 'a'), rec('c-000000000002', 'b')], torn: null, chain: 'ok' }),
    derive: () => (records) => state(records.filter((r) => r.t === 'claim').map((r) => r.id)),
    registry: () => ({ v: 1, namespaces: [], keys: {} }),
    ruleConfig: () => ({ r4: false }),
    level: () => 'reader',
    agents: () => ['a1', 'a2'],
    send: async (args) => { sent.push(args); return { ok: true }; },
    log: (r) => logs.push(r),
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: (t) => { timers[t - 1] = null; },
    ...over,
  };
  return { s: new ClaimsIndexSync(d), sent, logs, timers };
}

test('ClaimsIndexSync: sends verified chunks for reader/writer only; logs once without derive; skips a lost key; truncates at a break', async () => {
  let x = syncer();
  let r = await x.s.syncNow('a1');
  assert.equal(r.sent, true); assert.equal(x.sent.length, 1);
  assert.deepEqual({ wing: x.sent[0].wing, path: x.sent[0].path, head: x.sent[0].head }, { wing: 'a1', path: 'agents/a1/memory/claims', head: 'head' });
  assert.deepEqual(x.sent[0].chunks.map((c) => [c.claimId, c.part]), [['c-000000000001', 0], ['c-000000000002', 0]]);
  for (const level of ['off', 'shadow']) {
    x = syncer({ level: () => level });
    assert.deepEqual(await x.s.syncNow('a1'), { sent: false, why: 'level' }); assert.equal(x.sent.length, 0);
  }
  x = syncer({ derive: () => null });
  assert.deepEqual(await x.s.syncNow('a1'), { sent: false, why: 'no-derive' });
  await x.s.syncNow('a2');
  assert.equal(x.logs.filter((l) => l.kind === 'claims-index-no-derive').length, 1, 'logged once');
  x = syncer({ readLedger: () => ({ records: [rec('c-000000000001', 'a')], torn: null, chain: { brokenAt: 'c-000000000001', reason: 'key-missing' } }) });
  assert.deepEqual(await x.s.syncNow('a1'), { sent: false, why: 'key-missing' }); assert.equal(x.sent.length, 0, 'the index keeps what was verified');
  x = syncer({ readLedger: () => ({ records: [rec('c-000000000001', 'a'), rec('c-00000000000f', 'forged', { source: 'human' })], torn: null, chain: { brokenAt: 'c-00000000000f', reason: 'mac' } }) });
  r = await x.s.syncNow('a1');
  assert.equal(r.truncatedAt, 'c-00000000000f');
  assert.deepEqual(x.sent[0].chunks.map((c) => c.claimId), ['c-000000000001'], 'a forged line never reaches the index');
});

test('ClaimsIndexSync: a burst of appends is one debounced sync; syncAll covers every agent', async () => {
  const x = syncer();
  x.s.schedule('a1'); x.s.schedule('a1'); x.s.schedule('a1');
  const live = x.timers.filter(Boolean);
  assert.equal(live.length, 1);
  live[0]();
  await new Promise((r) => setImmediate(r));
  assert.equal(x.sent.length, 1);
  const all = await x.s.syncAll();
  assert.equal(all.length, 2);
  assert.deepEqual(x.sent.slice(1).map((s) => s.wing).sort(), ['a1', 'a2']);
});

function hiveWith(files) {
  const root = fs.mkdtempSync(path.join(JAIL, 'hive-'));
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (text !== null) fs.writeFileSync(p, text);
  }
  return root;
}

test('discovery: at reader/writer the claims source comes in and the three patterns go out; shadow and off change nothing', () => {
  assert.equal(ALLOW_LIST_VERSION, 2);
  for (const n of ['memory.md', 'MEMORY.md', 'memory-archive-2026-09-01.md', 'memory-ledger-export-2026-10.md', 'memory-ledger-export-2026-10-2.md']) assert.equal(ledgerReplaced(n), true, n);
  for (const n of ['notes.md', 'memory-notes.md', 'my-memory.md']) assert.equal(ledgerReplaced(n), false, n);
  const root = hiveWith({
    'agents/a1/memory.md': '# m', 'agents/a1/memory-archive-1.md': '# a', 'agents/a1/memory-ledger-export-2026-10.md': '- e', 'agents/a1/notes.md': '# n',
    'agents/a1/memory/claims/2026-10.jsonl': '{}\n', 'agents/a2/memory.md': '# m2',
  });
  const paths = (d) => d.eligible.map((e) => `${e.kind}:${e.path}`).sort();
  const at = (a1, global = undefined) => {
    fs.writeFileSync(path.join(root, 'memory-sources.json'), JSON.stringify({ ledger: { a1 } }));
    return discoverSources(root, undefined, { claimLedger: global, implemented: 'writer' });
  };
  for (const level of ['off', 'shadow']) {
    const d = at(level, 'writer');
    assert.ok(!paths(d).some((p) => p.startsWith('claims:')), level);
    assert.ok(paths(d).includes('memory:agents/a1/memory.md'), level);
  }
  for (const level of ['reader', 'writer']) {
    const d = at(level, 'writer');
    assert.deepEqual(paths(d).filter((p) => p.includes('/a1/')), ['claims:agents/a1/memory/claims', 'deliverable:agents/a1/notes.md'], level);
    assert.ok(paths(d).includes('memory:agents/a2/memory.md'), 'a2 is at writer too (the global) but has no ledger yet: it keeps memory.md');
    assert.equal(d.ledgerLevels.a2, 'writer');
    assert.equal(d.ledgerLevels.a1, level);
    for (const r of ['agents/a1/memory.md', 'agents/a1/memory-archive-1.md', 'agents/a1/memory-ledger-export-2026-10.md']) assert.ok(d.excludedMd.includes(r), `${r} reported as excluded`);
  }
  // The setting caps the manifest; this build caps both (the clamp).
  assert.equal(at('writer', 'shadow').ledgerLevels.a1, 'shadow');
  assert.equal(discoverSources(root, undefined, { claimLedger: 'writer', implemented: 'shadow' }).eligible.some((e) => e.kind === 'claims'), false);
  assert.equal(discoverSources(root).eligible.some((e) => e.kind === 'claims'), false, 'this build ships off: nothing changes by default');
});

test('search validation and the CLI: --history / --all / --kind / --key; never both modes', () => {
  const v = (args) => validateRequest({ cmd: 'search', args: { query: 'q', ...args } }, 'a1');
  assert.equal(v({}).args.mode, 'live');
  assert.equal(v({ history: true }).args.mode, 'history');
  assert.equal(v({ all: true }).args.mode, 'all');
  assert.equal(v({ history: true, all: true }).exit, 2);
  assert.equal(v({ kind: 'lesson' }).args.kind, 'lesson');
  assert.equal(v({ kind: 'nonsense' }).exit, 2);
  assert.equal(v({ key: 'release.current' }).args.key, 'release.current');
  assert.equal(v({ key: 'Bad Key' }).exit, 2);
  assert.deepEqual(cli.parseArgs(['search', '--history', '--kind', 'lesson', '--key', 'release.current', 'fetch', 'first']).args, { history: true, kind: 'lesson', key: 'release.current', query: 'fetch first' });
  assert.deepEqual(cli.parseArgs(['search', '--all', 'x']).args, { all: true, query: 'x' });
});

test('search output: a claim hit shows [status · kind · key · date · id]; the v2 index file name', () => {
  const text = formatSearch('q', {}, [{ chunkId: 1, wing: 'a1', room: 'claims', source: 'agents/a1/memory/claims', content: 'fact · - · 2026-10-03\nhello', cosineSim: 0.9, bm25: 1, score: 1,
    claim: { id: 'c-000000000001', status: 'superseded', kind: 'fact', key: 'release.current', at: '2026-10-03T10:00:00.000Z' } }]);
  assert.match(text, /Claim:  \[superseded · fact · release\.current · 2026-10-03 · c-000000000001\]/);
  assert.match(dbFileFor('U', 'C:/Dunder/hive'), /-v2\.sqlite$/);
});

test('discovery: an empty claims folder (no segment) is not a ledger; the agent keeps its markdown', () => {
  const root = hiveWith({ 'agents/a1/memory.md': '# m', 'agents/a1/memory/claims/readme.txt': 'x' });
  fs.writeFileSync(path.join(root, 'memory-sources.json'), JSON.stringify({ ledger: { a1: 'reader' } }));
  const d = discoverSources(root, undefined, { claimLedger: 'writer', implemented: 'writer' });
  assert.deepEqual(d.eligible.map((e) => e.path), ['agents/a1/memory.md']);
});
