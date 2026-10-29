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
