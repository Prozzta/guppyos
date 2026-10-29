'use strict';
/**
 * CLAIMS-90 round 10, Jim's gate on a84ce5e1 (f8c1d8; god 21df93 rules the SHOULD a must): seven general
 * rules in the done-mail indexer (doneMailFacts), each with its twins. Must 2: a reported range A..B reports
 * only its members; a commit subject's lower-case scope is a card's own form. Must 3: a quoted @sha loses
 * priority only when the subject also writes another sha; the fallback never takes another card's commit.
 * Must 4: a card-shaped id the board lacks still names a card (the thread link does not enter). Must 5: a
 * unique run of INNER segments names a card; a done mail the index lacks reaches the derived pass. Must 6:
 * an id written straight before its own @sha is the pairing, confirmed by the card's branch or taken as
 * written. Must 7: the spaced "@ sha" form and pairs listed in the body. Synthetic names and shas only; a
 * fake git port; HOME jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-r10b-'));
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
/** A git port over fixed maps: short -> full, full -> subject; parents/files/times/ancestors/ranges/refs optional. */
function fakeGit(commits, messages, extra = {}) {
  const anc = extra.ancestors ?? [];
  return {
    async commitOf(s) { return commits[s] ?? null; },
    async isAncestor(a, b) { return a === b || anc.some(([x, y]) => x === a && y === b); },
    async time(c) { return (extra.times && extra.times[c]) ?? 0; },
    async message(c) { return messages[c] ?? null; },
    ...(extra.parents ? { async parents(c) { return extra.parents[c] ?? []; } } : {}),
    ...(extra.files ? { async changedFiles(c) { return extra.files[c] ?? null; } } : {}),
    ...(extra.versions ? { async versionOnly(c) { return extra.versions[c] ?? null; } } : {}),
    ...(extra.ranges ? { async rangeCommits(a, b) { return extra.ranges[`${a}..${b}`] ?? null; } } : {}),
    ...(extra.refs ? { async refCommit(name) { return extra.refs[name] ?? null; } } : {}),
  };
}
const T0 = '2026-01-10T10:00:00.000Z';
const slot = (card, who) => `card.${card.toLowerCase()}.donesha#${who}`;
const commitOf = (r, s) => { const f = r.facts.find((x) => x.slot === s); return f ? f.refs.find((y) => y.type === 'commit').value : undefined; };
const mail = (id, subject, extra = {}) => ({ id, act: 'done', from: 'sam-aaaaaaaa', subject, body: '', created_at: T0, ...extra });
const SAM = 'sam-aaaaaaaa';

// ———————————————————————————————————————————————————————————— must 2 (F5)

