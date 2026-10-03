'use strict';
/**
 * CLAIM-LEDGER W4 delivery (claims/delivery.ts), Jim's CL-W4-INT audit:
 *   M-1 the read-only warning (healthy writer: none)   M-2 only the verified prefix is delivered
 *   M-3 the character cap (with the carry and the mail, inside 9,500)   M-4/G4.5 the Codex view
 *   S-1 the provider is a tested module: unknown = no flag, the cardOutcomes table, receipts
 *   S-2 bounded, cached git evidence   S-3 receipts deduplicated and rotated
 * Synthetic claims only. HOME and USERPROFILE are jailed before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-w4-'));
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
const ROOT = path.join(__dirname, '..');
const D = loadTs('src/main/claims/delivery.ts');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { worldView } = loadTs('src/main/claims/world.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');
const W = loadTs('src/main/claims/worldSnapshot.ts');
const { MAIL_JOINED_BUDGET } = loadTs('src/main/mailSurface.ts');
const { COMPACT_CARRY_MAX } = loadTs('src/main/compactHealth.ts');

let n = 0;
/** A sandbox hive with a real ClaimStore, and a delivery over it with a fake git. */
function setup(over = {}) {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  const keys = new SandboxKeyProvider();
  const mkStore = () => { const s = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)) }); STORES.push(s); return s; };
  const ref = { store: mkStore() };
  const gitCalls = [];
  const git = over.git ?? (async (cwd, args, input) => {
    gitCalls.push(args[0]);
    if (args[0] === 'rev-parse') return 'HEAD1\n';
    if (args[0] === 'cat-file') return input.trim().split('\n').map((s) => (s.startsWith('dead') ? `${s} missing` : `${s} commit 200`)).join('\n') + '\n';
    if (args[0] === 'log') return '';
    return null;
  });
  const receipts = [];
  const levels = { a1: 'writer', ...(over.levels ?? {}) };
  const deps = {
    hiveRoot: () => root,
    level: (a) => levels[a] ?? 'off',
    readLedger: (a) => ref.store.readLedger(a),
    registry: () => DEFAULT_KEY_REGISTRY,
    derive, worldView,
    agentCwd: () => root,
    tasks: () => over.tasks ?? [],
    usage: () => over.usage ?? [],
    countTokens: () => (t) => Math.ceil(t.length / 4),
    git,
    now: () => new Date('2026-10-03T12:00:00.000Z'),
    appendReceipt: (file, line) => receipts.push({ file, receipt: JSON.parse(line) }),
    ...(over.deps ?? {}),
  };
  return { root, keys, ref, mkStore, delivery: D.createClaimDelivery(deps), gitCalls, receipts, levels, claimsDir: (a) => path.join(root, 'agents', a, 'memory', 'claims') };
}
async function note(store, agent, text, extra = {}) { const r = await store.appendRecord(agent, { t: 'claim', kind: 'fact', text, ...extra }, 'endpoint'); assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }

test('Jim M-1: a healthy writer gets NO read-only warning; a reader and a broken chain do', async () => {
  const x = setup({ levels: { a2: 'reader' } });
  await note(x.ref.store, 'a1', 'synthetic writer fact');
  await note(x.ref.store, 'a2', 'synthetic reader fact');
  const w = await x.delivery.workingSet('a1');
  assert.match(w, /synthetic writer fact/);
  assert.ok(!w.includes(D.READ_ONLY_WARNING), 'a healthy writer is not told it is read-only');
  assert.ok((await x.delivery.workingSet('a2')).endsWith(D.READ_ONLY_WARNING), 'a reader is');
  // A forged line (no valid MAC) after a1's record: the chain breaks.
  const f = path.join(x.claimsDir('a1'), fs.readdirSync(x.claimsDir('a1'))[0]);
  const last = JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').pop());
  fs.appendFileSync(f, JSON.stringify({ ...last, id: 'c-ffffffffffff', text: 'FORGED synthetic line', mac: 'x' }) + '\n');
  x.ref.store = x.mkStore();
  assert.ok((await x.delivery.workingSet('a1')).endsWith(D.READ_ONLY_WARNING), 'a broken chain is');
});

