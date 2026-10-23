'use strict';

/**
 * HEAVY-LOCK-FALSE-POSITIVE (god, conv-20ca42, 2026-10-23). Two LIGHT god commands were denied as heavy
 * jobs by the HEAVY-JOB-LOCK PreToolUse hook, queued god (exclusive, bench) behind a running bench, and
 * the slot then reserved for god lapsed unused. The deny rows (hive log.jsonl, kind heavy-lock):
 *   ts 1792723871274 / 1792723876181 (02:51Z, Git Bash)
 *     why "g80.js (a script the lock cannot read yet: no such file at /tmp/g80.js)"
 *     `sed -i ... /tmp/g80.js && node /tmp/g80.js && ledger --file ...`: Git Bash mounts /tmp on the
 *     Windows temp folder (%TEMP%: `cd /tmp && pwd -W`), the lock looked only at C:\tmp\g80.js (nothing
 *     there) and called the script unreadable. Root cause 1: the script reader knew `/c/...` but not `/tmp`.
 *   ts 1792744078868 (08:27:58Z, PowerShell)
 *     why "$true (a path the lock cannot name)"
 *     `heavy release; $ok=$true; foreach ($i in 0..5) { $f="..."; ledger --file $f; if ($LASTEXITCODE -eq 0)
 *     { Remove-Item $f } else { $ok=$false } }; ...`: the assignment's right-hand side `$true` reached the
 *     unnamed-program rule. Root cause 2: a right-hand side that is ONE variable or constant runs nothing.
 *     The same job over a card list (`foreach ($c in $t) { $c | ConvertTo-Json ... }`) failed on `$c`:
 *     root cause 3, a foreach variable is assigned by the loop, not by `=`, so it was not a known name.
 *   The way out: `heavy release` (op unreserve) removes a queued waiter, and no slot is reserved for it
 *   afterwards (pinned here end to end); the deny text of a PROVISIONAL denial now says so, since the
 *   command that would have run `heavy release` was itself the denied one.
 * No agent is allowlisted. Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HKF = 'src/main/hooks.ts';
const HJ = loadTs(HJF);
const H = loadTs(HKF);
const CLI = require('../../resources/heavy-cli.cjs');

/** A fake disk: one script as written under /tmp, one under the agent's TEMP, a runner; nothing else. */
const TEMP = 'C:/Users/x/AppData/Local/Temp';
const FILES = {
  '/tmp/lit.sh': 'echo literal',
  // Andy MINOR 1: C:\tmp really exists on this machine; a light twin there must not hide the %TEMP% script bash runs.
  '/tmp/suite.sh': 'echo a light twin under C:/tmp',
  [`${TEMP}/twin.sh`]: 'npm test',
  '/tmp/twin.sh': 'echo light',
  // Andy NIT 3: a directory under %TEMP% named through /tmp.
  [`${TEMP}/dir`]: { dir: true },
  [`${TEMP}/g80.js`]: "const fs = require('fs'); fs.writeFileSync('C:/Dunder/hive/h1.json', '{}');",
  [`${TEMP}/suite.sh`]: 'node test/tools/run-tests.cjs',
  'C:/w/test/tools/run-tests.cjs': '// the runner',
};
const read = (abs) => { const k = abs.replace(/\\/g, '/'); return k in FILES ? (FILES[k].dir ? { size: 0, dir: true, text: () => '' } : { size: FILES[k].length, text: () => FILES[k] }) : null; };
const ctxOf = (M = HJ, env = { TEMP }) => M.scriptReaderFor('C:/w', read, env);
const c = (cmd, M = HJ, ctx = ctxOf(M)) => M.classifyCommand(cmd, 0, ctx);

const K = {};

// ── root cause 1: Git Bash's /tmp is %TEMP% ──────────────────────────────────────────────────

