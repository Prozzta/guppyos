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

// ———————————————————————————————————————————————————————————— must 6 (F2)

test('must 6: an id (or its leading form) written straight before its own @sha is the pairing, with no confirmation from the commit subject; the card\'s branch confirms it, another card\'s branch alone contradicts it', async () => {
  const CARDS = ['ABC-CRAWL-19', 'INT-1.2', 'XYZ-34'];
  const S1 = H('1'), X = H('2');
  // S1 names no card ("fix: capacity sweep"); S2 (2222bbb) is not in the repository.
  const mk = (refs) => fakeGit({ '1111aaa': S1, '3333ccc': X }, { [S1]: 'fix: capacity sweep over the hull', [X]: 'XYZ-34: the gadget' }, { files: { [S1]: SRC, [X]: SRC }, times: { [S1]: 1, [X]: 2 }, ...(refs ? { refs } : {}) });
  const SUBJ = 'ABC @1111aaa merged into INT-1.2 with fixup 4; pushed @2222bbb';
  const run = (id, git, extra = {}) => F.doneMailFacts([mail(id, SUBJ, { cards: ['INT-1.2'], in_reply_to: 'req-1', ...extra })], CARDS, git);
  // Twin: the paired form with an unnamed commit on the card's branch: a fact for the card (never the thread's INT card).
  let r = await run('m6-a', mk({ 'guppy/abc-crawl-19': S1 }));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), S1, 'MUTANT must 6: the pair ABC @S1 is the card\'s sha');
  assert.equal(commitOf(r, slot('INT-1.2', SAM)), undefined, 'the thread\'s int card gets no row');
  // Twin: the same with the commit on another card's branch and not on the card's own: skipped.
  r = await run('m6-b', mk({ 'guppy/xyz-34': S1, 'guppy/abc-crawl-19': X }));
  assert.equal(r.facts.length, 0, 'MUTANT must 6: a commit on another card\'s branch is not the pair');
  assert.deepEqual(r.skips, [{ mail: 'm6-b', reason: 'ambiguous', cards: ['ABC-CRAWL-19'] }]);
  // Accepted as written: no branch of the card known (and no other card's branch reaches it), or an older port without refCommit.
  r = await run('m6-c', mk({ 'guppy/xyz-34': X }));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), S1, 'no branch ref: as written');
  r = await run('m6-d', mk(null));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), S1, 'a port without refCommit: as written');
  // The card's own branch reaching the commit outranks another card's branch that reaches it too.
  r = await run('m6-e', mk({ 'guppy/abc-crawl-19': S1, 'guppy/xyz-34': S1 }));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), S1);
  // A field row is unchanged by the branch check; a single-card row picks the paired sha of two by the name.
  r = await run('m6-f', mk({ 'guppy/xyz-34': S1 }), { card: 'ABC-CRAWL-19', cards: [] });
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), S1, 'the field row keeps its subject sha');
  r = await F.doneMailFacts([mail('m6-g', 'ABC @1111aaa merged with fixup 4; pushed @2222bbb', { cards: ['ABC-CRAWL-19'], in_reply_to: 'req-1' })], CARDS, mk(null));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), S1, 'of two @shas the one after the card\'s own form');
  // A leading form shared by two board cards pairs with neither: ambiguous, never a guess.
  r = await F.doneMailFacts([mail('m6-h', SUBJ, { cards: ['INT-1.2'], in_reply_to: 'req-1' })], [...CARDS, 'ABC-SWEEP-20'], mk({ 'guppy/abc-crawl-19': S1 }));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), undefined, 'a shared leading form pairs with no card');
  assert.equal(commitOf(r, slot('ABC-SWEEP-20', SAM)), undefined);
  // The form pins.
  assert.equal(F.isPairForm('ABC', 'ABC-CRAWL-19'), true);
  assert.equal(F.isPairForm('ABC-CRAWL', 'ABC-CRAWL-19'), true);
  assert.equal(F.isPairForm('CRAWL', 'ABC-CRAWL-19'), false, 'a lone inner word is no form');
  assert.equal(F.isPairForm('19', 'ABC-CRAWL-19'), false, 'a number is no form');
  assert.equal(F.isPairForm('INT', 'INT-1.2'), false, 'a line word alone names the line, not the int card');
  assert.equal(F.isPairForm('INT-1.2', 'INT-1.2'), true);
  assert.equal(F.pairName('abc', 'ABC-CRAWL-19', CARDS), true);
  assert.equal(F.pairName('guppy/abc-crawl-19', 'ABC-CRAWL-19', CARDS), true);
  assert.equal(F.pairName('abc', 'ABC-CRAWL-19', [...CARDS, 'ABC-SWEEP-20']), false, 'shared: no card\'s');
  assert.equal(F.pairName('pushed', 'ABC-CRAWL-19', CARDS), false);
  const namer = F.cardNamer(CARDS);
  assert.deepEqual(namer('ABC @1111aaa merged'), { cards: ['ABC-CRAWL-19'], others: [] }, 'MUTANT must 6: the word before an @sha is a pair form');
  assert.deepEqual(namer('ABC merged @1111aaa'), { cards: [], others: [] }, 'elsewhere a bare word is no card');
  assert.deepEqual(F.cardNamer([...CARDS, 'ABC-SWEEP-20'])('ABC @1111aaa'), { cards: [], others: ['ABC'] }, 'shared: some other card');
  assert.deepEqual(F.pairedAtShas(SUBJ, ['ABC-CRAWL-19'], namer, CARDS).get('ABC-CRAWL-19'), ['1111aaa']);
  assert.equal(await F.subjectTip([{ sha: '1111aaa', name: 'abc' }, { sha: '2222bbb', name: 'pushed' }], 'ABC-CRAWL-19', mk(null), CARDS), '1111aaa');
  assert.equal(F.loneAtCounts('ABC @1111aaa; XYZ-34 FAIL', { sha: '1111aaa', name: 'abc' }, 'ABC-CRAWL-19', namer, CARDS), true);
});

