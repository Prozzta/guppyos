'use strict';

/**
 * HEAVY-LOCK-VARPATH-READ (god conv-7efeac; Andy's design and root cause, god's NARROW approval
 * op god-1022-varpath-design). Dwight, 2026-10-22, three deny rows in hive log.jsonl (kind heavy-lock,
 * action deny, heavyKind bench, provisional):
 *   ts 1792683325899  why "$logs (a path the lock cannot name)"
 *   ts 1792683402365  why "$_ (a path the lock cannot name)"
 *   ts 1792689896875  why "$a (a path the lock cannot name)"
 * Root cause: the classifier reads every command as sh, and a segment whose only word is a bare
 * variable (`$logs | ForEach-Object {...}` after `$logs = Get-ChildItem ...`, `$_ | Out-Null` inside
 * the block) reached classifyWords' unnamed-program rule: heavy, provisional, so a harmless PowerShell
 * value expression was refused or took the slot. The rows carry no command text; the shapes here are
 * the card's reconstructions.
 *
 * The narrow rules (everything else stays fail-closed):
 *   - a bare `$var` segment is light only when the SAME command assigns that same variable, in
 *     PowerShell's form (`$var = ...` / `$var=...`); a sh `var=...` is not that;
 *   - `$_` / `$PSItem` are light only inside a `{ }` script block;
 *   - a path that resolves to a DIRECTORY is not a program (light): god's `./term --help` from
 *     hive/bin, where `term` is a folder, was "a script the lock cannot read yet";
 *   - a missing path stays provisional; `& $x`, `. $x`, sh's bare `$cmd`, a named program through
 *     a variable, write targets and test runners are unchanged.
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

/** A reader of a disk with one directory (hive/bin/term), one script and nothing else. */
const DIRS = new Set(['c:/dunder/hive/bin/term', 'c:/dunder/hive/bin']);
const FILES = { 'c:/dunder/hive/bin/light.sh': 'echo hi' };
const norm = (p, cd) => {
  const raw = p.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  const abs = /^([A-Za-z]:\/|\/)/.test(raw) || !cd ? raw : `${cd.replace(/\\/g, '/').replace(/\/+$/, '')}/${raw}`;
  return abs.replace(/^\/([a-z])\//i, '$1:/').replace(/\/\.\//g, '/').toLowerCase();
};
const ctx = {
  readScript: (p, cd) => FILES[norm(p, cd)] ?? null,
  isDir: (p, cd) => DIRS.has(norm(p, cd)),
  missingAt: (p, cd) => { const k = norm(p, cd); return DIRS.has(k) || k in FILES ? null : k; }
};
const c = (cmd, x = ctx) => HJ.classifyCommand(cmd, 0, x);

const K = {};

// ── the deny rows: value expressions are light ───────────────────────────────────────────────

K.logsPipeline = (M = HJ) => {
  const cls = (cmd) => M.classifyCommand(cmd, 0, ctx);
  for (const cmd of [
    // the `$logs` row (ts 1792683325899): the files are listed into a variable, then piped.
    '$logs = Get-ChildItem C:\\Dunder\\hive\\log*.jsonl; $logs | ForEach-Object { Get-Content $_ | Select-String heavy-lock }',
    '$logs=Get-ChildItem C:\\Dunder\\hive\\log*.jsonl; $logs | Select-Object -First 5',
    '$logs = Get-ChildItem C:\\Dunder\\hive\\log*.jsonl | Sort-Object LastWriteTime; $logs',
    // the `$a` row (ts 1792689896875): a value echoed by its name.
    '$a = (Get-Content C:\\Dunder\\hive\\log.jsonl | Measure-Object -Line).Lines; $a',
    // PowerShell names are case-insensitive.
    '$Logs = Get-ChildItem C:\\x; $logs | Measure-Object',
  ]) {
    assert.deepEqual(cls(cmd), { heavy: false }, `A VARIABLE THIS COMMAND ASSIGNS IS A VALUE, NOT A PROGRAM: ${cmd}`);
  }
};
test('deny rows $logs / $a: a bare $var the same command assigned (PowerShell form) is light', () => K.logsPipeline());

K.psItemInBlock = (M = HJ) => {
  const cls = (cmd) => M.classifyCommand(cmd, 0, ctx);
  for (const cmd of [
    // the `$_` row (ts 1792683402365): the pipeline's current item inside the block.
    'Get-ChildItem C:\\Dunder\\hive\\log*.jsonl | ForEach-Object { $_ | Out-Null }',
    'Get-ChildItem C:\\Dunder\\hive\\log*.jsonl | % { Write-Host $_; $_ | Out-Null }',
    'Get-ChildItem C:\\x | ForEach-Object { $PSItem | Select-String deny }',
    'Get-ChildItem C:\\x | ForEach-Object { if ($_.Length -gt 0) { $_ } }',
  ]) {
    assert.deepEqual(cls(cmd), { heavy: false }, `$_ INSIDE A BLOCK IS A VALUE: ${cmd}`);
  }
};
test('deny row $_: $_ / $PSItem inside a { } script block is light (the split-on-; segment too)', () => K.psItemInBlock());

// ── fail-closed: what the narrow rules do NOT lighten ──────────────────────────────────────

K.psItemOutside = (M = HJ) => {
  const cls = (cmd) => M.classifyCommand(cmd, 0, ctx);
  for (const cmd of ['$_ | Out-Null', '$_', 'Get-ChildItem C:\\x | % { echo 1 }; $_ | Out-Null', '$PSItem | Out-Null']) {
    const r = cls(cmd);
    assert.equal(r.heavy, true, `$_ OUTSIDE A BLOCK STAYS UNKNOWN (heavy): ${cmd}`);
    assert.equal(r.provisional, true, `provisional: ${cmd}`);
  }
  assert.equal(cls('$_ | Out-Null').why, '$_ (a path the lock cannot name)', "the deny row's text is unchanged outside a block");
};
test('required mutant: $_ outside a { } block stays heavy, provisional (also after a block closed)', () => K.psItemOutside());

K.otherVar = (M = HJ) => {
  const cls = (cmd) => M.classifyCommand(cmd, 0, ctx);
  for (const cmd of ['$a = 1; $cmd', '$cmd', 'cmd=$(which npm); $cmd', 'CMD="$(cat run.txt)"; $CMD', '$cmd; $cmd = 1', '$a = 1; $env:cmd']) {
    const r = cls(cmd);
    assert.equal(r.heavy, true, `A DIFFERENT VARIABLE'S ASSIGNMENT DOES NOT LIGHTEN $cmd (sh's x=... is not PowerShell's): ${cmd}`);
    assert.equal(r.provisional, true, `provisional: ${cmd}`);
  }
  assert.equal(cls('$a = 1; $cmd').why, '$cmd (a path the lock cannot name)');
  assert.equal(cls('$logs | ForEach-Object { Get-Content $_ }').why, '$logs (a path the lock cannot name)', "the deny row's text is unchanged when nothing assigned $logs");
};
test('required mutant: a DIFFERENT variable\'s assignment (or a sh one) does not lighten a bare $cmd', () => K.otherVar());

K.callUnchanged = (M = HJ) => {
  const cls = (cmd) => M.classifyCommand(cmd, 0, ctx);
  // `& $x` / `. $x` are unchanged: a program named through a computed variable is unknown.
  assert.equal(cls('$p = (Get-Location).Path; & $p').why, '& $p (a path the lock cannot name)', 'A CALL THROUGH A COMPUTED VARIABLE STAYS UNKNOWN');
  assert.equal(cls('$p = (Get-Location).Path; & $p').provisional, true);
  assert.equal(cls('$p = (Get-Location).Path; . $p').provisional, true, '. $x is unchanged');
  // A named program is still judged by its name, assigned or not (LIVE-FILE-192 (b)).
  assert.deepEqual(cls("$p = 'C:\\x\\mutants.cjs'; $p"), { heavy: true, kind: 'bench', why: 'node mutants.cjs' }, 'A NAMED PROGRAM IS STILL JUDGED BY ITS NAME');
  assert.deepEqual(cls("$p = 'C:\\x\\mutants.cjs'; node $p"), { heavy: true, kind: 'bench', why: 'node mutants.cjs' });
  assert.equal(cls('$s = npm; $s test').kind, 'suite', 'a variable program with arguments is judged by them');
  assert.equal(cls('$s = (Get-Location); $s test/tools/run-tests.cjs').kind, 'suite', 'a computed program with arguments is judged by them');
  // A test runner and a write target are unchanged.
  assert.equal(cls('$t = test/tools/run-tests.cjs; node $t').kind, 'suite');
  assert.equal(cls('node --test $f').why, 'node --test $f (a path the lock cannot name)');
};
test('unchanged: & $x stays unknown, a named program through $p is judged by its name, runners too', () => K.callUnchanged());

// ── a directory is not a program; a missing path stays provisional ───────────────────────

K.directory = (M = HJ) => {
  const cls = (cmd) => M.classifyCommand(cmd, 0, ctx);
  for (const cmd of ['cd C:/Dunder/hive/bin && ./term --help', 'cd C:/Dunder/hive/bin; ./term rule --id x', 'C:/Dunder/hive/bin/term', 'd=C:/Dunder/hive/bin/term; bash $d', 'cd C:/Dunder/hive && bin/term --help', "$d = 'C:/Dunder/hive/bin/term'; $d --help", 'bash C:/Dunder/hive/bin/term']) {
    assert.deepEqual(cls(cmd), { heavy: false }, `A DIRECTORY IS NOT A PROGRAM: ${cmd}`);
  }
};
test("required mutant: god's ./term --help (term is a folder) and any path that is a directory is light", () => K.directory());

K.missingStays = (M = HJ) => {
  const cls = (cmd) => M.classifyCommand(cmd, 0, ctx);
  for (const cmd of ['cd C:/Dunder/hive/bin && ./termm --help', 'cd C:/Dunder/hive/bin && ../bin/nope', 'bash C:/Dunder/hive/bin/nope.sh', 'd=C:/Dunder/hive/bin/nope; bash $d', 'cd C:/Dunder/hive/bin && ./term/sub --help']) {
    const r = cls(cmd);
    assert.equal(r.heavy, true, `A MISSING PATH STAYS PROVISIONAL (heavy): ${cmd}`);
    assert.equal(r.provisional, true, `A MISSING PATH STAYS PROVISIONAL: ${cmd}`);
    assert.match(r.why, /a script the lock cannot read yet: no such file at /, `the deny names the missing path: ${cmd}`);
  }
  assert.deepEqual(cls('bash C:/Dunder/hive/bin/light.sh'), { heavy: false }, 'a script that is there is read');
};
test('required mutant: a missing path (./termm, a missing script) stays heavy, provisional, named', () => K.missingStays());

K.readerDir = (M = HJ) => {
  const seen = [];
  const read = (abs) => {
    seen.push(abs);
    const k = abs.replace(/\\/g, '/').replace(/\/\.\//g, '/').toLowerCase();
    if (k === 'c:/dunder/hive/bin/term') return { size: 0, text: () => '', dir: true };
    if (k === 'c:/dunder/hive/bin/light.sh') return { size: 7, text: () => 'echo hi' };
    return null;
  };
  const r = M.scriptReaderFor('C:/Dunder/hive/bin', read);
  assert.equal(r.isDir('./term'), true, 'THE READER REPORTS A DIRECTORY');
  assert.equal(r.readScript('./term'), null, 'THE READER REPORTS A DIRECTORY: a directory has no script text');
  assert.equal(r.missingAt('./term'), null, 'a directory is not called missing');
  assert.equal(r.isDir('./light.sh'), false, 'a file is not a directory');
  assert.equal(r.readScript('./light.sh'), 'echo hi');
  assert.equal(r.isDir('./nope'), false, 'a missing path is not a directory');
  assert.equal(r.missingAt('./nope'), 'C:/Dunder/hive/bin/./nope', 'a missing path is named');
  assert.equal(r.isDir('$x'), false, 'a computed path is not resolved');
  assert.ok(seen.length >= 3, 'the reader was asked');
};
test('scriptReaderFor: isDir reports what the reader marks dir; readScript/missingAt treat it as present, no text', () => K.readerDir());

// Andy's audit of e66b4134: PowerShell runs `./tool` and `.\tool` as tool.cmd when a folder `tool` sits
// beside it (measured: RAN twice), so a folder with a runnable sibling is not "a directory, light".
K.runnableSibling = (M = HJ) => {
  const read = (abs) => {
    const k = abs.replace(/\\/g, '/').replace(/\/\.\//g, '/').toLowerCase();
    if (k === 'c:/dunder/hive/bin/tool' || k === 'c:/dunder/hive/bin/term') return { size: 0, text: () => '', dir: true };
    if (k === 'c:/dunder/hive/bin/tool.cmd') return { size: 8, text: () => 'npm test' };
    return null;
  };
  const r = M.scriptReaderFor('C:/Dunder/hive/bin', read);
  assert.equal(r.isDir('./term'), true, 'A FOLDER ALONE IS A DIRECTORY');
  for (const p of ['./tool', '.\\tool', 'C:/Dunder/hive/bin/tool']) {
    assert.equal(r.isDir(p), false, `A FOLDER WITH A RUNNABLE SIBLING IS NOT A DIRECTORY: ${p}`);
  }
  for (const cmd of ['./tool', '.\\tool', 'cd C:/Dunder/hive/bin; ./tool --help']) {
    assert.equal(M.classifyCommand(cmd, 0, r).heavy, true, `A FOLDER WITH A RUNNABLE SIBLING IS NOT A DIRECTORY: ${cmd}`);
  }
};
test('required mutant: a folder with a runnable sibling (tool + tool.cmd) is not a directory: PowerShell runs the sibling', () => K.runnableSibling());

K.hookReader = (M = HJ, H = loadTs(HKF)) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-varpath-'));
  try {
    fs.mkdirSync(path.join(base, 'term'));
    fs.writeFileSync(path.join(base, 'light.sh'), 'echo hi');
    const hctx = H.HookServer.heavyScriptCtx(base);
    assert.deepEqual(M.classifyCommand('./term --help', 0, hctx), { heavy: false }, 'THE HOOK READER REPORTS A REAL DIRECTORY: ./term --help is light');
    assert.deepEqual(M.classifyCommand('bash light.sh', 0, hctx), { heavy: false });
    const miss = M.classifyCommand('./termm --help', 0, hctx);
    assert.equal(miss.provisional, true, 'a real missing path stays provisional');
    assert.match(miss.why, /no such file at /);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
};
test("the hook's reader (statSync) marks a real directory: ./term --help is light, ./termm stays provisional", () => K.hookReader());

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
  { name: 'any assignment lightens any variable (required: a DIFFERENT variable)', edits: [['      if (v && ctx.psVars?.has(v[1].toLowerCase())) return { heavy: false };', '      if (v && ctx.psVars?.size) return { heavy: false };']],
    killer: 'otherVar', dies: /A DIFFERENT VARIABLE'S ASSIGNMENT DOES NOT LIGHTEN/ },
  { name: "a sh assignment counts as PowerShell's", edits: [['    const psGlued = ws.length >= 1 ? /^\\$([A-Za-z_][A-Za-z0-9_]*)=./.exec(ws[0]) : null;', '    const psGlued = ws.length >= 1 ? /^\\$?([A-Za-z_][A-Za-z0-9_]*)=./.exec(ws[0]) : null;']],
    killer: 'otherVar', dies: /A DIFFERENT VARIABLE'S ASSIGNMENT DOES NOT LIGHTEN .*cmd=\$\(which npm\); \$cmd/ },
  { name: 'the assignment set is not carried in the ctx', edits: [['expand, psVars, ...(readScript', 'expand, ...(readScript']],
    killer: 'logsPipeline', dies: /A VARIABLE THIS COMMAND ASSIGNS IS A VALUE/ },
  { name: '$_ is a value anywhere (required: outside a block)', edits: [['      if (v && ctx.inBlock && /^(?:_|PSItem)$/i.test(v[1])) return { heavy: false };', '      if (v && /^(?:_|PSItem)$/i.test(v[1])) return { heavy: false };']],
    killer: 'psItemOutside', dies: /\$_ OUTSIDE A BLOCK STAYS UNKNOWN/ },
  { name: 'a block body is not marked as inside braces', edits: [['nested(block, depth, { ...ctx, inBlock: true }, `${bin} { }`)', 'nested(block, depth, ctx, `${bin} { }`)']],
    killer: 'psItemInBlock', dies: /\$_ INSIDE A BLOCK IS A VALUE/ },
  { name: 'the brace nesting is not tracked across split segments', edits: [['    braces = Math.max(0, braces + braceDelta(own));\n', '    braces = 0;\n']],
    killer: 'psItemInBlock', dies: /\$_ INSIDE A BLOCK IS A VALUE: .*Write-Host \$_; \$_ \| Out-Null/ },
  { name: 'a closed block keeps counting', edits: [["    else if (c === '}') n--;\n", '']],
    killer: 'psItemOutside', dies: /\$_ OUTSIDE A BLOCK STAYS UNKNOWN .*% \{ echo 1 \}; \$_/ },
  { name: 'a directory is not consulted (required: a directory lightens)', edits: [['  if (text === null) return dir ? { heavy: false } : unreadable(path, ctx);', '  if (text === null) return unreadable(path, ctx);']],
    killer: 'directory', dies: /A DIRECTORY IS NOT A PROGRAM/ },
  { name: 'an unreadable path is light (required: a missing file stays provisional)', edits: [['  if (text === null) return dir ? { heavy: false } : unreadable(path, ctx);', '  if (text === null) return { heavy: false };']],
    killer: 'missingStays', dies: /A MISSING PATH STAYS PROVISIONAL/ },
  { name: 'classifyCommand drops isDir from the ctx', edits: [['...(isDir ? { isDir } : {}), ', '']],
    killer: 'directory', dies: /A DIRECTORY IS NOT A PROGRAM/ },
  { name: 'the reader never reports a directory', edits: [['abs !== null && read(abs)?.dir === true && ', 'false && ']],
    killer: 'readerDir', dies: /THE READER REPORTS A DIRECTORY/ },
  { name: 'a runnable sibling is ignored', edits: [[' && !RUNNABLE_EXTS.some((e) => read(`${abs}${e}`) !== null);', ';']],
    killer: 'runnableSibling', dies: /A FOLDER WITH A RUNNABLE SIBLING IS NOT A DIRECTORY/ },
  { name: 'a directory reads as an empty script', edits: [['      if (!f || f.dir || f.size > HEAVY_SCRIPT_MAX_BYTES) return null;   // a directory has no text', '      if (!f || f.size > HEAVY_SCRIPT_MAX_BYTES) return null;']],
    killer: 'readerDir', dies: /THE READER REPORTS A DIRECTORY: a directory has no script text/ },
  { name: 'the hook reader calls a real directory missing', file: HKF, edits: [["          return st.isDirectory() ? { size: 0, text: () => '', dir: true } : null;", '          return null;']],
    killer: 'hookReader', dies: /THE HOOK READER REPORTS A REAL DIRECTORY/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const file = m.file ?? HJF;
      const mutated = loadTs.fromText(file, mutateText(file, m.edits, m.name));
      const run = () => (file === HKF ? K[m.killer](HJ, mutated) : K[m.killer](mutated));
      assert.throws(run, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
