'use strict';
require('./tools/own-job.cjs');

/**
 * MAILCARD-CATCHUP-RACE (god 0a79ca, 1.1.103): the startup mail-card catch-up raced live forward-link
 * decisions. A reply routed while the catch-up was still reading the hive could not find a parent the
 * catch-up had not reached yet (no index row, no MailLedger entry): it was bounced, or recorded
 * `none`. Now, while a catch-up runs, the router holds every live index record in arrival order and
 * records it once the catch-up settled (src/main/mailCards.ts MailCardIndex.defer / endCatchUp); a
 * reply whose chain reaches an unknown parent is delivered as written (no card set, never bounced)
 * and linked then, against the caught-up index. Append-only: nothing recorded is rewritten.
 * Twins (synthetic floor):
 *  - a reply that arrives mid-catch-up is linked once (reply, delivery trust), not bounced;
 *  - the order is preserved: the old mail the catch-up records, then the live mail as it arrived;
 *  - no duplicate rows or links (the catch-up skips held ids; a second start records nothing);
 *  - outside a catch-up nothing changed (the same reply bounces); its own card field settles a
 *    mid-catch-up mail at delivery; a failed catch-up still records the held mail;
 *  - replyChainGap pins.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const MC = loadTs('src/main/mailCards.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const T = '2026-10-29T05:00:00.000Z';
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

/**
 * A floor upgraded from before the index: o1, a two-party CARD-ONE mail from pam-1 to jim-1 (pam's
 * .sent copy + jim's inbox/.done, no MailLedger entry), so only the catch-up can give its card.
 */