test('must 6 git: DerivedGit.refCommit gives a branch\'s sha, origin\'s copy first, and null for no such ref', async () => {
  const { execFileSync } = require('node:child_process');
  const G = loadTs('src/main/claims/derivedGit.ts');
  const repo = path.join(JAIL, 'repo-m6');
  fs.mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  g('init', '-q', '-b', 'main');
  const shas = [];
  for (const n of ['one', 'two']) { fs.writeFileSync(path.join(repo, 'f.txt'), n); g('add', 'f.txt'); g('commit', '-q', '-m', n); shas.push(g('rev-parse', 'HEAD')); }
  g('branch', 'guppy/abc-12', shas[0]);
  g('update-ref', 'refs/remotes/origin/guppy/xyz-34', shas[1]);
  g('update-ref', 'refs/remotes/origin/guppy/abc-12', shas[1]);
  const dg = new G.DerivedGit(repo);
  assert.equal(await dg.refCommit('guppy/abc-12'), shas[1], 'origin first');
  assert.equal(await dg.refCommit('guppy/xyz-34'), shas[1]);
  assert.equal(await dg.refCommit('guppy/none-1'), null);
  assert.equal(await dg.isAncestor(shas[0], await dg.refCommit('guppy/abc-12')), true);
});

// ———————————————————————————————————————————————————————————— must 7 (F2, the SHOULD god ruled in)

