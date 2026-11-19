'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-NAMED-STALLS-RESIDUAL-108 (god 7e3f47, rulings 3ed50a): the named paths that stalled the main
 * thread for 1 s or more on 1.1.106 and 1.1.107 and were still synchronous on int.
 *
 *   1. statSync:(  (2260 ms, 2026-11-17T21:34Z). The name is whole: at every PreToolUse the heavy-lock
 *      classifier asks its script reader about command words that might be script files, and the
 *      reader answered with statSync + readFileSync on the main thread. A PowerShell command with a
 *      bracket in a quoted string makes it stat `<cwd>/(`. The same reader runs at PostToolUse (a
 *      provisional hold is classified again) and in the lease of a suite runner, and the runner's
 *      test-file lister walks `<cwd>/test` with readdirSync.
 *
 * Each test counts every synchronous fs call under the agent's folder while the path runs (the
 * count must be zero) and holds the answer to the synchronous classifier's. Counts of calls, never
 * milliseconds. HOME and USERPROFILE are jailed first. All paths here are invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lag-named-108-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');

const HJ = loadTs('src/main/heavyJob.ts');
const HK = loadTs('src/main/hooks.ts');

test.after(() => {
  loadTs.closeConfigWatchers?.();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

/** Every synchronous fs function that takes a path first (as test/lag-main-sync-remainder-108.test.cjs). */
const SYNC_FNS = Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function' && !/^(f|close|write|read)Sync$|^(fstat|fsync|fdatasync|ftruncate|futimes|fchmod|fchown|readv|writev)Sync$/.test(k));
const under = (dir, p) => { const s = path.resolve(String(p)).toLowerCase(); const d = path.resolve(dir).toLowerCase(); return s === d || s.startsWith(d + path.sep); };
/** Run fn (sync or async) and return the synchronous fs calls it made on paths under `dir`. */
async function syncCalls(dir, fn) {
  const orig = {};
  const calls = [];
  for (const k of SYNC_FNS) {
    orig[k] = fs[k];
    fs[k] = function (p, ...rest) {
      if ((typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL) && under(dir, p)) calls.push(`${k}:${path.basename(String(p))}`);
      return orig[k].call(this, p, ...rest);
    };
  }
  let result;
  try { result = await fn(); } finally { for (const k of SYNC_FNS) fs[k] = orig[k]; }
  return { calls, result };
}

// ─── the agent's folder ─────────────────────────────────────────────────────────────────────────

const NT = ['npm', 'test'].join(' ');
const RUNNER = ['test', 'tools', 'run-tests.cjs'].join('/');
/** A fresh checkout: 25 `ln-many-*` test files (two in a sub-folder), one `ln-only-one`, the real
 *  runner, a script that runs the suite, a light one, one over the size cap, and a folder. */
function agentDir() {
  const dir = fs.mkdtempSync(path.join(JAIL, 'agent-'));
  fs.mkdirSync(path.join(dir, 'test', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test', 'sub'), { recursive: true });
  for (let i = 0; i < 23; i++) fs.writeFileSync(path.join(dir, 'test', `ln-many-${i}.test.cjs`), '');
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(dir, 'test', 'sub', `ln-many-sub-${i}.test.cjs`), '');
  fs.writeFileSync(path.join(dir, 'test', 'ln-only-one.test.cjs'), '');
  fs.copyFileSync(path.resolve(__dirname, 'tools', 'run-tests.cjs'), path.join(dir, RUNNER));
  fs.writeFileSync(path.join(dir, 'suite.sh'), `#!/bin/bash\n${NT}\n`);
  fs.writeFileSync(path.join(dir, 'light.sh'), '#!/bin/bash\necho hi\ngit log -1\n');
  fs.writeFileSync(path.join(dir, 'outer.sh'), '#!/bin/bash\nbash inner.sh\n');
  fs.writeFileSync(path.join(dir, 'inner.sh'), `#!/bin/bash\n${NT}\n`);
  fs.writeFileSync(path.join(dir, 'big.sh'), `#!/bin/bash\n${'# pad\n'.repeat(HJ.HEAVY_SCRIPT_MAX_BYTES / 6 + 10)}`);
  fs.mkdirSync(path.join(dir, 'tooldir'));
  return dir;
}

/** The bracket command, cut down from the recorded one of 2026-11-16T20:16:41Z (PowerShell tool). */
const BRACKET = '`$d (`';
/** [tool, command, what]: every shape that reaches the reader or the lister. */
const SHAPES = [
  ['Bash', 'bash suite.sh', 'a script that runs the suite'],
  ['Bash', 'bash light.sh', 'a light script'],
  ['Bash', 'bash outer.sh', 'a script that runs a script'],
  ['Bash', 'bash big.sh', 'a script over the size cap'],
  ['Bash', 'bash nothere.sh', 'a script that is not there'],
  ['Bash', './tooldir', 'a folder'],
  ['Bash', `node ${RUNNER} ln-many`, 'the runner with a broad filter'],
  ['Bash', `node ${RUNNER} ln-only-one`, 'the runner with one file'],
  ['Bash', 'cd test && node tools/run-tests.cjs ln-many', 'the runner after a cd'],
  ['PowerShell', BRACKET, 'the bracket of the recorded stall'],
  ['Bash', 'git status', 'nothing to read'],
];

/** A real HookServer on a stub hive, with the lock wired as src/main/index.ts wires it. */
function server(dir, limit = 1) {
  const hive = { sockPath: () => path.join(JAIL, 'never.sock'), codexHomeFor: () => JAIL, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: { a1: { cwd: dir }, b1: { cwd: dir } } }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }), snapshot: () => ({ gatedTools: [] }) };
  const s = new HK.HookServer(hive, () => ({ send: () => {} }), () => ({}), control, undefined);
  const rows = [];
  const lock = new HJ.HeavyJobLock({
    limit: () => limit, setTimer: () => ({}), clearTimer: () => {}, leasePollMs: 1, log: (r) => rows.push(r),
    classifyCtx: (cwd) => HK.HookServer.heavyScriptCtx(cwd),
    ...(typeof HK.HookServer.heavyRead === 'function' ? { classifyRead: (run) => HK.HookServer.heavyRead(run) } : {}),
  });
  s.setHeavyLock(lock);
  const fire = (agent_id, hook_event_name, tool_name, command, id, more = {}) => s.handleWithClaimContext({ agent_id, hook_event_name, session_id: 's', cwd: dir, tool_name, tool_input: more.background ? { command, run_in_background: true } : { command }, tool_use_id: id, transport: 'http', ...more.payload });
  return { s, lock, rows, fire };
}
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const suiteIn = (file) => ({ heavy: true, kind: 'suite', why: `${NT} (in ${file})` });
const sync = (dir, tool, command) => HJ.classifyHeavy(tool, { command }, HK.HookServer.heavyScriptCtx(dir));

