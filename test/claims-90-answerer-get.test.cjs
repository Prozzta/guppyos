'use strict';
/**
 * CLAIMS-90 step 3 runner (Jim 4370f6, god 8c87a7): the answer child's claims deps (claims-90/claims-deps.cjs)
 * answer memory get and memory history byte for byte as main's wiring did before claims/readWiring.ts
 * (the pre-move index.ts bodies, copied below as the oracle), through the real NativeMemoryWiring; writes
 * are refused; claims: () => null is what the preflight and the run guard catch.
 * HOME and USERPROFILE are jailed and asserted before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-c90-answerer-get-'));
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
const L = (rel) => loadTs(path.join(ROOT, rel));
const { ClaimStore } = L('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = L('src/main/claims/keyProvider.ts');
const { verifiedPrefix } = L('src/main/claims/indexSync.ts');
const { derive: deriveClaims } = L('src/main/claims/derive.ts');
const { renderClaimHistory } = L('src/main/claims/views.ts');
const { reconcileQueueForHive } = L('src/main/claims/reconcile.ts');
const { DEFAULT_KEY_REGISTRY, loadRegistry } = L('src/main/claims/registry.ts');
const { formatGet, resolveGet } = L('src/main/claims/get.ts');
const { HiveManager } = L('src/main/hive.ts');
const { NativeMemoryWiring } = L('src/main/nativeMemory/mainWiring.ts');
const { hiveTasksFor, taskStatusFor, claimsDepsFor, UNAVAILABLE_RE } = require('./claims-90/claims-deps.cjs');
const A = require('./claims-90/answerer.cjs');

let fixtures = 0;
async function fixture() {
  const home = path.join(JAIL, `f${++fixtures}`);
  const root = path.join(home, 'hive');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'mail-cards'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'C90-FIX', title: 'a card', status: 'doing', assignee: 'ann' }] }));
  fs.mkdirSync(path.join(root, 'tasks-archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks-archive', '2026-10.jsonl'), `${JSON.stringify({ card: { id: 'C90-OLD', title: 'an archived card', status: 'done', assignee: 'bob' } })}\n`);
  fs.writeFileSync(path.join(root, 'state', 'mail-cards', 'c90-fix.jsonl'), `${JSON.stringify({ id: '2026-10-25T10-00-00-000Z-aaaaaa', from: 'bob', to: 'ann', act: 'inform', subject: 'started', at: '2026-10-25T10:00:00.000Z' })}\n`);
  const ud = `${root}-userdata`;
  let t = Date.parse('2026-10-25T09:00:00Z');
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)), now: () => new Date(t += 1000) });
  STORES.push(store);
  const ok = async (a, d) => { const r = await store.appendRecord(a, d, 'endpoint'); assert.equal(r.ok, true, JSON.stringify(r)); return r.id; };
  const old = await ok('ann', { t: 'claim', kind: 'fact', key: 'card.c90-fix', text: 'C90-FIX build at 1111111' });
  const cur = await ok('ann', { t: 'claim', kind: 'fact', key: 'card.c90-fix', text: 'C90-FIX build at 2222222', supersedes: [old], supersedesReason: { category: 'changed' } });
  await ok('bob', { t: 'claim', kind: 'fact', key: 'card.c90-fix', text: 'C90-FIX build at 3333333' });
  await ok('bob', { t: 'claim', kind: 'fact', key: 'release.port', text: 'the port is 4410' });
  await ok('bob', { t: 'claim', kind: 'fact', key: 'card.c90-old', text: 'C90-OLD shipped at 4444444' });
  const agents = () => ['ann', 'bob'];
  // The app's side: its own HiveManager over the same hive (main's hive.allTasks()).
  const app = new HiveManager(() => home);
  HIVES.push(app);
  assert.equal(app.root(), root);
  const child = hiveTasksFor(L, root);
  HIVES.push(child);
  return { root, store, agents, app, child, ids: { old, cur } };
}
const HIVES = [];
test.after(() => { for (const h of HIVES) h.dispose(); });
const depsOf = (f) => claimsDepsFor(L, { hive: f.root, store: f.store, agents: f.agents, allTasks: f.child.allTasks });

/** The oracle: index.ts's get closure body before the move (65bec666), over the same hive. */
function appGetBefore(f, args) {
  const root = f.root;
  const ledgers = {};
  for (const a of f.agents()) { const prefix = verifiedPrefix(f.store.readLedger(a)); if (prefix) ledgers[a] = prefix.records; }
  let reg; try { reg = loadRegistry(root); } catch { reg = DEFAULT_KEY_REGISTRY; }
  const queue = reconcileQueueForHive(root);
  const reconcileItems = Object.keys(ledgers).flatMap((a) => queue.allItems(a));
  const tasks = (f.app.allTasks().tasks ?? []);
  const mailRows = (card) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(card)) return null;
    try { return fs.readFileSync(path.join(root, 'state', 'mail-cards', `${card}.jsonl`), 'utf8').split('\n'); } catch { return null; }
  };
  const r = resolveGet(args.term, { agent: args.agent ?? null, mail: args.mail, before: args.before ?? null, noMail: args.noMail === true, history: args.history === true }, { ledgers, registry: reg, reconcileItems, tasks, mailRows, ruleConfig: { r4: false } });
  return formatGet(r, { agent: args.agent ?? null, history: args.history === true });
}