test('must 7: "@ sha" with a space is an @sha; the per-card "merge guppy/<branch> @<sha>" lines of an int-merge report in the BODY pair each card with its sha, held to the card\'s branch', async () => {
  const CARDS = ['ABC-CRAWL-19', 'DEF-SWEEP-20', 'INT-1.2', 'XYZ-34'];
  const A = H('1'), D = H('2'), S = H('3');
  const mk = (refs) => fakeGit({ '1111aaa': A, '2222bbb': D, '3333ccc': S }, { [A]: 'fix: capacity sweep over the hull', [D]: 'DEF-SWEEP-20: the follow-up', [S]: 'int-1.2 stage 4: both merged' },
    { files: { [A]: SRC, [D]: SRC, [S]: SRC }, times: { [A]: 1, [D]: 2, [S]: 3 }, ...(refs ? { refs } : {}) });
  const SUBJ = 'int-1.2 @ 3333ccc: ABC-CRAWL-19 merged (Jim PASS) and DEF-SWEEP-20 follow-up merged';
  const BODY = 'Both on origin now.\nmerge guppy/abc-crawl-19 @1111aaa\nmerge guppy/def-sweep-20 @2222bbb\n';
  const run = (id, git, extra = {}) => F.doneMailFacts([mail(id, SUBJ, { body: BODY, cards: ['INT-1.2'], in_reply_to: 'req-1', ...extra })], CARDS, git);
  // Twin: pairs listed in the body: each card gets the sha its body line pairs with it (DEF is no longer ambiguous).
  let r = await run('m7-a', mk({ 'guppy/abc-crawl-19': A, 'guppy/def-sweep-20': D }));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), A, 'MUTANT must 7: the body pair is the card\'s sha');
  assert.equal(commitOf(r, slot('DEF-SWEEP-20', SAM)), D, 'MUTANT must 7: the second body pair');
  assert.match(r.facts.find((f) => f.slot === slot('ABC-CRAWL-19', SAM)).text, /body pairs with the card/);
  assert.equal(r.skips.some((s) => s.cards && (s.cards.includes('ABC-CRAWL-19') || s.cards.includes('DEF-SWEEP-20'))), false);
  // Twin: a body pair confirmed by branch reachability: on the card's branch, a fact; on another card's branch alone, skipped.
  r = await run('m7-b', mk({ 'guppy/abc-crawl-19': A, 'guppy/xyz-34': D }));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), A);
  assert.equal(commitOf(r, slot('DEF-SWEEP-20', SAM)), D, 'a commit whose subject names the card needs no branch');
  r = await run('m7-c', mk({ 'guppy/xyz-34': A, 'guppy/def-sweep-20': D }));
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), undefined, 'MUTANT must 7: an unnamed commit on another card\'s branch alone is not the pair');
  assert.ok(r.skips.some((s) => s.mail === 'm7-c' && s.reason === 'ambiguous' && s.cards[0] === 'ABC-CRAWL-19'));
  assert.equal(commitOf(r, slot('DEF-SWEEP-20', SAM)), D);
  // Twin: the spaced "@ S" form on its own: the subject @sha of a single card.
  r = await F.doneMailFacts([mail('m7-d', 'DEF-SWEEP-20 landed @ 2222bbb (Jim PASS)', { cards: ['INT-1.2'], in_reply_to: 'req-1' })], CARDS, mk(null));
  assert.equal(commitOf(r, slot('DEF-SWEEP-20', SAM)), D, 'MUTANT must 7: "@ sha" is an @sha');
  assert.match(r.facts.find((f) => f.slot === slot('DEF-SWEEP-20', SAM)).text, /subject's @sha/);
  assert.equal(commitOf(r, slot('INT-1.2', SAM)), undefined);
  // A quoted body line (a reply quoting the request) is not a pair; a body line naming no card's form is none.
  r = await F.doneMailFacts([mail('m7-e', 'int-1.2 @ 3333ccc: DEF-SWEEP-20 follow-up merged', { body: '> merge guppy/abc-crawl-19 @1111aaa\nmerge guppy/def-sweep-20 @2222bbb\nsee also @1111aaa', cards: ['INT-1.2'], in_reply_to: 'req-1' })], CARDS, mk({ 'guppy/abc-crawl-19': A, 'guppy/def-sweep-20': D }));
  assert.equal(commitOf(r, slot('DEF-SWEEP-20', SAM)), D);
  assert.equal(commitOf(r, slot('ABC-CRAWL-19', SAM)), undefined, 'a quoted line pairs nothing');
  // The pins.
  assert.deepEqual(F.subjectAtShas('int-1.2 @ 3333ccc: X'), [{ sha: '3333ccc', name: 'int-1.2' }]);
  assert.deepEqual(F.shaMentions('int-1.2 @ 3333ccc').map((x) => x.sha), ['3333ccc']);
  assert.deepEqual([...F.pairedAtShas(SUBJ, ['ABC-CRAWL-19', 'DEF-SWEEP-20'], F.cardNamer(CARDS), CARDS, [{ sha: '1111aaa', name: 'guppy/abc-crawl-19' }, { sha: '2222bbb', name: 'guppy/def-sweep-20' }])],
    [['ABC-CRAWL-19', ['1111aaa']], ['DEF-SWEEP-20', ['2222bbb']]], 'MUTANT must 7: body pairs, and the subject\'s int sha goes to neither');
  assert.equal(F.loneAtCounts('ABC-CRAWL-19 landed @ 1111aaa; XYZ-34 FAIL', { sha: '1111aaa', name: 'landed' }, 'ABC-CRAWL-19', F.cardNamer(CARDS), CARDS), true, 'the spaced @sha sits in the card\'s segment');
});

// ———————————————————————————————————————————————————————————— re-gate (Jim 42dc40)

test('re-gate must B: a stranger counts as a card only with a 2+ letter word and a final number that ends no letter+digit range; item-range labels let the thread link in', async () => {
  for (const t of ['NEW-THING-99', 'CUT-1.1.80', 'ABC-12', 'C90-GET-2']) assert.equal(F.strangerNamesCard(t), true, t);
  for (const t of ['X1-X3', 'D1-D8', 'F1-F4', 'S1-S3', 'R6-R11', 'J1-J10', 'PLAN-V4', 'PHASE-D1-8', 'M-5', 'X-9']) assert.equal(F.strangerNamesCard(t), false, t);
  const CARDS = ['ABC-12', 'XYZ-34'];
  const S = H('1');
  const git = fakeGit({ '1111aaa': S }, { [S]: 'fix: the widget' }, { files: { [S]: SRC }, times: { [S]: 1 } });
  const run = (id, subject) => F.doneMailFacts([mail(id, subject, { cards: ['ABC-12'], in_reply_to: 'req-1' })], CARDS, git);
  let r = await run('mb-a', 'fixed X1-X3 @1111aaa');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'MUTANT must B: an item range blocked the link');
  r = await run('mb-b', 'PLAN-V4 merged @1111aaa');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S, 'a version label is no card');
  r = await run('mb-c', 'D1-D8, F1-F4, R6-R11 and J1-J10 done @1111aaa');
  assert.equal(commitOf(r, slot('ABC-12', SAM)), S);
  r = await run('mb-d', 'NEW-THING-99 @1111aaa');
  assert.equal(r.facts.length, 0, 'a card-shaped stranger still blocks the link');
  assert.deepEqual(r.skips, [{ mail: 'mb-d', reason: 'noCard', cards: ['NEW-THING-99'] }]);
  r = await run('mb-e', 'CUT-1.1.80 tagged @1111aaa');
  assert.equal(r.facts.length, 0, 'a dotted version end counts');
});

const gitIn = (repo) => {
  const { execFileSync } = require('node:child_process');
  return (args, input) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
};