// ─── the counter counts ─────────────────────────────────────────────────────────────────────────

test('NON-VACUOUS: the counter sees the synchronous reader and lister, and the bracket really is asked for', async () => {
  const dir = agentDir();
  const a = await syncCalls(dir, () => sync(dir, 'Bash', 'bash suite.sh'));
  assert.ok(a.calls.includes('statSync:suite.sh') && a.calls.includes('readFileSync:suite.sh'), JSON.stringify(a.calls));
  assert.deepEqual(a.result, suiteIn('suite.sh'));
  const b = await syncCalls(dir, () => sync(dir, 'Bash', `node ${RUNNER} ln-many`));
  assert.ok(b.calls.includes('readdirSync:test') && b.calls.includes('readdirSync:sub'), JSON.stringify(b.calls));
  assert.equal(b.result.kind, 'suite', JSON.stringify(b.result));
  const c = await syncCalls(dir, () => sync(dir, 'PowerShell', BRACKET));
  assert.ok(c.calls.includes('statSync:('), `THE STALL'S NAME: ${JSON.stringify(c.calls)}`);
});

// ─── PreToolUse ─────────────────────────────────────────────────────────────────────────────────

test('PreToolUse: no shape of command makes the hook touch the disk synchronously, and each is judged as before', async () => {
  for (const [tool, command, what] of SHAPES) {
    const dir = agentDir();
    const want = sync(dir, tool, command);
    const { fire, lock } = server(dir);
    // b1 holds the only slot, so a heavy call of a1 is denied and a light one is not.
    assert.equal(denied(await fire('b1', 'PreToolUse', 'Bash', 'GUPPY_BENCH=1 node bench.cjs', 'u0')), false, 'b1 takes the slot');
    const { calls, result } = await syncCalls(dir, () => fire('a1', 'PreToolUse', tool, command, 'u1'));
    assert.deepEqual(calls, [], `${what} (${command}): synchronous fs on the main thread`);
    assert.equal(denied(result), want.heavy, `${what} (${command}): judged as the synchronous classifier judges it (${JSON.stringify(want)})`);
    assert.deepEqual(lock.snapshot().map((h) => h.agentId), ['b1']);
  }
});

test('PreToolUse: a degraded Codex hook classifies its rollout hints without synchronous fs', async () => {
  const dir = agentDir();
  const { fire } = server(dir);
  assert.equal(denied(await fire('b1', 'PreToolUse', 'Bash', 'GUPPY_BENCH=1 node bench.cjs', 'u0')), false);
  const { calls, result } = await syncCalls(dir, () => fire('a1', 'PreToolUse', 'exec', '', 'u1', { payload: { tool_input: {}, payload_degraded: true, transport: 'mcp', codex_commands: ['git status', 'bash suite.sh'] } }));
  assert.deepEqual(calls, []);
  assert.equal(denied(result), true, 'the hinted suite script is denied');
});

test('PreToolUse: a hook template\'s own input (hook_tool_input) is what is read ahead', async () => {
  const dir = agentDir();
  const { fire } = server(dir);
  assert.equal(denied(await fire('b1', 'PreToolUse', 'Bash', 'GUPPY_BENCH=1 node bench.cjs', 'u0')), false);
  const { calls, result } = await syncCalls(dir, () => fire('a1', 'PreToolUse', 'exec', 'git status', 'u1', { payload: { transport: 'mcp', hook_tool_input: { command: 'bash suite.sh' } } }));
  assert.deepEqual(calls, []);
  assert.equal(denied(result), true);
});

// ─── PostToolUse ────────────────────────────────────────────────────────────────────────────────

test('PostToolUse: a provisional background hold is classified again without synchronous fs (freed when light, kept when heavy)', async () => {
  for (const [body, kept] of [['echo hi\ngit log -1\n', false], [`${NT}\n`, true]]) {
    const dir = agentDir();
    const { fire, lock, rows } = server(dir);
    const pre = await syncCalls(dir, () => fire('a1', 'PreToolUse', 'Bash', 'bash later.sh', 'j1', { background: true }));
    assert.deepEqual(pre.calls, []);
    assert.equal(lock.snapshot().length, 1, 'held for a script that is not there yet');
    fs.writeFileSync(path.join(dir, 'later.sh'), body);
    const post = await syncCalls(dir, () => fire('a1', 'PostToolUse', 'Bash', 'bash later.sh', 'j1', { background: true }));
    assert.deepEqual(post.calls, [], JSON.stringify(body));
    assert.equal(lock.snapshot().length, kept ? 1 : 0, JSON.stringify(body));
    assert.equal(rows.some((r) => r.action === 'settled-light'), !kept);
  }
});

test('PostToolUse: a call that holds nothing provisional is not read at all', async () => {
  const dir = agentDir();
  const { fire } = server(dir);
  await fire('a1', 'PreToolUse', 'Bash', 'bash light.sh', 'u1');
  const asked = [];
  const orig = { stat: fs.promises.stat, readFile: fs.promises.readFile, readdir: fs.promises.readdir };
  for (const k of Object.keys(orig)) fs.promises[k] = function (p, ...rest) { if (typeof p === 'string' && under(dir, p)) asked.push(`${k}:${path.basename(p)}`); return orig[k].call(this, p, ...rest); };
  let calls;
  try { ({ calls } = await syncCalls(dir, () => fire('a1', 'PostToolUse', 'Bash', 'bash light.sh', 'u1'))); } finally { Object.assign(fs.promises, orig); }
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, [], 'nothing would be classified, so nothing is read');
});

// ─── the lease ──────────────────────────────────────────────────────────────────────────────────