test('must 2: a reported range A..B reports only a member of it (a cherry-pick source quoted in the body is never the value); a member whose subject scope is the card\'s unique own form names it; a shared scope stays unresolved', async () => {
  const CARDS = ['ABC-HULL-STRETCH-12', 'XYZ-34', 'DEF-5'];
  // Range A..B = [C, B]; B is a cherry-pick of P, which is on another branch (outside the range) and names no card.
  const A = H('a'), B = H('b'), C = H('c'), P = 'd1'.repeat(20);
  const git = fakeGit(
    { aaa1aaa: A, bbb1bbb: B, ccc1ccc: C, ddd1ddd: P, [P]: P },
    { [A]: 'base', [B]: `fix: a backport\n\n(cherry picked from commit ${P})`, [C]: 'test(abc-hull): stretch the hull', [P]: 'fix: a backport' },
    { files: { [A]: SRC, [B]: SRC, [C]: SRC, [P]: SRC }, times: { [A]: 1, [C]: 2, [B]: 3, [P]: 4 },
      ancestors: [[A, C], [C, B], [A, B]], ranges: { [`${A}..${B}`]: [C, B] } },
  );
  const run = (id, subject, extra) => F.doneMailFacts([mail(id, subject, extra)], CARDS, git);
  // Twin (a): the field row, the body quoting the cherry-pick source: the value is C, a member; never P.
  let r = await run('m2-a', 'Pin delta aaa1aaa..bbb1bbb: PASS', { card: 'ABC-HULL-STRETCH-12', body: `B is a backport (cherry picked from commit ${P})` });
  assert.equal(commitOf(r, slot('ABC-HULL-STRETCH-12', SAM)), C, 'MUTANT must 2: a commit outside the range was reported');
  assert.match(r.facts[0].text, /a commit in the range aaa1aaa\.\.bbb1bbb/);
  assert.deepEqual(r.skips, []);
  // The same with no card field: the scope names the card in the subject-less way too (the member confirms it).
  r = await run('m2-b', 'ABC-HULL-STRETCH-12 pin delta aaa1aaa..bbb1bbb: PASS', { body: `(cherry picked from commit ${P})` });
  assert.equal(commitOf(r, slot('ABC-HULL-STRETCH-12', SAM)), C, 'MUTANT must 2b: the lower-case scope names the card');
  // A subject @sha outside the range is still the mail's sha (the subject reports it).
  r = await run('m2-c', 'ABC-HULL-STRETCH-12 pin delta aaa1aaa..bbb1bbb, then @ddd1ddd: PASS', { card: 'ABC-HULL-STRETCH-12' });
  assert.equal(commitOf(r, slot('ABC-HULL-STRETCH-12', SAM)), P, 'a subject @sha keeps its priority');
  // Twin (b): the scope shared by two cards stays unresolved: C names some other card, so the range gives nothing.
  const shared = await F.doneMailFacts([mail('m2-d', 'ABC-HULL-STRETCH-12 pin delta aaa1aaa..bbb1bbb: PASS', { body: `(cherry picked from commit ${P})` })], ['ABC-HULL-STRETCH-12', 'ABC-HULL-SPRINT-13', 'XYZ-34'], git);
  assert.equal(commitOf(shared, slot('ABC-HULL-STRETCH-12', SAM)), undefined, 'MUTANT must 2b: a shared scope names no card');
  assert.deepEqual(shared.skips.map((s) => s.reason), ['ambiguous'], 'the member names some other card: unresolved');
  // The recogniser: the scope is read upper-case as a form; a one-word scope, or a lower-case word elsewhere, is not a card.
  const namer = F.cardNamer(['ABC-HULL-STRETCH-12', 'ABC-HULL-SPRINT-13', 'XYZ-34']);
  assert.deepEqual(namer('test(abc-hull): stretch'), { cards: [], others: ['ABC-HULL'] }, 'twin: a scope shared by two cards is some other card');
  assert.deepEqual(F.cardNamer(['ABC-HULL-STRETCH-12', 'XYZ-34'])('test(abc-hull): stretch'), { cards: ['ABC-HULL-STRETCH-12'], others: [] }, 'MUTANT must 2b: a unique scope names the card');
  assert.deepEqual(F.cardNamer(['ABC-HULL-STRETCH-12'])('fix(abc-hull-stretch-12)!: the hull'), { cards: ['ABC-HULL-STRETCH-12'], others: [] }, 'the whole id as a scope');
  assert.deepEqual(F.cardNamer(['ABC-HULL-STRETCH-12'])('fix(hull): abc-hull again'), { cards: [], others: [] }, 'a one-word scope and a lower-case word elsewhere name nothing');
  assert.deepEqual(F.cardNamer(['ABC-HULL-STRETCH-12'])('fix(re-check): wording'), { cards: [], others: [] }, 'a scope that is no card\'s form names nothing');
});

// ———————————————————————————————————————————————————————————— must 3 (F4)

