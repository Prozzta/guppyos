'use strict';

/**
 * NEEDS-HUMAN-NO-ESCALATE-192: `needs_human` was stored and never acted on (it only exempted an ask
 * from the backstop); PROTOCOL.md never named it and the ledger command refused it. God's design
 * (2026-10-17, D1-D3):
 *  - an ASK (request / query / propose, or requires_reply) with needs_human, from any agent, becomes
 *    one ASK ME entry on its card: q names the sender and the subject, with a body excerpt. The
 *    card's status is NOT changed (the board is god's); ASK ME and the digest widen from "blocked
 *    with an open question" to "not done with an open question".
 *  - no card on the message: the card of an ancestor (in_reply_to) or of the conversation; still
 *    none, or the card is done or unknown: delivered to god as before, and the sender is told.
 *  - an inform / done with needs_human goes to god's floor digest under "Flagged for the Human".
 *  - the Human's answer is mailed to god AND to the agent that asked; one desktop notice per entry.
 * Invented subjects and bodies only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const D = loadTs('src/main/floorDigest.ts');
const L = loadTs('src/main/ledger.ts');
const HQ = loadTs('src/renderer/src/components/humanQuestion.ts');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-needs-human-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME redirected before any hive object exists');
  const hive = new HiveManager(() => home, () => {});
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorUserProfile;
    try { hive.dispose(); } catch { /* disposed by the test */ }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const card = (id, status) => ({ id, title: `invented card ${id}`, status, dependsOn: [], priority: 1, createdAt: '2026-10-17T00:00:00.000Z' });
  hive.writeTasks([card('ASK-1', 'doing'), card('DONE-1', 'done'), card('TODO-1', 'todo')]);
  const surfaced = [];
  hive.setNeedsHumanObserver((e) => surfaced.push(e));
  let n = 0;
  const post = (from, to, msg) => {
    const subject = msg.subject ?? `invented ${++n}`;
    fs.writeFileSync(path.join(hive.root(), 'agents', from, 'outbox', `m${++n}.json`), JSON.stringify({ to, subject, body: `invented body ${n}`, ...msg }));
    hive.routeOnce();
    return hive.inbox(to === 'god' ? 'god-1' : to).find((m) => m.subject === subject) ?? null;
  };
  const qa = (id) => hive.tasks().tasks.find((c) => c.id === id)?.humanQA ?? [];
  const status = (id) => hive.tasks().tasks.find((c) => c.id === id)?.status;
  const notices = () => hive.inbox('jim-1').filter((m) => m.from === 'system' && /^\[needs_human not surfaced\]/.test(m.subject));
  const logRows = (kind) => {
    const f = path.join(hive.root(), 'log.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === kind) : [];
  };
  return { hive, post, qa, status, notices, surfaced, logRows };
}

test('an ask with needs_human and a card: one ASK ME entry on the card, its status untouched, god still mailed', async (t) => {
  const f = await floor(t);
  const m = f.post('jim-1', 'god', { act: 'request', card: 'ASK-1', needs_human: true, subject: 'invented: which colour?', body: 'invented detail' });
  assert.ok(m, 'god still gets the message');
  assert.equal(m.needs_human, true);
  const q = f.qa('ASK-1');
  assert.equal(q.length, 1);
  assert.match(q[0].q, /^Jim asks: invented: which colour\?\n\ninvented detail$/);
  assert.equal(q[0].from, 'jim-1');
  assert.equal(q[0].msgId, m.id);
  assert.ok(Date.parse(q[0].askedAt) > 0);
  assert.equal(q[0].a, undefined);
  assert.equal(f.status('ASK-1'), 'doing', 'D2: the router never sets blocked');
  assert.equal(f.logRows('needs-human-surfaced').length, 1);
  assert.deepEqual(f.surfaced.map((e) => [e.card, e.name, e.subject]), [['ASK-1', 'Jim', 'invented: which colour?']], 'one desktop notice');
  // The same message routed again (a re-delivery, past the outbox's repeat filter): no second
  // entry, no second notice.
  f.hive.send({ id: m.id, to: 'god', act: 'request', card: 'ASK-1', needs_human: true, subject: 'invented: which colour?', body: 'invented detail' }, 'jim-1');
  assert.equal(f.qa('ASK-1').length, 1);
  assert.equal(f.surfaced.length, 1);
  assert.equal(f.notices().length, 0);
});