K.tmpMapped = (M = HJ) => {
  // the 02:51Z rows: the script is there, under the Windows temp folder Git Bash mounts as /tmp.
  for (const cmd of [
    "sed -i 's/cut199/recut/' /tmp/g80.js && node /tmp/g80.js && ledger --file /tmp/g81.json",
    'node /tmp/g80.js',
    'node /tmp/g80.js && ledger --file C:/Dunder/hive/h1.json',
  ]) assert.deepEqual(c(cmd, M), { heavy: false }, `GIT BASH /tmp IS %TEMP%: a light script there reads as light: ${cmd}`);
  // and it is read for what it runs, not waved through: a suite script under /tmp is still the suite.
  assert.deepEqual(c('bash /tmp/suite.sh', M), { heavy: true, kind: 'suite', why: 'node run-tests.cjs (no filter) (in suite.sh)' }, 'A /tmp SCRIPT IS JUDGED BY ITS TEXT');
  // TMP serves when TEMP is unset; without either the lock cannot place /tmp (fail closed, as before).
  assert.deepEqual(c('node /tmp/g80.js', M, ctxOf(M, { TMP: TEMP })), { heavy: false }, 'TMP PLACES /tmp TOO');
  const none = c('node /tmp/g80.js', M, ctxOf(M, {}));
  assert.equal(none.provisional, true, 'NO TEMP IN THE ENV: /tmp STAYS UNPLACEABLE (provisional)');
  assert.match(none.why, /no such file at \/tmp\/g80\.js/);
};
test("root cause 1: `node /tmp/g80.js` reads the script under the agent's TEMP, as Git Bash does", () => K.tmpMapped());

K.tempFirst = (M = HJ) => {
  // Andy MINOR 1: C:\tmp exists on this machine. Git Bash runs %TEMP%\suite.sh for /tmp/suite.sh, so the
  // %TEMP% place is read FIRST in sh; the light twin at C:\tmp\suite.sh must not make the suite light.
  assert.deepEqual(c('bash /tmp/suite.sh', M), { heavy: true, kind: 'suite', why: 'node run-tests.cjs (no filter) (in suite.sh)' }, 'IN SH, /tmp IS %TEMP% FIRST: the heavy %TEMP% script wins over a light C:\\tmp twin');
  assert.deepEqual(c('bash /tmp/suite.sh', M, { ...ctxOf(M), shell: 'powershell' }), { heavy: true, kind: 'suite', why: 'node run-tests.cjs (no filter) (in suite.sh)' }, 'IN SH, /tmp IS %TEMP% FIRST: bash run from the PowerShell tool still reads what bash runs');
  assert.deepEqual(c('bash /tmp/twin.sh', M), { heavy: true, kind: 'suite', why: 'npm test (in twin.sh)' }, 'IN SH, /tmp IS %TEMP% FIRST: twin.sh');
  assert.equal(ctxOf(M).readScript('/tmp/twin.sh'), 'npm test', 'IN SH, /tmp IS %TEMP% FIRST: readScript');
  assert.equal(ctxOf(M).readScript('/tmp/twin.sh', undefined, 'msys'), 'npm test');
  // a path that is in one place only is read wherever it is (a real C:\tmp file, or a non-Windows /tmp).
  assert.deepEqual(c('bash /tmp/lit.sh', M), { heavy: false }, 'A /tmp PATH THAT IS THERE AS WRITTEN ONLY IS READ THERE');
  assert.equal(ctxOf(M).readScript('/tmp/lit.sh'), 'echo literal');
  // PowerShell and cmd run C:\tmp\twin.sh for /tmp/twin.sh: as written first there.
  assert.equal(ctxOf(M).readScript('/tmp/twin.sh', undefined, 'win'), 'echo light', 'IN WIN, /tmp IS AS WRITTEN FIRST');
  assert.deepEqual(c('cmd /c "bash /tmp/twin.sh"', M), { heavy: true, kind: 'suite', why: 'npm test (in twin.sh)' }, 'a bash inside a cmd body still runs the %TEMP% script');
  assert.deepEqual(c('/tmp/twin.sh', M, { ...ctxOf(M), shell: 'powershell' }), { heavy: false }, 'IN WIN, /tmp IS AS WRITTEN FIRST: the PowerShell tool runs C:\\tmp\\twin.sh (light)');
  assert.deepEqual(M.classifyHeavy('PowerShell', { command: '/tmp/twin.sh' }, ctxOf(M)), { heavy: false }, 'THE POWERSHELL TOOL LOOKS AS WRITTEN FIRST');
  assert.deepEqual(M.classifyHeavy('PowerShell', { command: 'cmd /c /tmp/twin.sh' }, ctxOf(M)), { heavy: false }, 'A CMD BODY LOOKS AS WRITTEN FIRST');
  assert.deepEqual(M.classifyHeavy('Bash', { command: '/tmp/twin.sh' }, ctxOf(M)), { heavy: true, kind: 'suite', why: 'npm test (in twin.sh)' }, 'THE BASH TOOL LOOKS AT %TEMP% FIRST');
  // msysTemp maps only /tmp itself and what is under it.
  assert.equal(M.msysTemp('/tmp/a/b.sh', { TEMP }), `${TEMP}/a/b.sh`);
  assert.equal(M.msysTemp('/tmp', { TEMP: `${TEMP}/` }), TEMP);
  assert.equal(M.msysTemp('/tmpx/b.sh', { TEMP }), null);
  assert.equal(M.msysTemp('C:/tmp/b.sh', { TEMP }), null);
  assert.equal(M.msysTemp('/tmp/b.sh', {}), null);
};
test('Andy MINOR 1: in sh, /tmp is %TEMP% first (a light C:\\tmp twin does not hide the suite); as written first for PowerShell and cmd', () => K.tempFirst());