test('re-gate must A git: DerivedGit.branchesContaining names the guppy branches whose preferred tip (origin first) reaches a commit; null when git cannot say', async () => {
  const G = loadTs('src/main/claims/derivedGit.ts');
  const repo = path.join(JAIL, 'repo-ma1');
  fs.mkdirSync(repo, { recursive: true });
  const g = gitIn(repo);
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'one'); g(['add', 'f.txt']); g(['commit', '-q', '-m', 'one']);
  const one = g(['rev-parse', 'HEAD']);
  const tree = g(['rev-parse', 'HEAD^{tree}']);
  const two = g(['commit-tree', tree, '-p', one, '-m', 'two']);
  const three = g(['commit-tree', tree, '-p', one, '-m', 'three']);
  g(['update-ref', 'refs/remotes/origin/guppy/abc-12', two]);
  g(['update-ref', 'refs/heads/guppy/abc-12', three]);
  g(['update-ref', 'refs/heads/guppy/loc-5', three]);
  g(['update-ref', 'refs/heads/other/zz-1', three]);
  g(['update-ref', 'refs/heads/release-1.2', two]);
  const dg = new G.DerivedGit(repo);
  assert.deepEqual([...await dg.branchesContaining(one)].sort(), ['guppy/abc-12', 'guppy/loc-5', 'main', 'release-1.2'], 'must C: a line holding it is named by its plain name');
  assert.deepEqual([...await dg.branchesContaining(three)], ['guppy/loc-5'], 'a local copy behind origin\'s is not the branch; non-guppy refs never count');
  assert.deepEqual([...await dg.branchesContaining(two)].sort(), ['guppy/abc-12', 'release-1.2']);
  assert.equal(await dg.branchesContaining('f'.repeat(40)), null, 'a missing commit: git cannot say');
});

test('re-gate must A: the pairing check asks git once per distinct sha (110 card branches, 60 paired done mails): no merge-base per board card', async () => {
  const G = loadTs('src/main/claims/derivedGit.ts');
  const repo = path.join(JAIL, 'repo-ma2');
  fs.mkdirSync(repo, { recursive: true });
  const g = gitIn(repo);
  g(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'f.txt'), 'base'); g(['add', 'f.txt']); g(['commit', '-q', '-m', 'base']);
  const base = g(['rev-parse', 'HEAD']);
  const N = 110;
  // One fast-import: card i's commit changes a source file (a commit changing nothing confirms nothing) and is
  // the tip of origin's guppy/hull-i alone.
  const data = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  let stream = '';
  for (let i = 1; i <= N; i++) stream += `commit refs/remotes/origin/guppy/hull-${i}\ncommitter t <t@t> ${1700000000 + i} +0000\n${data(`fix: sweep ${i}`)}from ${base}\nM 100644 inline src/main/w.ts\n${data(`v${i}`)}\n`;
  g(['fast-import', '--quiet'], stream);
  const tips = new Map(g(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/guppy']).split('\n').map((l) => l.split(' ')));
  const c = [null];
  for (let i = 1; i <= N; i++) c.push(tips.get(`refs/remotes/origin/guppy/hull-${i}`));
  const CARDS = [...Array.from({ length: N }, (_, k) => `HULL-${k + 1}`), 'INT-1.2'];
  // 55 mails pair a card with its own commit; 5 pair a card with another card's commit (on that branch alone).
  const mails = [];
  for (let i = 1; i <= 55; i++) mails.push(mail(`ma-${i}`, `HULL-${i} @${c[i].slice(0, 12)} merged into INT-1.2`, { cards: ['INT-1.2'], in_reply_to: 'req-1' }));
  for (let i = 56; i <= 60; i++) mails.push(mail(`ma-${i}`, `HULL-${i} @${c[i + 50].slice(0, 12)} merged into INT-1.2`, { cards: ['INT-1.2'], in_reply_to: 'req-1' }));
  // 10 more mails report shas already reported (a re-send, a copy to god): the answer per sha is cached.
  for (let i = 1; i <= 10; i++) mails.push(mail(`ma-again-${i}`, `HULL-${i} @${c[i].slice(0, 12)} merged into INT-1.2 (again)`, { cards: ['INT-1.2'], in_reply_to: 'req-1' }));
  const LOG = path.join(JAIL, 'ma2-git-calls.log');
  const wrap = path.join(JAIL, 'ma2-git-wrap.cjs');
  fs.writeFileSync(wrap, [
    "const { spawnSync } = require('node:child_process');",
    `require('node:fs').appendFileSync(${JSON.stringify(LOG)}, process.argv.slice(2).join(' ') + '\\n');`,
    "const args = process.argv.slice(2);",
    // Only cat-file --batch-check reads stdin (prefetch); the other calls leave it open, so it is read only then.
    "const input = args.includes('cat-file') ? require('node:fs').readFileSync(0) : undefined;",
    "const r = spawnSync('git', args, { input, stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] });",
    'process.exit(r.status === null ? 1 : r.status);',
  ].join('\n'));
  const dg = new G.DerivedGit(repo, { command: [process.execPath, wrap] });
  // As the full pass does (derivedWriter): prefetch the written shas and read the log first.
  await dg.prefetch(mails.map((m) => /@([0-9a-f]{12})/.exec(m.subject)[1]));
  await dg.log();
  fs.writeFileSync(LOG, '');
  const r = await F.doneMailFacts(mails, CARDS, dg);
  for (let i = 1; i <= 55; i++) assert.equal(commitOf(r, slot(`HULL-${i}`, SAM)), c[i], `HULL-${i}: ${JSON.stringify(r.skips.filter((s) => s.mail === `ma-${i}`))} ${r.facts.length} facts`);
  for (let i = 56; i <= 60; i++) assert.ok(r.skips.some((s) => s.mail === `ma-${i}` && s.reason === 'ambiguous'), `ma-${i}: another card's commit is not the pair`);
  const calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const distinct = 60;
  const contains = calls.filter((l) => l.includes('--contains')).length;
  const mergeBase = calls.filter((l) => l.includes('merge-base')).length;
  assert.ok(contains <= distinct, `one containment call per distinct sha at most (${contains})`);
  assert.ok(mergeBase <= distinct, `MUTANT must A: a merge-base per board card branch (${mergeBase})`);
  assert.ok(calls.length <= 4 * distinct + 10, `git calls stay a small constant per distinct sha (${calls.length})`);
});

// ———————————————————————————————————————————————————————————— re-gate musts C-E (Jim 852664, 439873)

/** A MIRROR-shaped repo (Jim 439873: the jail is a mirror clone, refs/heads only, no remotes) with helpers. */
const { execFileSync } = require('node:child_process');
let tick = 1700000000;
function mirrorRepo(name) {
  const repo = path.join(JAIL, name);
  fs.mkdirSync(repo, { recursive: true });
  let n = 0;
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: `${tick} +0000`, GIT_COMMITTER_DATE: `${tick++} +0000` }, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
  const commit = (msg, file = `src/main/f${n++}.ts`) => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), `${msg} ${tick}`); g('add', file); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  const on = (b, from) => g('switch', '-q', '-C', b, from);
  const merge = (b, msg) => { g('merge', '-q', '--no-ff', '-m', msg, b); return g('rev-parse', 'HEAD'); };
  /** Three card branches cut from `from` after its merges, each with its own commit. */
  const later = (from) => { for (const b of ['later-a-1', 'later-b-2', 'later-c-3']) { on(`guppy/${b}`, from); commit(`${b.toUpperCase()}: work`); } };
  g('init', '-q', '-b', 'main'); commit('base', 'f.txt');
  return { repo, g, commit, on, merge, later };
}
const LATER = ['LATER-A-1', 'LATER-B-2', 'LATER-C-3'];
const s8 = (x) => x.slice(0, 8);
const runReal = async (G, r, cards, ml, parent) => F.doneMailFacts([ml], cards, new G.DerivedGit(r.repo), { subjectOf: (id) => (parent && id === parent.id ? parent.subject : undefined) });

