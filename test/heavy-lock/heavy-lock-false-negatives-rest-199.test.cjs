'use strict';
require('../tools/own-job.cjs');
/**
 * HEAVY-LOCK-FALSE-NEGATIVES, the rest of the card (Andy's 12:59Z items, after the P1 in
 * heavy-lock-false-negatives-199). Pre-existing false negatives (heavy runs unlocked, which feeds UI-CRAWL):
 *   - `foreach ($s in $suites) { & $s }` and `foreach ($s in @("npm")) { & $s test }` were light: a `&` after
 *     `{` read as sh's background operator and cut the block before the call; and a call of the loop
 *     variable was a value. Now each literal value of the list is CALLED (with the words after it); a list
 *     the lock cannot read is unknown: heavy, provisional.
 *   - `$r = (npm test)`, `[void](npm test)` and `` $r = `npm test` `` were light: a pipeline wrapped as a
 *     value runs; so does a bash backtick substitution (`` r=`npm test` ``).
 *   - `true="npm test"; $true` in bash was light: sh splits an unquoted `$x` on whitespace, so a value that
 *     is a command line runs as that line.
 * The false positive (Andy NIT 2, live 12:20Z: `git show > base.ts && sed ... > probe.cjs && node probe.cjs`
 * was denied "no such file at .../probe.cjs"): a file a `>` redirect, tee or Set-Content of the same command
 * writes is a file the command makes, never "no such file"; one written by echo / printf (no %) / -Value is
 * read as that text (`echo "npm test" > w.ps1; & ./w.ps1` is the suite, definitely).
 * The queue: a provisional denial (a command the lock could not read) enqueued as an EXCLUSIVE bench, so
 * a light command waited for the empty machine and nothing started beside it; it is not known to be a
 * suite or a bench, so it shares a slot and queues as a shared waiter.
 * All paths here are invented or in a jail; the jail's scripts are tiny texts.
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
const HK = loadTs(HKF);

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-fnr-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
fs.writeFileSync(path.join(JAIL, 'light.sh'), 'git status\n');
fs.writeFileSync(path.join(JAIL, 'suite.sh'), 'npm test\n');
fs.writeFileSync(path.join(JAIL, 'pack.ps1'), 'npm test\n');

const NT = ['npm', 'test'].join(' ');
const RUNNER = ['node', 'test/tools/run-tests.cjs'].join(' ');
const ps = (M, cmd, ctx = {}) => M.classifyHeavy('PowerShell', { command: cmd }, { shell: 'powershell', ...ctx });
const sh = (M, cmd, ctx = {}) => M.classifyHeavy('Bash', { command: cmd }, { shell: 'bash', ...ctx });
const jail = (Hm = HK) => Hm.HookServer.heavyScriptCtx(JAIL);
const sure = (g) => g.heavy && !g.provisional;
const prov = (g) => g.heavy && g.provisional === true;

const K = {};

// ── & $loopvar: a foreach CALLS each value of its list ───────────────────────────────────────────

K.loopCall = (M = HJ) => {
  let c = ps(M, `$suites = @("${NT}"); foreach ($s in $suites) { & $s }`);
  assert.ok(sure(c) && c.kind === 'suite', `A FOREACH CALLS EACH LITERAL VALUE: ${JSON.stringify(c)}`);
  c = ps(M, `$Suites = @("${NT}"); foreach ($S in $suites) {& $s}`);
  assert.ok(sure(c) && c.kind === 'suite', `A FOREACH CALLS EACH LITERAL VALUE (names are case-insensitive): ${JSON.stringify(c)}`);
  c = ps(M, 'foreach ($s in @("npm")) { & $s test }');
  assert.ok(sure(c) && c.kind === 'suite', `A LOOP VALUE TAKES THE WORDS AFTER IT: ${JSON.stringify(c)}`);
  c = ps(M, `$suites = @("git status", "${NT}"); foreach ($s in $suites) { & $s }`);
  assert.ok(sure(c) && c.kind === 'suite', `ANY HEAVY VALUE IS THE LOOP'S CLASS: ${JSON.stringify(c)}`);
  // A definite value wins over an unreadable one before it (a provisional is the fallback, not the answer).
  c = ps(M, `$suites = @("./nothere.ps1", "${NT}"); foreach ($s in $suites) { & $s }`, jail());
  assert.ok(sure(c) && c.kind === 'suite', `A DEFINITE VALUE OUTRANKS A PROVISIONAL ONE: ${JSON.stringify(c)}`);
  for (const cmd of ['foreach ($s in $suites) { & $s }', '$suites = Get-ChildItem *.ps1; foreach ($s in $suites) { & $s }', 'foreach ($f in Get-ChildItem) { & $f }',
    '$suites = @($a, "b"); foreach ($s in $suites) { & $s }']) {
    c = ps(M, cmd);
    assert.ok(prov(c), `AN UNKNOWN LIST IS PROVISIONAL: ${cmd}: ${JSON.stringify(c)}`);
    assert.match(c.why, /& \$[sf] \(a path the lock cannot name\)/, `AN UNKNOWN LIST IS PROVISIONAL (why): ${cmd}`);
  }
  for (const cmd of ['foreach ($s in @("git")) { & $s status }', 'foreach ($s in "a","b") { & $s }', 'foreach ($s in $suites) { $s }', `$suites = @("${NT}"); foreach ($s in $suites) { Write-Output $s }`]) {
    assert.deepEqual(ps(M, cmd), { heavy: false }, `A LIGHT LIST IS LIGHT: ${cmd}`);
  }
};
test('PowerShell: `foreach ($s in $suites) { & $s }` calls each value of its list; an unreadable list is provisional', () => K.loopCall());

// ── a pipeline wrapped as a value runs ───────────────────────────────────────────────────────────

K.wrapped = (M = HJ) => {
  for (const cmd of [`$r = (${NT})`, `$r=(${NT})`, `[void](${NT})`, `$null = (${NT})`, `$r = (${NT}); Write-Output $r`, '$r = `npm test`', `[string[]](${NT})`]) {
    const c = ps(M, cmd);
    assert.ok(sure(c) && c.kind === 'suite', `A WRAPPED PIPELINE RUNS: ${cmd}: ${JSON.stringify(c)}`);
  }
  for (const cmd of ['$r = (git status)', '[int](git status)', '$ok = ($true)']) assert.deepEqual(ps(M, cmd), { heavy: false }, `a wrapped light pipeline is light: ${cmd}`);
  for (const cmd of ['r=`npm test`', 'echo `npm test`', 'r=$(npm test)', `(${NT})`]) {
    const c = sh(M, cmd);
    assert.ok(sure(c) && c.kind === 'suite', `A BACKTICK SUBSTITUTION RUNS (bash): ${cmd}: ${JSON.stringify(c)}`);
  }
  assert.deepEqual(sh(M, "echo '`npm test`'"), { heavy: false }, 'a single-quoted backtick runs nothing');
};
test('`$r = (npm test)`, `[void](npm test)`, `$r = `npm test``, bash `r=`npm test``: a wrapped pipeline runs', () => K.wrapped());

// ── bash: an unquoted $x whose value is a command LINE runs as that line ─────────────────────────

K.bashLine = (M = HJ) => {
  for (const cmd of [`true="${NT}"; $true`, `x="${NT}"; $x`, `x='${RUNNER}'; $x`]) {
    const c = sh(M, cmd);
    assert.ok(sure(c) && c.kind === 'suite', `AN UNQUOTED \$x SPLITS INTO ITS LINE (bash): ${cmd}: ${JSON.stringify(c)}`);
  }
  assert.deepEqual(sh(M, 'x="git status"; $x'), { heavy: false }, 'a light line is light');
  // A quoted "$x" is one program named `npm test`: not npm.
  assert.equal(sh(M, `x="${NT}"; "$x"`).kind, undefined, 'a quoted "$x" is one word');
  // PowerShell keeps a path with spaces whole: `& $p` with $p = 'C:\a b\suite.ps1' is that file (unreadable here).
  const c = ps(M, `$p = 'C:\\a b\\nothere.ps1'; & $p`, jail());
  assert.ok(prov(c) && /^nothere\.ps1 /.test(c.why), `PowerShell keeps a path with spaces whole: ${JSON.stringify(c)}`);
  // PowerShell's `$true` stays a value (HEAVY-LOCK-FALSE-POSITIVE).
  assert.deepEqual(ps(M, '$ok=$true; $true'), { heavy: false });
};
test('bash: `true="npm test"; $true` runs npm test (an unquoted $x is split on whitespace)', () => K.bashLine());

// ── a file written earlier in the same command ───────────────────────────────────────────────────

K.written = (M = HJ) => {
  const ctx = jail();
  // The card: a script written by an echo / printf redirect is read as that text: the suite, definitely.
  for (const [run, cmd] of [[ps, `echo "${NT}" > w.ps1; & ./w.ps1`], [ps, `Write-Output "${NT}" > w.ps1; & ./w.ps1`], [sh, `printf '${NT}\\n' > w.sh; bash w.sh`],
    [sh, `echo '${NT}' >> w.sh; bash w.sh`], [sh, `echo -e '${NT}\\n' > w.sh; bash w.sh`], [sh, `echo '${NT}' 1>| w.sh; bash w.sh`], [sh, `echo 'echo hi' > w.sh; echo '${NT}' >> w.sh; bash w.sh`],
    [ps, `Set-Content -Path w.ps1 -Value "${NT}"; & ./w.ps1`], [ps, `Set-Content w.ps1 "${NT}"; & ./w.ps1`], [ps, `Set-Content -LiteralPath w.ps1 -Value 'echo hi'; Add-Content w.ps1 "${NT}"; & ./w.ps1`],
    [ps, `sc w.ps1 "${NT}"; & ./w.ps1`]]) {
    const c = run(M, cmd, ctx);
    assert.ok(sure(c) && c.kind === 'suite', `A LITERAL WRITE IS READ AS ITS TEXT: ${cmd}: ${JSON.stringify(c)}`);
  }
  // ... and a light text is light (the file is not on disk: without the write it would be "no such file").
  for (const [run, cmd] of [[sh, 'echo "git status" > l.sh; bash l.sh'], [ps, 'Set-Content -Path l.ps1 -Value "git status"; & ./l.ps1'], [sh, "printf 'git status\\n' >| l.sh; bash l.sh"]]) {
    assert.deepEqual(run(M, cmd, ctx), { heavy: false }, `A LIGHT LITERAL WRITE IS LIGHT: ${cmd}`);
  }
  assert.ok(!fs.existsSync(path.join(JAIL, 'l.sh')) && !fs.existsSync(path.join(JAIL, 'w.sh')), 'the jail holds none of these');
  // Andy NIT 2 (live 12:20Z): a file made by any other writer in the same command is unknown, never missing.
  for (const [run, cmd] of [[sh, 'git show HEAD:x > base.ts && sed s/a/b/ base.ts > probe.cjs && node probe.cjs'], [sh, 'git show HEAD:x > probe.cjs; node probe.cjs'],
    [sh, 'echo "git $X" > w.sh; bash w.sh'], [sh, "printf '%s\\n' 'git status' > w.sh; bash w.sh"], [sh, 'cat x | tee w.sh; bash w.sh'], [ps, '"git status" | Set-Content w.ps1; & ./w.ps1'],
    [ps, 'git show HEAD:x | Out-File -FilePath w.ps1; & ./w.ps1'], [ps, 'Set-Content w.ps1 $text; & ./w.ps1'], [sh, 'echo "git status" > w.sh; cp suite.sh w.sh; bash w.sh'],
    [sh, "cp suite.sh w.sh; echo 'echo hi' >> w.sh; bash w.sh"]]) {
    const c = run(M, cmd, ctx);
    assert.ok(prov(c), `A FILE MADE BY AN UNREADABLE WRITE IS PROVISIONAL: ${cmd}: ${JSON.stringify(c)}`);
    assert.match(c.why, /\(a script the lock cannot read yet\)$/, `A FILE MADE IN THE COMMAND IS NEVER "NO SUCH FILE": ${cmd}: ${c.why}`);
  }
  // A file on disk overwritten by an unreadable write is not read from disk (the disk holds the old text).
  const c = sh(M, 'git show HEAD:x > light.sh; bash light.sh', ctx);
  assert.ok(prov(c), `AN OVERWRITTEN DISK FILE IS NOT READ FROM DISK: ${JSON.stringify(c)}`);
  // Unchanged: a missing file nobody writes is still named as missing; a write to another file changes nothing.
  assert.match(sh(M, 'node probe.cjs', ctx).why, /no such file at /, 'a file nobody writes is missing');
  assert.deepEqual(sh(M, 'echo x > other.txt; bash light.sh', ctx), { heavy: false });
  assert.deepEqual(sh(M, `echo '${NT}' > /dev/null; bash light.sh`, ctx), { heavy: false }, '/dev/null is no file');
};
test('a script written by a > redirect / Set-Content earlier in the command is read as its text, or unknown: never "no such file"', () => K.written());

K.clobber = (M = HJ) => {
  // stripRedirects read `1>|` as `1>` with the target `|`, so the file stayed an argument of the program.
  const c = sh(M, `echo '${RUNNER}' 1>| w.sh; bash w.sh`, jail());
  assert.ok(sure(c) && c.kind === 'suite' && /\(no filter\)/.test(c.why), `A CLOBBER REDIRECT'S FILE IS NOT AN ARGUMENT: ${JSON.stringify(c)}`);
};
test('`1>| file` is one redirect operator for stripRedirects too', () => K.clobber());

// ── the queue: a provisional denial is a SHARED waiter ───────────────────────────────────────────

function rig(M, limit) {
  let now = 1_000_000; const logs = []; const notes = [];
  const l = new M.HeavyJobLock({ limit: () => limit, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r), notify: (a) => notes.push(a), alive: () => true });
  return { l, logs, notes, tick: (ms) => { now += ms; } };
}
const BENCH = { heavy: true, kind: 'bench', why: 'node bench.cjs' };
const BUILD = { heavy: true, kind: 'build', why: 'npm run build' };
const PROV = { heavy: true, kind: 'bench', why: 'probe.cjs (a script the lock cannot read yet)', provisional: true };

K.shared = (M = HJ) => {
  assert.equal(M.heavyExclusive(PROV), false, 'A PROVISIONAL CLASS IS NOT EXCLUSIVE');
  assert.equal(M.heavyExclusive(BENCH), true, 'a definite bench still is');
  assert.equal(M.heavyExclusive({ ...PROV, kind: 'suite' }), false, 'A PROVISIONAL CLASS IS NOT EXCLUSIVE (suite placeholder)');
  // One slot: Dwight builds; Andy's unreadable probe is denied and queued as a SHARED waiter.
  const x = rig(M, 1);
  assert.equal(x.l.acquire('dwight', BUILD, 'npm run build', 'd1', false).allow, true);
  const d = x.l.acquire('andy', PROV, 'git show > probe.cjs && node probe.cjs', 'a1', false);
  assert.equal(d.allow, false);
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => [w.agentId, w.exclusive]), [['andy', undefined]], 'A PROVISIONAL WAITER IS SHARED');
  assert.ok(!x.logs.some((r) => r.action === 'deny' && r.exclusive), 'the deny row is not exclusive');
  assert.match(d.reason, /This denial is PROVISIONAL/, 'the provisional hint stands');
  // The build ends: the slot is reserved for Andy, not exclusively.
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => [r.agentId, r.exclusive]), [['andy', undefined]], 'A PROVISIONAL RESERVATION IS SHARED');
  // Two slots: a provisional call starts beside a shared holder, and a shared job starts beside it.
  const y = rig(M, 2);
  assert.equal(y.l.acquire('dwight', BUILD, 'npm run build', 'd1', false).allow, true);
  assert.equal(y.l.acquire('andy', PROV, 'node probe.cjs', 'a1', false).allow, true, 'A PROVISIONAL CALL SHARES A SLOT');
  y.l.callDone('dwight', 'd1');
  assert.equal(y.l.acquire('creed', BUILD, 'npm run build', 'c1', false).allow, true, 'A SHARED JOB STARTS BESIDE A PROVISIONAL HOLDER');
  // A definite bench still waits for the empty machine, behind nobody.
  assert.equal(y.l.acquire('jim', BENCH, 'node bench.cjs', 'j1', false).allow, false, 'a definite bench runs alone');
  assert.deepEqual(y.l.queueSnapshot().waiters.map((w) => [w.agentId, w.exclusive]), [['jim', true]]);
};
test('a provisional denial queues as a SHARED waiter (not an exclusive bench); a provisional call shares a slot', () => K.shared());

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
  { file: HJF, name: 'a `&` after `{` is a background operator (today)', edits: [["    if (c === '&' && (!cur.trim() || /[{(]\\s*$/.test(cur)) && cmd[i + 1] !== '&') { cur += '& '; continue; }", "    if (c === '&' && !cur.trim() && cmd[i + 1] !== '&') { cur += '& '; continue; }"]],
    killer: 'loopCall', dies: /A FOREACH CALLS EACH LITERAL VALUE/ },
  { file: HJF, name: 'an unknown list is light', edits: [['      if (items === null) return unnamed(`& ${args[0]}`);', '      if (items === null) return { heavy: false };']],
    killer: 'loopCall', dies: /AN UNKNOWN LIST IS PROVISIONAL/ },
  { file: HJF, name: 'a loop value is one word', edits: [['        const c = classifyWords([...it.split(/\\s+/), ...args.slice(1)], depth + 1, ctx);', '        const c = classifyWords([it, ...args.slice(1)], depth + 1, ctx);']],
    killer: 'loopCall', dies: /A FOREACH CALLS EACH LITERAL VALUE/ },
  { file: HJF, name: 'the first heavy value answers, provisional or not', edits: [['      for (const it of items) {\n        const c = classifyWords([...it.split(/\\s+/), ...args.slice(1)], depth + 1, ctx);\n        if (c.heavy && !c.provisional) return c;\n        if (c.heavy && !maybe) maybe = c;', '      for (const it of items) {\n        const c = classifyWords([...it.split(/\\s+/), ...args.slice(1)], depth + 1, ctx);\n        if (c.heavy) return c;']],
    killer: 'loopCall', dies: /A DEFINITE VALUE OUTRANKS A PROVISIONAL ONE/ },
  { file: HJF, name: 'a bare list item is literal', edits: [['  return items.length && !bare.length && !items.some((w) => COMPUTED.test(w)) ? items : null;', '  return items.length && !items.some((w) => COMPUTED.test(w)) ? items : null;']],
    killer: 'loopCall', dies: /AN UNKNOWN LIST IS PROVISIONAL/ },
  { file: HJF, name: 'a list variable is not looked up', edits: [['      psLoop.set(name, v ? psLists.get(v[1].toLowerCase()) ?? null : psList(list));', '      psLoop.set(name, psList(list));']],
    killer: 'loopCall', dies: /A FOREACH CALLS EACH LITERAL VALUE/ },
  { file: HJF, name: 'a list name is case-sensitive', edits: [['    if (psAssigned) psLists.set(psAssigned[1].toLowerCase(), psList(psAssigned[2]));', '    if (psAssigned) psLists.set(psAssigned[1], psList(psAssigned[2]));']],
    killer: 'loopCall', dies: /A FOREACH CALLS EACH LITERAL VALUE \(names are case-insensitive\)/ },
  { file: HJF, name: 'an assignment\'s wrapped pipeline is not unwrapped', edits: [['  if (rhs) { const inner = depth + 1 < MAX_DEPTH ? unwrapped(rhs) : null;', '  if (rhs) { const inner = null;']],
    killer: 'wrapped', dies: /A WRAPPED PIPELINE RUNS: \$r = \(npm test\)/ },
  { file: HJF, name: 'a cast pipeline is not unwrapped', edits: [['  const cast = /^(?:\\[[A-Za-z0-9.]+(?:\\[\\])?\\])+\\(|^\\$\\(/.test(ws[0]) ? unwrapped(ws) : null;', '  const cast = null;']],
    killer: 'wrapped', dies: /A WRAPPED PIPELINE RUNS: \[void\]/ },
  { file: HJF, name: 'a cast before the parentheses is kept', edits: [["  out[0] = out[0].replace(/^(?:\\[[A-Za-z0-9.]+(?:\\[\\])?\\])+(?=\\$?\\()/, '');\n", '']],
    killer: 'wrapped', dies: /A WRAPPED PIPELINE RUNS: \[void\]/ },
  { file: HJF, name: 'a backtick span is not a substitution', edits: [["    if (c === '`') { const e = cmd.indexOf('`', i + 1); if (e > i) { out.push(cmd.slice(i + 1, e)); i = e; } continue; }\n", '']],
    killer: 'wrapped', dies: /A WRAPPED PIPELINE RUNS: \$r = `npm test`|A BACKTICK SUBSTITUTION RUNS \(bash\): r=`npm test`/ },
  { file: HJF, name: 'a bash $x value is one word', edits: [["      const line = ctx.shell === 'bash' && !quoted && /\\s/.test(program) ? program.split(/\\s+/) : [program];", '      const line = [program];']],
    killer: 'bashLine', dies: /AN UNQUOTED \$x SPLITS INTO ITS LINE/ },
  { file: HJF, name: 'a provisional class is exclusive (today)', edits: [["  return cls.heavy && !cls.provisional && (cls.exclusive === true || cls.kind === 'suite' || cls.kind === 'bench');", "  return cls.heavy && (cls.exclusive === true || cls.kind === 'suite' || cls.kind === 'bench');"]],
    killer: 'shared', dies: /A PROVISIONAL CLASS IS NOT EXCLUSIVE/ },
  { file: HJF, name: 'the waiter row ignores the class', edits: [['    const position = this.enqueue(agentId, kind, !callId.startsWith(\'lease:\'), excl);', '    const position = this.enqueue(agentId, kind, !callId.startsWith(\'lease:\'), true);']],
    killer: 'shared', dies: /A PROVISIONAL WAITER IS SHARED/ },
  { file: HJF, name: 'literal writes are not read', edits: [['heredocWrite(raw, ws, mine[0], here, virtual, key, rewritten) : literalWrite(raw, ws, here, virtual, key, rewritten);', 'heredocWrite(raw, ws, mine[0], here, virtual, key, rewritten) : new Set<string>();']],
    killer: 'written', dies: /A LITERAL WRITE IS READ AS ITS TEXT/ },
  { file: HJF, name: 'an echo write has no text', edits: [['      text = COMPUTED.test(body) ? null : esc ? unescape(body) : body;', '      text = null;']],
    killer: 'written', dies: /A LITERAL WRITE IS READ AS ITS TEXT: echo/ },
  { file: HJF, name: 'a computed echo is literal', edits: [['      text = COMPUTED.test(body) ? null : esc ? unescape(body) : body;', '      text = esc ? unescape(body) : body;']],
    killer: 'written', dies: /A FILE MADE BY AN UNREADABLE WRITE IS PROVISIONAL: echo "git \$X"/ },
  { file: HJF, name: 'a printf format with % is literal', edits: [["      text = fmt === undefined || COMPUTED.test(fmt) || /%/.test(fmt) ? null : unescape(fmt);", "      text = fmt === undefined || COMPUTED.test(fmt) ? null : unescape(fmt);"]],
    killer: 'written', dies: /A FILE MADE BY AN UNREADABLE WRITE IS PROVISIONAL: printf '%s/ },
  { file: HJF, name: 'Set-Content -Value is not read', edits: [['    text = value === undefined || COMPUTED.test(value) ? null : value;', '    text = null;']],
    killer: 'written', dies: /A LITERAL WRITE IS READ AS ITS TEXT: Set-Content/ },
  { file: HJF, name: 'an unreadable write leaves the file missing', edits: [['    if (text === null) { virtual.set(k, null); continue; }', '    if (text === null) continue;']],
    killer: 'written', dies: /A FILE MADE IN THE COMMAND IS NEVER "NO SUCH FILE"/ },
  { file: HJF, name: 'an append to an unknown file reads the disk', edits: [['      if (virtual.get(k) === null || (!virtual.has(k) && rewritten.has(k))) { virtual.set(k, null); continue; }\n', '']],
    killer: 'written', dies: /A FILE MADE BY AN UNREADABLE WRITE IS PROVISIONAL: cp suite\.sh w\.sh; echo/ },
  { file: HJF, name: 'a `1>|` is `1>` with the target `|` (today)', edits: [['    const m = /^(\\d*(?:>\\||>>?|<<?-?|<>)|&>>?|\\*>>?)(&?)(.*)$/.exec(w);', '    const m = /^(\\d*(?:>>?|<<?-?|<>)|&>>?|\\*>>?)(&?)(.*)$/.exec(w);']],
    killer: 'clobber', dies: /A CLOBBER REDIRECT'S FILE IS NOT AN ARGUMENT/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async (tt) => {
      const mutated = loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name));
      await assert.rejects(async () => K[m.killer](mutated, tt), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
  assert.equal(MUTANTS.length, 22, 'the census is complete');
});
