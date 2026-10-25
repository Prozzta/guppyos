'use strict';
/**
 * CLAIMS-90 HISTORY-PTR: a claim's history pointer is a runnable `memory history <id>` command
 * answered from the served hive, never a file anchor (an answerer read `memory.md#claim-history-<id>`
 * and went to the live hive's memory.md for it). Invented fixtures only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');
const V = loadTs('src/main/claims/views.ts');
const P = loadTs('src/main/claims/historyPointer.ts');
const { handleClaimVerb, CLAIM_VERBS } = loadTs('src/main/claims/endpoint.ts');
const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
const CLI = require('../resources/memory-cli.cjs');

const REPO = path.resolve(__dirname, '..');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'claims90-hptr-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const claim = (id, text, extra = {}) => ({ v: 1, id, at: '2026-01-01', wt: '2026-01-01', agent: 'a', prev: '', mac: id,
  t: 'claim', kind: 'fact', text, source: 'self', ...extra });
const stateFor = (records) => ({ v: 1, agent: 'a', registryHash: '', ledgerHead: '', conflicts: [], claims: Object.fromEntries(
  records.filter(r => r.t === 'claim').map(r => [r.id, { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: r.pin === true, reasons: [] }])) });
const world = () => ({ flags: {}, counters: {} });
/** A path-like token: a slash or backslash (any drive or folder path), or the memory.md file or its anchor. */
const PATHISH = /[\\/]|\.md\b|#claim-history/;

function fixture() {
  const old = claim('c-old000000001', 'invented value one', { key: 'invented-key', at: '2026-01-01', wt: '2026-01-01' });
  const cur = claim('c-cur000000001', 'invented value two', { key: 'invented-key', at: '2026-02-01', wt: '2026-02-01', supersedes: ['c-old000000001'] });
  const solo = claim('c-solo00000001', 'invented lone value', { key: 'lone-key' });
  const records = [old, cur, solo];
  const state = stateFor(records); state.claims['c-old000000001'].status = 'superseded';
  return { records, state };
}
const pointersIn = (text) => text.split('\n').filter(l => /history:/.test(l)).map(l => /history: (memory history \S+?)\]?$/.exec(l)?.[1] ?? l);

test('HISTORY-PTR: the working set and memory.md point with `memory history <id>` and never name a file', () => {
  const { records, state } = fixture();
  const views = V.createClaimViews(records, s => s.length);
  const working = views.buildWorkingSet(state, world(), 5000).text;
  const full = views.renderMemoryMd(state, world(), 'complete');
  const inline = working.split('\n').find(l => l.includes('[c:c-cur000000001]'));
  assert.match(inline, /\[history: memory history c-cur000000001\]$/);
  // The standalone pointer (current budgeted out) is the same command.
  const tight = V.createClaimViews(records, s => (s.includes('[c:') ? 200 : 1)).buildWorkingSet(state, world(), 50).text;
  assert.match(tight, /^- invented-key history: memory history c-cur000000001$/m);
  for (const text of [working, tight, full]) {
    for (const line of text.split('\n').filter(l => /history:/.test(l))) {
      assert.doesNotMatch(line.replace(/\[c:[^\]]+\]/g, ''), PATHISH, `a pointer names no path: ${line}`);
    }
  }
  assert.equal(P.historyPointer('c-x'), 'memory history c-x', 'one function spells the pointer');
});

test('HISTORY-PTR: an older `memory.md#claim-history-<id>` anchor is rewritten to the command; other text is untouched', () => {
  assert.equal(P.withHistoryCommands('- k [status:current] [c:c-a1] [history: memory.md#claim-history-c-a1]'), '- k [status:current] [c:c-a1] [history: memory history c-a1]');
  assert.equal(P.withHistoryCommands('- k history: memory.md#claim-history-c-a1\n- j history: memory.md#claim-history-c-b2.'), '- k history: memory history c-a1\n- j history: memory history c-b2.');
  assert.equal(P.withHistoryCommands('see memory.md for the log'), 'see memory.md for the log');
});

test('HISTORY-PTR: renderClaimHistory answers every id of a group with memory.md\'s dated lines; an unknown or purged id is null', () => {
  const { records, state } = fixture();
  const want = '### Claim history: invented-key\n- PRIOR — 2026-01-01 — invented value one [status:superseded] [c:c-old000000001]\n- CURRENT — 2026-02-01 — invented value two [status:live] [c:c-cur000000001]\n';
  assert.equal(V.renderClaimHistory(records, state, 'c-cur000000001'), want);
  assert.equal(V.renderClaimHistory(records, state, 'c-old000000001'), want, 'a prior id resolves to its group');
  const full = V.createClaimViews(records, s => s.length).renderMemoryMd(state, world(), 'complete');
  assert.ok(full.includes(want.split('\n').slice(1).join('\n')), 'the same lines as memory.md\'s section');
  assert.equal(V.renderClaimHistory(records, state, 'c-solo00000001'), '### Claim history: lone-key\n- CURRENT — 2026-01-01 — invented lone value [status:live] [c:c-solo00000001]\n');
  assert.equal(V.renderClaimHistory(records, state, 'c-none'), null);
  const purged = stateFor(records); purged.claims['c-solo00000001'].status = 'purged';
  assert.equal(V.renderClaimHistory(records, purged, 'c-solo00000001'), null);
});

