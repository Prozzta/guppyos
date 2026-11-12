'use strict';
require('./tools/own-job.cjs');

/**
 * STARTUP-FREEZE-104 A12 (Jim's 10x profile of c1db867a, 3e0c72): runDerivedBackfill was one 6.1-9.3 s block at
 * ~56 s: the mail index read synchronously (readIndexDoneMails 1.4 s, readFileSync 1.7 s) and the derived ledger
 * derived once per syncDerived (full 2.5 s + syncDerived 1.8 s). Now:
 *  - the index readers have async twins (fs/promises, a tick per file and per row) that return exactly what the
 *    sync ones return, with the same seen/subjects side effects (done, ruling, proven);
 *  - deriveOnce reuses the last state only for the same derive, the same records array and the same FROZEN
 *    registry (a registry that can still change, a new array, another registry or derive: a fresh derive);
 *  - each step of the backfill is its own event-loop turn, and with deriveOnce an idempotent rerun derives once,
 *    with the same counts as a plain derive.
 * Temp hives in a jailed HOME only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sf104-a12-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');
const W = loadTs('src/main/claims/derivedWriter.ts');
const { mailBodyHash } = loadTs('src/main/mailLedger.ts');
const { DERIVED_AGENT_ID } = loadTs('src/shared/claims.ts');

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const FROZEN = deepFreeze(structuredClone(DEFAULT_KEY_REGISTRY));

let n = 0;
function hiveDir() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return root;
}
function setup(deriveFor) {
  const root = hiveDir();
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), log: () => {}, alert: () => {} });
  STORES.push(store);
  return { root, store, deps: { store, derive: deriveFor, log: () => {} } };
}

const mid = (i) => `2026-11-12T10-00-${String(i).padStart(2, '0')}-000Z-a12${String(i).padStart(3, '0')}`;
/** A mail-cards index with every row kind the readers tell apart. */
function writeIndex(root, { godId = null } = {}) {
  const dir = path.join(root, 'state', 'mail-cards');
  fs.mkdirSync(dir, { recursive: true });
  if (godId) fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId, agents: {} }));
  const god = godId ?? 'god';
  const row = (o) => JSON.stringify({ v: 1, to: 'agent-x', ...o });
  const goodBody = 'shipped at abcdef12';
  const a = [
    row({ id: mid(1), card: 'SYN-A', cards: ['SYN-A'], cardFrom: 'field', from: 'agent-x', act: 'done', subject: 'done one', body: goodBody, bodyHash: mailBodyHash(goodBody), created_at: '2026-11-12T10:00:01Z' }),
    row({ id: mid(2), card: 'SYN-A', cardFrom: 'mention-body', from: 'agent-y', act: 'done', subject: 'weak done', body: 'x', bodyHash: 'nope', deliveredAt: Date.parse('2026-11-12T10:00:02Z') }),
    row({ id: mid(3), card: 'SYN-A', cardFrom: 'guess', from: 'agent-y', act: 'done', subject: 'untrusted' }),
    row({ id: 'not-a-mail-id', card: 'SYN-A', cardFrom: 'field', from: 'agent-y', act: 'done', subject: 'bad id' }),
    '{"torn": ',
    row({ id: mid(4), card: 'SYN-A', cardFrom: 'field', from: god, act: 'inform', subject: 'RULING: ship it', body: 'go', bodyHash: mailBodyHash('go'), created_at: '2026-11-12T10:00:04Z' }),
    row({ id: mid(5), card: 'SYN-A', cardFrom: 'field', from: god, act: 'inform', subject: 'just news' }),
    row({ id: mid(6), card: 'SYN-A', cardFrom: 'field', from: 'agent-z', act: 'inform', subject: 'RULING: not god' }),
    '',
  ].join('\n');
  const b = [
    row({ id: mid(1), card: 'SYN-B', cards: ['SYN-B'], cardFrom: 'field', from: 'agent-x', act: 'done', subject: 'done one' }),
    row({ id: mid(4), card: 'SYN-B', cardFrom: 'reply', from: god, act: 'inform', subject: 'RULING: ship it' }),
    row({ id: mid(4), card: 'SYN-C', cardFrom: 'mention-body', from: god, act: 'inform', subject: 'RULING: ship it' }),
    row({ id: mid(7), card: 'SYN-B', cardFrom: 'reply', from: 'agent-z', act: 'done', subject: 'replied done', in_reply_to: mid(1) }),
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'syn-a.jsonl'), a);
  fs.writeFileSync(path.join(dir, 'syn-b.jsonl'), `${b}\n`);
  fs.writeFileSync(path.join(dir, '_skip.jsonl'), row({ id: mid(9), card: 'SYN-Z', cardFrom: 'field', from: 'agent-x', act: 'done', subject: 'private' }));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an index file');
  return { files: 2, lines: a.split('\n').length + `${b}\n`.split('\n').length };
}

