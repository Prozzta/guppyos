'use strict';
/**
 * ZT-I1-MAIL layer (b): STATIC safety pins on test/tools/layer-b-run.cjs (Jim's audit R1-R10, god
 * c0a73f, Dwight). Nothing here builds, launches the app, a window or any CLI: the runner module is
 * only required (no side effect unless it is the main module) and its parts are exercised on temp
 * files. The one child process started here is a plain `node` sleeper that the kill fallback kills.
 *
 * Pinned (each by behaviour where it can be, else by the TypeScript AST, not a line regex):
 *  - not picked up by `node --test`; launches nothing without --go; --go needs LAYERB_SOAK=1 (the
 *    floor heavy-job lock);
 *  - EVERY disk mutation in the runner's code sits inside the write guard W (AST), W refuses every
 *    live location, and W.shred / W.removeProbeMarker are strict;
 *  - EVERY spawn/spawnSync call carries windowsHide: true (AST, any nesting);
 *  - the agents are confined: Codex never gets --dangerously-bypass-approvals-and-sandbox and runs
 *    workspace-write with jail-only writable roots, no network, unelevated; Claude's jailed settings
 *    carry the deny rules and the PreToolUse jail hook;
 *  - credentials: real files read-only, SHA-256 + mtime + size (a same-size edit with the mtime put
 *    back is caught), the token-refresh verdict, shredded copies; the startup sweep shreds stale ones;
 *  - kill: a failed scan is a FAILURE and falls back to open-handle roots only; emergency order is
 *    kill -> credentials -> sandbox;
 *  - caps abort; the window watch aborts on a visible window, a browser, WerFault/consent, or going blind;
 *  - evidence is redacted; the live-location watch fails on a run marker only;
 *  - B4 needs a genuine resume, B7 needs the mail to survive the compaction, B6 per Q44 (after turn 4);
 *  - the 1.1.74 worktree is removed node_modules first, without --force.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ts = require('typescript');
const { readSource, codeOnly } = require('./read-source.cjs');
const { selectTestFiles } = require('./tools/run-tests.cjs');

const RUNNER = path.join(__dirname, 'tools', 'layer-b-run.cjs');
const lb = require(RUNNER);
const raw = readSource(RUNNER);
const src = codeOnly(raw, 'layer-b-run.cjs');
const sf = ts.createSourceFile('layer-b-run.cjs', raw, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);

function tmpRoot(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  lb.W.allowRoot(d);
  t.after(() => { lb.W.roots = lb.W.roots.filter((r) => r !== path.resolve(d)); fs.rmSync(d, { recursive: true, force: true }); });
  return d;
}
/** Every call expression in the runner (template literal CONTENT is not code, so the stub TUI and
 *  the probe script, which are strings written into the sandbox, are excluded by construction). */
function calls(pred) {
  const out = [];
  const visit = (n) => { if (ts.isCallExpression(n) && pred(n)) out.push(n); ts.forEachChild(n, visit); };
  visit(sf);
  return out;
}
const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const insideNode = (n, container) => n.getStart(sf) >= container.getStart(sf) && n.getEnd() <= container.getEnd();
const wObject = (() => {
  let found = null;
  const visit = (n) => { if (!found && ts.isVariableDeclaration(n) && n.name.getText(sf) === 'W' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) found = n.initializer; ts.forEachChild(n, visit); };
  visit(sf);
  return found;
})();

test('the runner is NOT part of node --test (the runner only selects test/*.test.cjs)', () => {
  const entries = fs.readdirSync(path.join(__dirname));
  assert.ok(!selectTestFiles(entries).files.some((f) => /layer-b-run\.cjs$/.test(f)));
  assert.equal(selectTestFiles(fs.readdirSync(path.join(__dirname, 'tools'))).files.length, 0, 'nothing in test/tools is a test file');
  assert.ok(!/\.test\.cjs$/.test(RUNNER));
});

test('W refuses every live location and anything outside the run\'s own roots; shred and removeProbeMarker are strict', (t) => {
  const home = os.homedir();
  const root = tmpRoot(t, 'md-lb-static-');
  for (const bad of [
    'C:\\Dunder\\hive\\agents\\x\\inbox\\m.json', 'C:\\Dunder\\hive', 'C:\\Dunder\\MunderDevData\\userData\\config.json',
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'munder-difflin', 'config.json'),
    path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude.json'), path.join(home, '.codex', 'auth.json'),
    path.join(os.tmpdir(), 'somewhere-else', 'f.txt')
  ]) {
    assert.throws(() => lb.W.check(bad), /REFUSED/, bad);
    assert.throws(() => lb.W.write(bad, 'x'), /REFUSED/, bad);
    assert.throws(() => lb.W.rm(bad), /REFUSED/, bad);
    assert.throws(() => lb.W.shred(bad), /REFUSED/, bad);
  }
  for (const bad of ['C:\\Dunder', home, 'C:\\']) assert.throws(() => lb.W.allowRoot(bad), /REFUSED/, bad);
  const f = path.join(root, 'a', 'secret.json');
  lb.W.write(f, 'plaintext-token');
  assert.equal(lb.W.shred(f), true);
  assert.equal(fs.existsSync(f), false);
  // removeProbeMarker: only this run's exact marker name, only a small file.
  const marker = 'md-layerb-probe-0123456789abcdef.txt';
  const mf = path.join(root, marker);
  fs.writeFileSync(mf, 'x');
  assert.throws(() => lb.W.removeProbeMarker(mf, 'md-layerb-probe-ffffffffffffffff.txt'), /REFUSED/);
  assert.throws(() => lb.W.removeProbeMarker(path.join(root, 'registry.json'), 'registry.json'), /REFUSED/);
  lb.W.removeProbeMarker(mf, marker);
  assert.equal(fs.existsSync(mf), false);
});

