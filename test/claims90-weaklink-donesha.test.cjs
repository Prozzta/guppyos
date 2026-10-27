'use strict';
/**
 * CLAIMS-WEAKLINK-DONESHA (god e2f85a; mechanism from Jim's R4): memory get's derived done-sha for a card
 * must reflect the latest done mail that reports a sha for that card itself, including when that mail
 * links to the card only by a body mention. The rule, the same for every mail: a done mail with no card
 * field, no inherited (reply/conversation) card and no card in its subject falls back to the cards its
 * body names, and one of them counts only when the messages of the commits the mail reports name exactly
 * that one. A passing mention (a done mail about another card: its own field, link or subject names the
 * other card) never promotes; with no link at all, an unconfirmed body mention gives nothing (bodyOnly).
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
const { mailBodyHash } = loadTs('src/main/mailLedger.ts');

const H = (c) => c.repeat(40);
/** A git port over a fixed map: short sha -> full commit, full commit -> message. No ancestry, no times. */
function fakeGit(commits, messages) {
  return {
    async commitOf(s) { return commits[s] ?? null; },
    async isAncestor() { return false; },
    async time() { return 0; },
    async message(c) { return messages[c] ?? null; },
  };
}
const CARDS = ['SYN-WL', 'SYN-OTHER', 'SYN-THIRD', 'SYN-PIN'];
// Commits: a and b are SYN-WL's own (their messages name the card); c is SYN-OTHER's; d names no card.
const git = fakeGit(
  { aaaaaa1: H('a'), bbbbbb2: H('b'), cccccc3: H('c'), dddddd4: H('d') },
  { [H('a')]: 'SYN-WL step 3: serve the current value', [H('b')]: 'SYN-WL: fold the delta-audit nits', [H('c')]: 'SYN-OTHER: the other card', [H('d')]: 'housekeeping' },
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
