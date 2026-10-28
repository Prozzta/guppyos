'use strict';
/**
 * CLAIMS-90 round 9 (god a77298; Jim's brief-p.md, sha f8878475): four derived-fact mechanisms, each with
 * its synthetic fixtures and must-not-regress twins. P1: a done mail's card field naming an unknown card is
 * that other card (noCard), never the thread's card. P2: on a link or subject row a lone subject @sha counts
 * only when the word before it, or the subject segment it sits in, names the card, or the segment names no
 * item, or the subject reports one item. P3: an int card's field row never carries another card's plain
 * commit. P4: an audit entry written sha-first ("@<sha>, Jim PASS") counts, but never a verdict on another
 * line's tip (LANDED in int-… @sha (Jim stage-3 PASS)). S-1: a donesha value is a sha, never a version.
 * Synthetic names and shas only; a fake git port; HOME jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-r9-'));
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
/** A git port over fixed maps: short -> full, full -> subject; parents/files/times optional. */
function fakeGit(commits, messages, extra = {}) {
  return {
    async commitOf(s) { return commits[s] ?? null; },
    async isAncestor() { return false; },
    async time(c) { return (extra.times && extra.times[c]) ?? 0; },
    async message(c) { return messages[c] ?? null; },
    ...(extra.parents ? { async parents(c) { return extra.parents[c] ?? []; } } : {}),
    ...(extra.files ? { async changedFiles(c) { return extra.files[c] ?? null; } } : {}),
    ...(extra.versions ? { async versionOnly(c) { return extra.versions[c] ?? null; } } : {}),
  };
}
const T0 = '2026-01-10T10:00:00.000Z';
const T1 = '2026-01-11T10:00:00.000Z';
const slot = (card, who) => `card.${card.toLowerCase()}.donesha#${who}`;
const commitOf = (r, s) => { const f = r.facts.find((x) => x.slot === s); return f ? f.refs.find((y) => y.type === 'commit').value : undefined; };
const valueOf = (r, s) => r.facts.find((x) => x.slot === s)?.value;

// ———————————————————————————————————————————————————————————— P1
const CARDS1 = ['ALPHA-WIDGET-101', 'SYN-PIN'];
const git1 = fakeGit({ abc1234: H('1'), abc1235: H('2') }, { [H('1')]: 'tidy the thing', [H('2')]: 'SYN-PIN: pin it' });
const mail1 = (id, extra) => ({ id, act: 'done', from: 'sam-aaaaaaaa', cards: ['ALPHA-WIDGET-101'], subject: 'PASS delta: beta gadget @abc1234', body: '', created_at: T0, ...extra });

test('P1: a card field naming an unknown card is that other card: the mail counts for nothing on the thread\'s card (noCard)', async () => {
  const a = await F.doneMailFacts([mail1('p1-a', { card: 'BETA-GADGET-102' })], CARDS1, git1);
  assert.deepEqual(a.facts, [], 'P1-a: no row for ALPHA-WIDGET-101');
  assert.deepEqual(a.skips, [{ mail: 'p1-a', reason: 'noCard', cards: ['BETA-GADGET-102'] }], 'MUTANT P1: the unknown field falls through to the link');
  assert.equal(a.skipped.noCard, 1);
  // P1-b (must not regress): the same mail without a card field counts by its link.
  const b = await F.doneMailFacts([mail1('p1-b', {})], CARDS1, git1);
  assert.equal(commitOf(b, slot('ALPHA-WIDGET-101', 'sam-aaaaaaaa')), H('1'), 'P1-b: the link still counts');
  // P1-c: a field differing only in case, dashes or spaces is that card.
  for (const f of ['alpha widget 101', 'alpha-widget-101', 'ALPHA WIDGET 101', 'AlphaWidget101', ' ALPHA-WIDGET-101 ']) {
    const c = await F.doneMailFacts([mail1('p1-c', { card: f })], CARDS1, git1);
    assert.equal(commitOf(c, slot('ALPHA-WIDGET-101', 'sam-aaaaaaaa')), H('1'), `P1-c: field ${JSON.stringify(f)} is the card`);
    assert.deepEqual(c.skips, []);
  }
  // A blank field is no field (the link counts); a partial id is an unknown card, never the longer one.
  assert.equal(commitOf(await F.doneMailFacts([mail1('p1-d', { card: '  ' })], CARDS1, git1), slot('ALPHA-WIDGET-101', 'sam-aaaaaaaa')), H('1'), 'a blank field is no field');
  assert.deepEqual((await F.doneMailFacts([mail1('p1-e', { card: 'ALPHA-WIDGET' })], CARDS1, git1)).skips, [{ mail: 'p1-e', reason: 'noCard', cards: ['ALPHA-WIDGET'] }], 'a partial id in the field is not the card');
  // An unknown field never counts for a card the subject names either (the field is the mail's card).
  assert.deepEqual((await F.doneMailFacts([mail1('p1-f', { card: 'BETA-GADGET-102', cards: [], subject: 'ALPHA-WIDGET-101 PASS @abc1234' })], CARDS1, git1)).skips, [{ mail: 'p1-f', reason: 'noCard', cards: ['BETA-GADGET-102'] }]);
  // A known field still wins over a link to another card (unchanged).
  assert.equal(commitOf(await F.doneMailFacts([mail1('p1-g', { card: 'SYN-PIN', subject: 'pin @abc1235' })], CARDS1, git1), slot('SYN-PIN', 'sam-aaaaaaaa')), H('2'));
});