/** Andy NIT 3: a /tmp directory under %TEMP% is a directory (light), not a missing program. */
K.tmpDir = (M = HJ) => {
  assert.equal(ctxOf(M).isDir('/tmp/dir'), true, 'A /tmp DIRECTORY UNDER %TEMP% IS A DIRECTORY');
  assert.deepEqual(c('/tmp/dir --help', M), { heavy: false }, 'A /tmp DIRECTORY UNDER %TEMP% IS A DIRECTORY: running it is light');
  assert.equal(ctxOf(M).missingAt('/tmp/dir'), null, 'A /tmp DIRECTORY UNDER %TEMP% IS A DIRECTORY: not missing');
  assert.equal(ctxOf(M).isDir('/tmp/g80.js'), false, 'a file is not a directory');
  assert.equal(ctxOf(M).isDir('/tmp/nodir'), false, 'a missing path is not a directory');
};
test('Andy NIT 3: a /tmp directory under %TEMP% is a directory', () => K.tmpDir());

/** Andy NIT 1: PowerShell's value rules hold in PowerShell only; in bash `$a = $b` runs $a. */
K.bashValues = (M = HJ) => {
  for (const cmd of ['$ok=$true', '$x = $y', '$true', 'echo hi; $null']) {
    const b = M.classifyHeavy('Bash', { command: cmd }, ctxOf(M));
    assert.equal(b.provisional, true, `IN BASH, A POWERSHELL VALUE IS A PROGRAM (unknown, provisional): ${cmd}`);
    assert.match(b.why, /a path the lock cannot name/, `IN BASH, A POWERSHELL VALUE IS A PROGRAM: ${cmd}`);
    assert.deepEqual(M.classifyHeavy('PowerShell', { command: cmd }, ctxOf(M)), { heavy: false }, `IN POWERSHELL IT IS A VALUE: ${cmd}`);
    assert.deepEqual(c(cmd, M), { heavy: false }, `WITH NO SHELL KNOWN IT IS A VALUE (as before): ${cmd}`);
  }
  // the shell follows the wrapper, not the tool: a bash body inside PowerShell, a PowerShell body inside bash.
  assert.equal(M.classifyHeavy('PowerShell', { command: "bash -c '$x = $y'" }, ctxOf(M)).provisional, true, 'A BASH -c BODY RUNS IN BASH');
  assert.deepEqual(M.classifyHeavy('Bash', { command: "powershell -Command '$x = $y'" }, ctxOf(M)), { heavy: false }, 'A POWERSHELL -Command BODY RUNS IN POWERSHELL');
  assert.deepEqual(M.classifyHeavy('Bash', { command: 'powershell -c "$ok=$true; npm test"' }, ctxOf(M)), { heavy: true, kind: 'suite', why: 'npm test' }, 'and a heavy body is still heavy');
};
test('Andy NIT 1: PS_VALUE / PS_CONST apply in PowerShell only; in bash `$a = $b` runs $a', () => K.bashValues());

