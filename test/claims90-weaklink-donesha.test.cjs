'use strict';
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
    async time() { return 0; },
    async message(c) { return messages[c] ?? null; },
    ...(extra.parents ? { async parents(c) { return extra.parents[c] ?? []; } } : {}),
    ...(extra.files ? { async changedFiles(c) { return extra.files[c] ?? null; } } : {}),
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
  // A body mention that is a spelling variant (a space for the dash) is no candidate at all.
  const variant = await F.doneMailFacts([{ id: 'v-1', act: 'done', from: 'auditor', subject: 'Re: delta audit', body: 'PASS at bbbbbb2 (syn wl)' }], CARDS, git);
  assert.deepEqual(variant.skips, [{ mail: 'v-1', reason: 'noCard' }]);
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
  // Only confirmation is withheld: a mail whose card FIELD is the card still reports the docs commit.
  const field = await F.doneMailFacts([{ id: 'r3a-6', act: 'done', from: 'cutter', card: 'SYN-WL', subject: 'row added', body: 'a1a1a1a', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(field, 'card.syn-wl.donesha#cutter'), R3.g);
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
  assert.deepEqual(await F.resolveReported(R3.i, git3), [{ commit: R3.i, text: 'guppy/int-9.1', docsOnly: false, into: 'guppy/int-9.1' }, { commit: H('b'), text: 'SYN-WL: fold the delta-audit nits guppy/syn-wl', merge: R3.i, chain: [R3.i], docsOnly: false }]);
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
  // A refused link (the carried commit c names SYN-OTHER) still takes the git check: b's subject names
  // the link card, so the row stands (its value is the carried commit).
  const mixed = await F.doneMailFacts([{ id: 'r3c-4', act: 'done', from: 'auditor', cards: ['SYN-WL'], subject: 'Re: sweep', body: 'bbbbbb2 beside cccccc3', created_at: T0 }], CARDS, git3);
  assert.deepEqual(slots(mixed), ['card.syn-wl.donesha#auditor'], 'refused link, confirmed by git');
  assert.deepEqual(mixed.skips, []);
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
  // A docs-only commit naming another card is still a commit naming another card.
  const docs = await F.doneMailFacts([{ id: 'r3c-6', act: 'done', from: 'auditor', cards: ['SYN-OTHER'], subject: 'Re: row', body: 'a1a1a1a', created_at: T0 }], CARDS, git3);
  assert.deepEqual(docs.skips, [{ mail: 'r3c-6', reason: 'ambiguous', cards: ['SYN-OTHER', 'SYN-WL'] }]);
  // A card FIELD is not a link: it reports another card's commit as before.
  const field = await F.doneMailFacts([{ id: 'r3c-7', act: 'done', from: 'auditor', card: 'SYN-WL', subject: 'Re: diagnosis', body: 'see cccccc3', created_at: T0 }], CARDS, git3);
  assert.equal(commitOf(field, 'card.syn-wl.donesha#auditor'), H('c'));
});