test('A12: the async done reader returns what the sync one returns, with the same seen and subjects', async () => {
  const root = hiveDir();
  writeIndex(root);
  const seenS = new Set(); const subS = new Map();
  const seenA = new Set(); const subA = new Map();
  const sync = W.readIndexDoneMails(root, seenS, subS);
  let ticks = 0;
  const async_ = await W.readIndexDoneMailsAsync(root, seenA, subA, async () => { ticks++; });
  assert.ok(sync.length >= 3, 'the fixture yields done mails');
  assert.deepEqual(async_, sync);
  assert.deepEqual([...seenA], [...seenS]);
  assert.deepEqual([...subA], [...subS]);
  // A second pass with the same seen reads nothing new, both ways.
  assert.deepEqual(await W.readIndexDoneMailsAsync(root, seenA, subA, async () => {}), W.readIndexDoneMails(root, seenS, subS));
  assert.equal(W.readIndexDoneMails(root, seenS).length, 0);
  // No index folder at all: both empty.
  const bare = hiveDir();
  assert.deepEqual(await W.readIndexDoneMailsAsync(bare, undefined, undefined, async () => {}), W.readIndexDoneMails(bare));
  assert.ok(ticks > 0);
});

test('A12: the async ruling reader returns what the sync one returns (registry godId and default god)', async () => {
  for (const godId of [null, 'boss-1']) {
    const root = hiveDir();
    writeIndex(root, { godId });
    const sync = W.readIndexRulingMails(root);
    assert.ok(sync.length >= 1, 'the fixture yields a ruling');
    assert.deepEqual(await W.readIndexRulingMailsAsync(root, async () => {}), sync);
  }
});

test('A12: readDoneMailsAsync equals readDoneMails (index + ledgers + proven), seen and subjects included', async () => {
  const root = hiveDir();
  writeIndex(root);
  const s1 = new Set(); const m1 = new Map(); const s2 = new Set(); const m2 = new Map();
  const sync = W.readDoneMails(root, s1, m1, { proven: true });
  const async_ = await W.readDoneMailsAsync(root, s2, m2, { proven: true }, async () => {});
  assert.deepEqual(async_, sync);
  assert.deepEqual([...s2], [...s1]);
  assert.deepEqual([...m2], [...m1]);
  assert.deepEqual(await W.readDoneMailsAsync(root, undefined, undefined, {}, async () => {}), W.readDoneMails(root));
});

test('A12: the async readers tick before each file and each row (so the sliced ticker can yield)', async () => {
  const root = hiveDir();
  const { files, lines } = writeIndex(root);
  for (const read of [(t) => W.readIndexDoneMailsAsync(root, undefined, undefined, t), (t) => W.readIndexRulingMailsAsync(root, t)]) {
    let ticks = 0;
    await read(async () => { ticks++; });
    assert.equal(ticks, files + lines, 'one tick per index file and one per line');
  }
  // With a ticker that always pauses, a timer set before the read runs before the read ends.
  let fired = false;
  setImmediate(() => { fired = true; });
  let firedBeforeEnd = false;
  await W.readIndexDoneMailsAsync(root, undefined, undefined, async () => { await new Promise((r) => setImmediate(r)); if (fired) firedBeforeEnd = true; });
  assert.equal(firedBeforeEnd, true);
});

