'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-90 L6 M2 (god 3dc16a): the tool-output condenser keeps a memory search reply's header and brief block
 * (every line above the first hit) whole, the way it keeps the header, within BRIEF_BLOCK_MAX_CHARS; the rest of
 * the reply is condensed as before, error and warning lines included. The reply is the real --full search text.
 * Synthetic ids only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const loadTs = require(path.join(__dirname, 'load-ts.cjs'));
const C = loadTs('src/main/toolOutputCondense.ts');
const F = loadTs('src/main/nativeMemory/format.ts');

const BRIEF = ['donesha (latest): 1111111aaaaaaa', 'lastsha: 2222222bbbbbbb', 'status: blocked (build failed once)', 'assignee: syn-agent', 'merge: 3333333 into int-9.1.2'];
const hit = (i) => ({
  chunkId: i, wing: 'syn', room: `r${i}`, source: `syn/${i}.md`, cosineSim: 0.5, bm25: 1, score: 1,
  content: Array.from({ length: 12 }, (_, k) => `note ${i}.${k}: the syn-7 run ${k % 4 === 0 ? 'failed with an error' : 'went on'} ${'x'.repeat(60)}`).join('\n'),
});
const reply = (leads) => F.formatSearch('syn-7 done sha', { full: true }, Array.from({ length: 10 }, (_, i) => hit(i + 1)), leads, Object.keys(leads));
const condense = (text, cap = 1500) => C.condenseOutput({ text, cap, path: 'C:/p/t.txt' });
const count = (s, line) => s.split('\n').filter((l) => l === line).length;

test('a condensed --full search keeps the named brief whole, once, right under the header', () => {
  const text = reply({ 'syn-7': BRIEF });
  assert.ok(text.length > 6000, 'the reply is far over the cap');
  const out = condense(text);
  const lines = out.split('\n');
  assert.equal(count(out, '  Results for: "syn-7 done sha"'), 1, 'the header once');
  assert.equal(count(out, '  syn-7'), 1);
  for (const b of BRIEF) assert.equal(lines.filter((l) => l.trim() === b).length, 1, `brief line once: ${b}`);
  const at = lines.indexOf('  syn-7');
  assert.equal(at, lines.indexOf('  Results for: "syn-7 done sha"') + 3, 'the brief sits under the header (rule, blank line)');
  assert.match(out, /lines omitted; error and warning lines among them:/, 'error handling is kept');
  assert.match(out, /failed with an error/);
  assert.ok(out.endsWith('End a command with #full to see its output uncondensed.]'), 'the path is last');
  const block = C.searchBriefLines(text.replace(/\n$/, '').split('\n'));
  assert.ok(block > 0);
  const blockChars = text.split('\n').slice(0, block).reduce((n, l) => n + l.length + 1, 0);
  assert.ok(out.length <= 1500 + blockChars, 'the cap still holds for everything past the block');
});

test('with room for head lines, they start at the first hit: the block is never repeated', () => {
  const small = (i) => ({ ...hit(i), content: Array.from({ length: 14 }, (_, k) => `n${i}.${k} ok ${'w'.repeat(24)}`).join('\n') });
  const text = F.formatSearch('syn-7 done sha', { full: true }, [1, 2, 3].map(small), { 'syn-7': BRIEF }, ['syn-7']);
  assert.ok(text.length > 1500);
  const out = condense(text);
  const lines = out.split('\n');
  assert.equal(count(out, '='.repeat(60)), 2, 'the header rules once');
  assert.equal(count(out, '  Results for: "syn-7 done sha"'), 1);
  const end = lines.findIndex((l) => l.trim() === BRIEF[BRIEF.length - 1]);
  assert.ok(end > 0);
  assert.equal(lines[end + 2], '  [1] syn / r1', 'the first head line after the block is the first hit');
});

test('any other output condenses as before: no block', () => {
  const plain = Array.from({ length: 300 }, (_, i) => `line ${i} ${i % 50 === 0 ? 'warning: x' : 'ok'}`).join('\n');
  assert.equal(C.searchBriefLines(plain.split('\n')), 0);
  assert.equal(C.searchBriefLines(['  Results for: "q"', '  syn-7', '  … 3 more hits not shown (x)']), 2, 'no [1] hit: the block ends at the footer');
  assert.equal(C.searchBriefLines(['  Results for: "q"', '  syn-7', '    a: b']), 3, 'no hit and no footer: the block runs to the end');
  assert.equal(C.searchBriefLines([...Array(25).fill('x'), '  Results for: "q"', '  [1] a / b']), 0, 'the header must be near the top');
  const out = condense(plain);
  assert.ok(out.length <= 1500);
  assert.match(out, /^\[condensed by Guppy[^\n]*\]\nline 0 warning: x\nline 1 ok\n/, 'head lines start at the top');
});

test('n=310: a compact reply whose briefs leave no room for a hit keeps both briefs whole', () => {
  const long = (id) => Array.from({ length: 12 }, (_, k) => `field${k}: ${id} value ${'v'.repeat(48)}`);
  const leads = { 'syn-7': long('syn-7'), 'int-9.1.2': long('int-9.1.2') };
  const text = F.formatSearch('syn-7 rebase merged int-9.1.2', {}, Array.from({ length: 8 }, (_, i) => hit(i + 1)), leads, Object.keys(leads));
  assert.ok(!/^\s*\[1\] /m.test(text), 'no hit printed (the n=310 shape)');
  assert.ok(text.length > 1500, 'over the cap');
  const out = condense(text);
  const lines = out.split('\n');
  for (const [id, items] of Object.entries(leads)) for (const b of items) assert.equal(lines.filter((l) => l.trim() === b).length, 1, `${id} brief line once: ${b}`);
});

test('the block is bounded: whole lines up to BRIEF_BLOCK_MAX_CHARS, the rest counted', () => {
  const leads = {};
  for (let i = 0; i < 40; i++) leads[`syn-${i}`] = BRIEF.map((b) => `${b} ${'y'.repeat(100)}`);
  const lines = Array.from({ length: 200 }, (_, i) => `  card line ${i} ${'z'.repeat(80)}`);
  const text = ['', '='.repeat(60), '  Results for: "q"', '='.repeat(60), '', ...lines, '', '  [1] syn / r', '      body'].join('\n');
  const out = condense(text);
  assert.ok(out.length <= 1500 + C.BRIEF_BLOCK_MAX_CHARS + 200, 'bounded');
  assert.match(out, /… \d+ brief lines omitted/);
  assert.ok(out.includes('  card line 0 '), 'the first brief lines are kept');
});
