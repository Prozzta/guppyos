'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-WEAKLINK-DONESHA (god e2f85a; mechanism from Jim's R4): memory get's derived done-sha for a card
 * must reflect the latest done mail that reports a sha for that card itself, including when that mail
 * links to the card only by a body mention. The rule, the same for every mail: a done mail with no card
 * field, no inherited (reply/conversation) card and no card in its subject falls back to the cards its
 * body names, and one of them counts only when the messages of the commits the mail reports name exactly
 * that one. A passing mention (a done mail about another card: its own field, link or subject names the
 * other card) never promotes; with no link at all, an unconfirmed body mention gives nothing (bodyOnly).
 * Round 2 (Jim's gate, god cdd4c7): a card the SUBJECT names, in a mail with no card field, takes the
 * same git check (M-a: "U1-U9 killed (U6 included)" made card.u6); and git confirms on the commit's
 * SUBJECT line only (M-b: CHANGELOG, cut and int merge commits list many cards in their bodies).
 * Round 3 (Jim's gate on 844a3ddf, god 2b8abf): only the card's OWN commit confirms it. (A) a commit
 * that changes only CHANGELOG/docs files confirms nothing (GitPort.changedFiles, no subject-prefix
 * rule); (B) a merge (2+ parents) confirms nothing on its own sha and is never reported: it resolves to
 * its merged parent, which counts when its subject or the merged branch names the card, else the merge
 * is dropped, so a later int/rc merge mail yields the builder's own sha and never displaces it; (C) the
 * single-link path needs the commit the row would carry to name no different card (Jim's gate on
 * 8028fa88: the other shas a mail lists are not judged, and a refused link still takes the git check).
 * Round 4b (god aa8321/f7c2bc): a merge INTO the card's own line (its subject, or an earlier merge on its
 * first-parent chain, says "into <the card's branch>") is that card's own work: the merge sha is the value
 * and its merged parents are not descended; every other card sees (B) unchanged. The derived layer records
 * a verdict per processed done mail (derivedDoneStatus) so get's mail rule bridges only the derived lag.
 * Synthetic mails and a fake git port only; HOME jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-weaklink-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const F = loadTs('src/main/claims/derivedFacts.ts');
const DG = loadTs('src/main/claims/derivedGit.ts');
const W = loadTs('src/main/claims/derivedWriter.ts');
const S = loadTs('src/main/claims/derivedDoneStatus.ts');
const { mailBodyHash } = loadTs('src/main/mailLedger.ts');

const H = (c) => c.repeat(40);
/** A git port over a fixed map: short sha -> full commit, full commit -> message. No ancestry, no times.
 *  `extra.parents` / `extra.files` (full -> [full] / [path]) add the round-3 methods; without them the
 *  port, like an older one, answers neither parents nor changed files. */
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
const CARDS = ['SYN-WL', 'SYN-OTHER', 'SYN-THIRD', 'SYN-PIN', 'U6', 'M1'];
// Commits: a and b are SYN-WL's own (their subjects name the card); c is SYN-OTHER's; d names no card;
// e is a CHANGELOG commit whose BODY lists SYN-WL, SYN-OTHER and SYN-PIN; f an int merge whose body lists them.
const CHANGELOG = 'docs: CHANGELOG for 9.1.0\n\n- SYN-WL: the weak link\n- SYN-OTHER: the other card\n- SYN-PIN: pins\n';
const INT_MERGE = "Merge guppy/syn-pin into int-9.1.0\n\ncarries SYN-WL @aaaaaa1, SYN-OTHER @cccccc3 and SYN-PIN\n";
const git = fakeGit(
  { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d'), eeeeee5: H('e'), ffffff6: H('f') },
  { [H('a')]: 'SYN-WL step 3: serve the current value', [H('b')]: 'SYN-WL: fold the delta-audit nits', [H('c')]: 'SYN-OTHER: the other card', [H('d')]: 'housekeeping', [H('e')]: CHANGELOG, [H('f')]: INT_MERGE },
);
const slots = (r) => r.facts.map((f) => f.slot).sort();
const commitOf = (r, slot) => r.facts.find((f) => f.slot === slot).refs.find((y) => y.type === 'commit').value;

test('positive: a delta-audit done reply that names the card only in its body (lower case, beside other cards) gives the card its newest done sha', async () => {
  // The builder's done mail (strong: card field) at a; then the auditor's delta-audit done reply at b. The
  // reply has no card field; its parent named the card only in short form, so delivery inherited nothing;
  // its subject is the parent's; its body names the card in lower case beside two other cards.
  const mails = [
    { id: 'wl-1', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'SYN-WL step 3 served @aaaaaa1', body: 'on origin', created_at: '2026-10-20T10:00:00Z' },
    { id: 'wl-2', act: 'done', from: 'auditor', subject: 'Re: step 3 delta audit', body: 'Delta audit PASS at bbbbbb2 (syn-wl); syn-other and syn-third rows unchanged, test/claims90-wl.test.cjs green.', created_at: '2026-10-21T10:00:00Z' },
  ];
  const r = await F.doneMailFacts(mails, CARDS, git);
  assert.deepEqual(slots(r), ['card.syn-wl.donesha#auditor', 'card.syn-wl.donesha#builder']);
  assert.equal(commitOf(r, 'card.syn-wl.donesha#auditor'), H('b'), "the reply's sha, settled by its commit message naming SYN-WL and no other body card");
  assert.equal(commitOf(r, 'card.syn-wl.donesha#builder'), H('a'));
  assert.deepEqual(r.skips, []);
  // The same sender later: the newest body-linked report supersedes the older body-linked one (one fact per card and sender).
  const later = await F.doneMailFacts([...mails,
    { id: 'wl-3', act: 'done', from: 'auditor', subject: 'Re: step 3 delta audit', body: 'Re-checked syn-wl on aaaaaa1 after the rebase; syn-other untouched.', created_at: '2026-10-22T10:00:00Z' },
  ], CARDS, git);
  assert.equal(commitOf(later, 'card.syn-wl.donesha#auditor'), H('a'), 'wl-3 is the newest from auditor');
  assert.equal(later.older, 1);
});

test('negative: a passing mention never promotes; its own card field naming another card always excludes it', async () => {
  const mails = [
    // Own card field names another card: excluded whatever the body and the commit say.
    { id: 'pm-1', act: 'done', from: 'agent-a', card: 'SYN-OTHER', subject: 'other work done @aaaaaa1', body: 'syn-wl stays pinned at 3', created_at: '2026-10-23T10:00:00Z' },
    // Subject names another card: that card wins; the body's syn-wl is passing.
    { id: 'pm-2', act: 'done', from: 'agent-b', subject: 'SYN-OTHER shipped cccccc3', body: 'OK to close syn-wl too', created_at: '2026-10-23T11:00:00Z' },
    // Inherited (reply/conversation) link to another card: that card wins over the body.
    { id: 'pm-3', act: 'done', from: 'agent-c', cards: ['syn-other'], subject: 'sweep', body: 'pin count: syn-wl 3, syn-third 1; at cccccc3', created_at: '2026-10-23T12:00:00Z' },
    // No link at all, body names the card, but the commit it reports does not name it (a quoted sample): nothing.
    { id: 'pm-4', act: 'done', from: 'agent-d', subject: 'housekeeping landed dddddd4', body: 'quoted sample: "syn-wl: pinned, no change"', created_at: '2026-10-23T13:00:00Z' },
    // No link, body names two cards and the commit names neither: nothing (bodyOnly), never a guess.
    { id: 'pm-5', act: 'done', from: 'agent-e', subject: 'tidy up', body: 'OK to close syn-wl and syn-pin, see dddddd4', created_at: '2026-10-23T14:00:00Z' },
    // No link, body names the card once, but the commit it reports is SYN-OTHER's: nothing.
    { id: 'pm-6', act: 'done', from: 'agent-f', subject: 'done', body: 'cccccc3 lands; syn-wl pinned 3', created_at: '2026-10-23T15:00:00Z' },
  ];
  const r = await F.doneMailFacts(mails, CARDS, git);
  assert.deepEqual(slots(r), ['card.syn-other.donesha#agent-a', 'card.syn-other.donesha#agent-b', 'card.syn-other.donesha#agent-c']);
  assert.equal(r.facts.some((f) => f.key === 'card.syn-wl.donesha'), false, 'no passing mention reached SYN-WL');
  assert.deepEqual(r.skips, [
    { mail: 'pm-4', reason: 'bodyOnly', cards: ['SYN-WL'] },
    { mail: 'pm-5', reason: 'bodyOnly', cards: ['SYN-WL', 'SYN-PIN'] },
    { mail: 'pm-6', reason: 'bodyOnly', cards: ['SYN-WL'] },
  ]);
  assert.equal(r.skipped.bodyOnly, 3);
  // Without a message port git confirms nothing: a body-only mention stays bodyOnly even for the card's own commit.
  const noMsg = { async commitOf(s) { return s === 'bbbbbb2' ? H('b') : null; }, async isAncestor() { return false; }, async time() { return 0; } };
  const blind = await F.doneMailFacts([{ id: 'wl-2', act: 'done', from: 'auditor', subject: 'Re: delta audit', body: 'PASS at bbbbbb2 (syn-wl)' }], CARDS, noMsg);
  assert.deepEqual(blind.skips, [{ mail: 'wl-2', reason: 'bodyOnly', cards: ['SYN-WL'] }]);
  // Round 5 (god bfcff1, deliberately changed from round 2's noCard): a body mention written as a spelling
  // variant (a space for the dash) names the card like any other; git confirms it through b's subject.
  const variant = await F.doneMailFacts([{ id: 'v-1', act: 'done', from: 'auditor', subject: 'Re: delta audit', body: 'PASS at bbbbbb2 (syn wl)' }], CARDS, git);
  assert.deepEqual(slots(variant), ['card.syn-wl.donesha#auditor']);
});

test('index: a mention-body row reaches doneMailFacts with its body but no card and no linked cards; through the writer the body-linked report wins only when git confirms it', async () => {
  const root = path.join(JAIL, 'hive');
  const dir = path.join(root, 'state', 'mail-cards');
  fs.mkdirSync(dir, { recursive: true });
  const row = (o) => JSON.stringify({ v: 1, act: 'done', trust: 'two-party', to: 'god', bodyHash: mailBodyHash(o.body ?? ''), ...o });
  // The index files one mention-body mail under every card its body names (syn-wl, syn-other, syn-third).
  const weak = { id: 'wl-2', cards: ['SYN-WL', 'SYN-OTHER', 'SYN-THIRD'], cardFrom: 'mention-body', from: 'auditor', subject: 'Re: step 3 delta audit', body: 'Delta audit PASS at bbbbbb2 (syn-wl); syn-other and syn-third unchanged.', created_at: '2026-10-21T10:00:00Z' };
  fs.writeFileSync(path.join(dir, 'syn-wl.jsonl'), [
    row({ id: 'wl-1', card: 'SYN-WL', cards: ['SYN-WL'], cardFrom: 'field', from: 'builder', subject: 'SYN-WL step 3 served @aaaaaa1', body: 'on origin', created_at: '2026-10-20T10:00:00Z' }),
    row({ ...weak, card: 'SYN-WL' }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'syn-other.jsonl'), [
    row({ ...weak, card: 'SYN-OTHER' }),
    row({ id: 'pm-1', card: 'SYN-OTHER', cards: ['SYN-OTHER'], cardFrom: 'field', from: 'agent-a', subject: 'other work done @cccccc3', body: 'syn-wl stays pinned at 3', created_at: '2026-10-23T10:00:00Z' }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'syn-third.jsonl'), row({ ...weak, card: 'SYN-THIRD' }));
  const mails = W.readDoneMails(root);
  assert.deepEqual(mails.map((m) => [m.id, m.card ?? null, JSON.stringify(m.cards ?? null), typeof m.body]).sort(), [
    ['pm-1', 'SYN-OTHER', '["SYN-OTHER"]', 'string'],
    ['wl-1', 'SYN-WL', '["SYN-WL"]', 'string'],
    ['wl-2', null, 'null', 'string'],
  ], 'the weak row once (by id), with its body, no card and no linked cards');
  const r = await F.doneMailFacts(mails, CARDS, git);
  assert.deepEqual(slots(r), ['card.syn-other.donesha#agent-a', 'card.syn-wl.donesha#auditor', 'card.syn-wl.donesha#builder']);
  assert.equal(commitOf(r, 'card.syn-wl.donesha#auditor'), H('b'));
  assert.equal(commitOf(r, 'card.syn-other.donesha#agent-a'), H('c'), "pm-1's field names SYN-OTHER: its syn-wl mention is passing");
  // A weak row whose body does not hash to the row is read without its body: subject only, so no card from the body.
  fs.writeFileSync(path.join(dir, 'syn-pin.jsonl'), row({ id: 'wl-9', card: 'SYN-PIN', cards: ['SYN-PIN'], cardFrom: 'mention-body', from: 'auditor', subject: 'Re: audit bbbbbb2', body: 'syn-pin', bodyHash: 'not-the-hash' }));
  const torn = W.readDoneMails(root).find((m) => m.id === 'wl-9');
  assert.deepEqual([torn.card ?? null, torn.cards ?? null, torn.body ?? null], [null, null, null]);
  assert.deepEqual((await F.doneMailFacts([torn], CARDS, git)).skips, [{ mail: 'wl-9', reason: 'noCard' }]);
});

test('round 2 M-a: a card the subject names (no card field) takes the git check: confirmed by a commit subject it is found; a label-like id in the subject is not', async () => {
  const mails = [
    // The delta-audit reply whose SUBJECT names the card and whose commit's subject names it: found.
    { id: 'r2-1', act: 'done', from: 'auditor', subject: 'Re: SYN-WL delta audit PASS at bbbbbb2', body: 'rows unchanged', created_at: '2026-10-24T10:00:00Z' },
    // "U1-U9 killed (U6 included)": U6 is a known card id but a label here; the commit is SYN-OTHER's: nothing.
    { id: 'r2-2', act: 'done', from: 'runner', subject: 'U1-U9 killed (U6 included) at cccccc3', body: 'the mutant census', created_at: '2026-10-24T11:00:00Z' },
    // "M1 unanswered": the commit names no card: nothing.
    { id: 'r2-3', act: 'done', from: 'runner', subject: 'M1 unanswered, dddddd4 pushed', body: 'see the log', created_at: '2026-10-24T12:00:00Z' },
    // Two cards in the subject, one of them the commit subject's: that one (unchanged).
    { id: 'r2-4', act: 'done', from: 'builder', subject: 'SYN-WL and SYN-PIN at aaaaaa1', body: '', created_at: '2026-10-24T13:00:00Z' },
  ];
  const r = await F.doneMailFacts(mails, CARDS, git);
  assert.deepEqual(slots(r), ['card.syn-wl.donesha#auditor', 'card.syn-wl.donesha#builder']);
  assert.equal(commitOf(r, 'card.syn-wl.donesha#auditor'), H('b'));
  assert.equal(commitOf(r, 'card.syn-wl.donesha#builder'), H('a'));
  assert.deepEqual(r.skips, [
    { mail: 'r2-2', reason: 'ambiguous', cards: ['U6'] },
    { mail: 'r2-3', reason: 'ambiguous', cards: ['M1'] },
  ]);
  assert.equal(r.facts.some((f) => /card\.(u6|m1)\./.test(f.key)), false, 'no card.u6 or card.m1 from a label in a subject');
  // A single inherited link the subject does not contradict still counts without git (unchanged).
  const linked = await F.doneMailFacts([{ id: 'r2-5', act: 'done', from: 'auditor', cards: ['syn-wl'], subject: 'Re: delta audit, dddddd4', body: 'fine' }], CARDS, git);
  assert.deepEqual(slots(linked), ['card.syn-wl.donesha#auditor']);
});

test('round 2 M-b: git confirms on the commit SUBJECT only: a CHANGELOG or int merge commit whose body lists the card confirms nothing', async () => {
  const mails = [
    // A cut audit mail (no card field) naming a few cards in its subject, reporting the CHANGELOG commit: nothing.
    { id: 'r2-6', act: 'done', from: 'auditor', subject: 'cut 9.1.0 audit: SYN-WL, SYN-OTHER checked @eeeeee5', body: 'all rows green', created_at: '2026-10-24T14:00:00Z' },
    // The same mail naming ONE card in its subject: the CHANGELOG body lists it, the subject does not: nothing.
    { id: 'r2-7', act: 'done', from: 'auditor', subject: 'cut 9.1.0 audit: SYN-WL checked @eeeeee5', body: 'all rows green', created_at: '2026-10-24T15:00:00Z' },
    // A body-named card with the int merge commit (its body lists the card): nothing.
    { id: 'r2-8', act: 'done', from: 'integrator', subject: 'int 9.1.0 staged ffffff6', body: 'carries syn-wl and syn-other', created_at: '2026-10-24T16:00:00Z' },
    // The CHANGELOG commit beside the card's own commit: the own commit's subject settles it.
    { id: 'r2-9', act: 'done', from: 'builder', subject: 'SYN-WL done at bbbbbb2, changelog eeeeee5', body: '', created_at: '2026-10-24T17:00:00Z' },
  ];
  const r = await F.doneMailFacts(mails, CARDS, git);
  assert.deepEqual(slots(r), ['card.syn-wl.donesha#builder']);
  assert.deepEqual(r.skips, [
    { mail: 'r2-6', reason: 'ambiguous', cards: ['SYN-WL', 'SYN-OTHER'] },
    { mail: 'r2-7', reason: 'ambiguous', cards: ['SYN-WL'] },
    { mail: 'r2-8', reason: 'bodyOnly', cards: ['SYN-WL', 'SYN-OTHER'] },
  ]);
  // The subject line as git's %s: the text before the first blank line, folded; CRLF and a leading blank line tolerated.
  assert.equal(F.commitSubject(CHANGELOG), 'docs: CHANGELOG for 9.1.0');
  assert.equal(F.commitSubject('SYN-WL: fold\r\nthe nits\r\n\r\nbody SYN-OTHER'), 'SYN-WL: fold the nits');
  assert.equal(F.commitSubject('\n\nsubject only'), 'subject only');
  assert.equal(F.commitSubject(null), '');
  assert.equal(F.commitSubject(''), '');
});

// ———————————————————————————————————————————————————————————— round 3: only the card's own commit confirms

// Round-3 commits beside a-f (hex fulls so they look like shas): g, h change only docs although their
// subjects name SYN-WL; i is the int merge of SYN-WL's branch (merged parent b); j merges SYN-OTHER's
// branch on top of i; k is the rc merge of the int line (nested: k -> i -> b); l merges a tidy commit n
// whose subject names no card but whose branch does; p merges SYN-OTHER's branch under a subject that
// names SYN-WL (a merge's own subject must never confirm).
const HX = (c, n) => c.repeat(39) + n;
const R3 = {
  g: H('7'), h: H('8'), i: H('9'), j: H('0'), k: H('1'), l: H('2'), p: H('3'), n: H('4'),
  q1: HX('5', '1'), q2: HX('5', '2'), q3: HX('5', '3'), q4: HX('5', '4'),
};
const git3 = fakeGit(
  { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d'), eeeeee5: H('e'),
    a1a1a1a: R3.g, b2b2b2b: R3.h, c3c3c3c: R3.i, d4d4d4d: R3.j, e5e5e5e: R3.k, f6f6f6f: R3.l, a7a7a7a: R3.p, b8b8b8b: R3.n, c9c9c9c: R3.q1 },
  { [H('a')]: 'SYN-WL step 3: serve the current value', [H('b')]: 'SYN-WL: fold the delta-audit nits', [H('c')]: 'SYN-OTHER: the other card', [H('d')]: 'housekeeping', [H('e')]: CHANGELOG,
    [R3.g]: 'CHANGELOG 9.1.0: row 5 (SYN-WL)', [R3.h]: 'docs: the SYN-WL guide',
    [R3.i]: 'Merge guppy/syn-wl @bbbbbb2 into guppy/int-9.1 (SYN-WL, Jim PASS)',
    [R3.j]: 'Merge guppy/syn-other @cccccc3 into guppy/int-9.1 (SYN-OTHER, Jim PASS)',
    [R3.k]: 'Merge guppy/int-9.1 into rc/9.1 (cut)',
    [R3.l]: "Merge branch 'guppy/syn-wl' into guppy/int-9.1", [R3.n]: 'tidy the tests',
    [R3.p]: 'Merge guppy/syn-pin @cccccc3 into guppy/int-9.1 (SYN-WL re-check)',
    [R3.q1]: 'Merge 1', [R3.q2]: 'Merge 2', [R3.q3]: 'Merge 3', [R3.q4]: 'Merge guppy/syn-wl' },
  {
    parents: { [H('b')]: [H('a')], [R3.i]: [H('d'), H('b')], [R3.j]: [R3.i, H('c')], [R3.k]: [H('d'), R3.i], [R3.l]: [H('d'), R3.n], [R3.p]: [H('d'), H('c')],
      [R3.q1]: [H('d'), R3.q2], [R3.q2]: [H('d'), R3.q3], [R3.q3]: [H('d'), R3.q4], [R3.q4]: [H('d'), H('b')] },
    files: { [H('a')]: ['src/main/x.ts'], [H('b')]: ['src/main/x.ts', 'CHANGELOG.md'], [H('c')]: ['src/main/y.ts'], [H('d')]: ['package.json'], [H('e')]: ['CHANGELOG.md'],
      [R3.g]: ['CHANGELOG.md'], [R3.h]: ['docs/guide.md', 'README.md'], [R3.n]: ['test/x.test.cjs'] },
  },
);
const T0 = '2026-10-20T10:00:00Z';

test('round 3 A: a commit that changes only CHANGELOG/docs files confirms nothing, whatever its subject says', async () => {
  // Subject-named (no card field): the CHANGELOG row commit names SYN-WL in its SUBJECT and changes only CHANGELOG.md.
  const changelog = await F.doneMailFacts([{ id: 'r3a-1', act: 'done', from: 'cutter', subject: 'SYN-WL row added to the CHANGELOG', body: 'at a1a1a1a', created_at: T0 }], CARDS, git3);
  assert.deepEqual(changelog.facts, [], 'no row: the commit is not the card\'s work');
  assert.deepEqual(changelog.skips, [{ mail: 'r3a-1', reason: 'ambiguous', cards: ['SYN-WL'] }]);
  const docs = await F.doneMailFacts([{ id: 'r3a-2', act: 'done', from: 'writer', subject: 'SYN-WL guide written', body: 'b2b2b2b', created_at: T0 }], CARDS, git3);
  assert.deepEqual(docs.facts, [], 'docs/ and README.md only');
  // Body-named: the same, bodyOnly.
  const body = await F.doneMailFacts([{ id: 'r3a-3', act: 'done', from: 'writer', subject: 'docs sweep', body: 'syn-wl guide at b2b2b2b', created_at: T0 }], CARDS, git3);
  assert.deepEqual(body.skips, [{ mail: 'r3a-3', reason: 'bodyOnly', cards: ['SYN-WL'] }]);
  // A commit that changes CHANGELOG.md beside source is the card's work: confirms as before.
  const mixed = await F.doneMailFacts([{ id: 'r3a-4', act: 'done', from: 'builder', subject: 'SYN-WL nits folded', body: 'bbbbbb2', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(mixed, 'card.syn-wl.donesha#builder'), H('b'));
  // Beside the card's own commit the docs commit neither confirms nor contradicts.
  const beside = await F.doneMailFacts([{ id: 'r3a-5', act: 'done', from: 'builder', subject: 'SYN-WL done', body: 'bbbbbb2, CHANGELOG row a1a1a1a', created_at: T0 }], CARDS, git3);
  assert.deepEqual(slots(beside), ['card.syn-wl.donesha#builder']);
  // Round 6 (god 18e97a, R6-2; deliberately changed from round 3): a docs-only commit is not carried for a
  // feature card even by its card FIELD; only a cut/release card keeps it.
  const field = await F.doneMailFacts([{ id: 'r3a-6', act: 'done', from: 'cutter', card: 'SYN-WL', subject: 'row added', body: 'a1a1a1a', created_at: T0 }], CARDS, git3);
  assert.deepEqual(field.skips, [{ mail: 'r3a-6', reason: 'noCommit', cards: ['SYN-WL'] }], 'MUTANT release carried by field');
  // Without a changedFiles method the files are unknown and the subject confirms as in round 2 (the
  // production port, DerivedGit, has the method).
  const blind = await F.doneMailFacts([{ id: 'r3a-7', act: 'done', from: 'cutter', subject: 'SYN-WL row added', body: 'a1a1a1a', created_at: T0 }], CARDS,
    fakeGit({ a1a1a1a: R3.g }, { [R3.g]: 'CHANGELOG 9.1.0: row 5 (SYN-WL)' }));
  assert.deepEqual(slots(blind), ['card.syn-wl.donesha#cutter']);
  for (const [f, doc] of [['CHANGELOG.md', true], ['CHANGELOG', true], ['sub/CHANGELOG-9.1.md', true], ['docs/guide.md', true], ['docs/a/b.txt', true], ['README.md', true], ['src/notes.md', true], ['docs\\guide.md', true],
    ['src/main/x.ts', false], ['package.json', false], ['test/docs.test.cjs', false], ['mydocs/x.txt', false], ['src/changelog.ts', false]]) {
    assert.equal(F.isDocFile(f), doc, f);
  }
});

test('round 3 B: a merge confirms nothing on its own sha; it resolves to the merged parent when that names the card, else it is dropped; a later merge mail never displaces the own-commit sha', async () => {
  const builder = { id: 'r3b-1', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'SYN-WL served @bbbbbb2', body: 'on origin', created_at: T0 };
  // (1) The int merge of the card's branch, reported later by the same sender with a card field: the value
  // is the merged parent b, the same sha as before, never the merge sha i.
  const same = await F.doneMailFacts([builder, { id: 'r3b-2', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'SYN-WL merged into int @c3c3c3c', body: 'int-9.1 carries it', created_at: '2026-10-21T10:00:00Z' }], CARDS, git3);
  assert.deepEqual(slots(same), ['card.syn-wl.donesha#builder']);
  assert.equal(commitOf(same, 'card.syn-wl.donesha#builder'), H('b'), 'the merged parent, not the merge');
  assert.match(same.facts[0].text, /names commit bbbbbbbb \(b{40}\) as its subject's @sha \(the merged parent of 99999999, the merge the mail wrote\)$/);
  assert.equal(same.older, 1);
  // (2) A gate mail from another sender, no card field, subject naming the card, reporting the merge:
  // confirmed through the parent's subject; its row carries b, so the builder's row and the gate's agree.
  const gate = await F.doneMailFacts([builder, { id: 'r3b-3', act: 'done', from: 'gate', subject: 'Jim PASS SYN-WL on int @c3c3c3c', body: 'green', created_at: '2026-10-21T11:00:00Z' }], CARDS, git3);
  assert.deepEqual(slots(gate), ['card.syn-wl.donesha#builder', 'card.syn-wl.donesha#gate']);
  assert.equal(commitOf(gate, 'card.syn-wl.donesha#gate'), H('b'));
  assert.equal(commitOf(gate, 'card.syn-wl.donesha#builder'), H('b'), 'the builder\'s own row survives unchanged');
  assert.ok(!JSON.stringify(gate.facts).includes(R3.i), 'the merge sha appears nowhere as a value');
  // (3) The int merge of ANOTHER card's branch (j, merged parent c = SYN-OTHER): nothing for SYN-WL,
  // whether the subject names the card or the card field does; never the merge sha, never c.
  const other = await F.doneMailFacts([{ id: 'r3b-4', act: 'done', from: 'gate', subject: 'SYN-WL int cut @d4d4d4d', body: 'cut', created_at: T0 }], CARDS, git3);
  assert.deepEqual(other.facts, []);
  assert.deepEqual(other.skips, [{ mail: 'r3b-4', reason: 'ambiguous', cards: ['SYN-WL'] }]);
  const otherField = await F.doneMailFacts([{ id: 'r3b-5', act: 'done', from: 'gate', card: 'SYN-WL', subject: 'int cut @d4d4d4d', body: 'cut', created_at: T0 }], CARDS, git3);
  assert.deepEqual(otherField.facts, [], 'dropped: the merged parent names another card');
  assert.deepEqual(otherField.skips, [{ mail: 'r3b-5', reason: 'noCommit', cards: ['SYN-WL'] }]);
  // (4) A merge whose own subject names the card but whose merged parent is another card's commit (p):
  // the merge's subject never confirms.
  const ownSubject = await F.doneMailFacts([{ id: 'r3b-6', act: 'done', from: 'gate', subject: 'SYN-WL re-check merged @a7a7a7a', body: 're-check', created_at: T0 }], CARDS, git3);
  assert.deepEqual(ownSubject.facts, []);
  assert.deepEqual(ownSubject.skips, [{ mail: 'r3b-6', reason: 'ambiguous', cards: ['SYN-WL'] }]);
  // (5) Nested: the rc merge of the int line resolves through i to b.
  const rc = await F.doneMailFacts([{ id: 'r3b-7', act: 'done', from: 'cutter', subject: 'SYN-WL in rc/9.1 @e5e5e5e', body: 'cut', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(rc, 'card.syn-wl.donesha#cutter'), H('b'));
  // (6) The merged BRANCH names the card when the parent's subject does not (l merges n, "tidy the tests").
  const branch = await F.doneMailFacts([{ id: 'r3b-8', act: 'done', from: 'builder', subject: 'SYN-WL tidy merged @f6f6f6f', body: 'tidy', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(branch, 'card.syn-wl.donesha#builder'), R3.n);
  // (7) A merge named in the body (no @sha) resolves the same way; beside the own commit the value is still b.
  const bodyMerge = await F.doneMailFacts([{ id: 'r3b-9', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'landed', body: 'bbbbbb2, merged as c3c3c3c', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(bodyMerge, 'card.syn-wl.donesha#builder'), H('b'));
  assert.doesNotMatch(bodyMerge.facts[0].text, /latest in git order of the 2/, 'the merge and its parent are one commit');
  // (8) resolveReported: merges nest at most 3 deep; mergedBranch forms. Round 4b: a merge whose subject says
  // what line it merged into is listed too, for that line only (`into`); the nested int merge inside the rc merge keeps its own.
  assert.deepEqual(await F.resolveReported(R3.i, git3), [{ commit: R3.i, text: 'Merge guppy/syn-wl @bbbbbb2 into guppy/int-9.1 (SYN-WL, Jim PASS)', docsOnly: false, into: 'guppy/int-9.1' }, { commit: H('b'), text: 'SYN-WL: fold the delta-audit nits guppy/syn-wl', merge: R3.i, chain: [R3.i], docsOnly: false }]);
  assert.deepEqual((await F.resolveReported(R3.k, git3)).map((r) => [r.commit, r.merge, r.into, r.chain]), [[R3.k, undefined, 'rc/9.1', undefined], [R3.i, undefined, 'guppy/int-9.1', undefined], [H('b'), R3.k, undefined, [R3.i, R3.k]]]);
  assert.deepEqual(await F.resolveReported(R3.q1, git3), [], 'four merges deep gives nothing');
  assert.deepEqual(await F.resolveReported(R3.g, git3), [{ commit: R3.g, text: 'CHANGELOG 9.1.0: row 5 (SYN-WL)', docsOnly: true }]);
  assert.equal(F.mergedBranch('Merge guppy/x-1 @abc1234 into guppy/int-1 (X-1, Jim PASS)'), 'guppy/x-1');
  assert.equal(F.mergedBranch("Merge branch 'guppy/x-1' into main"), 'guppy/x-1');
  assert.equal(F.mergedBranch('Merge remote-tracking branch \'origin/guppy/x-1\''), 'origin/guppy/x-1');
  assert.equal(F.mergedBranch('Merge pull request #7 from org/guppy/x-1'), 'org/guppy/x-1');
  assert.equal(F.mergedBranch('X-1: merge the two maps'), '');
  // Without a parents method every commit is a plain one (an older port): the merge sha itself, as in round 2.
  const blind = await F.doneMailFacts([{ id: 'r3b-10', act: 'done', from: 'gate', subject: 'Jim PASS SYN-WL on int @c3c3c3c', body: 'green', created_at: T0 }], CARDS,
    fakeGit({ c3c3c3c: R3.i }, { [R3.i]: 'Merge guppy/syn-wl @bbbbbb2 into guppy/int-9.1 (SYN-WL, Jim PASS)' }));
  assert.equal(commitOf(blind, 'card.syn-wl.donesha#gate'), R3.i);
});

// Round 4b: s2 is a second stage merge on the int line whose subject names no target (its first parent i does);
// INT-9.1 is the card that owns the line guppy/int-9.1.
const S2 = HX('6', '1');
const CARDS4 = [...CARDS, 'INT-9.1'];
const git4 = fakeGit(
  { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d'), c3c3c3c: R3.i, d4d4d4d: R3.j, e5e5e5e: R3.k, d9d9d9d: S2, b8b8b8b: R3.n, f6f6f6f: R3.l },
  { [H('a')]: 'SYN-WL step 3: serve the current value', [H('b')]: 'SYN-WL: fold the delta-audit nits', [H('c')]: 'SYN-OTHER: the other card', [H('d')]: 'housekeeping',
    [R3.i]: 'Merge guppy/syn-wl @bbbbbb2 into guppy/int-9.1 (SYN-WL, Jim PASS)',
    [R3.j]: 'Merge guppy/syn-other @cccccc3 into guppy/int-9.1 (SYN-OTHER, Jim PASS)',
    [R3.k]: 'Merge guppy/int-9.1 into rc/9.1 (cut)',
    [S2]: 'Merge guppy/syn-other @cccccc3 (stage 2)',
    [R3.l]: "Merge branch 'guppy/syn-wl' into guppy/int-9.1", [R3.n]: 'tidy the tests' },
  {
    parents: { [H('b')]: [H('a')], [R3.i]: [H('d'), H('b')], [R3.j]: [R3.i, H('c')], [R3.k]: [H('d'), R3.i], [S2]: [R3.i, H('c')], [R3.l]: [H('d'), R3.n] },
    files: { [H('a')]: ['src/main/x.ts'], [H('b')]: ['src/main/x.ts'], [H('c')]: ['src/main/y.ts'], [H('d')]: ['package.json'], [R3.n]: ['test/x.test.cjs'] },
  },
);

test('round 4b: a merge into the card\'s own line is that card\'s work (the merge sha, not descended); every other card still gets the merged parent or nothing', async () => {
  // The int card's own stage merge, by card field, by link and by subject @sha: the merge sha, no descent.
  const field = await F.doneMailFacts([{ id: 'r4b-1', act: 'done', from: 'int-builder', card: 'INT-9.1', subject: 'stage 1 merged', body: 'c3c3c3c', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(field, 'card.int-9.1.donesha#int-builder'), R3.i, 'MUTANT always-descend: the int card gets the merged parent b');
  assert.match(field.facts[0].text, /the merge into the card's own line/);
  assert.doesNotMatch(field.facts[0].text, /merged parent|latest in git order/);
  const link = await F.doneMailFacts([{ id: 'r4b-2', act: 'done', from: 'int-builder', cards: ['INT-9.1'], subject: 'Re: stage 1', body: 'c3c3c3c', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(link, 'card.int-9.1.donesha#int-builder'), R3.i);
  const named = await F.doneMailFacts([{ id: 'r4b-3', act: 'done', from: 'gate', subject: 'INT-9.1 stage 1 PASS @c3c3c3c', body: 'green', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(named, 'card.int-9.1.donesha#gate'), R3.i, 'the line it merged into names the card');
  // The feature card mentioned in that same merge still gets its own parent commit, never the merge sha.
  const feat = await F.doneMailFacts([{ id: 'r4b-4', act: 'done', from: 'builder', subject: 'SYN-WL merged @c3c3c3c', body: 'landed', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(feat, 'card.syn-wl.donesha#builder'), H('b'), 'MUTANT never-descend: the feature card gets the merge sha');
  const featLink = await F.doneMailFacts([{ id: 'r4b-5', act: 'done', from: 'builder', cards: ['SYN-WL'], subject: 'Re: build', body: 'c3c3c3c', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(featLink, 'card.syn-wl.donesha#builder'), H('b'));
  // Both in one mail: each card its own value, the merge sha only on the int card.
  const both = await F.doneMailFacts([
    { id: 'r4b-6', act: 'done', from: 'int-builder', card: 'INT-9.1', subject: 'stage 1', body: 'c3c3c3c', created_at: T0 },
    { id: 'r4b-7', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'landed', body: 'c3c3c3c', created_at: T0 },
  ], CARDS4, git4);
  assert.deepEqual(both.facts.map((f) => [f.slot, f.value]).sort(), [['card.int-9.1.donesha#int-builder', R3.i], ['card.syn-wl.donesha#builder', H('b')]]);
  // The next stage merge of another card's branch on the same line: the int card's work; SYN-WL gets nothing from it.
  const stage = await F.doneMailFacts([{ id: 'r4b-8', act: 'done', from: 'int-builder', card: 'INT-9.1', subject: 'stage 2', body: 'd4d4d4d', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(stage, 'card.int-9.1.donesha#int-builder'), R3.j);
  const other = await F.doneMailFacts([{ id: 'r4b-9', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'landed', body: 'd4d4d4d', created_at: T0 }], CARDS4, git4);
  assert.deepEqual(other.skips, [{ mail: 'r4b-9', reason: 'noCommit', cards: ['SYN-WL'] }]);
  // A stage merge whose subject names no target: the earlier merge on its first-parent chain says the line.
  const chain = await F.doneMailFacts([{ id: 'r4b-10', act: 'done', from: 'int-builder', card: 'INT-9.1', subject: 'stage 2', body: 'd9d9d9d', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(chain, 'card.int-9.1.donesha#int-builder'), S2, 'the first parent is on the card\'s line');
  // The rc merge of the int line: for the int card the nested stage merge (its own line), never the rc merge sha;
  // for the feature card the own tip, as round 3.
  const rc = await F.doneMailFacts([{ id: 'r4b-11', act: 'done', from: 'cutter', card: 'INT-9.1', subject: 'cut', body: 'e5e5e5e', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(rc, 'card.int-9.1.donesha#cutter'), R3.i, 'the feature tip below the int card\'s own merge is not its value, although the rc merge merged the int branch');
  const rcFeat = await F.doneMailFacts([{ id: 'r4b-12', act: 'done', from: 'gate', subject: 'SYN-WL in rc @e5e5e5e', body: 'cut', created_at: T0 }], CARDS4, git4);
  assert.equal(commitOf(rcFeat, 'card.syn-wl.donesha#gate'), H('b'));
  // A merge sha never comes through a subject mention or an inherited link of a card the line does not name.
  const mention = await F.doneMailFacts([{ id: 'r4b-13', act: 'done', from: 'gate', subject: 'SYN-OTHER on int @c3c3c3c', body: 'checked', created_at: T0 }], CARDS4, git4);
  assert.deepEqual(mention.facts, []);
  // The same int card without the round-4b card in the list: nothing changes for the others (round 3 pins hold).
  const r3 = await F.doneMailFacts([{ id: 'r4b-14', act: 'done', from: 'builder', subject: 'SYN-WL merged @c3c3c3c', body: 'landed', created_at: T0 }], CARDS, git4);
  assert.equal(commitOf(r3, 'card.syn-wl.donesha#builder'), H('b'));
  // mergedInto forms.
  assert.equal(F.mergedInto('Merge guppy/x-1 @abc1234 into guppy/int-9.1.2 stage 2 (X-1)'), 'guppy/int-9.1.2');
  assert.equal(F.mergedInto("Merge branch 'guppy/x-1' into 'guppy/int-9.1.2'"), 'guppy/int-9.1.2');
  assert.equal(F.mergedInto('int-9.1.2 stage 2: merge guppy/x-1 @abc1234'), 'int-9.1.2');
  assert.equal(F.mergedInto('Merge guppy/x-1 @abc1234'), '');
  assert.equal(F.mergedInto('X-1: fold into the map'), '');
  // Round 5: the whole line name after "into", not one token.
  assert.equal(F.mergedInto('Merge FEAT-1 @abc1234 into INT 9.9.9 stage 20'), 'INT 9.9.9', 'MUTANT one-token: INT');
  assert.equal(F.mergedInto('Merge FEAT-1 @abc1234 into INT 9.9.9'), 'INT 9.9.9');
  assert.equal(F.mergedInto('Merge FEAT-1 @abc1234 into INT 9.9.9 (FEAT-1, Jim PASS)'), 'INT 9.9.9');
  assert.equal(F.mergedInto('INT 9.9.9 stage 20: merge FEAT-1 @abc1234'), 'INT 9.9.9');
});

// Round 5 (god bfcff1): s3 is a stage merge whose subject writes the line name with spaces; u is a commit of a
// card tasks.json does not know (card-shaped); v is another int card's own commit, its id written with a space.
const S3 = HX('6', '2');
const U = HX('6', '3');
const V = HX('6', '4');
const CARDS5 = [...CARDS4, 'INT-9.1.2'];
const git5 = fakeGit(
  { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d'), c3c3c3c: R3.i, d4d4d4d: R3.j, e6e6e6e: S3, f7f7f7f: U, a8a8a8a: V },
  { [H('a')]: 'SYN-WL step 3: serve the current value', [H('b')]: 'SYN-WL: fold the delta-audit nits', [H('c')]: 'SYN-OTHER: the other card', [H('d')]: 'housekeeping',
    [R3.i]: 'Merge guppy/syn-wl @bbbbbb2 into guppy/int-9.1 (SYN-WL, Jim PASS)',
    [R3.j]: 'Merge guppy/syn-other @cccccc3 into guppy/int-9.1 (SYN-OTHER, Jim PASS)',
    [S3]: 'Merge guppy/syn-wl @bbbbbb2 into INT 9.1.2 stage 3 (SYN-WL, Jim PASS)',
    [U]: 'FEAT-NEW: a card the board does not know yet', [V]: 'INT 9.1 fixup 4' },
  {
    parents: { [H('b')]: [H('a')], [R3.i]: [H('d'), H('b')], [R3.j]: [R3.i, H('c')], [S3]: [H('d'), H('b')] },
    files: { [H('a')]: ['src/main/x.ts'], [H('b')]: ['src/main/x.ts'], [H('c')]: ['src/main/y.ts'], [H('d')]: ['package.json'], [U]: ['src/main/z.ts'], [V]: ['src/main/w.ts'] },
  },
);

test('round 5: one card recogniser everywhere (variants, whole into-line, card-shaped unknown ids); no fallback after a dropped carried commit', async () => {
  // (1) A stage merge whose subject writes the line name with spaces is the int card's own work.
  const spaced = await F.doneMailFacts([{ id: 'r5-1', act: 'done', from: 'int-builder', card: 'INT-9.1.2', subject: 'stage 3', body: 'e6e6e6e', created_at: T0 }], CARDS5, git5);
  assert.equal(commitOf(spaced, 'card.int-9.1.2.donesha#int-builder'), S3, 'MUTANT one-token: into = "INT" names no card, the merge is dropped');
  const spacedFeat = await F.doneMailFacts([{ id: 'r5-2', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'landed', body: 'e6e6e6e', created_at: T0 }], CARDS5, git5);
  assert.equal(commitOf(spacedFeat, 'card.syn-wl.donesha#builder'), H('b'), 'the feature card still gets its parent');
  // The int card named with a space in a MAIL subject links like the exact id.
  const mailVariant = await F.doneMailFacts([{ id: 'r5-3', act: 'done', from: 'gate', subject: 'int 9.1 stage 1 PASS @c3c3c3c', body: 'green', created_at: T0 }], CARDS5, git5);
  assert.equal(commitOf(mailVariant, 'card.int-9.1.donesha#gate'), R3.i);
  // (C) A card-shaped token the board does not know names some other card: the link is refused.
  const unknown = await F.doneMailFacts([{ id: 'r5-4', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'f7f7f7f', created_at: T0 }], CARDS5, git5);
  assert.deepEqual(unknown.facts, [], 'MUTANT no-shape: FEAT-NEW reads as naming no card and the link counts');
  assert.deepEqual(unknown.skips, [{ mail: 'r5-4', reason: 'ambiguous', cards: ['SYN-WL', 'FEAT-NEW'] }]);
  // (C) Another int card's own commit, its id written with a space, names that card.
  const spacedCommit = await F.doneMailFacts([{ id: 'r5-5', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'a8a8a8a', created_at: T0 }], CARDS5, git5);
  assert.deepEqual(spacedCommit.skips, [{ mail: 'r5-5', reason: 'ambiguous', cards: ['SYN-WL', 'INT-9.1'] }]);
  // (2) A subject @sha that (B) drops (a merge into another line) never falls back to a body sha, by field or by link.
  const dropped = await F.doneMailFacts([{ id: 'r5-6', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'sweep @d4d4d4d', body: 'also dddddd4', created_at: T0 }], CARDS5, git5);
  assert.deepEqual(dropped.facts, [], 'MUTANT fallback: the row carries d, a body sha naming no card');
  assert.deepEqual(dropped.skips, [{ mail: 'r5-6', reason: 'noCommit', cards: ['SYN-WL'] }]);
  const droppedLink = await F.doneMailFacts([{ id: 'r5-7', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep @d4d4d4d', body: 'see bbbbbb2', created_at: T0 }], CARDS5, git5);
  assert.deepEqual(droppedLink.skips, [{ mail: 'r5-7', reason: 'noCommit', cards: ['SYN-WL'] }], 'not even the own commit the body lists');
  // The dropped self entry: the stage merge is INT-9.1's own; for the feature card it is dropped and nothing else is carried.
  const droppedSelf = await F.doneMailFacts([{ id: 'r5-8', act: 'done', from: 'gate', subject: 'SYN-OTHER swept @c3c3c3c', body: 'then cccccc3', created_at: T0 }], CARDS5, git5);
  assert.deepEqual(droppedSelf.facts, []);
  // The recogniser itself.
  const namer = F.cardNamer(['INT-9.1', 'SYN-WL']);
  assert.deepEqual(namer('FEAT-X lands on INT 9.1 beside syn wl'), { cards: ['INT-9.1', 'SYN-WL'], others: ['FEAT-X'] });
  assert.deepEqual(namer('feat-x in lower case; guppy/feat-x; INT-9.1.2 stage 3'), { cards: [], others: ['INT-9.1.2'] }, 'lower case is no card shape; a longer id is another card');
  // Round 6 (god 18e97a): X-1, a one-segment word plus a number, is a label, no card (deliberately changed from round 5).
  assert.deepEqual(namer('INT-9.1: X-1 Y-2.3 ab-CD'), { cards: ['INT-9.1'], others: ['Y-2.3'] });
  assert.deepEqual(namer(''), { cards: [], others: [] });
  assert.deepEqual(F.cardMatcher(['INT-9.1'])('int 9.1 and FEAT-X'), ['INT-9.1'], 'cardMatcher is the recogniser\'s cards');
});

// Round 6 (god 18e97a / 40991c, Jim af127d): synthetic cards and commits only. w1..w9 are commits whose subjects
// write a card in a short form (or an unrelated card-shaped token); rel is a release-only commit (version lines,
// CHANGELOG, README), bump a package.json change beyond the version; m1 a stage merge into the int line whose
// subject also names another card; plain a feature commit.
const CARDS6 = [...CARDS5, 'FEAT-ALPHA-WIDGET-DRAW', 'FEAT-ALPHA-TILE', 'SYN-GAMMA-TILE', 'SYN-BETA-PIPE-123', 'CUT-9.9.9'];
const R6 = { w1: HX('7', '1'), w2: HX('7', '2'), w3: HX('7', '3'), w4: HX('7', '4'), w5: HX('7', '5'), w6: HX('7', '6'), w7: HX('7', '7'), w8: HX('7', '8'), w9: HX('7', '9'),
  rel: HX('8', '1'), bump: HX('8', '2'), m1: HX('8', '3'), plain: HX('8', '4'), m2: HX('8', '5') };
const SRC = ['src/main/x.ts'];
const G6 = [
  { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d'), c3c3c3c: R3.i, d4d4d4d: R3.j, e6e6e6e: S3, f7f7f7f: U, a8a8a8a: V,
    '7a7a7a1': R6.w1, '7a7a7a2': R6.w2, '7a7a7a3': R6.w3, '7a7a7a4': R6.w4, '7a7a7a5': R6.w5, '7a7a7a6': R6.w6, '7a7a7a7': R6.w7, '7a7a7a8': R6.w8, '7a7a7a9': R6.w9,
    '8b8b8b1': R6.rel, '8b8b8b2': R6.bump, '8b8b8b3': R6.m1, '8b8b8b4': R6.plain, '8b8b8b5': R6.m2 },
  { [H('a')]: 'SYN-WL step 3: serve the current value', [H('b')]: 'SYN-WL: fold the delta-audit nits', [H('c')]: 'SYN-OTHER: the other card', [H('d')]: 'housekeeping',
    [R3.i]: 'Merge guppy/syn-wl @bbbbbb2 into guppy/int-9.1 (SYN-WL, Jim PASS)',
    [R3.j]: 'Merge guppy/syn-other @cccccc3 into guppy/int-9.1 (SYN-OTHER, Jim PASS)',
    [S3]: 'Merge guppy/syn-wl @bbbbbb2 into INT 9.1.2 stage 3 (SYN-WL, Jim PASS)',
    [U]: 'FEAT-NEW: a card the board does not know yet', [V]: 'INT 9.1 fixup 4',
    [R6.w1]: 'FEAT-ALPHA-WIDGET-DRAW-123: the id plus a number', [R6.w2]: 'SYN-BETA-PIPE: the id minus its number',
    [R6.w3]: 'SYN-GAMMA: a prefix run', [R6.w4]: 'WIDGET-DRAW: a suffix run', [R6.w5]: 'FAWD-ID: the initials',
    [R6.w6]: 'ALPHA-WIDGET: a middle run', [R6.w7]: 'ZETA-QUAD-NODE-EDGE: an unrelated card', [R6.w8]: 'FEAT-ALPHA: a prefix of two cards',
    [R6.w9]: 'DRAW-STUFF: a one-segment overlap',
    [R6.rel]: 'cut 9.9.9: the version, the README badge and the CHANGELOG section', [R6.bump]: 'SYN-WL: bump a dependency',
    [R6.m1]: 'Merge FEAT-ONE @f7f7f7f into SYN INT 9.1.2 stage 3', [R6.plain]: 'fix: tidy the widget',
    [R6.m2]: 'Merge guppy/syn-wl @bbbbbb2 (stage 4, SYN-WL, Jim PASS)' },
  {
    parents: { [H('b')]: [H('a')], [R3.i]: [H('d'), H('b')], [R3.j]: [R3.i, H('c')], [S3]: [H('d'), H('b')], [R6.m1]: [H('d'), U], [R6.m2]: [R6.m1, H('b')] },
    files: { [H('a')]: SRC, [H('b')]: SRC, [H('c')]: ['src/main/y.ts'], [H('d')]: ['package.json'], [U]: ['src/main/z.ts'], [V]: ['src/main/w.ts'],
      [R6.w1]: SRC, [R6.w2]: SRC, [R6.w3]: SRC, [R6.w4]: SRC, [R6.w5]: SRC, [R6.w6]: SRC, [R6.w7]: SRC, [R6.w8]: SRC, [R6.w9]: SRC,
      [R6.rel]: ['package.json', 'package-lock.json', 'CHANGELOG.md', 'README.md'], [R6.bump]: ['package.json'], [R6.plain]: SRC },
    // Round 7 (R7-2): the port answers per commit (a version-masked diff over every non-doc file).
    versions: { [R6.rel]: true, [R6.bump]: false },
  },
];
const git6 = fakeGit(...G6);

test('round 6: own-card short forms are the card; release-only commits confirm only a cut card; an int card carries only a merge into its line (god 18e97a)', async () => {
  const link = (id, card, body, subject = 'Re: sweep') => F.doneMailFacts([{ id, act: 'done', from: 'auditor', cards: [card], subject, body, created_at: T0 }], CARDS6, git6);
  const field = (id, card, body, subject = 'landed') => F.doneMailFacts([{ id, act: 'done', from: 'builder', card, subject, body, created_at: T0 }], CARDS6, git6);
  const slot = (card) => `card.${card.toLowerCase()}.donesha#auditor`;
  // R6-1 (a): the id plus a trailing number; the id minus its trailing number.
  assert.equal(commitOf(await link('r6-1', 'FEAT-ALPHA-WIDGET-DRAW', '7a7a7a1'), slot('FEAT-ALPHA-WIDGET-DRAW')), R6.w1, 'MUTANT drop (a): FEAT-ALPHA-WIDGET-DRAW-123 refuses the link');
  assert.equal(commitOf(await link('r6-2', 'SYN-BETA-PIPE-123', '7a7a7a2'), slot('SYN-BETA-PIPE-123')), R6.w2, 'the id minus -123 is the card');
  // (b): a prefix run and a suffix run of the segments.
  assert.equal(commitOf(await link('r6-3', 'SYN-GAMMA-TILE', '7a7a7a3'), slot('SYN-GAMMA-TILE')), R6.w3, 'MUTANT drop prefix');
  assert.equal(commitOf(await link('r6-4', 'FEAT-ALPHA-WIDGET-DRAW', '7a7a7a4'), slot('FEAT-ALPHA-WIDGET-DRAW')), R6.w4, 'MUTANT drop suffix');
  // (c): the initials.
  assert.equal(commitOf(await link('r6-5', 'FEAT-ALPHA-WIDGET-DRAW', '7a7a7a5'), slot('FEAT-ALPHA-WIDGET-DRAW')), R6.w5, 'MUTANT drop initials');
  // Round 10 (Jim's gate, must 5a) closes the R6-4 residual: a unique INNER run is the card's own form too.
  assert.equal(commitOf(await link('r6-6', 'FEAT-ALPHA-WIDGET-DRAW', '7a7a7a6'), slot('FEAT-ALPHA-WIDGET-DRAW')), R6.w6, 'MUTANT drop inner run (round 10 must 5a)');
  // Still refused: an unrelated 4-segment id, a form that fits two cards, a one-segment overlap.
  const unrelated = await link('r6-7', 'FEAT-ALPHA-WIDGET-DRAW', '7a7a7a7');
  assert.deepEqual(unrelated.skips, [{ mail: 'r6-7', reason: 'ambiguous', cards: ['FEAT-ALPHA-WIDGET-DRAW', 'ZETA-QUAD-NODE-EDGE'] }], 'a 4-segment unrelated id still refuses');
  const twoFit = await link('r6-8', 'FEAT-ALPHA-WIDGET-DRAW', '7a7a7a8');
  assert.deepEqual(twoFit.skips, [{ mail: 'r6-8', reason: 'ambiguous', cards: ['FEAT-ALPHA-WIDGET-DRAW', 'FEAT-ALPHA'] }], 'MUTANT any fit: a form of two cards is some other card');
  const oneSeg = await link('r6-9', 'FEAT-ALPHA-WIDGET-DRAW', '7a7a7a9');
  assert.deepEqual(oneSeg.skips, [{ mail: 'r6-9', reason: 'ambiguous', cards: ['FEAT-ALPHA-WIDGET-DRAW', 'DRAW-STUFF'] }], 'MUTANT one-segment overlap counts as own');
  // The recogniser and the form rule themselves.
  const namer = F.cardNamer(CARDS6);
  assert.deepEqual(namer('FAWD-7 then SGT-ID and FEAT-ALPHA-WIDGET-DRAW-9, encoded UTF-8 with SHA-1'), { cards: ['FEAT-ALPHA-WIDGET-DRAW', 'SYN-GAMMA-TILE'], others: [] }, 'MUTANT label: UTF-8 / SHA-1 are no card');
  assert.deepEqual(namer('FEAT-ALPHA lands; ALPHA-WIDGET too'), { cards: ['FEAT-ALPHA-WIDGET-DRAW'], others: ['FEAT-ALPHA'] }, 'round 10 must 5a: the unique inner run names the card; the shared prefix is some other card');
  assert.equal(F.isOwnForm('WIDGET-DRAW', 'FEAT-ALPHA-WIDGET-DRAW'), true);
  assert.equal(F.isOwnForm('FEAT-ALPHA-WIDGET', 'FEAT-ALPHA-WIDGET-DRAW'), true);
  assert.equal(F.isOwnForm('ALPHA-WIDGET', 'FEAT-ALPHA-WIDGET-DRAW'), true, 'an inner run (round 10 must 5a)');
  assert.equal(F.isOwnForm('DRAW-STUFF', 'FEAT-ALPHA-WIDGET-DRAW'), false, 'a one-segment overlap');
  assert.equal(F.isOwnForm('fawd', 'FEAT-ALPHA-WIDGET-DRAW'), false, 'R6-4: lower case is never a form');
  assert.equal(F.isOwnForm('FAWD', 'FEAT-ALPHA-WIDGET-DRAW'), true);
  assert.equal(F.isOwnForm('SYN-WL-77', 'SYN-WL'), true);
  assert.equal(F.isOwnForm('SYN-WL-7X', 'SYN-WL'), false, 'only a bare number after the id');
  // R6-2: a release-only commit (version lines + CHANGELOG + README) is the cut card's and no one else's.
  assert.equal(commitOf(await field('r6-10', 'CUT-9.9.9', '8b8b8b1'), 'card.cut-9.9.9.donesha#builder'), R6.rel, 'MUTANT release confirms nothing: the cut card loses its row');
  const relLink = await link('r6-11', 'SYN-WL', '8b8b8b1');
  assert.deepEqual(relLink.skips, [{ mail: 'r6-11', reason: 'noCommit', cards: ['SYN-WL'] }], 'MUTANT release carried: a feature card the release mail mentions gets the release sha');
  const relField = await field('r6-12', 'SYN-WL', '8b8b8b1');
  assert.deepEqual(relField.skips, [{ mail: 'r6-12', reason: 'noCommit', cards: ['SYN-WL'] }], 'not even by field');
  const relSubject = await F.doneMailFacts([{ id: 'r6-13', act: 'done', from: 'cutter', subject: 'cut 9.9.9 landed', body: '8b8b8b1', created_at: T0 }], CARDS6, git6);
  assert.equal(commitOf(relSubject, 'card.cut-9.9.9.donesha#cutter'), R6.rel, 'git confirms the cut card by the release commit');
  assert.equal(commitOf(await field('r6-14', 'SYN-WL', '8b8b8b2'), 'card.syn-wl.donesha#builder'), R6.bump, 'MUTANT any package.json: a change beyond the version line is not release-only');
  // Gate R4 (Jim 2699a7): a release card carries a version; RELEASE-X (no version) is a fix card, so the round-6 pin flips.
  assert.equal(F.isReleaseCard('CUT-9.9.9'), true); assert.equal(F.isReleaseCard('RELEASE-9.9.9'), true); assert.equal(F.isReleaseCard('RELEASE-X'), false); assert.equal(F.isReleaseCard('FEAT-9.9.9-FIX'), true);
  assert.equal(F.isReleaseCard('INT-9.9.9'), false, 'an int card is no cut card'); assert.equal(F.isReleaseCard('SYN-WL'), false);
  // R6-3: an int card carries only a merge into its own line, by link and by field; a plain commit makes the row ambiguous.
  const intPlain = await link('r6-15', 'INT-9.1.2', '8b8b8b4');
  assert.deepEqual(intPlain.skips, [{ mail: 'r6-15', reason: 'ambiguous', cards: ['INT-9.1.2'] }], 'MUTANT int carries a plain commit');
  // Round 7 (god 3af596, R7-1) let a FIELD row carry any plain commit; round 9 (Jim brief-p P3, deliberately
  // retargeted) refuses a plain commit whose subject names only OTHER cards (here the unknown card FEAT-NEW).
  // Gate R1 (Jim c366fb): FEAT-NEW has no number, so it is a topic, not another card; the P3 retarget of r9 goes back.
  assert.equal(commitOf(await field('r6-16', 'INT-9.1.2', 'f7f7f7f'), 'card.int-9.1.2.donesha#builder'), U, 'R7-1 / gate R1: a plain commit naming a non-numbered topic by field is the int done sha');
  // R6-5 (a), Jim's P10: the merge self entry is judged on its into-line, not its whole subject.
  assert.equal(commitOf(await link('r6-17', 'INT-9.1.2', '8b8b8b3'), slot('INT-9.1.2')), R6.m1, 'FEAT-ONE in the subject does not refuse the int card');
  // The into-line comes from the first-parent chain (stage 4 on top of the stage 3 merge): judged on that line,
  // the self entry names only the int card; judged on its whole subject it names SYN-WL and the link is refused.
  assert.equal(commitOf(await link('r6-17b', 'INT-9.1.2', '8b8b8b5'), slot('INT-9.1.2')), R6.m2, 'MUTANT P10: the whole subject (SYN-WL) refuses the link');
  const intSubject = await F.doneMailFacts([{ id: 'r6-18', act: 'done', from: 'gate', subject: 'int 9.1.2 stage 3 PASS', body: '8b8b8b3', created_at: T0 }], CARDS6, git6);
  assert.equal(commitOf(intSubject, 'card.int-9.1.2.donesha#gate'), R6.m1, 'by subject: git confirms the int card by the merge into its line');
  // Round 8 (god 6b94a5; deliberately changed from round 6): the fixup's subject LEADS with the int id, so it is the
  // line's own commit and confirms the card; a plain commit naming the id later still confirms nothing (round 8 test).
  const intSubjectPlain = await F.doneMailFacts([{ id: 'r6-19', act: 'done', from: 'gate', subject: 'int 9.1 fixup PASS', body: 'a8a8a8a', created_at: T0 }], CARDS6, git6);
  assert.equal(commitOf(intSubjectPlain, 'card.int-9.1.donesha#gate'), V, 'R8: the line\'s own fixup confirms the int card by subject');
  // R6-5 (b), Jim's P5: after every subject @sha is dropped the reason is noCommit, even when the body lists another card's commit.
  const p5 = await field('r6-20', 'SYN-WL', 'see cccccc3 too', 'sweep @d4d4d4d');
  assert.deepEqual(p5.skips, [{ mail: 'r6-20', reason: 'noCommit', cards: ['SYN-WL'] }], 'MUTANT P5: ambiguous');
  const p5link = await link('r6-21', 'SYN-WL', 'see cccccc3 too', 'Re: sweep @d4d4d4d');
  assert.deepEqual(p5link.skips, [{ mail: 'r6-21', reason: 'noCommit', cards: ['SYN-WL'] }]);
});

// Round 7 (god 3af596, Jim 3be848): synthetic shapes only. w10 is a plain commit on SYN-WL's line, later than
// everything; m3 a merge of a fix branch INTO SYN-WL's own line whose merged parent is w10.
// m4 is a stage-5 merge on top of m2 (its into-line comes from the chain: the int line) whose subject names
// SYN-WL and whose merged parent (FEAT-NEW) names no known card.
const R7 = { w10: HX('9', '1'), m3: HX('9', '2'), m4: HX('9', '3') };
const git7 = fakeGit(
  { ...G6[0], '9c9c9c1': R7.w10, '9c9c9c2': R7.m3, '9c9c9c3': R7.m4 },
  { ...G6[1], [R7.w10]: 'SYN-WL: the fix', [R7.m3]: 'Merge guppy/syn-wl-fix @9c9c9c1 into guppy/syn-wl (SYN-WL, Jim PASS)',
    [R7.m4]: 'Merge guppy/feat-new @f7f7f7f (stage 5, SYN-WL fix, Jim PASS)' },
  { ...G6[2], parents: { ...G6[2].parents, [R7.m3]: [H('a'), R7.w10], [R7.m4]: [R6.m2, U] }, files: { ...G6[2].files, [R7.w10]: SRC }, times: { [R7.w10]: 20, [R7.m3]: 10 } },
);

test('round 7: an int card by FIELD keeps its plain line commit (R7-1); the release-only port answers per commit (R7-2); self-entry, chain, body-fallback, into-line, own-form and int-subject pins (R7-3)', async () => {
  const link = (id, card, body, subject = 'Re: sweep') => F.doneMailFacts([{ id, act: 'done', from: 'auditor', cards: [card], subject, body, created_at: T0 }], CARDS6, git7);
  const field = (id, card, body, subject = 'landed') => F.doneMailFacts([{ id, act: 'done', from: 'builder', card, subject, body, created_at: T0 }], CARDS6, git7);
  const bySubject = (id, subject, body) => F.doneMailFacts([{ id, act: 'done', from: 'gate', subject, body, created_at: T0 }], CARDS6, git7);
  const slot = (card, who = 'auditor') => `card.${card.toLowerCase()}.donesha#${who}`;
  // R7-1: by FIELD an int card keeps its own plain line commit: a fixup, a pin naming another card, the line's
  // release commit. By link the merges-only rule (R6-3) and its 'ambiguous' reason stay.
  assert.equal(commitOf(await field('r7-1', 'INT-9.1', 'a8a8a8a'), slot('INT-9.1', 'builder')), V, 'MUTANT R7-1: field + fixup refused');
  // Round 9 (P3, deliberately retargeted): a commit naming only another board card is that card's, not the line's.
  assert.deepEqual((await field('r7-2', 'INT-9.1', 'cccccc3')).skips, [{ mail: 'r7-2', reason: 'noCommit', cards: ['INT-9.1'] }], 'P3: field + a commit naming only SYN-OTHER is refused');
  assert.equal(commitOf(await field('r7-3', 'INT-9.1.2', '8b8b8b1'), slot('INT-9.1.2', 'builder')), R6.rel, 'MUTANT R7-1: field + the line\'s release commit refused');
  assert.deepEqual((await link('r7-4', 'INT-9.1.2', '8b8b8b4')).skips, [{ mail: 'r7-4', reason: 'ambiguous', cards: ['INT-9.1.2'] }], 'by link a plain commit stays ambiguous');
  assert.equal(commitOf(await link('r7-5', 'INT-9.1.2', '8b8b8b3'), slot('INT-9.1.2')), R6.m1, 'by link a merge into the line is the done sha');
  // By field a row whose every carried commit is dropped (a merge into ANOTHER int line) is noCommit as in round 5,
  // not the merges-only rule's 'ambiguous'.
  assert.deepEqual((await field('r7-17', 'INT-9.1', 'e6e6e6e')).skips, [{ mail: 'r7-17', reason: 'noCommit', cards: ['INT-9.1'] }], 'MUTANT R7-1: the field row takes the merges-only reason');
  // R7-3 (a): the self entry (into-line set) is kept for the line's card by link: an int line and a feature line.
  assert.equal(commitOf(await link('r7-6', 'INT-9.1', 'c3c3c3c'), slot('INT-9.1')), R3.i, 'MUTANT (a): a self entry is never kept');
  assert.equal(commitOf(await link('r7-7', 'SYN-WL', '9c9c9c2'), slot('SYN-WL')), R7.m3, 'a merge into the feature card\'s own line is its work');
  // R7-3 (b): the merged parent below an own-line merge (later than the merge) is not carried as well.
  assert.equal(commitOf(await link('r7-8', 'SYN-WL', '9c9c9c2 lands'), slot('SYN-WL')), R7.m3, 'MUTANT (b): the parent below the own-line merge is kept too');
  assert.equal(commitOf(await field('r7-8b', 'SYN-WL', '9c9c9c2'), slot('SYN-WL', 'builder')), R7.m3);
  // R7-3 (c): after every subject @sha is dropped the row stays noCommit although its body lists the card's own commit.
  assert.deepEqual((await field('r7-9', 'SYN-WL', 'bbbbbb2 is the one', 'sweep @d4d4d4d')).skips, [{ mail: 'r7-9', reason: 'noCommit', cards: ['SYN-WL'] }], 'MUTANT (c): body fallback');
  assert.deepEqual((await link('r7-10', 'SYN-WL', 'bbbbbb2 is the one', 'Re: sweep @d4d4d4d')).skips, [{ mail: 'r7-10', reason: 'noCommit', cards: ['SYN-WL'] }]);
  // ... and when the subject @sha is one the repository lacks it stays the row's sha as written (F2): still no body fallback.
  const f2 = await field('r7-9b', 'SYN-WL', 'bbbbbb2 is the one', 'sweep @0000000');
  assert.deepEqual([f2.skips, f2.facts.map((f) => [f.slot, f.value])], [[], [['card.syn-wl.donesha#builder', '0000000']]], 'MUTANT (c): an unknown subject @sha falls back to the body');
  const f2link = await link('r7-10b', 'SYN-WL', 'bbbbbb2 is the one', 'Re: sweep @0000000');
  assert.deepEqual([f2link.skips, f2link.facts.map((f) => [f.slot, f.value])], [[], [['card.syn-wl.donesha#auditor', '0000000']]]);
  // The body fallback would surface through the link check: a body commit naming SYN-OTHER would refuse the link
  // and git would confirm SYN-OTHER instead; the subject's sha (kept as written) stays the linked card's row.
  const f2other = await link('r7-10c', 'SYN-WL', 'cccccc3 landed', 'Re: sweep @0000000');
  assert.deepEqual([f2other.skips, f2other.facts.map((f) => [f.slot, f.value])], [[], [['card.syn-wl.donesha#auditor', '0000000']]], 'MUTANT (c): the body commit refuses the link');
  // R7-3 (d): a merge is named by its into-line only, for the link (r6-17/r6-17b) and for git confirmation: the stage-5
  // merge's subject names SYN-WL, its into-line (from the chain) the int card; a subject naming both cards is confirmed
  // for the int card. (A merge of SYN-WL's own branch would confirm SYN-WL too, by its merged parent: ambiguous.)
  const d = await bySubject('r7-11', 'int 9.1.2 stage 5 and syn wl PASS', '9c9c9c3');
  assert.deepEqual(d.skips, []);
  assert.equal(commitOf(d, slot('INT-9.1.2', 'gate')), R7.m4, 'MUTANT (d): git names the merge by its whole subject');
  assert.deepEqual((await bySubject('r7-11b', 'int 9.1.2 stage 4 and syn wl PASS', '8b8b8b5')).skips, [{ mail: 'r7-11b', reason: 'ambiguous', cards: ['INT-9.1.2', 'SYN-WL'] }], 'the merged parent confirms SYN-WL as well');
  // R7-3 (e): own-form edges.
  assert.equal(F.isOwnForm('9-1', 'SYN-ALPHA-9-1'), false, 'MUTANT (e): an all-number run is an own form');
  assert.equal(F.isOwnForm('SAW-FOO', 'SYN-ALPHA-WIDGET'), false, 'MUTANT (e): initials plus an arbitrary segment');
  assert.equal(F.isOwnForm('SAW-ID', 'SYN-ALPHA-WIDGET'), true); assert.equal(F.isOwnForm('SAW-7', 'SYN-ALPHA-WIDGET'), true);
  assert.equal(F.isOwnForm('SYN-ALPHA', 'SYN-ALPHA-123'), true, 'MUTANT (e): the id minus its trailing -NNN');
  // The rule in its own right: a one-segment remainder is no prefix run (the namer itself never sees a one-segment token).
  assert.equal(F.isOwnForm('FEAT', 'FEAT-123'), true, 'MUTANT (e): the id minus -NNN is a form whatever its length');
  const namer = F.cardNamer(['SYN-ALPHA-9-1', 'SYN-GAMMA-WIDGET', 'SYN-BETA-123']);
  assert.deepEqual(namer('SGW-FOO beside SYN-BETA; ALPHA-9-1 too'), { cards: ['SYN-BETA-123', 'SYN-ALPHA-9-1'], others: ['SGW-FOO'] });
  // R7-3 (f): git never confirms an int card by a plain commit's subject: a subject naming the int card and another
  // card, whose only commit is the int fixup, is ambiguous between both (the fixup confirms neither).
  // Round 8 (deliberately changed): the fixup leads with the int id, so it confirms INT-9.1 and is kept by link; the
  // round-8 test pins the (f) shapes with commits that name the id later or another line.
  assert.equal(commitOf(await bySubject('r7-12', 'int 9.1 fixup and SYN-OTHER PASS', 'a8a8a8a'), slot('INT-9.1', 'gate')), V, 'R8: the own-line fixup confirms the int card among two named');
  assert.equal(commitOf(await link('r7-13', 'INT-9.1', 'a8a8a8a'), slot('INT-9.1')), V, 'R8: by link the own-line fixup is kept');
  // R7-2 with the faked port: without versionOnly a non-doc file is code (the older port); a docs-only commit needs no port.
  const noPort = fakeGit({ ...G6[0] }, { ...G6[1] }, { parents: G6[2].parents, files: G6[2].files });
  const relNoPort = await F.doneMailFacts([{ id: 'r7-14', act: 'done', from: 'cutter', card: 'CUT-9.9.9', subject: 'cut', body: '8b8b8b1', created_at: T0 }], CARDS6, noPort);
  assert.equal(commitOf(relNoPort, 'card.cut-9.9.9.donesha#cutter'), R6.rel, 'a code commit is still a done sha for the cut card');
  assert.deepEqual((await F.doneMailFacts([{ id: 'r7-15', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: cut', body: '8b8b8b1', created_at: T0 }], CARDS6, noPort)).skips,
    [{ mail: 'r7-15', reason: 'ambiguous', cards: ['SYN-WL', 'CUT-9.9.9'] }], 'without the port the release commit counts as code: carried, and refused as another card\'s');
  assert.deepEqual((await link('r7-16', 'SYN-WL', '8b8b8b1')).skips, [{ mail: 'r7-16', reason: 'noCommit', cards: ['SYN-WL'] }], 'with the port it is release-only and carried for no feature card');
});

// Round 8 (god 6b94a5, Jim 165f37): x1..x7 are plain commits on or near the int line; m6 a two-parent commit whose
// subject leads with the int id (judged as a merge: no into-line, so only its merged parent); m7 a merge of a branch
// whose tip is x1 into some other line.
const R8 = { x1: HX('a', '1'), x2: HX('a', '2'), x3: HX('a', '3'), x4: HX('a', '4'), x5: HX('a', '5'), x6: HX('a', '6'), x7: HX('a', '7'), m6: HX('a', '8'), m7: HX('a', '9') };
const git8 = fakeGit(
  { ...G6[0], '1a1a1a1': R8.x1, '1a1a1a2': R8.x2, '1a1a1a3': R8.x3, '1a1a1a4': R8.x4, '1a1a1a5': R8.x5, '1a1a1a6': R8.x6, '1a1a1a7': R8.x7, '1a1a1a8': R8.m6, '1a1a1a9': R8.m7 },
  { ...G6[1], [R8.x1]: 'INT 9.1.2 fixup 4: re-pin the count', [R8.x2]: 'INT-9.1.2 stage 3 fixup: the count', [R8.x3]: 'fix: thing for INT 9.1.2',
    [R8.x4]: 'INT 9.1.3: another line', [R8.x5]: 'INT 9.1.20: a longer version', [R8.x6]: 'INT 9.1.2.1: a longer version still', [R8.x7]: 'int 9.1.2: lower case',
    [R8.m6]: 'INT 9.1.2 stage 3', [R8.m7]: 'Merge guppy/int-9.1.2-fix @1a1a1a1 into guppy/other' },
  { ...G6[2], parents: { ...G6[2].parents, [R8.m6]: [H('d'), U], [R8.m7]: [H('d'), R8.x1] },
    files: { ...G6[2].files, [R8.x1]: SRC, [R8.x2]: SRC, [R8.x3]: SRC, [R8.x4]: SRC, [R8.x5]: SRC, [R8.x6]: SRC, [R8.x7]: SRC } },
);

test('round 8: on a link or subject row a plain commit whose own subject leads with the int card\'s id is the line\'s own commit; every other plain commit stays refused (god 6b94a5)', async () => {
  const link = (id, card, body, subject = 'Re: sweep') => F.doneMailFacts([{ id, act: 'done', from: 'auditor', cards: [card], subject, body, created_at: T0 }], CARDS6, git8);
  const bySubject = (id, subject, body) => F.doneMailFacts([{ id, act: 'done', from: 'gate', subject, body, created_at: T0 }], CARDS6, git8);
  const slot = (card, who = 'auditor') => `card.${card.toLowerCase()}.donesha#${who}`;
  const amb = (r, id, cards) => assert.deepEqual(r.skips, [{ mail: id, reason: 'ambiguous', cards }], id);
  // The spellings: a dash or a space, a space / colon / end after, any case.
  assert.equal(commitOf(await link('r8-1', 'INT-9.1.2', '1a1a1a1', 'Re: INT-9.1.2 @1a1a1a1: PASS'), slot('INT-9.1.2')), R8.x1, 'MUTANT R8 dropped: the fixup is refused');
  assert.equal(commitOf(await link('r8-2', 'INT-9.1.2', '1a1a1a2'), slot('INT-9.1.2')), R8.x2, 'MUTANT separator: INT-9.1.2 stage 3 fixup');
  assert.equal(commitOf(await link('r8-3', 'INT-9.1.2', '1a1a1a7'), slot('INT-9.1.2')), R8.x7, 'MUTANT case: int 9.1.2: lower case');
  // Not the line's own: the id later; another int line first; a longer version; a feature commit; a plain verb.
  amb(await link('r8-4', 'INT-9.1.2', '1a1a1a3'), 'r8-4', ['INT-9.1.2']);
  // (INT-9.1.3 and INT-9.1.20 are not board cards, so they are not named in the cards list.)
  amb(await link('r8-5', 'INT-9.1.2', '1a1a1a4'), 'r8-5', ['INT-9.1.2']);
  amb(await link('r8-6', 'INT-9.1.2', '1a1a1a5'), 'r8-6', ['INT-9.1.2']);
  amb(await link('r8-7', 'INT-9.1.2', '1a1a1a6'), 'r8-7', ['INT-9.1.2']);
  amb(await link('r8-8', 'INT-9.1', '1a1a1a1'), 'r8-8', ['INT-9.1']);
  amb(await link('r8-9', 'INT-9.1.2', 'f7f7f7f'), 'r8-9', ['INT-9.1.2']);
  amb(await link('r8-10', 'INT-9.1.2', '8b8b8b4'), 'r8-10', ['INT-9.1.2']);
  // A commit reached through a merge into another line is not the line's own, whatever its subject leads with.
  amb(await link('r8-11', 'INT-9.1.2', '1a1a1a9'), 'r8-11', ['INT-9.1.2']);
  // A two-parent commit whose subject leads with the id is a merge: no into-line, so only its merged parent (a feature commit).
  amb(await link('r8-12', 'INT-9.1.2', '1a1a1a8'), 'r8-12', ['INT-9.1.2']);
  // The rule is the int card's: a feature card linked to the int line's own fixup has its link refused, since the
  // fixup confirms the int card through git (R8) and not the feature card.
  amb(await link('r8-13', 'SYN-WL', '1a1a1a1'), 'r8-13', ['SYN-WL', 'INT-9.1.2']);
  // Through git by subject: the own-line fixup confirms the int card among two named cards; a commit naming the id later,
  // or a feature commit, confirms nothing.
  assert.equal(commitOf(await bySubject('r8-14', 'INT-9.1.2 and SYN-OTHER PASS', '1a1a1a1'), slot('INT-9.1.2', 'gate')), R8.x1, 'MUTANT git: the own-line fixup confirms nothing');
  amb(await bySubject('r8-15', 'INT-9.1.2 and SYN-OTHER PASS', '1a1a1a3'), 'r8-15', ['INT-9.1.2', 'SYN-OTHER']);
  amb(await bySubject('r8-16', 'INT-9.1.2 and SYN-OTHER PASS', '8b8b8b4'), 'r8-16', ['INT-9.1.2', 'SYN-OTHER']);
  // Field rows are unchanged (round 7): the fixup and the feature commit both count by field.
  assert.equal(commitOf(await F.doneMailFacts([{ id: 'r8-17', act: 'done', from: 'builder', card: 'INT-9.1.2', subject: 'landed', body: '1a1a1a3', created_at: T0 }], CARDS6, git8), slot('INT-9.1.2', 'builder')), R8.x3);
  // leadsWithCard itself.
  assert.equal(F.leadsWithCard('INT 9.1.2 fixup 4: x', 'INT-9.1.2'), true); assert.equal(F.leadsWithCard('INT-9.1.2', 'INT-9.1.2'), true); assert.equal(F.leadsWithCard('int 9.1.2: pin', 'INT-9.1.2'), true);
  assert.equal(F.leadsWithCard('INT 9.1.20: x', 'INT-9.1.2'), false, 'MUTANT boundary'); assert.equal(F.leadsWithCard('INT 9.1.2.1: x', 'INT-9.1.2'), false); assert.equal(F.leadsWithCard('INT 9.1.2-fix', 'INT-9.1.2'), false);
  assert.equal(F.leadsWithCard('SYN INT 9.1.2 fixup 4', 'INT-9.1.2'), false, 'a leading word: not first'); assert.equal(F.leadsWithCard('INT 9.1.2', 'INT-9.1'), false, 'a longer id is another line');
  assert.equal(F.leadsWithCard('INT  9.1.2', 'INT-9.1.2'), false, 'one separator'); assert.equal(F.leadsWithCard('INT_9.1.2', 'INT-9.1.2'), false);
});

// Round 7 (R7-2, Jim's (g)): DerivedGit.versionOnly against a real tiny repo, not the faked port.
test('round 7: DerivedGit.versionOnly is a version-masked equal diff over every non-doc file (real repo)', async () => {
  const repo = path.join(JAIL, 'repo-r7');
  fs.mkdirSync(repo);
  const ID = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
  const g = (args) => execFileSync('git', [...ID, ...args], { cwd: repo, encoding: 'utf8' }).trim();
  g(['init', '-q', '-b', 'main']);
  const write = (files) => { for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), text); } };
  const commit = (msg, files) => { write(files); g(['add', '-A']); g(['commit', '-q', '-m', msg]); return g(['rev-parse', 'HEAD']); };
  const pkg = (v) => `{\n  "name": "syn",\n  "version": "${v}",\n  "dependencies": {}\n}\n`;
  const lock = (v) => `{\n  "name": "syn",\n  "version": "${v}",\n  "packages": {\n    "": {\n      "name": "syn",\n      "version": "${v}"\n    }\n  }\n}\n`;
  const tst = (v, c, extra = '') => `const pkg = require('../package.json');\n// the artifact reports ${c}\nassert.equal(pkg.version, '${v}');\n${extra}`;
  commit('syn: start', { 'package.json': pkg('9.9.8'), 'package-lock.json': lock('9.9.8'), 'test/v.test.js': tst('9.9.8', '9.9.7'), 'CHANGELOG.md': '# 9.9.8\n- start\n' });
  const git = new DG.DerivedGit(repo);
  const release = commit('cut 9.9.9', { 'package.json': pkg('9.9.9'), 'package-lock.json': lock('9.9.9'), 'test/v.test.js': tst('9.9.9', '9.9.9'), 'CHANGELOG.md': '# 9.9.9\n- the cut\n\n# 9.9.8\n- start\n', 'README.md': 'badge 9.9.9\n' });
  assert.equal(await git.versionOnly(release), true, 'MUTANT R7-2: the release commit (versions in package, lock, a test and docs) is release-only');
  const code = commit('cut 9.9.10 plus a test change', { 'package.json': pkg('9.9.10'), 'package-lock.json': lock('9.9.10'), 'test/v.test.js': tst('9.9.10', '9.9.10').replace("require('../package.json')", "require('../package.json'), x = 1") });
  assert.equal(await git.versionOnly(code), false, 'MUTANT R7-2: one changed non-version line makes it code');
  const added = commit('a test line', { 'test/v.test.js': tst('9.9.10', '9.9.10', 'assert.ok(pkg.name);\n').replace("require('../package.json')", "require('../package.json'), x = 1") });
  assert.equal(await git.versionOnly(added), false, 'MUTANT R7-2: an added line alone is code');
  const bump = commit('cut 9.9.11', { 'package.json': pkg('9.9.11'), 'package-lock.json': lock('9.9.11'), 'test/v.test.js': tst('9.9.11', '9.9.11', 'assert.ok(pkg.name);\n').replace("require('../package.json')", "require('../package.json'), x = 1") });
  assert.equal(await git.versionOnly(bump), true, '9.9.10 to 9.9.11 masks as a whole token');
  const partial = commit('major 9.10', { 'test/v.test.js': tst('9.9.11', '9.9.11', 'assert.ok(pkg.name); // line 9.10\n').replace("require('../package.json')", "require('../package.json'), x = 1") });
  assert.equal(await git.versionOnly(partial), false, 'MUTANT R7-2: 9.9 alone is no version token');
  const docs = commit('docs only', { 'README.md': 'badge 9.9.11\nmore\n' });
  assert.equal(await git.versionOnly(docs), true, 'a docs-only commit is free');
  assert.equal(await git.versionOnly('0'.repeat(40)), null, 'an unknown commit: git cannot say');
  // The parser on a recorded diff: a doc file's free lines, a masked whole token, an added-only hunk, a binary.
  const diff = (file, hunk) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${hunk}`;
  assert.equal(DG.versionMaskedDiff(diff('src/a.ts', "-const v = '9.9.9';\n+const v = '9.9.10';\n")), true);
  assert.equal(DG.versionMaskedDiff(diff('src/a.ts', "-const v = '9.9';\n+const v = '9.10';\n")), false, 'MUTANT R7-2: a partial token');
  assert.equal(DG.versionMaskedDiff(diff('src/a.ts', "-const v = '1.9.9.9';\n+const v = '1.9.9.10';\n")), false, 'four parts are no N.N.N token');
  assert.equal(DG.versionMaskedDiff(diff('src/a.ts', "+const v = '9.9.9';\n")), false, 'MUTANT R7-2: an added line alone');
  assert.equal(DG.versionMaskedDiff(diff('docs/a.md', "+anything\n-and more\n")), true, 'MUTANT R7-2: a doc file is free');
  assert.equal(DG.versionMaskedDiff(`diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n`), false);
  assert.equal(DG.versionMaskedDiff(''), true, 'an empty diff changes nothing');
});

test('round 4b: the derived layer records a verdict per processed done mail; get reads it by mail id', async () => {
  const root = path.join(JAIL, 'hive-status');
  const done = await F.doneMailFacts([
    { id: 'st-1', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'landed', body: 'bbbbbb2', created_at: T0 },
    { id: 'st-2', act: 'done', from: 'builder', card: 'SYN-WL', subject: 'landed', body: 'aaaaaa1', created_at: '2026-10-19T10:00:00Z' },
    { id: 'st-3', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'b8b8b8b then cccccc3', created_at: T0 },
    { id: 'st-4', act: 'inform', from: 'x', subject: 'hello', body: 'bbbbbb2' },
  ], CARDS, git3);
  const statuses = S.doneMailStatuses([{ id: 'st-1' }, { id: 'st-2' }, { id: 'st-3' }, { id: 'st-4' }, { id: 7 }], done);
  assert.deepEqual(statuses, { 'st-1': 'fact', 'st-2': 'older', 'st-3': 'ambiguous', 'st-4': 'notDone' });
  S.writeDoneMailStatus(root, statuses);
  const read = S.readDoneMailStatus(root);
  assert.equal(read('st-3'), 'ambiguous'); assert.equal(read('st-1'), 'fact'); assert.equal(read('st-9'), null);
  assert.equal(read('hasOwnProperty'), null);
  S.writeDoneMailStatus(root, { 'st-3': 'fact', 'st-5': 'noCommit' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, S.DONE_MAIL_STATUS_FILE), 'utf8')), { 'st-1': 'fact', 'st-2': 'older', 'st-3': 'fact', 'st-4': 'notDone', 'st-5': 'noCommit' }, 'merged, later verdicts win');
  assert.equal(read('st-5'), 'noCommit', 're-read on change');
  assert.equal(S.readDoneMailStatus(path.join(JAIL, 'none'))('st-1'), null, 'no file: nothing reached');
  // Round 5 (god 5c9b37): the known verdicts only; a record over the size cap is treated as absent.
  for (const v of ['fact', 'older', 'notDone', 'noShaWord', 'noCommit', 'noCard', 'ambiguous', 'bodyOnly']) assert.ok(S.isDoneMailVerdict(v), v);
  for (const v of ['bogus', '', null, 7]) assert.ok(!S.isDoneMailVerdict(v), String(v));
  const big = path.join(JAIL, 'hive-big');
  fs.mkdirSync(path.join(big, 'state'), { recursive: true });
  fs.writeFileSync(path.join(big, S.DONE_MAIL_STATUS_FILE), JSON.stringify({ 'st-1': 'fact', pad: 'x'.repeat(S.DONE_MAIL_STATUS_MAX_BYTES) }));
  assert.equal(S.readDoneMailStatus(big)('st-1'), null, 'MUTANT no-cap: the oversized record is parsed');
  S.writeDoneMailStatus(big, { 'st-2': 'older' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(big, S.DONE_MAIL_STATUS_FILE), 'utf8')), { 'st-2': 'older' }, 'a write starts over from an oversized record');
});

test('round 3 C: a single inherited link counts only when the commit the row would carry names no different card', async () => {
  // The link says SYN-WL; the reported commit's subject names SYN-OTHER: nothing (never SYN-OTHER either).
  const other = await F.doneMailFacts([{ id: 'r3c-1', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: diagnosis', body: 'see cccccc3', created_at: T0 }], CARDS, git3);
  assert.deepEqual(other.facts, []);
  assert.deepEqual(other.skips, [{ mail: 'r3c-1', reason: 'ambiguous', cards: ['SYN-WL', 'SYN-OTHER'] }]);
  // A commit naming no card still counts with the link.
  const plain = await F.doneMailFacts([{ id: 'r3c-2', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'dddddd4', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(plain, 'card.syn-wl.donesha#auditor'), H('d'));
  // The card's own commit beside one naming no card: counts.
  const own = await F.doneMailFacts([{ id: 'r3c-3', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'bbbbbb2 then dddddd4', created_at: T0 }], CARDS, git3);
  assert.deepEqual(slots(own), ['card.syn-wl.donesha#auditor']);
  // Only the commit the row would carry is judged: the subject's @sha is the card's own commit, and the
  // base and history shas the body lists name another card (an int audit listing many shas).
  const listed = await F.doneMailFacts([{ id: 'r3c-8', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: audit @bbbbbb2', body: 'base cccccc3, history dddddd4, earlier aaaaaa1', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(listed, 'card.syn-wl.donesha#auditor'), H('b'), 'the listed shas naming other cards are not judged');
  // A refused link (the carried commit c, the latest in git order, names SYN-OTHER) still takes the git check,
  // and b's subject confirms the link card; but the row would carry c, which does not count for SYN-WL, so
  // round 5 (god bfcff1: no fallback to another listed sha) skips it (deliberately changed from round 4).
  const mixed = await F.doneMailFacts([{ id: 'r3c-4', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'bbbbbb2 beside cccccc3', created_at: T0 }], CARDS, git3);
  assert.deepEqual(mixed.facts, [], 'MUTANT fallback: the refused commit c (or b) becomes the value');
  assert.deepEqual(mixed.skips, [{ mail: 'r3c-4', reason: 'ambiguous', cards: ['SYN-WL', 'SYN-OTHER'] }]);
  // Refused and unconfirmed: the carried commit (c, the latest in git order: no ancestry, equal times, the larger
  // sha) names SYN-OTHER and no commit names SYN-WL.
  const refused = await F.doneMailFacts([{ id: 'r3c-9', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'b8b8b8b then cccccc3', created_at: T0 }], CARDS, git3);
  assert.deepEqual(refused.facts, []);
  assert.deepEqual(refused.skips, [{ mail: 'r3c-9', reason: 'ambiguous', cards: ['SYN-WL', 'SYN-OTHER'] }]);
  // The same shas with the card's own commit as the subject's @sha: the carried commit is judged, not the list.
  const carried = await F.doneMailFacts([{ id: 'r3c-10', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep @b8b8b8b', body: 'after cccccc3', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(carried, 'card.syn-wl.donesha#auditor'), R3.n);
  // Through a merge: the link with the int merge of another card's branch resolves to that card's commit, which
  // (B) drops for the link card before (C) judges it: no commit is left (round 3 pinned ambiguous here).
  const merge = await F.doneMailFacts([{ id: 'r3c-5', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: int cut', body: 'd4d4d4d', created_at: T0 }], CARDS, git3);
  assert.deepEqual(merge.facts, []);
  assert.deepEqual(merge.skips, [{ mail: 'r3c-5', reason: 'noCommit', cards: ['SYN-WL'] }]);
  // A docs-only commit is not carried for a feature card (round 6, R6-2; deliberately changed from round 3's
  // ambiguous [SYN-OTHER, SYN-WL]): the link holds, but no commit is left for the row.
  const docs = await F.doneMailFacts([{ id: 'r3c-6', act: 'done', from: 'auditor', cards: ['SYN-OTHER'], subject: 'Re: row', body: 'a1a1a1a', created_at: T0 }], CARDS, git3);
  assert.deepEqual(docs.skips, [{ mail: 'r3c-6', reason: 'noCommit', cards: ['SYN-OTHER'] }]);
  // A card FIELD is not a link: it reports another card's commit as before.
  const field = await F.doneMailFacts([{ id: 'r3c-7', act: 'done', from: 'auditor', card: 'SYN-WL', subject: 'Re: diagnosis', body: 'see cccccc3', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(field, 'card.syn-wl.donesha#auditor'), H('c'));
});
