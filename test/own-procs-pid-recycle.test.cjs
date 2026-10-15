'use strict';
/**
 * TEST-GLOB-PID-RECYCLE (1.1.88): a test lists and kills only the processes it started.
 * test-runner-glob listed the Human's HWiNFO64.EXE (pid 20664) as a hung file's child, on
 * ParentProcessId alone, and process.kill'ed it (it survived because it runs elevated). Fake process
 * tables here: an OLDER "child" and a RECYCLED grandchild are ignored and never killed; a pid that
 * changed hands between the snapshot and the kill is not killed. Jim's SHOULDs (audit of e9c99e66):
 * the recorded birth is an exact one-sided rule (no slack), and the pin covers all of test/.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const own = require('./tools/own-procs.cjs');
const { dueFiles, killTree } = require('./tools/file-watchdog.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const T = 1_792_000_000_000;   // the hung file's birth
const R = (pid, ppid, created, name = 'node.exe') => ({ pid, ppid, created, name });
const BOOT = T - 6 * 3600_000;
// The hung file (5000, dead: not in the table), what it really left, and what only LOOKS like it.
const TABLE = [
  R(20664, 5000, BOOT, 'HWiNFO64.EXE'),        // an OLDER "child": its long-gone parent had pid 5000
  R(6000, 5000, T + 300, 'conhost.exe'),       // the file's ConPTY conhost: ours
  R(6001, 6000, T + 400, 'cmd.exe'),           // its grandchild: ours
  R(6002, 6000, T - 60_000, 'svchost.exe'),    // a RECYCLED grandchild: older than its "parent" 6000
  R(7000, 1, T + 50, 'node.exe')               // unrelated
];
/** Fake deps that record every kill; `now` is the table at kill time (default: unchanged). */
const deps = (now = TABLE) => { const kills = []; return { kills, lookup: (pids) => now.filter((r) => pids.includes(r.pid)), kill: (rows) => kills.push(...rows.map((r) => r.pid)) }; };

test('a child is created at or after its parent: an OLDER process naming the parent is not a child', () => {
  const kids = own.childrenOf(TABLE, { pid: 5000, created: T });
  assert.deepStrictEqual(kids.map((r) => r.pid), [6000], 'HWiNFO64.EXE (created at boot) is not the file\'s child');
  assert.deepStrictEqual(own.childrenOf([R(9, 5000, T)], { pid: 5000, created: T }).map((r) => r.pid), [9], 'created at the same ms: a child');
});

test('the tree checks every link: a RECYCLED grandchild (older than its "parent") is not in it', () => {
  assert.deepStrictEqual(own.treeOf(TABLE, { pid: 5000, created: T }).map((r) => r.pid), [6000, 6001]);
});

test('a dead hung file: its orphans are killed, the older "child" and the recycled grandchild are NOT', () => {
  const d = deps();
  const r = own.killOwnTree({ pid: 5000, bornMs: T, name: 'node.exe' }, { table: () => TABLE, ...d });
  assert.deepStrictEqual(d.kills, [6001, 6000], 'deepest first');
  assert.ok(!d.kills.includes(20664) && !d.kills.includes(6002), 'NEVER the Human\'s process');
  assert.deepStrictEqual(r.skipped, []);
});

test('a dead root: orphans only from ORPHAN_LEAD_MS before its birth, and (goneBy known) none after it was gone', () => {
  assert.ok(own.ORPHAN_LEAD_MS > 0 && own.ORPHAN_LEAD_MS <= 1_000, `the orphan lead is bounded: ${own.ORPHAN_LEAD_MS} ms`);
  const rows = [R(6000, 5000, T - own.ORPHAN_LEAD_MS, 'conhost.exe'), R(6005, 5000, T - own.ORPHAN_LEAD_MS - 1, 'svchost.exe')];
  assert.deepStrictEqual(own.ownTree(rows, { pid: 5000, bornMs: T }).tree.map((r) => r.pid), [6000]);
  // NIT-4: ours died, a LATER process took 5000, had children and died too: with goneBy, its children are not ours
  const later = [R(6000, 5000, T + 300, 'conhost.exe'), R(6001, 6000, T + 900_000, 'cmd.exe'), R(6100, 5000, T + 600_000, 'chrome.exe'), R(6101, 6100, T + 600_100, 'chrome.exe')];
  assert.deepStrictEqual(own.ownTree(later, { pid: 5000, bornMs: T, goneBy: T + 1_000 }).tree.map((r) => r.pid), [6000],
    'the later holder\'s children, and their children, are cut; and ours only up to goneBy');
  assert.deepStrictEqual(own.ownTree(later, { pid: 5000, bornMs: T }).tree.map((r) => r.pid).sort(), [6000, 6001, 6100, 6101], 'without goneBy: unbounded (documented)');
});