test('Jim M-2: only the verified prefix is delivered: a forged line never; a head-anchor cut or a lost key: no claims at all, only the warning', async () => {
  const x = setup();
  await note(x.ref.store, 'a1', 'synthetic first fact');
  await note(x.ref.store, 'a1', 'synthetic second fact');
  x.ref.store.close();
  const f = path.join(x.claimsDir('a1'), fs.readdirSync(x.claimsDir('a1'))[0]);
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
  const prev = require('node:crypto').createHash('sha256').update(lines[1]).digest('hex');
  fs.appendFileSync(f, JSON.stringify({ ...JSON.parse(lines[1]), id: 'c-ffffffffffff', text: 'FORGED synthetic line', prev, mac: 'x' }) + '\n');
  x.ref.store = x.mkStore();
  const r = x.ref.store.readLedger('a1');
  assert.ok(r.records.some((q) => q.id === 'c-ffffffffffff'), 'readLedger returns the forged record (as Jim P2)');
  const w = await x.delivery.workingSet('a1');
  assert.ok(!w.includes('FORGED'), 'the forged text is not delivered');
  assert.ok(w.includes('synthetic first fact') && w.includes('synthetic second fact'), 'the verified records are');
  // A cut (the anchor no longer reached): nothing but the warning.
  fs.writeFileSync(f, lines[0] + '\n');
  x.ref.store = x.mkStore();
  assert.deepEqual(x.ref.store.readLedger('a1').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  assert.equal(await x.delivery.workingSet('a1'), D.READ_ONLY_WARNING);
  // A lost key: nothing but the warning.
  const y = setup();
  await note(y.ref.store, 'a1', 'synthetic fact under a key');
  y.ref.store.close();
  y.keys.drop();
  y.ref.store = y.mkStore();
  assert.equal(y.ref.store.readLedger('a1').chain.reason, 'key-missing');
  assert.equal(await y.delivery.workingSet('a1'), D.READ_ONLY_WARNING);
});

test('levels off and shadow deliver nothing', async () => {
  const x = setup({ levels: { a1: 'shadow', a3: 'off' } });
  await note(x.ref.store, 'a1', 'synthetic');
  assert.equal(await x.delivery.workingSet('a1'), null);
  assert.equal(await x.delivery.workingSet('a3'), null);
});

test('Jim S-1: god\'s cardOutcomes table: done WITH a result = helped; done without = none; blocked/cancelled = hurt; doing = none', () => {
  const tasks = { A: { id: 'A', status: 'done', result: 'shipped' }, B: { id: 'B', status: 'done', result: '  ' }, C: { id: 'C', status: 'done' }, E: { id: 'E', status: 'blocked' }, F: { id: 'F', status: 'cancelled' }, G: { id: 'G', status: 'doing' } };
  const usage = ['A', 'B', 'C', 'E', 'F', 'G', 'Z'].map((card) => ({ at: '2026-10-03T00:00:00Z', claim: 'c-000000000001', op: 'view', card }));
  assert.deepEqual(D.cardOutcomes(usage, (id) => tasks[id]), { A: 'helped', E: 'hurt', F: 'hurt' });
});

test('Jim S-1: unknown git evidence is neutral (god): an unknown commit exists, an unknown file did not change; known values pass through', () => {
  const snapshot = { commits: new Map([['abc1234', false], ['bcd2345', true]]), changedFiles: new Map([['a.ts\u00002026-10-01T00:00:00Z', true]]) };
  const w = D.worldInputs({ now: 'n', tasks: [{ id: 'T', status: 'doing' }], cwd: JAIL, snapshot, usage: [], fileExists: () => true });
  assert.equal(w.commitExists('0000000'), true, 'unknown commit: no stale-ref');
  assert.equal(w.commitExists('abc1234'), false); assert.equal(w.commitExists('bcd2345'), true);
  assert.equal(w.fileChangedSince('b.ts', '2026-10-01T00:00:00Z'), false, 'unknown file: unchanged');
  assert.equal(w.fileChangedSince('a.ts', '2026-10-01T00:00:00Z'), true);
  assert.equal(w.taskStatus('T'), 'doing'); assert.equal(w.taskStatus('nope'), null);
});

test('Jim S-1 / S-3: one receipt per DISTINCT delivered text (B14); a change appends another', async () => {
  const x = setup();
  await note(x.ref.store, 'a1', 'synthetic fact one');
  await x.delivery.workingSet('a1');
  await x.delivery.workingSet('a1');
  assert.equal(x.receipts.length, 1, 'the same text: one receipt');
  assert.equal(x.receipts[0].file, path.join(x.root, 'agents', 'a1', 'memory', 'receipts.jsonl'));
  assert.equal(x.receipts[0].receipt.agent, 'a1');
  await note(x.ref.store, 'a1', 'synthetic fact two');
  await x.delivery.workingSet('a1');
  assert.equal(x.receipts.length, 2);
});

test('Jim S-3: receipts.jsonl rotates past its size and keeps a bounded number of old files', () => {
  const dir = fs.mkdtempSync(path.join(JAIL, 'rot-'));
  const file = path.join(dir, 'receipts.jsonl');
  const line = 'x'.repeat(99) + '\n';
  for (let i = 0; i < 50; i++) D.appendRotating(file, line, 1000, 2);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ['receipts.jsonl', 'receipts.jsonl.1', 'receipts.jsonl.2']);
  for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 1000);
});

