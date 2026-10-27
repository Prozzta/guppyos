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

test('Jim 99a1d4 fix 3, bfa9cd census: only the session\'s OWN spill (init session id, tool-results, written before the end) is read', () => {
  const projects = path.join(JAIL, 'f3', 'projects');
  const cwd = path.join(JAIL, 'f3', 'run', 'sandbox-S', 'cwd');
  const slug = path.join(projects, A.projectSlug(cwd));
  const put = (rel, mtime) => { const p = path.join(slug, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'spill'); if (mtime) fs.utimesSync(p, mtime / 1000, mtime / 1000); return p; };
  const ended = Date.now() + 60_000;
  const own = put(path.join('sess-own', 'tool-results', 'b1.txt'));
  const other = put(path.join('sess-other', 'tool-results', 'b2.txt'));
  const late = put(path.join('sess-own', 'tool-results', 'late.txt'), ended + 120_000);
  const outside = put(path.join('sess-own', 'notes.txt'));
  const sub = put(path.join('sess-own', 'tool-results', 'sub', 'b3.txt'));
  const look = path.join(projects, `${A.projectSlug(cwd)}-x`, 'sess-own', 'tool-results', 'b4.txt');
  fs.mkdirSync(path.dirname(look), { recursive: true }); fs.writeFileSync(look, 'spill');
  // Same-length forms (census P21): only the prefix check refuses them, not the slice that follows it.
  const otherSame = put(path.join('sess-oth', 'tool-results', 'b5.txt'));
  const slugSame = A.projectSlug(cwd).replace(/.$/, (c) => (c === 'x' ? 'y' : 'x'));
  const lookSame = path.join(projects, slugSame, 'sess-own', 'tool-results', 'b6.txt');
  fs.mkdirSync(path.dirname(lookSame), { recursive: true }); fs.writeFileSync(lookSame, 'spill');
  const spill = { projects, cwd, endedMs: ended };
  const dotdot = `${slug}\\sess-own\\tool-results\\..\\..\\sess-other\\tool-results\\b2.txt`;
  assert.equal(A.ownSpillRead(own, spill, 'sess-own'), true, 'own spill: allowed');
  assert.equal(A.ownSpillRead(own.replace(/\\/g, '/'), spill, 'sess-own'), true, 'either slash form');
  for (const [p, why] of [[other, 'another session id'], [otherSame, 'another session id of the same length'], [lookSame, 'a lookalike folder of the same length'], [late, 'written after the session ended'], [outside, 'outside tool-results'], [sub, 'below tool-results'], [look, 'a lookalike prefix folder'], [dotdot, "'..' into another session"], [path.join(slug, 'sess-own', 'tool-results', 'none.txt'), 'no such file']]) {
    assert.equal(A.ownSpillRead(p, spill, 'sess-own'), false, why);
  }
  assert.equal(A.ownSpillRead(own, null, 'sess-own'), false, 'no spill context');
  assert.equal(A.ownSpillRead(own, spill, null), false, 'no recorded session id');
  // Through the transcript audit: the id is the init event's, never one taken from the path the agent names.
  const tf = path.join(JAIL, 'f3', 't.jsonl');
  const read = (id, file) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] } });
  fs.writeFileSync(tf, [{ type: 'system', subtype: 'init', session_id: 'sess-own', tools: ['Bash', 'Read'] }, read('r1', own), read('r2', other), read('r3', dotdot), read('r4', late)].map((r) => JSON.stringify(r)).join('\n'));
  const t = A.readTranscript(tf, 'X:/jail/hive/agents/a/tool-output', [], null, spill);
  assert.deepEqual(t.leaks.map((l) => l.id), ['r2', 'r3', 'r4']);
  assert.deepEqual(A.readTranscript(tf, 'X:/jail/hive/agents/a/tool-output', []).leaks.map((l) => l.id), ['r1', 'r2', 'r3', 'r4'], 'no spill context: every read outside tool-output is a leak');
  // The permission allows the slug's spill folders only; the audit narrows it to the session.
  const shape = { matcher: '*', events: ['PostToolUse'], timeout: 5 };
  const s = A.settingsFor(shape, 'http://h', 'b.txt', 'X:/t', null, slug);
  assert.ok(s.permissions.allow.includes(`Read(//${slug.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase())}/*/tool-results/**)`));
  assert.equal(A.settingsFor(shape, 'http://h', 'b.txt', 'X:/t', null).permissions.allow.filter((a) => a.includes('tool-results')).length, 0);
  const src = fs.readFileSync(path.join(__dirname, 'claims-90', 'answerer.cjs'), 'utf8');
  assert.match(src, /\{ projects: claudeProjectsDir\(\), cwd: path\.join\(home, 'cwd'\), endedMs: t0 \+ row\.ms \}\);/, 'the item audit passes its own spill context');
});

