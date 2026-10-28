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
