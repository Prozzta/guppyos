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
const http = require('node:http');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-w4-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
const HIVES = [];
test.after(() => {
  for (const s of STORES) s.close();
  for (const h of HIVES) h.dispose();
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
const { ReconcileQueue, ReconcileApi, reconcilePromptText, reconcileItemId } = loadTs('src/main/claims/reconcile.ts');
const W = loadTs('src/main/claims/worldSnapshot.ts');
const { MAIL_JOINED_BUDGET } = loadTs('src/main/mailSurface.ts');
const { COMPACT_CARRY_MAX } = loadTs('src/main/compactHealth.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

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

async function postLiveHook(server, agentId, payload) {
  server.start();
  for (let i = 0; i < 200 && server.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  const url = new URL(server.hookUrl(agentId));
  const body = JSON.stringify({ session_id: `s-${agentId}`, ...payload });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
      let text = ''; res.on('data', (d) => { text += d; }); res.on('end', () => resolve(JSON.parse(text))); });
    req.on('error', reject); req.end(body);
  });
}

/** One payload down the hook pipe (the command shim's route; only it may mark a briefing). */
async function pipeLiveHook(server, payload) {
  server.start();
  const sock = server.hive.sockPath();
  for (let i = 0; i < 200; i++) {
    const ok = await new Promise((r) => { const c = require('node:net').createConnection(sock, () => { c.destroy(); r(true); }); c.on('error', () => r(false)); });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  return new Promise((resolve, reject) => {
    let b = '';
    const c = require('node:net').createConnection(sock, () => c.write(JSON.stringify(payload) + '\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { b += d; });
    c.on('end', () => resolve(JSON.parse(b || '{}')));
    c.on('error', reject);
  });
}

/** CL-M4-BRIEFING-BUDGET C: a Claude SessionStart runs BOTH entries at once, the main bundle and the
 *  briefing (the shim's --part briefing); the model receives both outputs. */
async function postClaudeSessionStart(server, agentId, payload) {
  // Both are command entries over the pipe; the main one is marked 'bundle' (S1: new settings).
  const [main, brief] = await Promise.all([pipeLiveHook(server, { session_id: `s-${agentId}`, ...payload, agent_id: agentId, munder_part: 'bundle' }), pipeLiveHook(server, { session_id: `s-${agentId}`, ...payload, agent_id: agentId, munder_part: 'briefing' })]);
  const parts = [main?.hookSpecificOutput?.additionalContext, brief?.hookSpecificOutput?.additionalContext].filter(Boolean);
  return parts.length ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } } : {};
}

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

test('Jim M-3: the 9,000-char briefing ceiling is preserved; current joined envelope delivers at most 4,500', async () => {
  assert.equal(D.WORKING_SET_MAX_CHARS, 9_000);
  assert.equal(D.WORKING_SET_DELIVERY_MAX_CHARS, MAIL_JOINED_BUDGET - COMPACT_CARRY_MAX - D.WORKING_SET_MAIL_RESERVE);
  assert.equal(D.WORKING_SET_DELIVERY_MAX_CHARS, 4_500, '9,500 − 1,500 − 3,500 leaves 4,500 today');
  assert.equal(MAIL_JOINED_BUDGET, 9_500);
  const x = setup();
  for (let i = 0; i < 120; i++) await note(x.ref.store, 'a1', `synthetic claim ${i} about the widget relay and the crate on port ${4400 + i}, with some more words to make it long`);
  const w = await x.delivery.workingSet('a1');
  assert.ok(w.length <= D.WORKING_SET_DELIVERY_MAX_CHARS, `${w.length} > ${D.WORKING_SET_DELIVERY_MAX_CHARS}`);
  assert.ok(w.length > D.WORKING_SET_DELIVERY_MAX_CHARS * 0.6, 'uses most of the currently available joined-envelope room');
  assert.ok(x.receipts.at(-1).receipt.budget < 3000, 'B scaled down to fit');
  assert.match(w, /\+\d+ more/, 'the overflow is shown');
});

test('CL-M4-BRIEFING-BUDGET C: Claude\'s own briefing entry (maxChars = the ceiling) delivers past the joined room, up to 9,000 and never beyond', async () => {
  const x = setup();
  for (let i = 0; i < 120; i++) await note(x.ref.store, 'a1', `synthetic claim ${i} about the widget relay and the crate on port ${4400 + i}, with some more words to make it long`);
  const joined = await x.delivery.workingSet('a1', 'startup');
  const full = await x.delivery.workingSet('a1', 'startup', D.WORKING_SET_MAX_CHARS);
  assert.ok(joined.length <= D.WORKING_SET_DELIVERY_MAX_CHARS, 'the default stays the joined room');
  assert.ok(full.length > D.WORKING_SET_DELIVERY_MAX_CHARS, `${full.length}: the briefing entry uses the room the bundle could not give`);
  assert.ok(full.length <= D.WORKING_SET_MAX_CHARS, `${full.length} > ${D.WORKING_SET_MAX_CHARS}`);
  const over = await x.delivery.workingSet('a1', 'startup', 50_000);
  assert.ok(over.length <= D.WORKING_SET_MAX_CHARS, 'a larger request is held to the Human\'s 9,000 ceiling');
  assert.ok(D.WORKING_SET_MAX_CHARS < 10_000, 'under Claude Code\'s 10,000-char per-output spill');
});

test('god (W5 slot, Creed S3 ruling): reconcile items render ONCE, as the T1 ⚠ markers, inside the cap; turnCompleted reaches the W5 hook', async () => {
  const told = [], log = [];
  const item = (i) => ({ itemId: `r-${i}`, agent: 'a1', kind: 'conflict', a: 'c-000000000001', b: 'c-000000000002', text: `synthetic reconcile question ${i}`, turnsUnanswered: 0 });
  const x = setup();
  const queue = new ReconcileQueue(path.join(x.root, 'claims-reconcile-queue.json'));
  queue.refresh('a1', [item(1), item(2), item(3), item(4)]);
  const api = new ReconcileApi({ queue, countTokens: (text) => Math.ceil(text.length / 4), log: (row) => log.push(row),
    appendSoftSupersede: async () => ({ ok: true }), newestWins: () => null, isLiveClaim: () => true, isOwner: (a) => a === 'a1' });
  x.delivery = D.createClaimDelivery({ hiveRoot: () => x.root, level: () => 'writer', readLedger: (a) => x.ref.store.readLedger(a),
    registry: () => DEFAULT_KEY_REGISTRY, derive, worldView, agentCwd: () => x.root, tasks: () => [], usage: () => [],
    countTokens: () => (text) => Math.ceil(text.length / 4), git: async () => '', now: () => new Date('2026-10-03T12:00:00.000Z'),
    appendReceipt: () => {}, reconcileCandidates: (a, day) => api.peekForTurn(a, day),
    commitReconcile: (a, day, ids) => { api.commitRendered(a, day, ids); },
    onTurnCompleted: (a) => { told.push(a); void api.onTurnCompleted(a); } });
  for (let i = 0; i < 120; i++) await note(x.ref.store, 'a1', `synthetic claim ${i} about the widget relay and the crate on port ${4400 + i}, with some more words`);
  const w = await x.delivery.workingSet('a1');
  assert.ok(w.length <= D.WORKING_SET_MAX_CHARS);
  for (const i of [1, 2, 3]) assert.equal(w.split(`synthetic reconcile question ${i}`).length - 1, 1, `item ${i} rendered exactly once`);
  assert.ok(!w.includes('synthetic reconcile question 4'), 'at most 3 items (n <= 3)');
  assert.match(w, /⚠ reconcile r-1: synthetic reconcile question 1/, 'as a T1 marker');
  const injected = queue.items('a1').filter((x) => log[0].items.includes(x.itemId));
  assert.equal(log[0].tokens, injected.reduce((n, x) => n + Math.ceil(reconcilePromptText(x).length / 4), 0));
  x.delivery.turnCompleted('a1');
  assert.deepEqual(told, ['a1']);
});

test('M1: only rendered real-id T1 prompts are charged and leased; a dropped prompt survives three Stops and later renders', async () => {
  let room = false;
  const count = (text) => Math.ceil(text.length / (room ? 8 : 4));
  const x = setup();
  const ids = [];
  for (let i = 0; i < 120; i++) ids.push(await note(x.ref.store, 'a1', `synthetic note ${i}: the blue relay on bench ${i} hums at dusk, and the crate beside it holds spare gaskets`));
  const candidates = [[ids[0], ids[1]], [ids[2], ids[3]], [ids[4], ids[5]]].map(([a, b]) => ({
    itemId: reconcileItemId('a1', 'conflict', a, b), kind: 'conflict', a, b,
    text: `R5 candidate (0.931 >= 0.90): ${a} / ${b}`,
  }));
  const queue = new ReconcileQueue(path.join(x.root, 'claims-reconcile-queue.json'));
  queue.refresh('a1', candidates);
  const log = []; const superseded = []; const pendingStops = [];
  const api = new ReconcileApi({ queue, countTokens: count, log: (row) => log.push(row),
    appendSoftSupersede: async (agent, loser, winner, itemId) => { superseded.push(itemId); return { ok: true }; },
    newestWins: (item) => ({ loser: item.a, winner: item.b }), isLiveClaim: () => true, isOwner: (a) => a === 'a1' });
  x.delivery = D.createClaimDelivery({ hiveRoot: () => x.root, level: () => 'writer', readLedger: (a) => x.ref.store.readLedger(a),
    registry: () => DEFAULT_KEY_REGISTRY, derive, worldView, agentCwd: () => x.root, tasks: () => [], usage: () => [],
    countTokens: () => count, git: async (cwd, args) => args[0] === 'rev-parse' ? 'HEAD1\n' : '', now: () => new Date('2026-10-03T12:00:00.000Z'),
    appendReceipt: () => {}, reconcileCandidates: (a, day) => api.peekForTurn(a, day),
    commitReconcile: (a, day, rendered) => { api.commitRendered(a, day, rendered); },
    onTurnCompleted: (a) => { pendingStops.push(api.onTurnCompleted(a)); }, log: (row) => log.push(row) });

  const neverShown = candidates[2].itemId;
  for (let cycle = 0; cycle < 3; cycle++) {
    const start = log.length;
    const working = await x.delivery.workingSet('a1');
    const rendered = candidates.map((item) => item.itemId).filter((id) => working.includes(`reconcile ${id}:`));
    assert.ok(rendered.length < 3, 'M-3 leaves at least one real-length prompt outside T1');
    const injection = log.slice(start).find((row) => row.kind === 'claims-reconcile-injected');
    assert.deepEqual(injection?.items ?? [], rendered, 'charged/leased ids equal the rendered ids');
    assert.equal(injection?.tokens ?? 0, candidates.filter((item) => rendered.includes(item.itemId))
      .reduce((n, item) => n + count(reconcilePromptText({ ...item, agent: 'a1', turnsUnanswered: 0 })), 0));
    const dropped = log.slice(start).find((row) => row.kind === 'claims-reconcile-dropped' && row.itemId === neverShown);
    assert.equal(dropped?.reason, 'T1-space');
    assert.equal(Object.hasOwn(dropped ?? {}, 'text'), false, 'drop telemetry contains no prompt text');
    x.delivery.turnCompleted('a1');
    await Promise.all(pendingStops.splice(0));
  }
  const waiting = queue.peek('a1', 3).find((item) => item.itemId === neverShown);
  assert.equal(waiting?.turnsUnanswered, 0);
  assert.equal(waiting?.leaseTurn, undefined);
  assert.equal(superseded.includes(neverShown), false, 'an unseen prompt cannot soft-supersede');

  room = true;
  const later = await x.delivery.workingSet('a1');
  assert.ok(later.includes(`reconcile ${neverShown}:`), 'the still-queued prompt renders when capacity allows room');
  const laterInjected = log.filter((row) => row.kind === 'claims-reconcile-injected').at(-1);
  assert.ok(laterInjected.items.includes(neverShown));
  assert.ok(queue.items('a1').some((item) => item.itemId === neverShown && item.leaseTurn));
});

test('W5 integration: live hook SessionStart injects leased T1 markers; Stop completes the turn and logs rendered token count', async (t) => {
  const x = setup();
  const queue = new ReconcileQueue(path.join(x.root, 'claims-reconcile-queue.json'));
  queue.refresh('a1', [{ itemId: 'r-live', kind: 'conflict', a: 'c-000000000001', b: 'c-000000000002', text: 'live hook reconcile pair' }]);
  const log = [];
  const count = (text) => Math.ceil(text.length / 4);
  const api = new ReconcileApi({ queue, countTokens: count, log: (row) => log.push(row), appendSoftSupersede: async () => ({ ok: true }),
    newestWins: () => null, isLiveClaim: () => true, isOwner: (agentId) => agentId === 'a1' });
  x.delivery = D.createClaimDelivery({ hiveRoot: () => x.root, level: () => 'writer', readLedger: (a) => x.ref.store.readLedger(a),
    registry: () => DEFAULT_KEY_REGISTRY, derive, worldView, agentCwd: () => x.root, tasks: () => [], usage: () => [],
    countTokens: () => count, git: async () => '', now: () => new Date('2026-10-03T12:00:00.000Z'), appendReceipt: () => {},
    reconcileCandidates: (agentId, day) => api.peekForTurn(agentId, day),
    commitReconcile: (agentId, day, ids) => { api.commitRendered(agentId, day, ids); },
    onTurnCompleted: (agentId) => { void api.onTurnCompleted(agentId); } });
  const hive = new HiveManager(() => x.root, () => true); HIVES.push(hive);
  await hive.ensureAgent({ id: 'a1', name: 'a1', provider: 'claude', cwd: x.root });
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  server.setClaimWorkingSetProvider((agentId) => x.delivery.workingSet(agentId));
  server.setClaimTurnCompletedListener((agentId) => x.delivery.turnCompleted(agentId));
  t.after(() => server.stop());
  const start = await postClaudeSessionStart(server, 'a1', { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'a1' });
  const context = start?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(context, /⚠ reconcile r-live: live hook reconcile pair/);
  assert.ok(queue.items('a1')[0]?.leaseTurn, 'the delivered item is leased to a persisted turn');
  const injected = log.find((row) => row.kind === 'claims-reconcile-injected');
  assert.ok(injected?.tokens > 0);
  const marker = '⚠ reconcile r-live: live hook reconcile pair — Answer: memory reconcile c-000000000001 c-000000000002 --answer keep-both|supersedes';
  assert.equal(injected.tokens, count(marker), 'the injection log counts the rendered marker');
  await postLiveHook(server, 'a1', { hook_event_name: 'Stop', agent_id: 'a1' });
  const next = queue.beginTurn('a1');
  assert.equal(next.items[0]?.turnsUnanswered, 1, 'Stop advances the completed turn');
  assert.equal(next.items[0]?.leaseTurn, 'a1:2', 'the next turn gets a fresh lease');
});

test('M2/M3 real hook route: startup recovery, mixed compact leasing, and clear re-render', async (t) => {
  const makeScenario = async (label, candidateCount = 1) => {
    const x = setup();
    const file = path.join(x.root, 'claims-reconcile-queue.json');
    const items = Array.from({ length: candidateCount }, (_, i) => ({ itemId: `r-${label}-${i}`, kind: 'conflict', a: `c-${String(i * 2 + 1).padStart(12, '0')}`, b: `c-${String(i * 2 + 2).padStart(12, '0')}`, text: `${label}-${i} hook reconcile pair` }));
    const item = items[0];
    let queue = new ReconcileQueue(file); queue.refresh('a1', items.slice(0, 1));
    const log = []; let tight = false; const count = (text) => tight ? Math.ceil(text.length * 100) : Math.ceil(text.length / 4);
    let delivery;
    const buildDelivery = (q) => {
      const api = new ReconcileApi({ queue: q, countTokens: count, log: (row) => log.push(row), appendSoftSupersede: async () => ({ ok: true }),
        newestWins: () => null, isLiveClaim: () => true, isOwner: (agentId) => agentId === 'a1' });
      delivery = D.createClaimDelivery({ hiveRoot: () => x.root, level: () => 'writer', readLedger: (a) => x.ref.store.readLedger(a),
        registry: () => DEFAULT_KEY_REGISTRY, derive, worldView, agentCwd: () => x.root, tasks: () => [], usage: () => [],
        countTokens: () => count, git: async () => '', now: () => new Date('2026-10-03T12:00:00.000Z'), appendReceipt: () => {},
        log: (row) => log.push(row),
        reconcileCandidates: (agentId, day, source) => api.peekForTurn(agentId, day, source),
        commitReconcile: (agentId, day, ids, source) => { api.commitRendered(agentId, day, ids, source); },
        onTurnCompleted: (agentId) => { void api.onTurnCompleted(agentId); } });
    };
    buildDelivery(queue);
    const hive = new HiveManager(() => x.root, () => true); HIVES.push(hive);
    await hive.ensureAgent({ id: 'a1', name: 'a1', provider: 'claude', cwd: x.root });
    const server = new HookServer(hive, () => null, () => ({ notifications: false }));
    server.setClaimWorkingSetProvider((agentId, source) => delivery.workingSet(agentId, source));
    server.setClaimTurnCompletedListener((agentId) => delivery.turnCompleted(agentId));
    t.after(() => server.stop());
    return { x, item, items, log, server, file, setTight: () => { tight = true; }, get queue() { return queue; }, set queue(q) { queue = q; buildDelivery(q); } };
  };

  const restarted = await makeScenario('restart');
  const firstStart = await postClaudeSessionStart(restarted.server, 'a1', { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'a1' });
  const firstText = firstStart?.hookSpecificOutput?.additionalContext ?? '';
  assert.match(firstText, /restart-0 hook reconcile pair/);
  const oldTurn = restarted.queue.items('a1')[0].leaseTurn;
  restarted.queue = new ReconcileQueue(restarted.file); // process restart between SessionStart and Stop
  const secondStart = await postClaudeSessionStart(restarted.server, 'a1', { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'a1' });
  assert.match(secondStart?.hookSpecificOutput?.additionalContext ?? '', /restart-0 hook reconcile pair/);
  assert.notEqual(restarted.queue.items('a1')[0].leaseTurn, oldTurn, 'startup reclaims then takes a fresh lease');
  assert.equal(restarted.queue.items('a1')[0].turnsUnanswered, 0, 'abandoned process turn was not counted');
  await postLiveHook(restarted.server, 'a1', { hook_event_name: 'Stop', agent_id: 'a1' });
  assert.equal(restarted.queue.peek('a1')[0].turnsUnanswered, 1, 'Stop counts only the restarted session that showed the prompt');

  const compacted = await makeScenario('compact');
  const initial = await postClaudeSessionStart(compacted.server, 'a1', { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'a1' });
  assert.match(initial?.hookSpecificOutput?.additionalContext ?? '', /compact-0 hook reconcile pair/);
  const initialTurn = compacted.queue.items('a1')[0].leaseTurn;
  const beforeTokens = compacted.queue.dailyTokens('2026-10-03');
  const rerender = await postClaudeSessionStart(compacted.server, 'a1', { hook_event_name: 'SessionStart', source: 'compact', agent_id: 'a1' });
  assert.match(rerender?.hookSpecificOutput?.additionalContext ?? '', /compact-0 hook reconcile pair/);
  assert.equal(compacted.queue.items('a1')[0].leaseTurn, initialTurn, 'compact re-render does not lease again');
  assert.equal(compacted.queue.sequence('a1'), 1, 'compact re-render preserves the open turn sequence');
  assert.equal(compacted.queue.items('a1')[0].turnsUnanswered, 0);
  const rerenderLog = compacted.log.find((row) => row.kind === 'claims-reconcile-rerendered');
  assert.equal(rerenderLog?.tokens, Math.ceil(reconcilePromptText({ ...compacted.item, agent: 'a1', turnsUnanswered: 0 }).length / 4));
  assert.equal(compacted.queue.dailyTokens('2026-10-03'), beforeTokens + rerenderLog.tokens, 're-injected marker tokens count again');
  await postLiveHook(compacted.server, 'a1', { hook_event_name: 'Stop', agent_id: 'a1' });
  assert.equal(compacted.queue.peek('a1')[0].turnsUnanswered, 1, 'one Stop counts one unanswered turn after compact');

  const dropped = await makeScenario('rerender-drop');
  await postClaudeSessionStart(dropped.server, 'a1', { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'a1' });
  assert.ok(dropped.queue.items('a1').length);
  dropped.setTight();
  const noRoom = await postClaudeSessionStart(dropped.server, 'a1', { hook_event_name: 'SessionStart', source: 'compact', agent_id: 'a1' });
  assert.doesNotMatch(noRoom?.hookSpecificOutput?.additionalContext ?? '', /rerender-drop-0 hook reconcile pair/);
  assert.ok(dropped.log.some((row) => row.kind === 'claims-reconcile-dropped' && row.itemId === dropped.item.itemId));
  assert.equal(dropped.queue.items('a1').length, 0, 'a prompt dropped from compact is released, not counted unanswered');
  await postLiveHook(dropped.server, 'a1', { hook_event_name: 'Stop', agent_id: 'a1' });
  assert.equal(dropped.queue.peek('a1')[0].turnsUnanswered, 0);

  const mixed = await makeScenario('mixed', 3);
  await postClaudeSessionStart(mixed.server, 'a1', { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'a1' });
  const mixedTurn = mixed.queue.items('a1')[0].leaseTurn;
  mixed.queue.refresh('a1', mixed.items);
  const beforeMixedTokens = mixed.queue.dailyTokens('2026-10-03');
  const mixedLogMark = mixed.log.length;
  const mixedCompact = await postClaudeSessionStart(mixed.server, 'a1', { hook_event_name: 'SessionStart', source: 'compact', agent_id: 'a1' });
  const mixedText = mixedCompact?.hookSpecificOutput?.additionalContext ?? '';
  for (const item of mixed.items) assert.match(mixedText, new RegExp(`${item.itemId}:`));
  assert.deepEqual(mixed.queue.items('a1').map((item) => item.itemId), mixed.items.map((item) => item.itemId));
  assert.ok(mixed.queue.items('a1').every((item) => item.leaseTurn === mixedTurn));
  assert.equal(mixed.queue.sequence('a1'), 1, 'fresh mixed items join the existing turn');
  const mixedRows = mixed.log.slice(mixedLogMark).filter((row) => row.kind === 'claims-reconcile-injected' || row.kind === 'claims-reconcile-rerendered');
  assert.deepEqual(mixedRows.flatMap((row) => row.items).sort(), mixed.items.map((item) => item.itemId).sort());
  assert.equal(mixed.queue.dailyTokens('2026-10-03') - beforeMixedTokens, mixedRows.reduce((n, row) => n + row.tokens, 0));
  await postLiveHook(mixed.server, 'a1', { hook_event_name: 'Stop', agent_id: 'a1' });
  assert.ok(mixed.queue.peek('a1').every((item) => item.turnsUnanswered === 1), 'one Stop counts each shown marker once');

  const cleared = await makeScenario('clear');
  await postClaudeSessionStart(cleared.server, 'a1', { hook_event_name: 'SessionStart', source: 'startup', agent_id: 'a1' });
  const clearTurn = cleared.queue.items('a1')[0].leaseTurn;
  const beforeClearTokens = cleared.queue.dailyTokens('2026-10-03');
  const clearHook = await postClaudeSessionStart(cleared.server, 'a1', { hook_event_name: 'SessionStart', source: 'clear', agent_id: 'a1' });
  assert.match(clearHook?.hookSpecificOutput?.additionalContext ?? '', /clear-0 hook reconcile pair/);
  assert.equal(cleared.queue.items('a1')[0].leaseTurn, clearTurn);
  assert.equal(cleared.queue.sequence('a1'), 1);
  const clearRerender = cleared.log.find((row) => row.kind === 'claims-reconcile-rerendered');
  assert.ok(clearRerender?.tokens > 0);
  assert.equal(cleared.queue.dailyTokens('2026-10-03'), beforeClearTokens + clearRerender.tokens);
  await postLiveHook(cleared.server, 'a1', { hook_event_name: 'Stop', agent_id: 'a1' });
  assert.equal(cleared.queue.peek('a1')[0].turnsUnanswered, 1);
});

test('S-a rendered reconcile detection uses final text after the emergency line cut', async () => {
  const x = setup(); let committed;
  const oversized = { itemId: 'conflict:oversized', kind: 'conflict', a: 'a', b: 'b', text: 'x'.repeat(D.WORKING_SET_MAX_CHARS + 100) };
  x.delivery = D.createClaimDelivery({ hiveRoot: () => x.root, level: () => 'writer', readLedger: (a) => x.ref.store.readLedger(a),
    registry: () => DEFAULT_KEY_REGISTRY, derive, worldView, agentCwd: () => x.root, tasks: () => [], usage: () => [],
    countTokens: () => () => 0, git: async () => '', now: () => new Date('2026-10-03T12:00:00.000Z'), appendReceipt: () => {},
    reconcileCandidates: () => [oversized], commitReconcile: (_agent, _day, ids) => { committed = ids; } });
  const text = await x.delivery.workingSet('a1');
  assert.ok(text.length <= D.WORKING_SET_MAX_CHARS);
  assert.equal(text.includes('conflict:oversized'), false, 'the marker was cut off at a line boundary');
  assert.deepEqual(committed, [], 'only the final cut body can be committed as rendered');
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
  // CL-M4-BRIEFING-BUDGET C: still one provider; only Claude's own briefing entry asks for the full ceiling.
  assert.match(idx, /const claimWorkingSetForAgent = \(agentId: string, source\?: string, part\?: 'briefing'\): Promise<string \| null> => \(claimsEndpoint\(\) \? claimDelivery\.workingSet\(agentId, source, part === 'briefing' \? WORKING_SET_MAX_CHARS : undefined\) : Promise\.resolve\(null\)\);/);
  assert.match(idx, /hookServer\.setClaimTurnCompletedListener\(\(agentId\) => claimDelivery\.turnCompleted\(agentId\)\);/);
  const hive = fs.readFileSync(path.join(ROOT, 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(hive, /preset\.systemPromptChannel === 'codex-developer-instructions' \? HiveManager\.codexDeveloperInstructions\(prompt, claimContext\) : null/);
  assert.match(hive, /try \{ claimContext = await this\.codexClaimContext\(meta\.id\); \}/);
});