test('re-gate must C: a commit a line holds is merged work, none of the later card branches\' own: the pairing stays fact; on another card\'s unmerged branch alone it is still ambiguous; Jim\'s C1/C2 rows stay fact', async () => {
  const G = loadTs('src/main/claims/derivedGit.ts');
  // The rule: WIDGET-TAB-7 @c, c a plain commit on a work branch merged into int-9.9.9; the card's own branch
  // exists but lacks c; three card branches cut after the merge reach c.
  let r = mirrorRepo('mc-rule');
  r.on('guppy/work-w', 'main'); const c = r.commit('fix: harden the widget');
  r.on('guppy/other-wing-5', 'main'); const o = r.commit('fix: the wing');
  r.on('guppy/int-9.9.9', 'main'); r.merge('guppy/work-w', 'merge guppy/work-w into guppy/int-9.9.9');
  r.later('guppy/int-9.9.9');
  r.on('guppy/widget-tab-7', 'main'); r.commit('WIDGET-TAB-7: re-cut');
  r.g('switch', '-q', 'main');
  const CARDS = ['WIDGET-TAB-7', 'OTHER-WING-5', 'INT-9.9.9', ...LATER];
  let res = await runReal(G, r, CARDS, mail('mc-a', `WIDGET-TAB-7 @${s8(c)}: done`));
  assert.equal(commitOf(res, slot('WIDGET-TAB-7', SAM)), c, 'MUTANT must C: a card branch cut after the merge claimed the merged commit');
  // The hold still stands where it should: a plain commit only on another card's (unmerged) branch.
  res = await runReal(G, r, CARDS, mail('mc-b', `WIDGET-TAB-7 @${s8(o)}: done`));
  assert.deepEqual(res.skips, [{ mail: 'mc-b', reason: 'ambiguous', cards: ['WIDGET-TAB-7'] }], 'must 6 kept: another card\'s own commit contradicts the pair');

  // C1 (field row; the own branch exists but lacks c; body: another card's int stage merge, its commits, a plain one).
  r = mirrorRepo('mc-c1');
  r.on('guppy/work-w', 'main'); r.commit('WIDGET-TAB-7: first step'); const c1 = r.commit('WIDGET-TAB-7: census M12 measurable, M13 anchor fixed');
  r.on('guppy/other-positional-198', 'main'); const x = r.commit('OTHER-POSITIONAL-198: builtin delta');
  r.on('guppy/other-guard', 'main'); const og1 = r.commit('OTHER-GUARD: one'); const og2 = r.commit('OTHER-GUARD: two');
  r.on('guppy/plain-x', 'main'); const pl = r.commit('Normalize native probe environment scrub');
  r.on('guppy/int-9.9.8', 'main'); r.merge('guppy/work-w', 'INT-9.9.8 stage 8: merge WIDGET-TAB-7');
  const sm = r.merge('guppy/other-positional-198', `INT-9.9.8 stage 9: merge OTHER-POSITIONAL-198 builtin delta (guppy/other-positional-198 @${s8(x)}, tests)`);
  r.later('guppy/int-9.9.8');
  r.on('guppy/widget-tab-7', 'main'); r.commit('WIDGET-TAB-7: re-cut');
  r.g('switch', '-q', 'main');
  res = await runReal(G, r, ['WIDGET-TAB-7', 'OTHER-POSITIONAL-198', 'OTHER-GUARD', 'INT-9.9.8', ...LATER],
    mail('mc-c1', `Re: WIDGET-TAB-7: pushed @${s8(c1)}, with the auditor; one limit needs your call`, { card: 'WIDGET-TAB-7', in_reply_to: 'req-c1', body: `Also: ${s8(sm)} ${s8(og1)} ${s8(og2)} ${s8(pl)}` }),
    { id: 'req-c1', subject: 'Next: WIDGET-TAB-7 (yours, P2)' });
  assert.equal(commitOf(res, slot('WIDGET-TAB-7', SAM)), c1, 'C1');

  // C2 (reply row; m is the INT's own two-parent merge, "INT 9.9.9" spaced, no "into"; a second bare sha in the subject).
  r = mirrorRepo('mc-c2');
  r.on('guppy/other-rmw', 'main'); const sx = r.commit('test(config): drive the handlers');
  r.on('guppy/other-read-cache', 'main'); const z = r.commit('OTHER-REG-CACHE: reg'); const b = r.commit('OTHER-READ-CACHE: stack tip');
  r.on('guppy/other-tag', 'main'); const ot = r.commit('OTHER-TAG: tag');
  r.on('guppy/int-9.9.9', 'main'); const pm = r.merge('guppy/other-tag', `INT 9.9.9: merge OTHER-TAG @${s8(ot)}`);
  const p1 = r.merge('guppy/other-rmw', `INT 9.9.9: merge OTHER-RMW @${s8(sx)} (on OTHER-CACHE ${s8(z)})`);
  const m = r.merge('guppy/other-read-cache', `INT 9.9.9: merge OTHER-READ-CACHE stack @${s8(b)} (OTHER-REG-CACHE ${s8(z)}, OTHER-READ-CACHE)`);
  r.later('guppy/int-9.9.9');
  r.g('switch', '-q', 'main'); const rn = r.commit('docs: release notes', 'docs/notes.md');
  res = await runReal(G, r, ['INT-9.9.9', 'OTHER-RMW', 'OTHER-READ-CACHE', 'OTHER-REG-CACHE', 'OTHER-TAG', 'OTHER-CACHE', ...LATER],
    mail('mc-c2', `INT-9.9.9 @${s8(m)}: PASS 0/0/0/1 (merges = auto-merge but the glob count 525; 7/7 survivors now killed by ${s8(sx)}; probe 19/19; 13 files green; NIT: a name)`,
      { cards: ['INT-9.9.9'], in_reply_to: 'req-c2', body: `Read ${s8(pm)} ${s8(p1)} ${s8(z)} ${s8(b)} ${s8(ot)} ${s8(rn)}.` }),
    { id: 'req-c2', subject: `Audit INT-9.9.9 @${s8(m)} (whole-INT), incl. the unaudited commits ${s8(z)}, ${s8(sx)}, ${s8(b)}` });
  assert.equal(commitOf(res, slot('INT-9.9.9', SAM)), m, 'C2');
});