K.missingNames = (M = HJ) => {
  // a script that is in neither place stays provisional and the deny names the place Git Bash would look.
  const miss = c('node /tmp/g99.js', M);
  assert.equal(miss.provisional, true, 'A MISSING /tmp SCRIPT STAYS PROVISIONAL');
  assert.equal(miss.why, `g99.js (a script the lock cannot read yet: no such file at ${TEMP}/g99.js)`, 'THE DENY NAMES THE %TEMP% PLACE');
  assert.equal(ctxOf(M).missingAt('/tmp/g99.js'), `${TEMP}/g99.js`, 'THE DENY NAMES THE %TEMP% PLACE: missingAt');
  // Andy MINOR 1: missingAt agrees with the lookup order: the first place tried is named.
  assert.equal(ctxOf(M).missingAt('/tmp/g99.js', undefined, 'win'), '/tmp/g99.js', 'IN WIN THE DENY NAMES THE PATH AS WRITTEN');
  const ps = M.classifyHeavy('PowerShell', { command: 'node /tmp/g99.js' }, ctxOf(M));
  assert.equal(ps.why, 'g99.js (a script the lock cannot read yet: no such file at /tmp/g99.js)', 'IN WIN THE DENY NAMES THE PATH AS WRITTEN: the PowerShell tool');
  assert.equal(ctxOf(M).missingAt('/tmp/g80.js'), null, 'a script that is there is not missing');
  assert.equal(ctxOf(M).missingAt('/tmp/lit.sh'), null);
};
test('root cause 1: a script missing from both places stays provisional and the deny names the %TEMP% place', () => K.missingNames());

/** The hook's own reader (statSync) with a real file under the real TEMP, named through /tmp. */
K.hookReader = (M = HJ, Hm = H) => {
  const temp = process.env.TEMP || process.env.TMP;
  assert.ok(temp, 'this machine has a TEMP');
  const name = `hlfp199-g80-${process.pid}-${Date.now()}.js`;
  const file = path.join(temp, name);
  fs.writeFileSync(file, "const fs = require('fs'); fs.writeFileSync(process.argv[2], JSON.stringify({ ok: true }));\n");
  try {
    const hctx = Hm.HookServer.heavyScriptCtx(os.tmpdir());
    assert.deepEqual(M.classifyCommand(`node /tmp/${name} C:/Dunder/hive/h1.json`, 0, hctx), { heavy: false }, 'GIT BASH /tmp IS %TEMP% (THE HOOK READER): a light script named through /tmp is light');
    assert.deepEqual(M.classifyCommand(`sed -i 's/a/b/' /tmp/${name} && node /tmp/${name} && ledger --file /tmp/x.json`, 0, hctx), { heavy: false }, "god's 02:51Z command shape is light");
  } finally {
    fs.rmSync(file, { force: true });
  }
  const gone = M.classifyCommand(`node /tmp/${name}`, 0, Hm.HookServer.heavyScriptCtx(os.tmpdir()));
  assert.equal(gone.provisional, true, 'the file gone: provisional again');
  assert.match(gone.why, /no such file at [A-Z]:\/.*\/hlfp199-g80-/, 'and the real place is named');
};
test("the hook's reader resolves /tmp/<file> to a real file under TEMP", () => K.hookReader());

// ── root causes 2 and 3: PowerShell values are not programs ──────────────────────────────────

K.psAssignValue = (M = HJ) => {
  for (const cmd of [
    // the 08:27:58Z row: god's loop, with `heavy release` at its head.
    'heavy release; $ok=$true; foreach ($i in 0..5) { $f="C:\\Dunder\\hive\\h$i.json"; ledger --file $f; if ($LASTEXITCODE -eq 0) { Remove-Item $f -Confirm:$false } else { $ok=$false } }; Remove-Item C:\\Dunder\\hive\\h*.json -Confirm:$false; $ok',
    '$ok=$true',
    '$ok = $true; $ok',
    '$x=$y',
    '$x = $null; $x',
    '$t = $env:TEMP; $t',
    '$done = $false; while (-not $done) { $done = $true }',
  ]) assert.deepEqual(c(cmd, M), { heavy: false }, `A ONE-VARIABLE RIGHT-HAND SIDE RUNS NOTHING: ${cmd}`);
};
test("root cause 2: `$ok=$true` and any `$a = $b` assignment runs nothing (god's 08:28Z loop is light)", () => K.psAssignValue());

