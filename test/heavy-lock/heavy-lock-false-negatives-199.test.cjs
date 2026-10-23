'use strict';
/**
 * HEAVY-LOCK-FALSE-NEGATIVES (god 13:47Z, P1). At 13:44Z-13:46Z Dwight's Codex ran
 * `node test/tools/run-tests.cjs <needle>` and `npm test -- <needle>` while Jim held the only slot.
 * The Codex PreToolUse path DID classify both (the log carries no bypass): the classifier said
 * light, by Jim MF2's rule that a FILTERED run is light, and the lease agreed ('a filtered suite
 * runner'), so the runner's `node --test` child inherited a light run (lease-inherit held:false).
 * The rule was too coarse: the runner picks every test file whose name contains the needle, so a
 * broad needle is the suite in all but name. Also fixed here (the card's items 1 and 2):
 *   - a Codex tool name (exec_command, write_stdin) says nothing about the shell, so a bash `$true`
 *     was read with PowerShell's value rules and a PowerShell `& $x` with bash's; the call's literal
 *     `shell`, else Codex's default (PowerShell on Windows), now names it;
 *   - a node script that spawns a heavy command line (`execSync('npm test')`) is that command.
 * All paths here are invented; the jail's test files are only names.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HKF = 'src/main/hooks.ts';
const HJ = loadTs(HJF);
const HK = loadTs(HKF);

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-fn-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

/** The agent's folder: a checkout with 25 `FN-Many-*` test files, one `fn-only-one`, and the real runner. */
const AGENT = path.join(JAIL, 'agent');
const MANY = 25;
fs.mkdirSync(path.join(AGENT, 'test', 'tools'), { recursive: true });
fs.mkdirSync(path.join(AGENT, 'test', 'heavy-lock'), { recursive: true });
for (let i = 0; i < MANY - 2; i++) fs.writeFileSync(path.join(AGENT, 'test', `FN-Many-${i}.test.cjs`), '');
for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(AGENT, 'test', 'heavy-lock', `FN-Many-sub-${i}.test.cjs`), '');
fs.writeFileSync(path.join(AGENT, 'test', 'fn-only-one.test.cjs'), '');
fs.writeFileSync(path.join(AGENT, 'test', 'not-a-test.cjs'), '');
const RUNNER = ['test', 'tools', 'run-tests.cjs'].join('/');
fs.copyFileSync(path.resolve(__dirname, '..', 'tools', 'run-tests.cjs'), path.join(AGENT, RUNNER));
const NT = ['npm', 'test'].join(' ');

/** Scripts that spawn things. */
const SP = path.join(JAIL, 'sp');
fs.mkdirSync(SP, { recursive: true });
const SCRIPTS = {
  'h.js': `const { execSync } = require('child_process');\nexecSync('${NT}', { stdio: 'inherit' });\n`,
  'const.js': `const cp = require('child_process');\nconst NT = '${NT}';\ncp.execSync(NT);\n`,
  'arr.js': `const cp = require('child_process');\ncp.spawnSync('npm', ['ci'], { stdio: 'inherit' });\n`,
  'exe.js': `require('child_process').spawn(process.execPath, ['go-bench.cjs'], { cwd: __dirname });\n`,
  'fork.js': `require('child_process').fork('run-tests.cjs');\n`,
  'light.js': `require('child_process').execSync('git status');\n`,
  'computed.js': `const cmd = process.argv[2];\nrequire('child_process').execSync(cmd);\n`,
  'prov.js': `require('child_process').execSync('node nothere.js');\n`,
  'a.js': `require('child_process').execSync('node b.js');\n`,
  'b.js': `require('child_process').execSync('${NT}');\n`,
  // Andy NIT 2: a one-string program with shell:true is a line. NIT 1: a `node --test` list is a line.
  'shell.js': `require('child_process').spawn('${NT}', { shell: true, stdio: 'inherit' });\n`,
  'tlist.js': `require('child_process').spawn(process.execPath, ['--test'], { stdio: 'inherit' });\n`,
  'tmany.js': `require('child_process').spawn(process.execPath, ['--test', ${Array.from({ length: 20 }, (_, i) => `'x-${i}.test.cjs'`).join(', ')}]);\n`,
};
const AGENTP = AGENT.replace(/\\/g, '/');
for (const [n, t] of Object.entries(SCRIPTS)) fs.writeFileSync(path.join(SP, n), t);

const cls = (M, cmd, ctx, toolName = 'Bash') => M.classifyHeavy(toolName, toolName === 'write_stdin' ? { chars: `${cmd}\n` } : toolName === 'Bash' ? { command: cmd } : { cmd }, ctx);
const sure = (g) => g.heavy && !g.provisional;

// ─── KILLERS (named assertions; the census checks each mutant dies at the right one) ─────────

const K = {};