test('re-gate must D: reply-only done mails keep their sha: a bare subject sha that a body range p..c ends at is still the subject\'s report (D1); a plain fix on a differently named branch (D2)', async () => {
  const G = loadTs('src/main/claims/derivedGit.ts');
  let r = mirrorRepo('md-d1');
  r.on('guppy/widget-tab-7', 'main'); const p = r.commit('WIDGET-TAB-7: the view'); const c = r.commit('WIDGET-TAB-7: link the ask (auditor delta SHOULD)');
  r.on('guppy/int-9.9.9', 'main'); r.merge('guppy/widget-tab-7', 'merge guppy/widget-tab-7 into guppy/int-9.9.9');
  r.later('guppy/int-9.9.9'); r.g('switch', '-q', 'main');
  const CARDS = ['WIDGET-TAB-7', 'INT-9.9.9', ...LATER];
  let res = await runReal(G, r, CARDS,
    mail('md-d1', `WIDGET SHOULD fix ${s8(c)}: OK. Link only on the newest open ask of a BLOCKED card (x); tests 17/17; done`, { cards: ['WIDGET-TAB-7'], in_reply_to: 'req-d1', body: `Delta ${s8(p)}..${s8(c)} is View.tsx + review.ts + test. Fine.` }),
    { id: 'req-d1', subject: `Spot-check WIDGET SHOULD fix @ ${s8(c)} (merged into int)` });
  assert.equal(commitOf(res, slot('WIDGET-TAB-7', SAM)), c, 'MUTANT must D: the body range took the subject\'s own sha away (D1)');

  r = mirrorRepo('md-d2');
  r.on('guppy/related-run-sidecar', 'main'); r.commit('WIDGET-TAB-7: the run'); const p2 = r.commit('WIDGET-TAB-7: the sidecar'); const c2 = r.commit('fix: harden the related run sidecar');
  r.on('guppy/int-9.9.9', 'main'); r.merge('guppy/related-run-sidecar', 'merge guppy/related-run-sidecar into guppy/int-9.9.9');
  r.later('guppy/int-9.9.9'); r.g('switch', '-q', 'main');
  res = await runReal(G, r, CARDS,
    mail('md-d2', `WTK fix-up ${s8(c2)} re-check: PASS 0/0/0 (1 nit)`, { cards: ['WIDGET-TAB-7'], in_reply_to: 'req-d2', body: `Was ${s8(p2)}, now ${s8(c2)}.` }),
    { id: 'req-d2', subject: `Re-check WTK fix-up @${s8(c2)} against your CHANGES 0/1/3` });
  assert.equal(commitOf(res, slot('WIDGET-TAB-7', SAM)), c2, 'D2');
});