test('D3: a query, a propose and a requires_reply inform surface; an inform or done does not reach ASK ME', async (t) => {
  const f = await floor(t);
  f.post('jim-1', 'god', { act: 'query', card: 'ASK-1', needs_human: true });
  f.post('jim-1', 'god', { act: 'propose', card: 'ASK-1', needs_human: true });
  f.post('jim-1', 'god', { act: 'inform', requires_reply: true, card: 'ASK-1', needs_human: true });
  assert.equal(f.qa('ASK-1').length, 3);
  f.post('jim-1', 'god', { act: 'done', card: 'TODO-1', needs_human: true, subject: 'invented: finding the Human should see' });
  f.post('jim-1', 'god', { act: 'inform', needs_human: true, subject: 'invented: cardless finding' });
  assert.equal(f.qa('TODO-1').length, 0, 'an FYI is never an ASK ME entry');
  assert.equal(f.notices().length, 0, 'an FYI needs no card, so no notice');
  assert.equal(f.surfaced.length, 3);
  // FYIs go to god's digest, under Flagged for the Human, naming the card when there is one.
  const flagged = D.readFlaggedForHuman(f.hive.root());
  assert.deepEqual(flagged.map((x) => [x.agentId, x.card, x.subject]), [['jim-1', 'TODO-1', 'invented: finding the Human should see'], ['jim-1', null, 'invented: cardless finding']]);
  assert.equal(f.logRows('needs-human-flagged').length, 2);
});

test('no card on the ask: an ancestor\'s card, then the conversation\'s card', async (t) => {
  const f = await floor(t);
  const ask = f.post('god-1', 'jim-1', { act: 'request', card: 'ASK-1', conversation: 'conv-inv1', subject: 'invented: please build' });
  f.post('jim-1', 'god', { act: 'query', in_reply_to: ask.id, needs_human: true, subject: 'invented: via reply chain' });
  assert.deepEqual(f.qa('ASK-1').map((e) => e.q.split('\n')[0]), ['Jim asks: invented: via reply chain']);
  f.post('god-1', 'jim-1', { act: 'request', card: 'TODO-1', conversation: 'conv-inv2', subject: 'invented: second job' });
  f.post('jim-1', 'god', { act: 'query', conversation: 'conv-inv2', needs_human: true, subject: 'invented: via conversation' });
  assert.deepEqual(f.qa('TODO-1').map((e) => e.q.split('\n')[0]), ['Jim asks: invented: via conversation']);
  assert.equal(f.notices().length, 0);
});

test('no card found, a done card or an unknown card: delivered to god as before, and the sender is told', async (t) => {
  const f = await floor(t);
  for (const [extra, why] of [[{}, /no card/], [{ card: 'DONE-1' }, /DONE-1 is done/], [{ card: 'NOPE-9' }, /NOPE-9 is not a card/]]) {
    const before = f.notices().length;
    const m = f.post('jim-1', 'god', { act: 'request', needs_human: true, ...extra });
    assert.ok(m, 'god still gets it');
    const got = f.notices().slice(before);
    assert.equal(got.length, 1, JSON.stringify(extra));
    assert.match(got[0].body, why);
    assert.match(got[0].body, /resend it with its card/);
    assert.equal(got[0].requires_reply, false);
  }
  assert.equal(f.qa('DONE-1').length, 0);
  assert.equal(f.surfaced.length, 0);
});

test('only an agent surfaces (system and the Human do not), and the body excerpt is capped', async (t) => {
  const f = await floor(t);
  f.hive.send({ to: 'god', act: 'request', card: 'ASK-1', needs_human: true, subject: 'invented system ask' }, 'system');
  assert.equal(f.qa('ASK-1').length, 0);
  const long = 'x'.repeat(5000);
  const m = f.post('jim-1', 'god', { act: 'request', card: 'ASK-1', needs_human: true, subject: 'invented: long', body: long });
  const q = f.qa('ASK-1')[0].q;
  assert.ok(q.length < 800, `q is ${q.length} chars`);
  assert.ok(q.includes(`(the rest is in the message ${m.id})`));
});