test('LEASE: a suite runner\'s argv is judged in its folder without synchronous fs', async () => {
  const dir = agentDir();
  const { lock } = server(dir);
  const runner = path.join(dir, RUNNER);
  const one = await syncCalls(dir, () => lock.lease('a1', { op: 'acquire', pid: 4241, createdMs: Date.now(), runner: [runner, 'ln-only-one'], cwd: dir }));
  assert.deepEqual(one.calls, []);
  assert.equal(one.result.state, 'light', JSON.stringify(one.result));
  assert.equal(one.result.why, 'a filtered suite runner');
  const many = await syncCalls(dir, () => lock.lease('a1', { op: 'acquire', pid: 4242, createdMs: Date.now(), runner: [runner, 'ln-many'], cwd: dir }));
  assert.deepEqual(many.calls, []);
  assert.notEqual(many.result.state, 'light', `the broad filter is the suite: ${JSON.stringify(many.result)}`);
});

test('WIRING: main gives the lock the read-ahead beside its synchronous context', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  assert.ok(/classifyCtx: \(cwd\) => HookServer\.heavyScriptCtx\(cwd\),\s*classifyRead: \(run\) => HookServer\.heavyRead\(run\),/.test(src), 'src/main/index.ts must pass classifyRead to the heavy lock');
});

// ─── the read-ahead itself ──────────────────────────────────────────────────────────────────────

test('READ-AHEAD: heavyRead answers every shape exactly as the synchronous classifier does, with no synchronous fs', async () => {
  assert.equal(typeof HK.HookServer.heavyRead, 'function', 'HookServer.heavyRead must exist');
  const dir = agentDir();
  for (const [tool, command, what] of SHAPES) {
    const want = sync(dir, tool, command);
    const { calls, result } = await syncCalls(dir, () => HK.HookServer.heavyRead(() => HJ.classifyHeavy(tool, { command }, HK.HookServer.heavyScriptCtx(dir))));
    assert.deepEqual(calls, [], `${what} (${command})`);
    assert.deepEqual(result, want, `${what} (${command})`);
  }
  // Outside a read-ahead the context reads the disk itself, as its direct callers expect.
  assert.deepEqual(sync(dir, 'Bash', 'bash suite.sh'), suiteIn('suite.sh'));
});

test('READ-AHEAD: what was read ahead is gone once the run returns or throws', async () => {
  assert.equal(typeof HK.HookServer.heavyRead, 'function', 'HookServer.heavyRead must exist');
  const dir = agentDir();
  await HK.HookServer.heavyRead(() => sync(dir, 'Bash', 'bash light.sh'));
  await assert.rejects(HK.HookServer.heavyRead(() => { sync(dir, 'Bash', 'bash light.sh'); throw new Error('boom'); }), /boom/);
  // A later synchronous caller sees the file as it is now, not as it was read ahead.
  fs.writeFileSync(path.join(dir, 'light.sh'), `${NT}\n`);
  assert.deepEqual(sync(dir, 'Bash', 'bash light.sh'), suiteIn('light.sh'));
});

test('READ-AHEAD: a file over the size limit is measured, never read', async () => {
  assert.equal(typeof HK.HookServer.heavyRead, 'function', 'HookServer.heavyRead must exist');
  const dir = agentDir();
  const asked = [];
  const orig = { stat: fs.promises.stat, readFile: fs.promises.readFile };
  for (const k of Object.keys(orig)) fs.promises[k] = function (p, ...rest) { if (typeof p === 'string' && under(dir, p)) asked.push(`${k}:${path.basename(p)}`); return orig[k].call(this, p, ...rest); };
  let got;
  try { got = await HK.HookServer.heavyRead(() => sync(dir, 'Bash', 'bash big.sh && bash light.sh')); } finally { Object.assign(fs.promises, orig); }
  assert.deepEqual(got, sync(dir, 'Bash', 'bash big.sh && bash light.sh'));
  assert.ok(asked.includes('stat:big.sh') && asked.includes('readFile:light.sh'), `NON-VACUOUS: both scripts are asked for (${asked.join(', ')})`);
  assert.ok(!asked.includes('readFile:big.sh'), 'the text of a file over HEAVY_SCRIPT_MAX_BYTES must not be read');
});

test('ONE-WAY: an AGY PostToolUse frame that settles a provisional hold is classified without synchronous fs', async () => {
  const dir = agentDir();
  const { s, lock, rows } = server(dir);
  const token = 'ab'.repeat(16);
  s.hookTokens.set('a1', Buffer.from(token, 'hex'));
  const args = { command: 'bash later.sh', run_in_background: true };
  // AGY sends no tool_use_id: the call is known by its command, at PreToolUse and in the frame alike.
  await s.handleWithClaimContext({ agent_id: 'a1', hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: args });
  assert.equal(lock.snapshot().length, 1, 'held for a script that is not there yet');
  fs.writeFileSync(path.join(dir, 'later.sh'), 'echo hi\n');
  const frame = `agy PostToolUse ${token} a1\n${JSON.stringify({ workspacePaths: [dir], toolCall: { name: 'Bash', args } })}`;
  const { calls } = await syncCalls(dir, async () => {
    s.onOneway(frame);
    // The frame has no reply: wait on the settle itself, one timer turn at a time.
    for (let turn = 0; turn < 2000 && !rows.some((r) => r.action === 'settled-light'); turn++) await new Promise((r) => setTimeout(r, 5));
  });
  assert.ok(rows.some((r) => r.action === 'settled-light'), 'the frame reached the lock and settled the hold');
  assert.equal(lock.snapshot().length, 0);
  assert.deepEqual(calls, []);
});

// ─── 2. the mail rebuild ────────────────────────────────────────────────────────────────────────
//
// readdirSync:hive (3 stalls on 1.1.107): the synchronous log tail lists the hive folder for the
// rotated logs and reads them. Its last caller on int but one is the rebuild of a corrupt mail
// ledger (MailLedger.rebuildCorrupt: 50,000 log rows, the inbox and .done), which runs inside
// whichever ledger call touches that agent first: a delivery in the router, a hook.

const { HiveManager } = loadTs('src/main/hive.ts');
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Two copies of one floor whose `andy-1` ledger is corrupt: mail in the inbox and in .done, and a
 *  log that holds what only the log knows (a reply, a surfaced message). */