/** A filter that picks SUITE_MANY_FILES files or more is the suite, under every tool name. */
K.needle = async ({ HJ: M, HK: H }) => {
  const ctx = H.HookServer.heavyScriptCtx(AGENT);
  assert.equal(ctx.testFiles().length, MANY + 1, 'the lister finds every *.test.cjs under test/, any depth, and nothing else');
  for (const tn of ['Bash', 'exec_command', 'write_stdin']) {
    const many = cls(M, `node ${RUNNER} fn-many`, ctx, tn);
    assert.equal(sure(many) && many.kind, 'suite', `A BROAD NEEDLE IS THE SUITE (${tn}): ${JSON.stringify(many)}`);
    assert.equal(many.why, `node run-tests.cjs fn-many (matches ${MANY} test files)`);
    assert.equal(cls(M, `node ${RUNNER} only-one`, ctx, tn).heavy, false, `ONE FILE IS LIGHT (${tn})`);
    const npm = cls(M, `${NT} -- fn-many`, ctx, tn);
    assert.equal(sure(npm) && npm.kind, 'suite', `NPM TEST WITH A BROAD NEEDLE IS THE SUITE (${tn}): ${JSON.stringify(npm)}`);
    assert.equal(npm.why, `npm test -- fn-many (matches ${MANY} test files)`);
    assert.equal(cls(M, `${NT} -- only-one`, ctx, tn).heavy, false, `NPM TEST WITH ONE FILE IS LIGHT (${tn})`);
  }
  const run = cls(M, 'npm run test:focused -- many', ctx);
  assert.equal(sure(run) && run.kind, 'suite', `NPM RUN TEST WITH A BROAD NEEDLE IS THE SUITE: ${JSON.stringify(run)}`);
  assert.equal(cls(M, `node ${RUNNER} fn-MANY`, ctx).heavy, true, 'THE NEEDLE IS CASE-INSENSITIVE, AS THE RUNNER MATCHES IT');
  // Two needles are a union: each file counted once.
  assert.equal(cls(M, `node ${RUNNER} fn-many many-1`, ctx).why, `node run-tests.cjs fn-many many-1 (matches ${MANY} test files)`, 'NEEDLES ARE A UNION');
  assert.equal(cls(M, `${NT} -- fn-many many-1`, ctx).why, `npm test -- fn-many many-1 (matches ${MANY} test files)`, 'NPM NEEDLES ARE A UNION');
  // Andy MINOR 1: EVERY argument is a needle, as the runner takes them (process.argv.slice(2), a plain
  // substring): `-` picks every file; a flag that matches nothing is a filter, not "no filter".
  assert.equal(cls(M, `node ${RUNNER} -`, ctx).why, `node run-tests.cjs - (matches ${MANY + 1} test files)`, 'A DASH NEEDLE COUNTS (runner)');
  assert.equal(cls(M, `node ${RUNNER} fn-only-one -`, ctx).why, `node run-tests.cjs fn-only-one - (matches ${MANY + 1} test files)`, 'A DASH NEEDLE COUNTS (runner, after a narrow one)');
  assert.equal(cls(M, `${NT} -- -`, ctx).why, `npm test -- - (matches ${MANY + 1} test files)`, 'A DASH NEEDLE COUNTS (npm)');
  assert.deepEqual(cls(M, `node ${RUNNER} --nothing-named-so`, ctx), { heavy: false }, 'A FLAG THAT MATCHES NOTHING IS A FILTER, NOT "no filter"');
  // The threshold is the suite's own SUITE_MANY_FILES (node --test with that many files is a suite too):
  // 20, pinned as a number (Andy NIT 1: a threshold of 21 survived the symbolic pin).
  const names = (n) => Array.from({ length: n }, (_, i) => `x-${i}.test.cjs`);
  const at = (n) => cls(M, `node ${RUNNER} x-`, { ...ctx, testFiles: () => names(n) });
  assert.equal(at(19).heavy, false, 'THRESHOLD: 19 MATCHES IS LIGHT');
  assert.equal(at(20).heavy, true, 'THRESHOLD: 20 MATCHES IS THE SUITE');
  assert.equal(M.SUITE_MANY_FILES, 20, 'THRESHOLD IS 20');
  // Andy MINOR 2: the runner lists ITS OWN repo (two folders above its file), not the caller's folder:
  // from a folder with no test/ at all, and relative to the caller's folder.
  const away = H.HookServer.heavyScriptCtx(SP);
  assert.equal(away.testFiles(), null, 'the caller\'s folder has no test/ to list');
  const far = cls(M, `node ${AGENTP}/${RUNNER} fn-many`, away);
  assert.equal(sure(far) && far.kind, 'suite', `THE RUNNER LISTS ITS OWN REPO: ${JSON.stringify(far)}`);
  assert.equal(far.why, `node run-tests.cjs fn-many (matches ${MANY} test files)`);
  assert.equal(cls(M, `node ${AGENTP}/${RUNNER} fn-only-one`, away).heavy, false, 'THE RUNNER LISTS ITS OWN REPO: one file is light');
  const rel = cls(M, `node agent/${RUNNER} fn-many`, H.HookServer.heavyScriptCtx(JAIL));
  assert.equal(sure(rel) && rel.kind, 'suite', `A RELATIVE RUNNER PATH LISTS ITS REPO: ${JSON.stringify(rel)}`);
  // npm --prefix <repo> (also -C, --prefix=): that repo's suite; the folder is not the subcommand.
  assert.deepEqual(cls(M, `npm --prefix ${AGENTP} test`, away), { heavy: true, kind: 'suite', why: 'npm test' }, 'THE PREFIX FOLDER IS NOT THE SUBCOMMAND');
  const pre = cls(M, `npm --prefix ${AGENTP} test -- fn-many`, away);
  assert.equal(sure(pre) && pre.kind, 'suite', `NPM --prefix LISTS THAT REPO: ${JSON.stringify(pre)}`);
  assert.equal(cls(M, `npm -C ${AGENTP} run test:focused -- fn-many`, away).heavy, true, 'NPM -C LISTS THAT REPO (run test:focused)');
  assert.equal(cls(M, `npm --prefix=${AGENTP} test -- fn-only-one`, away).heavy, false, 'NPM --prefix= ONE FILE IS LIGHT');
  // Without a lister (a bare classifyCommand), the old rule stands: a filtered run is light.
  const { testFiles: _t, ...bare } = ctx;
  assert.equal(cls(M, `node ${RUNNER} fn-many`, bare).heavy, false, 'NO LISTER: A FILTERED RUN IS LIGHT AS BEFORE');
  assert.equal(cls(M, `node ${RUNNER}`, bare).why, 'node run-tests.cjs (no filter)', 'NO FILTER IS STILL THE SUITE');
};