test('god f884de fix 2: the preflight stops unless the serve child lists the derived ledger and a card get shows a mail index', () => {
  const ok = { code: 0, stdout: 'card X\nmails: 2 (newest first)\n', stderr: '' };
  assert.equal(A.servedStateProblem({ derived: { records: 5 } }, ok), null);
  assert.match(A.servedStateProblem({ jim: { records: 5 } }, ok), /no 'derived' ledger/);
  assert.match(A.servedStateProblem({ derived: { records: 0 } }, ok), /no 'derived' ledger/);
  assert.match(A.servedStateProblem(undefined, ok), /no 'derived' ledger/);
  assert.match(A.servedStateProblem({ derived: { records: 5 } }, null), /no mail index/);
  assert.match(A.servedStateProblem({ derived: { records: 5 } }, { code: 0, stdout: 'mails: no mail index for this card yet (hive/state/mail-cards)\n', stderr: '' }), /card get shows no mail index/);
  assert.match(A.servedStateProblem({ derived: { records: 5 } }, { code: 2, stdout: '', stderr: '' }), /^card get: exit 2/);
  const hive = path.join(JAIL, 'f2', 'hive');
  assert.equal(A.firstIndexedCard(hive), null, 'no state/mail-cards');
  const mc = path.join(hive, 'state', 'mail-cards');
  fs.mkdirSync(mc, { recursive: true });
  fs.writeFileSync(path.join(mc, '_links.jsonl'), `${JSON.stringify({ card: 'NOT-A-CARD-FILE' })}\n`);
  assert.equal(A.firstIndexedCard(hive), null, '_links.jsonl is not a card file');
  fs.writeFileSync(path.join(mc, 'c90-mailcard.jsonl'), `{torn\n${JSON.stringify({ v: 1, id: 'm1', card: 'C90-MAILCARD' })}\n`);
  assert.equal(A.firstIndexedCard(hive), 'C90-MAILCARD');
  const src = fs.readFileSync(path.join(__dirname, 'claims-90', 'answerer.cjs'), 'utf8');
  assert.match(src, /problem: servedStateProblem\(connect\.ledgers, g\) \}\);/, 'the check is a preflight call, so a problem stops the run before any spend');
});