/** The oracle: index.ts's claimHistory body before the move. */
function appHistoryBefore(f, agentId, id) {
  let reg; try { reg = loadRegistry(f.root); } catch { reg = DEFAULT_KEY_REGISTRY; }
  for (const owner of [agentId, ...f.agents().filter((a) => a !== agentId)]) {
    const prefix = verifiedPrefix(f.store.readLedger(owner));
    if (!prefix || !prefix.records.some((r) => r.t === 'claim' && r.id === id)) continue;
    const text = renderClaimHistory(prefix.records, deriveClaims(prefix.records, reg, { r4: false }), id);
    if (text) return text;
  }
  return null;
}

function wiring(f, claims) {
  const w = new NativeMemoryWiring({
    hiveRoot: () => f.root, enabled: () => true, userData: path.join(f.root, 'ud'), resourcesDir: path.join(f.root, 'res'), workerEntry: 'w.js',
    fork: () => { throw new Error('no worker in this test'); }, memoryBaseUrl: () => null, writeCommand: () => null, log: () => {},
    vecLoadablePath: () => null, claims,
  });
  w.run = async (body) => ({ ok: false, exit: 2, error: `memory: unsupported command ${body.cmd}` });
  return w;
}

test('the child deps answer get for 3 real terms byte for byte as main did before the move, through NativeMemoryWiring', async () => {
  const f = await fixture();
  const w = wiring(f, () => depsOf(f));
  const terms = [{ term: 'card.c90-fix' }, { term: 'C90-FIX', agent: 'ann' }, { term: f.ids.old }, { term: 'release.port', history: true }, { term: 'C90-OLD' }];
  for (const args of terms) {
    const want = appGetBefore(f, args);
    assert.ok(want.length > 20, `the oracle answers ${args.term}`);
    const r = await w.handleAs('ann', { cmd: 'get', args });
    assert.equal(r.body.exit, 0, JSON.stringify(r.body));
    assert.equal(r.body.text, want, `get ${JSON.stringify(args)}`);
  }
});

test('Jim 0959e3: the child tasks are the app HiveManager.allTasks() (ids, statuses, assignees), the archive included', async () => {
  const f = await fixture();
  const pick = (ts) => ts.map((c) => [c.id, c.status, c.assignee ?? null]);
  assert.deepEqual(pick(f.child.allTasks()), pick(f.app.allTasks().tasks));
  assert.deepEqual(pick(f.child.allTasks()), [['C90-FIX', 'doing', 'ann'], ['C90-OLD', 'done', 'bob']]);
  const w = wiring(f, () => depsOf(f));
  for (const [term, card] of [['C90-FIX', ['doing', 'ann']], ['C90-OLD', ['done', 'bob']]]) {
    const r = await w.handleAs('ann', { cmd: 'get', args: { term } });
    for (const v of card) assert.ok(r.body.text.includes(v), `get ${term} shows ${v}`);
  }
});

test('Jim 8dc581: the child ledger taskStatus reads HiveManager.allTasks() (an archived card has its status)', async () => {
  const f = await fixture();
  const status = taskStatusFor(f.child.allTasks);
  assert.equal(status('C90-FIX'), 'doing');
  assert.equal(status('C90-OLD'), 'done', 'the archived card is found');
  assert.equal(status('C90-NONE'), null);
  assert.equal(f.app.tasks().tasks.some((t) => t.id === 'C90-OLD'), false, 'C90-OLD is in the archive only');
});