test('Jim M-3: the working set fits its character cap (set + carry + mail reserve = 9,500), at a scaled-down budget', async () => {
  assert.equal(D.WORKING_SET_MAX_CHARS, MAIL_JOINED_BUDGET - COMPACT_CARRY_MAX - D.WORKING_SET_MAIL_RESERVE);
  assert.equal(MAIL_JOINED_BUDGET, 9_500);
  const x = setup();
  for (let i = 0; i < 120; i++) await note(x.ref.store, 'a1', `synthetic claim ${i} about the widget relay and the crate on port ${4400 + i}, with some more words to make it long`);
  const w = await x.delivery.workingSet('a1');
  assert.ok(w.length <= D.WORKING_SET_MAX_CHARS, `${w.length} > ${D.WORKING_SET_MAX_CHARS}`);
  assert.ok(w.length > D.WORKING_SET_MAX_CHARS * 0.6, 'and it uses most of it');
  assert.ok(x.receipts.at(-1).receipt.budget < 3000, 'B scaled down to fit');
  assert.match(w, /\+\d+ more/, 'the overflow is shown');
});

test('god (W5 slot, Creed S3 ruling): reconcile items render ONCE, as the T1 ⚠ markers, inside the cap; turnCompleted reaches the W5 hook', async () => {
  const told = [];
  const item = (i) => ({ itemId: `r-${i}`, agent: 'a1', kind: 'conflict', a: 'c-000000000001', b: 'c-000000000002', text: `synthetic reconcile question ${i}`, turnsUnanswered: 0 });
  const x = setup({ deps: { reconcileItems: () => [item(1), item(2), item(3), item(4)], onTurnCompleted: (a) => told.push(a) } });
  for (let i = 0; i < 120; i++) await note(x.ref.store, 'a1', `synthetic claim ${i} about the widget relay and the crate on port ${4400 + i}, with some more words`);
  const w = await x.delivery.workingSet('a1');
  assert.ok(w.length <= D.WORKING_SET_MAX_CHARS);
  for (const i of [1, 2, 3]) assert.equal(w.split(`synthetic reconcile question ${i}`).length - 1, 1, `item ${i} rendered exactly once`);
  assert.ok(!w.includes('synthetic reconcile question 4'), 'at most 3 items (n <= 3)');
  assert.match(w, /⚠ reconcile r-1: synthetic reconcile question 1/, 'as a T1 marker');
  x.delivery.turnCompleted('a1');
  assert.deepEqual(told, ['a1']);
});

test('Jim S-2: the git evidence is cached per ledger head and HEAD: a second build runs only rev-parse', async () => {
  let head = 'HEAD1';
  const calls = [];
  const git = async (cwd, args, input) => {
    calls.push(args[0]);
    if (args[0] === 'rev-parse') return `${head}\n`;
    if (args[0] === 'cat-file') return input.trim().split('\n').map((s) => `${s} commit 1`).join('\n') + '\n';
    return '';
  };
  const x = setup({ git });
  await note(x.ref.store, 'a1', 'synthetic', { refs: [{ type: 'commit', value: 'abc1234' }, { type: 'file', value: 'src/a.ts' }] });
  await x.delivery.workingSet('a1');
  assert.deepEqual(calls, ['rev-parse', 'cat-file', 'log']);
  calls.length = 0;
  await x.delivery.workingSet('a1');
  assert.deepEqual(calls, ['rev-parse'], 'cached');
  head = 'HEAD2';
  calls.length = 0;
  await x.delivery.workingSet('a1');
  assert.deepEqual(calls, ['rev-parse', 'cat-file', 'log'], 'a new HEAD rebuilds');
});

