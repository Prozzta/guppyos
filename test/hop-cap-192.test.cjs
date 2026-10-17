'use strict';

/**
 * HOP-CAP-INERT-192: the loop guard (HOP_CAP 12) never fired. normalize() kept whatever `hops` the
 * sender wrote (0 when absent) and nothing ever raised it, so only a sender that set a large `hops`
 * itself was stopped; agents ping-ponging acknowledgements were not.
 *
 * The harness now owns `hops`: the number of messages in a row, along the in_reply_to chain and
 * ending with this one, that ask for no reply (an ack of an ack of a done...). A message that asks
 * for a reply starts work again: 0. Reply depth itself is NOT capped: real work conversations run
 * 20 replies deep (request, done, request...), and their acknowledgement runs stop at 7 (measured on
 * the live hive, 9,063 messages). The 13th acknowledgement in a row is not delivered; the sender gets
 * a system notice (never silent), which is itself no reply to anything, so it cannot extend the loop.
 * Invented subjects and bodies only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hop-cap-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(require('node:os').homedir(), home, 'HOME redirected before any hive object exists');
  const hive = new HiveManager(() => home, () => {});
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorUserProfile;
    try { hive.dispose(); } catch { /* disposed by the test */ }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const outbox = (id) => path.join(hive.root(), 'agents', id, 'outbox');
  let n = 0;
  /** `from` writes one message to its outbox; the router runs; returns the delivered copy or null. */
  const post = (from, to, msg) => {
    fs.writeFileSync(path.join(outbox(from), `m${++n}.json`), JSON.stringify({ to, subject: `invented ${n}`, body: `invented body ${n}`, ...msg }));
    hive.routeOnce();
    return hive.inbox(to).find((m) => m.subject === `invented ${n}`) ?? null;
  };
  const logRows = (kind) => {
    const f = path.join(hive.root(), 'log.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === kind) : [];
  };
  return { hive, post, logRows };
}

/** jim and god acknowledge each other `count` times, each a reply to the last; returns the copies. */
function ackRun(post, count, first = null) {
  const out = [];
  let prev = first;
  for (let i = 0; i < count; i++) {
    const [from, to] = i % 2 === 0 ? ['jim-1', 'god-1'] : ['god-1', 'jim-1'];
    const m = post(from, to, { act: 'inform', in_reply_to: prev?.id ?? null });
    out.push(m);
    if (!m) break;
    prev = m;
  }
  return out;
}

test('an acknowledgement ping-pong: hops counts it, and the 13th in a row is not delivered', async (t) => {
  const { hive, post, logRows } = await floor(t);
  const run = ackRun(post, 13);
  assert.equal(run.length, 13);
  for (let i = 0; i < 12; i++) {
    assert.ok(run[i], `ack ${i + 1} is delivered`);
    assert.equal(run[i].hops, i + 1, `ack ${i + 1} carries hops ${i + 1}`);
  }
  assert.equal(run[12], null, 'the 13th ack in a row is dropped');
  const drops = logRows('drop').filter((r) => r.reason === 'hop-cap');
  assert.equal(drops.length, 1);
  assert.equal(drops[0].from, 'jim-1');
  assert.equal(drops[0].hops, 13);
  // Never silent: the sender is told, by a notice that asks nothing and answers nothing.
  const notices = hive.inbox('jim-1').filter((m) => m.from === 'system' && /^\[loop stopped\]/.test(m.subject));
  assert.equal(notices.length, 1, 'the sender gets one notice');
  assert.equal(notices[0].act, 'inform');
  assert.equal(notices[0].requires_reply, false);
  assert.equal(notices[0].in_reply_to, null, 'the notice is no reply, so a reply to it starts a new run');
  assert.match(notices[0].body, /13 messages in a row/);
  assert.match(notices[0].body, /invented 13/, 'it names the message that was not delivered');
});

test('the harness owns hops: a sender-written value is ignored, high or low', async (t) => {
  const { post } = await floor(t);
  const high = post('jim-1', 'god-1', { act: 'inform', hops: 99 });
  assert.ok(high, 'a fresh inform claiming hops 99 is still delivered');
  assert.equal(high.hops, 1);
  const run = ackRun(post, 11, high);
  assert.equal(run[10].hops, 12);
  const low = post('god-1', 'jim-1', { act: 'inform', in_reply_to: run[10].id, hops: 0 });
  assert.equal(low, null, 'claiming hops 0 does not get the 13th ack through');
});

test('a message that asks for a reply starts again at 0, so real work conversations are never capped', async (t) => {
  const { post } = await floor(t);
  const acks = ackRun(post, 12);
  assert.equal(acks[11].hops, 12);
  const ask = post('jim-1', 'god-1', { act: 'request', in_reply_to: acks[11].id });
  assert.ok(ask, 'a request after 12 acks is delivered');
  assert.equal(ask.hops, 0);
  const done = post('god-1', 'jim-1', { act: 'done', in_reply_to: ask.id });
  assert.equal(done.hops, 1, 'the run restarts after the request');
  // An inform that sets requires_reply asks for a reply too.
  const q = post('jim-1', 'god-1', { act: 'inform', requires_reply: true, in_reply_to: done.id });
  assert.equal(q.hops, 0);
  // 40 replies deep (request, done, request...): every one delivered (the live hive reaches 20).
  let prev = q;
  for (let i = 0; i < 40; i++) {
    const [from, to] = i % 2 === 0 ? ['god-1', 'jim-1'] : ['jim-1', 'god-1'];
    const m = post(from, to, { act: i % 2 === 0 ? 'done' : 'request', in_reply_to: prev.id });
    assert.ok(m, `reply ${i + 1} of a 40-deep work conversation is delivered`);
    assert.ok(m.hops <= 1, `reply ${i + 1}: hops ${m.hops}`);
    prev = m;
  }
});

test('a reply to an unknown message, and a chain that cycles back on itself, count from what is found', async (t) => {
  const { post } = await floor(t);
  const orphan = post('jim-1', 'god-1', { act: 'done', in_reply_to: '2026-10-17T00-00-00-000Z-nosuch' });
  assert.ok(orphan);
  assert.equal(orphan.hops, 1, 'a parent that cannot be found ends the count');
  // A message whose own id is its in_reply_to (a sender-chosen id): counted once, no endless walk.
  const self = post('jim-1', 'god-1', { act: 'inform', id: '2026-10-17T00-00-01-000Z-selfref', in_reply_to: '2026-10-17T00-00-01-000Z-selfref' });
  assert.ok(self);
  assert.equal(self.hops, 1);
  const next = post('god-1', 'jim-1', { act: 'inform', in_reply_to: self.id });
  assert.equal(next.hops, 2);
});