test('a recorded pid now held by ANOTHER process (created after the birth): a stranger, nothing is killed', () => {
  const table = [R(5000, 4, T + 5_000, 'HWiNFO64.EXE'), R(5100, 5000, T + 5_010, 'HWiNFO64.EXE')];
  const d = deps(table);
  const r = own.killOwnTree({ pid: 5000, bornMs: T, name: 'node.exe' }, { table: () => table, ...d });
  assert.deepStrictEqual(d.kills, [], 'not the stranger, and not the stranger\'s children');
  assert.strictEqual(r.stranger.name, 'HWiNFO64.EXE');
  // a SAME-image reuse 1 ms after the birth: a stranger too (the old 2 s slack called it ours)
  const twin = own.ownTree([R(5000, 4, T + 1)], { pid: 5000, bornMs: T, name: 'node.exe' });
  assert.deepStrictEqual([twin.tree, twin.older], [[], false]);
});

test('the birth rule is exact and one-sided: created at or before bornMs is ours, however long before', () => {
  for (const created of [T, T - 37, T - 317, T - 5_000, T - 3600_000]) {
    const t = own.ownTree([R(5000, 4, created)], { pid: 5000, bornMs: T, name: 'node.exe' });
    assert.deepStrictEqual(t.tree.map((r) => r.pid), [5000], `created ${T - created} ms before the birth: ours`);
  }
  // under load node can take seconds to start: the live root is STILL ours (the 2 s slack made it a stranger,
  // and leftBehind then returned [] while the file still ran)
  const slow = own.ownTree([R(5000, 4, T - 4_000), R(6000, 5000, T - 3_000, 'conhost.exe')], { pid: 5000, bornMs: T, name: 'node.exe' });
  assert.deepStrictEqual(slow.tree.map((r) => r.pid), [5000, 6000]);
  assert.strictEqual(own.stillOurs({ pid: 5000, bornMs: T, name: 'node.exe' }, { table: () => [R(5000, 4, T - 4_000)] }).pid, 5000);
});

