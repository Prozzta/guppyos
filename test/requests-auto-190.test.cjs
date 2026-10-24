'use strict';
require('./tools/own-job.cjs');
/**
 * REQUESTS-AUTO-190: every open ask closes itself when its work is over, with no hand triage (the
 * Human: "fully automatic"). The replay of the real ledgers (2026-10-17: 714 asks, 65 closed by hand,
 * 60 of them carrying no card) gave two rules on top of REQUESTS-BADGE-84 / REQUESTS-TAB-STALE:
 *  - R1: an ask with no card takes the card of its in_reply_to chain or its conversation, and
 *    closes when that card is done after the ask (auto:card-done-inherited:<card>);
 *  - R4, the backstop: the owner has written to the requester since the ask, and the ask is
 *    ASK_BACKSTOP_MS (24 h = max(24 h, the p99 reply latency 2.13 h)) old: auto:backstop:<id>.
 *    Never for a needs_human ask, an ask on a card with an open humanQA, or an ask to god on a card
 *    still doing. Each backstop close tells both sides (a system inform) and lists it in the digest.
 * The replay had 0 false closes for both (no rule fired before a real reply).
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-requests-auto-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const ML = loadTs('src/main/mailLedger.ts');
const { staleObligations, applyDelivered, emptyLedger } = ML;
const { HiveManager } = loadTs('src/main/hive.ts');
const { buildFloorDigest } = loadTs('src/main/floorDigest.ts');

const H = 3600_000;
const T0 = 1_790_000_000_000;
let seq = 0;
function entry(o) {
  seq++;
  return { id: o.id ?? `m${seq}`, from: o.from, act: o.act ?? 'request', subject: o.subject ?? 'x', conversation: o.conversation,
    inReplyTo: o.inReplyTo ?? null, ...(o.cardId ? { cardId: o.cardId } : {}), ...(o.needsHuman ? { needsHuman: true } : {}),
    bodyHash: null, via: 'inbox', state: 'acted', seq, deliveredAt: o.at ?? T0, surfaceCount: 1, unconfirmedSurfacings: 0,
    redelivered: false, legacy: false, requiresReply: o.requiresReply ?? (o.act ?? 'request') === 'request',
    repliedAt: o.repliedAt ?? null, closedAt: o.closedAt ?? null, updatedAt: o.at ?? T0 };
}
function doc(agentId, ...entries) {
  return { version: 1, agentId, nextSeq: entries.length + 1, lastActivityAt: null, lastActedAt: null, entries: Object.fromEntries(entries.map((e) => [e.id, e])) };
}
const reasons = (list) => Object.fromEntries(list.map((s) => [`${s.agentId}/${s.id}`, s.reason]));
const opts = (now) => ({ now, backstopMs: ML.ASK_BACKSTOP_MS, godId: 'god' });

test('ASK_BACKSTOP_MS is 24 h (max(24 h, the replayed p99 reply latency of 2.13 h))', () => {
  assert.equal(ML.ASK_BACKSTOP_MS, 24 * H);
});

test('R1: a card-less ask takes its in_reply_to chain\'s or its conversation\'s card; done AFTER the ask closes it', () => {
  const cards = new Map([['WORK-1', { status: 'done', doneAt: T0 + 2 * H }], ['WORK-2', { status: 'done', doneAt: T0 + 3 * H }],
    ['OLD-1', { status: 'done', doneAt: T0 - H }], ['OPEN-1', { status: 'doing', doneAt: null }]]);
  const docs = {
    andy: doc('andy',
      entry({ id: 'carded', from: 'god', cardId: 'WORK-1', conversation: 'c1', at: T0 - H }),
      entry({ id: 'conv', from: 'god', subject: 'and also look at the logs', conversation: 'c1', at: T0 }),
      entry({ id: 'chain', from: 'god', subject: 're: that', inReplyTo: 'ref-2', at: T0 }),
      entry({ id: 'followup', from: 'god', subject: 'it broke again', conversation: 'c3', at: T0 }),
      entry({ id: 'still', from: 'god', subject: 'next step', conversation: 'c4', at: T0 })),
    god: doc('god',
      entry({ id: 'ref-2', from: 'andy', act: 'inform', cardId: 'WORK-2', requiresReply: false, at: T0 - H }),
      entry({ id: 'old', from: 'andy', act: 'inform', cardId: 'OLD-1', conversation: 'c3', requiresReply: false, at: T0 - 2 * H }),
      entry({ id: 'open', from: 'andy', act: 'inform', cardId: 'OPEN-1', conversation: 'c4', requiresReply: false, at: T0 - 2 * H }))
  };
  assert.deepEqual(reasons(staleObligations(docs, cards, [])), {
    'andy/carded': 'auto:card-done:WORK-1',
    'andy/conv': 'auto:card-done-inherited:WORK-1',
    'andy/chain': 'auto:card-done-inherited:WORK-2'
  }, 'a card done BEFORE the ask (a follow-up) or still doing leaves it open');
});

test('R4: the owner wrote to the requester since the ask, and 24 h passed: auto:backstop', () => {
  const docs = {
    andy: doc('andy',
      entry({ id: 'wrote', from: 'god', subject: 'look at it', at: T0 }),
      entry({ id: 'silent', from: 'jim', subject: 'audit please', at: T0 }),
      entry({ id: 'before', from: 'creed', subject: 'help', at: T0 })),
    god: doc('god', entry({ id: 'back-1', from: 'andy', act: 'inform', subject: 'on it', requiresReply: false, at: T0 + H })),
    jim: doc('jim'),
    creed: doc('creed', entry({ id: 'early', from: 'andy', act: 'inform', subject: 'earlier', requiresReply: false, at: T0 - H }))
  };
  assert.deepEqual(staleObligations(docs, new Map(), []), [], 'no `now`: the backstop is off (every older caller)');
  assert.deepEqual(staleObligations(docs, new Map(), [], opts(T0 + 24 * H - 1)), [], 'one ms short of 24 h: open');
  assert.deepEqual(reasons(staleObligations(docs, new Map(), [], opts(T0 + 24 * H))), { 'andy/wrote': 'auto:backstop:back-1' },
    'an owner who never wrote back, or wrote only BEFORE the ask, keeps it open');
});

test('R4 exclusions: needs_human, an open humanQA on its card, an ask to god while its card is doing, a non-agent sender', () => {
  const cards = new Map([['QA-1', { status: 'blocked', doneAt: null, openQA: true }], ['DOING-1', { status: 'doing', doneAt: null }],
    ['TODO-1', { status: 'todo', doneAt: null }]]);
  const docs = {
    andy: doc('andy',
      entry({ id: 'human', from: 'god', needsHuman: true, at: T0 }),
      entry({ id: 'qa', from: 'god', cardId: 'QA-1', at: T0 }),
      entry({ id: 'qa-inh', from: 'god', conversation: 'cq', at: T0 }),
      entry({ id: 'plain', from: 'god', cardId: 'TODO-1', at: T0 })),
    god: doc('god',
      entry({ id: 'cq-card', from: 'andy', act: 'inform', cardId: 'QA-1', conversation: 'cq', requiresReply: false, at: T0 - H }),
      entry({ id: 'signoff', from: 'andy', cardId: 'DOING-1', subject: 'sign off DOING-1?', at: T0 }),
      entry({ id: 'signoff-todo', from: 'andy', cardId: 'TODO-1', subject: 'ok to start TODO-1?', at: T0 }),
      entry({ id: 'from-human', from: 'human', subject: 'do X', at: T0 }),
      entry({ id: 'back-a', from: 'andy', act: 'inform', requiresReply: false, at: T0 + H })),
    // god -> andy: the owner (god) writes back to andy, and andy writes back to god
  };
  docs.andy.entries['back-g'] = entry({ id: 'back-g', from: 'god', act: 'inform', requiresReply: false, at: T0 + H });
  assert.deepEqual(reasons(staleObligations(docs, cards, [], opts(T0 + 30 * H))), {
    'andy/plain': 'auto:backstop:back-a',
    'god/signoff-todo': 'auto:backstop:back-g'
  });
});

test('needs_human is kept on the ledger entry at delivery (absent = false)', () => {
  const d1 = applyDelivered(emptyLedger('god'), { id: 'n1', from: 'andy', act: 'request', subject: 's', body: 'b', needs_human: true }, T0).doc;
  assert.equal(d1.entries.n1.needsHuman, true);
  const d2 = applyDelivered(emptyLedger('god'), { id: 'n2', from: 'andy', act: 'request', subject: 's', body: 'b' }, T0).doc;
  assert.equal('needsHuman' in d2.entries.n2, false);
});

test('digest: the backstop closes of the last 24 h are listed; none, no section', () => {
  const base = { tasks: [], meta: {}, flags: [], ledgerIssues: [], agents: [], now: T0 };
  assert.doesNotMatch(buildFloorDigest(base).markdown, /backstop/i);
  const md = buildFloorDigest({ ...base, backstopClosed: [
    { agentId: 'andy-1', from: 'god-1', id: 'ask-1', subject: 'look at it', at: T0 - H },
    { agentId: 'jim-1', from: 'andy-1', id: 'ask-old', subject: 'two days ago', at: T0 - 25 * H }
  ] }).markdown;
  assert.match(md, /## Asks closed by the backstop \(last 24 h\)\n\n- andy-1 <- god-1: look at it \(ask-1\)\n/);
  assert.doesNotMatch(md, /ask-old/);
});

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  return hive;
}
const inbox = (hive, id) => fs.readdirSync(path.join(hive.root(), 'agents', id, 'inbox')).filter((n) => n.endsWith('.json'))
  .map((n) => JSON.parse(fs.readFileSync(path.join(hive.root(), 'agents', id, 'inbox', n), 'utf8')));

test('hive: a backstop close tells both sides once, logs its reason, is recorded for the digest, and is idempotent', async (t) => {
  const hive = await floor(t);
  const ask = hive.send({ to: 'andy-1', act: 'request', subject: 'Look at the logs', body: 'go' }, 'god-1');
  const human = hive.send({ to: 'andy-1', act: 'request', subject: 'Human must pick', body: 'go', needs_human: true }, 'god-1');
  assert.equal(hive.mail.ledger('andy-1').entries[human.id].needsHuman, true, 'stamped at delivery through the real send path');
  hive.addTask({ id: 'ASK-QA-1', title: 'needs the Human', status: 'blocked', dependsOn: [], humanQA: [{ q: 'Which one?', askedAt: new Date().toISOString() }] });
  const onQA = hive.send({ to: 'andy-1', act: 'request', subject: 'build it once the Human picks', body: 'go', card: 'ASK-QA-1' }, 'god-1');
  hive.send({ to: 'god-1', act: 'inform', subject: 'something else', body: 'fyi' }, 'andy-1');
  assert.deepEqual(hive.autoCloseStaleObligations(null), [], 'fresh: open');
  const before = { god: inbox(hive, 'god-1').length, andy: inbox(hive, 'andy-1').length };
  const later = Date.now() + 25 * H;
  const closed = hive.autoCloseStaleObligations(null, later);
  assert.deepEqual(closed.map((s) => [s.id, s.reason.replace(/:[^:]*$/, '')]), [[ask.id, 'auto:backstop']],
    'the needs_human ask and the ask on a card with an open humanQA stay open');
  assert.deepEqual(hive.mailObligations().flatMap((a) => a.openRequests.map((o) => o.id)).sort(), [human.id, onQA.id].sort());
  const note = (id) => inbox(hive, id).filter((m) => m.from === 'system' && /closed by the backstop/.test(m.subject));
  assert.equal(note('andy-1').length, 1, 'the owner is told');
  assert.equal(note('god-1').length, 1, 'the requester is told');
  assert.equal(note('andy-1')[0].requires_reply, false);
  assert.match(note('andy-1')[0].body, new RegExp(ask.id));
  assert.equal(inbox(hive, 'god-1').length, before.god + 1);
  assert.equal(inbox(hive, 'andy-1').length, before.andy + 1);
  const row = hive.logTail(200).find((r) => r && r.kind === 'mail-obligation-closed' && r.id === ask.id);
  assert.match(row.reason, /^auto:backstop:/);
  const rec = JSON.parse(fs.readFileSync(path.join(hive.root(), 'state', 'asks-backstop.json'), 'utf8'));
  assert.deepEqual(rec.closed.map((c) => [c.agentId, c.from, c.id, c.subject]), [['andy-1', 'god-1', ask.id, 'Look at the logs']]);
  assert.deepEqual(hive.autoCloseStaleObligations(null, later), [], 'idempotent');
  assert.equal(note('andy-1').length, 1, 'no second notice');
});

test('hive: many backstop closes in one sweep are ONE notice per recipient, naming every ask (Jim NIT-2)', async (t) => {
  const hive = await floor(t);
  const asks = [1, 2, 3].map((n) => hive.send({ to: 'andy-1', act: 'request', subject: `Ask ${n}`, body: 'go' }, 'god-1'));
  hive.send({ to: 'god-1', act: 'inform', subject: 'something else', body: 'fyi' }, 'andy-1');
  const before = { god: inbox(hive, 'god-1').length, andy: inbox(hive, 'andy-1').length };
  const closed = hive.autoCloseStaleObligations(null, Date.now() + 25 * H);
  assert.deepEqual(closed.map((s) => s.id).sort(), asks.map((a) => a.id).sort());
  for (const [id, n] of [['andy-1', before.andy], ['god-1', before.god]]) {
    const notes = inbox(hive, id).filter((m) => m.from === 'system' && /closed by the backstop/.test(m.subject));
    assert.equal(notes.length, 1, `${id}: one notice for the sweep, not one per ask`);
    assert.equal(inbox(hive, id).length, n + 1, `${id}: one new message`);
    assert.equal(notes[0].requires_reply, false);
    for (const a of asks) assert.match(notes[0].body, new RegExp(a.id), `${id}: names ${a.id}`);
    assert.match(notes[0].subject, /3 asks/);
  }
});
