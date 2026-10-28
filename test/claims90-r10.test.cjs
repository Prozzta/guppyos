'use strict';
/**
 * CLAIMS-90 round 10 (god a22191): five general index rules in the done-mail indexer (doneMailFacts), each
 * with its twins. F1: a subject token that is a known id plus a role suffix (ABC-12-INT), or a unique leading
 * short form, names that card. F2: a done mail naming two or more cards is indexed under each, with the sha
 * the subject pairs with that card. F3: the mail's own field, then its own subject, outranks the thread it
 * replies to. F4: a reply's subject @sha that quotes the subject it replies to is not the reported sha.
 * F5: a range A..B reports the card's own commits in it. Synthetic names and shas only; a fake git port;
 * HOME jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-r10-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const F = loadTs('src/main/claims/derivedFacts.ts');

const H = (c) => c.repeat(40);
const SRC = ['src/main/w.ts'];
/** A git port over fixed maps: short -> full, full -> subject; parents/files/times/ancestors/ranges optional. */
function fakeGit(commits, messages, extra = {}) {
  const anc = extra.ancestors ?? [];
  return {
    async commitOf(s) { return commits[s] ?? null; },
    async isAncestor(a, b) { return anc.some(([x, y]) => x === a && y === b); },
    async time(c) { return (extra.times && extra.times[c]) ?? 0; },
    async message(c) { return messages[c] ?? null; },
    ...(extra.parents ? { async parents(c) { return extra.parents[c] ?? []; } } : {}),
    ...(extra.files ? { async changedFiles(c) { return extra.files[c] ?? null; } } : {}),
    ...(extra.versions ? { async versionOnly(c) { return extra.versions[c] ?? null; } } : {}),
    ...(extra.ranges ? { async rangeCommits(a, b) { return extra.ranges[`${a}..${b}`] ?? null; } } : {}),
  };
}
const T0 = '2026-01-10T10:00:00.000Z';
const T1 = '2026-01-11T10:00:00.000Z';
const slot = (card, who) => `card.${card.toLowerCase()}.donesha#${who}`;
const commitOf = (r, s) => { const f = r.facts.find((x) => x.slot === s); return f ? f.refs.find((y) => y.type === 'commit').value : undefined; };
const mail = (id, subject, extra = {}) => ({ id, act: 'done', from: 'sam-aaaaaaaa', subject, body: '', created_at: T0, ...extra });
const SAM = 'sam-aaaaaaaa';

// ———————————————————————————————————————————————————————————— F1

test('F1: a known id plus a role suffix names the card (ABC-12-INT -> ABC-12) unless the suffix form is itself a card; a unique leading short form names its card; a shared prefix stays unresolved', async () => {
  const CARDS = ['ABC-12', 'ABC-13', 'ABC-13-INT', 'LONG-NAME-DELTA-7', 'TWIN-NAME-ECHO-8', 'TWIN-NAME-FOX-9'];
  const namer = F.cardNamer(CARDS);
  assert.deepEqual(namer('ABC-12-INT PASS'), { cards: ['ABC-12'], others: [] }, 'a role suffix on a known id');
  assert.deepEqual(namer('ABC-12-INT-AUDIT PASS'), { cards: ['ABC-12'], others: [] }, 'two role words');
  assert.deepEqual(namer('ABC-13-INT PASS'), { cards: ['ABC-13-INT'], others: [] }, 'twin: a suffix form that is a real card is that card');
  assert.deepEqual(namer('ABC-12-3 PASS').cards, ['ABC-12'], 'the numbered form (round 6) still names the card');
  assert.deepEqual(namer('LONG-NAME shipped'), { cards: ['LONG-NAME-DELTA-7'], others: [] }, 'a unique leading short form');
  assert.deepEqual(namer('TWIN-NAME shipped'), { cards: [], others: ['TWIN-NAME'] }, 'twin: two cards share the prefix: unresolved, some other card');
  assert.deepEqual(namer('ABC-12-STAGE-3 PASS'), { cards: [], others: ['ABC-12-STAGE-3'] }, 'MUTANT F1: a suffix with a digit is no role suffix (another card)');
  // Indexed under the card: a done mail with no card field, its subject token the role form, its commit the card's own.
  const git = fakeGit({ '1111aaa': H('1') }, { [H('1')]: 'ABC-12: the widget' }, { files: { [H('1')]: SRC } });
  const r = await F.doneMailFacts([mail('f1-a', 'ABC-12-INT PASS 0/0/0 @1111aaa')], CARDS, git);
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1'), 'MUTANT F1: indexed under ABC-12');
  assert.deepEqual(r.skips, []);
  const amb = await F.doneMailFacts([mail('f1-b', 'TWIN-NAME PASS @1111aaa')], CARDS, git);
  assert.deepEqual(amb.skips, [{ mail: 'f1-b', reason: 'noCard' }], 'twin: the shared prefix indexes nothing');
});