/** The lease judges a runner's argv in the process's own folder. */
K.lease = async ({ HJ: M, HK: H }) => {
  const lock = new M.HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {}, leasePollMs: 1, classifyCtx: (cwd) => H.HookServer.heavyScriptCtx(cwd) });
  const runner = path.join(AGENT, RUNNER);
  const one = await lock.lease('cx', { op: 'acquire', pid: 4241, createdMs: Date.now(), runner: [runner, 'fn-only-one'], cwd: AGENT });
  assert.equal(one.state, 'light', `one file: ${JSON.stringify(one)}`);
  assert.equal(one.why, 'a filtered suite runner');
  const many = await lock.lease('cx', { op: 'acquire', pid: 4242, createdMs: Date.now(), runner: [runner, 'fn-many'], cwd: AGENT });
  assert.notEqual(many.state, 'light', `THE LEASE COUNTS THE NEEDLE: ${JSON.stringify(many)}`);
  // Andy MINOR 2: the preload's argv[1] is the runner's own path; its repo is listed, not process.cwd().
  const away = await lock.lease('cx', { op: 'acquire', pid: 4243, createdMs: Date.now(), runner: [runner, 'fn-many'], cwd: SP });
  assert.notEqual(away.state, 'light', `THE LEASE LISTS THE RUNNER'S OWN REPO: ${JSON.stringify(away)}`);
};

/** A node script that spawns a heavy command line is that command. */
K.spawn = async ({ HJ: M, HK: H }) => {
  const ctx = H.HookServer.heavyScriptCtx(SP);
  const at = (cmd) => cls(M, cmd, ctx);
  assert.equal(at('node h.js').why, `node h.js (spawns ${NT})`, `A SCRIPT SPAWNS NPM TEST: ${JSON.stringify(at('node h.js'))}`);
  assert.equal(sure(at('node h.js')), true, 'A SCRIPT SPAWNS NPM TEST: SURE');
  assert.equal(at('node const.js').why, `node const.js (spawns ${NT})`, 'A CONST COMMAND LINE IS READ');
  assert.equal(at('node arr.js').why, 'node arr.js (spawns npm ci)', 'A PROGRAM PLUS ARRAY IS A LINE');
  assert.equal(at('node exe.js').why, 'node exe.js (spawns node go-bench.cjs)', 'PROCESS.EXECPATH IS NODE');
  assert.equal(at('node fork.js').why, 'node fork.js (spawns node run-tests.cjs (no filter))', 'A FORKED MODULE IS THE SCRIPT IT NAMES');
  assert.equal(at('node shell.js').why, `node shell.js (spawns ${NT})`, 'A ONE-STRING PROGRAM WITH shell:true IS A LINE');
  assert.equal(at('node tlist.js').why, 'node tlist.js (spawns node --test (all))', 'A SPAWNED node --test LIST IS A LINE');
  assert.equal(at('node tmany.js').why, 'node tmany.js (spawns node --test (20 files))', 'A SPAWNED node --test LIST IS A LINE (20 files)');
  assert.equal(at(`node -e "require('child_process').execSync('${NT}')"`).why, `node -e (spawns ${NT})`, 'INLINE CODE SPAWNS NPM TEST');
  assert.deepEqual(at('node light.js'), { heavy: false }, 'A LIGHT SPAWN STAYS LIGHT');
  assert.deepEqual(at('node computed.js'), { heavy: false }, 'A COMPUTED SPAWN IS NOT GUESSED');
  assert.deepEqual(at('node prov.js'), { heavy: false }, 'A PROVISIONAL SPAWN IS NOT COUNTED (a path the lock cannot read is not a bench)');
  assert.deepEqual(at('node a.js'), { heavy: false }, "A SPAWNED SCRIPT'S OWN SPAWNS ARE NOT FOLLOWED (one hop)");
  assert.equal(at('node b.js').heavy, true, 'b.js itself spawns npm test');
};