// ———————————————————————————————————————————————————————————— P2
const CARDS2 = ['GAMMA-LOOP-201', 'SYN-PIN'];
const git2 = fakeGit({ def5678: H('3'), def5679: H('4') }, { [H('3')]: 'tidy the loop', [H('4')]: 'GAMMA-LOOP-201: the loop itself' });
const link2 = (id, subject, extra = {}) => F.doneMailFacts([{ id, act: 'done', from: 'pat-dddddddd', cards: ['GAMMA-LOOP-201'], subject, body: '', created_at: T0, ...extra }], CARDS2, git2);
const G2 = slot('GAMMA-LOOP-201', 'pat-dddddddd');

test('P2: a lone subject @sha counts on a link or subject row only when the subject ties it to the card or reports one item', async () => {
  const amb = (r, id) => assert.deepEqual(r.skips, [{ mail: id, reason: 'ambiguous', cards: ['GAMMA-LOOP-201'] }], id);
  // P2-a: a multi-item reply; the sha sits in an item that is not the card.
  amb(await link2('p2-a', 'Re: resume - 3 verdicts: GAMMA-LOOP PASS (live deny); DELTA M3 PASS, M4 NOT YET; rc NIT done @def5678'), 'p2-a');
  // P2-b, P2-c (must not regress): the card's own line, and a one-item subject.
  assert.equal(commitOf(await link2('p2-b', 'GAMMA-LOOP-201 delta PASS @def5678'), G2), H('3'), 'P2-b');
  assert.equal(commitOf(await link2('p2-c', 'delta PASS @def5678'), G2), H('3'), 'P2-c');
  // (i) the word before the sha is the card or its branch, in a multi-item subject.
  assert.equal(commitOf(await link2('p2-d', 'OTHER-THING-9 FAIL; guppy/gamma-loop-201 @def5678'), G2), H('3'), 'MUTANT (i): the branch before the sha');
  assert.equal(commitOf(await link2('p2-d2', 'OTHER-THING-9 FAIL; GAMMA-LOOP-201 @def5678'), G2), H('3'), '(i): the id before the sha');
  // (ii) the segment names the card, or names no item (the sha alone).
  assert.equal(commitOf(await link2('p2-e', 'Re: sweep - GAMMA-LOOP-201 PASS @def5678; OTHER-THING-9 FAIL'), G2), H('3'), 'MUTANT (ii): the segment names the card');
  assert.equal(commitOf(await link2('p2-f', 'GAMMA-LOOP-201 PASS; OTHER-THING-9 FAIL; @def5678'), G2), H('3'), 'MUTANT (ii): a sha-only segment');
  assert.equal(commitOf(await link2('p2-f2', 'GAMMA-LOOP-201 PASS; OTHER-THING-9 FAIL - at @def5678'), G2), H('3'), '(ii): a segment naming no item');
  // (iii) one item only, with a reply prefix segment that is no item.
  assert.equal(commitOf(await link2('p2-g', 'Re: sweep - delta PASS @def5678'), G2), H('3'), 'MUTANT (iii): a one-item subject behind a prefix');
  // Not tied: the sha sits with another card's item, or with a status of its own among several items.
  amb(await link2('p2-h', 'OTHER-THING-9 FAIL @def5678; GAMMA-LOOP-201 PASS'), 'p2-h');
  amb(await link2('p2-i', 'GAMMA-LOOP-201 PASS; OTHER-THING-9 FAIL; rc landed @def5678'), 'p2-i');
  // A subject row (no link) takes the same check; a FIELD row does not (the field is authoritative).
  assert.deepEqual((await link2('p2-j', 'GAMMA-LOOP-201 PASS; OTHER-THING-9 FAIL @def5678', { cards: [] })).skips, [{ mail: 'p2-j', reason: 'ambiguous', cards: ['GAMMA-LOOP-201'] }], 'by subject too');
  assert.equal(commitOf(await link2('p2-k', 'Re: resume - 3 verdicts: GAMMA-LOOP PASS (live deny); DELTA M3 PASS, M4 NOT YET; rc NIT done @def5678', { card: 'GAMMA-LOOP-201' }), G2), H('3'), 'MUTANT: a field row is unchanged');
  // A commit whose own subject names the card is not needed: the subject settles it, not git (the rule is the subject's).
  amb(await link2('p2-l', 'OTHER-THING-9 FAIL @def5679; GAMMA-LOOP-201 PASS'), 'p2-l');
  // Two @shas go through subjectTip as before (unchanged): next to the card's id wins.
  assert.equal(commitOf(await link2('p2-m', 'OTHER-THING-9 @def5678; GAMMA-LOOP-201 @def5679'), G2), H('4'), 'two @shas: unchanged');
  // loneAtCounts itself.
  const names = F.cardNamer(CARDS2);
  const lone = (subject, name = '') => F.loneAtCounts(subject, { sha: 'def5678', name }, 'GAMMA-LOOP-201', names);
  assert.equal(lone('A-1 PASS; B-2 FAIL @def5678', 'gamma-loop-201'), true, 'MUTANT (i): the word before the sha is the id although its segment is another item');
  assert.equal(lone('A-1 PASS; B-2 FAIL @def5678', 'origin/guppy/gamma-loop-201'), true, '(i): the branch');
  assert.equal(lone('A-1 PASS; B-2 FAIL @def5678', 'gamma-loop-20'), false, '(i): a partial id is not the card');
  assert.equal(lone('A-1 PASS; B-2 FAIL; done @def5678', 'done'), false, 'MUTANT: three items, the sha with a status of its own');
  assert.equal(lone('A-1 PASS; B-2 FAIL; @def5678', 'fail'), true, 'a sha-only segment names no item');
  assert.equal(lone('A-1 PASS — gamma loop 201 done @def5678', 'done'), true, 'the segment names the card (space form)');
  assert.equal(lone('one @def5678', 'one'), true, 'one item');
  assert.equal(lone('Re: thread - one @DEF5678', 'one'), true, 'the sha as written, any case; the prefix is no item');
});

