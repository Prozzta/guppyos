'use strict';
/**
 * ZT-I1-MAIL layer (b): STATIC safety pins on test/tools/layer-b-run.cjs. Nothing here builds,
 * launches the app, a window or any CLI: the runner module is only required (it has no side effect
 * unless it is the main module) and its pure parts are exercised on temp files.
 *
 * Pinned: it is not picked up by `node --test`; every disk mutation goes through its write guard
 * `W`, which refuses the live hive, MunderDevData, the live userData and the real ~/.claude / ~/.codex;
 * the credential copy reads the real file read-only and deletes the copy; the process tracker never
 * adopts a stranger through a reused pid; every child it starts is windowless; it never removes a
 * git worktree; it launches nothing without --go.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSource, codeOnly } = require('./read-source.cjs');
const { selectTestFiles } = require('./tools/run-tests.cjs');

const RUNNER = path.join(__dirname, 'tools', 'layer-b-run.cjs');
const lb = require(RUNNER);
const src = codeOnly(readSource(RUNNER), 'layer-b-run.cjs');

test('the runner is NOT part of node --test (the runner only selects test/*.test.cjs)', () => {
  const entries = fs.readdirSync(path.join(__dirname));
  assert.ok(!selectTestFiles(entries).files.some((f) => /layer-b-run\.cjs$/.test(f)));
  assert.equal(selectTestFiles(fs.readdirSync(path.join(__dirname, 'tools'))).files.length, 0, 'nothing in test/tools is a test file');
  assert.ok(!/\.test\.cjs$/.test(RUNNER));
});

test('W refuses every live location and anything outside the run\'s own roots', () => {
  const home = os.homedir();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lb-static-'));
  try {
    lb.W.allowRoot(root);
    for (const bad of [
      'C:\\Dunder\\hive\\agents\\x\\inbox\\m.json', 'C:\\Dunder\\hive', 'C:\\Dunder\\MunderDevData\\userData\\config.json',
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'munder-difflin', 'config.json'),
      path.join(home, '.claude', '.credentials.json'), path.join(home, '.claude.json'), path.join(home, '.codex', 'auth.json'),
      path.join(os.tmpdir(), 'somewhere-else', 'f.txt')
    ]) {
      assert.throws(() => lb.W.check(bad), /REFUSED/, bad);
      assert.throws(() => lb.W.write(bad, 'x'), /REFUSED/, bad);
      assert.throws(() => lb.W.rm(bad), /REFUSED/, bad);
    }
    // A root that CONTAINS a live location cannot even be registered.
    for (const bad of ['C:\\Dunder', home, 'C:\\']) assert.throws(() => lb.W.allowRoot(bad), /REFUSED/, bad);
    const ok = path.join(root, 'a', 'b.txt');
    lb.W.write(ok, 'x');
    assert.equal(fs.readFileSync(ok, 'utf8'), 'x');
    lb.W.rm(path.join(root, 'a'));
    assert.equal(fs.existsSync(ok), false);
  } finally { lb.W.roots = lb.W.roots.filter((r) => r !== path.resolve(root)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('SOURCE: every disk mutation in the runner goes through W (or is the stub TUI\'s own sandboxed code)', () => {
  const wStart = src.indexOf('const W = {');
  const wEnd = src.indexOf('\n};', wStart);
  const stubStart = src.indexOf('function stubSource(');
  const stubEnd = src.indexOf('`;\n}', stubStart);   // the end of the stub's template literal
  assert.ok(wStart > 0 && wEnd > wStart && stubStart > 0 && stubEnd > stubStart);
  const outside = src.slice(0, wStart) + src.slice(wEnd, stubStart) + src.slice(stubEnd);
  const mutations = outside.match(/fs\.(writeFileSync|appendFileSync|mkdirSync|rmSync|renameSync|copyFileSync|cpSync|unlinkSync|symlinkSync|linkSync|rmdirSync|truncateSync|writeSync)\s*\(/g) || [];
  // The one exception: Credentials.deleteAll removes the COPY through W.check (sync, for 'exit').
  const allowed = outside.match(/fs\.rmSync\(W\.check\(c\.dest\)/g) || [];
  assert.equal(mutations.length, allowed.length, `unguarded disk mutation(s): ${mutations.join(', ')}`);
  // The real credential is only ever opened read-only.
  assert.deepEqual(outside.match(/fs\.openSync\([^)]*\)/g), ["fs.openSync(real, 'r')"]);
  assert.ok(!/writeFile\(|promises/.test(outside), 'no async fs writes either');
});

test('SOURCE: windowless children only, no worktree removal, no fixed canary port, nothing without --go', () => {
  const calls = src.match(/\bspawn(Sync)?\((?:[^()]|\([^()]*\))*\)/g) || [];
  assert.ok(calls.length >= 5);
  for (const c of calls) assert.match(c, /windowsHide: true/, `a child without windowsHide: ${c.slice(0, 120)}`);
  assert.ok(!/worktree['"],\s*['"]remove|worktree remove/.test(src), 'never removes a git worktree');
  assert.ok(!/9333/.test(src), 'free ports, never the canary\'s fixed CDP port');
  assert.ok(!/Start-Process|ShellExecute|\bstart\s+""/i.test(src), 'no shell-launched windows');
  assert.match(src, /if \(!this\.args\.go\) \{[\s\S]{0,200}return 0;/, 'without --go only the preflight runs');
  assert.equal(lb.parseArgs([]).go, false);
  assert.equal(lb.parseArgs(['--dry-run-stubs']).dryRun, true);
  assert.throws(() => lb.parseArgs(['--claude-model', 'x; rm -rf']), /bad model id/);
  // The app env: MUNDER_DEV + MUNDER_HIDDEN + the sandbox root, from the rig allowlist.
  assert.match(src, /isolation\.rigEnv\(s\.jail, process\.env\)/);
  assert.match(src, /MUNDER_DEV: '1', MUNDER_HIDDEN: '1', MUNDER_DEV_ROOT: s\.devRoot/);
  assert.match(src, /isolation\.checkIsolation\(probe, s\.base/);
  // Caps as the design sets them.
  assert.deepEqual(lb.CAPS, { perAgentTokens: 400_000, totalTokens: 1_000_000, wallMs: 30 * 60_000 });
});

test('Credentials: the real file is read, never changed; the copy is exclusive and deleted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lb-cred-'));
  try {
    lb.W.allowRoot(root);
    const real = path.join(root, 'real', 'auth.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{"decoy":true}');
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(real, past, past);
    const c = new lb.Credentials();
    const dest = path.join(root, 'jail', '.codex', 'auth.json');
    c.copy('codex', real, dest);
    assert.equal(fs.readFileSync(dest, 'utf8'), '{"decoy":true}');
    assert.throws(() => c.copy('codex', real, dest), /EEXIST/, 'exclusive create');
    const del = c.deleteAll();
    assert.deepEqual(del.map((d) => [d.label, d.deleted]), [['codex', true]]);
    assert.equal(fs.existsSync(dest), false);
    assert.deepEqual(c.verifyRealUnchanged().map((v) => v.unchanged), [true]);
    assert.equal(fs.readFileSync(real, 'utf8'), '{"decoy":true}');
  } finally { lb.W.roots = lb.W.roots.filter((r) => r !== path.resolve(root)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('ProcTracker: grows the tree, keeps orphans, and never adopts a stranger through a reused pid', () => {
  const t = new lb.ProcTracker();
  t.addRoot(100);
  const scan = (procs) => t.ingest({ so: JSON.stringify({ procs, visible: [] }), se: '' });
  scan([
    { pid: 100, ppid: 1, name: 'Munder Difflin.exe', created: '1000' },
    { pid: 200, ppid: 100, name: 'node.exe', created: '1100' },
    { pid: 300, ppid: 200, name: 'claude.exe', created: '1200' }
  ]);
  assert.deepEqual([...t.known.keys()].sort(), [100, 200, 300]);
  // 200 exits; its child 301 appears as an orphan (parent gone): still ours.
  scan([{ pid: 100, ppid: 1, name: 'Munder Difflin.exe', created: '1000' }, { pid: 301, ppid: 200, name: 'codex.exe', created: '1300' }]);
  assert.ok(t.known.has(301));
  // pid 200 is REUSED by a stranger; the stranger's child must not be adopted.
  scan([{ pid: 200, ppid: 4, name: 'explorer.exe', created: '5000' }, { pid: 999, ppid: 200, name: 'notepad.exe', created: '5100' }]);
  assert.equal(t.known.has(999), false);
  assert.equal(t.known.get(200).created, '1100', 'the record keeps OUR process identity');
});

// ─── §11.18 items 50-53 (Creed on Q44/Q45)

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

test('B6 tier 2: persisted items carrying an earlier nonce; after a compaction, replacement_history instead', () => {
  const t0 = Date.parse('2026-09-28T10:00:00Z');
  const opts = { turnStart: [t0, t0 + 1, t0 + 2, t0 + 3], nonces: ['LBN-0000000a', 'LBN-0000000b', 'LBN-0000000c', 'LBN-0000000d'], blocks: [2000, 2000, 2000, 100] };
  const item = { timestamp: new Date(t0 + 5000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'developer', content: '<hive-mail>LBN-0000000a</hive-mail>' } };
  assert.match(lb.b6Tiers([item], opts).tier2, /carrying a turn 1-3 nonce: 1/);
  const compacted = { timestamp: new Date(t0 + 6000).toISOString(), type: 'compacted', payload: { replacement_history: [{ content: 'LBN-0000000b' }] } };
  assert.match(lb.b6Tiers([item, compacted], opts).tier2, /replacement_history carries 1 of the turn 1-3 nonces \(LBN-0000000b\)/);
});

test('B6 tier 3 + B7 rulings are wired: turn 4 asks for turn 1\'s nonce; B7 forces /compact, retries once, GATE-BLOCKED otherwise, never NOT-PROVEN in a real run', () => {
  assert.match(src, /what was the LBN- token in the FIRST hive mail/);
  assert.match(src, /const recalled = !!r4 && r4\.includes\(nonces\[0\]\);/);
  assert.match(src, /TIER 1 \(decides\): \$\{t\.tier1\}\. TIER 2: \$\{t\.tier2\}\. TIER 3: \$\{tier3\}/);
  assert.match(src, /for \(let attempt = 1; attempt <= 2; attempt\+\+\)/, 'one retry');
  assert.match(src, /writePty\(.*, '\/compact', 'HUMAN'\)/, '/compact typed into the running turn');
  assert.match(src, /this\.fact\('B7', hit \? 'PASS' : 'GATE-BLOCKED'/);
  assert.match(src, /unproven\(id\) \{ return id === 'B7' && !this\.args\.dryRun \? 'GATE-BLOCKED' : 'NOT-PROVEN'; \}/);
  assert.ok(!/this\.fact\('B7', 'NOT-PROVEN', (?!this\.dryNote)/.test(src), 'B7 is never NOT-PROVEN outside the dry run');
  assert.ok(!/this\.fact\('B7', 'PASS'/.test(src), 'B7 PASS only through the mid-epoch hit');
  // Only PASS passes: the report's ok needs every asserted fact at PASS.
  assert.match(src, /asserted\.every\(\(f\) => f\.status === 'PASS'\)/);
});
