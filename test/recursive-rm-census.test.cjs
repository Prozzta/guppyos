'use strict';
require('./tools/own-job.cjs');

/**
 * ELECTRON-RMSYNC-AGENT-WRITABLE-108: no recursive remove anywhere in src/main, the two remover
 * modules included.
 *
 * Under Electron 45 a recursive rmSync deletes THROUGH a Windows junction: the files the link
 * points at go too (pinned in electron-rmsync-link-safe.test.cjs, RUNTIME PIN). Every remove of a
 * folder in the main process therefore goes through src/main/linkSafeRemove.ts (a path that may be
 * anything) or src/main/fsSafeRemove.ts (a real folder). fsSafeRemove walks the tree bottom-up
 * and removes each entry by itself, so it holds no recursive remove either (since f18d624d), and
 * nothing is exempt. This census reads the source, so a new site is caught without a fixture.
 *
 * A call is counted when it is rm, rmSync, rmdir or rmdirSync (bare or as a member) and either
 * names `recursive` in its arguments or takes options that are not an object literal (they cannot
 * be read here, so they are assumed recursive).
 *
 * A second pattern (NIT 1 of Jim's audit of 2edbe77f) counts the ways a remove can be reached
 * under another name, which the first pattern would not see called:
 *   const zap = fs.rmSync          a remove assigned to a name
 *   { rmSync: zap }, rm as zap     renamed in a destructuring, an object or an import
 *   fs['rmSync']                   bracket access
 *   promisify(fs.rm), rm.bind(..)  handed on as a value
 * A plain `import { rmSync }` keeps its name, so its calls are read by the first pattern.
 *
 * A site that must stay goes in ALLOW with the reason. An entry that matches nothing fails too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'main');
/** The two remover modules, by path under src/main. They are read like any other file. */
const REMOVERS = ['fsSafeRemove.ts', 'linkSafeRemove.ts'];
/** { file (under src/main, forward slashes), call (the text of the call, whitespace collapsed), reason }. */
const ALLOW = [];

/** The top-level arguments of the call whose `(` is at `open`; null if it never closes. */
function argsAt(text, open) {
  const args = []; let depth = 0; let from = open + 1; let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { const last = text.slice(from, i).trim(); if (last) args.push(last); return { args, end: i }; }
    } else if (c === ',' && depth === 1) { args.push(text.slice(from, i).trim()); from = i + 1; }
  }
  return null;
}