// ———————————————————————————————————————————————————————————— P3
const CARDS3 = ['INT-9.4.2', 'SYN-PIN'];
const git3 = fakeGit(
  { '1111aaa': H('5'), '2222bbb': H('6'), '3333ccc': H('7'), '4444ddd': H('8'), '5555eee': H('9') },
  { [H('5')]: 'INT 9.4.2 release', [H('6')]: 'OMEGA-CI-ONE-301: fix publish', [H('7')]: 'PSI-IPC-302: full run', [H('8')]: 'INT 9.4.2 fixup 2', [H('9')]: 'INT 9.4.2: merge prep for OMEGA-CI-ONE-301' },
  { parents: { [H('5')]: [H('a')], [H('6')]: [H('5')], [H('7')]: [H('6')], [H('8')]: [H('5')], [H('9')]: [H('5')] }, files: { [H('5')]: SRC, [H('6')]: SRC, [H('7')]: SRC, [H('8')]: SRC, [H('9')]: SRC },
    times: { [H('5')]: 10, [H('6')]: 20, [H('7')]: 30, [H('8')]: 40, [H('9')]: 50 } },
);
const field3 = (id, subject, body, created_at = T0) => ({ id, act: 'done', from: 'kim-bbbbbbbb', card: 'INT-9.4.2', subject, body, created_at });
const I3 = slot('INT-9.4.2', 'kim-bbbbbbbb');