test('re-gate must E: the card\'s own commit the subject writes outranks a later body sha; a forward-looking body line ("Next: ... at <sha>") reports nothing', async () => {
  const G = loadTs('src/main/claims/derivedGit.ts');
  const r = mirrorRepo('me');
  r.on('guppy/widget-tab-7', 'main'); const e1 = r.commit('WIDGET-TAB-7: delta one');
  r.on('guppy/other-side', 'main'); const e2 = r.commit('fix: the other delta'); r.g('switch', '-q', 'main');
  const CARDS = ['WIDGET-TAB-7', 'OTHER-SIDE-4'];
  // Twin E (Jim's row): the subject's own-card sha against a later plain sha on a "Next:" line.
  let res = await runReal(G, r, CARDS, mail('me-a', `WIDGET-TAB-7 delta ${s8(e1)}: PASS 0/1/0`, { body: `Checked the delta.\nNext: the OTHER delta at ${s8(e2)}` }));
  assert.equal(commitOf(res, slot('WIDGET-TAB-7', SAM)), e1, 'E');
  // The subject rule alone: a plain later sha on an ordinary body line still loses to the subject's own-card sha.
  res = await runReal(G, r, CARDS, mail('me-b', `WIDGET-TAB-7 delta ${s8(e1)}: PASS 0/1/0`, { body: `Also touched ${s8(e2)}.` }));
  assert.equal(commitOf(res, slot('WIDGET-TAB-7', SAM)), e1, 'MUTANT must E: a later body sha beat the subject\'s own-card sha');
  // The forward-line rule alone: no subject sha; the "Next:" line's later sha is not reported.
  res = await runReal(G, r, CARDS, mail('me-c', 'WIDGET-TAB-7: PASS 0/1/0', { body: `Fixed at ${s8(e1)}.\n- Next: the OTHER delta at ${s8(e2)}` }));
  assert.equal(commitOf(res, slot('WIDGET-TAB-7', SAM)), e1, 'MUTANT must E: a forward-looking body line was read as a report');
  // Not a forward line: "Next" inside a sentence.
  assert.equal(F.FORWARD_LINE_RE.test('Next: the OTHER delta at abc1234'), true);
  assert.equal(F.FORWARD_LINE_RE.test('TODO - rebase at abc1234'), true);
  assert.equal(F.FORWARD_LINE_RE.test('The next delta landed at abc1234'), false);
  assert.equal(F.FORWARD_LINE_RE.test('Nextcloud sync fixed at abc1234'), false);
});

// ———————————————————————————————————————————————————————————— re-gate cf751a (board-size scaling)

