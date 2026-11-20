'use strict';
require('./tools/own-job.cjs');
/**
 * FLAKE-MAIL-RECOVER-189-ENOTEMPTY (the class): a hive manager's dispose() stops NEW async reads, but
 * the ones already open still hold files in its folder until drainReads() resolves (src/main/hive.ts:
 * "a caller that removes the folder awaits drainReads() in between"). A test that disposes and then
 * removes its folder without that wait gets ENOTEMPTY / a TEMP LEAK on Windows, under load only.
 *
 * Two rules over every source file under test/ (helpers and sub-folders included, no exceptions):
 *   A. a file that builds a manager awaits drainReads() somewhere;
 *   B. no synchronous one-line after-hook disposes a manager the file built: such a hook cannot wait,
 *      so a second manager in a file that drains its first one is still caught.
 * "Builds" covers the class under another name the file gives it and the class handed to a helper.
 * B reads one line at a time and knows a name only where the file binds it to a construction, so a
 * synchronous hook written over several lines, or on a manager built from a bare parameter, is seen by A only.
 * A failure lists each file (for B each line) with the text to write.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const SOURCE = /\.(cjs|mjs|js|ts)$/;
/** Another name the file gives the class: `{ HiveManager: Mutant }`, `Manager = HiveManager`, `M = mod.HiveManager`. */
const ALIAS = /HiveManager\s*:\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)*HiveManager\b(?!\s*[.(])/g;
/** The class built in place, or handed to a helper that builds it: `(HiveManager)(...)`, `killer(t, HiveManager)`. */
const HANDS = /[(,]\s*(?:[\w$]+\.)*HiveManager\s*\)|HiveManager\)\s*\(/;
const AWAITS_DRAIN = /await\s+[^;\n]*drainReads\s*\??\.?\s*\(/;

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (SOURCE.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * The file's text with comments and the insides of one-line quoted strings blanked (same length, same
 * line numbers): prose cannot match, and neither can a test that quotes source text to search for it.
 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
}

/** `new X(` for the class under its own name or any name the file gives it (regex source). */
function construction(text) {
  const names = new Set(['HiveManager']);
  for (const m of text.matchAll(ALIAS)) names.add(m[1] || m[2]);
  return `new\\s+(?:[\\w$]+\\.)*(?:${[...names].map((n) => n.replace(/\$/g, '\\$')).join('|')})\\s*\\(`;
}
const builds = (text) => new RegExp(construction(text)).test(text) || HANDS.test(text);

/** Lines where a synchronous one-line after-hook disposes a manager the file built. */
function syncHookDisposes(text) {
  const names = new Set();
  const bound = new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*(?:[^;\\n=]*?\\?\\s*)?${construction(text)}`, 'g');
  for (const m of text.matchAll(bound)) names.add(m[1]);
  const out = [];
  const lines = text.split('\n');
  for (const name of names) {
    const n = name.replace(/\$/g, '\\$');
    const hook = new RegExp(`\\bafter\\(\\s*\\(\\)\\s*=>[^\\n]*(?<![\\w$.])${n}\\s*\\??\\.dispose\\(\\)`);
    lines.forEach((l, i) => { if (hook.test(l)) out.push({ name, line: i + 1 }); });
  }
  return out.sort((a, b) => a.line - b.line);
}

const rel = (p) => path.relative(TEST_DIR, p).split(path.sep).join('/');
const builders = sourceFiles(TEST_DIR)
  .map((p) => ({ file: rel(p), text: code(fs.readFileSync(p, 'utf8')) }))
  .filter((f) => builds(f.text))
  .sort((a, b) => (a.file < b.file ? -1 : 1));

test('the guard sees the test files that build a manager, and not itself', () => {
  assert.ok(builders.length >= 100, `expected the 100+ files under test/ that build a manager, found ${builders.length}`);
  assert.ok(builders.some((f) => f.file === 'mail-channel-recover-189.test.cjs'), 'mail-channel-recover-189.test.cjs is among them');
  assert.ok(builders.some((f) => f.file.includes('/')), 'files in sub-folders are among them');
  assert.ok(!builders.some((f) => f.file === rel(__filename)), 'this file builds none (its samples spell the class name at run time)');
});

test('A. every file under test/ that builds a manager awaits drainReads()', () => {
  const bad = builders.filter((f) => !AWAITS_DRAIN.test(f.text)).map((f) => f.file);
  assert.deepEqual(bad, [],
    `${bad.length} file(s) build a manager and never await drainReads(). After dispose() and before the folder `
    + `is removed, write: await hive.drainReads();\n  ${bad.join('\n  ')}`);
});

test('B. no synchronous one-line after-hook disposes a manager', () => {
  const bad = [];
  for (const f of builders) {
    for (const d of syncHookDisposes(f.text)) bad.push(`${f.file}:${d.line}  after(async () => { ${d.name}.dispose(); await ${d.name}.drainReads(); })`);
  }
  assert.deepEqual(bad, [],
    `${bad.length} synchronous after-hook(s) dispose a manager and cannot wait for its reads. Write:\n  ${bad.join('\n  ')}`);
});

test('the rules themselves: what each one catches and what it lets through', () => {
  // HM stands for the class name, so this file is not one of the files it reads.
  const src = (s) => code(s.replace(/HM/g, 'HiveManager'));
  const hooks = (s) => syncHookDisposes(src(s)).map((d) => `${d.name}:${d.line}`);
  const built = (s) => builds(src(s));
  assert.equal(built('const hive = new HM(() => home);'), true, 'a plain construction');
  assert.equal(built('const hive = new m.HM(() => home);'), true, 'a construction through a module object');
  assert.equal(built('// new HM(() => home)'), false, 'a comment builds nothing');
  assert.equal(built("assert.ok(index.indexOf('const hive = new HM(') > 0);"), false, 'quoted source text builds nothing');
  assert.equal(built("const hive = new HM(() => path.join(home, 'harness'));"), true, 'a string argument does not hide the construction');
  assert.equal(built('const { HM: Mutant } = load(text);\nconst hive = new Mutant(() => home);'), true, 'the class under a renamed import');
  assert.equal(built('async function floor(t, Manager = HM) { return new Manager(() => home); }'), true, 'the class as a default parameter');
  assert.equal(built('await killer(t, HM);'), true, 'the class handed to a helper that builds it');
  assert.equal(built('const hive = new (load().HM)(() => home);'), true, 'the class from a call');
  assert.equal(built('const { A, HM, B } = load();\nconst real = HM.prototype.ensureAgent;\nconst n = HM.agyAgentName(id);'), false, 'naming the class builds nothing');
  assert.equal(built('const Other = Thing;\nconst x = new Other(1);'), false, 'another class under another name');
  assert.deepEqual(hooks('const { HM: Mutant } = load(text);\nconst hive = new Mutant(x);\nt.after(() => hive.dispose());'), ['hive:3'], 'a hook on a manager built under another name');
  assert.deepEqual(hooks('const hive = new HM(() => home);\nt.after(() => hive.dispose());'), ['hive:2'], 'a bare hook');
  assert.deepEqual(hooks('const again = new m.HM(x);\nt.after(() => { try { s.stop(); } catch { } again.dispose(); });'), ['again:2'], 'a hook with a body');
  assert.deepEqual(hooks('let hive;\nhive = live ? new HM(a) : new HM(b);\ntest.after(() => hive?.dispose());'), ['hive:3'], 'optional call, ternary binding');
  assert.deepEqual(hooks('const hive = new HM(x);\nt.after(async () => { hive.dispose(); await hive.drainReads(); });'), [], 'the pattern');
  assert.deepEqual(hooks('const hive = new HM(x);\nt.after(() => mirror.dispose());\nhive.dispose();'), [], 'another object, and a dispose outside a hook');
  assert.equal(AWAITS_DRAIN.test(src('hive.dispose(); await hive.drainReads();')), true, 'rule A: the wait');
  assert.equal(AWAITS_DRAIN.test(src('await last?.drainReads?.();')), true, 'rule A: optional forms');
  assert.equal(AWAITS_DRAIN.test(src('// await hive.drainReads();\nhive.drainReads();')), false, 'rule A: a comment or an unawaited call is no wait');
});
