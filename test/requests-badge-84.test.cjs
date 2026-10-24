'use strict';
require('./tools/own-job.cjs');
/**
 * REQUESTS-BADGE-84 (god 09ef18, ruling 4d2bbc): the requests badge counts only asks that are
 * really still open. Every close records its reason; nothing is closed by age or by content.
 *  A. a request is tied to its card at send time (message `card`, or the ledger op's card): the
 *     ask closes when THAT card is done after delivery (`auto:card-done:<id>`); the ledger command
 *     refuses a request with no card (information goes as inform);
 *  B. at routing time, an answer act from the owner to the requester closes every open ask of the
 *     requester it cites by id (`auto:answered-cited:<msg>`), and with no in_reply_to the latest
 *     open ask in the same conversation (`auto:answered:<act>:<msg>`);
 *  C. a later message from the requester whose `supersedes` names the ask (`auto:superseded:<msg>`);
 *  D. the owner closes its own ask with a reason (`owner:<text>`), via the ledger `close` part;
 *  E. the requester withdraws its own ask with a reason (`withdrawn:<text>`). Nobody else may.
 * HOME and USERPROFILE are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-requests-badge-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const ML = loadTs('src/main/mailLedger.ts');
const L = loadTs('src/main/ledger.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

let seq = 0;
function entry(o) {
  seq++;
  return { id: o.id ?? `m${seq}`, from: o.from, act: o.act ?? 'request', subject: o.subject ?? 'x', conversation: o.conversation,
    inReplyTo: null, ...(o.senderId ? { senderId: o.senderId } : {}), ...(o.cardId ? { cardId: o.cardId } : {}),
    bodyHash: null, via: 'inbox', state: o.state ?? 'acted', seq, deliveredAt: o.at ?? 100, surfaceCount: 1, unconfirmedSurfacings: 0,
    redelivered: false, legacy: false, requiresReply: (o.act ?? 'request') === 'request',
    repliedAt: o.repliedAt ?? null, closedAt: null, updatedAt: o.at ?? 100 };
}
function doc(agentId, ...entries) {
  return { version: 1, agentId, nextSeq: entries.length + 1, lastActivityAt: null, lastActedAt: null, entries: Object.fromEntries(entries.map((e) => [e.id, e])) };
}
const reasons = (list) => Object.fromEntries(list.map((s) => [s.id, s.reason]));
const ID = (tail) => `2026-10-15T10-00-00-000Z-${tail}`;

// ── A: the tie ───────────────────────────────────────────────────────────────────────────────
test('A: cardIdValue keeps a card id as tasks.json spells them, and nothing else', () => {
  for (const ok of ['READS-181', 'T5b', 'M1', 'GPU-SETTING-188', 'a.b_c-1']) assert.equal(ML.cardIdValue(ok), ok, ok);
  assert.equal(ML.cardIdValue('  READS-181 '), 'READS-181', 'trimmed');
  for (const bad of [undefined, null, 7, '', ' ', 'a b', '../x', '-X', 'X/1', 'x'.repeat(121), ['READS-181']]) assert.equal(ML.cardIdValue(bad), null, String(bad));
  assert.equal(ML.cardIdValue('x'.repeat(120)), 'x'.repeat(120));
});

test('A: an entry stores the message card; a tied card decides alone, after delivery only', () => {
  const cards = new Map([['TIED-1', { status: 'done', doneAt: 500 }], ['OTHER-2', { status: 'done', doneAt: 500 }],
    ['OPEN-3', { status: 'doing', doneAt: null }], ['EARLY-4', { status: 'done', doneAt: 50 }], ['T5b', { status: 'done', doneAt: 500 }]]);
  const docs = { andy: doc('andy',
    entry({ id: 'tied', from: 'god', subject: 'build it', cardId: 'TIED-1' }),
    entry({ id: 'short', from: 'god', subject: 'go', cardId: 'T5b' }),
    // the tie decides alone: a subject naming a done card does not close an ask tied to an open one
    entry({ id: 'tiedOpen', from: 'god', subject: 'OTHER-2 follow-up', cardId: 'OPEN-3' }),
    entry({ id: 'tiedEarly', from: 'god', subject: 'it broke again', cardId: 'EARLY-4' }),
    entry({ id: 'tiedGone', from: 'god', subject: 'OTHER-2', cardId: 'NO-SUCH-9' }),
    entry({ id: 'untied', from: 'god', subject: 'OTHER-2: the old subject rule' }))};
  assert.deepEqual(reasons(ML.staleObligations(docs, cards, [])),
    { tied: 'auto:card-done:TIED-1', short: 'auto:card-done:T5b', untied: 'auto:card-done:OTHER-2' });
});

test('A: the mail ledger records cardId from a delivered message, and drops a malformed one', () => {
  const home = fs.mkdtempSync(path.join(JAIL, 'ml-'));
  const root = path.join(home, 'hive');
  fs.mkdirSync(path.join(root, 'agents', 'jim-1', 'inbox', '.done'), { recursive: true });
  const ml = new ML.MailLedger({ root: () => root, appendLog: () => {}, readLogRows: () => [], clock: () => 1000, setTimer: () => ({}), clearTimer: () => {} });
  ml.markDelivered('jim-1', { id: 'c1', from: 'god', act: 'request', subject: 's', body: 'b', card: 'READS-181' });
  ml.markDelivered('jim-1', { id: 'c2', from: 'god', act: 'request', subject: 's', body: 'b', card: 'no such/../card' });
  ml.markDelivered('jim-1', { id: 'c3', from: 'god', act: 'request', subject: 's', body: 'b' });
  const es = ml.ledger('jim-1').entries;
  assert.equal(es.c1.cardId, 'READS-181');
  assert.equal(es.c2.cardId, undefined);
  assert.equal(es.c3.cardId, undefined);
  ml.dispose();
});

// ── B: answered at routing ───────────────────────────────────────────────────────────────────
test('B: an answer act closes every cited ask of that requester, plus the latest open one in its conversation', () => {
  const owner = doc('andy',
    entry({ id: ID('aaa111'), from: 'god', conversation: 'c1', at: 100 }),
    entry({ id: ID('bbb222'), from: 'god', conversation: 'c2', at: 110 }),
    entry({ id: ID('ccc333'), from: 'god', conversation: 'c3', at: 120 }),
    entry({ id: ID('ddd444'), from: 'god', conversation: 'c4', at: 130, senderId: 'god-own-7' }),
    entry({ id: ID('eee555'), from: 'jim', conversation: 'c1', at: 100 }),          // another requester
    entry({ id: ID('ggg777'), from: 'god', conversation: 'c1', at: 105 }),          // the latest open one in c1
    entry({ id: ID('hhh888'), from: 'god', conversation: 'c5', at: 100, state: 'replied', repliedAt: 150 }),
    entry({ id: ID('fff666'), from: 'god', conversation: 'c1', at: 900 }));         // arrived after the answer (cited, latest in c1)
  const m = { id: 'ans-1', act: 'done', conversation: 'c1', inReplyTo: null, at: 500,
    subject: `done: ${ID('aaa111')}`, body: `also bbb222 and god-own-7; not xccc333 nor ccc3334; hhh888 already replied; eee555 is jim's; fff666 came later` };
  assert.deepEqual(reasons(ML.answeredByMessage(owner, 'god', m)), {
    [ID('aaa111')]: 'auto:answered-cited:ans-1',     // full id
    [ID('bbb222')]: 'auto:answered-cited:ans-1',     // its random tail as a whole word
    [ID('ddd444')]: 'auto:answered-cited:ans-1',     // its sender_id
    [ID('ggg777')]: 'auto:answered:done:ans-1'       // the conversation's latest open ask (no in_reply_to)
  });
});

test('B: no conversation rule with in_reply_to; its target is left to applyReplied; non-answer acts answer nothing', () => {
  const owner = doc('andy',
    entry({ id: ID('aaa111'), from: 'god', conversation: 'c1', at: 100 }),
    entry({ id: ID('bbb222'), from: 'god', conversation: 'c1', at: 110 }),
    entry({ id: ID('ccc333'), from: 'god', conversation: 'c9', at: 110 }));
  const base = { id: 'ans-2', conversation: 'c1', at: 500, subject: 's', body: `re ${ID('aaa111')} and ccc333` };
  assert.deepEqual(reasons(ML.answeredByMessage(owner, 'god', { ...base, act: 'done', inReplyTo: ID('aaa111') })),
    { [ID('ccc333')]: 'auto:answered-cited:ans-2' }, 'in_reply_to: no same-conversation close, and its own target is skipped');
  assert.deepEqual(reasons(ML.answeredByMessage(owner, 'god', { ...base, act: 'refuse', inReplyTo: null })),
    { [ID('aaa111')]: 'auto:answered-cited:ans-2', [ID('ccc333')]: 'auto:answered-cited:ans-2', [ID('bbb222')]: 'auto:answered:refuse:ans-2' });
  // An inform or agree is often a status ("NEXT: the audit of <id>, starting now"): it answers
  // neither the asks it names nor the conversation's latest ask (god, conv-c110a5).
  for (const act of ['inform', 'agree']) {
    assert.deepEqual(ML.answeredByMessage(owner, 'god', { ...base, act, inReplyTo: null }), [], act);
    assert.deepEqual(ML.answeredByMessage(owner, 'god', { ...base, act, inReplyTo: ID('aaa111') }), [], `${act} with in_reply_to`);
  }
  for (const act of ['request', 'query', 'propose']) assert.deepEqual(ML.answeredByMessage(owner, 'god', { ...base, act, inReplyTo: null }), [], act);
  assert.deepEqual(ML.answeredByMessage(owner, 'jim', { ...base, act: 'done', inReplyTo: null }), [], 'only the addressee\'s asks');
  assert.deepEqual(ML.answeredByMessage(owner, 'god', { ...base, act: 'done', inReplyTo: null, conversation: undefined, body: 'nothing cited' }), [], 'no conversation, no citation');
  const short = doc('andy', entry({ id: 'x-ab12', from: 'god', at: 100 }));
  assert.deepEqual(ML.answeredByMessage(short, 'god', { ...base, act: 'done', inReplyTo: null, conversation: undefined, body: 'ab12' }), [], 'a tail under 6 chars is never cited');
  // Jim N1: a sender_id is cited only as a whole word of 6+ chars.
  const sids = doc('andy', entry({ id: 'x-q1', from: 'god', at: 100, senderId: '1' }), entry({ id: 'x-q2', from: 'god', at: 100, senderId: 'g.f-2(a)' }));
  const cite = (body) => Object.keys(reasons(ML.answeredByMessage(sids, 'god', { ...base, act: 'done', inReplyTo: null, conversation: undefined, body }))).sort();
  assert.deepEqual(cite('fixed 1 thing in 1.1.88'), [], 'a short sender_id is never cited');
  assert.deepEqual(cite('fixed xg.f-2(a)'), [], 'not inside a word');
  assert.deepEqual(cite('fixed g.f-2(a), done'), ['x-q2'], 'a whole word, regex characters taken literally');
  assert.deepEqual(cite('fixed g.f-2(a)b'), [], 'not followed by a letter');
  assert.deepEqual(cite('fixed gxf-2a'), [], 'not as a pattern');
});

// ── C: superseded ────────────────────────────────────────────────────────────────────────────
test('C: a later message from the same requester naming the ask in supersedes closes it', () => {
  const rec = doc('andy',
    entry({ id: 'q1', from: 'god', at: 100 }),
    entry({ id: 'q2', from: 'god', at: 100, senderId: 'god-file-2' }),
    entry({ id: 'q3', from: 'jim', at: 100 }),
    entry({ id: 'q4', from: 'god', at: 900 }),
    entry({ id: 'q5', from: 'god', at: 100 }));
  const m = { id: 'sup-1', act: 'inform', at: 500, supersedes: ['q1', 'god-file-2', 'q3', 'q4'] };
  assert.deepEqual(reasons(ML.supersededByMessage(rec, 'god', m)), { q1: 'auto:superseded:sup-1', q2: 'auto:superseded:sup-1' });
  assert.deepEqual(ML.supersededByMessage(rec, 'god', { ...m, supersedes: [] }), []);
  assert.deepEqual(ML.supersededByMessage(rec, 'god', { ...m, supersedes: undefined }), []);
});

test('D/E: askCloseReason prefixes owner: or withdrawn:, collapses space, needs text, is bounded', () => {
  assert.equal(ML.askCloseReason('owner', ' done in\n c04fede3 '), 'owner:done in c04fede3');
  assert.equal(ML.askCloseReason('requester', 'not needed'), 'withdrawn:not needed');
  assert.equal(ML.askCloseReason('owner', '   '), null);
  assert.equal(ML.askCloseReason('owner', 7), null);
  assert.equal(ML.askCloseReason('owner', 'x'.repeat(500)).length, ML.ASK_CLOSE_REASON_MAX);
});

// ── the ledger command: A (request needs a card) and D/E (close) ─────────────────────────────
function fixture({ closers = {}, tasks = [{ id: 'READS-181', title: 'r', status: 'todo', dependsOn: [], priority: 1, createdAt: 'x' }, { id: 'T5b', title: 't', status: 'todo', dependsOn: [], priority: 1, createdAt: 'x' }] } = {}) {
  const agentDir = fs.mkdtempSync(path.join(JAIL, 'agent-'));
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '# m\n');
  const closed = [];
  const open = new Map(Object.entries(closers));
  const deps = {
    agentId: 'creed', agentDir,
    isRecipient: (to) => ['god', 'broadcast', 'jim'].includes(to),
    readTasks: () => tasks.map((t) => ({ ...t })),
    addTask: () => true, patchTask: () => true,
    now: () => new Date('2026-10-15T19:00:00.000Z'),
    askCloser: (id) => open.get(id) ?? null,
    closeAsk: (id, by, reason) => { if (open.get(id) !== by) return false; open.delete(id); closed.push([id, reason]); return true; }
  };
  const outbox = () => { try { return fs.readdirSync(path.join(agentDir, 'outbox')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(agentDir, 'outbox', f), 'utf8'))); } catch { return []; } };
  return { deps, closed, outbox };
}
const msg = (o = {}) => ({ to: 'god', act: 'request', subject: 's', body: 'b', ...o });

test('A (ledger): a request must name its card; the op card or message.card rides on the outbox message', async () => {
  const p = L.parseLedgerOp({ op: 'r1', message: msg() });
  assert.equal(p.ok, false);
  assert.match(p.error, /a request must name its card/);
  assert.match(p.error, /act "inform"/, 'points FYIs to inform');
  for (const act of ['inform', 'done', 'query', 'propose', 'agree', 'refuse']) assert.equal(L.parseLedgerOp({ op: 'r2', message: msg({ act }) }).ok, true, act);
  assert.match(L.parseLedgerOp({ op: 'r3', message: msg({ card: 'bad card' }) }).error, /^message\.card: a card id/);
  assert.match(L.parseLedgerOp({ op: 'r3', message: msg({ card: 7 }) }).error, /^message\.card/);

  const f = fixture();
  let r = await L.applyLedgerOp({ op: 'a1', card: { id: 'READS-181', appendNote: 'n' }, message: msg() }, f.deps);
  assert.equal(r.status, 200, r.body.line);
  r = await L.applyLedgerOp({ op: 'a2', message: msg({ card: 'T5b' }) }, f.deps);
  assert.equal(r.status, 200, r.body.line);
  r = await L.applyLedgerOp({ op: 'a3', card: { id: 'READS-181', appendNote: 'n' }, message: msg({ card: 'T5b', act: 'inform' }) }, f.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.deepEqual(f.outbox().map((m) => [m.act, m.card]), [['request', 'READS-181'], ['request', 'T5b'], ['inform', 'T5b']], 'message.card wins over the op card');
  r = await L.applyLedgerOp({ op: 'a4', message: msg({ card: 'NOPE-1' }) }, f.deps);
  assert.equal(r.status, 404);
  assert.match(r.body.line, /message\.card NOPE-1 is not a card/);
  assert.equal(f.outbox().length, 3, 'a refused op writes nothing');
});

test('D/E (ledger): close parse errors are refused before anything else', () => {
  const bad = [
    [[], /close: a list of 1-50/], ['x', /close: a list/], [Array.from({ length: 51 }, (_, i) => ({ id: `i${i}`, reason: 'r' })), /close: a list of 1-50/],
    [[7], /close\[0\]: must be an object/], [[{ id: 'a', reason: 'r', by: 'god' }], /close\[0\]: unknown field\(s\): by/],
    [[{ reason: 'r' }], /close\[0\]\.id/], [[{ id: 'a' }], /close\[0\]\.reason: required/], [[{ id: 'a', reason: '  ' }], /close\[0\]\.reason: required/],
    [[{ id: 'a', reason: 'x'.repeat(181) }], /at most 180/], [[{ id: 'a', reason: 'r' }, { id: 'a', reason: 's' }], /close\[1\]\.id: a is listed twice/]
  ];
  for (const [close, re] of bad) {
    const p = L.parseLedgerOp({ op: 'c', close });
    assert.equal(p.ok, false, JSON.stringify(close).slice(0, 60));
    assert.match(p.error, re);
  }
  const ok = L.parseLedgerOp({ op: 'c', close: [{ id: 'a', reason: ' r ' }] });
  assert.deepEqual(ok.op.close, [{ id: 'a', reason: 'r' }]);
  assert.equal(L.LEDGER_CLOSE_MAX, 50);
});

test('D/E (ledger): an ask closed already is done, also when routing closes it meanwhile (Jim N3)', async () => {
  const f = fixture({ closers: { gone: 'closed', racy: 'owner' } });
  f.deps.closeAsk = (id) => { f.deps.askCloser = (x) => (x === id ? 'closed' : null); return false; };
  const r = await L.applyLedgerOp({ op: 'n3', close: [{ id: 'gone', reason: 'r' }, { id: 'racy', reason: 'r' }] }, f.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.match(r.body.line, /closed=2/);
  const g = fixture({ closers: { racy: 'owner' } });
  g.deps.closeAsk = () => false;
  const r2 = await L.applyLedgerOp({ op: 'n3b', close: [{ id: 'racy', reason: 'r' }] }, g.deps);
  assert.equal(r2.status, 500, 'not closed and not closed already is still an error');
  assert.match(r2.body.line, /racy was not open any more/);
});

test('D/E (ledger): the owner closes (owner:), the requester withdraws (withdrawn:); anyone else is refused, all-or-nothing', async () => {
  const f = fixture({ closers: { own1: 'owner', sent1: 'requester' } });
  let r = await L.applyLedgerOp({ op: 'k0', card: { id: 'READS-181', appendNote: 'n' }, message: msg({ act: 'inform' }), close: [{ id: 'own1', reason: 'r' }, { id: 'stranger', reason: 'r' }] }, f.deps);
  assert.equal(r.status, 404);
  assert.match(r.body.line, /stranger is not an open ask you owe or sent/);
  assert.deepEqual(f.closed, []);
  assert.equal(f.outbox().length, 0, 'checked before any write');

  r = await L.applyLedgerOp({ op: 'k1', close: [{ id: 'own1', reason: 'done in c04fede3' }, { id: 'sent1', reason: 'no longer needed' }] }, f.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.match(r.body.line, /closed=2/);
  assert.deepEqual(f.closed, [['own1', 'owner:done in c04fede3'], ['sent1', 'withdrawn:no longer needed']]);
  r = await L.applyLedgerOp({ op: 'k1', close: [{ id: 'own1', reason: 'done in c04fede3' }, { id: 'sent1', reason: 'no longer needed' }] }, f.deps);
  assert.match(r.body.line, /already applied/);
  assert.equal(f.closed.length, 2, 'a retry closes nothing twice');

  // a partial failure: the retry finishes the rest and never closes the first one again
  const p = fixture({ closers: { own2: 'owner', sent2: 'requester' } });
  const realClose = p.deps.closeAsk;
  let flaky = true;
  p.deps.closeAsk = (id, by, reason) => { if (id === 'sent2' && flaky) { flaky = false; throw new Error('disk full'); } return realClose(id, by, reason); };
  r = await L.applyLedgerOp({ op: 'k3', close: [{ id: 'own2', reason: 'a' }, { id: 'sent2', reason: 'b' }] }, p.deps);
  assert.equal(r.status, 500);
  assert.match(r.body.line, /close sent2 failed/);
  r = await L.applyLedgerOp({ op: 'k3', close: [{ id: 'own2', reason: 'a' }, { id: 'sent2', reason: 'b' }] }, p.deps);
  assert.equal(r.status, 200, r.body.line);
  assert.match(r.body.line, /closed=2/);
  assert.deepEqual(p.closed, [['own2', 'owner:a'], ['sent2', 'withdrawn:b']]);

  const none = fixture();
  delete none.deps.askCloser; delete none.deps.closeAsk;
  r = await L.applyLedgerOp({ op: 'k2', close: [{ id: 'x', reason: 'r' }] }, none.deps);
  assert.equal(r.status, 400);
  assert.match(r.body.line, /close is not available/);
});

// ── over a real (jailed) hive ────────────────────────────────────────────────────────────────
async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { hive };
}
const openIds = (hive) => hive.mailObligations().flatMap((a) => a.openRequests.map((o) => o.id)).sort();
const tick = () => new Promise((r) => setTimeout(r, 5));
const closedRows = (hive) => hive.logTail(500).filter((r) => r && r.kind === 'mail-obligation-closed').map((r) => [r.id, r.reason]);

test('hive: A tie by card, B answers at routing, C supersedes; each close is logged with its reason', async (t) => {
  const { hive } = await floor(t);
  hive.startLedgerGuard();
  t.after(() => hive.stopLedgerGuard());
  hive.addTask({ id: 'SHIP-IT-1', title: 'ship', status: 'doing', dependsOn: [] });
  const tied = hive.send({ to: 'andy-1', act: 'request', subject: 'build it (no card in subject)', body: 'go', card: 'SHIP-IT-1' }, 'god-1');
  const cited = hive.send({ to: 'andy-1', act: 'request', subject: 'review', body: 'go', conversation: 'conv-a' }, 'god-1');
  const retract = hive.send({ to: 'andy-1', act: 'request', subject: 'old plan', body: 'go', conversation: 'conv-b' }, 'god-1');
  const live = hive.send({ to: 'andy-1', act: 'request', subject: 'still open', body: 'go', conversation: 'conv-c' }, 'god-1');
  const jims = hive.send({ to: 'andy-1', act: 'request', subject: 'jim asks', body: 'go', conversation: 'conv-j' }, 'jim-1');
  assert.equal(hive.mail.ledger('andy-1').entries[tied.id].cardId, 'SHIP-IT-1', 'the tie is stored');
  await tick();

  hive.send({ to: 'god-1', act: 'done', subject: 'reviewed', body: `answers ${cited.id}; ${jims.id} is jim's`, conversation: 'conv-other' }, 'andy-1');
  hive.send({ to: 'andy-1', act: 'inform', subject: 'new plan', body: 'drop the old one', conversation: 'conv-b', supersedes: [retract.id] }, 'god-1');
  assert.deepEqual(openIds(hive), [tied.id, live.id, jims.id].sort(), 'B and C closed at routing');

  await tick();
  hive.patchTask('SHIP-IT-1', { status: 'done' });
  const swept = hive.autoCloseStaleObligations(null);
  assert.deepEqual(swept.map((s) => [s.id, s.reason]), [[tied.id, 'auto:card-done:SHIP-IT-1']]);
  assert.deepEqual(openIds(hive), [live.id, jims.id].sort());
  const rows = Object.fromEntries(closedRows(hive));
  assert.match(rows[cited.id], /^auto:answered-cited:/);
  assert.match(rows[retract.id], /^auto:superseded:/);
  assert.equal(rows[tied.id], 'auto:card-done:SHIP-IT-1');
});

test('hive: D/E askCloser/closeAsk: owner, requester, never a third party; the reason is recorded', async (t) => {
  const { hive } = await floor(t);
  const a = hive.send({ to: 'andy-1', act: 'request', subject: 'one', body: 'go' }, 'god-1');
  const b = hive.send({ to: 'andy-1', act: 'request', subject: 'two', body: 'go' }, 'god-1');
  const c = hive.send({ to: 'andy-1', act: 'request', subject: 'three', body: 'go' }, 'god-1');
  assert.equal(hive.askCloser('andy-1', a.id), 'owner');
  assert.equal(hive.askCloser('god-1', a.id), 'requester');
  assert.equal(hive.askCloser('jim-1', a.id), null, 'a third party may not');
  assert.equal(hive.askCloser('andy-1', 'not a mail id'), null);
  assert.equal(hive.closeAsk('jim-1', a.id, 'owner', 'owner:x'), false);
  assert.equal(hive.closeAsk('god-1', a.id, 'owner', 'owner:x'), false, 'the role must match');
  assert.equal(hive.closeAsk('andy-1', a.id, 'owner', '  '), false, 'a reason is required');
  assert.equal(hive.closeAsk('andy-1', a.id, 'owner', 'owner:shipped in c04fede3'), true);
  assert.equal(hive.closeAsk('god-1', b.id, 'requester', 'withdrawn:not needed'), true);
  // Jim N3: an ask closed already is done (a retry after routing closed it), with no second row.
  assert.equal(hive.askCloser('andy-1', b.id), 'closed');
  assert.equal(hive.askCloser('god-1', b.id), 'closed');
  assert.equal(hive.askCloser('jim-1', b.id), null, 'still not a third party\'s');
  assert.equal(hive.closeAsk('god-1', b.id, 'requester', 'withdrawn:again'), true, 'closed already');
  assert.equal(hive.closeAsk('god-1', b.id, 'owner', 'owner:x'), false, 'the role must still match');
  assert.deepEqual(openIds(hive), [c.id]);
  const rows = Object.fromEntries(closedRows(hive));
  assert.equal(rows[a.id], 'owner:shipped in c04fede3');
  assert.equal(rows[b.id], 'withdrawn:not needed');
  assert.equal(closedRows(hive).filter(([id]) => id === b.id).length, 1);
});

test('hive: E on a broadcast ask closes every recipient\'s copy (Jim N2)', async (t) => {
  const { hive } = await floor(t);
  const bc = hive.send({ to: 'broadcast', act: 'request', subject: 'everyone', body: 'go' }, 'god-1');
  const holders = () => ['andy-1', 'jim-1'].filter((a) => hive.askCloser(a, bc.id) === 'owner');
  assert.deepEqual(holders(), ['andy-1', 'jim-1'], 'each recipient owes its copy');
  assert.equal(hive.askCloser('god-1', bc.id), 'requester');
  assert.equal(hive.closeAsk('god-1', bc.id, 'requester', 'withdrawn:not needed'), true);
  assert.deepEqual(holders(), [], 'one withdraw closes every copy');
  assert.deepEqual(closedRows(hive).filter(([id]) => id === bc.id).map(([, r]) => r), ['withdrawn:not needed', 'withdrawn:not needed']);
});

test('hive: the one-time replay runs B and C over every agent\'s outbox/.sent, after delivery only, once', async (t) => {
  const { hive } = await floor(t);
  const x = hive.send({ to: 'andy-1', act: 'request', subject: 'fix x', body: 'go', conversation: 'conv-x' }, 'god-1');
  const y = hive.send({ to: 'andy-1', act: 'request', subject: 'plan y', body: 'go', conversation: 'conv-y' }, 'god-1');
  const z = hive.send({ to: 'andy-1', act: 'request', subject: 'z', body: 'go', conversation: 'conv-z' }, 'god-1');
  const c = hive.send({ to: 'andy-1', act: 'request', subject: 'conv answer', body: 'go', conversation: 'conv-c' }, 'god-1');
  const j = hive.send({ to: 'andy-1', act: 'request', subject: 'jim asks', body: 'go', conversation: 'conv-j' }, 'jim-1');
  const later = Date.now() / 1000 + 60;
  const put = (agent, file, m, at = later) => {
    const dir = path.join(hive.root(), 'agents', agent, 'outbox', '.sent');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), JSON.stringify(m));
    fs.utimesSync(path.join(dir, file), at, at);
  };
  put('andy-1', 'a-done.json', { to: 'god', act: 'done', subject: 'fixed', body: `fixed ${x.id}; ${j.id} too`, conversation: 'other', in_reply_to: 'zzz' });
  put('god-1', 'g-sup.json', { to: 'andy-1', act: 'inform', subject: 'new plan', body: 'b', supersedes: [y.id] });
  put('andy-1', 'a-old.json', { to: 'god', act: 'done', subject: 'old', body: `cites ${z.id}` }, Date.now() / 1000 - 3600);
  put('andy-1', 'a-query.json', { to: 'god', act: 'query', subject: 'which?', body: `${z.id}?`, conversation: 'conv-z' });
  put('andy-1', 'a-conv.json', { to: 'human', act: 'done', subject: 'answered', body: 'see thread', conversation: 'conv-c' });
  put('andy-1', 'a-status.json', { to: 'god', act: 'inform', subject: 'starting', body: `on ${z.id} now`, conversation: 'conv-z' });
  put('andy-1', 'a-bcast.json', { to: 'broadcast', act: 'done', subject: 'all', body: `${z.id}` });
  put('andy-1', 'bad-x.json', { to: 'god', act: 'done', subject: 'bad', body: `${z.id}` });
  put('andy-1', 'broken.json', '{not json');
  // Jim N4: the replay runs in time order (the conversation rule's "latest open" depends on it):
  // the earlier answer (its file name sorts last) answers the latest ask, the later one the first.
  const p1 = hive.send({ to: 'andy-1', act: 'request', subject: 'p one', body: 'go', conversation: 'conv-p' }, 'god-1');
  const p2 = hive.send({ to: 'andy-1', act: 'request', subject: 'p two', body: 'go', conversation: 'conv-p' }, 'god-1');
  put('andy-1', 'z-first.json', { to: 'god', act: 'done', subject: 'one done', body: 'b', conversation: 'conv-p' }, later);
  put('andy-1', 'y-second.json', { to: 'god', act: 'done', subject: 'other done', body: 'b', conversation: 'conv-p' }, later + 30);

  const closed = hive.runReplay84();
  assert.deepEqual(closed.map((s) => [s.id, s.reason]).sort(), [
    [x.id, 'auto:answered-cited:sent:a-done.json'],
    [y.id, 'auto:superseded:sent:g-sup.json'],
    [c.id, 'auto:answered:done:sent:a-conv.json'],
    [p2.id, 'auto:answered:done:sent:z-first.json'],
    [p1.id, 'auto:answered:done:sent:y-second.json']].sort());
  assert.deepEqual(openIds(hive), [z.id, j.id].sort(), 'jim\'s ask is answered only to jim; z only by a status inform, a query, an older file, a broadcast or a rejected file');
  // Jim N4: a self-send is no answer. Routing never puts a self-ask in a ledger, so this is pinned by source.
  assert.match(codeOnly(readSource('src/main/hive.ts'), 'hive.ts'), /if \(to === from \|\| !agents\.includes\(to\)\) continue;/);
  const marker = JSON.parse(fs.readFileSync(path.join(hive.root(), 'state', 'replay-84.json'), 'utf8'));
  assert.equal(marker.closed.length, 5);
  assert.equal(hive.runReplay84(), null, 'once per hive');
});

// ── wiring ───────────────────────────────────────────────────────────────────────────────────
test('WIRING: routing runs B/C for direct mail; main gives the ledger the caller-bound close; the protocol says so', () => {
  const hiveSrc = codeOnly(readSource('src/main/hive.ts'), 'hive.ts');
  assert.match(hiveSrc, /this\.mail\.markReplied\(msg\.from, msg\.in_reply_to, msg\.id, resolveTo\(msg\.to\), msg\.needs_human === true \? 'blocked' : msg\.act\);[\s\S]{0,900}if \(msg\.to !== 'broadcast'\) this\.closeAnsweredAsks\(msg, resolveTo\(msg\.to\)\);/);
  assert.match(hiveSrc, /answeredByMessage\(this\.mail\.ledger\(msg\.from\), to, m\), \.\.\.supersededByMessage\(this\.mail\.ledger\(to\), msg\.from, m\)/);
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(idx, /askCloser: \(id\) => hive\.askCloser\(agentId, id\),\s*closeAsk: \(id, by, reason\) => hive\.closeAsk\(agentId, id, by, reason\)/);
  assert.match(idx, /function runStaleRequestsBeat\(\): void \{\s*if \(!app\.isPackaged\) return;[^}]*\}[^\n]*\n[^\n]*autoCloseStaleObligations[^\n]*\n\s*try \{ hive\.runReplay84\(\); \}/, 'the replay rides the packaged-only beat');
  const raw = readSource('src/main/hive.ts');
  assert.ok(raw.includes('"card": "<the task card id this message is about'), 'the message schema has card');
  assert.ok(raw.includes('A \\`request\\` must name its card'), 'the ledger docs: a request names its card');
  assert.ok(raw.includes('goes as \\`inform\\`, never as \\`request\\`'), 'FYIs go as inform');
  assert.ok(raw.includes('- \\`close\\`: '), 'the ledger docs: close');
});