/** Every recursive remove in `text`: { line, call }. */
function recursiveRemoves(text) {
  const found = [];
  const re = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\(/g;
  for (let m; (m = re.exec(text));) {
    const call = argsAt(text, m.index + m[0].length - 1);
    if (!call) continue;
    const opts = call.args[1];
    // `name(a: string, b: Opts)` is a declaration, not a call: its "arguments" are typed names.
    if (call.args.every((a) => /^[\w$]+\??\s*:/.test(a))) continue;
    if (opts === undefined) continue;
    if (/\brecursive\b/.test(opts) || !opts.startsWith('{')) {
      found.push({ line: text.slice(0, m.index).split('\n').length, call: text.slice(m.index, call.end + 1).replace(/\s+/g, ' ') });
    }
  }
  return found;
}

const NAMES = '(?:rm|rmSync|rmdir|rmdirSync)';
const ALIAS_PATTERNS = [
  new RegExp(`=\\s*(?:[\\w$]+\\s*\\.\\s*)*${NAMES}\\s*(?=[;,)\\]}\\r\\n]|$)`, 'g'),          // = fs.rmSync;
  new RegExp(`\\b${NAMES}\\s*:\\s*[A-Za-z_$][\\w$]*\\s*(?=[,}=])`, 'g'),                        // { rmSync: zap }
  new RegExp(`\\b${NAMES}\\s+as\\s+[\\w$]+`, 'g'),                                              // rmSync as zap
  new RegExp(`\\[\\s*(['"\`])${NAMES}\\1\\s*\\]`, 'g'),                                         // fs['rmSync']
  new RegExp(`[(,]\\s*(?:[\\w$]+\\s*\\.\\s*)+${NAMES}\\s*(?=[,)])`, 'g'),                       // promisify(fs.rm)
  new RegExp(`\\b${NAMES}\\s*\\.\\s*(?:bind|call|apply)\\b`, 'g')                               // rmSync.bind(fs)
];

/** Every place `text` reaches a remove under another name: { line, call }. */
function aliasedRemoves(text) {
  const found = [];
  for (const re of ALIAS_PATTERNS) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(text));) found.push({ line: text.slice(0, m.index).split('\n').length, call: m[0].replace(/\s+/g, ' ').trim() });
  }
  return found.sort((a, b) => a.line - b.line);
}

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(?:ts|tsx|cjs|mjs|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('the census itself: what it counts as a recursive remove, and what it does not', () => {
  const count = (src) => recursiveRemoves(src).length;
  assert.equal(count('rmSync(p, { recursive: true, force: true });'), 1);
  assert.equal(count('fs.rmSync(p, { force: true, recursive: true });'), 1);
  assert.equal(count('await fs.promises.rm(join(a, "b)"), {\n  recursive: true\n});'), 1, 'over lines, with a bracket in a string');
  assert.equal(count('await rm(p, { recursive, force: true });'), 1, 'shorthand');
  assert.equal(count('rmdirSync(p, { recursive: true });'), 1);
  assert.equal(count('nodeFs.rmSync(p, opts);'), 1, 'options that cannot be read are counted');
  assert.equal(count('rmSync(p, { force: true });'), 0, 'one file');
  assert.equal(count('rmdirSync(p); await rm(p);'), 0);
  assert.equal(count('mkdirSync(p, { recursive: true }); readdirSync(p, { recursive: true }); cpSync(a, b, { recursive: true });'), 0);
  assert.equal(count('removePathLinkSafeSync(p); // was rmSync, recursive'), 0);
  assert.equal(count('async rm(path: string, opts: RmOptions): Promise<void> {'), 0, 'a declaration');
  assert.deepEqual(recursiveRemoves('a();\nb();\nrmSync(x,\n {recursive:true});'), [{ line: 3, call: 'rmSync(x, {recursive:true})' }]);
});

test('the census itself: a remove reached under another name is counted, a plain import is not', () => {
  const hits = (src) => aliasedRemoves(src).map((h) => h.call);
  assert.deepEqual(hits('const zap = fs.rmSync;'), ['= fs.rmSync']);
  assert.deepEqual(hits('const zap = rmSync\nzap(p, o);'), ['= rmSync']);
  assert.deepEqual(hits('let del = nodeFs.promises.rm, x = 1;'), ['= nodeFs.promises.rm']);
  assert.deepEqual(hits('const { rmSync: zap } = require("node:fs");'), ['rmSync: zap']);
  assert.deepEqual(hits('const { a, rmdirSync : gone, b } = fs;'), ['rmdirSync : gone']);
  assert.deepEqual(hits('const ops = { rm: remove, x };'), ['rm: remove']);
  assert.deepEqual(hits('import { rmSync as zap, readFileSync } from "node:fs";'), ['rmSync as zap']);
  assert.deepEqual(hits("fs['rmSync'](p, o);"), ["['rmSync']"]);
  assert.deepEqual(hits('fs["rm"](p, o); fs[ `rmdir` ](p);'), ['["rm"]', '[ `rmdir` ]']);
  assert.deepEqual(hits('const del = promisify(fs.rm);'), ['(fs.rm']);
  assert.deepEqual(hits('retry(3, nodeFs.rmSync, p);'), [', nodeFs.rmSync']);
  assert.deepEqual(hits('const zap = rmSync.bind(null);'), ['rmSync.bind']);
  assert.deepEqual(hits('fs.rm.call(fs, p, o);'), ['rm.call']);
  for (const fine of [
    'import { existsSync, rmSync, writeFileSync } from "node:fs";', 'import { lstat, rm } from "node:fs/promises";',
    'const { rm, rmSync } = require("node:fs");', 'rmSync(p, { force: true }); await fs.promises.rm(p);',
    'for (const rm of root.resourceMetrics) { use(rm.resource); }', 'interface D { rmdir: (p: string) => Promise<void> }',
    "type F = Pick<typeof nodeFs, 'statSync' | 'rmSync'>;", "const SAFE = ['mkdir', 'rm', 'cp'];", 'x = { rmSync: typeof fs.rmSync };',
    '// const zap was rmSync once'
  ]) assert.deepEqual(hits(fine), [], fine);
});

test('no recursive remove in src/main, and no remove reached under another name', () => {
  for (const r of REMOVERS) assert.equal(fs.existsSync(path.join(SRC, r)), true, `${r} exists`);
  const files = sourceFiles(SRC);
  assert.ok(files.length > 100, `the walk saw src/main (${files.length} files)`);
  const used = new Set();
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    for (const { line, call } of [...recursiveRemoves(text), ...aliasedRemoves(text)]) {
      const i = ALLOW.findIndex((a) => a.file === rel && a.call === call);
      if (i >= 0) used.add(i); else offenders.push(`${rel}:${line} ${call}`);
    }
  }
  assert.deepEqual(offenders, [], 'USE removePathLinkSafe / removePathLinkSafeSync (src/main/linkSafeRemove.ts) AND CALL A REMOVE BY ITS OWN NAME, OR ADD AN ALLOW ENTRY WITH ITS REASON');
  ALLOW.forEach((a, i) => {
    assert.ok(typeof a.reason === 'string' && a.reason.length >= 30, `ALLOW ${a.file}: a reason is given`);
    assert.ok(used.has(i), `ALLOW ${a.file} ${a.call}: still matches a call (remove a stale entry)`);
  });
});

test('the removers hold no recursive remove: fsSafeRemove walks bottom-up, linkSafeRemove only chooses', () => {
  const body = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
  for (const r of REMOVERS) {
    assert.deepEqual(recursiveRemoves(body(r)), [], `${r} has no recursive remove`);
    assert.deepEqual(aliasedRemoves(body(r)), [], `${r} reaches no remove under another name`);
  }
  assert.match(body('fsSafeRemove.ts'), /\brmdirSync\(p\);/, 'fsSafeRemove.ts removes a folder by itself, after its entries');
  assert.doesNotMatch(body('fsSafeRemove.ts'), /^import .*\brm(?:Sync)?\b/m, 'fsSafeRemove.ts does not import rm or rmSync at all');
});