test('must 3: a quoted @sha loses its priority only when the subject also writes another sha; the fallback never takes a commit whose subject names a different card', async () => {
  const CARDS = ['ABC-12', 'XYZ-34'];
  // S (ABC-12) -> T (ABC-12, newer); X (XYZ-34, newest, another line); N (names no card, newest of all).
  const S = H('1'), T = H('3'), X = H('2'), N = H('4');
  const git = fakeGit(
    { '1111aaa': S, '3333ccc': T, '2222bbb': X, '4444ddd': N },
    { [S]: 'ABC-12: the widget', [T]: 'ABC-12: the widget, covered', [X]: 'XYZ-34: the gadget', [N]: 'housekeeping' },
    { files: { [S]: SRC, [T]: SRC, [X]: SRC, [N]: SRC }, times: { [S]: 1, [T]: 2, [X]: 3, [N]: 4 }, ancestors: [[S, T]] },
  );
  const REQ = 'req-1';
  const ctx = { subjectOf: (id) => (id === REQ ? 'ABC-12 re-check @1111aaa' : undefined) };
  const run = (id, subject, extra) => F.doneMailFacts([mail(id, subject, { cards: ['ABC-12'], in_reply_to: REQ, ...extra })], CARDS, git, ctx);
  // Twin: the plain audit reply keeps @S, whatever the body lists (another card's newer commit; a no-card one).
  let r = await run('m3-a', 'ABC-12 re-check @1111aaa: PASS-WITH-CHANGES', { body: 'compare 2222bbb and 4444ddd' });
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'MUTANT must 3: the quoted @sha alone keeps its priority');
  assert.deepEqual(r.skips, []);
  // Twin: the covered-by reply writes a second sha, so the quoted one yields: T, the newer commit of the card's line.
  r = await run('m3-b', 'Re: ABC-12 @1111aaa: covered by the 3333ccc verdict');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), T, 'MUTANT must 3: the subject writes another sha, so the quoted one is not reported');
  // Twin: a body commit of another card is never picked: the fallback takes the latest among the card's own and no-card commits.
  r = await run('m3-c', 'Re: ABC-12 @1111aaa: covered by the 3333ccc verdict', { body: 'see also 2222bbb' });
  assert.equal(commitOf(r, slot('ABC-12', SAM)), T, 'MUTANT must 3: the fallback took another card\'s commit');
  r = await run('m3-d', 'ABC-12 done, see 1111aaa', { in_reply_to: undefined, body: 'then 2222bbb landed too' });
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'no quoting at all: the other card\'s newer commit is still never the value');
  r = await run('m3-e', 'done, see 1111aaa', { in_reply_to: undefined, cards: undefined, card: 'ABC-12', body: 'then 2222bbb landed too' });
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'a field row too');
  // A no-card commit still counts in the fallback (unchanged): the latest of S and N is N.
  r = await run('m3-f', 'Re: ABC-12 @1111aaa: covered by the 4444ddd verdict');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), N);
  // Only another card's commits in the fallback: the row stays ambiguous (never that commit).
  r = await run('m3-g', 'Re: ABC-12 @1111aaa: covered by 2222bbb');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'the quoted sha is still a commit the mail names: the fallback takes it over the other card\'s');
  r = await run('m3-h', 'Re: ABC-12: covered by 2222bbb');
  assert.deepEqual(r.skips, [{ mail: 'm3-h', reason: 'ambiguous', cards: ['ABC-12', 'XYZ-34'] }]);
});

// ———————————————————————————————————————————————————————————— must 4 (F3)

test('must 4: a subject writing a card-shaped id the board lacks names that card, so the thread link does not enter; no id lets the link in; a known id is that card', async () => {
  const CARDS = ['ABC-12', 'XYZ-34'];
  const S = H('1'), X = H('2');
  const git = fakeGit({ '1111aaa': S, '2222bbb': X }, { [S]: 'fix: the widget', [X]: 'XYZ-34: the gadget' }, { files: { [S]: SRC, [X]: SRC }, times: { [S]: 1, [X]: 2 } });
  const run = (id, subject, extra) => F.doneMailFacts([mail(id, subject, { cards: ['ABC-12'], in_reply_to: 'req-1', ...extra })], CARDS, git);
  // Twin: an unknown card-shaped id in a reply plus a link: no row for the linked card, the mail has no card.
  let r = await run('m4-a', 'PASS: NEW-THING-99 @1111aaa (clean)');
  assert.equal(r.facts.length, 0, 'MUTANT must 4: the thread link entered over an unknown id');
  assert.deepEqual(r.skips, [{ mail: 'm4-a', reason: 'noCard', cards: ['NEW-THING-99'] }]);
  // Twin: the same reply with no id: the link enters, as before.
  r = await run('m4-b', 'PASS @1111aaa (clean)');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'no id: the link is the card');
  // Twin: a known id: that card (F3), never the linked one.
  r = await run('m4-c', 'PASS: XYZ-34 @2222bbb (clean)');
  assert.equal(commitOf(r, slot('XYZ-34', SAM)), X);
  assert.equal(commitOf(r, slot('ABC-12', SAM)), undefined);
  // A card field outranks the subject's unknown id (round 9); a bare role word or a version is no id.
  r = await run('m4-d', 'PASS: NEW-THING-99 @1111aaa (clean)', { card: 'ABC-12' });
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'the field row is unchanged');
  r = await run('m4-e', 'PASS-INT @1111aaa for v1.1.102 (clean)');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'a role word without a number is no card');
  // A form shared by two board cards is not an unknown id: the linked card owns it (round 9 R2 stands).
  r = await F.doneMailFacts([mail('m4-f', 'Re: WIDGET-7 @1111aaa: PASS', { cards: ['ALPHA-WIDGET-7'], in_reply_to: 'req-1' })], ['ALPHA-WIDGET-7', 'BETA-WIDGET-7'], git);
  assert.equal(commitOf(r, slot('ALPHA-WIDGET-7', SAM)), S, 'a shared form is the linked card\'s, not a stranger');
});

