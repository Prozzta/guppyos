'use strict';
require('../tools/own-job.cjs');
/**
 * HEAVY-LOCK-FUNC-CALL-LOOP-108: a glob for-loop that calls a shell function running
 * `node --test "$1"` was classed light. The same loop written inline is a suite.
 * Sighted card shape: `run(){ env -u X timeout 400 node --test "$1"; }; for f in test/*.test.cjs; do run "$f"; done`.
 * Root cause: the classifier never looked inside a call. Each call site now gets the body of the
 * function in force there, with the call's arguments substituted. The call stays in place, and
 * the body is inserted after it. So a function-call loop is classed the same as the inline loop.
 * Jim 53c957: nested calls resolve against the definitions in force at the OUTERMOST call site.
 * A body inherits the call's `&`. A body with shift or set -- puts all the arguments ($@) in
 * every positional. Only `export -f` functions reach bash -c, sh -c, or a script.
 * Only pure strings are classified here; nothing is run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const G = 'test/*.test.cjs';
const pick = (c) => ({ heavy: c.heavy, kind: c.kind, exclusive: c.exclusive === true, provisional: c.provisional === true });

/** The function-call form is classed exactly as its inline form, and that class is held. */
function same(M, fnCmd, inlineCmd, tag, ctx = {}) {
  const f = M.classifyCommand(fnCmd, 0, ctx);
  const i = M.classifyCommand(inlineCmd, 0, ctx);
  assert.equal(i.heavy, true, `${tag}: (fixture) the inline form ${JSON.stringify(inlineCmd)} is heavy`);
  assert.deepEqual(pick(f), pick(i), `${tag}: ${JSON.stringify(fnCmd)} is classed as its inline form (got ${JSON.stringify(f)}, inline ${JSON.stringify(i)})`);
  return f;
}
function suite(M, cmd, tag, ctx = {}) {
  const c = M.classifyCommand(cmd, 0, ctx);
  assert.equal(c.heavy, true, `${tag}: ${JSON.stringify(cmd)} is heavy (classed ${JSON.stringify(c)})`);
  assert.equal(c.kind, 'suite', `${tag}: ${JSON.stringify(cmd)} is a suite`);
  assert.notEqual(c.provisional, true, `${tag}: ${JSON.stringify(cmd)} is held for what it runs, not only because it is unreadable`);
  return c;
}
function light(M, cmd, tag, ctx = {}) {
  const c = M.classifyCommand(cmd, 0, ctx);
  assert.equal(c.heavy, false, `${tag}: ${JSON.stringify(cmd)} stays light (classed ${JSON.stringify(c)})`);
}