test('the child deps answer history as main did before the move; a write verb is refused at level reader', async () => {
  const f = await fixture();
  const w = wiring(f, () => depsOf(f));
  for (const [asker, id] of [['ann', f.ids.cur], ['bob', f.ids.old]]) {
    const r = await w.handleAs(asker, { cmd: 'history', args: { id } });
    assert.equal(r.body.exit, 0, JSON.stringify(r.body));
    assert.equal(r.body.text, appHistoryBefore(f, asker, id));
  }
  const before = f.store.readLedger('ann').records.length;
  const n = await w.handleAs('ann', { cmd: 'note', args: { text: 'a write', kind: 'fact' } });
  assert.notEqual(n.body.exit, 0);
  assert.match(String(n.body.error), /level reader/);
  assert.equal(f.store.readLedger('ann').records.length, before, 'nothing appended');
});

test('claims: () => null (the step 3 runs) answers get and history "unsupported command"; preflight and run guard catch it', async () => {
  const f = await fixture();
  const w = wiring(f, () => null);
  for (const body of [{ cmd: 'get', args: { term: 'card.c90-fix' } }, { cmd: 'history', args: { id: f.ids.cur } }]) {
    const r = await w.handleAs('ann', body);
    assert.notEqual(r.body.exit, 0);
    assert.match(String(r.body.error), UNAVAILABLE_RE);
    assert.equal(A.preflightProblem({ code: 2, stdout: '', stderr: String(r.body.error) }), 'exit 2');
  }
  assert.equal(A.preflightProblem({ code: 0, stdout: 'memory get is not available in this build\n', stderr: '' }), 'the build does not answer it');
  assert.equal(A.preflightProblem({ code: 0, stdout: '', stderr: '' }), 'an empty reply');
  assert.equal(A.preflightProblem({ code: 0, stdout: 'card.c90-fix\n', stderr: '' }), null);
  const g = A.unavailableOf([{ unavailable: true }, { unavailable: false }], [{ result: { text: 'Exit code 2\nmemory: unsupported command get' } }, { result: { text: 'ok' } }, {}]);
  assert.deepEqual(g, { serve: 1, transcript: 1 });
  assert.deepEqual(A.unavailableOf([{ unavailable: false }], [{ result: { text: 'card.c90-fix current' } }]), { serve: 0, transcript: 0 });
});

test('god 3164a1 R5: the session folder name is the cwd with every non-alphanumeric a dash (as the step3-r2 folders)', () => {
  assert.equal(A.projectSlug('C:\\Dunder\\_work\\claims-90\\answerer\\step3-r2\\off-1\\sandbox-Zd6MLo\\cwd'), 'C--Dunder--work-claims-90-answerer-step3-r2-off-1-sandbox-Zd6MLo-cwd');
  assert.equal(A.claudeProjectsDir({}), path.join(JAIL, '.claude', 'projects'), 'the default config dir (the CLI login), here the jailed home');
  assert.equal(A.claudeProjectsDir({ CLAUDE_CONFIG_DIR: 'C:/cfg' }), path.join('C:/cfg', 'projects'));
  assert.ok(A.leftoverPrefixes(path.join(JAIL, 'out')).includes(A.LEFTOVER_PREFIX));
});