// ———————————————————————————————————————————————————————————— must 5a (F1)

test('must 5a: a run of INNER segments unique among board ids names that card; a shared run stays unresolved; two unique forms go the F2 way; a run broken by a foreign word is no form', async () => {
  const CARDS = ['PRE-WRAP-GAP-12', 'PRE-LIMIT-RE-12', 'Z-1'];
  const S = H('1'), W = H('2'), L = H('3');
  const git = fakeGit(
    { '1111aaa': S, '2222bbb': W, '3333ccc': L },
    { [S]: 'PRE-WRAP-GAP-12 + PRE-LIMIT-RE-12: rebase both', [W]: 'PRE-WRAP-GAP-12: the gap', [L]: 'PRE-LIMIT-RE-12: the limit' },
    { files: { [S]: SRC, [W]: SRC, [L]: SRC }, times: { [S]: 1, [W]: 2, [L]: 3 } },
  );
  // Every mail is a reply in card Z-1's thread with no card field: the inner forms must outrank the link.
  const run = (id, subject, cards = CARDS) => F.doneMailFacts([mail(id, subject, { cards: ['Z-1'], in_reply_to: 'req-1' })], cards, git);
  // Twin: a unique inner run names the card (never Z-1).
  let r = await run('m5-a', 'LIMIT-RE rebase: PASS @3333ccc');
  assert.equal(commitOf(r, slot('PRE-LIMIT-RE-12', SAM)), L, 'MUTANT must 5a: the inner run names the card');
  assert.equal(commitOf(r, slot('Z-1', SAM)), undefined, 'MUTANT must 5a: the thread link filed it under Z');
  assert.deepEqual(r.skips, []);
  // Twin: two unique inner runs over one @sha whose commit names both: a row on each (the F2 way), never Z-1.
  r = await run('m5-b', 'WRAP-GAP + LIMIT-RE rebase: final PASS @1111aaa');
  assert.deepEqual(r.facts.map((f) => f.slot).sort(), [slot('PRE-LIMIT-RE-12', SAM), slot('PRE-WRAP-GAP-12', SAM)], 'MUTANT must 5a: both cards get their row');
  assert.ok(r.facts.every((f) => f.value === S));
  assert.deepEqual(r.skips, []);
  // Twin: a run shared by two ids stays unresolved (no row for either), while the unique one still gets its row.
  r = await run('m5-c', 'WRAP-GAP + LIMIT-RE rebase: final PASS @1111aaa', ['PRE-WRAP-GAP-12', 'OLD-WRAP-GAP-13', 'PRE-LIMIT-RE-12', 'Z-1']);
  assert.deepEqual(r.facts.map((f) => f.slot), [slot('PRE-LIMIT-RE-12', SAM)], 'a shared run names no card');
  // Twin: the card form plus an unrelated word in one token is no form (the recogniser says "some other card").
  r = await run('m5-d', 'LIMIT-RE-REBASE done @3333ccc');
  assert.deepEqual(r.facts, []);
  assert.deepEqual(r.skips, [{ mail: 'm5-d', reason: 'ambiguous', cards: ['Z-1', 'PRE-LIMIT-RE-12'] }], 'the broken run is another card; the commit names the real one');
  // The form rule itself.
  assert.equal(F.isOwnForm('WRAP-GAP', 'PRE-WRAP-GAP-12'), true, 'MUTANT must 5a: an inner run');
  assert.equal(F.isOwnForm('LIMIT-RE', 'PRE-LIMIT-RE-12'), true);
  assert.equal(F.isOwnForm('LIMIT-RE-REBASE', 'PRE-LIMIT-RE-12'), false, 'a run broken by a foreign segment');
  assert.equal(F.isOwnForm('GAP-12', 'PRE-WRAP-GAP-12'), true, 'a suffix run still counts');
  assert.equal(F.isOwnForm('RE-12', 'PRE-LIMIT-RE-12'), true);
  assert.equal(F.isOwnForm('12-RE', 'PRE-LIMIT-RE-12'), false, 'segments out of order');
  const namer = F.cardNamer(CARDS);
  assert.deepEqual(namer('WRAP-GAP + LIMIT-RE rebase'), { cards: ['PRE-WRAP-GAP-12', 'PRE-LIMIT-RE-12'], others: [] });
  assert.deepEqual(F.cardNamer(['PRE-WRAP-GAP-12', 'OLD-WRAP-GAP-13'])('WRAP-GAP rebase'), { cards: [], others: ['WRAP-GAP'] }, 'MUTANT must 5a: a shared inner run is some other card');
});