test('HISTORY-PTR endpoint: `history` is a read at every level; it takes one claim id and nothing else', async () => {
  assert.ok(CLAIM_VERBS.has('history'));
  const seen = [];
  const deps = (level, wired = true) => ({ store: {}, level: () => level,
    ...(wired ? { claimHistory: (agentId, id) => { seen.push([agentId, id]); return id === 'c-k' ? { ok: true, text: 'H\n', owner: 'b' } : { ok: false, error: `no claim ${id}` }; } } : {}) });
  for (const level of ['off', 'shadow', 'reader', 'writer']) {
    const r = await handleClaimVerb(deps(level), 'a', { cmd: 'history', args: { id: 'c-k' } }, 'endpoint');
    assert.deepEqual(r, { ok: true, exit: 0, text: 'H\n', json: { id: 'c-k', owner: 'b' } }, level);
  }
  assert.deepEqual(seen[0], ['a', 'c-k'], 'the caller is the token\'s agent');
  assert.equal((await handleClaimVerb(deps('writer'), 'a', { cmd: 'history', args: { id: 'c-z' } }, 'endpoint')).error, 'no claim c-z');
  assert.equal((await handleClaimVerb(deps('writer'), 'a', { cmd: 'history', args: {} }, 'endpoint')).exit, 2);
  assert.equal((await handleClaimVerb(deps('writer'), 'a', { cmd: 'history', args: { id: '../memory.md' } }, 'endpoint')).exit, 2, 'an id is never a path');
  assert.equal((await handleClaimVerb(deps('writer'), 'a', { cmd: 'history', args: { id: 'c-k', key: 'x' } }, 'endpoint')).exit, 2);
  assert.equal((await handleClaimVerb(deps('writer'), 'a', { cmd: 'history', args: { id: 'c-k', agent: 'b' } }, 'endpoint')).exit, 2, 'no agent field');
  assert.equal((await handleClaimVerb(deps('writer', false), 'a', { cmd: 'history', args: { id: 'c-k' } }, 'endpoint')).exit, 3);
});

test('HISTORY-PTR CLI: the pointer a working set shows, run as typed, prints that claim\'s history from the served ledger', async () => {
  const { records, state } = fixture();
  const working = V.createClaimViews(records, s => (s.includes('[c:') ? 200 : 1)).buildWorkingSet(state, world(), 50).text;
  const pointer = /history: (memory history \S+)$/m.exec(working)[1];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const c = await handleClaimVerb({ store: {}, level: () => 'reader', claimHistory: (_a, id) => {
        const text = V.renderClaimHistory(records, state, id);
        return text ? { ok: true, text, owner: 'a' } : { ok: false, error: `no claim ${id}` };
      } }, 'a', JSON.parse(Buffer.concat(chunks).toString('utf8')), 'endpoint');
      res.end(JSON.stringify({ exit: c.exit, text: c.text, json: c.json, error: c.error }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const out = []; const err = [];
    const argv = pointer.split(' ').slice(1);
    const code = await CLI.main(argv, { MUNDER_MEMORY_URL: `http://127.0.0.1:${server.address().port}/memory`, MEMORY_TOKEN: 't' }, { out: s => out.push(s), err: s => err.push(s) });
    assert.equal(code, 0, err.join(''));
    assert.equal(out.join(''), V.renderClaimHistory(records, state, 'c-cur000000001'));
    assert.match(out.join(''), /PRIOR — 2026-01-01 — invented value one/);
    assert.doesNotMatch(out.join('').replace(/\[c:[^\]]+\]/g, ''), PATHISH, 'the answer names no path');
    assert.equal(await CLI.main(['history', 'c-a', 'c-b'], {}, { out() {}, err() {} }), 2, 'one id only');
  } finally { server.close(); }
  assert.match(fs.readFileSync(path.join(REPO, 'resources', 'memory-cli.cjs'), 'utf8'), /memory history ID/, 'USAGE names the verb');
});

test('HISTORY-PTR engine: search hits, wake-up entries and the pinned section serve old anchors as the command', async () => {
  const root = fs.mkdtempSync(path.join(JAIL, 'e-'));
  fs.mkdirSync(path.join(root, 'agents', 'ph'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'ph', 'memory.md'), '# Ph\n\n## How I work (standing lessons)\n- invented habit [history: memory.md#claim-history-c-l1]\n\n## Log\n- entry\n');
  const OLD = '- invented-key history: memory.md#claim-history-c-cur000000001';
  const hit = { chunkId: 1, wing: 'ph', room: 'memory', source: 'agents/ph/memory.md', content: `## Working set\n${OLD}`, cosineSim: 0.9, bm25: 1 };
  const store = { setMeta() {}, sourceShas: () => new Map(), removeSource() {}, planDiff: () => ({ keep: [], add: [], remove: [] }), applyDiff: () => true,
    wakeUp: () => [{ wing: 'ph', room: 'memory', source: 'agents/ph/memory.md', content: OLD }], search: () => [hit] };
  const eng = new MemoryEngine({ hiveRoot: root, store, embedder: { loaded: true, embed: async (x) => x.map(() => new Float32Array(384)), unload: async () => {} },
    countTokens: (x) => x.split(/\s+/).length, mode: () => 'native', watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : { ms }), clearTimer: () => {} });
  for (const full of [false, true]) {
    const s = (await eng.search({ query: 'invented', full })).text;
    assert.match(s, /memory history c-cur000000001/, `search full=${full}`);
    assert.doesNotMatch(s, /#claim-history/);
    const w = (await eng.wakeUp('ph', full)).text;
    assert.match(w, /memory history c-cur000000001/, `wake-up full=${full}`);
    assert.doesNotMatch(w, /#claim-history/);
  }
  assert.match((await eng.wakeUp('ph', true)).text, /\[history: memory history c-l1\]/, 'the pinned section too');
  assert.equal(hit.content.includes('memory.md#claim-history'), true, 'the stored chunk itself is not changed');
});
