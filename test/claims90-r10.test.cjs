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