test('god b6624e fix 1: the preflight child builds the served state through the app\'s startup entry points; the runner copies exactly the mail index, the derived ledger and its anchor into every item, re-keyed, and the hashes match', () => {
  const W = path.join(JAIL, 'f1');
  const mk = (rel, text) => { fs.mkdirSync(path.dirname(path.join(W, rel)), { recursive: true }); fs.writeFileSync(path.join(W, rel), text); };
  const heads = (pre) => JSON.stringify({ v: 1, hives: pre });
  // The preflight sandbox after staging.
  mk('a/hive/tasks.json', '[]'); mk('a/hive/agents/jim/memory/claims/2026-10.jsonl', '{"j":1}\n');
  mk('a/ud/claims-heads.json', heads({ pre: { jim: { head: 'h-j', lastId: 'c-j', at: 't' } } }));
  const hiveA = path.join(W, 'a', 'hive'); const udA = path.join(W, 'a', 'ud');
  const baseline = { hive: A.treeShas(hiveA), heads: { jim: { head: 'h-j', lastId: 'c-j', at: 't' } } };
  // What the build writes, and one write that is not the build's.
  mk('a/hive/state/mail-cards/c90-facts.jsonl', '{"card":"C90-FACTS"}\n'); mk('a/hive/state/mail-cards/_links.jsonl', '{"id":"m1"}\n');
  mk('a/hive/agents/derived/memory/claims/2026-09.jsonl', '{"d":1}\n{"d":2}\n'); mk('a/hive/agents/derived/memory/claims/2026-10.jsonl', '{"d":3}\n');
  mk('a/hive/claims-reconcile-queue.json', '{"q":1}');
  mk('a/ud/claims-heads.json', heads({ pre: { jim: { head: 'h-j', lastId: 'c-j', at: 't' }, derived: { head: 'h-d', lastId: 'c-d', at: 't2' } } }));
  const served = A.captureServed(hiveA, udA, baseline, 'pre');
  assert.deepEqual(served.files.map((f) => f.rel), ['agents/derived/memory/claims/2026-09.jsonl', 'agents/derived/memory/claims/2026-10.jsonl', 'state/mail-cards/_links.jsonl', 'state/mail-cards/c90-facts.jsonl']);
  assert.deepEqual(served.other.map((f) => f.path), ['claims-reconcile-queue.json'], 'another write is reported, not served');
  assert.deepEqual(Object.keys(served.anchors), ['derived'], 'only the derived anchor');
  const n = A.servedNumbers(served);
  assert.deepEqual(n.mailCards.map((f) => f.path), ['_links.jsonl', 'c90-facts.jsonl']);
  assert.equal(n.derivedLedger.lines, 3);
  assert.match(n.derivedLedger.sha256, /^[0-9a-f]{64}$/);
  const preSha = A.servedSha(hiveA, served);
  // An item sandbox: freshly staged from the snapshot, another hive id.
  mk('b/hive/tasks.json', '[]'); mk('b/hive/agents/jim/memory/claims/2026-10.jsonl', '{"j":1}\n');
  mk('b/ud/claims-heads.json', heads({ itm: { jim: { head: 'h-j', lastId: 'c-j', at: 't' } } }));
  const hiveB = path.join(W, 'b', 'hive');
  assert.equal(A.applyServed(served, hiveB, path.join(W, 'b', 'ud'), 'itm'), preSha, 'the item serves the preflight\'s bytes');
  const hb = JSON.parse(fs.readFileSync(path.join(W, 'b', 'ud', 'claims-heads.json'), 'utf8'));
  assert.deepEqual(Object.keys(hb.hives), ['itm']);
  assert.deepEqual(hb.hives.itm, { jim: { head: 'h-j', lastId: 'c-j', at: 't' }, derived: { head: 'h-d', lastId: 'c-d', at: 't2' } }, 'the derived anchor re-keyed to the item\'s hive id');
  assert.equal(fs.existsSync(path.join(hiveB, 'claims-reconcile-queue.json')), false);
  fs.appendFileSync(path.join(hiveB, 'state', 'mail-cards', '_links.jsonl'), 'x');
  assert.notEqual(A.servedSha(hiveB, served), preSha, 'a changed served file changes the sha');
  // The derived repo and changelog come from the T_s bundle, not the tree under test.
  const repo = path.join(W, 'repo'); fs.mkdirSync(repo);
  const git = (args) => require('node:child_process').execFileSync('git', ['-c', 'user.name=syn', '-c', 'user.email=syn@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(W, 'no-global-config') } });
  git(['init', '-q', '-b', 'main']);
  // The changelog is the newest version tag's (the gate jail's backfill rule): v1.1.100 beats v1.1.90 by number,
  // a non-version tag and the branch tip are not it, and the bundle carries no HEAD (as the T_s bundle).
  for (const [text, tag] of [['# 1.1.90\n', 'v1.1.90'], ['# 1.1.100\n', 'v1.1.100'], ['# later\n', 'nightly'], ['# tip\n', null]]) {
    fs.writeFileSync(path.join(repo, 'CHANGELOG.md'), text); git(['add', '.']); git(['commit', '-q', '-m', text.trim()]);
    if (tag) git(['tag', tag]);
  }
  const add = path.join(W, 'add'); fs.mkdirSync(add);
  git(['bundle', 'create', '-q', path.join(add, 'repo-at-ts.bundle'), '--branches', '--tags']);
  const home = path.join(W, 'home'); fs.mkdirSync(home);
  const s = A.prepareServed(add, home);
  assert.equal(s.changelogTag, 'v1.1.100');
  assert.equal(fs.readFileSync(s.changelogFile, 'utf8'), '# 1.1.100\n');
  assert.ok(fs.existsSync(path.join(s.repo, 'HEAD')), 'a mirror of the bundle');
  // The child builds through the app's own entry points, in the app's order, and the runner wires it.
  const child = fs.readFileSync(path.join(__dirname, 'claims-90', 'answer-child.cjs'), 'utf8');
  const cu = child.indexOf('const catchUp = startupMailCardCatchUp(hive, { log, now: () => spec.now });');
  const seq = child.indexOf('await startAfterMailCardCatchUp(catchUp, () => derivedLive.start());');
  const list = child.indexOf('// Integrity before any answer');
  assert.ok(cu > 0 && seq > cu && list > seq, 'catch-up, then the derived start once it settled, then the ledger listing');
  assert.match(child, /repo: \(\) => spec\.served\.repo,/);
  assert.match(child, /if \(failed\.length\) \{ emit\(\{ summary: \{ ok: false, reason: `the served-state build failed: /, 'a failed build stops the child');
  const run = fs.readFileSync(path.join(__dirname, 'claims-90', 'answerer.cjs'), 'utf8');
  assert.match(child, /served: \{ catchUp: [\s\S]*if \(spec\.served\.buildOnly\) process\.exit\(0\);/, 'the build-only child stops before it serves');
  assert.match(child, /effectiveLevel\(config\.claimLedger, manifestEntry\(floor\.ledger, agentId, floor\.ledgerDefault\)\)/, 'the child resolves a level as main does (the derived ledger defaults to writer)');
  assert.match(run, /R\.stageSandbox\(path\.resolve\(o\.snapshot\), v\.manifest, home, \['primary-mail'\]\);/, 'the build stage holds the T_s mail');
  assert.match(run, /served: \{ \.\.\.servedIn, buildOnly: true \} \}\)\);/, 'the build child gets the build inputs');
  assert.match(run, /if \(!built\.derivedOn\) return \{ problem: /, 'a build with the derived ledger off stops the run');
  assert.match(run, /served = \{ \.\.\.servedNumbers\(servedState\), sha256: applyServed\(servedState, hive, userData, hiveId\.to\), build: build\.report \};/, 'the preflight serves the items\' copy');
  assert.doesNotMatch(run, /serve, served: servedIn/, 'the serving preflight child builds nothing');
  assert.match(run, /row\.servedSha256 = applyServed\(pre\.servedState, hive, userData, hiveId\.to\);/, 'every item gets the preflight\'s state');
  assert.match(run, /if \(row\.servedSha256 !== pre\.served\.sha256\) throw /);
});

test('god ba807e: the preflight serves its synced index to every item; a failed, dropping or (on an item) embedding sync, or an index that is not whole or not the served one, stops it', () => {
  const ok = (records, embedded, dropped = 0) => ({ sent: true, records, chunks: records, reply: { ok: true, exit: 0, json: { embedded, dropped, statusChanges: 0, roomChanges: 0 } } });
  const timedOut = { sent: true, records: 11639, chunks: 11639, reply: { ok: false, exit: 4, error: 'memory claims-sync timed out after 120000 ms' } };
  const off = { sent: false, why: 'level' };
  // The preflight fills the index: a full embed is fine there, a timeout or a drop is not.
  assert.equal(A.syncProblem([ok(1652, 0), ok(11639, 11639), off], { embedNone: false }), null);
  assert.match(A.syncProblem([ok(1652, 0), timedOut], { embedNone: false }), /^sync 2 \(11639 records\): memory claims-sync timed out/);
  assert.match(A.syncProblem([ok(11639, 11639, 3)], { embedNone: false }), /dropped 3$/);
  assert.match(A.syncProblem(null, { embedNone: false }), /no index sync/);
  // An item is served that index: its sync embeds nothing.
  assert.equal(A.syncProblem([ok(1652, 0), ok(11639, 0), off], { embedNone: true }), null);
  assert.match(A.syncProblem([ok(1652, 0), ok(11639, 40)], { embedNone: true }), /^sync 2 \(11639 records\) embedded 40$/);
  assert.match(A.syncProblem([timedOut], { embedNone: true }), /timed out/);
  // The index served must be whole.
  const d = { perWing: [{ wing: 'claims-derived', chunks: 11639 }, { wing: 'memory', chunks: 900 }], chunks: 12539, vectors: 12539, chunkSha256: 'a'.repeat(64), walBytes: 0 };
  assert.equal(A.indexProblem(d), null);
  assert.match(A.indexProblem(null), /no index/);
  assert.match(A.indexProblem({ error: 'SQLITE_CANTOPEN' }), /could not be read: SQLITE_CANTOPEN/);
  assert.match(A.indexProblem({ ...d, walBytes: 4096 }), /4096 WAL bytes/);
  assert.match(A.indexProblem({ ...d, vectors: 900 }), /900 vectors for 12539 chunks/);
  assert.match(A.indexProblem({ ...d, perWing: [], chunks: 0, vectors: 0 }), /0 vectors for 0 chunks/);
  // Equality is by content: the per-wing counts, the vectors and the chunk sha; not the WAL size read.
  assert.equal(A.indexKey(d), A.indexKey({ ...d, walBytes: 7 }));
  assert.notEqual(A.indexKey(d), A.indexKey({ ...d, chunkSha256: 'b'.repeat(64) }));
  assert.notEqual(A.indexKey(d), A.indexKey({ ...d, perWing: [{ wing: 'claims-derived', chunks: 11638 }, { wing: 'memory', chunks: 901 }] }));
  assert.notEqual(A.indexKey(d), A.indexKey({ ...d, vectors: 12538 }));
  assert.equal(A.indexKey({ error: 'x' }), null);
  assert.deepEqual(A.syncRows([ok(5, 0), timedOut, off]), [
    { records: 5, chunks: 5, ok: true, embedded: 0, dropped: 0 },
    { records: 11639, chunks: 11639, ok: false, embedded: null, dropped: null, error: 'memory claims-sync timed out after 120000 ms' },
    { sent: false, why: 'level' },
  ]);
  // serveIndex writes the bytes under the item's hive id and drops a stale WAL of the staged copy.
  const W = fs.mkdtempSync(path.join(JAIL, 'serve-index-'));
  const ud = path.join(W, 'ud'); fs.mkdirSync(path.join(ud, 'memory'), { recursive: true });
  const p = path.join(ud, 'memory', 'hive-item-v2.sqlite');
  fs.writeFileSync(p, 'staged'); fs.writeFileSync(`${p}-wal`, 'stale'); fs.writeFileSync(`${p}-shm`, 'stale');
  const buf = Buffer.from('synced index bytes');
  const sha = require('node:crypto').createHash('sha256').update(buf).digest('hex');
  assert.equal(A.serveIndex({ buf, sha256: sha }, ud, 'hive-item'), sha);
  assert.deepEqual(fs.readFileSync(p), buf);
  assert.ok(!fs.existsSync(`${p}-wal`) && !fs.existsSync(`${p}-shm`), 'no WAL of the staged copy is left to replay over it');
  // The wiring: the preflight checks and captures the index; every item is served it, checked, and its sync judged.
  const run = fs.readFileSync(path.join(__dirname, 'claims-90', 'answerer.cjs'), 'utf8');
  const child = fs.readFileSync(path.join(__dirname, 'claims-90', 'answer-child.cjs'), 'utf8');
  assert.match(run, /calls\.push\(\{ cmd: 'index sync', problem: syncProblem\(summary\?\.synced, \{ embedNone: false \}\) \?\? indexProblem\(summary\?\.index\) \?\? \(indexBuf \? null : 'no index file'\) \}\);/, 'the preflight fails on the index sync or index');
  assert.match(run, /if \(indexBuf\) servedState\.index = \{ buf: indexBuf, sha256: served\.index\.sha256 \};/);
  assert.match(run, /waitFor\(serve\.connectFile, PREFLIGHT_SYNC_MS\)/, 'the preflight waits out the full first sync');
  assert.match(run, /row\.indexServedSha256 = serveIndex\(pre\.servedState\.index, userData, hiveId\.to\);/, 'every item gets the preflight\'s index');
  assert.match(run, /if \(row\.indexServedSha256 !== pre\.served\.index\.sha256\) throw /);
  assert.match(run, /const syncBad = syncProblem\(row\.serve\.synced, \{ embedNone: true \}\);\r?\n    if \(!row\.invalid && syncBad\) row\.invalid = /, 'an item whose sync embeds or times out is INVALID');
  assert.match(run, /else if \(!row\.invalid && indexKey\(row\.indexAfter\) !== indexKey\(pre\.served\.index\.digest\)\) row\.invalid = /, 'an item whose index is not the served one is INVALID');
  const shut = child.indexOf('    await nativeMemory.shutdown().catch(() => {});\n    // god ba807e');
  const shutCrlf = shut >= 0 ? shut : child.indexOf('    await nativeMemory.shutdown().catch(() => {});\r\n    // god ba807e');
  const dig = child.indexOf('index: indexDigest(nativeMemory.dbFile())');
  assert.ok(shutCrlf > 0 && dig > shutCrlf, 'the serve child reads the index only after its worker shut down');
});

test('god 8c625b: every search is timed at the worker port (deadline, ms, worker wait/run, brief asks) into the serve summary, and an item with a search that exited 4 is INVALID', () => {
  // search4Of counts only the searches that exited 4: another verb's exit 4, or a search's exit 0 or 2, is not one.
  const calls = [
    { cmd: 'search', exit: 4 }, { cmd: 'search', exit: 0 }, { cmd: 'search', exit: 2 },
    { cmd: 'get', exit: 4 }, { cmd: 'history', exit: 4 }, { cmd: 'search', exit: 4 },
  ];
  assert.equal(A.search4Of(calls), 2);
  assert.equal(A.search4Of([{ cmd: 'search', exit: 0 }, { cmd: 'wake-up', exit: 4 }]), 0);
  assert.equal(A.search4Of([]), 0);
  const run = fs.readFileSync(path.join(__dirname, 'claims-90', 'answerer.cjs'), 'utf8');
  const child = fs.readFileSync(path.join(__dirname, 'claims-90', 'answer-child.cjs'), 'utf8');
  // The INVALID chain, the item fields and the run totals.
  assert.match(run, /row\.search4 = search4Of\(memCalls\);/);
  assert.match(run, /else if \(row\.search4\) row\.invalid = `a search exited 4 \(\$\{row\.search4\}\)`;\r?\n    else if \(row\.exit !== 0/, 'a search exit 4 is in the INVALID chain, before the session result');
  assert.match(run, /row\.searches = row\.serve\.searches \?\? null;/);
  assert.match(run, /row\.memLog = row\.serve\.memLog \?\? null;/);
  assert.match(run, /served\.searches = summary\?\.searches \?\? null;/);
  assert.match(run, /search4Calls: rows\.reduce\(\(n, r\) => n \+ \(r\.search4 \?\? 0\), 0\),/);
  assert.match(run, /search4Items: rows\.filter\(\(r\) => r\.search4\)\.length,/);
  // The child: the tap sits on both directions of the worker port, it is passed to the fork, the brief dep is timed,
  // a reply past its deadline counts as main's exit 4, and the summary carries the rows and the memory log.
  assert.match(child, /postMessage: \(msg\) => \{ const m = structuredClone\(msg\); tap\?\.toMain\(m\); setImmediate/);
  assert.match(child, /      tap\?\.toWorker\(m\);\r?\n      setImmediate\(\(\) => \{ for \(const fn of port\.fns\) fn\(\{ data: m \}\); \}\);/);
  assert.match(child, /ort: treeRequire\('onnxruntime-node'\) \}, searchTap\),/, 'the fork gets the tap');
  assert.match(child, /    cardLead: timedCardLead,/, 'the brief asks are timed');
  assert.match(child, /try \{ return claimsDeps\.cardLead\(ask\); \} finally \{ const o = \[\.\.\.openSearch\.values\(\)\]\.pop\(\); if \(o\) o\.row\.briefMs\.push\(/);
  assert.match(child, /budgetMs: typeof m\.deadline === 'number' \? Math\.round\(m\.deadline - Date\.now\(\)\) : null/);
  assert.match(child, /exit: late \? 4 : workerExit, workerExit, late,/, 'a reply past its deadline is main\'s exit 4');
  assert.match(child, /waitMs: m\.timing\?\.waitMs \?\? null, runMs: m\.timing\?\.runMs \?\? null/);
  assert.match(child, /index: indexDigest\(nativeMemory\.dbFile\(\)\), searches, memLog: logRows\.filter\(\(r\) => \/\^native-memory\/\.test\(String\(r\.kind \?\? ''\)\)\) \} \}\);/);
});
