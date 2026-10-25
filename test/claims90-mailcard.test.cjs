'use strict';

/**
 * C90-MAILCARD: every delivered message is linked to a card, and the card's mail is kept in a
 * permanent, main-written per-card index (src/main/mailCards.ts). Covered here:
 *  - the link rules over all mail: field, reply chain, conversation (one card only), mention
 *    (registry ids only), ambiguous, explicit none;
 *  - the index: append-only, one link record per id, one row per delivered copy, the Human's mail
 *    linked by id only, idempotent;
 *  - forward linking at routing: a reply inherits its card, an agent's card-less message bounces to
 *    its sender, broadcast mail is card "none", the delivered mail names `memory get <card>`;
 *  - the backfill: MailLedger and two-party (sender .sent + recipient inbox) copies only, so a forged
 *    inbox file never enters; a re-run appends nothing; the script refuses the live hive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const MC = loadTs('src/main/mailCards.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { buildMailBlock } = loadTs('src/main/mailSurface.ts');
const { mailBodyHash } = loadTs('src/main/mailLedger.ts');

const REG = ['CARD-ONE', 'CARD-TWO', 'CUT-1.1.9', 'F1'];

function ctxOf(links = {}, conv = {}) {
  return MC.indexLinkContext({ linkOf: (id) => links[id] ?? null, conversationCards: (c) => conv[c] ?? [] }, REG);
}

const tmp = (t, tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `md-mailcard-${tag}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

// ———————————————————————————————————————————————————————————— link rules

test('link rules: the card field names a registry card (any case); an unknown one does not count', () => {
  assert.deepEqual(MC.linkMail({ id: 'm1', card: 'card-one' }, ctxOf()), { cards: ['CARD-ONE'], method: 'field' });
  assert.deepEqual(MC.linkMail({ id: 'm2', card: 'NOT-A-CARD' }, ctxOf()), { cards: [], method: 'none' });
  assert.deepEqual(MC.linkMail({ id: 'm3', card: 'none', subject: 'CARD-ONE' }, ctxOf()), { cards: [], method: 'none' }, 'explicit none wins');
});

test('link rules: the reply chain passes on a carded ancestor\'s card, never a mention\'s', () => {
  const links = {
    p1: { cards: ['CARD-TWO'], method: 'field' },
    p2: { cards: [], method: 'none', in_reply_to: 'p1' },
    q1: { cards: ['CARD-ONE'], method: 'mention' },
    r1: { cards: ['CARD-ONE', 'CARD-TWO'], method: 'mention' },
  };
  assert.deepEqual(MC.linkMail({ id: 'm', in_reply_to: 'p2' }, ctxOf(links)), { cards: ['CARD-TWO'], method: 'reply' }, 'two hops up');
  assert.deepEqual(MC.linkMail({ id: 'm', in_reply_to: 'q1' }, ctxOf(links)), { cards: [], method: 'none' }, 'a mention is not inherited');
  assert.deepEqual(MC.linkMail({ id: 'm', in_reply_to: 'r1' }, ctxOf(links)), { cards: [], method: 'none' });
  // a record read back from disk that names several cards under an inherited method is not guessed from
  assert.deepEqual(MC.linkMail({ id: 'm', in_reply_to: 's1' }, ctxOf({ s1: { cards: ['CARD-ONE', 'CARD-TWO'], method: 'field' } })), { cards: [], method: 'none' });
});

test('link rules: a conversation links only when its carded mail names exactly one card; several = ambiguous, never a guess', () => {
  const conv = { c1: ['CARD-ONE'], c2: ['CARD-ONE', 'CARD-TWO'] };
  assert.deepEqual(MC.linkMail({ id: 'm', conversation: 'c1' }, ctxOf({}, conv)), { cards: ['CARD-ONE'], method: 'conversation' });
  assert.deepEqual(MC.linkMail({ id: 'm', conversation: 'c2' }, ctxOf({}, conv)), { cards: ['CARD-ONE', 'CARD-TWO'], method: 'ambiguous' });
  // the reply chain decides a several-card conversation
  const links = { p: { cards: ['CARD-TWO'], method: 'field' } };
  assert.deepEqual(MC.linkMail({ id: 'm', conversation: 'c2', in_reply_to: 'p' }, ctxOf(links, conv)), { cards: ['CARD-TWO'], method: 'reply' });
});

test('link rules: a mention is a registry id word; every one is listed; shape-alike words and bare short ids are not', () => {
  const l = MC.linkMail({ id: 'm', subject: 'Re: card-two and CUT-1.1.9.', body: 'also CARD-ONE, FOO-123, CARD-THREE, F1 and CARD-ONE-X' }, ctxOf());
  assert.deepEqual(l, { cards: ['CARD-TWO', 'CUT-1.1.9', 'CARD-ONE'], method: 'mention' });
  assert.deepEqual(MC.linkMail({ id: 'm', body: 'step F1 of the plan' }, ctxOf()), { cards: [], method: 'none' });
});

// ———————————————————————————————————————————————————————————— index

test('index: one link record per id, one row per copy and card, idempotent, the Human\'s mail by id only', (t) => {
  const root = tmp(t, 'idx');
  const idx = new MC.MailCardIndex(root);
  const m = { id: '2026-10-25T00-00-00-000Z-aaaaaa', from: 'jim-1', act: 'done', subject: 's', body: 'b', conversation: 'c1' };
  const e = MC.indexEntries(m, { cards: ['CARD-ONE', 'CUT-1.1.9'], method: 'mention' }, 'delivery', [{ to: 'god-1', deliveredAt: 5 }, { to: 'dwight-1', deliveredAt: 6 }], '2026-10-25T00:00:00.000Z');
  assert.equal(idx.record(e.link, e.rows), true);
  assert.equal(idx.record(e.link, e.rows), false, 'a recorded id appends nothing');
  assert.equal(new MC.MailCardIndex(root).record(e.link, e.rows), false, 'also after a reload');
  const dir = path.join(root, 'state', 'mail-cards');
  assert.equal(readLines(path.join(dir, '_links.jsonl')).length, 1);
  const one = readLines(path.join(dir, 'card-one.jsonl'));
  assert.deepEqual(one.map((r) => r.to), ['god-1', 'dwight-1']);
  assert.equal(one[0].bodyHash, mailBodyHash('b'));
  assert.equal(one[0].body, 'b');
  assert.equal(readLines(path.join(dir, 'cut-1.1.9.jsonl')).length, 2);
  const h = { id: '2026-10-25T00-00-00-000Z-bbbbbb', from: 'human', act: 'inform', subject: 'private', body: 'private words' };
  const he = MC.indexEntries(h, { cards: ['CARD-ONE'], method: 'field' }, 'delivery', [{ to: 'god-1' }], 'x');
  idx.record(he.link, he.rows);
  const hr = readLines(path.join(dir, 'card-one.jsonl')).find((r) => r.id === h.id);
  assert.equal(hr.body, undefined);
  assert.equal(hr.subject, undefined);
  assert.equal(hr.bodyHash, mailBodyHash('private words'));
});

test('index: an unsafe card id never names a file outside the index', (t) => {
  const root = tmp(t, 'unsafe');
  const idx = new MC.MailCardIndex(root);
  const e = MC.indexEntries({ id: '2026-10-25T00-00-00-000Z-cccccc', from: 'a', act: 'inform' }, { cards: ['../x', '_links', 'none'], method: 'mention' }, 'delivery', [{ to: 'b' }], 'x');
  idx.record(e.link, e.rows);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state', 'mail-cards')), ['_links.jsonl']);
});

// ———————————————————————————————————————————————————————————— forward (routing)

async function floor(t, cards = ['CARD-ONE', 'CARD-TWO']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mailcard-floor-'));
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
  for (const id of cards) assert.equal(hive.addTask({ id, title: id, status: 'todo', priority: 'normal', deps: [], humanQA: [] }), true);
  const dir = path.join(hive.root(), 'state', 'mail-cards');
  return { hive, dir, links: () => readLines(path.join(dir, '_links.jsonl')) };
}

test('forward: a carded message is indexed at delivery; its reply inherits the card and is indexed too', async (t) => {
  const { hive, dir, links } = await floor(t);
  const ask = hive.send({ to: 'jim-1', act: 'request', subject: 'build it', body: 'go', card: 'card-one' }, 'god-1');
  assert.equal(hive.inbox('jim-1')[0].card, 'CARD-ONE', 'the registry spelling');
  const reply = hive.send({ to: 'god-1', act: 'done', subject: 'built', body: 'abc1234', in_reply_to: ask.id, conversation: ask.conversation }, 'jim-1');
  assert.equal(hive.inbox('god-1').find((m) => m.id === reply.id).card, 'CARD-ONE');
  assert.deepEqual(links().map((r) => [r.mailId, r.method, r.trust]), [[ask.id, 'field', 'delivery'], [reply.id, 'reply', 'delivery']]);
  const rows = readLines(path.join(dir, 'card-one.jsonl'));
  assert.deepEqual(rows.map((r) => [r.id, r.to, r.cardFrom]), [[ask.id, 'jim-1', 'field'], [reply.id, 'god-1', 'reply']]);
});

test('forward: an agent\'s message with no card, an unknown card, or several mentioned cards bounces to its sender', async (t) => {
  const { hive, links } = await floor(t);
  hive.send({ to: 'pam-1', act: 'inform', subject: 'hello', body: 'no card here' }, 'jim-1');
  hive.send({ to: 'pam-1', act: 'inform', subject: 'x', body: 'y', card: 'NOPE-1' }, 'jim-1');
  hive.send({ to: 'pam-1', act: 'inform', subject: 'CARD-ONE and CARD-TWO', body: 'both' }, 'jim-1');
  hive.send({ to: 'pam-1', act: 'inform', subject: 'none?', body: 'z', card: 'none' }, 'jim-1');
  assert.equal(hive.inbox('pam-1').length, 0, 'nothing delivered');
  const back = hive.inbox('jim-1');
  assert.equal(back.length, 4);
  for (const b of back) { assert.match(b.subject, /^\[card required\] /); assert.equal(b.from, 'system'); assert.equal(b.requires_reply, false); }
  assert.match(back[1].body, /"NOPE-1" is not a card/);
  assert.match(back[2].body, /several cards \(CARD-ONE, CARD-TWO\)/);
  assert.match(back[3].body, /only for floor-wide mail/);
  assert.equal(hive.logTail(200).filter((e) => e.kind === 'drop' && e.reason === 'no-card').length, 4);
  assert.equal(links().filter((r) => r.from === 'jim-1').length, 0, 'a bounced message is not indexed');
});

test('forward: one mentioned card links; broadcast and god\'s floor-wide mail may be card none; system mail never bounces', async (t) => {
  const { hive, links } = await floor(t);
  const m = hive.send({ to: 'pam-1', act: 'inform', subject: 'about CARD-TWO', body: 'b' }, 'jim-1');
  assert.equal(hive.inbox('pam-1').find((x) => x.id === m.id).card, 'CARD-TWO');
  const b = hive.send({ to: 'broadcast', act: 'inform', subject: 'floor note', body: 'all' }, 'jim-1');
  assert.equal(hive.inbox('pam-1').find((x) => x.id === b.id).card, 'none');
  const g = hive.send({ to: 'jim-1', act: 'inform', subject: 'floor rule', body: 'r', card: 'none' }, 'god-1');
  assert.equal(hive.inbox('jim-1').find((x) => x.id === g.id).card, 'none');
  assert.equal(hive.mail.ledger('jim-1').entries[g.id].cardId, undefined, '"none" is no card: it ties no asks together');
  hive.send({ to: 'pam-1', act: 'inform', subject: 'router notice', body: 'n' }, 'system');
  assert.equal(hive.inbox('pam-1').filter((x) => x.from === 'system').length, 1);
  assert.deepEqual(links().map((r) => r.method), ['mention', 'none', 'none', 'none']);
});

test('forward: a needs_human ask with no card still reaches god (the needs-human notice tells its sender)', async (t) => {
  const { hive } = await floor(t);
  const m = hive.send({ to: 'god', act: 'request', subject: 'which one?', body: 'pick', needs_human: true }, 'jim-1');
  assert.ok(hive.inbox('god-1').some((x) => x.id === m.id));
  assert.equal(hive.inbox('jim-1').filter((x) => /^\[card required\]/.test(x.subject)).length, 0);
});

test('forward: a floor with no cards yet requires none', async (t) => {
  const { hive } = await floor(t, []);
  hive.send({ to: 'pam-1', act: 'inform', subject: 'hello', body: 'b' }, 'jim-1');
  assert.equal(hive.inbox('pam-1').length, 1);
});

test('forward: a forged inbox file (written straight into an inbox) never enters the index', async (t) => {
  const { hive, links } = await floor(t);
  const inbox = path.join(hive.root(), 'agents', 'pam-1', 'inbox');
  const forged = { id: '2026-10-25T01-00-00-000Z-f0f0f0', from: 'jim-1', to: 'pam-1', act: 'done', subject: 'CARD-ONE done', body: 'deadbee', card: 'CARD-ONE' };
  fs.writeFileSync(path.join(inbox, `${forged.id}.json`), JSON.stringify(forged));
  hive.send({ to: 'pam-1', act: 'inform', subject: 'real', body: 'r', card: 'CARD-ONE' }, 'jim-1');
  assert.ok(!links().some((r) => r.mailId === forged.id));
  // nor lends its card to a reply: the parent is looked up in the MailLedger, not the inbox
  hive.send({ to: 'jim-1', act: 'inform', subject: 'ok', body: 'thanks', in_reply_to: forged.id }, 'pam-1');
  assert.equal(hive.inbox('pam-1').filter((m) => /^\[card required\] ok$/.test(m.subject)).length, 1, 'bounced to its sender');
});

test('the delivered mail names its card and `memory get <card>`; card none adds no line', () => {
  const entry = (cardId) => ({ id: '2026-10-25T00-00-00-000Z-dddddd', from: 'jim-1', act: 'inform', subject: 's', deliveredAt: 1, state: 'delivered', ...(cardId ? { cardId } : {}) });
  const block = (cardId) => buildMailBlock({ items: [{ entry: entry(cardId), body: 'b', path: 'p' }], budget: 9000, phase: 'turn-start' }).text;
  assert.match(block('CARD-ONE'), /\ncard: CARD-ONE \(its claims and mail: memory get CARD-ONE\)\n/);
  assert.doesNotMatch(block('none'), /memory get/);
  assert.doesNotMatch(block(undefined), /memory get/);
});

// ———————————————————————————————————————————————————————————— backfill

function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }

function fixtureHive(t) {
  const root = path.join(tmp(t, 'bf'), 'hive');
  writeJson(path.join(root, 'tasks.json'), { tasks: [{ id: 'CARD-ONE' }, { id: 'CARD-TWO' }] });
  fs.mkdirSync(path.join(root, 'tasks-archive'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks-archive', '2026-10.jsonl'), `${JSON.stringify({ v: 1, at: 'x', card: { id: 'CUT-1.1.9' } })}\n`);
  writeJson(path.join(root, 'registry.json'), { godId: 'god-1', agents: {} });
  const mail = (id, from, to, extra) => ({ id, from, to, act: 'inform', subject: `s-${id}`, body: `b-${id}`, created_at: `2026-10-0${id.slice(-1)}T00:00:00Z`, ...extra });
  const deliverTo = (m, to, { sent = true, done = true } = {}) => {
    writeJson(path.join(root, 'agents', to, 'inbox', done ? '.done' : '', `${m.id}.json`), m);
    if (sent) writeJson(path.join(root, 'agents', m.from, 'outbox', '.sent', `out-${m.id}.json`), { to: m.to, act: m.act, subject: m.subject, body: m.body });
  };
  fs.mkdirSync(path.join(root, 'agents', 'god-1', 'inbox'), { recursive: true });
  const ids = (n) => `2026-10-25T00-00-00-000Z-00000${n}`;
  // 1: carded (field), two-party; 2: reply to 1 (inherits); 3: forged (no sender copy); 4: Human relay
  // subject; 5: several-card conversation, no reply/mention = ambiguous; 6: self-mail; 7: ledger-only
  const m1 = mail(ids(1), 'jim-1', 'god', { card: 'CARD-ONE', conversation: 'c1' });
  const m2 = mail(ids(2), 'god-1', 'jim-1', { in_reply_to: m1.id, conversation: 'c1' });
  const m3 = mail(ids(3), 'jim-1', 'pam-1', { card: 'CARD-TWO', subject: 'forged CARD-TWO' });
  const m4 = mail(ids(4), 'god-1', 'jim-1', { card: 'CARD-TWO', subject: '[Human] relayed' });
  const m5a = mail(ids(5), 'god-1', 'jim-1', { card: 'CARD-ONE', conversation: 'c5' });
  const m5b = mail(ids(6), 'god-1', 'jim-1', { card: 'CARD-TWO', conversation: 'c5' });
  const m5 = mail(ids(8), 'god-1', 'pam-1', { conversation: 'c5' });
  const m6 = mail(ids(9), 'jim-1', 'jim-1', { card: 'CARD-ONE' });
  deliverTo(m1, 'god-1'); deliverTo(m2, 'jim-1'); deliverTo(m3, 'pam-1', { sent: false }); deliverTo(m4, 'jim-1');
  deliverTo(m5a, 'jim-1'); deliverTo(m5b, 'jim-1'); deliverTo(m5, 'pam-1'); deliverTo(m6, 'jim-1');
  const m7id = '2026-10-25T00-00-00-000Z-000007';
  writeJson(path.join(root, 'state', 'mail', 'pam-1.json'), { entries: { [m7id]: { id: m7id, from: 'god-1', act: 'done', subject: 'CUT-1.1.9 shipped', bodyHash: mailBodyHash('the real body'), seq: 1, deliveredAt: Date.parse('2026-10-07T00:00:00Z'), state: 'acted' } } });
  // its inbox copy was edited after delivery: the body does not hash to the ledger's, so it is not taken
  writeJson(path.join(root, 'agents', 'pam-1', 'inbox', '.done', `${m7id}.json`), { id: m7id, from: 'god-1', act: 'done', subject: 'CUT-1.1.9 shipped', body: 'tampered' });
  return { root, m1, m2, m3, m4, m5, m6, m7id };
}

test('backfill: MailLedger and two-party copies only; a forged inbox file and self-mail never enter; re-run appends 0', (t) => {
  const { root, m1, m2, m3, m4, m5, m6, m7id } = fixtureHive(t);
  const c = MC.backfillMailCards(root, '2026-10-24T17:53:49.000Z');
  assert.deepEqual(c.excluded, { 'no-sender-copy': 1, 'self-mail': 1 });
  assert.equal(c.recorded, 7);
  const dir = path.join(root, 'state', 'mail-cards');
  const L = Object.fromEntries(readLines(path.join(dir, '_links.jsonl')).map((r) => [r.mailId, r]));
  assert.equal(L[m3.id], undefined, 'forged');
  assert.equal(L[m6.id], undefined, 'self-mail');
  assert.deepEqual([L[m1.id].method, L[m1.id].trust], ['field', 'two-party']);
  assert.deepEqual([L[m2.id].method, L[m2.id].cards], ['reply', ['CARD-ONE']]);
  assert.deepEqual([L[m5.id].method, L[m5.id].cards], ['ambiguous', ['CARD-ONE', 'CARD-TWO']]);
  assert.deepEqual([L[m7id].method, L[m7id].cards, L[m7id].trust], ['mention', ['CUT-1.1.9'], 'mail-ledger']);
  const r7 = readLines(path.join(dir, 'cut-1.1.9.jsonl')).find((r) => r.id === m7id);
  assert.equal(r7.body, undefined, 'an inbox body that does not match the ledger hash is not taken');
  assert.equal(r7.bodyHash, mailBodyHash('the real body'), 'the ledger\'s hash is kept');
  assert.equal(readLines(path.join(dir, 'card-one.jsonl')).find((r) => r.id === m1.id).body, `b-${m1.id}`, 'a proven body is kept');
  const human = readLines(path.join(dir, 'card-two.jsonl')).find((r) => r.id === m4.id);
  assert.equal(human.body, undefined);
  assert.equal(human.subject, undefined);
  assert.deepEqual(c.unlinked, [m5.id]);
  const again = MC.backfillMailCards(root, '2026-10-24T17:53:49.000Z');
  assert.deepEqual([again.recorded, again.already], [0, 7]);
  // prune-proof: the index alone still answers with every mail file gone
  fs.rmSync(path.join(root, 'agents'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'state', 'mail'), { recursive: true, force: true });
  assert.equal(readLines(path.join(dir, 'card-one.jsonl')).find((r) => r.id === m2.id).body, `b-${m2.id}`);
});

test('backfill script: refuses the live hive and a hive under the app\'s user data; writes on a copy', (t) => {
  const { root } = fixtureHive(t);
  const script = path.join(__dirname, '..', 'scripts', 'claims-mailcard-backfill.cjs');
  const run = (env) => spawnSync(process.execPath, [script, '--hive', root, '--now', '2026-10-24T17:53:49Z'], { encoding: 'utf8', env: { ...process.env, ...env } });
  const live = run({ MUNDER_HIVE_ROOT: path.dirname(root) });
  assert.equal(live.status, 2);
  assert.match(live.stderr, /never the live hive/);
  const ud = run({ MUNDER_HIVE_ROOT: path.join(os.tmpdir(), 'md-no-such-hive'), LOCALAPPDATA: path.dirname(path.dirname(root)), APPDATA: '' });
  // the app's user data is <LOCALAPPDATA>/Munder Difflin: a hive beside it is fine, one inside it is not
  assert.equal(ud.status, 0, ud.stderr);
  const inside = path.join(path.dirname(root), 'Munder Difflin', 'hive');
  fs.cpSync(root, inside, { recursive: true });
  const refused = spawnSync(process.execPath, [script, '--hive', inside], { encoding: 'utf8', env: { ...process.env, MUNDER_HIVE_ROOT: path.join(os.tmpdir(), 'md-no-such-hive'), LOCALAPPDATA: path.dirname(root) } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /user data/);
  const out = JSON.parse(ud.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.recorded, 7);
});