async function corruptFloors(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'mail-'));
  const twin = `${home}-twin`;
  const first = new HiveManager(() => home, () => true);
  await first.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await first.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  const q = first.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'please' }, 'god-1');
  const old = first.send({ to: 'andy-1', act: 'request', subject: 'Audit', body: 'x' }, 'god-1');
  first.send({ to: 'andy-1', act: 'inform', subject: 'fyi', body: 'no reply owed' }, 'god-1');
  const reply = first.send({ to: 'god-1', act: 'done', subject: 're: Audit', body: 'done', in_reply_to: old.id }, 'andy-1');
  first.mail.flushAll();
  first.dispose();
  await first.drainReads();
  const root = first.root();
  const rel = path.relative(home, root);
  const inbox = path.join(root, 'agents', 'andy-1', 'inbox');
  fs.mkdirSync(path.join(inbox, '.done'), { recursive: true });
  fs.renameSync(path.join(inbox, `${old.id}.json`), path.join(inbox, '.done', `${old.id}.json`));
  assert.match(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8'), new RegExp(reply.id), 'the log holds the reply');
  fs.writeFileSync(path.join(root, 'state', 'mail', 'andy-1.json'), '{"schema":', 'utf8');
  fs.cpSync(home, twin, { recursive: true, preserveTimestamps: true });
  const open = (h) => {
    const hive = new HiveManager(() => h, () => true);
    t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(h, { recursive: true, force: true }); });
    return hive;
  };
  return { a: open(home), b: open(twin), rel, q, old, reply };
}
/** What a rebuild stamps with the clock of its own run. */
const clockless = (doc) => JSON.parse(JSON.stringify(doc, (k, v) => (/At$/.test(k) && typeof v === 'number' ? 0 : v)));
/** The synchronous calls that are the log tail or the rebuild's folder reads. */
// What only the rebuild reads: the hive folder's listing and each log's stat (the log tail), the
// inbox and .done listings, and each message file's stat and text. Not the log append's open of
// log.jsonl (a write) nor a delivery's existsSync of its own message file.
const rebuildReads = (calls) => calls.filter((c) => /^(readdirSync:(hive|inbox|\.done)|(statSync|existsSync|readFileSync):log[\w.-]*\.jsonl|(statSync|readFileSync):(m-[\w-]+\.json|[\w-]+T[\w-]+\.json))$/.test(c));

test('MAIL REBUILD NON-VACUOUS: the synchronous rebuild lists the hive folder and reads the log, and the log decides the answer', async (t) => {
  const { b, reply, old } = await corruptFloors(t);
  const root = b.root();
  const { calls, result } = await syncCalls(root, () => b.mail.ledger('andy-1'));
  assert.ok(calls.includes(`readdirSync:${path.basename(root)}`), `THE STALL'S NAME: ${JSON.stringify(calls)}`);
  assert.ok(calls.includes('readdirSync:.done'), JSON.stringify(calls));
  assert.equal(result.entries[old.id]?.replyId, reply.id, 'only the log knows the reply');
  assert.ok(rebuildReads(calls).length > 0, JSON.stringify(calls));
});

test('MAIL REBUILD: a corrupt ledger warmed ahead is rebuilt with no synchronous read of the log, the inbox or .done, to the synchronous answer', async (t) => {
  const { a, b, reply, old, q } = await corruptFloors(t);
  assert.equal(typeof a.mail.warm, 'function', 'MailLedger.warm');
  const { calls } = await syncCalls(a.root(), () => a.mail.warm(['andy-1', 'god-1', 'nobody-1']));
  assert.deepEqual(rebuildReads(calls), [], JSON.stringify(calls));
  const after = await syncCalls(a.root(), () => a.mail.ledger('andy-1'));
  assert.deepEqual(after.calls.filter((c) => !c.startsWith('existsSync:inbox')), [], 'loaded: the ledger call reads nothing');
  const doc = after.result;
  assert.equal(doc.entries[old.id]?.replyId, reply.id);
  assert.equal(doc.entries[q.id]?.state, 'delivered');
  assert.deepEqual(clockless(doc), clockless(b.mail.ledger('andy-1')), 'the rebuilt ledger is the synchronous one');
  assert.deepEqual(plain(a.mail.integrityIssues()).map((i) => [i.file, i.repaired]), [['state/mail/andy-1.json', true]]);
  const quarantined = fs.readdirSync(path.join(a.root(), 'state', 'mail')).filter((n) => n.startsWith('andy-1.json.corrupt-'));
  assert.equal(quarantined.length, 1, 'quarantined once');
});

test('MAIL REBUILD: the router rebuilds a corrupt ledger off the main thread before it delivers', async (t) => {
  const { a } = await corruptFloors(t);
  const root = a.root();
  const outbox = path.join(root, 'agents', 'god-1', 'outbox');
  fs.mkdirSync(outbox, { recursive: true });
  fs.writeFileSync(path.join(outbox, 'm1.json'), JSON.stringify({ to: 'andy-1', act: 'inform', subject: 'new', body: 'after the corruption' }), 'utf8');
  const { calls, result } = await syncCalls(root, () => a.routeOnce());
  assert.equal(result, 1, 'the message was routed');
  assert.deepEqual(rebuildReads(calls).filter((c) => !/^existsSync:inbox$/.test(c)), [], JSON.stringify(calls));
  const entries = Object.values(a.mail.ledger('andy-1').entries);
  assert.ok(entries.some((e) => e.subject === 'new' || /new/.test(JSON.stringify(e))), 'delivered into the rebuilt ledger');
  assert.equal(plain(a.mail.integrityIssues()).length, 1);
});

test('MAIL REBUILD: a hook warms its agent\'s ledger before it is handled', async () => {
  const dir = agentDir();
  const { s } = server(dir);
  const order = [];
  s.hive.mail = { warm: async (ids) => { await new Promise((r) => setImmediate(r)); order.push(`warm:${ids.join(',')}`); }, pending: () => { order.push('pending'); return []; } };
  const handle = s.handle.bind(s);
  s.handle = (p) => { order.push('handle'); return handle(p); };
  await s.handleWithClaimContext({ agent_id: 'a1', hook_event_name: 'PreToolUse', session_id: 's', cwd: dir, tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 't1', transport: 'http' });
  assert.deepEqual(order.slice(0, 2), ['warm:a1', 'handle'], JSON.stringify(order));
});