test('Jim S-2: the snapshot caps its git children and stops at its deadline (the rest unknown); an ambiguous short sha is unknown', async () => {
  const claims = {}; const records = [];
  for (let i = 0; i < 20; i++) {
    const id = `c-${String(i).padStart(12, '0')}`;
    records.push({ v: 1, id, t: 'claim', kind: 'fact', text: 't', refs: [{ type: 'file', value: `f${i}.ts` }], at: '2026-10-01T00:00:00Z', wt: '2026-10-01T00:00:00Z', agent: 'a1', prev: '', mac: '' });
    claims[id] = { id, status: 'live', lastAt: '2026-10-01T00:00:00Z' };
  }
  records.push({ v: 1, id: 'c-zzzzzzzzzzzz', t: 'claim', kind: 'fact', text: 't', refs: [{ type: 'commit', value: 'abc1234' }, { type: 'commit', value: 'dead123' }, { type: 'commit', value: 'beef123' }], at: '', wt: '', agent: 'a1', prev: '', mac: '' });
  claims['c-zzzzzzzzzzzz'] = { id: 'c-zzzzzzzzzzzz', status: 'live', lastAt: '2026-10-01T00:00:00Z' };
  let running = 0; let peak = 0; let logs = 0;
  let t = 0;
  const git = async (cwd, args) => {
    if (args[0] === 'cat-file') return 'abc1234 ambiguous\ndead123 missing\nbeef123 commit 10\n';
    running++; peak = Math.max(peak, running); logs++;
    await new Promise((r) => setTimeout(r, 5));
    t += 100;   // each git log "takes" 100 ms of the deadline
    running--;
    return 'x\n';
  };
  const s = await W.buildClaimsWorldSnapshot(records, { claims }, JAIL, { git, deadlineMs: 1000, now: () => t });
  assert.ok(peak <= W.WORLD_GIT_CONCURRENCY, `peak ${peak}`);
  assert.ok(logs < 20, `stopped at the deadline (${logs} logs)`);
  assert.equal(s.changedFiles.size, logs, 'what ran is known; the rest is unknown');
  assert.equal(s.commits.has('abc1234'), false, 'ambiguous: unknown (no stale-ref)');
  assert.equal(s.commits.get('dead123'), false);
  assert.equal(s.commits.get('beef123'), true);
});

test('Jim M-5: a claim with a lone surrogate still gives a Codex config.toml that parses (U+FFFD in its place), on the spawn and the -c resume paths', async () => {
  const toml = require('toml');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const x = setup();
  await note(x.ref.store, 'a1', 'synthetic fact with a lone \ud800 surrogate and a lone \udfff one');
  const view = await x.delivery.workingSet('a1');
  assert.ok(view.includes('\ud800'), 'the view carries it (as Jim P4)');
  const instructions = HiveManager.codexDeveloperInstructions('PROTOCOL', view);
  const config = HiveManager.withCodexDeveloperInstructions('model = "x"\n', instructions);
  const parsed = toml.parse(config);
  assert.ok(parsed.developer_instructions.includes('a lone � surrogate and a lone � one'));
  assert.ok(!/\\ud[89ab]/i.test(config) && !/\\ud[c-f]/i.test(config), 'no surrogate escape is written');
  assert.equal(toml.parse(`developer_instructions = ${HiveManager.tomlString(instructions)}`).developer_instructions, parsed.developer_instructions, '-c resume path');
  // A valid pair is kept as is.
  assert.equal(toml.parse(`k = ${HiveManager.tomlString('pair 😀 ok')}`).k, 'pair 😀 ok');
});

test('Jim M-4 / G4.5: the Codex instruction file and wake-up get the same bytes at the same state; the app wires one provider to both', async () => {
  const x = setup();
  await note(x.ref.store, 'a1', 'synthetic fact for codex');
  const forWake = await x.delivery.workingSet('a1');
  const forCodex = await x.delivery.workingSet('a1');
  assert.equal(forCodex, forWake, 'byte for byte');
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /nativeMemory\.setClaimWakeupProvider\(claimWorkingSetForAgent\);/);
  assert.match(idx, /hive\.setCodexClaimContextProvider\(claimWorkingSetForAgent\);/);
  assert.match(idx, /hookServer\.setClaimWorkingSetProvider\(claimWorkingSetForAgent\);/);
  assert.match(idx, /const claimWorkingSetForAgent = \(agentId: string\): Promise<string \| null> => \(claimsEndpoint\(\) \? claimDelivery\.workingSet\(agentId\) : Promise\.resolve\(null\)\);/);
  assert.match(idx, /hookServer\.setClaimTurnCompletedListener\(\(agentId\) => claimDelivery\.turnCompleted\(agentId\)\);/);
  const hive = fs.readFileSync(path.join(ROOT, 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(hive, /preset\.systemPromptChannel === 'codex-developer-instructions' \? HiveManager\.codexDeveloperInstructions\(prompt, claimContext\) : null/);
  assert.match(hive, /try \{ claimContext = await this\.codexClaimContext\(meta\.id\); \}/);
});