// ———————————————————————————————————————————————————————————— F2

test('F2: a done mail whose subject names two or more cards with @shas is indexed under EACH card with the sha the subject pairs with it', async () => {
  const CARDS = ['ABC-12', 'ABC-13', 'INT-9.9.9'];
  const M = 'ab'.repeat(20);
  const git = fakeGit(
    { '1111aaa': H('1'), '2222bbb': H('2'), '3333ccc': H('3'), '4444ddd': H('4'), '5555eee': H('5'), '6666fff': H('6'), ab1ab1a: M },
    { [H('1')]: 'ABC-12: the widget', [H('2')]: 'ABC-13: the gadget', [H('3')]: 'ABC-12 ABC-13: the shared refactor', [H('4')]: 'housekeeping',
      [H('5')]: 'int-9.9.9 stage 1: base', [H('6')]: 'ABC-13: a fixup', [M]: 'Merge guppy/abc-12 @1111aaa into int-9.9.9 stage 2 (ABC-12, PASS)' },
    { files: { [H('1')]: SRC, [H('2')]: SRC, [H('3')]: SRC, [H('4')]: SRC, [H('5')]: SRC, [H('6')]: SRC }, parents: { [M]: [H('5'), H('1')] } },
  );
  const run = (id, subject, extra) => F.doneMailFacts([mail(id, subject, extra)], CARDS, git);
  // Twin 1: two cards, two paired shas (segments; the id before the sha; a branch name before it).
  let r = await run('f2-a', 'ABC-12 PASS @1111aaa; ABC-13 PASS @2222bbb');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1'), 'MUTANT F2: the first segment pairs ABC-12 with its sha');
  assert.equal(commitOf(r, slot('ABC-13', SAM)), H('2'), 'MUTANT F2: the second segment pairs ABC-13 with its sha');
  assert.deepEqual(r.skips, []);
  r = await run('f2-b', 'landed ABC-12 @1111aaa and ABC-13 @2222bbb: PASS');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1')); assert.equal(commitOf(r, slot('ABC-13', SAM)), H('2'), 'the word before each @sha');
  r = await run('f2-c', 'merge guppy/abc-12 @1111aaa (ABC-12 the widget) + merge guppy/abc-13 @2222bbb (ABC-13 the gadget)');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1')); assert.equal(commitOf(r, slot('ABC-13', SAM)), H('2'), 'a branch name before each @sha');
  // Twin 2: two cards sharing one sha (a commit naming both).
  r = await run('f2-d', 'ABC-12 + ABC-13 refactor: PASS @3333ccc');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('3'), 'MUTANT F2: one @sha for the segment goes to every card in it');
  assert.equal(commitOf(r, slot('ABC-13', SAM)), H('3'));
  assert.deepEqual(r.skips, []);
  // Twin 3: an int-merge report: the feature card's line gets its branch-tip sha, never the int merge; the int line keeps the merge.
  r = await run('f2-e', 'INT-9.9.9 stage 2: merge guppy/abc-12 @ab1ab1a (ABC-12 the widget) PASS');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1'), 'MUTANT F2: the merged parent, never the int merge commit');
  assert.equal(commitOf(r, slot('INT-9.9.9', SAM)), M, 'the merge into its own line is the int card\'s');
  assert.deepEqual(r.skips, []);
  // The other card's sha never becomes this card's: a paired sha whose commit is the other card's work is ambiguous.
  r = await run('f2-f', 'ABC-12 PASS @2222bbb; ABC-13 PASS @1111aaa');
  assert.deepEqual(r.skips, [{ mail: 'f2-f', reason: 'ambiguous', cards: ['ABC-12'] }, { mail: 'f2-f', reason: 'ambiguous', cards: ['ABC-13'] }], 'MUTANT F2: the pairing is checked against the commit');
  // A pairing that cannot be settled (two cards, three @shas in one segment) is ambiguous for those cards; a card the subject names
  // and no commit confirms gets no row, and a body-sha mail (no subject @sha) keeps the one-card git rule.
  r = await run('f2-g', 'ABC-12 ABC-13 @1111aaa @2222bbb @4444ddd PASS');
  assert.deepEqual(r.skips, [{ mail: 'f2-g', reason: 'ambiguous', cards: ['ABC-12'] }, { mail: 'f2-g', reason: 'ambiguous', cards: ['ABC-13'] }]);
  r = await run('f2-h', 'ABC-12 and ABC-13 at 1111aaa');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1')); assert.equal(commitOf(r, slot('ABC-13', SAM)), undefined, 'no @sha: the one card git confirms (unchanged)');
  // The F1 forms name cards here too (ABC-12-INT -> ABC-12).
  r = await run('f2-i', 'ABC-12-INT PASS @1111aaa; ABC-13-INT PASS @6666fff');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1')); assert.equal(commitOf(r, slot('ABC-13', SAM)), H('6'));
  // pairedAtShas itself.
  const namer = F.cardNamer(CARDS);
  assert.deepEqual([...F.pairedAtShas('ABC-12 @1111aaa, ABC-13 @2222bbb - ABC-12 again @3333ccc', ['ABC-12', 'ABC-13'], namer)], [['ABC-12', ['1111aaa', '3333ccc']], ['ABC-13', ['2222bbb']]]);
  assert.deepEqual([...F.pairedAtShas('ABC-12 and ABC-13 @1111aaa @2222bbb', ['ABC-12', 'ABC-13'], namer)], [['ABC-12', ['2222bbb']], ['ABC-13', ['1111aaa']]], 'the id written before an @sha claims it first; the other sha goes to the open card');
  assert.deepEqual([...F.pairedAtShas('ABC-12 and ABC-13 landed: @1111aaa, @2222bbb', ['ABC-12', 'ABC-13'], namer)], [['ABC-12', ['1111aaa']], ['ABC-13', ['2222bbb']]], 'as many @shas as cards pair in order of appearance');
  assert.deepEqual([...F.pairedAtShas('ABC-13 and ABC-12 landed: @1111aaa, @2222bbb', ['ABC-12', 'ABC-13'], namer)], [['ABC-12', ['2222bbb']], ['ABC-13', ['1111aaa']]], 'MUTANT F2: order of appearance, not of the card list');
  assert.deepEqual([...F.pairedAtShas('ABC-12 PASS @1111aaa; ABC-13 FAIL', ['ABC-12', 'ABC-13'], namer)], [['ABC-12', ['1111aaa']], ['ABC-13', []]], 'a card in a segment with no @sha gets none');
});