test('A12: deriveOnce reuses only for the same derive, the same records array and the same frozen registry', () => {
  let calls = 0;
  const d = (records, registry, opts) => { calls++; assert.deepEqual(opts, { r4: false }); return { claims: {}, n: records.length, registry }; };
  const recs = [];
  const s1 = W.deriveOnce(d, recs, FROZEN);
  assert.equal(calls, 1);
  assert.equal(W.deriveOnce(d, recs, FROZEN), s1, 'same inputs: the kept state');
  assert.equal(calls, 1);
  const recs2 = [];
  assert.notEqual(W.deriveOnce(d, recs2, FROZEN), s1, 'a new records array (an append) is derived');
  assert.equal(calls, 2);
  const other = deepFreeze(structuredClone(DEFAULT_KEY_REGISTRY));
  W.deriveOnce(d, recs2, other);
  assert.equal(calls, 3, 'another registry is derived');
  let calls2 = 0;
  const d2 = (...a) => { calls2++; return d(...a); };
  W.deriveOnce(d2, recs2, other);
  assert.equal(calls2, 1, 'another derive is called');
  // A registry that can still change is never kept: it is derived every time.
  const live = structuredClone(DEFAULT_KEY_REGISTRY);
  calls = 0;
  W.deriveOnce(d, recs, live); W.deriveOnce(d, recs, live);
  assert.equal(calls, 2);
  // and it drops what was kept (no stale reuse after it).
  W.deriveOnce(d, recs, FROZEN); W.deriveOnce(d, recs, FROZEN);
  assert.equal(calls, 3);
  // Real derive: the kept state equals a fresh one.
  const real = W.deriveOnce(derive, recs, FROZEN);
  assert.deepEqual(real, derive(recs, FROZEN, { r4: false }));
});

function cardsHive(root) {
  const tasks = { tasks: [
    { id: 'SYN-H1', title: 'Hot card', status: 'done', assignee: 'agent-x', dependsOn: [], priority: 1, createdAt: '2026-10-01T00:00:00Z',
      result: 'shipped it', notes: 'a note', humanQA: [{ q: 'Synthetic go?', a: 'Go', answeredAt: '2026-10-02T00:00:00Z' }] },
    { id: 'SYN-H2', title: 'Second', status: 'todo', dependsOn: [], priority: 1, createdAt: '2026-10-01T00:00:00Z', result: 'half' },
  ] };
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify(tasks));
}
const CHANGELOG = '# Changelog\n\n## 9.1.2\n\n- SYN-H1 shipped\n';
const input = (root) => ({ hiveRoot: root, git: null, releases: { changelog: CHANGELOG, tags: [] } });

test('A12: with deriveOnce the backfill counts equal a plain derive, and an idempotent rerun derives once', async () => {
  const plain = setup((records) => derive(records, FROZEN, { r4: false }));
  let calls = 0;
  const spy = (...a) => { calls++; return derive(...a); };
  const once = setup((records) => W.deriveOnce(spy, records, FROZEN));
  for (const x of [plain, once]) { cardsHive(x.root); writeIndex(x.root); }
  const p1 = await W.runDerivedBackfill(plain.deps, input(plain.root));
  const o1 = await W.runDerivedBackfill(once.deps, input(once.root));
  assert.deepEqual(o1, p1);
  assert.ok(p1.decisions.appended + p1.records.appended + p1.rulings.appended > 0, 'the first run appends');
  const strip = (r) => r.records.filter((c) => c.t === 'claim').map((c) => [c.key, c.text, c.status ?? null]);
  assert.deepEqual(strip(once.store.readLedger(DERIVED_AGENT_ID)), strip(plain.store.readLedger(DERIVED_AGENT_ID)));
  calls = 0;
  const p2 = await W.runDerivedBackfill(plain.deps, input(plain.root));
  const o2 = await W.runDerivedBackfill(once.deps, input(once.root));
  assert.deepEqual(o2, p2);
  assert.equal(p2.records.appended + p2.decisions.appended + p2.rulings.appended + p2.cardFields.appended + p2.releases.appended, 0, 'idempotent');
  assert.equal(calls, 1, 'nothing appended: one derive for the whole rerun (was one per step)');
});