test('god 3164a1 R5: the item session folder is copied byte-equal into the run dir, then deleted; nothing else is touched', () => {
  const projects = path.join(JAIL, 'r5', 'projects');
  const out = path.join(JAIL, 'r5', 'run');
  const cwd = path.join(out, 'sandbox-AAA', 'cwd');
  const other = path.join(out, 'sandbox-BBB', 'cwd');
  const mine = path.join(projects, A.projectSlug(cwd));
  fs.mkdirSync(path.join(mine, 's1', 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(mine, 's1', 'tool-results', 'b1.txt'), 'spilled get reply');
  fs.mkdirSync(path.join(projects, 'C--Somebody-else'), { recursive: true });
  const dest = path.join(out, 'items', 'DV1', 'session');
  const r = A.sessionFolderOut(projects, cwd, dest);
  assert.deepEqual(r, { folder: A.projectSlug(cwd), created: true, files: 1, removed: true, problem: null });
  assert.equal(fs.existsSync(mine), false, 'deleted from projects');
  assert.equal(fs.readFileSync(path.join(dest, A.projectSlug(cwd), 's1', 'tool-results', 'b1.txt'), 'utf8'), 'spilled get reply');
  assert.ok(fs.existsSync(path.join(projects, 'C--Somebody-else')), 'another folder is untouched');
  assert.deepEqual(A.sessionFolderOut(projects, other, dest), { folder: A.projectSlug(other), created: false, files: 0, removed: false, problem: null });
  // A leftover of this run (or any answerer folder) is found; other folders are not.
  fs.mkdirSync(path.join(projects, A.projectSlug(other)), { recursive: true });
  fs.mkdirSync(path.join(projects, `${A.LEFTOVER_PREFIX}step3-on-1-sandbox-X-cwd`), { recursive: true });
  assert.deepEqual(A.leftoversIn(projects, A.leftoverPrefixes(out)), [`${A.LEFTOVER_PREFIX}step3-on-1-sandbox-X-cwd`, A.projectSlug(other)].sort());
  assert.deepEqual(A.leftoversIn(path.join(JAIL, 'r5', 'none'), A.leftoverPrefixes(out)), []);
});

test('god 3164a1 R5: a session folder holding a link is never copied or deleted', () => {
  const projects = path.join(JAIL, 'r5l', 'projects');
  const cwd = path.join(JAIL, 'r5l', 'run', 'sandbox-L', 'cwd');
  const mine = path.join(projects, A.projectSlug(cwd));
  const target = path.join(JAIL, 'r5l', 'target');
  fs.mkdirSync(mine, { recursive: true }); fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
  fs.symlinkSync(target, path.join(mine, 'link'), 'junction');
  const r = A.sessionFolderOut(projects, cwd, path.join(JAIL, 'r5l', 'dest'));
  assert.equal(r.problem, 'the session folder holds a link');
  assert.ok(fs.existsSync(path.join(target, 'keep.txt')) && fs.existsSync(mine), 'nothing deleted');
  fs.unlinkSync(path.join(mine, 'link'));
});

test('static: the run guard is in the INVALID chain, the preflight gates the spend, the child serves claimsDeps', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, 'claims-90', f), 'utf8');
  assert.match(src('answerer.cjs'), /else if \(row\.unavailable\.serve \|\| row\.unavailable\.transcript\) row\.invalid = /);
  assert.match(src('answerer.cjs'), /if \(!pre\.ok\) throw new Error\(`preflight failed: /);
  assert.match(src('answerer.cjs'), /\[\['wake-up'\], \['search', p\.key\], \['get', p\.key, '--agent', asker\], \['history', p\.claimId\]\]/, 'every verb an agent is shown');
  assert.match(src('answer-child.cjs'), /\n\s+claims: \(\) => claimsDeps,\r?\n/);
  // Jim 8dc581: the ledger's taskStatus and the delivery's tasks read the same allTasks; no hot-only reader is left.
  assert.match(src('answer-child.cjs'), /\n\s+taskStatus: taskStatusFor\(hiveTasks\.allTasks\),\r?\n/);
  assert.match(src('answer-child.cjs'), /\n\s+tasks: hiveTasks\.allTasks,\r?\n/);
  assert.doesNotMatch(src('answer-child.cjs'), /'tasks\.json'/);
  // god 3164a1 R5: every item and the preflight's claude -p go through the session guard; a leftover stops the run.
  assert.match(src('answerer.cjs'), /\n  \} finally \{\r?\n    const guard = sessionGuard\(home, path\.join\(itemDir, 'session'\), outDir\);\r?\n/);
  assert.match(src('answerer.cjs'), /    if \(guard\.problem\) row\.invalid = /);
  assert.match(src('answerer.cjs'), /    if \(row\.session\?\.problem \|\| row\.leftovers\?\.length\) throw new Error\(/);
  assert.match(src('answerer.cjs'), /    probe = await claudeProbe\(o, home\);\r?\n    const guard = sessionGuard\(home, path\.join\(dir, 'session'\), outDir\);/);
  assert.match(src('answerer.cjs'), /    if \(probe\.problem\) bad\.push\(/);
});