async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mailcard-race-'));
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const hive = new HiveManager(() => home);
  t.after(() => {
    hive.dispose();
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  for (const id of ['CARD-ONE', 'CARD-TWO']) assert.equal(hive.addTask({ id, title: id, status: 'todo', priority: 'normal', deps: [], humanQA: [] }), true);
  const root = hive.root();
  const o1 = { id: '2026-10-01T00-00-00-000Z-0a0a01', from: 'pam-1', to: 'jim-1', act: 'request', subject: 'build CARD-ONE', body: 'please', card: 'CARD-ONE', conversation: 'c-old', created_at: '2026-10-01T00:00:00Z' };
  writeJson(path.join(root, 'agents', 'jim-1', 'inbox', '.done', `${o1.id}.json`), o1);
  writeJson(path.join(root, 'agents', 'pam-1', 'outbox', '.sent', `out-${o1.id}.json`), { to: o1.to, act: o1.act, subject: o1.subject, body: o1.body });
  const dir = path.join(root, 'state', 'mail-cards');
  const rows = [];
  /** A catch-up held at its first pause until release() (then it runs to its end). */
  const catchUp = () => {
    let open = null;
    let held = true;
    const gate = new Promise((r) => { open = r; });
    const promise = MC.startupMailCardCatchUp(root, { log: (r) => rows.push(r), index: hive.mailCardIndexFor(root), now: () => T, pause: () => (held ? gate : Promise.resolve()) });
    return { promise, release: () => { held = false; open(); return promise; } };
  };
  return { hive, root, o1, dir, rows, catchUp, links: () => readLines(path.join(dir, '_links.jsonl')), cardRows: (c) => readLines(path.join(dir, `${c}.jsonl`)) };
}
const bounced = (hive, agent) => hive.inbox(agent).filter((m) => /^\[card required\]/.test(m.subject));

test('race-a: a reply that arrives mid-catch-up is delivered, not bounced, and linked once to its parent\'s card', async (t) => {
  const F = await floor(t);
  const c = F.catchUp();
  assert.equal(F.hive.mailCardIndexFor(F.root).catchingUp, true, 'the catch-up is open');
  const r = F.hive.send({ to: 'pam-1', act: 'done', subject: 'built it', body: 'abc1234', in_reply_to: F.o1.id }, 'jim-1');
  assert.deepEqual(bounced(F.hive, 'jim-1'), [], 'MUTANT: the mid-catch-up reply was bounced (its parent is not indexed yet)');
  const got = F.hive.inbox('pam-1').find((m) => m.id === r.id);
  assert.ok(got, 'delivered');
  assert.equal(got.card, undefined, 'delivered as written: no card is guessed before the catch-up settles');
  assert.deepEqual(F.links().filter((l) => l.mailId === r.id), [], 'nothing is recorded while the catch-up runs');
  F.hive.mail.flushAll();   // the ledger's debounced write lands mid-catch-up, so the catch-up reads the live mail too
  const counts = await c.release();
  assert.equal(counts.deferred, 1, `the catch-up skips the held live mail: ${JSON.stringify(counts)}`);
  const mine = F.links().filter((l) => l.mailId === r.id);
  assert.deepEqual(mine.map((l) => [l.method, l.cards, l.trust]), [['reply', ['CARD-ONE'], 'delivery']], 'MUTANT: linked once, by the reply rule, as the router saw it');
  assert.deepEqual(F.cardRows('card-one').filter((x) => x.id === r.id).map((x) => [x.to, x.cardFrom, x.trust]), [['pam-1', 'reply', 'delivery']]);
  const held = F.rows.filter((x) => x.kind === MC.MAILCARDS_DEFERRED_ROW);
  assert.deepEqual(held.map((x) => [x.queued, x.recorded, x.failed]), [[1, 1, 0]], 'one mailcards-deferred row');
  assert.equal(F.hive.mailCardIndexFor(F.root).catchingUp, false, 'settled');
});

test('race-b: the order is preserved: old mail first (catch-up), then the live mail as it arrived', async (t) => {
  const F = await floor(t);
  const c = F.catchUp();
  const a = F.hive.send({ to: 'pam-1', act: 'inform', subject: 'starting', body: 'b', card: 'CARD-ONE' }, 'jim-1');
  assert.equal(F.hive.inbox('pam-1').find((m) => m.id === a.id).card, 'CARD-ONE', 'its own card field settles it at delivery');
  const b = F.hive.send({ to: 'pam-1', act: 'done', subject: 'built it', body: 'abc1234', in_reply_to: F.o1.id }, 'jim-1');
  const g = F.hive.send({ to: 'jim-1', act: 'inform', subject: 'thanks', body: 'ok', in_reply_to: b.id }, 'pam-1');
  assert.deepEqual([...bounced(F.hive, 'jim-1'), ...bounced(F.hive, 'pam-1')], [], 'a reply to a held reply is held too, not bounced');
  await c.release();
  assert.deepEqual(F.links().map((l) => [l.mailId, l.method]), [[F.o1.id, 'field'], [a.id, 'field'], [b.id, 'reply'], [g.id, 'reply']], 'MUTANT: the live records were written before the old mail, or out of arrival order');
  assert.deepEqual(F.cardRows('card-one').map((x) => x.id), [F.o1.id, a.id, b.id, g.id]);
});

test('race-c: no duplicate rows or links; a second start records nothing', async (t) => {
  const F = await floor(t);
  const c = F.catchUp();
  const b = F.hive.send({ to: 'pam-1', act: 'done', subject: 'built it', body: 'abc1234', in_reply_to: F.o1.id }, 'jim-1');
  F.hive.mail.flushAll();
  await c.release();
  const second = await MC.startupMailCardCatchUp(F.root, { log: () => {}, index: F.hive.mailCardIndexFor(F.root), now: () => T, pause: () => Promise.resolve() });
  assert.equal(second.recorded, 0, `a second start records nothing: ${JSON.stringify(second)}`);
  const ids = F.links().map((l) => l.mailId);
  assert.deepEqual(ids, [...new Set(ids)], 'MUTANT: a message id has two link records');
  const keys = F.cardRows('card-one').map((x) => `${x.id}/${x.to}`);
  assert.deepEqual(keys, [...new Set(keys)], 'MUTANT: a delivered copy has two rows');
  assert.ok(ids.includes(b.id));
  // a fresh index over the same files (the next app start) sees the same: nothing re-appended
  const fresh = MC.backfillMailCards(F.root, T);
  assert.equal(fresh.recorded, 0);
});

test('race-d: outside a catch-up nothing changed; a failed catch-up still records the held mail', async (t) => {
  const F = await floor(t);
  F.hive.send({ to: 'pam-1', act: 'done', subject: 'built it', body: 'abc1234', in_reply_to: F.o1.id }, 'jim-1');
  assert.equal(bounced(F.hive, 'jim-1').length, 1, 'with no catch-up open, a reply to an unknown parent bounces as before');
  // a mid-catch-up mail that names no card and replies to nothing is judged at once (bounced)
  const G = await floor(t);
  const c = G.catchUp();
  G.hive.send({ to: 'pam-1', act: 'inform', subject: 'hello', body: 'no card here' }, 'jim-1');
  assert.equal(bounced(G.hive, 'jim-1').length, 1, 'MUTANT: every mid-catch-up mail was held (only a reply with an unknown parent waits)');
  await c.release();
  // a failed catch-up: the held mail is still recorded at settle
  const H = await floor(t);
  const index = H.hive.mailCardIndexFor(H.root);
  const h = H.catchUp();
  const r = H.hive.send({ to: 'pam-1', act: 'done', subject: 'built it', body: 'abc1234', in_reply_to: H.o1.id }, 'jim-1');
  const real = index.linkOf.bind(index);
  index.linkOf = () => { index.linkOf = real; throw new Error('disk full'); };   // the catch-up's first index read fails
  assert.equal(await h.release(), null, 'the catch-up failed');
  assert.match(H.rows.find((x) => x.kind === MC.MAILCARDS_BACKFILL_FAILED_ROW)?.error ?? '', /disk full/);
  assert.deepEqual(H.rows.filter((x) => x.kind === MC.MAILCARDS_DEFERRED_ROW).map((x) => [x.queued, x.recorded, x.failed]), [[1, 1, 0]], 'MUTANT: a failed catch-up dropped the held mail');
  assert.deepEqual(H.links().filter((l) => l.mailId === r.id).map((l) => l.method), ['none'], 'its parent never got indexed, so it is recorded unlinked (append-only; no bounce after delivery)');
  assert.equal(index.catchingUp, false);
});

test('race-e: replyChainGap and the index hooks', () => {
  const known = { p1: { cards: ['CARD-ONE'], method: 'field' }, p2: { cards: [], method: 'none', in_reply_to: 'gone' }, p3: { cards: ['A-1', 'B-2'], method: 'mention-subject' }, p4: { cards: [], method: 'none', in_reply_to: 'p1' } };
  const ctx = { linkOf: (id) => known[id] ?? null };
  assert.equal(MC.replyChainGap({ id: 'm' }, ctx), false, 'not a reply');
  assert.equal(MC.replyChainGap({ id: 'm', in_reply_to: 'gone' }, ctx), true, 'an unknown parent');
  assert.equal(MC.replyChainGap({ id: 'm', in_reply_to: 'p1' }, ctx), false, 'a carded parent settles it');
  assert.equal(MC.replyChainGap({ id: 'm', in_reply_to: 'p2' }, ctx), true, 'an unknown grandparent');
  assert.equal(MC.replyChainGap({ id: 'm', in_reply_to: 'p3' }, ctx), false, 'a several-card parent stops the chain');
  assert.equal(MC.replyChainGap({ id: 'm', in_reply_to: 'p4' }, ctx), false, 'a carded grandparent settles it');
  // nested catch-ups: only the last settle records; an id is held once
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mailcard-race-idx-'));
  try {
    const idx = new MC.MailCardIndex(root);
    idx.beginCatchUp(); idx.beginCatchUp();
    const id = '2026-10-29T00-00-00-000Z-0b0b01';
    const e = () => MC.indexEntries({ id, from: 'jim-1', act: 'inform', subject: 's', body: 'b' }, { cards: ['CARD-ONE'], method: 'field' }, 'delivery', [{ to: 'pam-1' }], T);
    idx.defer(id, e); idx.defer(id, e);
    assert.equal(idx.isDeferred(id), true);
    assert.deepEqual(idx.endCatchUp(), { queued: 0, recorded: 0, failed: 0 }, 'one catch-up still open');
    assert.equal(idx.has(id), false);
    assert.deepEqual(idx.endCatchUp(), { queued: 1, recorded: 1, failed: 0 }, 'held once, recorded once');
    assert.equal(idx.isDeferred(id), false);
    assert.equal(readLines(path.join(root, 'state', 'mail-cards', 'card-one.jsonl')).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