// ———————————————————————————————————————————————————————————— F3

test('F3: the mail\'s own card field, then a card its own subject names, outranks the card of the thread it replies to; the reply link applies only when the mail names no card', async () => {
  const CARDS = ['ABC-12', 'ABC-13'];
  const git = fakeGit({ '1111aaa': H('1'), '2222bbb': H('2'), '4444ddd': H('4') }, { [H('1')]: 'ABC-12: the widget', [H('2')]: 'ABC-13: the gadget', [H('4')]: 'housekeeping' },
    { files: { [H('1')]: SRC, [H('2')]: SRC, [H('4')]: SRC } });
  const run = (id, subject, extra) => F.doneMailFacts([mail(id, subject, { cards: ['ABC-12'], ...extra })], CARDS, git);
  // Twin: a reply in card A's thread (linked to ABC-12) whose card field is ABC-13 is indexed to ABC-13 only.
  let r = await run('f3-a', 'Re: ABC-12 audit: PASS @2222bbb', { card: 'ABC-13' });
  assert.equal(commitOf(r, slot('ABC-13', SAM)), H('2'));
  assert.equal(commitOf(r, slot('ABC-12', SAM)), undefined, 'MUTANT F3: the field outranks the thread and the subject');
  assert.deepEqual(r.skips, []);
  // A reply in ABC-12's thread whose own subject names ABC-13 (its commit confirms it) is ABC-13's, not the thread's.
  r = await run('f3-b', 'ABC-13 PASS @2222bbb');
  assert.equal(commitOf(r, slot('ABC-13', SAM)), H('2'), 'MUTANT F3: the subject outranks the thread');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), undefined);
  // The link applies when the subject names no card (a bare verdict in the thread), or only the thread's card.
  r = await run('f3-c', 'Re: audit PASS @1111aaa');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1'), 'a reply naming no card takes the thread');
  r = await run('f3-d', 'Re: ABC-12 audit PASS @1111aaa');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), H('1'));
  // A subject naming the thread's card and another, with no @sha, is judged by git over both (the link alone never decides).
  r = await run('f3-e', 'ABC-12 thread: ABC-13 landed at 2222bbb');
  assert.equal(commitOf(r, slot('ABC-13', SAM)), H('2'), 'MUTANT F3: the link would have made this ABC-12');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), undefined);
  // A subject card no commit confirms, in another card's thread, is ambiguous: never the thread's card by fallback.
  r = await run('f3-f', 'ABC-13 PASS @4444ddd');
  assert.deepEqual(r.skips, [{ mail: 'f3-f', reason: 'ambiguous', cards: ['ABC-13'] }]);
  assert.equal(commitOf(r, slot('ABC-12', SAM)), undefined, 'MUTANT F3: no fallback to the thread');
});