/** Which shell a Codex call's text runs in. */
K.shell = async ({ HJ: M }) => {
  assert.equal(M.codexDefaultShell('win32'), 'powershell', 'DEFAULT SHELL ON WINDOWS IS POWERSHELL');
  assert.equal(M.codexDefaultShell('linux'), 'bash');
  assert.equal(M.codexDefaultShell('darwin'), 'bash');
  assert.equal(M.codexShellKind(null, 'win32'), 'powershell', 'NO SHELL GIVEN IS THE DEFAULT');
  assert.equal(M.codexShellKind(null, 'linux'), 'bash', 'NO SHELL GIVEN IS THE DEFAULT');
  assert.equal(M.codexShellKind('bash', 'win32'), 'bash', 'A LITERAL BASH');
  assert.equal(M.codexShellKind('/usr/bin/zsh', 'win32'), 'bash', 'A SHELL PATH ENDING IN ZSH IS BASH-LIKE');
  assert.equal(M.codexShellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'linux'), 'bash', 'A WINDOWS PATH TO BASH.EXE');
  assert.equal(M.codexShellKind('pwsh', 'linux'), 'powershell', 'PWSH IS POWERSHELL');
  assert.equal(M.codexShellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32'), 'powershell');
  assert.equal(M.codexShellKind('cmd.exe', 'win32'), undefined, 'CMD IS NEITHER (hook_cmd_shell covers it)');
  assert.equal(M.codexShellKind(undefined, 'win32'), undefined, 'NOT FOUND OR COMPUTED STAYS UNKNOWN');
  assert.equal(M.codexShellKind('C:/x/fish', 'win32'), undefined);
  // The context's shell wins over a tool name's (a Codex hook with a template names the tool Bash).
  assert.deepEqual(M.classifyHeavy('Bash', { command: '$true' }, { shell: 'powershell' }), { heavy: false }, 'CTX SHELL WINS OVER THE TOOL NAME');
  assert.equal(M.classifyHeavy('Bash', { command: '$true' }, {}).heavy, true, 'the Bash tool reads $true as a path');
};

// ─── MCP E2E: a real HookServer, Codex agent cx, Claude agent b1 holding the only slot ─────────

const THREAD = '01a0a169-b0e4-71f0-970a-4a8033ccaa99';
const TURN = '01a0a169-b0e4-71f0-970a-4a8033cc0099';
const turn = JSON.stringify({ timestamp: 't', type: 'turn_context', payload: { turn_id: TURN, cwd: AGENT } });
const code = (input) => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input } });
const fcall = (name, args) => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name, arguments: JSON.stringify(args) } });
/** Codex's exec program: bare keys, one nested exec_command. */
const EX = (cmd, extra = '') => `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}${extra},yield_time_ms:30000}); text(r.output ?? '');`;

