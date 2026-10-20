'use strict';

/**
 * HEAVY-LOCK-FALSE-HEAVY-198 (god 327b16). Andy, 2026-10-19 ~20:21Z: a light chain
 *   cd <wt> && f=<one test file> && sed -i ... $f && ... && timeout 120 node --test $f | grep ... && git add ...
 * was denied as "node --test (a glob or a directory)" and queued (position 3) while Creed's cut bench
 * held the slot. Root cause: classifyCommand tracks `f=<literal>` (for script reads) but the node
 * --test file check saw the word `$f`, which is not a .js name. Now a variable the command set to a
 * literal is substituted there, as the shell will; anything else still fails closed.
 *
 * Jim's two denials the same evening (20:24:49Z, ~20:29Z) were the "cannot read yet" rule on a file
 * that really did not exist at PreToolUse (a wrong path; a worktree the same call was to create):
 * true readings, pinned here as unchanged.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
/** The files on disk at PreToolUse (the hook's reader resolves against cwd, then each `cd`). */
const ON_DISK = new Set(['c:/dunder/_work/andy-hlrr/test/heavy-lock/heavy-lock-reservation-release-198.test.cjs', 'c:/dunder/_work/jim-hlrr/test/heavy-job-lock.test.cjs', 'c:/w/test/one.test.cjs']);
const ctx = {
  readScript: (p, cd) => {
    const raw = p.replace(/\\/g, '/');
    const abs = /^([A-Za-z]:\/|\/)/.test(raw) || !cd ? raw : `${cd.replace(/\\/g, '/').replace(/\/+$/, '')}/${raw}`;
    const k = abs.replace(/^\/([a-z])\//i, '$1:/').toLowerCase();
    return ON_DISK.has(k) ? '// a test' : null;
  }
};

const K = {};

K.todaysChain = (M = HJ) => {
  // Andy's denied command, verbatim (2026-10-19 ~20:21Z).
  const cmd = "cd /c/Dunder/_work/andy-hlrr && f=test/heavy-lock/heavy-lock-reservation-release-198.test.cjs && sed -i 's/\\r$//; s/$/\\r/' $f && sed -i 's/\\r$//; s/$/\\r/' resources/heavy-cli.cjs && grep -c $'\\r$' $f resources/heavy-cli.cjs && timeout 120 node --test $f 2>&1 | grep -E \"^# (pass|fail)\" && git add -A src resources test electron-builder.yml && git status --short";
  assert.deepEqual(M.classifyCommand(cmd, 0, ctx), { heavy: false }, "TODAY'S LIGHT CHAIN IS LIGHT");
};
test("today's denied chain (sed && node --test $f && git add) is light", () => K.todaysChain());

K.varFile = (M = HJ) => {
  for (const cmd of ['f=test/one.test.cjs && node --test $f', 'f=test/one.test.cjs; node --test "$f"', 'export F=test/one.test.cjs; node --test ${F}', "f='test/one.test.cjs' && timeout 60 node --test $f 2>&1 | tail -3"]) {
    assert.deepEqual(M.classifyCommand(`cd /c/w && ${cmd}`, 0, ctx), { heavy: false }, `A VARIABLE SET TO ONE FILE IS THAT FILE: ${cmd}`);
  }
};
test('node --test $f, with f set to one test file in the same command, is light', () => K.varFile());

K.failsClosed = (M = HJ) => {
  const c = (cmd) => M.classifyCommand(`cd /c/w && ${cmd}`, 0, ctx);
  assert.equal(c('node --test $F').why, 'node --test (a glob or a directory)', 'A VARIABLE THE COMMAND DID NOT SET STAYS HEAVY');
  assert.equal(c("f='test/*.test.cjs' && node --test $f").why, 'node --test (a glob or a directory)', 'A VARIABLE SET TO A GLOB IS A GLOB');
  assert.equal(c('d=test && node --test $d').why, 'node --test (a glob or a directory)', 'A VARIABLE SET TO A DIRECTORY IS A DIRECTORY');
  assert.equal(c('f=$(ls test/*.test.cjs | head -1) && node --test $f').why, 'node --test (a glob or a directory)', 'A COMPUTED VALUE STAYS HEAVY');
  assert.equal(c('f=test/missing.test.cjs && node --test $f').why, 'missing.test.cjs (a script the lock cannot read yet)', 'A VARIABLE NAMING A MISSING FILE IS READ AS THAT FILE (UNREADABLE)');
  assert.equal(c('node --test $f').heavy, true);
  // The glob loop rule is unchanged (HGL196): the loop variable is not a literal assignment.
  assert.equal(c('f=test/one.test.cjs; for f in test/*.test.cjs; do node --test $f; done').kind, 'suite', 'A GLOB LOOP IS STILL A SUITE');
};
test('fails closed: an unset, glob, directory, computed or missing value stays heavy; a glob loop is a suite', () => K.failsClosed());

K.jimsDenials = (M = HJ) => {
  // Jim, 20:24:49Z (verbatim apart from the env paths): a path that does not exist (the file is test/heavy-job-lock.test.cjs).
  const a = "cd C:/Dunder/_work/jim-hlrr && export NODE_PATH='C:/x/node_modules'; ls test/heavy-lock/ | head -20; env -u HIVE_LEDGER_URL -u HIVE_ROOT -u AGENT_ID node --test test/heavy-lock/heavy-job-lock.test.cjs 2>&1 | grep -E \"^# (pass|fail)\"; date -u +%T";
  assert.equal(M.classifyCommand(a, 0, ctx).why, 'heavy-job-lock.test.cjs (a script the lock cannot read yet)', 'a missing file is still unreadable (a true reading)');
  assert.deepEqual(M.classifyCommand(a.replace('test/heavy-lock/heavy-job-lock', 'test/heavy-job-lock'), 0, ctx), { heavy: false }, 'the right path is light');
  // Jim, ~20:29Z: the file is inside a worktree the same command creates first: unknown at PreToolUse.
  const b = 'cd C:/Dunder/MunderDev && git worktree add -q --detach C:/Dunder/_work/jim-hlrr2 03046b31 && cd C:/Dunder/_work/jim-hlrr2 && node --test test/heavy-lock/heavy-lock-reservation-release-198.test.cjs';
  assert.equal(M.classifyCommand(b, 0, ctx).provisional, true, 'a file the call creates first is still unknown');
};
test("Jim's two denials were true readings and stay as they were", () => K.jimsDenials());

// ─── god 2d273e: the deny names a missing path; Jim's SHOULD: a value splits as the shell splits ───

/** The hook's own reader (scriptReaderFor), over a fake disk. */
const DISK = new Set(['C:/Dunder/_work/jim-hlrr/test/heavy-job-lock.test.cjs', 'C:/w/test/one.test.cjs', 'C:/w/test/two.test.cjs',
  ...Array.from({ length: 20 }, (_, i) => `C:/w/test/t${i}.test.cjs`)]);
const realCtx = (M) => M.scriptReaderFor('C:\\PrzEdit', (abs) => {
  const k = abs.replace(/\\/g, '/').replace(/^\/([a-z])\//i, (_m, d) => `${d.toUpperCase()}:/`);
  if (k === 'C:/w/big.sh') return { size: M.HEAVY_SCRIPT_MAX_BYTES + 1, text: () => 'echo big' };
  return DISK.has(k) ? { size: 10, text: () => '// a test' } : null;
});

K.missingSaid = (M = HJ) => {
  const ctx2 = realCtx(M);
  const c = (cmd) => M.classifyCommand(cmd, 0, ctx2);
  const jim = 'cd C:/Dunder/_work/jim-hlrr && env -u HIVE_ROOT node --test test/heavy-lock/heavy-job-lock.test.cjs 2>&1 | tail -3';
  assert.deepEqual(c(jim), { heavy: true, kind: 'bench', why: 'heavy-job-lock.test.cjs (a script the lock cannot read yet: no such file at C:/Dunder/_work/jim-hlrr/test/heavy-lock/heavy-job-lock.test.cjs)', provisional: true }, 'A MISSING PATH IS NAMED IN THE DENY');
  assert.deepEqual(c(jim.replace('test/heavy-lock/heavy-job-lock', 'test/heavy-job-lock')), { heavy: false }, 'the real path is light');
  assert.equal(c('cd /c/w && f=test/zz.test.cjs && node --test $f').why, 'zz.test.cjs (a script the lock cannot read yet: no such file at C:/w/test/zz.test.cjs)', 'A MISSING PATH IS NAMED, THROUGH A VARIABLE');
  assert.equal(c('cd /c/w && bash gone.sh').why, 'gone.sh (a script the lock cannot read yet: no such file at C:/w/gone.sh)', 'A MISSING SCRIPT IS NAMED');
  assert.equal(c('S=/c/w && bash $S/gone.sh').why, 'gone.sh (a script the lock cannot read yet: no such file at C:/w/gone.sh)', 'A MISSING SCRIPT IS NAMED, THROUGH A VARIABLE');
  assert.equal(c('cd /c/w && bash big.sh').why, 'big.sh (a script the lock cannot read yet)', 'A FILE THAT IS THERE (TOO BIG TO READ) IS NOT CALLED MISSING');
  // A file this command writes, then rewrites by other means: unknown, but it is not "no such file".
  assert.equal(c("cd /c/w && cat <<'EOF' > run.sh\necho hi\nEOF\nsed -i 's/hi/x/' run.sh && bash run.sh").why, 'run.sh (a script the lock cannot read yet)', 'A FILE THE COMMAND WRITES IS NOT CALLED MISSING');
};
test('the deny names a path that does not exist (god 2d273e), not a file the command writes', () => K.missingSaid());

K.splitVar = (M = HJ) => {
  const c = (cmd) => M.classifyCommand(`cd /c/w && ${cmd}`, 0, realCtx(M));
  assert.deepEqual(c('F="test/one.test.cjs test/two.test.cjs" && node --test $F'), { heavy: false }, 'A VALUE NAMING TWO FILES IS TWO FILES');
  assert.equal(c('F="test/one.test.cjs test/gone.test.cjs" && node --test $F').why, 'gone.test.cjs (a script the lock cannot read yet: no such file at C:/w/test/gone.test.cjs)', 'each one is read');
  const many = Array.from({ length: 20 }, (_, i) => `test/t${i}.test.cjs`).join(' ');
  assert.deepEqual(c(`F="${many}"; node --test $F`), { heavy: true, kind: 'suite', why: 'node --test (20 files)' }, 'A VALUE NAMING SUITE_MANY_FILES FILES IS A SUITE (definite)');
  assert.equal(c("F='' && node --test $F").why, 'node --test (all)', 'an empty value runs node --test with no files: the suite');
};
test("a variable's value splits on whitespace as the shell splits it (Jim SHOULD)", () => K.splitVar());

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
  { name: 'the file word is not expanded (today)', edits: [['        const e = ctx.expand ? ctx.expand(a) : a;\n', '        const e = a;\n']],
    killer: 'todaysChain', dies: /TODAY'S LIGHT CHAIN IS LIGHT/ },
  { name: 'no split: a value is one word', edits: [['        if (e === a) files.push(a); else files.push(...e.split(/\\s+/).filter(Boolean));', '        files.push(e);']],
    killer: 'splitVar', dies: /A VALUE NAMING TWO FILES IS TWO FILES/ },
  { name: 'the deny does not name the missing path', edits: [['  try { at = ctx?.missingAt?.(path, ctx.cd) ?? null; } catch { at = null; }\n', '']],
    killer: 'missingSaid', dies: /A MISSING PATH IS NAMED IN THE DENY/ },
  { name: 'classifyCommand drops missingAt (no expand, no cd)', edits: [['...(missingAt ? { missingAt } : {}) };', '...(where ? { missingAt: where } : {}) };']],
    killer: 'missingSaid', dies: /A MISSING SCRIPT IS NAMED, THROUGH A VARIABLE/ },
  { name: 'a file the command writes is called missing', edits: [['virtual.has(key(p, cd)) ? null : where(', 'false ? null : where(']],
    killer: 'missingSaid', dies: /A FILE THE COMMAND WRITES IS NOT CALLED MISSING/ },
  { name: 'missingAt reports a file that is there', edits: [['      if (abs === null || read(abs)) return null;\n', '      if (abs === null) return null;\n']],
    killer: 'missingSaid', dies: /A FILE THAT IS THERE \(TOO BIG TO READ\) IS NOT CALLED MISSING/ },
  { name: 'classifyCommand does not pass expand', edits: [['  let here: ClassifyCtx = { ...ctx, stdin: undefined, expand, ', '  let here: ClassifyCtx = { ...ctx, stdin: undefined, ']],
    killer: 'varFile', dies: /A VARIABLE SET TO ONE FILE IS THAT FILE/ },
  { name: 'every $word is taken as a .js file (fails open)', edits: [["      if (files.some((f) => /[*?]/.test(f) || !/\\.[cm]?[jt]s$/.test(f))) return { heavy: true, kind: 'suite', why: 'node --test (a glob or a directory)' };", "      if (files.some((f) => !f.includes('$') && (/[*?]/.test(f) || !/\\.[cm]?[jt]s$/.test(f)))) return { heavy: true, kind: 'suite', why: 'node --test (a glob or a directory)' };"]],
    killer: 'failsClosed', dies: /A VARIABLE THE COMMAND DID NOT SET STAYS HEAVY/ }
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
});