K.psAssignRuns = (M = HJ) => {
  // the SHAPES-189 rule stands: a right-hand side that runs a command is that command.
  assert.deepEqual(c('$r = npm test', M), { heavy: true, kind: 'suite', why: 'npm test' }, 'A RIGHT-HAND SIDE THAT RUNS A COMMAND IS STILL THAT COMMAND: $r = npm test');
  assert.deepEqual(c('$r=npm ci', M), { heavy: true, kind: 'install', why: 'npm ci' }, 'A RIGHT-HAND SIDE THAT RUNS A COMMAND IS STILL THAT COMMAND: $r=npm ci');
  assert.deepEqual(c('$r = $NODE test/tools/run-tests.cjs', M), { heavy: true, kind: 'suite', why: 'node run-tests.cjs (no filter)' }, 'A RIGHT-HAND SIDE THAT RUNS A COMMAND IS STILL THAT COMMAND: $r = $NODE <runner>');
  assert.deepEqual(c('$r = $cmd test/tools/run-tests.cjs', M), { heavy: true, kind: 'suite', why: 'node run-tests.cjs (no filter)' }, 'A RIGHT-HAND SIDE THAT RUNS A COMMAND IS STILL THAT COMMAND: $r = $cmd <runner>');
  const amp = c('$r = & $exe', M);
  assert.equal(amp.provisional, true, 'A RIGHT-HAND SIDE THAT RUNS A COMMAND IS STILL THAT COMMAND: `& $exe` stays unknown');
  assert.deepEqual(c("$p = 'C:\\x\\mutants.cjs'; node $p", M), { heavy: true, kind: 'bench', why: 'node mutants.cjs' }, 'a named program is still judged by its name (LIVE-FILE-192)');
};
test('required mutant: an assignment whose right-hand side runs a command is still classified as that command', () => K.psAssignRuns());

K.psConst = (M = HJ) => {
  for (const cmd of ['Write-Host hi; $true', 'Get-Content C:\\x.json | Out-Null; $null', 'if ($x) { $false }', '$TRUE'])
    assert.deepEqual(c(cmd, M), { heavy: false }, `A POWERSHELL CONSTANT IS A VALUE: ${cmd}`);
};
test("root cause 2: PowerShell's $true / $false / $null alone are values", () => K.psConst());

K.psConstOnly = (M = HJ) => {
  // only the constants: a variable this command did not assign stays unknown (VARPATH-READ's rule).
  for (const cmd of ['Write-Host hi; $cmd', '$trueish', 'Get-ChildItem; $nullable']) {
    const r = c(cmd, M);
    assert.equal(r.provisional, true, `ONLY THE CONSTANTS ARE VALUES: an unassigned variable stays unknown: ${cmd}`);
    assert.match(r.why, /a path the lock cannot name/);
  }
};
test('required mutant: only $true / $false / $null; an unassigned bare variable stays unknown', () => K.psConstOnly());

K.foreachVar = (M = HJ) => {
  for (const cmd of [
    // the 08:28Z job over the card list: the loop variable is assigned by the loop.
    '$t = Get-Content C:\\Dunder\\hive\\tasks.json | ConvertFrom-Json; foreach ($c in $t) { $c | ConvertTo-Json -Depth 5 | Set-Content C:\\Dunder\\hive\\h1.json; ledger --file C:\\Dunder\\hive\\h1.json }',
    'foreach ($c in (Get-ChildItem C:\\x)) { $c }',
    'foreach($row in $rows){ $row | Out-Null }',
    // PowerShell names are case-insensitive.
    'foreach ($C in $t) { $c | Out-Null }',
  ]) assert.deepEqual(c(cmd, M), { heavy: false }, `A FOREACH VARIABLE IS ASSIGNED BY THE LOOP: ${cmd}`);
  // not any name: another variable in the block stays unknown, and the collection is not assigned.
  for (const cmd of ['foreach ($c in $t) { $d }', 'foreach ($c in $t) { $c }; $t']) {
    const r = c(cmd, M);
    assert.equal(r.provisional, true, `ONLY THE LOOP VARIABLE: ${cmd}`);
    assert.match(r.why, /a path the lock cannot name/);
  }
};
test('root cause 3: `foreach ($c in $t) { $c | ... }` assigns $c for the block', () => K.foreachVar());