test('the floor digest: an open question on a card that is not blocked is listed, and so are FYIs', async () => {
  const now = Date.parse('2026-10-17T12:00:00.000Z');
  const base = { tasks: { tasks: [
    { id: 'ASK-1', title: 't', status: 'doing', assignee: 'jim-1', humanQA: [{ q: 'Jim asks: invented?', askedAt: '2026-10-17T11:00:00.000Z' }] },
    { id: 'OLD-1', title: 't', status: 'done', humanQA: [{ q: 'never answered' }] }
  ] }, meta: {}, flags: [], ledgerIssues: [], agents: [], now };
  const md = D.buildFloorDigest({ ...base, flaggedForHuman: [
    { agentId: 'jim-1', name: 'Jim', card: 'TODO-1', id: 'm-1', subject: 'invented finding', at: now - 60_000 },
    { agentId: 'jim-1', name: 'Jim', card: null, id: 'm-0', subject: 'too old', at: now - 25 * 3600_000 }
  ] }).markdown;
  assert.match(md, /- ASK-1 \(jim-1\)[^\n]*: 1 question\(s\) for the Human, card not blocked \(set it blocked if the work waits\)/);
  assert.doesNotMatch(md, /OLD-1/, 'a done card is never listed');
  assert.match(md, /## Flagged for the Human \(last 24 h\)\n\n- Jim on TODO-1: invented finding \(m-1\)/);
  assert.doesNotMatch(md, /too old/);
  assert.doesNotMatch(D.buildFloorDigest(base).markdown, /Flagged for the Human/, 'no section when there is nothing');
});

test('ASK ME lists any card that is not done with an open question; the answer goes to god and to the asker', () => {
  const kb = src('src/renderer/src/components/TasksKanban.tsx');
  assert.match(kb, /return t\.status !== 'done' && !!openQuestion\(t\);/);
  assert.deepEqual(HQ.answerRecipients({ q: 'x', from: 'jim-1' }, 'god-1'), ['jim-1']);
  assert.deepEqual(HQ.answerRecipients({ q: 'x', from: 'god-1' }, 'god-1'), [], 'god is mailed anyway');
  assert.deepEqual(HQ.answerRecipients({ q: 'x' }, 'god-1'), [], 'a god-written question has no from');
  for (const bad of ['god', 'human', 'system', '../x', 7]) assert.deepEqual(HQ.answerRecipients({ q: 'x', from: bad }, 'god-1'), [], String(bad));
  const ask = src('src/renderer/src/components/AskMeTab.tsx');
  assert.match(ask, /for \(const to of answerRecipients\(open, godId\)\) await window\.cth\.hiveSend\(\{ to, act: 'inform', \.\.\.answerMail\(task, open, ans\) \}, 'human'\);/);
});

test('agents are told: the protocol line, and the ledger command takes needs_human', async (t) => {
  const f = await floor(t);
  const p = fs.readFileSync(path.join(f.hive.root(), 'PROTOCOL.md'), 'utf8');
  assert.match(p, /"needs_human": true \(optional: see "Asking the Human"\)/);
  assert.match(p, /## Asking the Human\n/);
  assert.match(p, /an ask \(request, query or propose\) to god with `needs_human: true` and its `card`/);
  assert.match(p, /An inform or done with `needs_human` goes to god's floor digest/);
  const ok = L.parseLedgerOp({ op: 'nh-1', message: { to: 'god', act: 'query', subject: 's', body: 'b', card: 'ASK-1', needs_human: true } });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.op.message.needs_human, true);
  const bad = L.parseLedgerOp({ op: 'nh-2', message: { to: 'god', act: 'query', subject: 's', body: 'b', needs_human: 'yes' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /message\.needs_human: true or false/);
  // and the message it writes to the caller's outbox carries the flag (the router reads it there)
  const agentDir = path.join(f.hive.root(), 'agents', 'jim-1');
  const deps = { agentId: 'jim-1', agentDir, isRecipient: (to) => to === 'god', readTasks: () => f.hive.tasks().tasks, addTask: () => false, patchTask: () => false, now: () => new Date('2026-10-17T12:00:00Z') };
  const r = await L.applyLedgerOp({ op: 'nh-3', message: { to: 'god', act: 'query', subject: 'invented: ledger ask', body: 'b', card: 'ASK-1', needs_human: true } }, deps);
  assert.equal(r.body.ok, true, JSON.stringify(r));
  const written = JSON.parse(fs.readFileSync(path.join(agentDir, 'outbox', 'ledger-nh-3.json'), 'utf8'));
  assert.equal(written.needs_human, true);
});