async function server(t, H = HK, M = HJ) {
  const home = fs.mkdtempSync(path.join(JAIL, 'cx-'));
  const day = path.join(home, 'sessions', '2026', '10', '23'); fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-x-${THREAD}.jsonl`);
  const handled = [];
  const hive = { sockPath: () => (process.platform === 'win32' ? `\\\\.\\pipe\\fn-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(home, 's.sock')), codexHomeFor: () => home, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: { cx: { cwd: AGENT }, b1: { cwd: AGENT } } }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }), snapshot: () => ({ gatedTools: [] }) };
  const s = new H.HookServer(hive, () => ({ send: () => {} }), () => ({}), control, undefined);
  const rows = [];
  const lock = new M.HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {}, leasePollMs: 1, log: (r) => rows.push(r), classifyCtx: (cwd) => H.HookServer.heavyScriptCtx(cwd) });
  s.setHeavyLock(lock);
  const real = s.handle.bind(s); s.handle = (p) => { handled.push(JSON.parse(JSON.stringify(p))); return real(p); };
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  // b1 holds the only slot with a bench, as Jim did at 13:44Z.
  const held = await s.handleWithClaimContext({ agent_id: 'b1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'GUPPY_BENCH=1 node bench.cjs' }, tool_use_id: 'u1', transport: 'http' });
  assert.notEqual(held?.hookSpecificOutput?.permissionDecision, 'deny', 'b1 takes the slot');
  /** One Codex PreToolUse for the rollout `line` (with the hook template's {command} when `ti` is given). */
  const pre = async (line, ti) => {
    fs.writeFileSync(rollout, [turn, line].join('\n') + '\n');
    const ep = s.mcpEndpoint('cx');
    const args = { event: 'PreToolUse', k: ep.token };
    if (ti) args.ti = JSON.stringify({ command: ti });
    const r = await rpc(ep.url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hive_hook', arguments: args, _meta: { threadId: THREAD } } });
    return { out: r.body.result.structuredContent, p: handled.at(-1) };
  };
  return { pre, rows, lock };
}
function rpc(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let o = ''; res.on('data', (d) => { o += d; }); res.on('end', () => resolve({ status: res.statusCode, body: o ? JSON.parse(o) : null })); });
    req.on('error', reject); req.end(data);
  });
}
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason ?? '';

/** Dwight's two calls, in both Codex tool shapes, while b1 holds. */
K.codexDenied = async ({ HJ: M, HK: H }, t) => {
  const { pre, rows } = await server(t, H, M);
  const dflt = M.codexDefaultShell();
  const lastDeny = () => rows.filter((r) => r.action === 'deny').at(-1);
  // (5) plain exec_command, as Dwight's rollout carries it.
  const direct = await pre(fcall('exec_command', { cmd: `node ${RUNNER} fn-many` }));
  assert.equal(direct.p.tool_name, 'exec_command');
  assert.equal(direct.p.cwd, AGENT, "the call's folder");
  assert.equal(denied(direct.out), true, `A CODEX exec_command node run-tests.cjs WITH A BROAD NEEDLE IS DENIED: ${reason(direct.out)}`);
  assert.equal(lastDeny()?.why, `node run-tests.cjs fn-many (matches ${MANY} test files)`, 'THE DENY ROW SAYS HOW MANY FILES THE NEEDLE PICKS');
  assert.equal(lastDeny()?.heavyKind, 'suite');
  assert.equal(direct.p.hook_shell, dflt, "THE HOOK NAMES THE SHELL (Codex's default when the call gives none)");
  const npm = await pre(fcall('exec_command', { cmd: `${NT} -- fn-many` }));
  assert.equal(denied(npm.out), true, `A CODEX exec_command npm test -- <broad> IS DENIED: ${reason(npm.out)}`);
  assert.equal(lastDeny()?.why, `npm test -- fn-many (matches ${MANY} test files)`);
  // write_stdin typed into the shell.
  const typed = await pre(fcall('write_stdin', { session_id: 3, chars: `${NT}\n` }));
  assert.equal(typed.p.tool_name, 'write_stdin');
  assert.equal(denied(typed.out), true, `A CODEX write_stdin npm test IS DENIED: ${reason(typed.out)}`);
  assert.equal(typed.p.hook_shell, dflt, 'WRITE_STDIN RUNS IN THE DEFAULT SHELL');
  const typedRun = await pre(fcall('write_stdin', { session_id: 3, chars: `node ${RUNNER} fn-many\n` }));
  assert.equal(denied(typedRun.out), true, `A CODEX write_stdin node run-tests.cjs <broad> IS DENIED: ${reason(typedRun.out)}`);
  assert.equal(typedRun.p.cwd, AGENT, "a write_stdin's folder is the turn's cwd");
  // Code-mode exec_command, with and without the hook template's own input.
  const own = await pre(code(EX(`node ${RUNNER} fn-many`)), `node ${RUNNER} fn-many`);
  assert.equal(denied(own.out), true, `A TEMPLATED exec_command IS DENIED: ${reason(own.out)}`);
  assert.equal(own.p.hook_shell, dflt);
  const rebuilt = await pre(code(EX(`${NT} -- fn-many`)));
  assert.equal(denied(rebuilt.out), true, `A REBUILT exec_command IS DENIED: ${reason(rebuilt.out)}`);
  // One file, both shapes: not limited.
  assert.equal(denied((await pre(fcall('exec_command', { cmd: `node ${RUNNER} fn-only-one` }))).out), false, 'ONE FILE IS ALLOWED (exec_command)');
  assert.equal(denied((await pre(code(EX(`${NT} -- fn-only-one`)), `${NT} -- fn-only-one`)).out), false, 'ONE FILE IS ALLOWED (templated)');
  assert.equal(denied((await pre(fcall('write_stdin', { session_id: 3, chars: `node ${RUNNER} fn-only-one\n` }))).out), false, 'ONE FILE IS ALLOWED (write_stdin)');
};