test('an OLDER process under the pid with another name cannot be a stranger: the record is wrong, and a run check throws', () => {
  const rows = [R(5000, 4, BOOT, 'HWiNFO64.EXE')];
  const t = own.ownTree(rows, { pid: 5000, bornMs: T, name: 'node.exe' });
  assert.deepStrictEqual([t.tree, t.older, t.stranger.name], [[], true, 'HWiNFO64.EXE']);
  assert.throws(() => own.ownTreeOrThrow(rows, { pid: 5000, bornMs: T, name: 'node.exe' }), /BEFORE the recorded birth/);
  assert.doesNotThrow(() => own.ownTreeOrThrow([R(5000, 4, T + 9)], { pid: 5000, bornMs: T, name: 'node.exe' }), 'a real reuse is a stranger, not an error');
  // test-runner-glob's checks go through it: never an empty, vacuous list on a wrong record
  const glob = readSource('test/test-runner-glob.test.cjs');
  assert.match(glob, /function leftBehind\(rec\) \{\s*const \{ tree \} = own\.ownTreeOrThrow\(own\.processTable\(\), rec\);/);
  assert.match(glob, /function childStillRunning\(rec\) \{[\s\S]*?const \{ root \} = own\.ownTreeOrThrow\(own\.processTable\(\), rec\);/);
});

test('re-verified just before the kill: a pid that died and was REUSED since the snapshot is not killed', () => {
  const later = [R(6000, 5000, T + 300, 'conhost.exe'), R(6001, 77, T + 90_000, 'chrome.exe')];   // 6001 now another program
  const d = deps(later);
  const r = own.killVerified(own.treeOf(TABLE, { pid: 5000, created: T }), d);
  assert.deepStrictEqual(d.kills, [6000]);
  assert.deepStrictEqual(r.attempted.map((x) => x.pid), [6000], 'attempted: handed to the kill, which may still fail');
  assert.deepStrictEqual(r.skipped.map((x) => x.pid), [6001]);
  // reused by the SAME image (another node.exe, another conhost): only the CreationDate tells them apart
  const twin = deps([R(6000, 5000, T + 9_000, 'conhost.exe')]);
  assert.deepStrictEqual(own.killVerified([R(6000, 5000, T + 300, 'conhost.exe')], twin).attempted, []);
  assert.deepStrictEqual(twin.kills, [], 'same pid and name, another birth: not killed');
  // the same pid AND CreationDate under another image name: not the same process either
  assert.strictEqual(own.sameProcess(R(6000, 5000, T + 300, 'conhost.exe'), R(6000, 5000, T + 300, 'HWiNFO64.EXE')), false);
  const other = deps([R(6000, 5000, T + 300, 'HWiNFO64.EXE')]);
  own.killVerified([R(6000, 5000, T + 300, 'conhost.exe')], other);
  assert.deepStrictEqual(other.kills, [], 'same pid and birth, another name: not killed');
  const gone = deps([]);
  assert.deepStrictEqual(own.killVerified([R(6000, 5000, T + 300, 'conhost.exe')], gone).attempted, []);
  assert.deepStrictEqual(gone.kills, [], 'a gone pid: no kill call at all');
});

test('stopIfSame: the PowerShell that stops checks the name AND the CreationDate again, per row, with the list assigned first', { skip: process.platform !== 'win32' && 'win32 only' }, () => {
  const scripts = [];
  own.stopIfSame([R(6000, 5000, T + 300, 'conhost.exe'), R(6001, 6000, T + 400, "o'dd.exe")], (s) => scripts.push(s));
  assert.strictEqual(scripts.length, 1, 'one PowerShell for all rows');
  const s = scripts[0];
  assert.match(s, /^\$list = '\[.*\]' \| ConvertFrom-Json\r?\nforeach \(\$t in \$list\) \{/, 'assigned first: PS 5.1 pipes the array as ONE object');
  assert.match(s, /\$q = Get-CimInstance Win32_Process -Filter "ProcessId=\$\(\$t\.pid\)"/);
  assert.match(s, /if \(\$q -and \$q\.Name -eq \$t\.name -and \(\[DateTimeOffset\]\$q\.CreationDate\)\.ToUnixTimeMilliseconds\(\) -eq \$t\.created\) \{ Stop-Process -Id \$t\.pid /);
  assert.match(s, /"created":1792000000300/);
  assert.match(s, /o''dd\.exe/, 'quotes escaped for the single-quoted PowerShell string');
  own.stopIfSame([], (x) => scripts.push(x));
  assert.strictEqual(scripts.length, 1, 'no rows: no PowerShell');
});

test('watchdog: an OLDER node --test or test-file process under a recycled pid is not due', () => {
  const now = 1_000_000;
  const P = (pid, ppid, name, cmd, age) => ({ pid, ppid, name, cmd, startedAt: now - age });
  const procs = [
    P(10, 1, 'node.exe', 'node run-tests.cjs', 100_000),
    P(20, 10, 'node.exe', 'node.exe --test a.test.cjs', 90_000),
    P(30, 20, 'node.exe', 'node.exe C:/r/test/hung.test.cjs', 6_000),
    P(21, 10, 'node.exe', 'node.exe --test x.test.cjs', 500_000),       // older than the runner
    P(22, 21, 'node.exe', 'node.exe C:/o/test/x.test.cjs', 6_000),
    P(31, 20, 'node.exe', 'node.exe C:/o/test/old.test.cjs', 95_000)    // older than its node --test
  ];
  assert.deepStrictEqual(dueFiles(procs, 10, 5_000, now).map((d) => d.pid), [30]);
  assert.deepStrictEqual(dueFiles(procs.filter((p) => p.pid !== 10), 10, 5_000, now), [], 'no runner row: nothing can be verified');
});

test('watchdog: the tree kill takes the file and its tree, verified, never an older process naming it', () => {
  const now = 1_000_000;
  const P = (pid, ppid, name, age) => ({ pid, ppid, name, cmd: '', startedAt: now - age });
  const procs = [P(30, 20, 'node.exe', 6_000), P(32, 30, 'conhost.exe', 5_000), P(33, 30, 'HWiNFO64.EXE', 900_000)];
  const kills = [];
  const rows = (pids) => procs.filter((p) => pids.includes(p.pid)).map((p) => ({ pid: p.pid, ppid: p.ppid, created: p.startedAt, name: p.name }));
  killTree(procs, 30, { lookup: rows, kill: (rs) => kills.push(...rs.map((r) => r.pid)) });
  assert.deepStrictEqual(kills, [32, 30], 'deepest first: the file LAST, so the run it ends cannot stop the kill halfway');
});

test('parseRows reads pid|ppid|createdMs|name, names with spaces kept', () => {
  assert.deepStrictEqual(own.parseRows('12|4|1792000000000|node.exe\r\n13|12|1792000000001|Some App.exe\r\n\r\njunk'),
    [R(12, 4, 1792000000000), R(13, 12, 1792000000001, 'Some App.exe')]);
});

// ---- THE PIN, over all of test/ (Jim SHOULD-2): reverting the original defect anywhere must fail here ----
const TEST_DIR = __dirname;
function testSources(dir = TEST_DIR, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') testSources(p, out); } else if (/\.(cjs|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p) => path.relative(TEST_DIR, p).split(path.sep).join('/');
/** own-procs is where the rule lives; this file names the patterns it forbids. */
const RULE_FILES = new Set(['tools/own-procs.cjs', 'own-procs-pid-recycle.test.cjs']);
const SOURCES = testSources().filter((p) => !RULE_FILES.has(rel(p))).map((p) => ({ file: rel(p), code: codeOnly(readSource(p), 'x.js') }));
/** Each code line (comments blanked) of each source that matches `re`, as "file:line: text". */
const hits = (re, src = SOURCES) => src.flatMap(({ file, code }) => code.split('\n').map((l, i) => [l, i]).filter(([l]) => re.test(l)).map(([l, i]) => ({ file, line: i + 1, text: l.trim() })));

/**
 * A real taskkill /T (a call that runs taskkill, or a taskkill command line), outside own-procs. The
 * allowed ones only build a product's argv as DATA (fakes that assert what the app would run), or a
 * fake source that a scanner must flag.
 */
const TASKKILL_CALL = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(\s*['"`](?:[^'"`]*[\\/])?taskkill(?:\.exe)?['"`][^;]*\/T\b/i;
const TASKKILL_LINE = /['"`]\s*taskkill(?:\.exe)?\s[^'"`]*\/T\b/i;   // a command line (a test title that names it is not)
const TASKKILL_ALLOW = {
  'sync-child-calls-173.test.cjs': /rogue\(\): void \{ spawnSync\('taskkill'/   // a fake product source the scanner must REJECT
};
test('PIN (all of test/): no taskkill /T outside own-procs (it walks ParentProcessId alone, strangers included)', () => {
  const bad = [...hits(TASKKILL_CALL), ...hits(TASKKILL_LINE)].filter((h) => !(TASKKILL_ALLOW[h.file] && TASKKILL_ALLOW[h.file].test(h.text)));
  assert.deepStrictEqual(bad.map((h) => `${h.file}:${h.line}: ${h.text.slice(0, 140)}`), []);
  // the detector itself: the reverts Jim's mutants made must be caught
  for (const revert of [
    "  try { execFileSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }",
    "    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f']);",
    "  execSync(`taskkill /PID ${pid} /T /F`);"
  ]) assert.strictEqual(hits(/./, [{ file: 'mail-rig/driver.cjs', code: revert }]).some((h) => TASKKILL_CALL.test(h.text) || TASKKILL_LINE.test(h.text)), true, revert);
});

/**
 * A tree walk by ParentProcessId / .ppid outside own-procs. Allowed per file, line by line: a LISTING
 * (the field selected, parsed or carried), a walk that checks CreationDate on the same line, or data.
 */
const PPID = /\bParentProcessId\b|\.ppid\s*===?|===?\s*[\w.]*\.ppid\b/;
const PPID_ALLOW = {
  'tools/file-watchdog.cjs': [/ParentProcessId/, /p\.ppid === parent\.pid && p\.startedAt >= parent\.startedAt/],
  // PowerShell text: ProcTracker's listing (its own reused-pid test), the watcher's and PS_TREE_CMDLINES' walks
  // (each pinned below with its CreationDate check); the codex child picked out of that checked tree
  'tools/layer-b-run.cjs': [/ParentProcessId/, /x\.ppid === l\.pid && \/\^codex/],
  'test-runner-glob.test.cjs': [/ParentProcessId/],                                   // a CreationDate-windowed listing; parse fixtures
  'heavy-job-lock.test.cjs': [/ParentProcessId/],                                     // parse fixtures
  'layer-b-codex-argv.test.cjs': [/c\.ppid === x\.pid/]                               // a fake table
};
test('PIN (all of test/): no tree walk by ParentProcessId alone outside own-procs (an allow-list, each entry a listing or checked)', () => {
  const bad = hits(PPID).filter((h) => !(PPID_ALLOW[h.file] || []).some((re) => re.test(h.text)));
  assert.deepStrictEqual(bad.map((h) => `${h.file}:${h.line}: ${h.text.slice(0, 140)}`), []);
  const lb = SOURCES.find((s) => s.file === 'tools/layer-b-run.cjs').code;
  assert.match(lb, /if \(-not \$c\.CreationDate -or \$c\.CreationDate -lt \$born\[\$x\]\) \{ continue \}/, 'the window watcher\'s walk');
  assert.match(lb, /\$p\.CreationDate -ge \$born\[\$pp\]\) \{ \$ids \+= \$p\.ProcessId/, 'PS_TREE_CMDLINES\' walk');
  const canary = SOURCES.find((s) => s.file === 'tools/packaged-condense-canary.cjs').code;
  assert.match(canary, /own\.treeOf\(rows, r\)/, 'the condense canary\'s tree');
  // the detector itself: Jim's surviving mutant (leftBehind back to a JS ppid-only filter) must be caught
  const revert = { file: 'test-runner-glob.test.cjs', code: '  const tree = own.processTable().filter((r) => r.ppid === rec.pid);' };
  assert.strictEqual(hits(PPID, [revert]).filter((h) => !PPID_ALLOW[h.file].some((re) => re.test(h.text))).length, 1);
});

test('PIN: no process.kill of a recorded or listed pid in the fixed files (process.kill(pid, 0) only probes)', () => {
  for (const f of ['test-runner-glob.test.cjs', 'claude-model-list-180.test.cjs', 'models-refresh-173.test.cjs', 'quit-sweep.electron.test.cjs']) {
    const kills = (SOURCES.find((s) => s.file === f).code.match(/process\.kill\([^)]*\)/g) || []).filter((k) => !/,\s*0\)$/.test(k));
    assert.deepStrictEqual(kills, [], `${f}: no process.kill of a recorded or listed pid`);
  }
});

test('own-procs, real (win32): kills a tree of TWO children it started, and not one recorded with a LATER-reused birth', { timeout: 60_000, skip: process.platform !== 'win32' && 'win32 only' }, async () => {
  const { spawn } = require('node:child_process');
  const start = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); return { c, rec: { pid: c.pid, bornMs: Date.now(), name: 'node.exe' }, exit: new Promise((r) => c.once('exit', r)) }; };
  const a = start(), b = start(), keep = start();
  try {
    await new Promise((r) => setTimeout(r, 500));
    // one call, several rows (PowerShell 5.1 once took the JSON list as ONE object and killed none)
    const rows = own.lookupPids([a.c.pid, b.c.pid]);
    assert.strictEqual(rows.length, 2);
    const r = own.killVerified(rows);
    assert.strictEqual(r.attempted.length, 2);
    await Promise.all([a.exit, b.exit]);
    // Date.now() right after the spawn is ours under the exact rule (no slack)
    assert.strictEqual(own.stillOurs(keep.rec).pid, keep.c.pid, 'the spawner\'s Date.now() is at or after the CreationDate');
    // the pid of a live process, recorded with a birth BEFORE it was created: a reused pid, never killed
    const k = own.killOwnTree({ ...keep.rec, bornMs: keep.rec.bornMs - 3600_000 });
    assert.deepStrictEqual(k.attempted, []);
    assert.ok(k.stranger, 'seen as a stranger');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(keep.c.exitCode, null, 'still running');
  } finally { for (const x of [a, b, keep]) try { x.c.kill(); } catch { /* gone */ } }
});

test('own-procs, real (win32): this process\'s in-process birth estimate is at or after its CreationDate, so it is ours', { skip: process.platform !== 'win32' && 'win32 only' }, () => {
  const [me] = own.lookupPids([process.pid]);
  assert.ok(me, 'this process is in the table');
  const born = own.bornNow();
  assert.ok(me.created <= born, `CreationDate ${me.created} is at or before the estimate ${born} (one-sided rule)`);
  assert.strictEqual(own.ownTree([me], { pid: process.pid, bornMs: born, name: me.name }).root.pid, process.pid);
});