// ── the way out: heavy release dequeues, and a provisional denial says so ──────────────────

function rig(M = HJ, limit = 1) {
  let now = 1_000_000; const logs = []; const notes = [];
  const l = new M.HeavyJobLock({
    limit: () => limit, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), alive: () => true
  });
  return { l, logs, notes, tick: (ms) => { now += ms; } };
}
const BENCH = { heavy: true, kind: 'bench', why: 'node bench.cjs' };
const PROV = { heavy: true, kind: 'bench', why: '$true (a path the lock cannot name)', provisional: true };

K.dequeue = async (M = HJ) => {
  // god's 08:28Z: Dwight holds a bench; god's light command is denied provisionally and queued.
  const x = rig(M);
  assert.equal(x.l.acquire('dwight', BENCH, 'node bench.cjs', 'd1', false).allow, true);
  const d = x.l.acquire('god', PROV, 'heavy release; $ok=$true; ...', 'g1', false);
  assert.equal(d.allow, false);
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['god'], 'queued');
  // `heavy release` leaves the queue ...
  const a = await x.l.lease('god', { op: 'unreserve' });
  assert.deepEqual(a, { state: 'unreserved', reserved: false, queued: true, next: null }, 'HEAVY RELEASE REMOVES A QUEUED WAITER');
  assert.deepEqual(x.l.queueSnapshot().waiters, [], 'HEAVY RELEASE REMOVES A QUEUED WAITER: the queue is empty');
  assert.ok(x.logs.some((r) => r.action === 'queue-left' && r.agentId === 'god'), 'and says so in the log');
  // ... so when the bench ends, no slot is reserved for god (the 08:33Z lapse): it is free for anyone.
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(x.l.queueSnapshot().reserved, [], 'HEAVY RELEASE REMOVES A QUEUED WAITER: no slot is reserved for it after');
  assert.deepEqual(x.notes, [], 'no HEAVY SLOT FREE for an agent that left');
  assert.ok(!x.logs.some((r) => r.action === 'reserve' && r.agentId === 'god'));
  assert.equal(x.l.acquire('creed', BENCH, 'node bench.cjs', 'c1', false).allow, true, 'the slot is free at once');
  // a second `heavy release` has nothing to do.
  assert.deepEqual(await x.l.lease('god', { op: 'unreserve' }), { state: 'unreserved', reserved: false, queued: false, next: null });
};
test('the way out: `heavy release` removes a queued waiter, and no slot is reserved for it afterwards', () => K.dequeue());

K.denyHint = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('dwight', BENCH, 'node bench.cjs', 'd1', false);
  const p = x.l.acquire('god', PROV, '$ok=$true', 'g1', false);
  assert.match(p.reason, /This denial is PROVISIONAL \(\$true \(a path the lock cannot name\)\): if the command is in fact light, `heavy release` leaves the queue, and name the file so the lock can read it\.$/, 'A PROVISIONAL DENIAL NAMES THE WAY OUT');
  assert.match(p.reason, /Do not retry this or a variant of it now/, 'the standing text is kept');
  const d = x.l.acquire('jim', { heavy: true, kind: 'install', why: 'npm ci' }, 'npm ci', 'j1', false);
  assert.equal(d.allow, false);
  assert.doesNotMatch(d.reason, /PROVISIONAL|name the file/, 'A DEFINITE DENIAL HAS NO PROVISIONAL HINT');
  // HEAVY-HANDOFF-RACE (c): the standing sentence follows (heavy-lock-handoff-race-199 pins its words).
  assert.match(d.reason, /until you are told\. A reservation you leave unused for 5 min passes on and queues you again at the back, once; `heavy status` shows your standing and `heavy release` leaves the queue\.$/);
};
test('a provisional denial tells the agent that `heavy release` leaves the queue; a definite one does not', () => K.denyHint());