/** The call's own `shell` names the rules; none given is Codex's default; cmd stays unknown. */
K.codexShell = async ({ HJ: M, HK: H }, t) => {
  const { pre } = await server(t, H, M);
  const bash = await pre(code(EX('$true', ',shell:"bash"')), '$true');
  assert.equal(bash.p.hook_shell, 'bash', 'THE HOOK NAMES THE SHELL (a literal bash)');
  assert.equal(denied(bash.out), true, `A BASH $true IS A PATH THE LOCK CANNOT NAME: ${reason(bash.out)}`);
  const bashPath = await pre(fcall('exec_command', { cmd: '$true', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' }));
  assert.equal(bashPath.p.hook_shell, 'bash', 'THE HOOK NAMES THE SHELL (a plain exec_command with a bash path)');
  assert.equal(denied(bashPath.out), true, 'A BASH $true IS A PATH THE LOCK CANNOT NAME (plain exec_command)');
  const ps = await pre(code(EX('$true', ',shell:"powershell"')), '$true');
  assert.equal(ps.p.hook_shell, 'powershell');
  assert.equal(denied(ps.out), false, `A POWERSHELL $true IS A VALUE: ${reason(ps.out)}`);
  const none = await pre(code(EX('$true')), '$true');
  assert.equal(none.p.hook_shell, M.codexDefaultShell(), "NO SHELL GIVEN IS CODEX'S DEFAULT");
  assert.equal(denied(none.out), M.codexDefaultShell() === 'bash', 'and the default decides');
  const cmd = await pre(code(EX('$true', ',shell:"cmd"')), '$true');
  assert.equal(cmd.p.hook_shell, undefined, 'CMD NAMES NO SHELL KIND');
  assert.equal(cmd.p.hook_cmd_shell, true);
  const post = await pre(fcall('exec_command', { cmd: '$true' }));
  assert.equal(post.p.hook_shell, M.codexDefaultShell(), 'a plain exec_command with no shell');
};

// ─── TESTS ───────────────────────────────────────────────────────────────────────────────────

const mods = { HJ, HK };
test('a broad needle is the suite: run-tests.cjs and npm test, every tool name (Dwight 13:44Z, 13:46Z)', () => K.needle(mods));
test('the lease judges a runner\'s argv in its own folder (lease-inherit held:false)', () => K.lease(mods));
test('a node script that spawns a heavy command line is that command (item 2)', () => K.spawn(mods));
test('the shell of a Codex call (item 1)', () => K.shell(mods));
test('E2E: Dwight\'s exec_command and write_stdin are denied while another agent holds', (t) => K.codexDenied(mods, t));
test('E2E: a Codex call\'s shell is the call\'s own, else Codex\'s default', (t) => K.codexShell(mods, t));

test('wiring: main gives the lease the classifier context; the preload sends its folder', () => {
  assert.ok(readSource('src/main/index.ts').includes('classifyCtx: (cwd) => HookServer.heavyScriptCtx(cwd),'), 'MAIN WIRES classifyCtx');
  assert.ok(readSource('resources/heavy-preload.cjs').includes('runner: process.argv.slice(1), cwd: process.cwd()'), 'THE PRELOAD SENDS cwd');
});

test('listTestFiles: relative to a cd, absent folder is null, node_modules skipped', () => {
  const L = HK.HookServer.listTestFiles;
  assert.equal(L(null), null);
  assert.equal(L(path.join(JAIL, 'nowhere')), null);
  assert.equal(L(JAIL, 'agent').length, MANY + 1, 'a relative cd under the folder');
  assert.equal(L(null, AGENT).length, MANY + 1, 'an absolute cd alone');
  fs.mkdirSync(path.join(AGENT, 'test', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(AGENT, 'test', 'node_modules', 'dep.test.cjs'), '');
  assert.equal(L(AGENT).length, MANY + 1, 'node_modules is skipped');
  assert.ok(L(AGENT).includes('heavy-lock/FN-Many-sub-0.test.cjs'), 'names are relative to test/, with forward slashes');
});

// ─── MUTANT CENSUS ───────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  { file: HJF, name: 'the file count is not applied', edits: [["  if (n >= SUITE_MANY_FILES) return { heavy: true, kind: 'suite'", "  if (false) return { heavy: true, kind: 'suite'"]],
    killer: 'needle', dies: /A BROAD NEEDLE IS THE SUITE \(Bash\)/ },
  { file: HJF, name: 'threshold off by one', edits: [['  if (n >= SUITE_MANY_FILES) return', '  if (n > SUITE_MANY_FILES) return']],
    killer: 'needle', dies: /THRESHOLD: 20 MATCHES IS THE SUITE/ },
  { file: HJF, name: 'threshold 21 (Andy NIT 1)', edits: [['export const SUITE_MANY_FILES = 20;', 'export const SUITE_MANY_FILES = 21;']],
    killer: 'needle', dies: /THRESHOLD: 20 MATCHES IS THE SUITE/ },
  { file: HJF, name: 'npm needles drop a dash argument (today)', edits: [["    const needles = filtered ? args.slice(args.indexOf('--') + 1) : [];", "    const needles = filtered ? args.slice(args.indexOf('--') + 1).filter((a) => !a.startsWith('-')) : [];"]],
    killer: 'needle', dies: /A DASH NEEDLE COUNTS \(npm\)/ },
  { file: HJF, name: 'runner needles drop a dash argument (today)', edits: [['      const rest = args.slice(at + 1);\n', "      const rest = args.slice(at + 1).filter((a) => !a.startsWith('-'));\n"]],
    killer: 'needle', dies: /A DASH NEEDLE COUNTS \(runner\)/ },
  { file: HJF, name: 'the runner lists the caller\'s folder (today)', edits: [['filteredSuite(`node ${base}`, rest, ctx, runnerRoot(script))', 'filteredSuite(`node ${base}`, rest, ctx)']],
    killer: 'needle', dies: /THE RUNNER LISTS ITS OWN REPO: \{/ },
  { file: HJF, name: 'a relative runner path is not its repo', edits: [["  const root = parts.slice(0, -3).join('/');\n  return root === '' ? '/' : root;", "  const root = parts.slice(0, -3).join('/');\n  return root === '' || !/^([A-Za-z]:)?\\//.test(root) ? undefined : root;"]],
    killer: 'needle', dies: /A RELATIVE RUNNER PATH LISTS ITS REPO/ },
  { file: HJF, name: 'npm --prefix is the subcommand (today)', edits: [['    args = own;\n', '']],
    killer: 'needle', dies: /THE PREFIX FOLDER IS NOT THE SUBCOMMAND/ },
  { file: HJF, name: 'npm --prefix is not the repo listed', edits: [['filteredSuite(`${bin} test --`, needles, ctx, prefix)', 'filteredSuite(`${bin} test --`, needles, ctx)']],
    killer: 'needle', dies: /NPM --prefix LISTS THAT REPO/ },
  { file: HJF, name: 'npm run test* ignores the prefix', edits: [['filteredSuite(`${bin} run ${script} --`, needles, ctx, prefix)', 'filteredSuite(`${bin} run ${script} --`, needles, ctx)']],
    killer: 'needle', dies: /NPM -C LISTS THAT REPO/ },
  { file: HKF, name: 'the lister ignores the repo', edits: [['    const base = repo ? (abs(repo) ? drive(repo) : join(folder!, repo)) : folder!;', '    const base = folder!;']],
    killer: 'needle', dies: /THE RUNNER LISTS ITS OWN REPO: \{/ },
  { file: HJF, name: 'a spawned node --test list is not a line (the old rule)', edits: [["    if (e.length === 1 && e[0].t === 'str') words.push(e[0].v);", "    if (e.length === 1 && e[0].t === 'str') { if (e[0].v === '--test') return null; words.push(e[0].v); }"]],
    killer: 'spawn', dies: /A SPAWNED node --test LIST IS A LINE/ },
  { file: HJF, name: 'the match is case-sensitive', edits: [['  for (const f of list) { const name = f.toLowerCase();', '  for (const f of list) { const name = f;']],
    killer: 'needle', dies: /A BROAD NEEDLE IS THE SUITE \(Bash\)/ },
  { file: HJF, name: 'npm test -- <needle> is always light (today)', edits: [['filteredSuite(`${bin} test --`, needles, ctx, prefix)', '{ heavy: false }']],
    killer: 'needle', dies: /NPM TEST WITH A BROAD NEEDLE IS THE SUITE \(Bash\)/ },
  { file: HJF, name: 'npm run test* -- <needle> is always light (today)', edits: [['filteredSuite(`${bin} run ${script} --`, needles, ctx, prefix)', '{ heavy: false }']],
    killer: 'needle', dies: /NPM RUN TEST WITH A BROAD NEEDLE IS THE SUITE/ },
  { file: HJF, name: 'node run-tests.cjs <needle> is always light (today)', edits: [['      if (many.heavy) return many;\n', '']],
    killer: 'needle', dies: /A BROAD NEEDLE IS THE SUITE \(Bash\)/ },
  { file: HJF, name: 'the lease classifies the argv without its folder (today)', edits: [['      if (!classifyCommand(argv, 0, ctx).heavy) {', '      if (!classifyCommand(argv).heavy) {']],
    killer: 'lease', dies: /THE LEASE COUNTS THE NEEDLE/ },
  { file: HJF, name: 'spawned lines are not collected', edits: [['      const sp = spawnedLine(x.v, args);\n      if (sp) spawns.push(sp);\n', '']],
    killer: 'spawn', dies: /A SCRIPT SPAWNS NPM TEST/ },
  { file: HJF, name: 'a one-string program with a space is not a line (Andy NIT 2)', edits: [["  if (!(list && list[0]?.t === 'p' && list[0].v === '[')) return prog;", "  if (!(list && list[0]?.t === 'p' && list[0].v === '[')) return /\\s/.test(prog) ? null : prog;"]],
    killer: 'spawn', dies: /A ONE-STRING PROGRAM WITH shell:true IS A LINE/ },
  { file: HJF, name: 'process.execPath is not node', edits: [["  else if (first.length === 3 && first[0].v === 'process' && first[1].v === '.' && first[2].v === 'execPath') prog = 'node';\n", '']],
    killer: 'spawn', dies: /PROCESS.EXECPATH IS NODE/ },
  { file: HJF, name: 'a provisional spawn counts', edits: [['    if (g.heavy && !g.provisional) return g.why ?? line;', '    if (g.heavy) return g.why ?? line;']],
    killer: 'spawn', dies: /A PROVISIONAL SPAWN IS NOT COUNTED/ },
  { file: HJF, name: 'spawns are followed without bound', edits: [['  if (!spawns?.length || depth >= 1) return null;', '  if (!spawns?.length) return null;']],
    killer: 'spawn', dies: /A SPAWNED SCRIPT'S OWN SPAWNS ARE NOT FOLLOWED/ },
  { file: HJF, name: 'inline code\'s spawns are ignored', edits: [["    const sp = spawnedHeavy(s.spawns, ctx);\n    return sp ? hit(`spawns ${sp}`, '-e') : { heavy: false };", '    return { heavy: false };']],
    killer: 'spawn', dies: /INLINE CODE SPAWNS NPM TEST/ },
  { file: HJF, name: 'the default shell is bash everywhere', edits: [["  return platform === 'win32' ? 'powershell' : 'bash';", "  return 'bash';"]],
    killer: 'shell', dies: /DEFAULT SHELL ON WINDOWS IS POWERSHELL/ },
  { file: HJF, name: 'no shell given stays unknown', edits: [['  if (shell === null) return codexDefaultShell(platform);\n', '']],
    killer: 'shell', dies: /NO SHELL GIVEN IS THE DEFAULT/ },
  { file: HJF, name: 'only a bare "bash" is bash', edits: [["  if (/^(bash|sh|zsh|dash)$/.test(base)) return 'bash';", "  if (shell === 'bash') return 'bash';"]],
    killer: 'shell', dies: /A SHELL PATH ENDING IN ZSH IS BASH-LIKE/ },
  { file: HKF, name: 'the hook never names the shell (today)', edits: [['      if (shell) p.hook_shell = shell;\n', '']],
    killer: 'codexDenied', dies: /THE HOOK NAMES THE SHELL/ },
  { file: HKF, name: 'write_stdin gets no shell', edits: [["      const shell = rebuilt.toolName === 'write_stdin' ? codexDefaultShell() : tail && runs ? codexShellKind(pendingExecShell(tail, runs)) : undefined;", '      const shell = tail && runs ? codexShellKind(pendingExecShell(tail, runs)) : undefined;']],
    killer: 'codexDenied', dies: /WRITE_STDIN RUNS IN THE DEFAULT SHELL/ },
  { file: HKF, name: 'a plain exec_command\'s cmd is not read for its shell or folder (today)', edits: [["commandFromToolInput(rebuilt.toolName === 'Bash' || rebuilt.toolName === 'exec_command' ? rebuilt.toolInput : undefined)", "commandFromToolInput(rebuilt.toolName === 'Bash' ? rebuilt.toolInput : undefined)"]],
    killer: 'codexShell', dies: /THE HOOK NAMES THE SHELL \(a plain exec_command with a bash path\)/ },
  { file: HKF, name: 'PreToolUse classifies without the named shell', edits: [['      const scripts = HookServer.heavyCtxOf(p);', '      const scripts = HookServer.heavyScriptCtx(p.cwd);']],
    killer: 'codexShell', dies: /A BASH \$true IS A PATH THE LOCK CANNOT NAME/ },
  { file: HKF, name: 'the hook context lists no test files (today)', edits: [['      testFiles: (cd, repo) => HookServer.listTestFiles(folder, cd, repo),\n', '']],
    killer: 'codexDenied', dies: /A CODEX exec_command node run-tests.cjs WITH A BROAD NEEDLE IS DENIED/ },
  { file: HKF, name: 'the lister stops at test/ (feature folders not walked)', edits: [["if (depth < 3 && e.name !== 'node_modules') walk(", "if (false) walk("]],
    killer: 'needle', dies: /the lister finds every \*\.test\.cjs under test\/, any depth/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async (tt) => {
      const mutated = loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name));
      const ms = m.file === HJF ? { HJ: mutated, HK } : { HJ, HK: mutated };
      await assert.rejects(async () => K[m.killer](ms, tt), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