test('re-gate cf751a: on a 900-id board, 1,000 done mails with subject and body pair lines read the board ids at most (distinct tokens) x ids x 2 times, not once per card per token', async () => {
  const N = 900, M = 1000;
  const raw = Array.from({ length: N }, (_, k) => k % 3 === 0 ? `HULL-${k}` : `ABC${k % 30}-PART-${k}`);
  let reads = 0;
  const ids = new Proxy(raw, { get(t, p, r) { if (typeof p === 'string' && /^\d+$/.test(p)) reads++; return Reflect.get(t, p, r); } });
  const commits = {}, messages = {}, files = {};
  const sha = (k, j) => { const s = `b${k.toString(16)}c${j}`.padEnd(7, 'd').slice(0, 7); const f = s.repeat(6).slice(0, 40); commits[s] = f; messages[f] = `${raw[k]}: step ${j}`; files[f] = SRC; return s; };
  const mails = [];
  for (let j = 0; j < M; j++) {
    const k = (j * 7) % N, o = (j * 13 + 1) % N;
    const pairWord = raw[o].split('-').slice(0, 2).join('-');
    mails.push({ id: `m-${j}`, act: 'done', from: SAM, subject: `${raw[k]} @${sha(k, 0)}: PASS`, body: `${raw[k]} @${sha(k, 1)}\n${pairWord} @${sha(o, 2)}`, created_at: new Date(Date.parse(T0) + j * 1000).toISOString(), cards: [raw[k]] });
  }
  const git = { ...fakeGit(commits, messages, { files }), async branchesContaining() { return new Set(); } };
  const tokens = new Set();
  for (const m of mails) for (const t of [m.subject, ...m.body.split('\n')]) for (const x of F.subjectAtShas(t)) tokens.add(x.name);
  const r = await F.doneMailFacts(mails, ids, git, { subjectOf: () => undefined });
  assert.ok(r.facts.length > 0, 'the twin writes facts');
  assert.ok(reads <= tokens.size * N * 2, `board ids read ${reads} times for ${tokens.size} distinct tokens (bound ${tokens.size * N * 2})`);
});

// ———————————————————————————————————————————————————————————— re-gate MUST 1 (Jim 61bddb)

test('re-gate MUST 1: a body @sha written after ANOTHER card\'s name never enters this card\'s tip set; a subject @sha whose commit names the card outranks body @shas; a body pair of the card itself still counts', async () => {
  const G = loadTs('src/main/claims/derivedGit.ts');
  const r = mirrorRepo('m1');
  r.on('guppy/int-9.9.9', 'main'); r.commit('INT-9.9.9 stage 1: base');
  r.on('guppy/foo-18', 'guppy/int-9.9.9'); r.commit('FOO-12: first step'); const a = r.commit('FOO-12: the probe limit'); r.commit('FOO-12: tidy');
  const p = r.commit('tidy the probe limit');
  r.on('guppy/plain-x', 'main'); const b = r.commit('Normalize native probe environment scrub');
  r.g('switch', '-q', 'main');
  const PAD = Array.from({ length: 900 }, (_, k) => `PAD-${k}`);
  const subject = `Re: FOO-12: pushed @${s8(a)}, with ${SAM}; one limit needs your call`;
  const body = (word) => `Branch: origin guppy/foo-18 @${s8(a)}, off origin INT 9.9.9\nStage 10 (your req): I'll batch ${word} @${s8(b)} with the rest once each`;
  const row = (id, subj, bd) => mail(id, subj, { card: 'FOO-12', cards: ['FOO-12'], in_reply_to: 'req-m1', body: bd });
  const parent = { id: 'req-m1', subject: 'Next: FOO-12 (yours)' };
  // (a) BAR-NAMES is a board card: its body pair is its own, the subject's own commit is the fact.
  let res = await runReal(G, r, [...PAD, 'FOO-12', 'BAR-NAMES', 'INT-9.9.9'], row('m1-a', subject, body('BAR-NAMES')), parent);
  assert.equal(commitOf(res, slot('FOO-12', SAM)), a, 'MUTANT MUST 1 (a): another card\'s body pair entered the tip set');
  // (b) an unknown numbered card-shaped token is another item (F9): still the subject's commit.
  res = await runReal(G, r, [...PAD, 'FOO-12', 'INT-9.9.9'], row('m1-b', subject, body('BAR-NAMES-41')), parent);
  assert.equal(commitOf(res, slot('FOO-12', SAM)), a, 'MUST 1 (b)');
  // (c) a body line pairing the card itself, no subject @sha: that sha counts.
  res = await runReal(G, r, [...PAD, 'FOO-12', 'BAR-NAMES', 'INT-9.9.9'], row('m1-c', 'Re: FOO-12: pushed, one limit needs your call', `Stage 10: FOO-12 @${s8(b)} landed`), parent);
  assert.equal(commitOf(res, slot('FOO-12', SAM)), b, 'MUST 1 (c): the card\'s own body pair (must 7) counts');
  // (a2) rule 1 alone: the subject's commit names no card, so only the body pair's owner settles it.
  res = await runReal(G, r, [...PAD, 'FOO-12', 'BAR-NAMES', 'INT-9.9.9'], row('m1-a2', `Re: FOO-12: pushed @${s8(p)}, with ${SAM}`, body('BAR-NAMES')), parent);
  assert.equal(commitOf(res, slot('FOO-12', SAM)), p, 'MUTANT MUST 1 rule 1: another card\'s body pair made the row ambiguous');
  // (e) rule 2 alone: the subject's own commit outranks the card's own body pair of an unrelated commit.
  res = await runReal(G, r, [...PAD, 'FOO-12', 'BAR-NAMES', 'INT-9.9.9'], row('m1-e', subject, `Stage 10: FOO-12 @${s8(b)} queued`), parent);
  assert.equal(commitOf(res, slot('FOO-12', SAM)), a, 'MUTANT MUST 1 rule 2: a body @sha outranked the subject\'s own commit');
});