test('A12: each backfill step runs in its own event-loop turn', async () => {
  const derives = [];
  let turn = 0;
  let spinning = true;
  const spin = () => { turn++; if (spinning) setImmediate(spin); };
  const x = setup((records) => { derives.push(turn); return derive(records, FROZEN, { r4: false }); });
  cardsHive(x.root);
  await W.runDerivedBackfill(x.deps, input(x.root));
  derives.length = 0;
  setImmediate(spin);
  const t0 = turn;
  try { await W.runDerivedBackfill(x.deps, input(x.root)); } finally { spinning = false; }
  assert.ok(derives.length >= 5, `one derive per step (${derives.length})`);
  assert.ok(derives[0] > t0, 'the first step runs after a turn, not in the caller\'s');
  for (let i = 1; i < derives.length; i++) assert.ok(derives[i] > derives[i - 1], `step ${i} ran in the same turn as step ${i - 1}: ${derives.join(',')}`);
});

test('A12: main wires deriveOnce with the shared registry, and the live pass reads the index async', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.ok(idx.includes('derive: (records) => deriveOnce(claimsDerive, records, registry())'), 'the derived writer derives through deriveOnce');
  assert.ok(idx.includes('try { return loadRegistryShared(root); }'), 'with the frozen shared registry');
  const live = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'claims', 'derivedLive.ts'), 'utf8');
  assert.ok(live.includes('return readDoneMailsAsync(root, this.seenMail, this.subjects);'), 'newDoneMails is the async reader');
  assert.ok(!/\breadDoneMails\(|\breadIndexRulingMails\(/.test(live), 'no sync index reader is left in the live pass');
});

// A13 (Jim 3e0c72 item 3: the first index sync, syncOnce, was one 2.3 s block over all agents).
const { ClaimsIndexSync } = loadTs('src/main/claims/indexSync.ts');
test('A13: syncAll starts each agent in its own event-loop turn, same agents, order and outcomes', async () => {
  let turn = 0;
  let spinning = true;
  const spin = () => { turn++; if (spinning) setImmediate(spin); };
  const reads = [];
  const sent = [];
  const rec = (id) => ({ v: 1, id, t: 'claim', kind: 'fact', text: id, source: 'self', at: '2026-10-03T10:00:00.000Z', wt: '2026-10-03T10:00:00.000Z', agent: 'a1', prev: '', mac: `m-${id}` });
  const agents = ['a1', 'a2', 'a3', 'a4'];
  const s = new ClaimsIndexSync({
    readLedger: (a) => { reads.push([a, turn]); return { records: [rec(`c-00000000000${agents.indexOf(a) + 1}`)], torn: null, chain: 'ok' }; },
    derive: () => (records) => ({ v: 1, agent: 'a1', registryHash: '', ledgerHead: 'head', conflicts: [], claims: Object.fromEntries(records.map((r) => [r.id, { id: r.id, status: 'live', sightings: 0, firstAt: '', lastAt: '', pinned: false, reasons: [] }])) }),
    registry: () => FROZEN,
    ruleConfig: () => ({ r4: false }),
    level: (a) => (a === 'a3' ? 'shadow' : 'reader'),
    agents: () => agents,
    send: async (args) => { sent.push(args.wing); return { ok: true }; },
  });
  setImmediate(spin);
  const t0 = turn;
  let out;
  try { out = await s.syncAll(); } finally { spinning = false; }
  assert.deepEqual(out.map((o) => (o.sent ? o.records : o.why)), [1, 1, 'level', 1], 'outcomes in agent order');
  assert.deepEqual(reads.map(([a]) => a), ['a1', 'a2', 'a4']);
  assert.deepEqual(sent, ['a1', 'a2', 'a4']);
  assert.ok(reads[0][1] > t0, 'the first agent is not read in the caller\'s turn');
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i][1] > reads[i - 1][1], `agents ${reads[i - 1][0]} and ${reads[i][0]} were synced in one turn: ${JSON.stringify(reads)}`);
});
