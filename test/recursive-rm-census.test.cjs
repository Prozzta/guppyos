'use strict';
require('./tools/own-job.cjs');

/**
 * ELECTRON-RMSYNC-AGENT-WRITABLE-108: no recursive remove in src/main outside the two modules that
 * exist to make one safely.
 *
 * Under Electron 45 a recursive rmSync deletes THROUGH a Windows junction: the files the link
 * points at go too (pinned in electron-rmsync-link-safe.test.cjs, RUNTIME PIN). Every remove of a
 * folder in the main process therefore goes through src/main/linkSafeRemove.ts (a path that may be
 * anything) or src/main/fsSafeRemove.ts (a tree known to be a real folder). This census reads the
 * source, so a new site is caught without a fixture for it.
 *
 * A call is counted when it is rm, rmSync, rmdir or rmdirSync (bare or as a member) and either
 * names `recursive` in its arguments or takes options that are not an object literal (they cannot
 * be read here, so they are assumed recursive).
 *
 * A site that must stay goes in ALLOW with the reason. An entry that matches nothing fails too.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src', 'main');
/** The two modules that hold the recursive removes, by path under src/main. */
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

test('no recursive remove in src/main outside fsSafeRemove.ts and linkSafeRemove.ts', () => {
  for (const r of REMOVERS) assert.equal(fs.existsSync(path.join(SRC, r)), true, `${r} exists`);
  const files = sourceFiles(SRC);
  assert.ok(files.length > 100, `the walk saw src/main (${files.length} files)`);
  const used = new Set();
  const offenders = [];
  for (const f of files) {
    const rel = path.relative(SRC, f).split(path.sep).join('/');
    if (REMOVERS.includes(rel)) continue;
    for (const { line, call } of recursiveRemoves(fs.readFileSync(f, 'utf8'))) {
      const i = ALLOW.findIndex((a) => a.file === rel && a.call === call);
      if (i >= 0) used.add(i); else offenders.push(`${rel}:${line} ${call}`);
    }
  }
  assert.deepEqual(offenders, [], 'USE removePathLinkSafe / removePathLinkSafeSync (src/main/linkSafeRemove.ts), OR ADD AN ALLOW ENTRY WITH ITS REASON');
  ALLOW.forEach((a, i) => {
    assert.ok(typeof a.reason === 'string' && a.reason.length >= 30, `ALLOW ${a.file}: a reason is given`);
    assert.ok(used.has(i), `ALLOW ${a.file} ${a.call}: still matches a call (remove a stale entry)`);
  });
});

test('the removers are where the recursive removes are: fsSafeRemove has them, linkSafeRemove has none of its own', () => {
  const body = (f) => { const s = fs.readFileSync(path.join(SRC, f), 'utf8'); return s.slice(s.indexOf('*/')); };
  assert.ok(recursiveRemoves(body('fsSafeRemove.ts')).length >= 1, 'fsSafeRemove.ts removes the tree after its link pass');
  assert.deepEqual(recursiveRemoves(body('linkSafeRemove.ts')), [], 'linkSafeRemove.ts only chooses; it never removes a tree itself');
});