test('MAIL REBUILD: starting the router loads every active agent\'s ledger off the main thread, a corrupt one rebuilt', async (t) => {
  const { a, b } = await corruptFloors(t);
  const root = a.root();
  const { calls } = await syncCalls(root, async () => {
    a.startRouter(60_000);
    t.after(() => a.stopRouter());
    for (let turn = 0; a.mail.loadedDoc('andy-1') === null || a.mail.loadedDoc('god-1') === null; turn++) {
      assert.ok(turn < 2000, 'the router never loaded the ledgers');
      await new Promise((r) => setTimeout(r, 5));
    }
  });
  assert.deepEqual(rebuildReads(calls).filter((c) => !/^existsSync:inbox$/.test(c)), [], JSON.stringify(calls));
  assert.deepEqual(clockless(a.mail.loadedDoc('andy-1')), clockless(b.mail.ledger('andy-1')));
  assert.equal(plain(a.mail.integrityIssues()).length, 1);
});

// ─── 3. the release runs ────────────────────────────────────────────────────────────────────
//
// readdirSync:hive, the last caller: the packaged app's stale-requests beat (at arm time, then
// every 60 s) asks HiveManager.releaseRuns, which read state/app-releases.json on the main thread
// at every sweep and, when it was absent, listed the hive folder and read every log file to seed
// it. The same sweep asks every registry agent's mail ledger, a first load when nothing loaded it.

/** The sweep's own synchronous disk work for the release runs (the seed, the file, its write). */
const releaseReads = (calls) => calls.filter((c) => /^(readdirSync:hive|(readFileSync|statSync|existsSync):(log[\w.-]*\.jsonl|app-releases\.json)|(writeFileSync|openSync|renameSync):app-releases\.json[\w.-]*)$/.test(c));
const releasesFile = (hive) => path.join(hive.root(), 'state', 'app-releases.json');

