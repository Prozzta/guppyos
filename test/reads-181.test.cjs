'use strict';

/**
 * READS-181 (god 350e5f, approved 1faf38): replace token-saving habits with app features.
 *  A. the `ledger` command: card + outbox message + memory note in ONE call, applied in main,
 *     with the body never in shell arguments (MSG-COMPOSE-SHELL-INJECTION);
 *  B. a PostToolUse condenser: a successful Bash/PowerShell result over the cap (1500) is replaced
 *     by its outcome, error lines, head, tail and the full output's path (kept on disk);
 *  C. scripts/reads-measure.cjs: requests and re-reads per agent and day, from the transcripts.
 * Plus the memory reflector keeping an append made while its summary ran.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly, normaliseEol } = require('./read-source.cjs');

const ROOT = path.join(__dirname, '..');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'reads-181-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => {
  for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});
const tmp = (p) => fs.mkdtempSync(path.join(JAIL, p));

const C = loadTs('src/main/toolOutputCondense.ts');
const L = loadTs('src/main/ledger.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

// ── B: the condenser (pure) ─────────────────────────────────────────────────────────────────
function bigOutput() {
  const lines = ['> munder-difflin@1.1.81 test', '> node test/tools/run-tests.cjs', 'starting 3946 tests'];
  for (let i = 0; i < 1200; i += 1) lines.push(`ok ${i} - some passing test number ${i} with a fairly long title to fill space`);
  lines.splice(600, 0, 'Error: ENOENT: no such file or directory, open C:/x/missing.json');
  lines.splice(700, 0, 'warning: deprecated option --foo');
  lines.splice(701, 0, 'warning: deprecated option --foo');
  lines.push('# tests 3946', '# pass 3937', '# fail 0', '# skipped 9');
  return lines.join('\n');
}

test('B: a 100 KB result condenses to the cap with the outcome, deduped error lines, head, tail and the path', () => {
  const text = bigOutput();
  const out = C.condenseOutput({ text, cap: 1500, path: 'C:/hive/agents/a/tool-output/t1.txt' });
  assert.ok(out.length <= 1500, `${out.length} chars`);
  assert.match(out, /^\[condensed by Munder Difflin: the command succeeded; [\d,]+ chars, [\d,]+ lines\]/);
  assert.match(out, /Error: ENOENT: no such file or directory/, 'an error line from the middle survives');
  assert.match(out, /warning: deprecated option --foo ×2/, 'a repeated warning is one line with a count');
  assert.match(out, /# fail 0/, 'the summary tail survives');
  assert.match(out, /> munder-difflin@1\.1\.81 test/, 'the head survives');
  assert.match(out, /\[full output: C:\/hive\/agents\/a\/tool-output\/t1\.txt /, 'the path is the last line');
  assert.ok(out.trimEnd().endsWith('uncondensed.]'));
});

test('B: a tiny cap still keeps the outcome and the path; the interpretation and partial reads are named', () => {
  const out = C.condenseOutput({ text: bigOutput(), cap: 600, path: 'C:/p/t.txt', interpretation: 'No matches found', partial: true, totalChars: 9_000_000 });
  assert.ok(out.length <= 600);
  assert.match(out, /succeeded \(No matches found\); 9,000,000 chars, .* \(read in part\)\]/);
  assert.match(out, /\[full output: C:\/p\/t\.txt/);
});

test('B: shouldCondense: only Bash/PowerShell, over the cap or saved by Claude Code, not #full, not images, not cap 0', () => {
  const big = { stdout: 'x'.repeat(2000), stderr: '' };
  assert.equal(C.shouldCondense('Bash', { command: 'ls' }, big, 1500), true);
  assert.equal(C.shouldCondense('PowerShell', { command: 'dir' }, big, 1500), true);
  assert.equal(C.shouldCondense('Read', { file_path: 'x' }, big, 1500), false, 'Read is not capped (god: Read stays uncapped)');
  assert.equal(C.shouldCondense('Bash', { command: 'git diff #full' }, big, 1500), false, '#full skips the condenser');
  assert.equal(C.shouldCondense('Bash', { command: 'ls' }, { stdout: 'x'.repeat(1500) }, 1500), false, 'within the cap');
  assert.equal(C.shouldCondense('Bash', { command: 'ls' }, { stdout: 'x'.repeat(1400), stderr: 'y'.repeat(200) }, 1500), true, 'stderr counts');
  assert.equal(C.shouldCondense('Bash', { command: 'ls' }, { stdout: 'short', persistedOutputPath: 'C:/x.txt' }, 1500), true, 'saved by Claude Code');
  assert.equal(C.shouldCondense('Bash', { command: 'ls' }, { ...big, isImage: true }, 1500), false);
  assert.equal(C.shouldCondense('Bash', { command: 'ls' }, big, 0), false, 'cap 0 = off');
  assert.equal(C.effectiveCap(undefined), 1500);
  assert.equal(C.effectiveCap(0), 0);
  assert.equal(C.effectiveCap(100), C.TOOL_OUTPUT_CAP_MIN);
  assert.equal(C.effectiveCap(4000), 4000);
});

test('MUTANT B-M1 (no error-line pass): the middle error line is lost', () => {
  const file = 'src/main/toolOutputCondense.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const from = 'const e = errs ? pickErrors(h, t, errs, width) : [];';
  assert.ok(src.includes(from));
  const M = loadTs.fromText(file, src.replace(from, 'const e: string[] = [];'));
  const out = M.condenseOutput({ text: bigOutput(), cap: 1500, path: 'C:/p/t.txt' });
  assert.doesNotMatch(out, /ENOENT/);
});

// ── B: the condenser in the hook server (a real broker over HTTP) ──────────────────────────────
function post(url, body, raw) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = raw ?? Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let out = ''; res.on('data', (d) => { out += d; }); res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

async function broker(t, { provider = 'claude', cap, steer = null, god = false, config = {}, Server = HookServer } = {}) {
  const home = tmp('hive-');
  const logs = [];
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\reads181-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(tmp('s-'), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: (e) => logs.push(e),
    registry: () => ({ agents: { a1: { id: 'a1', provider, ...(cap !== undefined ? { toolOutputCap: cap } : {}) } } }),
    isGod: () => god, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(home, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => { const s = steer; steer = null; return s; }, toolDecision: () => ({ deny: false }) };
  const s = new Server(hive, () => ({ send: () => {} }), () => config, control);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return { s, home, logs, url: s.hookUrl('a1') };
}

const postTool = (url, over = {}) => post(url, {
  hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_01ABC', session_id: 's1',
  tool_input: { command: 'npm test' }, tool_response: { stdout: bigOutput(), stderr: '', interrupted: false, isImage: false }, ...over
});

test('B: a Claude agent\'s large Bash result is replaced in the hook reply; the FULL output is on disk byte for byte', async (t) => {
  const { url, home } = await broker(t);
  const r = await postTool(url);
  assert.equal(r.status, 200);
  const u = r.body.hookSpecificOutput.updatedToolOutput;
  assert.equal(r.body.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(u.stdout.length <= 1500, `${u.stdout.length}`);
  assert.equal(u.stderr, '');
  assert.equal(u.interrupted, false, 'the other fields are kept');
  const saved = path.join(home, 'agents', 'a1', 'tool-output', 'toolu_01ABC.txt');
  assert.equal(fs.readFileSync(saved, 'utf8'), bigOutput(), 'nothing is dropped from disk');
  assert.ok(u.stdout.includes(saved), 'the path the model gets is the saved file');
});

test('B: a result Claude Code already saved is condensed from ITS file (an error past the preview is found), with no copy of ours', async (t) => {
  const { url, home } = await broker(t);
  const ccFile = path.join(tmp('cc-'), 'bj2fuhb8z.txt');
  fs.writeFileSync(ccFile, bigOutput());
  const r = await postTool(url, { tool_response: { stdout: bigOutput().slice(0, 30000), stderr: '', persistedOutputPath: ccFile, persistedOutputSize: bigOutput().length } });
  const u = r.body.hookSpecificOutput.updatedToolOutput;
  assert.match(u.stdout, /# fail 0/, 'the tail comes from the full file, not the 30k preview');
  assert.ok(u.stdout.includes(ccFile));
  assert.equal(fs.existsSync(path.join(home, 'agents', 'a1', 'tool-output')), false);
});

test('B: no replacement for a Codex agent, a #full command, a small result, a failure event, or cap 0', async (t) => {
  const codex = await broker(t, { provider: 'codex' });
  assert.equal((await postTool(codex.url)).body.hookSpecificOutput, undefined);
  const b = await broker(t);
  assert.equal((await postTool(b.url, { tool_input: { command: 'git diff HEAD~1 #full' } })).body.hookSpecificOutput, undefined);
  assert.equal((await postTool(b.url, { tool_response: { stdout: 'ok\n', stderr: '' } })).body.hookSpecificOutput, undefined);
  assert.equal((await postTool(b.url, { hook_event_name: 'PostToolUseFailure', error: bigOutput() })).body.hookSpecificOutput, undefined);
  const off = await broker(t, { cap: 0 });
  assert.equal((await postTool(off.url)).body.hookSpecificOutput, undefined);
});

test('B: the replacement rides in the SAME hookSpecificOutput as injected context', async (t) => {
  const { url } = await broker(t, { steer: 'operator steer: wrap up' });
  const r = await postTool(url);
  assert.match(r.body.hookSpecificOutput.additionalContext, /operator steer/);
  assert.ok(r.body.hookSpecificOutput.updatedToolOutput.stdout.length <= 1500);
});

test('N1 (god): read-type commands (grep, sed, cat, git diff …, last pipeline segment) get the 6000 cap; build/test logs keep 1500', () => {
  for (const c of ['grep -n foo src/x.ts', 'rg -n "a|b" src', 'cd /x && git diff HEAD~1', 'git -C /repo show abc123', 'git --no-pager log -5', 'npm test 2>&1 | tail -40',
    'sed -n 1,80p file.ts', 'cat a.json | jq .tasks', 'FOO=1 head -50 x', 'Get-Content x.log', '/usr/bin/grep x y', 'echo hi; cat x #full']) {
    assert.equal(C.isReadCommand(c), true, c);
    assert.equal(C.capForCommand(c, 1500), 6000, c);
  }
  for (const c of ['npm test', 'node test/tools/run-tests.cjs', 'npm ci', 'grep x f | wc -l', 'git status', 'git commit -m "diff"', 'echo "a | cat"', 'ls -la']) {
    assert.equal(C.isReadCommand(c), false, c);
    assert.equal(C.capForCommand(c, 1500), 1500, c);
  }
  assert.equal(C.capForCommand('grep x y', 0), 0, 'off stays off');
  assert.equal(C.capForCommand('grep x y', 9000), 9000, 'a larger agent cap wins');
});

test('N1 through the hook: a 5000-char grep result passes whole; a 7000-char one is cut to 6000; an npm log is cut to 1500; each condense is logged', async (t) => {
  const { url, logs } = await broker(t);
  const grep5k = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts:${i}: const x = ${'y'.repeat(60)}`).join('\n').slice(0, 5000);
  assert.equal((await postTool(url, { tool_input: { command: 'grep -rn "const x" src' }, tool_response: { stdout: grep5k, stderr: '' } })).body.hookSpecificOutput, undefined);
  const grep7k = Array.from({ length: 90 }, (_, i) => `src/f${i}.ts:${i}: const x = ${'y'.repeat(60)}`).join('\n');
  const g = (await postTool(url, { tool_use_id: 'toolu_g7', tool_input: { command: 'grep -rn "const x" src' }, tool_response: { stdout: grep7k, stderr: '' } })).body.hookSpecificOutput.updatedToolOutput;
  assert.ok(g.stdout.length <= 6000 && g.stdout.length > 1500, `${g.stdout.length}`);
  const lineCount = g.stdout.split('\n').length;
  assert.ok(lineCount >= 50, `the read cap is spent on lines: ${lineCount} lines`);
  const n = (await postTool(url, { tool_use_id: 'toolu_n1' })).body.hookSpecificOutput.updatedToolOutput;
  assert.ok(n.stdout.length <= 1500);
  const rows = logs.filter((e) => e.kind === 'tool-output-condensed');
  assert.deepEqual(rows.map((e) => [e.cap, e.read]), [[6000, true], [1500, false]]);
});

test('N1: a Read or grep of a condensed output\'s saved file within 10 tool calls is logged as a re-fetch, once; later ones are not', async (t) => {
  const { url, logs } = await broker(t);
  await postTool(url, { tool_use_id: 'toolu_r1' });
  await post(url, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/hive/agents/a1/tool-output/toolu_r1.txt', offset: 100 } });
  await post(url, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'C:/hive/agents/a1/tool-output/toolu_r1.txt' } });
  let re = logs.filter((e) => e.kind === 'tool-output-refetch');
  assert.equal(re.length, 1, 'logged once');
  assert.deepEqual([re[0].tool, re[0].after], ['Read', 0]);
  await postTool(url, { tool_use_id: 'toolu_r2' });
  for (let i = 0; i < 11; i++) await post(url, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {}, tool_response: {} });
  await post(url, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'grep ERR C:/x/toolu_r2.txt' } });
  re = logs.filter((e) => e.kind === 'tool-output-refetch');
  assert.equal(re.length, 1, 'past the 10-call window it is not a re-fetch');
});

test('god (d8e742): the orchestrator\'s default cap is 6000 for EVERY command; a registry value still wins; workers keep 1500', async (t) => {
  const mid = Array.from({ length: 50 }, (_, i) => `ok ${i} - a passing test with a long enough title to fill the line`).join('\n'); // ~3.3k chars
  const g = await broker(t, { god: true });
  assert.equal((await postTool(g.url, { tool_response: { stdout: mid, stderr: '' } })).body.hookSpecificOutput, undefined, 'an npm log of 3.3k passes whole for god');
  const big = (await postTool(g.url, { tool_use_id: 'toolu_gb' })).body.hookSpecificOutput.updatedToolOutput;
  assert.ok(big.stdout.length <= 6000 && big.stdout.length > 1500, `${big.stdout.length}`);
  const w = await broker(t);
  assert.ok((await postTool(w.url, { tool_response: { stdout: mid, stderr: '' } })).body.hookSpecificOutput.updatedToolOutput.stdout.length <= 1500, 'a worker keeps 1500');
  const own = await broker(t, { god: true, cap: 2000 });
  assert.ok((await postTool(own.url, { tool_response: { stdout: mid, stderr: '' } })).body.hookSpecificOutput.updatedToolOutput.stdout.length <= 2000, 'god\'s own registry cap wins');
});

test('god + the floor switched off (config toolOutputCap 0): off for god too, never 6000 (Andy\'s pin)', async (t) => {
  const mid = Array.from({ length: 50 }, (_, i) => `ok ${i} - a passing test with a long enough title to fill the line`).join('\n');
  const off = await broker(t, { god: true, config: { toolOutputCap: 0 } });
  assert.equal((await postTool(off.url, { tool_response: { stdout: mid, stderr: '' } })).body.hookSpecificOutput, undefined, 'a 3.3k output passes whole');
  assert.equal((await postTool(off.url)).body.hookSpecificOutput, undefined, 'a 100k output passes untouched: the condenser is off');
});

test('MUTANT G-M1 (drop "&& configured"): god\'s condenser turns ON at 6000 when the floor switched it off', async (t) => {
  const file = 'src/main/hooks.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const from = 'isGod && configured ? Math.max(configured, TOOL_OUTPUT_CAP_READ) : configured';
  assert.ok(src.includes(from));
  const M = loadTs.fromText(file, src.replace(from, 'isGod ? Math.max(configured, TOOL_OUTPUT_CAP_READ) : configured'));
  const off = await broker(t, { god: true, config: { toolOutputCap: 0 }, Server: M.HookServer });
  const u = (await postTool(off.url)).body.hookSpecificOutput;
  assert.ok(u && u.updatedToolOutput.stdout.length <= 6000, 'the mutant condenses although the floor turned it off');
});

test('N2: a saved output over 256 KB is read as head + tail parts (named "read in part"), never whole', async (t) => {
  const { url } = await broker(t);
  const big = path.join(tmp('cc-'), 'big.txt');
  const middle = 'Error: in the middle only\n';
  fs.writeFileSync(big, 'HEAD line\n' + 'x'.repeat(200 * 1024) + '\n' + middle + 'y'.repeat(200 * 1024) + '\nTAIL line\n');
  const u = (await postTool(url, { tool_response: { stdout: 'HEAD line', stderr: '', persistedOutputPath: big, persistedOutputSize: fs.statSync(big).size } })).body.hookSpecificOutput.updatedToolOutput;
  assert.match(u.stdout, /\(read in part\)/);
  assert.match(u.stdout, /TAIL line/);
  assert.doesNotMatch(u.stdout, /in the middle only/, 'the middle is not read (N2 trade-off, named in the outcome line)');
  const H = loadTs('src/main/hooks.ts');
  assert.equal(H.CONDENSE_READ_MAX, 256 * 1024);
});

// ── A: the ledger ───────────────────────────────────────────────────────────────────────────
function ledgerFixture(tasks = [{ id: 'READS-181', title: 'reads', status: 'todo', assignee: 'creed', dependsOn: [], priority: 1, createdAt: 'x' }]) {
  const agentDir = tmp('agent-');
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '# Creed memory\n\n## How I work (standing lessons)\n- lesson one\n\n## 2026-10-01 notes\n- old note\n');
  const state = { tasks: tasks.map((t) => ({ ...t })), adds: 0, patches: 0, failPatch: false };
  const deps = {
    agentId: 'creed', agentDir,
    isRecipient: (to) => ['god', 'broadcast', 'jim'].includes(to),
    readTasks: () => state.tasks.map((t) => ({ ...t })),
    addTask: (t) => { if (state.tasks.some((x) => x.id === t.id)) return false; state.tasks.push(t); state.adds += 1; return true; },
    patchTask: (id, patch) => { if (state.failPatch) throw new Error('disk full'); const i = state.tasks.findIndex((x) => x.id === id); if (i < 0) return false; state.tasks[i] = { ...state.tasks[i], ...patch, id }; state.patches += 1; return true; },
    now: () => new Date('2026-10-03T08:00:00.000Z')
  };
  const outbox = () => { try { return fs.readdirSync(path.join(agentDir, 'outbox')).filter((f) => f.endsWith('.json')); } catch { return []; } };
  const memory = () => fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf8');
  return { deps, state, agentDir, outbox, memory };
}
const BODY = 'Ran `rm -rf /` and $(touch CANARY) and %USERPROFILE% and "quotes" and \'single\' and \\ backslash, ünïcödé ✓';

test('A: one op patches the card (assignee kept), writes one outbox message and appends memory; the reply is one line', () => {
  const f = ledgerFixture();
  const r = L.applyLedgerOp({
    op: 'creed-181-1',
    card: { id: 'READS-181', patch: { status: 'doing' }, appendResult: 'design approved' },
    message: { to: 'god', act: 'inform', subject: 'started', body: BODY, conversation: 'reads-181', in_reply_to: 'm1' },
    memory: { append: '- 2026-10-03 started READS-181' }
  }, f.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.equal(r.body.line, `ok op=creed-181-1 card=READS-181:doing msg=ledger-creed-181-1.json memory=+${Buffer.byteLength('- 2026-10-03 started READS-181')}B`);
  assert.equal(f.state.tasks[0].status, 'doing');
  assert.equal(f.state.tasks[0].assignee, 'creed', 'the assignee is kept');
  assert.equal(f.state.tasks[0].result, '\n[2026-10-03T08:00:00.000Z] design approved');
  const msg = JSON.parse(fs.readFileSync(path.join(f.agentDir, 'outbox', 'ledger-creed-181-1.json'), 'utf8'));
  assert.deepEqual(msg, { to: 'god', act: 'inform', subject: 'started', body: BODY, conversation: 'reads-181', in_reply_to: 'm1' });
  assert.equal(msg.from, undefined, 'from is the router\'s (the folder), never the input\'s');
  assert.ok(f.memory().endsWith('- old note\n- 2026-10-03 started READS-181\n'));
});

test('A: everything is checked BEFORE any write: a duplicate create, a missing card or a bad recipient writes nothing', () => {
  for (const [op, status] of [
    [{ op: 'o1', card: { id: 'READS-181', create: { title: 'dup' } }, message: { to: 'god', act: 'inform', subject: 's', body: 'b' }, memory: { append: 'x' } }, 409],
    [{ op: 'o2', card: { id: 'NOPE-1', patch: { status: 'done' } }, memory: { append: 'x' } }, 404],
    [{ op: 'o3', card: { id: 'READS-181', patch: { status: 'done' } }, message: { to: 'nobody-123', act: 'inform', subject: 's', body: 'b' } }, 400]
  ]) {
    const f = ledgerFixture();
    const mem0 = f.memory();
    const r = L.applyLedgerOp(op, f.deps);
    assert.equal(r.status, status, r.body.line);
    assert.match(r.body.line, /^refused: /);
    assert.equal(f.state.patches + f.state.adds, 0, `${op.op}: no card write`);
    assert.deepEqual(f.outbox(), [], `${op.op}: no message`);
    assert.equal(f.memory(), mem0, `${op.op}: memory untouched`);
  }
});

test('A: shape errors are refused with the field named (unknown keys, no op, create+patch, bad act, a lesson with "## ")', () => {
  const bad = [
    [{ op: 'x', card: { id: 'A' }, extra: 1 }, /unknown field\(s\): extra/],
    [{ card: { id: 'A', patch: { status: 'done' } } }, /^op: required/],
    [{ op: 'has space' }, /^op: required/],
    [{ op: 'x' }, /nothing to do/],
    [{ op: 'x', card: { id: 'A', create: { title: 't' }, patch: { status: 'done' } } }, /create OR patch/],
    [{ op: 'x', card: { id: 'A', patch: { status: 'finished' } } }, /status: one of todo, doing, blocked, done/],
    [{ op: 'x', card: { id: 'A', patch: { result: 'x' } } }, /use appendResult/],
    [{ op: 'x', message: { to: 'god', act: 'reply', subject: 's', body: 'b' } }, /message\.act: one of/],
    [{ op: 'x', message: { to: 'god', act: 'inform', subject: '', body: 'b' } }, /message\.subject: required/],
    [{ op: 'x', memory: { append: '## New section', lesson: true } }, /may not contain a "## " heading/],
    [[1, 2], /one JSON object/]
  ];
  for (const [raw, re] of bad) {
    const p = L.parseLedgerOp(raw);
    assert.equal(p.ok, false, JSON.stringify(raw));
    assert.match(p.error, re);
  }
});

test('A: create makes a new card (status todo by default); a lesson lands at the END of the standing lessons', () => {
  const f = ledgerFixture();
  const r = L.applyLedgerOp({ op: 'c1', card: { id: 'NEW-1', create: { title: 'New card', assignee: 'jim' } }, memory: { append: '- lesson two', lesson: true } }, f.deps);
  assert.equal(r.status, 200, r.body.line);
  const t = f.state.tasks.find((x) => x.id === 'NEW-1');
  assert.deepEqual({ status: t.status, assignee: t.assignee, title: t.title }, { status: 'todo', assignee: 'jim', title: 'New card' });
  assert.equal(f.memory(), '# Creed memory\n\n## How I work (standing lessons)\n- lesson one\n- lesson two\n\n## 2026-10-01 notes\n- old note\n');
  const noSection = ledgerFixture();
  fs.writeFileSync(path.join(noSection.agentDir, 'memory.md'), '# memory\n- a\n');
  assert.equal(L.applyLedgerOp({ op: 'c2', memory: { append: '- x', lesson: true } }, noSection.deps).status, 400);
});

test('A: idempotent by op: a repeat is a no-op, and a retry after a failed part finishes ONLY what is left', () => {
  const f = ledgerFixture();
  const op = { op: 'r1', card: { id: 'READS-181', patch: { status: 'done' }, appendResult: 'built' }, message: { to: 'jim', act: 'request', subject: 'audit', body: 'please' }, memory: { append: '- built' } };
  assert.equal(L.applyLedgerOp(op, f.deps).status, 200);
  const again = L.applyLedgerOp(op, f.deps);
  assert.match(again.body.line, /\(already applied\)$/);
  assert.equal(f.state.patches, 1);
  assert.equal((f.memory().match(/- built/g) || []).length, 1);

  // A failure in the message part: the card is done once; the retry writes the message and memory only.
  const g = ledgerFixture();
  fs.writeFileSync(path.join(g.agentDir, 'outbox'), 'a file where the outbox dir should be');
  const r1 = L.applyLedgerOp(op, g.deps);
  assert.equal(r1.status, 500);
  assert.match(r1.body.line, /^partial: card=READS-181:done; message failed .*Run the same op again/);
  fs.rmSync(path.join(g.agentDir, 'outbox'));
  const r2 = L.applyLedgerOp(op, g.deps);
  assert.equal(r2.status, 200, r2.body.line);
  assert.equal(g.state.patches, 1, 'the card is not patched twice');
  assert.equal((g.state.tasks[0].result.match(/built/g) || []).length, 1, 'the result line is not appended twice');
  assert.deepEqual(g.outbox(), ['ledger-r1.json']);
  assert.equal((g.memory().match(/- built/g) || []).length, 1);
});

test('B1 (Jim): a REUSED op name with DIFFERENT content is refused (409) and writes nothing; the same content stays "(already applied)"', () => {
  const f = ledgerFixture();
  const op = { op: 'done-1', message: { to: 'god', act: 'done', subject: 'first', body: 'one' }, memory: { append: '- first' } };
  assert.equal(L.applyLedgerOp(op, f.deps).status, 200);
  const mem1 = f.memory();
  const other = { op: 'done-1', message: { to: 'god', act: 'done', subject: 'SECOND', body: 'two' }, memory: { append: '- second' } };
  const r = L.applyLedgerOp(other, f.deps);
  assert.equal(r.status, 409);
  assert.equal(r.body.line, 'refused: op done-1 was already used for a different operation; choose a new op name');
  assert.equal(f.memory(), mem1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.agentDir, 'outbox', 'ledger-done-1.json'), 'utf8')).subject, 'first');
  // key order does not matter: the same content is the same op
  const same = { memory: { append: '- first' }, message: { body: 'one', subject: 'first', act: 'done', to: 'god' }, op: 'done-1' };
  assert.match(L.applyLedgerOp(same, f.deps).body.line, /\(already applied\)$/);
});

test('B1: a partial retry with CHANGED content is refused, so an op is never half old and half new', () => {
  const g = ledgerFixture();
  const op = { op: 'p1', card: { id: 'READS-181', patch: { status: 'done' } }, message: { to: 'jim', act: 'request', subject: 'audit', body: 'v1' } };
  fs.writeFileSync(path.join(g.agentDir, 'outbox'), 'blocks the outbox dir');
  assert.equal(L.applyLedgerOp(op, g.deps).status, 500);
  fs.rmSync(path.join(g.agentDir, 'outbox'));
  const changed = { ...op, message: { ...op.message, body: 'v2' } };
  assert.equal(L.applyLedgerOp(changed, g.deps).status, 409);
  assert.deepEqual(g.outbox(), [], 'nothing written by the refused retry');
  assert.equal(L.applyLedgerOp(op, g.deps).status, 200, 'the original content still finishes');
});

test('MUTANT B1-M1 (no content-hash check): a reused name with different content is answered "already applied" and lost', () => {
  const file = 'src/main/ledger.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const from = 'if (rec && rec.hash !== hash) {';
  assert.ok(src.includes(from));
  const M = loadTs.fromText(file, src.replace(from, 'if (false) {'));
  const f = ledgerFixture();
  M.applyLedgerOp({ op: 'x1', memory: { append: '- first' } }, f.deps);
  const r = M.applyLedgerOp({ op: 'x1', memory: { append: '- second' } }, f.deps);
  assert.match(r.body.line, /already applied/);
  assert.equal(f.memory().includes('- second'), false);
});

test('A: the broker route: the URL token names the caller (a wrong token is 403); invalid UTF-8 and bad JSON are refused', async (t) => {
  const { s } = await broker(t);
  const seen = [];
  s.setLedgerHandler((agentId, body) => { seen.push({ agentId, body }); return { status: 200, body: { ok: true, line: 'ok' } }; });
  const url = s.hookUrl('a1').replace('/hook/', '/ledger/');
  assert.equal((await post(url, { op: 'x', memory: { append: 'y' }, from: 'god' })).status, 200);
  assert.equal(seen[0].agentId, 'a1', 'the caller is the URL\'s agent');
  assert.equal((await post(url.replace(/[0-9a-f]{32}$/, '0'.repeat(32)), { op: 'x' })).status, 403);
  const badUtf8 = Buffer.concat([Buffer.from('{"op":"x","memory":{"append":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')]);
  const r = await post(url, null, badUtf8);
  assert.equal(r.status, 400);
  assert.match(r.body.line, /not valid UTF-8/);
  assert.match((await post(url, null, Buffer.from('{nope'))).body.line, /not valid JSON/);
  assert.equal(seen.length, 1, 'refused bodies never reach the handler');
});

test('MUTANT A-M2 (no recipient check before writing): a bad "to" leaves a patched card and a stray message behind', () => {
  const file = 'src/main/ledger.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const from = 'if (op.message && !rec?.message && !deps.isRecipient(op.message.to)) {';
  assert.ok(src.includes(from));
  const M = loadTs.fromText(file, src.replace(from, 'if (false) {'));
  const f = ledgerFixture();
  M.applyLedgerOp({ op: 'm2', card: { id: 'READS-181', patch: { status: 'done' } }, message: { to: 'nobody-123', act: 'inform', subject: 's', body: 'b' } }, f.deps);
  assert.ok(f.state.patches === 1 || f.outbox().length === 1, 'the mutant writes before refusing');
});

test('MUTANT B-M2 (no #full exemption): a #full command is condensed', () => {
  const file = 'src/main/toolOutputCondense.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const from = 'if (FULL_MARKER_RE.test(commandOf(toolInput))) return false;';
  assert.ok(src.includes(from));
  const M = loadTs.fromText(file, src.replace(from, ''));
  assert.equal(M.shouldCondense('Bash', { command: 'git diff #full' }, { stdout: 'x'.repeat(5000) }, 1500), true);
});

// ── A: the CLI end to end (a child process against a real broker) ────────────────────────────
function run(cmd, args, { input, env } = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
    c.stdin.end(input ?? '');
  });
}
const CLI = path.join(ROOT, 'resources', 'ledger-cli.cjs');
// A POSIX bash that shares this filesystem's paths (Git Bash / MSYS on Windows, never WSL's).
const HAS_BASH = (() => {
  try {
    const r = require('node:child_process').spawnSync('bash', ['-c', 'uname -o'], { encoding: 'utf8' });
    return r.status === 0 && (process.platform !== 'win32' || /msys|cygwin/i.test(r.stdout));
  } catch { return false; }
})();

async function cliBroker(t) {
  const { s } = await broker(t);
  const f = ledgerFixture();
  s.setLedgerHandler((agentId, body) => L.applyLedgerOp(body, { ...f.deps, agentId }));
  return { f, env: { HIVE_LEDGER_URL: s.hookUrl('a1').replace('/hook/', '/ledger/') } };
}

test('A (MSG-COMPOSE-SHELL-INJECTION): the CLI refuses inline arguments; a body with backticks and $() sent on stdin arrives byte for byte', async (t) => {
  const { f, env } = await cliBroker(t);
  const inline = await run(process.execPath, [CLI, '{"op":"x"}'], { env });
  assert.equal(inline.code, 2);
  assert.match(inline.err, /only --file <path> or stdin/);
  const op = { op: 'cli-1', message: { to: 'god', act: 'inform', subject: 's', body: BODY } };
  const r = await run(process.execPath, [CLI], { env, input: JSON.stringify(op) });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'ok op=cli-1 msg=ledger-cli-1.json\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.agentDir, 'outbox', 'ledger-cli-1.json'), 'utf8')).body, BODY);
  const viaFile = path.join(f.agentDir, 'op.json');
  fs.writeFileSync(viaFile, JSON.stringify({ op: 'cli-2', memory: { append: '- via file' } }));
  assert.equal((await run(process.execPath, [CLI, '--file', viaFile], { env })).code, 0);
  const refused = await run(process.execPath, [CLI], { env, input: JSON.stringify({ op: 'cli-3', card: { id: 'NOPE', patch: { status: 'done' } } }) });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^ledger: refused: no card NOPE/);
  const unavailable = await run(process.execPath, [CLI], { env: { HIVE_LEDGER_URL: '' }, input: '{"op":"x","memory":{"append":"y"}}' });
  assert.equal(unavailable.code, 3);
});

test('A (MSG-COMPOSE-SHELL-INJECTION): the documented bash form (a quoted heredoc) runs NOTHING in the body', { skip: !HAS_BASH && 'no bash' }, async (t) => {
  const { f, env } = await cliBroker(t);
  const canary = path.join(f.agentDir, 'CANARY').replace(/\\/g, '/');
  const body = `ran \`touch ${canary}\` and $(touch ${canary}) and \${HOME}`;
  const script = `"${process.execPath.replace(/\\/g, '/')}" "${CLI.replace(/\\/g, '/')}" <<'EOF'\n${JSON.stringify({ op: 'bash-1', message: { to: 'god', act: 'inform', subject: 's', body } })}\nEOF\n`;
  const r = await run('bash', ['-c', script], { env });
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.existsSync(canary), false, 'the canary command never ran');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.agentDir, 'outbox', 'ledger-bash-1.json'), 'utf8')).body, body);
});

// ── A: the reflector keeps an append made while its summary ran ─────────────────────────────
const { MemoryReflector } = loadTs('src/main/reflect.ts');
function reflectFixture(onSummary, ReflectorClass = MemoryReflector) {
  const home = tmp('reflect-');
  const agentDir = path.join(home, 'hive', 'agents', 'andy');
  fs.mkdirSync(agentDir, { recursive: true });
  const mem = path.join(agentDir, 'memory.md');
  const recent = [];
  for (let i = 0; i < 40; i++) recent.push(`## day ${i}`, `work item ${i}: ${'detail '.repeat(200)}`, '');
  fs.writeFileSync(mem, ['# Andy memory', '', '## 🗜 Condensed history', 'old', '', '## Recent', ...recent].join('\n'));
  const logs = [];
  let calls = 0;
  const reflector = new ReflectorClass(() => home, () => 'claude', () => ({}),
    () => ({ enabled: true, intervalMs: 60_000, byteTriggerPct: 50, sectionTrigger: 10, recentKeep: 5, minBytes: 1 }),
    (e) => logs.push(e),
    async () => { if (calls++ === 0) onSummary(mem); return { ok: true, structuredOutput: { condensed: 'a much shorter history', hoist: [] } }; });
  return { mem, logs, reflector };
}

test('A: an APPEND made while the summary ran survives the swap; any other change aborts the pass', async () => {
  const f = reflectFixture((mem) => fs.appendFileSync(mem, '\n- 2026-10-03 appended by the ledger mid-summary\n'));
  await f.reflector.reflectNow('andy');
  const after = fs.readFileSync(f.mem, 'utf8');
  assert.ok(after.includes('a much shorter history'), 'it did condense');
  assert.ok(after.includes('- 2026-10-03 appended by the ledger mid-summary'), 'the append is kept');
  const g = reflectFixture((mem) => fs.writeFileSync(mem, '# rewritten by hand\n'));
  const [r] = await g.reflector.reflectNow('andy');
  assert.equal(fs.readFileSync(g.mem, 'utf8'), '# rewritten by hand\n', 'a rewrite is never overwritten');
  assert.ok(g.logs.some((e) => e.kind === 'condense-abort' && e.reason === 'changed-during-condense') || r.reason === 'changed-during-condense', JSON.stringify(r));
});

test('MUTANT A-M1 (swap the rebuilt text, not the re-read): the mid-summary append is lost', async () => {
  const file = 'src/main/reflect.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const from = 'atomicWrite(mem, toWrite);';
  assert.ok(src.includes(from));
  const M = loadTs.fromText(file, src.replace(from, 'atomicWrite(mem, rebuilt);'));
  const f = reflectFixture((mem) => fs.appendFileSync(mem, '\n- appended mid-summary\n'), M.MemoryReflector);
  await f.reflector.reflectNow('andy');
  assert.equal(fs.readFileSync(f.mem, 'utf8').includes('- appended mid-summary'), false);
});

// ── wiring (source) ─────────────────────────────────────────────────────────────────────────
test('wiring: the spawn sets HIVE_LEDGER_URL from this spawn\'s hook URL; dev builds scrub it; main applies ops with source "ledger"; the CLI ships', () => {
  const hive = codeOnly(readSource('src/main/hive.ts'));
  assert.match(hive, /const hookUrl = this\.hookBroker\?\.urlFor\(meta\.id\) \?\? null;[\s\S]{0,300}if \(hookUrl\) env\.HIVE_LEDGER_URL = hookUrl\.replace\('\/hook\/', '\/ledger\/'\);/);
  assert.match(readSource('src/main/devIsolation.ts'), /'HIVE_LEDGER_URL'/);
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /hookServer\.setLedgerHandler\(\(agentId, body\) => \{[\s\S]{0,900}addTask: \(task\) => hive\.addTask\(task, 'ledger'\),\s*patchTask: \(id, patch\) => hive\.patchTask\(id, patch, 'ledger'\)/);
  assert.match(idx, /const ledgerDir = hive\.writeLedgerCommand\(LEDGER_CLI\);\s*if \(ledgerDir\) opts\.pathPrepend = \[\.\.\.\(opts\.pathPrepend \?\? \[\]\), ledgerDir\];/);
  assert.match(readSource('electron-builder.yml'), /- from: resources\/ledger-cli\.cjs\s+to: ledger-cli\.cjs/);
  assert.match(readSource('src/main/hive.ts'), /## The ledger command/);
});

test('writeLedgerCommand: bin/ledger holds only the ledger wrappers; memory\'s are unchanged', () => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = tmp('bin-');
  const h = new HiveManager(() => home);
  const d = h.writeLedgerCommand('C:\\app\\resources\\ledger-cli.cjs');
  assert.equal(d, path.join(home, 'hive', 'bin', 'ledger'));
  assert.deepEqual(fs.readdirSync(d).sort(), process.platform === 'win32' ? ['ledger', 'ledger.cmd'] : ['ledger']);
  if (process.platform === 'win32') {
    assert.equal(fs.readFileSync(path.join(d, 'ledger.cmd'), 'utf8'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "C:\\app\\resources\\ledger-cli.cjs" %*\r\n`);
  }
  h.dispose();
});

// ── C: the measure ──────────────────────────────────────────────────────────────────────────
test('C: reads-measure folds a request\'s rows by requestId, names the agent from its hook URL, and prices a tool result\'s re-reads', async () => {
  const M = require(path.join(ROOT, 'scripts', 'reads-measure.cjs'));
  const dir = tmp('projects-');
  const pdir = path.join(dir, 'C--Dunder');
  fs.mkdirSync(pdir);
  const u = (read, write, out) => ({ cache_read_input_tokens: read, cache_creation_input_tokens: write, input_tokens: 1, output_tokens: out });
  const rows = [
    { type: 'user', message: { content: 'PreCompact [http://127.0.0.1:1/hook/creed-mukyiphw/abc] ok' }, timestamp: '2026-10-02T10:00:00Z' },
    // one request written as two rows (a text block and a tool_use block)
    { type: 'assistant', requestId: 'r1', timestamp: '2026-10-02T10:00:01Z', message: { id: 'm1', usage: u(1000, 100, 5), content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', requestId: 'r1', timestamp: '2026-10-02T10:00:01Z', message: { id: 'm1', usage: u(1000, 100, 9), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(4000) }] } },
    { type: 'assistant', requestId: 'r2', timestamp: '2026-10-02T10:00:02Z', message: { id: 'm2', usage: u(2000, 1000, 3), content: [{ type: 'text', text: 'done' }] } },
    { type: 'assistant', requestId: 'r3', timestamp: '2026-10-02T10:00:03Z', message: { id: 'm3', usage: u(2100, 10, 3), content: [{ type: 'text', text: 'more' }] } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-02T10:00:04Z', compactMetadata: { trigger: 'auto', preTokens: 150000 } },
    { type: 'user', message: { content: 'This session is being continued from a previous conversation. ' + 's'.repeat(3938) } }
  ];
  fs.writeFileSync(path.join(pdir, 's1.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
  fs.writeFileSync(path.join(pdir, 'other.jsonl'), JSON.stringify({ type: 'assistant', requestId: 'z', timestamp: '2026-10-02T10:00:00Z', message: { usage: u(5, 5, 5), content: [] } }));
  const t = await M.readTranscript(path.join(pdir, 's1.jsonl'));
  assert.equal(t.agent, 'creed-mukyiphw');
  assert.equal(t.requests.length, 3, 'two rows of r1 are one request');
  assert.equal(t.requests[0].output, 9, 'the largest output_tokens of the request');
  const [row] = M.aggregate([{ ...t, sub: false, session: 's1' }], { top: 1, caps: [1500], tz: 0 });
  assert.deepEqual([row.agent, row.day, row.requests, row.cacheRead], ['creed-mukyiphw', '2026-10-02', 3, 5100]);
  assert.equal(row.tools.Bash.results, 1);
  assert.equal(row.tools.Bash.reread, 1000 * 2, '4000 chars = 1000 tokens, re-read by the 2 requests after it');
  assert.equal(row.tools.Bash.saved[1500], 625 * 2);
  assert.deepEqual([row.compactions, row.compactCallBE], [1, 15000 + 1000], 'the summary call: 150000 x 0.1 + 4000 chars / 4');
  assert.equal(M.listTranscripts(dir).length, 2);
});
