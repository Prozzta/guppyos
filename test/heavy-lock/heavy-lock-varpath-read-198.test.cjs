'use strict';

/**
 * HEAVY-LOCK-VARPATH-READ (god 14896f, design approved NARROW in 09dae8). 2026-10-22 15:35Z/15:36Z:
 * Dwight's read-only PowerShell (Codex) calls were denied as "$logs (a path the lock cannot name)" and
 * "$_ (a path the lock cannot name)" while Jim held the slot. Root cause: the classifier reads every
 * command as sh, where a bare `$cmd` RUNS its value; in PowerShell a bare variable is a value it
 * prints (`$logs | ForEach-Object {...}`, `{ $_ | Out-Null }`), and only `& $x` / `. $x` call one.
 * Codex hooks arrive as "Bash", so the tool name cannot say which shell. Narrow fix: a lone variable
 * is a value only when the same command assigned THAT variable PowerShell's way (`$logs = ...`, which
 * is no sh assignment), or for `$_` / `$PSItem` inside a PowerShell script block.
 *
 * Folded in (god): a directory is not a program. god's 12:21Z read-only chain took the slot as bench
 * on `./term --help` in hive/bin, where term is a FOLDER. A path that is a folder (with no runnable
 * sibling the shell would pick instead) is light; a path with nothing there stays provisional.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
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
const { HookServer } = loadTs(HKF);
const LIGHT = { heavy: false };

const K = {};

K.todaysReads = (M = HJ) => {
  const c = (cmd) => M.classifyCommand(cmd, 0, {});
  // The shapes of Dwight's two denials (the deny rows keep no command text) and their kin.
  for (const cmd of [
    "$logs = Get-ChildItem C:\\Dunder\\hive -Filter 'log*.jsonl'; $logs | ForEach-Object { Get-Content $_ -Tail 5 }",
    "$logs = Get-ChildItem C:\\Dunder\\hive -Filter 'log*.jsonl'\n$logs | Select-Object -First 3",
    '$logs=Get-ChildItem C:\\x; $logs',
    '$logs = Get-ChildItem C:\\x; ${logs} | Measure-Object'
  ]) assert.deepEqual(c(cmd), LIGHT, `TODAY'S POWERSHELL READS ARE LIGHT: ${cmd}`);
  for (const cmd of [
    'Get-ChildItem C:\\x | ForEach-Object { $_ | Out-Null }',
    'Get-ChildItem C:\\x | ForEach-Object { $_ }',
    'Get-ChildItem C:\\x | Where-Object { $PSItem } | Select-Object -First 3',
    'Get-ChildItem C:\\x | % { $_ }'
  ]) assert.deepEqual(c(cmd), LIGHT, `$_ IN A SCRIPT BLOCK IS LIGHT: ${cmd}`);
};
test("today's PowerShell reads ($logs = ...; $logs | ..., { $_ }) are light", () => K.todaysReads());

K.psCase = (M = HJ) => {
  assert.deepEqual(M.classifyCommand('$Logs = Get-ChildItem C:\\x; $logs | Select-Object -First 1', 0, {}), LIGHT, 'POWERSHELL NAMES IGNORE CASE');
};
test('PowerShell variable names ignore case', () => K.psCase());

K.failsClosed = (M = HJ) => {
  const why = (cmd) => M.classifyCommand(cmd, 0, {}).why;
  assert.equal(why('$a = 1; $cmd'), "$cmd (a path the lock cannot name)", "A DIFFERENT VARIABLE'S ASSIGNMENT DOES NOT LIGHTEN $cmd");
  assert.equal(why('$cmd'), "$cmd (a path the lock cannot name)", 'A BARE VARIABLE NOBODY ASSIGNED STAYS HEAVY');
  assert.equal(why('$logs | Out-Null; $logs = 1'), "$logs (a path the lock cannot name)", 'A USE BEFORE THE ASSIGNMENT STAYS HEAVY');
  assert.equal(why('$_ | Out-Null'), "$_ (a path the lock cannot name)", '$_ OUTSIDE A SCRIPT BLOCK STAYS HEAVY');
  assert.equal(why('$PSItem'), "$PSItem (a path the lock cannot name)", '$_ OUTSIDE A SCRIPT BLOCK STAYS HEAVY ($PSItem)');
  assert.equal(why('ls x; { $_; }'), "$_ (a path the lock cannot name)", 'A SH GROUP IS NOT A POWERSHELL BLOCK');  assert.equal(why('$env:RUNNER'), "$env:RUNNER (a path the lock cannot name)", '$env:X ALONE IS UNCHANGED');
  // The call operator still runs what it names: an assignment makes the variable a value, not a program.
  assert.equal(why('$p = Get-Command node; & $p'), '& $p (a path the lock cannot name)', '& $x STAYS HEAVY');
  assert.equal(M.classifyCommand('$r = Get-Command node; $r test/tools/run-tests.cjs', 0, {}).heavy, true, 'A VARIABLE WITH ARGUMENTS IS JUDGED BY THEM');
};
test('fails closed: another variable, no assignment, $_ outside a block, sh groups, & $x', () => K.failsClosed());

/** A temp hive/bin: term/ is a folder (as on the floor), tool/ a folder beside tool.cmd, gate a file. */
function binRig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heavy-varpath-'));
  try {
    fs.mkdirSync(path.join(dir, 'term'));
    fs.writeFileSync(path.join(dir, 'term', 'term.cmd'), '@node "%~dp0term" %*\r\n');
    fs.mkdirSync(path.join(dir, 'tool'));
    fs.writeFileSync(path.join(dir, 'tool.cmd'), '@node test/tools/run-tests.cjs\r\n');
    return fn(dir, dir.replace(/\\/g, '/'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** The hook's reader (hooks.ts heavyScriptCtx), built from the module under test. */
const fsCtx = (M, cwd) => M.scriptReaderFor(cwd, (abs) => {
  try { const st = fs.statSync(abs); return st.isFile() ? { size: st.size, text: () => fs.readFileSync(abs, 'utf8') } : null; } catch { return null; }
}, (abs) => { try { return fs.statSync(abs).isDirectory(); } catch { return false; } });

K.directory = (M = HJ) => binRig((dir, d) => {
  const c = (cmd, cwd = null) => M.classifyHeavy('Bash', { command: cmd }, fsCtx(M, cwd));
  assert.deepEqual(c(`cd ${d}; head -c 600 runtime; echo; ./term --help 2>&1 | head -30`), LIGHT, 'A DIRECTORY IS NOT A PROGRAM');
  assert.deepEqual(c('./term --help', dir), LIGHT, 'A DIRECTORY IS NOT A PROGRAM (cwd)');
  assert.deepEqual(c(`T=term; cd ${d}; ./$T --help`), LIGHT, 'A DIRECTORY NAMED THROUGH A VARIABLE IS NOT A PROGRAM');
  const missing = c(`cd ${d}; ./nope --help`);
  assert.equal(missing.provisional, true, 'A MISSING FILE STAYS PROVISIONAL');
  assert.match(missing.why, /^nope \(a script the lock cannot read yet: no such file at /, 'A MISSING FILE STAYS PROVISIONAL (named)');
  assert.equal(c(`cd ${d}; ./tool`).heavy, true, 'A FOLDER WITH A RUNNABLE SIBLING STAYS UNKNOWN');
});
test('a directory is not a program; a missing path and a folder with a runnable sibling stay unknown', () => K.directory());

K.hookDir = (H = HookServer) => binRig((dir, d) => {
  const ctx = H.heavyScriptCtx(dir);
  assert.equal(ctx.dirAt('./term'), true, 'THE HOOK READER SEES A DIRECTORY');
  assert.equal(ctx.dirAt(`${d}/runtime`), false, 'THE HOOK READER SEES A DIRECTORY (none there)');
  assert.equal(ctx.dirAt('./tool'), false, 'THE HOOK READER SEES A DIRECTORY (a runnable sibling)');
});
test('wiring: the hook reader passes a directory check, and a failing one reads as not a directory', () => {
  K.hookDir();
  const ctx = { dirAt: () => { throw new Error('stat failed'); }, readScript: () => null };
  assert.equal(HJ.classifyCommand('./term', 0, ctx).provisional, true, 'A THROWING LOOKUP IS NOT A DIRECTORY');
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
  { name: 'any PowerShell assignment lightens every bare variable', edits: [['  return ctx.psVars?.has(name) === true;\n', '  return (ctx.psVars?.size ?? 0) > 0;\n']],
    killer: 'failsClosed', dies: /A DIFFERENT VARIABLE'S ASSIGNMENT DOES NOT LIGHTEN \$cmd/ },
  { name: '$_ is a value anywhere', edits: [["  if (name === '_' || name === 'psitem') return ctx.psBlock === true;\n", "  if (name === '_' || name === 'psitem') return true;\n"]],
    killer: 'failsClosed', dies: /\$_ OUTSIDE A SCRIPT BLOCK STAYS HEAVY/ },
  { name: 'a lone unnamed variable is always light', edits: [['    if (ws.length === 1) return psValue(ws[0], ctx) ? { heavy: false } : unnamed(ws[0]);\n', '    if (ws.length === 1) return { heavy: false };\n']],
    killer: 'failsClosed', dies: /A DIFFERENT VARIABLE'S ASSIGNMENT DOES NOT LIGHTEN \$cmd/ },
  { name: 'PowerShell assignments are not tracked', edits: [['    if (psName) psVars.add(psName[1].toLowerCase());\n', '']],
    killer: 'todaysReads', dies: /TODAY'S POWERSHELL READS ARE LIGHT/ },
  { name: 'only the spaced `$x = ...` form is tracked', edits: [["    const psName = /^\\$([A-Za-z_][A-Za-z0-9_]*)=/.exec(ws[0]) ?? (", "    const psName = null ?? ("]],
    killer: 'todaysReads', dies: /TODAY'S POWERSHELL READS ARE LIGHT: \$logs=Get-ChildItem/ },
  { name: 'PowerShell names are case-sensitive', edits: [['    if (psName) psVars.add(psName[1].toLowerCase());\n', '    if (psName) psVars.add(psName[1]);\n']],
    killer: 'psCase', dies: /POWERSHELL NAMES IGNORE CASE/ },
  { name: 'a cmdlet block does not mark $_', edits: [['nested(block, depth, { ...ctx, psBlock: true }, ', 'nested(block, depth, ctx, ']],
    killer: 'todaysReads', dies: /\$_ IN A SCRIPT BLOCK IS LIGHT/ },
  { name: 'a directory still reads as an unknown program', edits: [['    if (c.provisional && isDirAt(ws[0], ctx)) return { heavy: false };\n', '']],
    killer: 'directory', dies: /A DIRECTORY IS NOT A PROGRAM/ },
  { name: 'any unreadable ./path is light (a missing file too)', edits: [['    if (c.provisional && isDirAt(ws[0], ctx)) return { heavy: false };\n', '    if (c.provisional) return { heavy: false };\n']],
    killer: 'directory', dies: /A FOLDER WITH A RUNNABLE SIBLING STAYS UNKNOWN|A MISSING FILE STAYS PROVISIONAL/ },
  { name: 'a runnable sibling is ignored', edits: [['        return abs !== null && isDir(abs) && !RUNNABLE_EXTS.some((e) => read(`${abs}${e}`) !== null);\n', '        return abs !== null && isDir(abs);\n']],
    killer: 'directory', dies: /A FOLDER WITH A RUNNABLE SIBLING STAYS UNKNOWN/ },
  { name: "the folder path is not expanded (the command's variables)", edits: [['dirOf(expand(p), cd === undefined ? cd : expand(cd))', 'dirOf(p, cd)']],
    killer: 'directory', dies: /A DIRECTORY NAMED THROUGH A VARIABLE IS NOT A PROGRAM/ },
  { name: 'classifyCommand drops dirAt', edits: [['expand, psVars, ...(dirAt ? { dirAt } : {}), ', 'expand, psVars, ']],
    killer: 'directory', dies: /A DIRECTORY NAMED THROUGH A VARIABLE IS NOT A PROGRAM/ }
];
const HOOK_MUTANTS = [
  { name: 'the hook reader checks isFile, not isDirectory', edits: [['.isDirectory(); } catch { return false; }', '.isFile(); } catch { return false; }']],
    killer: 'hookDir', dies: /THE HOOK READER SEES A DIRECTORY/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const M = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      assert.throws(() => K[m.killer](M), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
  for (const m of HOOK_MUTANTS) {
    await t.test(`mutant (hooks): ${m.name}`, () => {
      const { HookServer: H } = loadTs.fromText(HKF, mutateText(HKF, m.edits, m.name));
      assert.throws(() => K[m.killer](H), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