/** A floor whose logs (one rotated) hold packaged and dev starts, with two asks that name releases. */
async function releaseFloor(t, seed) {
  const home = fs.mkdtempSync(path.join(JAIL, 'rel-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  fs.writeFileSync(path.join(hive.root(), 'log.1.jsonl'), `${JSON.stringify({ kind: 'app-start', version: '1.1.79', packaged: true, ts: 500 })}\n`, 'utf8');
  hive.appendLog({ kind: 'app-start', version: '1.1.80', packaged: true, ts: 1000 });
  hive.appendLog({ kind: 'app-start', version: '1.1.80', packaged: true, ts: 2000 });
  hive.appendLog({ kind: 'app-start', version: '1.1.81', packaged: false, ts: 1500 });
  if (seed) { fs.mkdirSync(path.join(hive.root(), 'state'), { recursive: true }); fs.writeFileSync(releasesFile(hive), JSON.stringify({ v: 1, firstRunAt: seed }), 'utf8'); }
  const old = hive.send({ to: 'andy-1', act: 'request', subject: '1.1.82: cut it', body: 'go' }, 'god-1');
  const ran80 = hive.send({ to: 'andy-1', act: 'request', subject: '1.1.80: bug in it', body: 'go' }, 'god-1');
  await new Promise((r) => setTimeout(r, 5));   // the first run below must be later than the asks (ms clock)
  return { hive, old, ran80 };
}
const openAsks = (hive) => hive.mailObligations().flatMap((a) => a.openRequests.map((o) => o.id)).sort();
/** The file as the async write left it: waited for by loop turns, read off the patched functions. */
async function releasesOnDisk(hive, has) {
  for (let turn = 0; ; turn++) {
    let doc = null;
    try { doc = JSON.parse(await fs.promises.readFile(releasesFile(hive), 'utf8')); } catch { /* not written yet */ }
    if (doc && typeof doc.firstRunAt?.[has] === 'number') return doc.firstRunAt;
    assert.ok(turn < 2000, `app-releases.json never got ${has}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('RELEASE RUNS NON-VACUOUS: the synchronous sweep reads the file, lists the hive folder and reads every log', async (t) => {
  const { hive, old } = await releaseFloor(t);
  const { calls, result } = await syncCalls(hive.root(), () => hive.autoCloseStaleObligations('1.1.82'));
  assert.deepEqual(result.map((s) => [s.id, s.reason]), [[old.id, 'auto:release-shipped:1.1.82']]);
  const reads = releaseReads(calls);
  for (const want of ['readFileSync:app-releases.json', 'readdirSync:hive', 'readFileSync:log.1.jsonl', 'readFileSync:log.jsonl']) assert.ok(reads.includes(want), `${want} in ${JSON.stringify(reads)}`);
  assert.ok(reads.some((c) => /^writeFileSync:app-releases\.json/.test(c)), JSON.stringify(reads));
  const first = JSON.parse(fs.readFileSync(releasesFile(hive), 'utf8')).firstRunAt;
  assert.deepEqual([first['1.1.79'], first['1.1.80'], first['1.1.81'], typeof first['1.1.82']], [500, 1000, undefined, 'number']);
});

test('RELEASE RUNS: a load that has landed clears its in-flight mark', async (t) => {
  const { hive } = await releaseFloor(t);
  assert.equal(typeof hive.readReleaseRunsAhead, 'function', 'HiveManager.readReleaseRunsAhead');
  await hive.readReleaseRunsAhead();
  assert.equal(hive.releaseRunsLoading, null, 'else a sweep that found the load in flight re-arms on it for ever');
});

test('RELEASE RUNS: read ahead, the sweep seeds from the logs, closes the shipped ask and writes the file with no synchronous disk work', async (t) => {
  const { hive, old, ran80 } = await releaseFloor(t);
  assert.equal(typeof hive.readReleaseRunsAhead, 'function', 'HiveManager.readReleaseRunsAhead');
  const { calls, result } = await syncCalls(hive.root(), async () => {
    const loaded = hive.readReleaseRunsAhead();
    // A mark still set here makes the waiting sweep re-arm on a settled promise: an endless
    // microtask loop that starves every timer, so no assert or watchdog could report it.
    void loaded.then(() => { if (hive.releaseRunsLoading) { console.error('FAIL: the release-runs load landed with its in-flight mark still set; the sweep would re-arm for ever'); process.exit(1); } });
    const during = hive.autoCloseStaleObligations('1.1.82');   // main's first beat, at arm time
    await loaded;
    return during;
  });
  assert.deepEqual(result, [], 'a sweep that finds the load in flight closes nothing itself');
  assert.deepEqual(releaseReads(calls), [], JSON.stringify(calls));
  assert.deepEqual(openAsks(hive), [ran80.id], 'the sweep ran once the load landed: the 1.1.82 ask is closed, the 1.1.80 ask is not');
  const rows = hive.logTail(500).filter((r) => r && r.kind === 'mail-obligation-closed');
  assert.deepEqual(rows.map((r) => [r.id, r.reason]), [[old.id, 'auto:release-shipped:1.1.82']]);
  const first = await releasesOnDisk(hive, '1.1.82');
  assert.deepEqual([first['1.1.79'], first['1.1.80'], first['1.1.81']], [500, 1000, undefined], 'the seed the synchronous sweep writes');
});

test('RELEASE RUNS: once read ahead, every later sweep answers from memory and a new running version is written off the main thread', async (t) => {
  const { hive, old, ran80 } = await releaseFloor(t, { '1.1.70': 7, '1.1.80': 1000 });
  assert.equal(typeof hive.readReleaseRunsAhead, 'function', 'HiveManager.readReleaseRunsAhead');
  await hive.readReleaseRunsAhead();
  let first;
  const one = await syncCalls(hive.root(), async () => {
    const closed = hive.autoCloseStaleObligations('1.1.82');
    first = await releasesOnDisk(hive, '1.1.82');   // the write lands inside the counted window
    return closed;
  });
  assert.deepEqual(one.result.map((s) => [s.id, s.reason]), [[old.id, 'auto:release-shipped:1.1.82']]);
  assert.deepEqual(releaseReads(one.calls), [], JSON.stringify(one.calls));
  void hive.readReleaseRunsAhead();
  assert.equal(hive.releaseRunsLoading, null, 'a folder already read ahead is not read again');
  assert.deepEqual([first['1.1.70'], first['1.1.79']], [7, undefined], 'a file that is there is never re-seeded from the logs');
  const bug = hive.send({ to: 'andy-1', act: 'request', subject: '1.1.82: bug found while it runs', body: 'go' }, 'god-1');
  const two = await syncCalls(hive.root(), () => hive.autoCloseStaleObligations('1.1.82'));
  assert.deepEqual(two.result, [], 'an ask about the running release stays');
  assert.deepEqual(releaseReads(two.calls), [], JSON.stringify(two.calls));
  assert.deepEqual(openAsks(hive), [bug.id, ran80.id].sort());
  assert.equal((await releasesOnDisk(hive, '1.1.82'))['1.1.82'], first['1.1.82'], 'the first run keeps its time');
  // What was read ahead is one folder's: after a home change the sweep reads the new folder itself.
  hive.releaseRunsMem.root = path.join(JAIL, 'another-hive');
  const moved = await syncCalls(hive.root(), () => hive.autoCloseStaleObligations('1.1.82'));
  assert.ok(releaseReads(moved.calls).includes('readFileSync:app-releases.json'), JSON.stringify(moved.calls));
});

test('RELEASE RUNS: the read-ahead alone writes the seed, off the main thread', async (t) => {
  const { hive } = await releaseFloor(t);
  let first;
  const { calls } = await syncCalls(hive.root(), async () => {
    await hive.readReleaseRunsAhead();
    first = await releasesOnDisk(hive, '1.1.80');
  });
  assert.deepEqual(releaseReads(calls), [], JSON.stringify(calls));
  assert.deepEqual(first, { '1.1.79': 500, '1.1.80': 1000 }, 'no sweep ran: no running version yet');
});

test('RELEASE RUNS: the read-ahead loads every agent\'s mail ledger too, a corrupt one rebuilt off the main thread', async (t) => {
  const { a, b } = await corruptFloors(t);
  assert.equal(typeof a.readReleaseRunsAhead, 'function', 'HiveManager.readReleaseRunsAhead');
  const { calls } = await syncCalls(a.root(), async () => {
    const loaded = a.readReleaseRunsAhead();
    a.autoCloseStaleObligations(null);
    await loaded;
  });
  assert.deepEqual(rebuildReads(calls).filter((c) => !/^existsSync:inbox$/.test(c)), [], JSON.stringify(calls));
  assert.deepEqual(releaseReads(calls), [], JSON.stringify(calls));
  assert.deepEqual(clockless(a.mail.loadedDoc('andy-1')), clockless(b.mail.ledger('andy-1')));
});

test('WIRING: the packaged app reads the release runs ahead before it arms the stale-requests beat', () => {
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(idx, /if \(app\.isPackaged\) void hive\.readReleaseRunsAhead\(\);\s*armAlwaysOnBeats\(\);/);
});

test('RELEASE RUNS: a write that fails is tried again at the next sweep, still off the main thread', async (t) => {
  const { hive } = await releaseFloor(t);
  // A folder in the file's place: it cannot be read (so the logs seed the runs) or renamed onto.
  fs.mkdirSync(releasesFile(hive), { recursive: true });
  fs.writeFileSync(path.join(releasesFile(hive), 'in-the-way'), '', 'utf8');
  await hive.readReleaseRunsAhead();
  for (let turn = 0; !(hive.releaseRunsMem.unsaved && !hive.releaseRunsMem.saving); turn++) {
    assert.ok(turn < 2000, 'the failed write never reported');
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(fs.statSync(releasesFile(hive)).isDirectory(), 'nothing was written');
  fs.rmSync(releasesFile(hive), { recursive: true, force: true });
  const { calls } = await syncCalls(hive.root(), () => hive.autoCloseStaleObligations('1.1.82'));
  assert.deepEqual(releaseReads(calls), [], JSON.stringify(calls));
  const first = await releasesOnDisk(hive, '1.1.82');
  assert.deepEqual([first['1.1.79'], first['1.1.80'], first['1.1.81']], [500, 1000, undefined]);
});

// ─── 4. the breaker beat's coordination times ───────────────────────────────────────────────
//
// statSync:.sent (1.1.106): every 30 s the circuit-breaker beat asked, for each live agent, when
// it last coordinated, and the answer came from three statSync calls on the main thread: the
// agent's outbox, outbox/.sent and memory.md (index.ts lastCoordinationAt). The stats are now one
// asynchronous batch on HiveManager that the beat awaits before it ticks the breaker.

const coordReads = (calls) => calls.filter((c) => /^(statSync|lstatSync|existsSync|readdirSync|openSync):(outbox|\.sent|memory\.md|andy-1|pam-1)$/.test(c));
/** A floor with two agents whose three coordination paths carry set times (seconds). */
async function coordFloor(t, times) {
  const home = fs.mkdtempSync(path.join(JAIL, 'coord-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  for (const id of ['andy-1', 'pam-1']) {
    await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
    const dir = path.join(hive.root(), 'agents', id);
    fs.mkdirSync(path.join(dir, 'outbox', '.sent'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'inbox', '.done'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.md'), 'notes', 'utf8');
    const at = times[id] || {};
    // The inbox and its .done are the harness's and the sender's doing: far newer, never counted.
    for (const [rel, sec] of [['inbox', 9000], [path.join('inbox', '.done'), 9000], [path.join('outbox', '.sent'), at.sent], ['outbox', at.outbox], ['memory.md', at.memory]]) {
      if (sec === undefined) continue;
      if (sec === null) fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
      else fs.utimesSync(path.join(dir, rel), sec, sec);
    }
  }
  return hive;
}

test('COORDINATION NON-VACUOUS: the synchronous stats the beat made are seen by the counter', async (t) => {
  const hive = await coordFloor(t, { 'andy-1': { outbox: 1000, sent: 3000, memory: 2000 } });
  const dir = path.join(hive.root(), 'agents', 'andy-1');
  const { calls, result } = await syncCalls(hive.root(), () => Math.max(...[path.join(dir, 'outbox'), path.join(dir, 'outbox', '.sent'), path.join(dir, 'memory.md')].map((p) => fs.statSync(p).mtimeMs)));
  assert.deepEqual(coordReads(calls), ['statSync:outbox', 'statSync:.sent', 'statSync:memory.md']);
  assert.equal(result, 3_000_000);
});

test('COORDINATION: the newest of outbox, outbox/.sent and memory.md for every agent asked, with no synchronous disk work', async (t) => {
  const hive = await coordFloor(t, { 'andy-1': { outbox: 1000, sent: 3000, memory: 2000 }, 'pam-1': { outbox: 6000, sent: 4000, memory: 5000 } });
  assert.equal(typeof hive.coordinationFileTimes, 'function', 'HiveManager.coordinationFileTimes');
  const { calls, result } = await syncCalls(hive.root(), () => hive.coordinationFileTimes(['andy-1', 'pam-1']));
  assert.deepEqual(coordReads(calls), [], JSON.stringify(calls));
  assert.deepEqual([...result], [['andy-1', 3_000_000], ['pam-1', 6_000_000]], 'the inbox and inbox/.done (9000) are not the agent\'s doing');
});

test('COORDINATION: each of the three paths counts when it is the newest', async (t) => {
  const hive = await coordFloor(t, { 'andy-1': { outbox: 1000, sent: 2000, memory: 7000 }, 'pam-1': { outbox: 1000, sent: 8000, memory: 2000 } });
  assert.equal(typeof hive.coordinationFileTimes, 'function', 'HiveManager.coordinationFileTimes');
  assert.deepEqual([...await hive.coordinationFileTimes(['pam-1', 'andy-1'])], [['pam-1', 8_000_000], ['andy-1', 7_000_000]]);
});

test('COORDINATION: a missing path is skipped, an agent with none of them (or no folder) is 0, and only the agents asked are read', async (t) => {
  const hive = await coordFloor(t, { 'andy-1': { outbox: 1000, sent: null, memory: null }, 'pam-1': { outbox: null, sent: null, memory: null } });
  assert.equal(typeof hive.coordinationFileTimes, 'function', 'HiveManager.coordinationFileTimes');
  const { calls, result } = await syncCalls(hive.root(), () => hive.coordinationFileTimes(['andy-1', 'pam-1', 'nobody-1']));
  assert.deepEqual(coordReads(calls), [], JSON.stringify(calls));
  assert.deepEqual([...result], [['andy-1', 1_000_000], ['pam-1', 0], ['nobody-1', 0]]);
  assert.deepEqual([...await hive.coordinationFileTimes([])], []);
});

test('COORDINATION: after dispose nothing is read and every agent asked is 0', async (t) => {
  const hive = await coordFloor(t, { 'andy-1': { outbox: 1000, sent: 3000, memory: 2000 } });
  assert.equal(typeof hive.coordinationFileTimes, 'function', 'HiveManager.coordinationFileTimes');
  hive.dispose();
  const seen = [];
  const stat = fs.promises.stat;
  fs.promises.stat = function (p, ...rest) { seen.push(String(p)); return stat.call(this, p, ...rest); };
  let result;
  try { result = await hive.coordinationFileTimes(['andy-1']); } finally { fs.promises.stat = stat; }
  assert.deepEqual([...result], [['andy-1', 0]]);
  assert.deepEqual(seen.filter((p) => under(hive.root() || JAIL, p)), [], 'no read starts on a disposed manager');
});

/** The call, or a named failure if it is still waiting after 5 s: an unbounded wait is the defect, not a slow run. */
function bounded(call) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('coordinationFileTimes is still waiting for a stat that never settles')), 5000); });
  return Promise.race([call, late]).finally(() => clearTimeout(timer));
}

test('COORDINATION: a stat that never settles is waited for once, counts as 0, is not asked again while open, and is logged once', async (t) => {
  const hive = await coordFloor(t, { 'andy-1': { outbox: 1000, sent: 3000, memory: 2000 }, 'pam-1': { outbox: 6000, sent: 4000, memory: 5000 } });
  const stuckPath = path.join(hive.root(), 'agents', 'andy-1', 'outbox', '.sent');
  const stat = fs.promises.stat;
  const asked = [];
  let free;
  const held = new Promise((resolve) => { free = resolve; });
  fs.promises.stat = function (p, ...rest) {
    asked.push(String(p));
    return String(p) === stuckPath ? held.then(() => stat.call(this, p, ...rest)) : stat.call(this, p, ...rest);
  };
  const stuckRows = () => hive.logTail(500).filter((r) => r && r.kind === 'coordination-stat-stuck');
  try {
    const one = await bounded(hive.coordinationFileTimes(['andy-1', 'pam-1'], 20));
    assert.deepEqual([...one], [['andy-1', 2_000_000], ['pam-1', 6_000_000]], 'the beat goes on: the open stat is 0, every other path counts');
    assert.deepEqual(stuckRows().map((r) => [r.paths, r.first, r.waitMs]), [[1, 'agents/andy-1/outbox/.sent', 20]]);
    const two = await bounded(hive.coordinationFileTimes(['andy-1', 'pam-1'], 20));
    assert.deepEqual([...two], [['andy-1', 2_000_000], ['pam-1', 6_000_000]]);
    assert.equal(asked.filter((p) => p === stuckPath).length, 1, 'the open stat is reused, not piled up');
    assert.equal(stuckRows().length, 1, 'one row for one stuck spell');
    free();
    await held;
    for (let turn = 0; hive.coordinationStats.size; turn++) {
      assert.ok(turn < 1000, 'the settled stat is dropped');
      await new Promise((resolve) => setImmediate(resolve));
    }
    fs.utimesSync(stuckPath, 9000, 9000);
    const three = await bounded(hive.coordinationFileTimes(['andy-1', 'pam-1'], 20));
    assert.deepEqual([...three], [['andy-1', 9_000_000], ['pam-1', 6_000_000]], 'once it settles the path is read afresh, not answered from the old stat');
    assert.equal(asked.filter((p) => p === stuckPath).length, 2);
    assert.equal(stuckRows().length, 1);
  } finally { free(); fs.promises.stat = stat; }
});

test('COORDINATION: a second stuck spell after a clean beat is logged again', async (t) => {
  const hive = await coordFloor(t, { 'andy-1': { outbox: 1000, sent: 3000, memory: 2000 } });
  const stat = fs.promises.stat;
  let hold = true;
  const frees = [];
  fs.promises.stat = function (p, ...rest) {
    if (!hold || !String(p).endsWith('memory.md')) return stat.call(this, p, ...rest);
    return new Promise((resolve) => { frees.push(resolve); }).then(() => stat.call(this, p, ...rest));
  };
  const stuckRows = () => hive.logTail(500).filter((r) => r && r.kind === 'coordination-stat-stuck');
  try {
    assert.deepEqual([...await bounded(hive.coordinationFileTimes(['andy-1'], 20))], [['andy-1', 3_000_000]]);
    assert.equal(stuckRows().length, 1);
    hold = false;
    frees.splice(0).forEach((f) => f());
    await new Promise((resolve) => setImmediate(resolve));
    await bounded(hive.coordinationFileTimes(['andy-1'], 20));
    assert.equal(stuckRows().length, 1, 'a clean beat writes no row');
    hold = true;
    await bounded(hive.coordinationFileTimes(['andy-1'], 20));
    assert.equal(stuckRows().length, 2, 'a new spell is a new row');
  } finally { hold = false; frees.splice(0).forEach((f) => f()); fs.promises.stat = stat; }
});

test('WIRING: the breaker beat awaits the coordination times, one beat at a time, and stats nothing itself', () => {
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const from = idx.indexOf('function lastCoordinationAt');
  const coord = idx.slice(from, idx.indexOf('hive.setHumanInputSource', from));
  assert.ok(from >= 0 && !/statSync|existsSync|readdirSync/.test(coord), coord);
  assert.match(coord, /Math\.max\(0, mailCoordinationAt\(hive\.mail, agentId\), fileTime\)/);
  const at = idx.indexOf('async function runBreakerBeat');
  assert.ok(at >= 0, 'runBreakerBeat is async');
  const beat = idx.slice(at, idx.indexOf('breaker.tick(inputs, now)', at));
  assert.match(beat, /if \(breakerBeatBusy\) return;\s*breakerBeatBusy = true;/);
  assert.match(beat, /try \{ fileTimes = await hive\.coordinationFileTimes\(\w+\); \} finally \{ breakerBeatBusy = false; \}/);
  assert.match(beat, /const fileTime = fileTimes\.get\(id\);\s*if \(fileTime === undefined\) continue;/);
  assert.match(beat, /now - lastCoordinationAt\(id, fileTime\) < progressWindowMs/);
  assert.ok(!/statSync/.test(beat), 'no stat in the beat');
  assert.match(idx, /void runBreakerBeat\(300_000\)\.catch\(\(e\) => \{ console\.error\('\[breaker beat\]', e\); \}\)/);
});

// ─── 5. source discovery ────────────────────────────────────────────────────────────────────
//
// readdirSync:hive, the third caller: discoverSources (nativeMemory/sources.ts) lists the hive
// folder synchronously. That is right where it runs, in the memory worker (a utility process);
// this pins that the main process cannot reach it. No product change.

/** Every module under src/ that `entry` loads at run time (type-only imports are erased). */
function runtimeImports(entry) {
  const seen = new Set();
  const todo = [path.resolve(__dirname, '..', entry)];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = codeOnly(fs.readFileSync(file, 'utf8'), path.basename(file));
    const specs = [];
    for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?'(\.[^']+)'/gm)) specs.push(m[1]);
    for (const m of src.matchAll(/\b(?:require|import)\(\s*'(\.[^']+)'\s*\)/g)) specs.push(m[1]);
    for (const spec of specs) {
      const base = path.resolve(path.dirname(file), spec);
      const hit = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (hit && /\.tsx?$/.test(hit)) todo.push(hit);
    }
  }
  return [...seen].map((p) => path.relative(path.resolve(__dirname, '..'), p).split(path.sep).join('/'));
}

test('SOURCES: discoverSources is called by the memory worker and its engine only, and the main process loads neither', () => {
  const callers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && /\bdiscoverSources\(/.test(codeOnly(fs.readFileSync(p, 'utf8'), e.name))) callers.push(path.relative(path.resolve(__dirname, '..'), p).split(path.sep).join('/'));
    }
  };
  walk(path.resolve(__dirname, '..', 'src'));
  assert.deepEqual(callers.sort(), ['src/main/nativeMemory/engine.ts', 'src/main/nativeMemory/sources.ts', 'src/main/nativeMemory/worker.ts']);
  const main = runtimeImports('src/main/index.ts');
  assert.ok(main.length > 50 && main.includes('src/main/hive.ts') && main.includes('src/main/nativeMemory/sourcesCache.ts'), `the walk follows main's imports (${main.length})`);
  assert.deepEqual(main.filter((p) => /nativeMemory\/(engine|worker)\.ts$/.test(p)), [], 'the main process loads the engine or the worker');
  const worker = runtimeImports('src/main/nativeMemory/worker.ts');
  assert.ok(worker.includes('src/main/nativeMemory/engine.ts') && worker.includes('src/main/nativeMemory/sources.ts'), 'NON-VACUOUS: the same walk reaches them from the worker');
});