/** A script reader over fixed texts: s.sh loops over the glob calling run; a.test.cjs is readable. */
const SCRIPTS = { 's.sh': `for f in ${G}; do run "$f"; done\n`, 'a.test.cjs': "require('node:test')('x', () => {});\n" };
const RS = { readScript: (p) => SCRIPTS[p.replace(/^\.\//, '')] ?? null, isDir: () => false, missingAt: () => null };

const K = {
  card(M) {
    const T = 'A GLOB LOOP CALLING A NODE --TEST FUNCTION IS A SUITE';
    suite(M, `run(){ env -u X timeout 400 node --test "$1"; }; for f in ${G}; do run "$f"; done`, T);
    same(M, `run(){ env -u X timeout 400 node --test "$1"; }; for f in ${G}; do run "$f"; done`,
      `for f in ${G}; do env -u X timeout 400 node --test "$f"; done`, T);
    same(M, `run() { node --test "$1"; }; for f in ${G}; do run "$f"; done`, `for f in ${G}; do node --test "$f"; done`, T);
    const many = Array.from({ length: 25 }, (_, i) => `t${i}.test.cjs`).join(' ');
    same(M, `run(){ node --test "$1"; }; for f in ${many}; do run "$f"; done`, `for f in ${many}; do node --test "$f"; done`, `${T} (a 25-word list)`);
    same(M, `run(){ node --test "$1"; }; run ${G}`, `node --test ${G}`, `${T} (one call with a glob argument)`);
  },
  allArgs(M) {
    const T = 'A FUNCTION OVER "$@" IS CLASSED AS ITS INLINE LOOP';
    same(M, `run(){ node --test "$@"; }; for f in ${G}; do run "$f"; done`, `for f in ${G}; do node --test "$f"; done`, T);
    same(M, `run(){ node --test "$@"; }; run ${G}`, `node --test ${G}`, T);
  },
  glued(M) {
    const T = 'A GLUED f(){ DEFINITION IS READ AS A DEFINITION';
    same(M, 'f(){ npm test; }; f', 'npm test', T);
    same(M, 'f(){ npm test; }', 'f() { npm test; }', `${T} (an uncalled body is classed as the spaced form)`);
    same(M, 'f (){ npm test; }', 'f() { npm test; }', `${T} (an uncalled body is classed as the spaced form)`);
  },
  keyword(M) {
    const T = 'THE FUNCTION KEYWORD AND A NEXT-LINE BRACE ARE DEFINITIONS';
    same(M, `function run { node --test "$1"; }\nfor f in ${G}; do run "$f"; done`, `for f in ${G}; do node --test "$f"; done`, T);
    same(M, `function run() { node --test "$1"; }\nfor f in ${G}; do run "$f"; done`, `for f in ${G}; do node --test "$f"; done`, T);
    same(M, `run()\n{\n  node --test "$1"\n}\nfor f in ${G}; do run "$f"; done`, `for f in ${G}; do node --test "$f"; done`, T);
  },
  outermost(M) {
    const T = 'NESTED CALLS RESOLVE AT THE OUTERMOST CALL SITE';
    same(M, `inner(){ node --test "$1"; }; outer(){ inner "$1"; }; for f in ${G}; do outer "$f"; done`, `for f in ${G}; do node --test "$f"; done`, T);
    // Jim MUST: inner is defined after outer, but before the call. Bash resolves it when the call runs.
    same(M, `outer(){ inner "$1"; }; inner(){ node --test "$1"; }; for f in ${G}; do outer "$f"; done`, `for f in ${G}; do node --test "$f"; done`, `${T} (a forward-defined inner)`);
    same(M, `outer(){ inner; }; inner(){ node --test a.test.cjs; }; for f in ${G}; do outer; done`, `for f in ${G}; do node --test a.test.cjs; done`, `${T} (a forward-defined inner, literal body)`);
  },
  subst(M) {
    const T = 'A CALL LOOP INSIDE $(...) OR BACKTICKS IS CLASSED AS ITS INLINE LOOP';
    same(M, `run(){ node --test "$1"; }; x=$(for f in ${G}; do run "$f"; done)`, `x=$(for f in ${G}; do node --test "$f"; done)`, T);
    same(M, `run(){ node --test a.test.cjs; }; x=$(for f in ${G}; do run; done)`, `x=$(for f in ${G}; do node --test a.test.cjs; done)`, T);
    same(M, `run(){ node --test "$1"; }; x=\`for f in ${G}; do run "$f"; done\``, `x=\`for f in ${G}; do node --test "$f"; done\``, T);
  },
  exported(M) {
    const T = 'AN EXPORTED FUNCTION REACHES BASH -C AND A SCRIPT';
    same(M, `run(){ node --test "$1"; }; export -f run; bash -c 'for f in ${G}; do run "$f"; done'`, `bash -c 'for f in ${G}; do node --test "$f"; done'`, T);
    same(M, `run(){ node --test a.test.cjs; }; export -f run; bash -c 'for f in ${G}; do run; done'`, `bash -c 'for f in ${G}; do node --test a.test.cjs; done'`, T);
    same(M, `run(){ node --test a.test.cjs; }; declare -fx run; bash -c 'for f in ${G}; do run; done'`, `bash -c 'for f in ${G}; do node --test a.test.cjs; done'`, `${T} (declare -fx)`);
    suite(M, 'run(){ node --test a.test.cjs; }; export -f run; bash s.sh', `${T} (a script)`, RS);
  },
  bashOnlyExported(M) {
    const T = 'ONLY EXPORTED FUNCTIONS REACH BASH -C';
    light(M, `run(){ node --test a.test.cjs; }; bash -c 'for f in ${G}; do run; done'`, T);
  },
  scriptOnlyExported(M) {
    const T = 'ONLY EXPORTED FUNCTIONS REACH A SCRIPT';
    light(M, 'run(){ node --test a.test.cjs; }; bash s.sh', T, RS);
  },
  background(M) {
    const T = 'A BACKGROUNDED CALL IN A LOOP IS CLASSED AS THE INLINE BACKGROUNDED LOOP';
    const four = 'a.test.cjs b.test.cjs c.test.cjs d.test.cjs';
    const c = same(M, `run(){ node --test "$1"; }; for f in ${four}; do run "$f" & done`, `for f in ${four}; do node --test "$f" & done`, T);
    assert.equal(c.exclusive, true, `${T}: four backgrounded calls are an exclusive bench`);
    // One background process per call, as inline: three calls stay under the 4-process rule.
    assert.deepEqual(pick(M.classifyCommand('run(){ node --test a.test.cjs; }; for i in 1 2 3; do run & done', 0, {})),
      pick(M.classifyCommand('for i in 1 2 3; do node --test a.test.cjs & done', 0, {})), `${T}: three backgrounded calls are not counted twice`);
    light(M, 'run(){ node --test a.test.cjs; }; for i in 1 2 3; do run & done', `${T}: three backgrounded calls`);
  },
  bodyBg(M) {
    // Jim MUST 1 (99238882): a body's own & is kept when the call is not backgrounded.
    const T = 'A BODY THAT BACKGROUNDS IS CLASSED AS THE INLINE BACKGROUNDED LOOP';
    const four = 'a.test.cjs b.test.cjs c.test.cjs d.test.cjs';
    const w = same(M, 'w(){ sleep 100 & }; for i in 1 2 3 4; do w; done', 'for i in 1 2 3 4; do sleep 100 & done', T);
    assert.equal(w.exclusive, true, `${T}: four backgrounding calls are an exclusive bench`);
    same(M, `run(){ node --test "$1" & }; for f in ${four}; do run "$f"; done`, `for f in ${four}; do node --test "$f" & done`, `${T} (node --test)`);
    // Fail closed past FUNC_DEPTH: a chain of ten calls whose last body backgrounds.
    const chain = Array.from({ length: 9 }, (_, i) => `f${i}(){ f${i + 1}; }; `).join('') + 'f9(){ sleep 100 & }; ';
    same(M, `${chain}for i in 1 2 3 4; do f0; done`, 'for i in 1 2 3 4; do sleep 100 & done', `${T} (PAST THE DEPTH CAP)`);
  },
  bodyBgOnce(M) {
    const T = 'A BACKGROUNDED PROCESS IS COUNTED ONCE';
    const three = (fnCmd, tag) => assert.deepEqual(pick(M.classifyCommand(fnCmd, 0, {})),
      pick(M.classifyCommand('for i in 1 2 3; do sleep 100 & done', 0, {})), `${T}: ${tag} (${JSON.stringify(fnCmd)})`);
    three('w(){ sleep 100 & }; for i in 1 2 3; do w & done', 'A BACKGROUNDED CALL OF A BACKGROUNDING BODY');
    three('inner(){ sleep 100 & }; w(){ inner & }; for i in 1 2 3; do w; done', 'A NESTED BACKGROUNDED CALL OF A BACKGROUNDING BODY');
    const chain = Array.from({ length: 9 }, (_, i) => `f${i}(){ f${i + 1}; }; `).join('') + 'f9(){ sleep 100 & }; ';
    three(`${chain}for i in 1 2 3; do f0 & done`, 'A BACKGROUNDED CALL PAST THE DEPTH CAP');
    light(M, 'w(){ sleep 100 & }; for i in 1 2 3; do w & done', `${T}: three backgrounded calls of a backgrounding body`);
  },
  shift(M) {
    const T = 'A BODY WITH SHIFT OR SET -- PUTS ALL ARGUMENTS IN EVERY POSITIONAL';
    same(M, `run(){ shift; node --test "$1"; }; for f in ${G}; do run x "$f"; done`, `for f in ${G}; do node --test x "$f"; done`, T);
    same(M, `run(){ set -- "$@"; node --test "$1"; }; for f in ${G}; do run x "$f"; done`, `for f in ${G}; do node --test x "$f"; done`, T);
    // Where the positional decides it: after the shift, "$1" is the quoted glob node --test expands.
    suite(M, `run(){ shift; node --test "$1"; }; run a.test.cjs "${G}"`, `${T} (shift: $1 is the glob)`);
    suite(M, `run(){ set -- "$2"; node --test "$1"; }; run a.test.cjs "${G}"`, `${T} (set --: $1 is the glob)`);
  },
  recursion(M) {
    const T = 'A SELF-CALLING NODE --TEST FUNCTION IS A SUITE';
    const c = suite(M, 'f(){ node --test a.test.cjs; f; }; f', T);
    assert.match(c.why, /calls itself/, `${T}: the reason names the self-call`);
    assert.equal(M.planSize('f(){ node --test a.test.cjs; f; }; f'), -1, `${T}: planSize cannot count it`);
    suite(M, 'a(){ node --test x.test.cjs; b; }; b(){ a; }; a', `${T} (mutual)`);
  },
  light(M) {
    const T = 'NOT WIDENED';
    light(M, 'run(){ node --test a.test.cjs; }; run', `${T}: one call of a one-file body`);
    light(M, 'run(){ node --test a.test.cjs; }; for i in 1 2 3; do run; done', `${T}: a short literal loop of calls`);
    light(M, `run(){ echo "$1"; }; for f in ${G}; do run "$f"; done`, `${T}: a function that runs no test`);
    light(M, `run(){ echo x; }; for f in ${G}; do run; done; run(){ node --test a.test.cjs; }`, `${T}: a definition after the loop is not in force at the call`);
    light(M, `run(){ node --test a.test.cjs; }; run(){ echo x; }; for f in ${G}; do run; done`, `${T}: a redefinition before the call replaces the body`);
    light(M, 'f(){ echo x; f; }; f', `${T}: a self-calling function that runs no test`);
    // '$1' is the text $1, not the glob: classed as the inline form (a path the lock cannot name).
    same(M, `run(){ node --test '$1'; }; run "${G}"`, `node --test '$1'`, `${T}: A $1 IN SINGLE QUOTES OF A BODY IS NOT FILLED`);
    light(M, `run(){ node --test a.test.cjs; }; for f in ${G}; do timeout 5 run; done`, `${T}: timeout runs a program, not a function`);
  },
};

test('CARD: a glob loop calling a node --test function is a suite, as the inline loop', () => K.card(HJ));
test('"$@": a function over all its arguments', () => K.allArgs(HJ));
test('GLUED: f(){ is a definition', () => K.glued(HJ));
test('KEYWORD: function name { and a next-line brace', () => K.keyword(HJ));
test('JIM MUST: nested calls resolve at the outermost call site', () => K.outermost(HJ));
test('$(...) and backticks see the definitions', () => K.subst(HJ));
test('EXPORT -F: exported functions reach bash -c and a script', () => K.exported(HJ));
test('EXPORT -F: a function that is not exported does not reach bash -c', () => K.bashOnlyExported(HJ));
test('EXPORT -F: a function that is not exported does not reach a script', () => K.scriptOnlyExported(HJ));
test('JIM SHOULD 1: a backgrounded call is classed as the inline backgrounded loop', () => K.background(HJ));
test('JIM MUST 1: a body that backgrounds is classed as the inline backgrounded loop', () => K.bodyBg(HJ));
test('JIM MUST 1: a backgrounded process is counted once', () => K.bodyBgOnce(HJ));
test('JIM SHOULD 2: shift / set -- put all arguments in every positional', () => K.shift(HJ));
test('RECURSION: a self-calling node --test function is a suite', () => K.recursion(HJ));
test('NOT WIDENED: calls that run one file, or no test, stay light', () => K.light(HJ));

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
  { name: 'calls are not expanded',
    edits: [["const calls = d === 'cmd' ? { segs, ops, funcs: undefined } : expandCalls(segs, ops, d, ctx.funcs);", 'const calls = { segs, ops, funcs: ctx.funcs };']],
    killer: 'card', dies: /A GLOB LOOP CALLING A NODE --TEST FUNCTION IS A SUITE/ },
  { name: 'a glued f(){ head is not stripped (its body is not classed where it is defined)',
    edits: [['const FUNC_HEAD = /^[A-Za-z_][\\w.:-]*\\(\\)\\{?$/;', 'const FUNC_HEAD = /^[A-Za-z_][\\w.:-]*\\(\\)$/;']],
    killer: 'glued', dies: /A GLUED f\(\)\{ DEFINITION IS READ AS A DEFINITION \(an uncalled body is classed as the spaced form\): "f\(\)\{/ },
  { name: 'a call resolves to the last definition in the command, not the one in force',
    edits: [['if (f.name === name && f.start < at) best = f.fn;', 'if (f.name === name) best = f.fn;']],
    killer: 'light', dies: /NOT WIDENED: a definition after the loop is not in force at the call/ },
  { name: 'a nested call resolves at the definition site of its caller (Jim MUST)',
    edits: [['const inner = c && lookup(c.name, at);', 'const inner = c && lookup(c.name, defs.find((f) => f.fn === fn)?.start ?? at);']],
    killer: 'outermost', dies: /NESTED CALLS RESOLVE AT THE OUTERMOST CALL SITE \(a forward-defined inner/ },
  { name: 'every definition reaches bash -c, not only the exported ones',
    edits: [["dialect: 'sh', funcs: exportedOnly(ctx.funcs) }", "dialect: 'sh', funcs: ctx.funcs }"]],
    killer: 'bashOnlyExported', dies: /ONLY EXPORTED FUNCTIONS REACH BASH -C/ },
  { name: 'every definition reaches a script, not only the exported ones',
    edits: [["funcs: ctx.shell === 'powershell' || dialect === 'cmd' ? undefined : exportedOnly(ctx.funcs) }", 'funcs: ctx.funcs }']],
    killer: 'scriptOnlyExported', dies: /ONLY EXPORTED FUNCTIONS REACH A SCRIPT/ },
  { name: 'no definition reaches bash -c',
    edits: [["dialect: 'sh', funcs: exportedOnly(ctx.funcs) }", "dialect: 'sh', funcs: undefined }"]],
    killer: 'exported', dies: /AN EXPORTED FUNCTION REACHES BASH -C AND A SCRIPT/ },
  { name: 'the inserted body is backgrounded again (one call counted twice)',
    edits: [['for (const s of r) { outSegs.push(s); outOps.push(0); }', "for (const s of r) { outSegs.push(/\\s&$/.test(segs[si]) ? s + ' &' : s); outOps.push(0); }"]],
    killer: 'background', dies: /A BACKGROUNDED CALL IN A LOOP IS CLASSED AS THE INLINE BACKGROUNDED LOOP: three backgrounded calls are not counted twice/ },
  { name: 'shift / set -- are not seen (positionals stay positional)',
    edits: [['const shifty = fn.body.some((s) => SHIFTY.test(s));', 'const shifty = false;']],
    killer: 'shift', dies: /A BODY WITH SHIFT OR SET -- PUTS ALL ARGUMENTS IN EVERY POSITIONAL/ },
  { name: 'a single quote in a body does not hide a positional',
    edits: [[`    if (q === "'") { if (c === "'") q = null; out += c; continue; }   // single-quoted: as written\n`, '']],
    killer: 'light', dies: /A \$1 IN SINGLE QUOTES OF A BODY IS NOT FILLED/ },
  { name: 'a body that cannot be inlined is light even when it reaches node --test',
    edits: [["if (reaches(name, at)) return { heavy: true, kind: 'suite'", "if (false) return { heavy: true, kind: 'suite'"]],
    killer: 'recursion', dies: /A SELF-CALLING NODE --TEST FUNCTION IS A SUITE/ },
  { name: "a body's own & is stripped again (Jim MUST 1)",
    edits: [["fillArgs(bg ? fn.body[k].replace(/\\s&$/, '') : fn.body[k], args, shifty)", "fillArgs(fn.body[k].replace(/\\s&$/, ''), args, shifty)"]],
    killer: 'bodyBg', dies: /A BODY THAT BACKGROUNDS IS CLASSED AS THE INLINE BACKGROUNDED LOOP: "w\(\)\{ sleep 100 & \}/ },
  { name: "a body's own & is kept under a backgrounded call (counted twice)",
    edits: [["fillArgs(bg ? fn.body[k].replace(/\\s&$/, '') : fn.body[k], args, shifty)", 'fillArgs(fn.body[k], args, shifty)']],
    killer: 'bodyBgOnce', dies: /A BACKGROUNDED PROCESS IS COUNTED ONCE: A BACKGROUNDED CALL OF A BACKGROUNDING BODY/ },
  { name: "a nested call under a body's own & is not seen as backgrounded (counted twice)",
    edits: [['inline(c.name, inner, c.args, at, [...stack, name], bg || own)', 'inline(c.name, inner, c.args, at, [...stack, name], bg)']],
    killer: 'bodyBgOnce', dies: /A BACKGROUNDED PROCESS IS COUNTED ONCE: A NESTED BACKGROUNDED CALL OF A BACKGROUNDING BODY/ },
  { name: 'past the depth cap, a backgrounding body is light (not fail-closed)',
    edits: [['if (!bg && backgrounds(name, at)) return', 'if (false) return']],
    killer: 'bodyBg', dies: /A BODY THAT BACKGROUNDS IS CLASSED AS THE INLINE BACKGROUNDED LOOP \(PAST THE DEPTH CAP\)/ },
  { name: 'past the depth cap, a backgrounded call of a backgrounding body is counted twice',
    edits: [['if (!bg && backgrounds(name, at)) return', 'if (backgrounds(name, at)) return']],
    killer: 'bodyBgOnce', dies: /A BACKGROUNDED PROCESS IS COUNTED ONCE: A BACKGROUNDED CALL PAST THE DEPTH CAP/ },
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