test('P3: an int card\'s field row never carries another card\'s plain commit; its own line commits still count', async () => {
  const early = field3('p3-a1', '9.4.2 released @1111aaa', '');
  const late = field3('p3-a2', 'landed', 'carries 2222bbb and 3333ccc on top of 1111aaa', T1);
  const both = await F.doneMailFacts([early, late], CARDS3, git3);
  assert.equal(commitOf(both, I3), H('5'), 'MUTANT P3: the newest mail picks another card\'s commit (3333ccc) and overwrites the int row');
  assert.equal(commitOf(await F.doneMailFacts([late], CARDS3, git3), I3), H('5'), 'the later mail alone gives the int tip');
  assert.equal(commitOf(await F.doneMailFacts([early], CARDS3, git3), I3), H('5'), 'the earlier mail alone');
  // P3-b (must not regress): the line's own fixup by field.
  assert.equal(commitOf(await F.doneMailFacts([field3('p3-b', 'fixup', '4444ddd')], CARDS3, git3), I3), H('8'), 'P3-b');
  // Its own commit naming another card as well is still the line's (names the card).
  assert.equal(commitOf(await F.doneMailFacts([field3('p3-c', 'prep', '5555eee')], CARDS3, git3), I3), H('9'));
  // Only other cards' commits: nothing is carried (noCommit), and the sender's earlier row stands.
  const only = await F.doneMailFacts([early, field3('p3-d', 'landed', '2222bbb 3333ccc', T1)], CARDS3, git3);
  assert.equal(commitOf(only, I3), H('5'));
  assert.deepEqual(only.skips, [{ mail: 'p3-d', reason: 'noCommit', cards: ['INT-9.4.2'] }]);
  // A subject @sha that is another card's commit on a field row: nothing carried either.
  assert.deepEqual((await F.doneMailFacts([field3('p3-e', 'done @2222bbb', '')], CARDS3, git3)).skips, [{ mail: 'p3-e', reason: 'noCommit', cards: ['INT-9.4.2'] }]);
  // The line's release commit is its own: version-only files naming the cut card, or a cut card named in a source commit.
  const git3r = fakeGit({ ...{ '1111aaa': H('5'), '6666fff': H('r'), '7777abc': H('s') } }, { [H('5')]: 'INT 9.4.2 release', [H('r')]: 'cut 9.4.2: the version and the CHANGELOG section', [H('s')]: 'CUT-9.4.2 prep: the badge' },
    { files: { [H('5')]: SRC, [H('r')]: ['package.json', 'package-lock.json', 'CHANGELOG.md'], [H('s')]: SRC }, versions: { [H('r')]: true } });
  const CARDS3R = [...CARDS3, 'CUT-9.4.2'];
  assert.equal(commitOf(await F.doneMailFacts([field3('p3-f', 'cut', '6666fff')], CARDS3R, git3r), I3), H('r'), 'MUTANT release: the release-only commit naming the cut card is the line\'s own');
  assert.equal(commitOf(await F.doneMailFacts([field3('p3-g', 'prep', '7777abc')], CARDS3R, git3r), I3), H('s'), 'a source commit naming only the cut card is the line\'s own');
  // S-1 (side check): the value is a sha, never the version in the subject.
  const s1 = await F.doneMailFacts([{ id: 's-1', act: 'done', from: 'rae-cccccccc', card: 'INT-9.4.2', subject: 'INT-9.4.2 final FULL - PASS on 1111aaa', body: '', created_at: T0 }], CARDS3, git3);
  assert.equal(valueOf(s1, slot('INT-9.4.2', 'rae-cccccccc')), H('5'), 'S-1: the value is the sha');
  assert.match(s1.facts[0].text, /names commit 55555555 \(5{40}\)/);
  assert.doesNotMatch(s1.facts[0].value, /^9\.4\.2$/);
});
