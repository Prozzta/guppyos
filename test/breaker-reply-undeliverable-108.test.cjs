'use strict';
require('./tools/own-job.cjs');

/**
 * BREAKER-REPLY-UNDELIVERABLE-108. The circuit breaker mails an agent a `request` ("Circuit
 * breaker: steer" / "constrain") from the sender id `breaker`. A request asks for a reply, and
 * the only address the mail carries is its sender. `breaker` is not an agent, so the router
 * treated the reply as mail to an unknown id: logged as a `no-inbox` drop and handed to god as
 * "[undeliverable — no agent "breaker" on this floor; check the id against the roster]". Seen
 * live four times (Dwight 2026-11-16, Andy 2026-11-18). The `ledger` command refused the same
 * address at send time, so the two send paths disagreed as well.
 *
 * Both breaker mails tell the agent to take its answer to god, so `breaker` is an address that
 * reaches god, on both send paths.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { readProvenMail } = loadTs('src/main/mailCards.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-breaker-reply-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(async () => {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = priorUserProfile;
    hive.dispose(); await hive.drainReads();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive };
}

const entries = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

// The two mails exactly as src/main/index.ts sends them (subject, act and sender id).
const BREAKER_MAILS = {
  steer: { subject: 'Circuit breaker: steer', body: 'Automated guardrail: 12 identical tool calls. Re-check your approach — if you\'re looping or stuck, STOP repeating, summarize what you\'ve tried, and ask god for direction.' },
  constrain: { subject: 'Circuit breaker: constrain', body: 'Automated guardrail escalated: 12 identical tool calls. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to god for sign-off BEFORE running more tools.' }
};

/** The breaker's mail lands in jim's inbox; jim answers it the way an agent does: one JSON file
 *  in its outbox, addressed to the mail's sender, in_reply_to the mail. */
async function replyToBreaker(hive, level) {
  hive.send({ to: 'jim-1', act: 'request', ...BREAKER_MAILS[level] }, 'breaker');
  const [mail] = hive.inbox('jim-1');
  assert.equal(mail.from, 'breaker');
  assert.equal(mail.requires_reply, true, 'the breaker mail asks for a reply');
  const reply = { to: mail.from, act: 'inform', in_reply_to: mail.id, subject: `Stopped: answer to the ${level}`, body: 'I tried A and B. Next I will do C.' };
  fs.writeFileSync(path.join(hive.root(), 'agents', 'jim-1', 'outbox', 'reply.json'), JSON.stringify(reply));
  assert.equal(await hive.routeOnce(), 1);
  return { mail, reply };
}

for (const level of ['steer', 'constrain']) {
  test(`a reply to a circuit-breaker ${level} is delivered to god, not bounced as undeliverable`, async (t) => {
    const { hive } = await floor(t);
    const { mail, reply } = await replyToBreaker(hive, level);

    assert.deepEqual(entries(hive, 'drop'), [], `A REPLY TO A BREAKER ${level.toUpperCase()} IS DROPPED: the router logged it as a drop`);
    const got = hive.inbox('god-1');
    assert.equal(got.length, 1, `A REPLY TO A BREAKER ${level.toUpperCase()} REACHES GOD: god's inbox holds ${got.length} message(s)`);
    assert.equal(got[0].subject, reply.subject, 'A REPLY TO A BREAKER MAIL IS DELIVERED AS WRITTEN: its subject was changed');
    assert.equal(got[0].from, 'jim-1');
    assert.equal(got[0].body, reply.body);
    assert.equal(got[0].in_reply_to, mail.id);
    const sent = entries(hive, 'message').find((e) => e.from === 'jim-1');
    assert.deepEqual(sent.delivered, ['god-1'], 'the message log names god as the one who received it');
    // The card backfill pairs the sender's copy with the delivered copy by recipient: it must
    // resolve 'breaker' as the router does, or the reply is never linked to its card.
    const proven = readProvenMail(hive.root());
    assert.ok(proven.mails.some((m) => m.subject === reply.subject), `A REPLY TO A BREAKER MAIL IS PROVEN MAIL: the backfill left it out (${JSON.stringify(proven.excluded)})`);
  });
}

test('the ledger command and the router accept the same addresses, "breaker" among them', async (t) => {
  const { hive } = await floor(t);
  assert.equal(typeof hive.isRecipient, 'function', 'THE ROUTER AND THE LEDGER COMMAND SHARE ONE RECIPIENT RULE: HiveManager has no isRecipient');
  for (const to of ['breaker', 'god', 'human', 'broadcast', 'jim-1', 'god-1']) assert.equal(hive.isRecipient(to), true, `"${to}" is an address`);
  for (const to of ['jim', 'brekaer', 'scheduler', 'system', '', '__proto__', 'constructor']) assert.equal(hive.isRecipient(to), false, `"${to}" is not an address`);
  // The ledger command's check is this rule, not a second list.
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(index, /isRecipient: \(to\) => hive\.isRecipient\(to\),/, 'THE LEDGER COMMAND USES THE ROUTER\'S RECIPIENT RULE');
});

test('an address that is not on the floor still bounces to god as undeliverable', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'brekaer', act: 'inform', subject: 'typo', body: 'x' }, 'jim-1');
  const dropped = entries(hive, 'drop').filter((e) => e.reason === 'no-inbox');
  assert.equal(dropped.length, 1);
  assert.match(hive.inbox('god-1')[0].subject, /^\[undeliverable — no agent "brekaer"/);
});

test('god answering a breaker mail is not handed its own reply', async (t) => {
  const { hive } = await floor(t);
  hive.send({ to: 'breaker', act: 'inform', subject: 'noted', body: 'x' }, 'god-1');
  assert.equal(hive.inbox('god-1').length, 0, 'GOD IS HANDED ITS OWN MAIL TO THE BREAKER AS UNDELIVERABLE');
  assert.deepEqual(entries(hive, 'drop'), []);
});