test('the heavy CLI says that release also leaves the queue', async () => {
  let err = '';
  const code = await CLI.main(['leave'], {}, { out: () => {}, err: (s) => { err += s; } });
  assert.equal(code, 2);
  assert.match(err, /usage: heavy status \| heavy release \[--to <agent>\] \| heavy next <agent>\n {2}release: give up my reserved slot, or my place in the queue/);
  assert.equal(CLI.describe({ state: 'unreserved', reserved: false, queued: true, next: null }), 'heavy: left the queue\n');
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

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
  { name: '/tmp is not placed on TEMP', edits: [['  const temp = env?.TEMP || env?.TMP;', "  const temp = '';"]],
    killer: 'tmpMapped', dies: /GIT BASH \/tmp IS %TEMP%/ },
  { name: 'the place as written is tried first in sh (Andy MINOR 1: a light C:\\tmp twin hid the suite)', edits: [["    return t ? (look === 'win' ? [abs, t] : [t, abs]) : [abs];", '    return t ? [abs, t] : [abs];']],
    killer: 'tempFirst', dies: /IN SH, \/tmp IS %TEMP% FIRST/ },
  { name: 'only the mapped place is tried (required: as written when it is there alone)', edits: [["    return t ? (look === 'win' ? [abs, t] : [t, abs]) : [abs];", '    return t ? [t] : [abs];']],
    killer: 'tempFirst', dies: /A \/tmp PATH THAT IS THERE AS WRITTEN ONLY IS READ THERE/ },
  { name: 'the lookup ignores the shell (required: PowerShell and cmd look as written first)', edits: [["    return t ? (look === 'win' ? [abs, t] : [t, abs]) : [abs];", '    return t ? [t, abs] : [abs];']],
    killer: 'tempFirst', dies: /IN WIN, \/tmp IS AS WRITTEN FIRST/ },
  { name: 'the tool name does not set the shell', edits: [['  return cmd ? classifyCommand(cmd, 0, shell && !ctx.shell ? { ...ctx, shell } : ctx) : { heavy: false };', '  return cmd ? classifyCommand(cmd, 0, ctx) : { heavy: false };']],
    killer: 'tempFirst', dies: /THE POWERSHELL TOOL LOOKS AS WRITTEN FIRST/ },
  { name: 'a script is read where the outer shell looks, not where its own shell looks', edits: [['  const look = lookupOf(ctx, dialect);\n  try { text = ctx.readScript(path, ctx.cd, look); }', '  const look = lookupOf(ctx, dialect);\n  try { text = ctx.readScript(path, ctx.cd); }']],
    killer: 'tempFirst', dies: /bash run from the PowerShell tool still reads what bash runs/ },
  { name: 'isDir looks only as written (Andy NIT 3)', edits: [['      const abs = find(p, cd, look);\n      return abs !== null && read(abs)?.dir === true', '      const abs = resolve(p, cd);\n      return abs !== null && read(abs)?.dir === true']],
    killer: 'tmpDir', dies: /A \/tmp DIRECTORY UNDER %TEMP% IS A DIRECTORY/ },
  { name: 'the PowerShell value rules hold in bash too (Andy NIT 1)', edits: [["PS_VALUE.test(rhs[0]) && ctx.shell !== 'bash')", 'PS_VALUE.test(rhs[0]))'], ["PS_CONST.test(v[1]) && ctx.shell !== 'bash')", 'PS_CONST.test(v[1]))']],
    killer: 'bashValues', dies: /IN BASH, A POWERSHELL VALUE IS A PROGRAM/ },
  { name: 'a wrapper body keeps the tool shell', edits: [["      const shell = SH_BINS.has(bin) ? 'bash' as const : /^(powershell|pwsh)$/.test(bin) ? 'powershell' as const : ctx.shell;", '      const shell = ctx.shell;']],
    killer: 'bashValues', dies: /A BASH -c BODY RUNS IN BASH|A POWERSHELL -Command BODY RUNS IN POWERSHELL/ },
  { name: 'a missing /tmp script is light (required: provisional)', edits: [['      if (!at.length || find(p, cd) !== null) return null;', '      return null;']],
    killer: 'missingNames', dies: /A MISSING \/tmp SCRIPT STAYS PROVISIONAL|THE DENY NAMES/ },
  { name: 'the deny names the place tried last', edits: [['      return at[0].replace(', '      return at[at.length - 1].replace(']],
    killer: 'missingNames', dies: /THE DENY NAMES THE %TEMP% PLACE|IN WIN THE DENY NAMES THE PATH AS WRITTEN/ },
  { name: 'the hook passes no env to the reader', file: HKF, edits: [['      }, env),\n      env,\n', '      }),\n      env,\n']],
    killer: 'hookReader', dies: /GIT BASH \/tmp IS %TEMP% \(THE HOOK READER\)/ },
  { name: 'a one-value right-hand side is classified as a program', edits: [["  if (rhs && rhs.length === 1 && PS_VALUE.test(rhs[0]) && ctx.shell !== 'bash') return { heavy: false };\n", '']],
    killer: 'psAssignValue', dies: /A ONE-VARIABLE RIGHT-HAND SIDE RUNS NOTHING/ },
  { name: 'any right-hand side starting with a variable is light (required: `$r = $cmd <runner>` runs)', edits: [['rhs && rhs.length === 1 && PS_VALUE.test(rhs[0])', 'rhs && rhs.length >= 1 && PS_VALUE.test(rhs[0])']],
    killer: 'psAssignRuns', dies: /A RIGHT-HAND SIDE THAT RUNS A COMMAND IS STILL THAT COMMAND: \$r = \$(?:NODE|cmd) <runner>/ },
  { name: 'a lone constant is a program', edits: [["      if (v && PS_CONST.test(v[1]) && ctx.shell !== 'bash') return { heavy: false };\n", '']],
    killer: 'psConst', dies: /A POWERSHELL CONSTANT IS A VALUE/ },
  { name: 'every lone variable is a value (required: only the constants)', edits: [['const PS_CONST = /^(?:true|false|null)$/i;', 'const PS_CONST = /^/;']],
    killer: 'psConstOnly', dies: /ONLY THE CONSTANTS ARE VALUES/ },
  { name: 'a foreach variable is not assigned', edits: [['psVars.add(m[1].toLowerCase());', 'void m;']],
    killer: 'foreachVar', dies: /A FOREACH VARIABLE IS ASSIGNED BY THE LOOP/ },
  { name: 'a foreach variable is case-sensitive', edits: [['psVars.add(m[1].toLowerCase());', 'psVars.add(m[1]);']],
    killer: 'foreachVar', dies: /A FOREACH VARIABLE IS ASSIGNED BY THE LOOP: foreach \(\$C in \$t\)/ },
  { name: 'a provisional denial has no way out', edits: [['${cls.provisional ? ` This denial is PROVISIONAL', '${false ? ` This denial is PROVISIONAL']],
    killer: 'denyHint', dies: /A PROVISIONAL DENIAL NAMES THE WAY OUT/ },
  { name: 'every denial carries the hint (required: a definite one does not)', edits: [['${cls.provisional ? ` This denial is PROVISIONAL', '${true ? ` This denial is PROVISIONAL']],
    killer: 'denyHint', dies: /A DEFINITE DENIAL HAS NO PROVISIONAL HINT/ },
  { name: 'heavy release leaves a queued waiter in the queue', edits: [['    const waiting = !!own?.procs.length || !!this.reservations.get(agentId)?.procs.length;\n    this.dequeue(agentId);\n', '    const waiting = !!own?.procs.length || !!this.reservations.get(agentId)?.procs.length;\n']],
    killer: 'dequeue', dies: /HEAVY RELEASE REMOVES A QUEUED WAITER/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const file = m.file ?? HJF;
      const mutated = loadTs.fromText(file, mutateText(file, m.edits, m.name));
      const run = () => (file === HKF ? K[m.killer](HJ, mutated) : K[m.killer](mutated));
      await assert.rejects(async () => run(), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