test('AST: every disk mutation in the runner\'s code sits inside the write guard W', () => {
  assert.ok(wObject, 'the W object literal was found');
  const MUT = /^(writeFileSync|appendFileSync|mkdirSync|rmSync|rmdirSync|renameSync|copyFileSync|cpSync|unlinkSync|symlinkSync|linkSync|truncateSync|writeSync|writeFile|appendFile|mkdir|rm|rename|copyFile|cp|unlink|symlink|link|truncate)$/;
  const muts = calls((n) => ts.isPropertyAccessExpression(n.expression) && /^(fs|fsp|fs\.promises)$/.test(n.expression.expression.getText(sf)) && MUT.test(n.expression.name.text));
  const outside = muts.filter((n) => !insideNode(n, wObject)).map((n) => `${line(n)}: ${n.getText(sf).slice(0, 90)}`);
  assert.deepEqual(outside, [], 'a disk mutation outside W');
  assert.ok(muts.length >= 8, 'the AST really found W\'s own mutations');
  // Every openSync outside W is read-only ('r').
  const opens = calls((n) => n.expression.getText(sf) === 'fs.openSync').filter((n) => !insideNode(n, wObject));
  assert.ok(opens.length >= 2);
  for (const o of opens) assert.equal(o.arguments[1] && o.arguments[1].getText(sf), "'r'", `line ${line(o)} opens read-only`);
  // Nothing requires fs/promises or a child-process-based copy (robocopy/xcopy/mklink) to dodge the guard.
  assert.ok(!/require\('node:fs\/promises'\)|fs\.promises|robocopy|xcopy|mklink|New-Item/.test(src.replace(/const PS_WATCH[\s\S]*?\n`;/, '')));
});

test('AST: every spawn / spawnSync call, at any nesting, passes windowsHide: true', () => {
  const sp = calls((n) => /^(spawn|spawnSync)$/.test(n.expression.getText(sf)));
  assert.ok(sp.length >= 10, `found ${sp.length} spawn calls`);
  const bad = [];
  for (const c of sp) {
    const opts = c.arguments.find((a) => ts.isObjectLiteralExpression(a));
    const ok = opts && opts.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText(sf) === 'windowsHide' && p.initializer.getText(sf) === 'true');
    if (!ok) bad.push(`${line(c)}: ${c.getText(sf).slice(0, 100)}`);
  }
  assert.deepEqual(bad, []);
  // exec/execSync/fork are not used at all (they would bypass this check).
  assert.equal(calls((n) => /^(exec|execSync|execFile|execFileSync|fork)$/.test(n.expression.getText(sf))).length, 0);
});

test('Credentials: SHA-256 + mtime + size (a same-size edit with the mtime restored is CAUGHT), token-refresh verdict, shredded copy', (t) => {
  const root = tmpRoot(t, 'md-lb-cred-');
  const real = path.join(root, 'real', 'auth.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{"token":"AAAA"}');
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(real, past, past);
  const c = new lb.Credentials();
  const dest = path.join(root, 'jail', '.codex', 'auth.json');
  c.copy('codex', real, dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"token":"AAAA"}');
  assert.throws(() => c.copy('codex', real, dest), /EEXIST/, 'exclusive create');
  assert.deepEqual(c.verifyRealUnchanged().map((v) => v.unchanged), [true]);
  // Dwight: same size, mtime put back: only the SHA can see it.
  fs.writeFileSync(real, '{"token":"BBBB"}');
  fs.utimesSync(real, past, past);
  const v = c.verifyRealUnchanged()[0];
  assert.equal(v.sizeSame, true); assert.equal(v.mtimeSame, true);
  assert.equal(v.shaSame, false); assert.equal(v.unchanged, false);
  // The CLI refreshed its token in the jail: reported, then the copy is shredded.
  fs.writeFileSync(dest, '{"token":"CCCC-refreshed"}');
  const del = c.deleteAll();
  assert.deepEqual(del.map((d) => [d.label, d.deleted, d.tokenRefreshed]), [['codex', true, true]]);
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(c.deleteAll().map((d) => d.deleted), [true], 'idempotent');
  // $CODEX_HOME honoured; one inside a live hive refused.
  assert.equal(lb.realCredentialPaths({ CODEX_HOME: 'D:\\ch' }).codex, path.resolve('D:\\ch', 'auth.json'));
  assert.throws(() => lb.realCredentialPaths({ CODEX_HOME: 'C:\\Dunder\\hive\\agents\\x\\.codex' }), /live hive/);
  assert.equal(lb.realCredentialPaths({}).codex, path.join(os.homedir(), '.codex', 'auth.json'));
});

test('ProcTracker: grows the tree, keeps orphans, and never adopts a stranger through a reused pid', () => {
  const tr = new lb.ProcTracker();
  tr.addRoot(100);
  const scan = (procs) => tr.ingest({ so: JSON.stringify({ procs, visible: [] }), se: '' });
  scan([
    { pid: 100, ppid: 1, name: 'Munder Difflin.exe', created: '1000' },
    { pid: 200, ppid: 100, name: 'node.exe', created: '1100' },
    { pid: 300, ppid: 200, name: 'claude.exe', created: '1200' }
  ]);
  assert.deepEqual([...tr.known.keys()].sort(), [100, 200, 300]);
  scan([{ pid: 100, ppid: 1, name: 'Munder Difflin.exe', created: '1000' }, { pid: 301, ppid: 200, name: 'codex.exe', created: '1300' }]);
  assert.ok(tr.known.has(301));
  scan([{ pid: 200, ppid: 4, name: 'explorer.exe', created: '5000' }, { pid: 999, ppid: 200, name: 'notepad.exe', created: '5100' }]);
  assert.equal(tr.known.has(999), false);
  assert.equal(tr.known.get(200).created, '1100');
});

test('caps: a token ledger over the per-agent cap ABORTS the run (and so does the total)', (t) => {
  const root = tmpRoot(t, 'md-lb-caps-');
  const run = new lb.LayerB(lb.parseArgs([]));
  run.s = { base: root, hive: path.join(root, 'hive'), home: path.join(root, 'home') };
  fs.mkdirSync(run.s.hive, { recursive: true });
  const row = (agent, n) => JSON.stringify({ agent_id: agent, session_id: `s-${agent}`, ts: 1, input: n, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd: 0 }) + '\n';
  fs.writeFileSync(path.join(run.s.hive, 'cost-ledger.jsonl'), row('lb-claude', 399_000));
  run.pollTokens();
  assert.equal(run.aborted(), false, 'under the cap');
  fs.appendFileSync(path.join(run.s.hive, 'cost-ledger.jsonl'), row('lb-claude', 400_001));
  run.pollTokens();
  assert.equal(run.aborted(), true);
  assert.match(String(run.abort.signal.reason.message), /per-agent token cap: lb-claude/);
  const run2 = new lb.LayerB(lb.parseArgs([]));
  run2.s = run.s;
  fs.writeFileSync(path.join(run.s.hive, 'cost-ledger.jsonl'), row('lb-claude', 350_000) + row('lb-codex', 350_000) + row('god', 350_000));
  run2.pollTokens();
  assert.match(String(run2.abort.signal.reason.message), /total token cap/);
});

test('R8: the window watch starts with the process and aborts on a visible window, a browser, WerFault/consent, or going blind', () => {
  const hits = []; const blind = [];
  const w = new lb.WindowWatch(1, { onHit: (x) => hits.push(x), onBlind: (x) => blind.push(x) });
  assert.equal(w.healthy(), false, 'no line yet: not healthy');
  w.ingest(JSON.stringify({ ok: true, tree: 3, visible: [], browsers: [], alerts: [] }));
  assert.equal(w.healthy(), true);
  assert.deepEqual(hits, []);
  w.ingest(JSON.stringify({ ok: true, visible: ['123:Munder Difflin DEV'], browsers: [], alerts: [] }));
  w.ingest(JSON.stringify({ ok: true, visible: [], browsers: ['55:chrome.exe'], alerts: [] }));
  w.ingest(JSON.stringify({ ok: true, visible: [], browsers: [], alerts: ['77:WerFault.exe', '78:consent.exe'] }));
  assert.equal(hits.length, 3);
  assert.match(hits[0], /visible window 123/); assert.match(hits[1], /browser/); assert.match(hits[2], /WerFault.*consent/);
  for (let i = 0; i < 3; i++) w.ingest(JSON.stringify({ ok: false, error: 'CIM down' }));
  assert.equal(blind.length, 1);
  assert.equal(w.healthy(Date.now() + 60_000), false, 'silent = blind');
  // Wiring: the watch starts right after spawn, BEFORE any CDP target is awaited; hits and blindness stop the run.
  const launch = src.slice(src.indexOf('async launch(exe, label) {'), src.indexOf('async assertHidden('));
  assert.ok(launch.indexOf('new WindowWatch(proc.pid') > 0 && launch.indexOf('new WindowWatch(proc.pid') < launch.indexOf('Cdp.target('));
  assert.match(launch, /onHit: \(why\) => \{[^\n]*this\.stop\(/);
  assert.match(launch, /onBlind: \(why\) => \{[^\n]*this\.stop\(/);
  assert.match(src, /\$browsers = '\^\(chrome\|msedge\|firefox/);
  assert.match(src, /\$alerts = '\^\(WerFault\|WerFaultSecure\|consent\)/);
  assert.match(launch, /'--remote-debugging-address=127\.0\.0\.1', `--inspect=127\.0\.0\.1:\$\{inspPort\}`/);
  assert.match(launch, /if \(!this\.check\(!!pipeLine && /, 'R10: a missing pipe= line fails');
});

test('R6: the build env is scrubbed of every secret and points the caches into the run', () => {
  const parent = { Path: 'C:\\Windows;C:\\Dunder\\hive\\bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', CSC_LINK: 'x', CSC_KEY_PASSWORD: 'x', WIN_CSC_LINK: 'x', NPM_TOKEN: 'x', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'x', APPLE_ID: 'x', HIVE_ROOT: 'x', MUNDER_DEV: '1', CLAUDE_CODE_X: 'x', npm_config__authToken: 'x', ELECTRON_BUILDER_CACHE: 'C:\\real', SystemRoot: 'C:\\Windows' };
  const env = lb.buildEnv('D:\\run\\cache', { parent });
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'NPM_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'APPLE_ID', 'HIVE_ROOT', 'MUNDER_DEV', 'CLAUDE_CODE_X', 'npm_config__authToken']) assert.equal(env[k], undefined, k);
  assert.equal(env.MUNDER_LAYERB_SEAMS, '1');
  assert.equal(env.ELECTRON_BUILDER_CACHE, path.join('D:\\run\\cache', 'electron-builder'));
  assert.equal(env.ELECTRON_CACHE, path.join('D:\\run\\cache', 'electron'));
  assert.equal(env.npm_config_cache, path.join('D:\\run\\cache', 'npm'));
  assert.equal(env.Path, 'C:\\Windows');
  assert.equal(lb.buildEnv(null, { parent, seams: false }).MUNDER_LAYERB_SEAMS, undefined, 'the out/ rebuild at the end has no seams');
  assert.match(src, /-c\.electronDist=/);
});

test('R9: evidence is redacted (token-shaped strings, auth headers, token fields)', () => {
  const r = lb.redact('a sk-ant-api03-AAAAAAAAAAAAAAAA b sk-proj-BBBBBBBBBBBBBBBBBBBBBBBB {"access_token":"x1","refresh_token":"y2","accessToken":"z3"} Authorization: Bearer abc.def eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U x-api-key: KKKK');
  for (const leak of ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBBBBBBBBBB', 'x1', 'y2', 'z3', 'abc.def', 'dozjgNry', 'KKKK']) assert.ok(!r.includes(leak), `${leak} leaked: ${r}`);
  const ev = src.slice(src.indexOf('collectEvidence() {'), src.indexOf('markers() {'));
  assert.ok(!/W\.copy\(/.test(ev), 'no raw copy into the report');
  assert.match(ev, /W\.write\(path\.join\(dst, rel\), redact\(text\)\)/);
});

test('SOURCE: no --force worktree removal (node_modules goes first), no fixed canary port, nothing without --go, the heavy-job gate', () => {
  assert.ok(!/['"]--force['"]|['"]-f['"]/.test(src), 'never --force as an argument');
  const rm = src.indexOf("['worktree', 'remove', dir]");
  assert.ok(rm > 0, 'the 1.1.74 worktree is removed');
  const clean = src.slice(src.indexOf('removeV1174() {'), rm);
  assert.ok(clean.indexOf('W.rm(nm)') > 0, 'node_modules removed before');
  assert.match(clean, /isSymbolicLink\(\)\) throw new Error\('node_modules is a link/, 'never removed through a link');
  assert.equal((src.match(/'worktree', 'remove'/g) || []).length, 1);
  assert.ok(!/9333/.test(src));
  assert.ok(!/Start-Process|ShellExecute|\bstart\s+""/i.test(src.replace(/const PS_WATCH[\s\S]*?\n`;/, '')));
  assert.match(src, /if \(!this\.args\.go\) \{[\s\S]{0,300}return 0;/);
  const main = src.slice(src.indexOf('async main() {'));
  assert.ok(main.indexOf('return 0;') < main.indexOf('W.allowRoot(s.base)'), 'without --go nothing is even registered for writing');
  assert.match(src, /if \(this\.args\.go && process\.env\[HEAVY_GATE\] !== '1'\)/);
  assert.equal(lb.HEAVY_GATE, 'LAYERB_SOAK');
  const { classifyCommand } = require('./load-ts.cjs')(path.join(__dirname, '..', 'src', 'main', 'heavyJob.ts'));
  assert.equal(classifyCommand('LAYERB_SOAK=1 node C:/Dunder/_work/andy-scratch/flaky170/run-clean-realhome.cjs C:/Dunder/_work/andy-zt175 node test/tools/layer-b-run.cjs --go').heavy, true);
  assert.equal(lb.parseArgs([]).go, false);
  assert.equal(lb.parseArgs(['--dry-run-stubs']).dryRun, true);
  assert.equal(lb.parseArgs(['--keep-v1174']).keepV1174, true);
  assert.deepEqual(['floorPaused', 'uacRisk', 'codexProbe'].map((k) => lb.parseArgs([])[k]), [false, false, false], 'every gate is OFF by default');
  assert.throws(() => lb.parseArgs(['--claude-model', 'x; rm -rf']), /bad model id/);
  assert.match(src, /isolation\.rigEnv\(s\.jail, process\.env\)/);
  assert.match(src, /MUNDER_DEV: '1', MUNDER_HIDDEN: '1', MUNDER_DEV_ROOT: s\.devRoot/);
  assert.match(src, /isolation\.checkIsolation\(probe, s\.base/);
  assert.deepEqual(lb.CAPS, { perAgentTokens: 400_000, totalTokens: 1_000_000, wallMs: 30 * 60_000 });
  assert.equal(lb.GLOBAL_WALL_MS, 55 * 60_000, 'under the heavy lock\'s 60 min TTL');
});

test('god 4dd770 (3) + 57634c: the REAL run refuses without --floor-paused-confirmed AND --uac-risk-accepted; the DRY run starts no codex binary', (t) => {
  const prev = process.env.LAYERB_SOAK;
  process.env.LAYERB_SOAK = '1';
  // From an agent shell the runner's own env check (HIVE_NODE ...) would refuse first: scrub those here.
  const scrubbed = {};
  for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_|CTH_|KG_)/i.test(k)) { scrubbed[k] = process.env[k]; delete process.env[k]; }
  t.after(() => Object.assign(process.env, scrubbed));
  try {
    const pre = (argv) => { const r = new lb.LayerB(lb.parseArgs(argv)); r.layout(); return () => r.preflight(); };
    assert.throws(pre(['--go']), /--floor-paused-confirmed/);
    assert.throws(pre(['--go', '--floor-paused-confirmed']), /--uac-risk-accepted/);
    assert.throws(pre(['--go', '--uac-risk-accepted']), /--floor-paused-confirmed/);
    assert.throws(pre(['--go', '--dry-run-stubs', '--codex-sandbox-probe']), /real run only/);
    assert.doesNotThrow(pre(['--go', '--dry-run-stubs']), 'the dry run needs neither');
  } finally { if (prev === undefined) delete process.env.LAYERB_SOAK; else process.env.LAYERB_SOAK = prev; }
  const main = src.slice(src.indexOf('async main() {'));
  // Real: the help first, then STOP unless --codex-sandbox-probe; the probe only in the real run.
  assert.match(main, /if \(!this\.args\.dryRun\) \{\s*this\.codexSandboxHelp\(\);\s*if \(!this\.args\.codexProbe\) \{/);
  assert.ok(main.indexOf('this.codexSandboxHelp()') < main.indexOf('this.build()'), 'the help comes before the build');
  assert.match(main, /if \(!this\.args\.dryRun && !this\.proveCodexSandbox\(\)\) throw/);
  // Every codex-binary spawn in the runner lives in the two real-run-only methods.
  const codexSpawns = calls((n) => /^spawnSync$/.test(n.expression.getText(sf)) && n.arguments[0] && n.arguments[0].getText(sf) === 'exe');
  const owners = codexSpawns.map((c) => { let x = c; while (x && !(ts.isMethodDeclaration(x))) x = x.parent; return x ? x.name.getText(sf) : null; });
  assert.deepEqual(owners.sort(), ['codexSandboxHelp', 'proveCodexSandbox']);
  assert.match(src, /'sandbox', 'windows', '--help'/);
});

test('R8 / Dwight (c): the session window watch (this runner\'s whole tree) starts BEFORE any other process of the run', () => {
  const main = src.slice(src.indexOf('async main() {'), src.indexOf('/** R1: the Codex agent really runs'));
  const watchAt = main.indexOf('this.sessionWatch = new WindowWatch(process.pid');
  assert.ok(watchAt > 0);
  for (const step of ['this.startupSweep()', 'this.codexSandboxHelp()', 'this.build()', 'this.seed()', 'this.installCredentials()', 'this.proveClaudeJail()', 'this.proveCodexSandbox()', 'this.launch(']) {
    const at = main.indexOf(step);
    assert.ok(at > watchAt, `${step} comes after the session watch starts`);
  }
  assert.ok(main.indexOf("waitFor('the session window watch reports'") < main.indexOf('this.startupSweep()'), 'and it has reported before anything runs');
  // Nothing in main before the watch spawns.
  const before = main.slice(0, watchAt);
  assert.ok(!/spawn|this\.build|this\.launch|codexSandboxHelp|prove/.test(before.replace('this.preflight()', '')));
  assert.match(src, /onBlind: \(why\) => \{ if \(!this\.aborted\(\)\) \{ this\.check\(false, 'the session window watch sees'/);
});

test('R1 confinement: Codex runs workspace-write with jail-only roots, no network, unelevated; Claude\'s jail settings are an allowlist mirror + the hook', (t) => {
  assert.ok(!/command = `codex[^`]*dangerously/.test(src), 'Codex never gets the bypass flag');
  assert.match(src, /command = `codex --model \$\{this\.args\.models\.codex\} --sandbox workspace-write --ask-for-approval never`;/);
  assert.match(src, /command = `claude --model \$\{this\.args\.models\.claude\} --permission-mode bypassPermissions`;/, 'Claude arguments unchanged from the product');
  const toml = lb.codexSandboxToml(['C:\\sb\\work\\lb-codex', 'C:\\sb\\devroot\\hive\\agents\\lb-codex']);
  assert.match(toml, /^sandbox_mode = "workspace-write"$/m);
  assert.match(toml, /^approval_policy = "never"$/m);
  assert.match(toml, /^writable_roots = \['C:\\sb\\work\\lb-codex', 'C:\\sb\\devroot\\hive\\agents\\lb-codex'\]$/m);
  assert.match(toml, /^network_access = false$/m);
  assert.match(toml, /^\[windows\]\nsandbox = "unelevated"$/m);
  const st = lb.claudeJailSettings({ node: 'C:\\n\\node.exe', policyFile: 'C:\\sb\\layer-b-jail-policy.json', liveDenied: ['C:\\Dunder', path.join(os.homedir(), '.claude')], readRoots: ['C:\\sb'], writeRoots: ['C:\\sb\\work\\lb-claude'], env: { X: '1' } });
  for (const tool of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'NotebookEdit', 'Agent', 'Task', 'mcp__*']) assert.ok(st.permissions.deny.includes(tool), `deny ${tool}`);
  assert.ok(st.permissions.deny.includes('Write(//c/Dunder/**)') && st.permissions.deny.includes('Read(//c/Dunder/**)'));
  assert.deepEqual(st.permissions.allow.sort(), ['Edit(//c/sb/work/lb-claude/**)', 'Glob(//c/sb/**)', 'Grep(//c/sb/**)', 'LS(//c/sb/**)', 'MultiEdit(//c/sb/work/lb-claude/**)', 'Read(//c/sb/**)', 'Write(//c/sb/work/lb-claude/**)'].sort());
  assert.equal(st.hooks.PreToolUse[0].matcher, '*');
  assert.match(st.hooks.PreToolUse[0].hooks[0].command, /^"C:\/n\/node\.exe" ".*\/test\/tools\/layer-b-jail-hook\.cjs" "C:\/sb\/layer-b-jail-policy\.json"$/);
  assert.deepEqual(st.env, { X: '1' });
  // The hook's allowlist is exactly the tools the permissions allow.
  const hook = require('./tools/layer-b-jail-hook.cjs');
  assert.deepEqual([...hook.READ_TOOLS, ...hook.WRITE_TOOLS].sort(), ['Edit', 'Glob', 'Grep', 'LS', 'MultiEdit', 'Read', 'Write']);
  // The facts need no shell: no fact prompt asks for a shell command, and B2 uses Read calls.
  const facts = src.slice(src.indexOf('async factB1B8B9() {'), src.indexOf('factN4() {'));
  const claudeFacts = ['factB1B8B9', 'factB2', 'factB4', 'factB3'].map((f) => src.slice(src.indexOf(`async ${f}() {`), src.indexOf('\n  }\n', src.indexOf(`async ${f}() {`))));
  for (const f of claudeFacts) assert.ok(!/shell command|sleep \d|\bBash\b|PowerShell|run these/i.test(f), 'a Claude fact asks for a shell');
  assert.match(facts, /Read these six files with your Read tool, ONE file per tool call/);
  // Phase B keeps the jail; the proof runs BEFORE any agent starts and stops the run on failure.
  assert.match(src, /this\.writeClaudeSettings\(\{ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String\(pct\) \}\);/);
  const main = src.slice(src.indexOf('async main() {'));
  assert.ok(main.indexOf('this.proveClaudeJail()') < main.indexOf('this.launch('));
  assert.match(main, /if \(!this\.proveClaudeJail\(\)\) throw/);
  assert.match(src, /checkCodexSeed\(\)/);
});

test('R4 startup sweep: a stale md-layerb-* sandbox has its credentials SHREDDED, then is removed; this run\'s and other dirs are left', (t) => {
  const tmp = tmpRoot(t, 'md-lb-sweep-');
  const stale = path.join(tmp, 'md-layerb-2026-09-01T10-00-00-000Z');
  const mine = path.join(tmp, 'md-layerb-2026-09-28T10-00-00-000Z');
  const other = path.join(tmp, 'md-layerb-v1174');
  for (const f of [path.join(stale, 'jail', 'home', '.claude', '.credentials.json'), path.join(stale, 'devroot', 'hive', 'agents', 'lb-codex', '.codex', 'auth.json'), path.join(stale, 'x.txt'), path.join(mine, 'keep.txt'), path.join(other, 'package.json')]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'secret');
  }
  const r = lb.sweepStale(tmp, mine);
  assert.equal(r.ok, true);
  assert.deepEqual(r.done.map((d) => [path.basename(d.dir), d.credentials, d.shredded, d.removed]), [['md-layerb-2026-09-01T10-00-00-000Z', 2, 2, true]]);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(path.join(mine, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(other, 'package.json')), true);
});

test('R4 FAIL-CLOSED (Dwight a): an injected shred failure KEEPS the stale dir, ok:false, and the run aborts before the build and any credential copy', (t) => {
  const tmp = tmpRoot(t, 'md-lb-sweepfail-');
  const stale = path.join(tmp, 'md-layerb-2026-09-02T10-00-00-000Z');
  const cred = path.join(stale, 'jail', 'home', '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(cred), { recursive: true });
  fs.writeFileSync(cred, 'secret');
  let rmCalled = false;
  const r = lb.sweepStale(tmp, null, { shred: () => { throw new Error('EBUSY (injected)'); }, rm: () => { rmCalled = true; } });
  assert.equal(r.ok, false);
  assert.match(r.done[0].error, /EBUSY \(injected\)/);
  assert.equal(rmCalled, false, 'the dir is NOT removed after a failed shred');
  assert.equal(fs.existsSync(cred), true, 'the evidence of the failure stays');
  // A shred that "succeeds" but leaves the file is a failure too; so is a removal that leaves the dir.
  assert.equal(lb.sweepStale(tmp, null, { shred: () => true, rm: () => {} }).ok, false);
  // main: the sweep (which throws when not ok) runs BEFORE build() and installCredentials().
  const main = src.slice(src.indexOf('async main() {'));
  const thr = main.indexOf('sweep = this.startupSweep();');
  assert.ok(thr > 0 && thr < main.indexOf('this.build()') && thr < main.indexOf('this.installCredentials()'));
  { const m = src.slice(src.indexOf('startupSweep(ops) {')); assert.ok(m.indexOf("if (!sweep.ok) throw new Error('the startup sweep could not prove") > 0 && m.indexOf("if (!sweep.ok) throw") < 600, 'startupSweep throws when not ok'); }
});

test('R3: a FAILED scan is a failure (never a vacuous "all gone"); the fallback kills only roots whose handle is still open', async (t) => {
  const tr = new lb.ProcTracker();
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { try { sleeper.kill(); } catch { /* gone */ } });
  const exited = { pid: 4, exitCode: 0, signalCode: null };
  tr.addRoot(sleeper.pid, sleeper);
  tr.handles.set(4, exited);
  tr.scan = async () => { throw new Error('scan failed'); };
  const r = await tr.killAll();
  assert.equal(r.ok, false);
  assert.equal(r.scanFailed, true);
  assert.deepEqual(r.fallback, [sleeper.pid]);
  assert.ok(r.survivors.length > 0, 'reported as unknown, not as none');
  await new Promise((res) => { if (sleeper.exitCode !== null || sleeper.signalCode !== null) return res(); sleeper.once('exit', res); setTimeout(res, 10_000); });
  assert.ok(sleeper.exitCode !== null || sleeper.signalCode !== null, 'the open-handle root was killed');
  const tr2 = new lb.ProcTracker();
  tr2.addRoot(123456);
  tr2.scan = async () => ({ procs: [], visible: [] });
  assert.equal((await tr2.killAll()).ok, false, 'an EMPTY scan with known pids is a failure');
});

test('NO PROOF OF EXIT (Dwight b): stopApp aborts the run before any relaunch; the teardown kills again, SHREDS the credentials, KEEPS the sandbox and names the survivors', async (t) => {
  const root = tmpRoot(t, 'md-lb-noexit-');
  const run = new lb.LayerB(lb.parseArgs([]));
  run.s = { base: root, hive: path.join(root, 'hive'), home: path.join(root, 'home'), report: path.join(root, 'report'), stubs: path.join(root, 'stubs') };
  fs.mkdirSync(run.s.hive, { recursive: true });
  // A credential copy in the jail.
  const real = path.join(root, 'decoy-real', 'auth.json');
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, '{"t":"decoy"}');
  const dest = path.join(root, 'jail', '.codex', 'auth.json');
  run.creds.copy('codex', real, dest);
  // An injected failed kill: every attempt fails, synchronous and asynchronous.
  let asyncKills = 0; let syncKills = 0;
  run.procs.killAll = async () => { asyncKills++; return { ok: false, scanFailed: true, why: 'injected', killed: [], fallback: [4242], survivors: ['4242:claude.exe'] }; };
  run.procs.killSyncBestEffort = () => { syncKills++; return { ok: false, survivors: ['4242:claude.exe'] }; };
  // 1. stopApp throws AND aborts, so no phase/relaunch can follow.
  await assert.rejects(run.stopApp('phase A'), /no proof of exit/);
  assert.equal(run.aborted(), true);
  assert.deepEqual(run.exitUnproven.survivors, ['4242:claude.exe']);
  assert.match(src, /async relaunchForPhaseB\(\) \{[\s\S]*?await this\.stopApp\('phase A'\);[\s\S]*?this\.relaunchAt = Date\.now\(\);/, 'the relaunch comes after a stopApp that throws on no proof');
  // 2. The teardown: a further kill attempt, then the credentials, the sandbox KEPT, the survivors reported.
  run.exitUnproven = null;
  const td = await run.teardown();
  assert.ok(asyncKills >= 3 && syncKills >= 1, `a further kill attempt was made (async ${asyncKills}, sync ${syncKills})`);
  assert.equal(fs.existsSync(dest), false, 'the credential copy was shredded');
  assert.deepEqual(td.credentials.map((c) => [c.label, c.deleted]), [['codex', true]]);
  assert.deepEqual(td.survivors, ['4242:claude.exe']);
  assert.equal(td.sandboxRemoved, false);
  assert.equal(fs.existsSync(root), true, 'the sandbox (and the evidence) is KEPT');
  assert.ok(td.buildCleanup.some((x) => /NO PROOF OF EXIT/.test(x)));
  // Order inside teardown: kill attempts, then credentials.
  const tdSrc = src.slice(src.indexOf('async teardown() {'), src.indexOf('// ── evidence + report'));
  assert.ok(tdSrc.indexOf('killSyncBestEffort') < tdSrc.indexOf('this.creds.deleteAll()'));
  assert.ok(tdSrc.indexOf("this.stopApp('final')") < tdSrc.indexOf('this.creds.deleteAll()'));
  assert.ok(tdSrc.indexOf('rebuildOutWithoutSeams') > 0, 'out/ is rebuilt without the seams in every teardown');
});

test('R4: the emergency path kills FIRST, then shreds the credentials, then removes the sandbox only with proof, then rebuilds out/', () => {
  const em = src.slice(src.indexOf('const emergency = (code) => {'), src.indexOf("for (const sig of ['SIGINT'"));
  const k = em.indexOf('killSyncBestEffort()'); const c = em.indexOf('creds.deleteAll()'); const r = em.indexOf('W.rm(lb.s.base)'); const o = em.indexOf('rebuildOutWithoutSeams()');
  assert.ok(k > 0 && c > k && r > c && o > r, `order kill ${k} < creds ${c} < sandbox ${r} < out ${o}`);
  assert.match(em, /if \(proven\) W\.rm\(lb\.s\.base\);\s*else console\.error\(`\[layer-b\] NO PROOF OF EXIT/);
  assert.match(src, /process\.on\('exit', \(\) => \{ try \{ if \(lb && !exiting\) \{ lb\.procs\.killRootsByHandle\('process exit'\); lb\.creds\.deleteAll\(\); \}/);
});

test('decision 4: the live-location watch is STAT + HASH only (no content read); a change is reported, only a NAME carrying a run marker FAILS', (t) => {
  const root = tmpRoot(t, 'md-lb-live-');
  const f = path.join(root, 'log.jsonl');
  fs.writeFileSync(f, '{"kind":"x"}\n');
  const w = new lb.LiveWatch([root], [f]).start();
  fs.appendFileSync(f, '{"from":"lb-claude","body":"LBN-12345678"}\n');
  const r = w.compare(['md-layerb-2026', 'lb-claude', 'LBN-12345678']);
  assert.equal(r.ok, true, 'content is never read, so a marker INSIDE a live file is not looked at');
  assert.ok(r.changed.some((c) => c.file === f));
  assert.equal(r.keys[0].same, false, 'the key-file hash shows the change');
  fs.writeFileSync(path.join(root, 'md-layerb-probe-0000000000000000.txt'), 'x');
  assert.equal(w.compare(['md-layerb-probe']).ok, false, 'a new file NAMED with a marker fails');
  const lw = src.slice(src.indexOf('class LiveWatch {'), src.indexOf('function b6Tiers('));
  assert.ok(!/readSync\(|readFileSync\(|createReadStream/.test(lw.replace(/shaReadOnly\(k\)/g, '')), 'no content read besides the hash');
  const main = src.slice(src.indexOf('async main() {'));
  assert.match(main, /this\.liveWatch = LiveWatch\.defaults\(\)\.start\(\);/);
  const td = src.slice(src.indexOf('async teardown() {'), src.indexOf('// ── evidence + report'));
  assert.ok(td.indexOf('this.liveWatch.compare(this.markers())') > td.indexOf('this.creds.deleteAll()'));
});

test('decision 5: a real-credential change during the run is INCONCLUSIVE with attribution; FAIL only if it coincides with the jailed copy\'s refresh', (t) => {
  const root = tmpRoot(t, 'md-lb-incon-');
  const mk = (name) => { const real = path.join(root, name, 'real.json'); fs.mkdirSync(path.dirname(real), { recursive: true }); fs.writeFileSync(real, '{"t":"a"}'); const past = new Date(Date.now() - 3_600_000); fs.utimesSync(real, past, past); return real; };
  // (1) the live floor refreshes the real file; the jailed copy is untouched: INCONCLUSIVE.
  const c1 = new lb.Credentials();
  const r1 = mk('one');
  c1.copy('claude', r1, path.join(root, 'jail1', '.credentials.json'));
  fs.writeFileSync(r1, '{"t":"live-floor-refresh"}');
  c1.deleteAll();
  const v1 = c1.verifyRealUnchanged()[0];
  assert.equal(v1.verdict, 'INCONCLUSIVE');
  assert.match(v1.attribution, /no write path to it/);
  // (2) the jailed copy refreshed AND the real file changed at the same moment: FAIL.
  const c2 = new lb.Credentials();
  const r2 = mk('two');
  const d2 = path.join(root, 'jail2', 'auth.json');
  c2.copy('codex', r2, d2);
  fs.writeFileSync(d2, '{"t":"jail-refresh"}');
  fs.writeFileSync(r2, '{"t":"jail-refresh"}');
  c2.deleteAll();
  assert.equal(c2.verifyRealUnchanged()[0].verdict, 'FAIL');
  // (3) nothing changed: UNCHANGED.
  const c3 = new lb.Credentials();
  const r3 = mk('three');
  c3.copy('codex', r3, path.join(root, 'jail3', 'auth.json'));
  c3.deleteAll();
  assert.equal(c3.verifyRealUnchanged()[0].verdict, 'UNCHANGED');
  assert.match(src, /this\.check\(c\.verdict !== 'FAIL', `credentials: the REAL \$\{c\.label\} file/);
});

test('R4 FAIL-CLOSED on TRAVERSAL (Dwight x2): a root readdir, an lstat or a nested readdir failure keeps everything and aborts before the build and any credential copy', (t) => {
  const mkStale = () => {
    const tmp = tmpRoot(t, 'md-lb-sweeptrav-');
    const stale = path.join(tmp, 'md-layerb-2026-09-03T10-00-00-000Z');
    const cred = path.join(stale, 'jail', 'home', '.claude', '.credentials.json');
    fs.mkdirSync(path.dirname(cred), { recursive: true });
    fs.writeFileSync(cred, 'secret');
    return { tmp, stale, cred };
  };
  const real = (d) => fs.readdirSync(d, { withFileTypes: true });
  const injections = {
    'root readdir': (x) => ({ readdir: (d) => { if (path.resolve(d) === path.resolve(x.tmp)) throw new Error('EACCES (injected root)'); return real(d); } }),
    'lstat': () => ({ lstat: () => { throw new Error('EPERM (injected lstat)'); } }),
    'nested readdir': (x) => ({ readdir: (d) => { if (path.resolve(d) === path.resolve(path.join(x.stale, 'jail'))) throw new Error('EIO (injected nested)'); return real(d); } })
  };
  for (const [name, inject] of Object.entries(injections)) {
    const x = mkStale();
    let shredCalls = 0; let rmCalls = 0;
    const ops = { ...inject(x), shred: () => { shredCalls++; return true; }, rm: () => { rmCalls++; } };
    const r = lb.sweepStale(x.tmp, null, ops);
    assert.equal(r.ok, false, `${name}: not clean`);
    assert.match(r.done.map((d) => d.error).join(' '), /injected/, `${name}: the error is reported`);
    assert.equal(rmCalls, 0, `${name}: nothing removed`);
    assert.equal(shredCalls, 0, `${name}: nothing shredded from an incomplete listing`);
    assert.equal(fs.existsSync(x.cred), true, `${name}: the stale credential and its dir stay`);
    // The run method throws: main calls it inside its try, BEFORE the build and the credential copy.
    const run = new lb.LayerB(lb.parseArgs([]));
    run.s = { base: path.join(x.tmp, 'md-layerb-current') };
    const origTmp = os.tmpdir;
    os.tmpdir = () => x.tmp;
    try { assert.throws(() => run.startupSweep(ops), /could not prove the stale credentials gone/, `${name}: startupSweep aborts`); }
    finally { os.tmpdir = origTmp; }
    assert.equal(run.checks.some((c) => !c.ok && /startup sweep/.test(c.label)), true);
  }
  const main = src.slice(src.indexOf('async main() {'));
  const at = main.indexOf('sweep = this.startupSweep();');
  assert.ok(at > 0 && at < main.indexOf('this.build()') && at < main.indexOf('this.installCredentials()') && at < main.indexOf('this.codexSandboxHelp()'));
  assert.ok(at > main.indexOf('try {'), 'inside the try: the teardown still runs');
  // The sweep has no catch that continues silently.
  const sw = src.slice(src.indexOf('function sweepStale('), src.indexOf('class LiveWatch {'));
  assert.ok(!/catch \{\s*(continue|return[^;]*ok: true)/.test(sw), 'no silent skip or clean return on an error');
  assert.ok(!/walk\(/.test(sw), 'the lenient walk() helper is not used by the sweep');
});

test('the other swallowing catches fail closed: an unreadable live location, an unreadable real credential, an unreadable token source', (t) => {
  // Live watch: a root that exists but cannot be listed is a FAILURE, not an empty (clean) listing.
  const root = tmpRoot(t, 'md-lb-livefail-');
  const w = new lb.LiveWatch([root], []).start();
  const orig = fs.readdirSync;
  fs.readdirSync = (d, ...rest) => { if (path.resolve(String(d)) === path.resolve(root)) { const e = new Error('EACCES (injected)'); e.code = 'EACCES'; throw e; } return orig.call(fs, d, ...rest); };
  let r;
  try { r = w.compare(['lb-claude']); } finally { fs.readdirSync = orig; }
  assert.equal(r.ok, false);
  assert.match(r.failures.join(' '), /cannot stat\/hash a live location/);
  // A MISSING live root (MunderDevData may not exist) is not an error.
  const w2 = new lb.LiveWatch([path.join(root, 'absent')], [path.join(root, 'absent.json')]).start();
  assert.equal(w2.compare(['x']).ok, true);
  // The real credential unreadable at the end: FAIL, never "inconclusive" or "unchanged".
  const c = new lb.Credentials();
  const realF = path.join(root, 'real.json');
  fs.writeFileSync(realF, '{}');
  c.copy('codex', realF, path.join(root, 'jail', 'auth.json'));
  c.deleteAll();
  fs.rmSync(realF);
  assert.equal(c.verifyRealUnchanged()[0].verdict, 'FAIL');
  // A token source that exists but cannot be read ABORTS (it would otherwise count as 0 tokens).
  const run = new lb.LayerB(lb.parseArgs([]));
  const dir = path.join(root, 'ledger-is-a-dir.jsonl');
  fs.mkdirSync(dir);
  assert.deepEqual(run.tokenLines(dir), []);
  assert.equal(run.aborted(), true);
  assert.match(String(run.abort.signal.reason.message), /cannot read the token source/);
  assert.deepEqual(new lb.LayerB(lb.parseArgs([])).tokenLines(path.join(root, 'absent.jsonl')), [], 'a missing source is simply empty');
});

test('J1/J2 wiring: the runner narrows the Claude jail roots and keeps both credential copies outside every read root', () => {
  assert.match(src, /this\.jailRoots = \{ readRoots: \[claude\.cwd, claude\.dir\], writeRoots: \[claude\.cwd, path\.join\(claude\.dir, 'outbox'\)\] \};/);
  assert.match(src, /protectPaths: \[s\.jail, codexDir, this\.jailPolicy, this\.jailLog, s\.stubs, path\.join\(s\.hive, 'state'\)\]/);
  assert.match(src, /if \(inside\(c\.dest, r\)\) throw new Error\(`the \$\{c\.label\} credential copy/);
  // Where the copies go (jail home; the Codex agent's own home) is outside both read roots by layout.
  const home = 'C:\\sb\\jail\\home'; const work = 'C:\\sb\\work\\lb-claude'; const cdir = 'C:\\sb\\devroot\\hive\\agents\\lb-claude';
  for (const cred of [path.join(home, '.claude', '.credentials.json'), 'C:\\sb\\devroot\\hive\\agents\\lb-codex\\.codex\\auth.json']) {
    assert.equal(lb.inside(cred, work) || lb.inside(cred, cdir), false, cred);
  }
  // The installed-hook proof covers J1/J2 too.
  const proof = src.slice(src.indexOf('proveClaudeJail() {'), src.indexOf('codexSandboxHelp() {'));
  assert.match(proof, /'deny', \{ tool_name: 'Grep', tool_input: \{ pattern: 'refresh_token', path: this\.s\.base \} \}/);
  assert.match(proof, /'deny', \{ tool_name: 'Write', tool_input: \{ file_path: path\.join\(claude\.dir, 'inbox', 'forged\.json'\)/);
});

test('god 1a3c97 catch sweep (runner): listing, reading, monitoring and cleanup errors FAIL instead of looking clean', (t) => {
  const root = tmpRoot(t, 'md-lb-catch-');
  // walk(): a missing dir is empty; any other listing error THROWS (injected).
  assert.deepEqual(lb.walk(path.join(root, 'absent'), () => true), []);
  const orig = fs.readdirSync;
  fs.readdirSync = function (d, ...rest) { if (path.resolve(String(d)) === path.resolve(root)) { const e = new Error('EACCES (injected)'); e.code = 'EACCES'; throw e; } return orig.call(fs, d, ...rest); };
  try { assert.throws(() => lb.walk(root, () => true), /cannot list .*EACCES/); } finally { fs.readdirSync = orig; }
  // readJsonStrict: missing -> the given default; unreadable or unparseable -> throw.
  assert.deepEqual(lb.readJsonStrict(path.join(root, 'none.json'), { entries: {} }), { entries: {} });
  assert.throws(() => lb.readJsonStrict(path.join(root, 'none.json')), /cannot read/);
  fs.writeFileSync(path.join(root, 'bad.json'), '{"entries": ');
  assert.throws(() => lb.readJsonStrict(path.join(root, 'bad.json'), {}), /cannot parse/);
  // Evidence lines: only the LAST line may be half-written; an earlier bad line fails a check once.
  const run = new lb.LayerB(lb.parseArgs([]));
  const f = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(f, '{"a":1}\nnot json\n{"b":2}\n{"half":');
  assert.deepEqual(run.tokenLines(f), [{ a: 1 }, { b: 2 }]);
  run.tokenLines(f);
  assert.equal(run.checks.filter((c) => !c.ok && /every evidence line parses/.test(c.label)).length, 1, 'one failed check, not one per poll');
  const fine = new lb.LayerB(lb.parseArgs([]));
  fs.writeFileSync(path.join(root, 'ok.jsonl'), '{"a":1}\n{"half":');
  assert.deepEqual(fine.tokenLines(path.join(root, 'ok.jsonl')), [{ a: 1 }]);
  assert.equal(fine.checks.length, 0, 'a half-written LAST line is normal');
  // Source pins for the rest (each was a catch that continued).
  assert.match(src, /catch \(e\) \{ if \(!this\.aborted\(\)\) \{ this\.check\(false, 'a run monitor kept working', e\.message\); this\.stop\(`a monitor failed/, 'a failing monitor stops the run');
  assert.match(src, /claudeEvents\(\) \{ return this\.claudeTranscripts\(\)\.flatMap\(\(f\) => this\.tokenLines\(f\)\); \}/);
  assert.match(src, /codexEvents\(\) \{ return this\.codexRollouts\(\)\.flatMap\(\(f\) => this\.tokenLines\(f\)\); \}/);
  assert.match(src, /rows\(\) \{ return walk\([^\n]*\.flatMap\(\(f\) => this\.tokenLines\(f\)\); \}/);
  const rb = src.slice(src.indexOf('async factRollback() {'), src.indexOf('async stopApp('));
  assert.match(rb, /catch \(e\) \{ if \(e && e\.code === 'ENOENT'\) return \[\]; throw new Error\(`cannot list/, 'rollback: an unreadable inbox is an error');
  assert.match(rb, /readJsonStrict\(path\.join\(s\.hive, 'state', 'mail'/, 'rollback: an unreadable ledger is an error');
  assert.match(rb, /const reg = readJsonStrict\(path\.join\(s\.hive, 'registry\.json'\)\);/);
  assert.match(src, /async relaunchForPhaseB\(\) \{[\s\S]*?const reg = readJsonStrict\(path\.join\(s\.hive, 'registry\.json'\)\);/);
  const td = src.slice(src.indexOf('async teardown() {'), src.indexOf('// ── evidence + report'));
  assert.match(td, /this\.check\(false, 'out\/ rebuilt without the layer-b seams', e\.message\)/);
  assert.match(td, /this\.check\(false, 'the 1\.1\.74 worktree removed', e\.message\)/);
  assert.match(td, /this\.check\(false, 'the evidence was collected', e\.message\)/);
  assert.match(td, /this\.check\(sandboxRemoved, 'the sandbox was removed'/);
  assert.match(src, /this\.check\(skipped\.length === 0, 'every evidence file was copied'/);
  assert.match(src, /jailRefreshed === true && \(jailMtime === null \|\| Math\.abs/, 'an unknown jail refresh time cannot rule out correlation');
});

test('B6 tier 1: the token-delta verdict (FAIL >= 50% of the earlier blocks, PASS < 10%, NOT-PROVEN between)', () => {
  const t0 = Date.parse('2026-09-28T10:00:00Z');
  const at = (s) => new Date(t0 + s * 1000).toISOString();
  const nonces = ['LBN-00000001', 'LBN-00000002', 'LBN-00000003', 'LBN-00000004'];
  const blocks = [2000, 2000, 2000, 100];
  /** 4 turns; turn k's first request has input in[k]; each turn outputs 50 tokens; a 400-char tool output per turn. */
  const rollout = (inputs, extra = []) => {
    const ev = [];
    inputs.forEach((inp, k) => {
      const s = k * 100 + 1;
      ev.push({ timestamp: at(s), type: 'event_msg', payload: { type: 'task_started' } });
      ev.push({ timestamp: at(s + 1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x'.repeat(40) }] } });
      ev.push({ timestamp: at(s + 2), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: inp, output_tokens: 50 } } } });
      ev.push({ timestamp: at(s + 3), type: 'response_item', payload: { type: 'function_call_output', output: 'y'.repeat(400) } });
    });
    return [...ev, ...extra];
  };
  const opts = { turnStart: [t0, t0 + 100_000, t0 + 200_000, t0 + 300_000], nonces, blocks };
  // growth = outputs 3*50 + text ~((40+400)*3 + 40 + quoting)/4; build in4 from a chosen retention.
  const base = lb.b6Tiers(rollout([10_000, 10_000, 10_000, 10_000]), opts);
  assert.ok(base.retained !== null, base.tier1);
  const growthPlus = 10_000 - base.retained;   // in4 that means "exactly zero retained" is in1 + (10k - retained)
  const verdictAt = (retained) => lb.b6Tiers(rollout([10_000, 10_000, 10_000, growthPlus + retained]), opts);
  assert.equal(verdictAt(0).verdict, 'PASS');
  assert.equal(verdictAt(550).verdict, 'PASS', '9% of 6000');
  assert.equal(verdictAt(1200).verdict, null, '20%: NOT-PROVEN');
  assert.equal(verdictAt(3000).verdict, 'FAIL', '50%');
  assert.equal(verdictAt(6000).verdict, 'FAIL', 'full retention');
  assert.match(verdictAt(6000).tier1, /100% of the 6000 earlier-block tokens -> FAIL/);
  // Fewer than 4 turns: not measurable, no verdict.
  assert.equal(lb.b6Tiers(rollout([10_000, 10_000]), opts).verdict, null);
  // <hive-mail> text never counts as growth.
  assert.equal(lb.withoutMail('a<hive-mail id="x">body</hive-mail>b'), 'ab');
});

test('B6 tier 2: only items carrying an earlier nonce AT/AFTER turn 4 count as retained; after a compaction, replacement_history instead', () => {
  const t0 = Date.parse('2026-09-28T10:00:00Z');
  const at = (sec) => new Date(t0 + sec * 1000).toISOString();
  const opts = { turnStart: [t0, t0 + 100_000, t0 + 200_000, t0 + 300_000], nonces: ['LBN-0000000a', 'LBN-0000000b', 'LBN-0000000c', 'LBN-0000000d'], blocks: [2000, 2000, 2000, 100] };
  const starts = [1, 101, 201, 301].map((sec) => ({ timestamp: at(sec), type: 'event_msg', payload: { type: 'task_started' } }));
  const own = { timestamp: at(5), type: 'response_item', payload: { type: 'message', role: 'developer', content: '<hive-mail>LBN-0000000a</hive-mail>' } };
  let r = lb.b6Tiers([...starts, own], opts);
  assert.equal(r.tier2Retained, 0, 'turn 1\'s own block in turn 1 is not retention');
  const late = { timestamp: at(305), type: 'response_item', payload: { type: 'message', role: 'developer', content: '<hive-mail>LBN-0000000a</hive-mail>' } };
  r = lb.b6Tiers([...starts, own, late], opts);
  assert.equal(r.tier2Retained, 1);
  assert.match(r.tier2, /AT\/AFTER turn 4 started \(retained into turn 4\): 1/);
  const compacted = { timestamp: at(250), type: 'compacted', payload: { replacement_history: [{ content: 'LBN-0000000b' }] } };
  assert.match(lb.b6Tiers([...starts, own, compacted], opts).tier2, /replacement_history carries 1 of the turn 1-3 nonces \(LBN-0000000b\)/);
});

test('rulings wired: B6 tier 3 asks for turn 1\'s nonce; B7 forces /compact, retries once, PASS only if the MAIL SURVIVES, GATE-BLOCKED otherwise; B4 needs a genuine resume', () => {
  assert.match(src, /what was the LBN- token in the FIRST hive mail/);
  assert.match(src, /const recalled = !!r4 && r4\.includes\(nonces\[0\]\);/);
  assert.match(src, /TIER 1 \(decides\): \$\{t\.tier1\}\. TIER 2: \$\{t\.tier2\}\. TIER 3: \$\{tier3\}/);
  // B7
  const b7 = src.slice(src.indexOf('async factB7() {'), src.indexOf('factN4() {'));
  assert.match(b7, /for \(let attempt = 1; attempt <= 2; attempt\+\+\)/, 'one retry');
  assert.match(b7, /writePty\(.*, '\/compact', 'HUMAN'\)/, '/compact typed into the running turn');
  assert.match(b7, /const status = !hit \? 'GATE-BLOCKED' : \(hit\.resurfaced \|\| hit\.recallable \? 'PASS' : 'FAIL'\);/);
  assert.match(b7, /const resurfaced = midEpoch && hist\.some\(\(h, i\) => h\.t >= firstCompact/, 're-surfaced AFTER the compaction');
  assert.match(b7, /const recallable = midEpoch && !!reply && replyAt !== null && replyAt > firstCompact;/, 'recalled AFTER the compaction');
  assert.ok(!/this\.fact\('B7', 'PASS'/.test(src));
  assert.ok(!/this\.fact\('B7', 'NOT-PROVEN', (?!this\.dryNote)/.test(src), 'B7 is never NOT-PROVEN outside the dry run');
  assert.match(src, /unproven\(id\) \{ return id === 'B7' && !this\.args\.dryRun \? 'GATE-BLOCKED' : 'NOT-PROVEN'; \}/);
  // B4
  const b4 = src.slice(src.indexOf('async factB4() {'), src.indexOf('async factB3() {'));
  assert.match(b4, /const status = !reply \|\| !resume\.same \? 'NOT-PROVEN' : \(v2 && !v1 \? 'PASS' : 'FAIL'\);/);
  assert.match(b4, /return \{ same: sameId && grew,/);
  assert.match(src, /this\.relaunchAt = Date\.now\(\);\s*await this\.launch\(this\.exe175, '1\.1\.75 \(phase B\)'\);/);
  // B6 status comes from tier 1 (a measured verdict), never from "nothing found".
  assert.match(src, /const status = !all4 \|\| t\.verdict === null \? 'NOT-PROVEN' : t\.verdict;/);
  // Only PASS passes.
  assert.match(src, /asserted\.every\(\(f\) => f\.status === 'PASS'\)/);
});
