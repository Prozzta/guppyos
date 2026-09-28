'use strict';

/**
 * ZT-I1-MAIL (1.1.75) §4.1 through the real router (HiveManager.send / routeOnce → deliver):
 *  - an invalid id (traversal, overlong, reserved) is replaced with a fresh `<ts>-<rand>`, the
 *    sender's value kept as sender_id, and NOTHING is written outside the recipient's inbox;
 *  - a same-id resend with the same sender and body is dropped idempotently (`mail-dedup`);
 *  - a same-id message with different content is reassigned (`mail-id-reassigned`);
 *  - in_reply_to resolves against either value (reply tracking and the L2 supersede test);
 *  - every delivery is recorded `delivered` in hive/state/mail/<agent>.json.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-ids-'));
  const keys = ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GEMINI_CLI_HOME'];
  const prior = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.GEMINI_CLI_HOME = home;
  assert.equal(os.homedir(), home, 'home must be jailed before HiveManager construction');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => home);
  t.after(() => {
    hive.dispose();
    for (const k of keys) { if (prior[k] === undefined) delete process.env[k]; else process.env[k] = prior[k]; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  const root = path.join(home, 'hive');
  const inbox = (a) => path.join(root, 'agents', a, 'inbox');
  return { home, root, hive, inbox, files: (a) => fs.readdirSync(inbox(a)).filter((f) => f.endsWith('.json')).sort() };
}

const rows = (hive, kind) => hive.logTail(1000).filter((e) => e.kind === kind);

/** Every file under `dir`, relative, recursively. */
function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base)); else out.push(path.relative(base, full));
  }
  return out;
}

test('invalid ids are reassigned with sender_id, and nothing lands outside the inbox', async (t) => {
  const { home, root, hive, inbox, files } = await floor(t);
  const before = new Set(walk(home));
  const bad = ['../../escaped', '..\\..\\escaped2', 'x'.repeat(129), '.done', 'CON', 'evil.tmp', 'a/b', 42];
  for (const id of bad) hive.send({ id, to: 'jim-1', subject: `bad ${String(id).slice(0, 10)}`, body: `b ${String(id)}` }, 'god-1');

  const msgs = hive.inbox('jim-1');
  assert.equal(msgs.length, bad.length, 'every message still delivered');
  for (const m of msgs) {
    assert.match(m.id, /^\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-f]{6}$/, 'a fresh router id');
    assert.ok(fs.existsSync(path.join(inbox('jim-1'), `${m.id}.json`)));
  }
  assert.deepEqual(msgs.map((m) => m.sender_id).sort(), bad.map((b) => (typeof b === 'string' ? b.slice(0, 200) : JSON.stringify(b))).sort());
  const reassigned = rows(hive, 'mail-id-reassigned');
  assert.equal(reassigned.length, bad.length);
  assert.ok(reassigned.every((r) => r.reason === 'invalid'));

  // The only new files are inside the hive's known places: inbox files, the ledger, the log.
  hive.mail.flushAll();
  const added = walk(home).filter((f) => !before.has(f));
  const allowed = (f) => f.startsWith(path.join('hive', 'agents', 'jim-1', 'inbox') + path.sep)
    || f.startsWith(path.join('hive', 'state', 'mail') + path.sep)
    || /^hive[\\/]log.*\.jsonl$/.test(f);
  assert.deepEqual(added.filter((f) => !allowed(f)), []);
  assert.ok(!walk(home).some((f) => /escaped/.test(f)), 'no traversal target exists anywhere');
  assert.equal(files('jim-1').length, bad.length);
  assert.ok(fs.existsSync(path.join(root, 'state', 'mail', 'jim-1.json')));
});

test('a same-id resend with the same content is dropped idempotently', async (t) => {
  const { hive, files } = await floor(t);
  const m = { id: 'req-1', to: 'jim-1', act: 'request', subject: 'do X', body: 'please do X' };
  hive.send({ ...m }, 'god-1');
  hive.send({ ...m, subject: 'do X (resent)' }, 'god-1'); // the subject is not the content test
  assert.deepEqual(files('jim-1'), ['req-1.json']);
  const dedup = rows(hive, 'mail-dedup');
  assert.equal(dedup.length, 1);
  assert.equal(dedup[0].agentId, 'jim-1');
  assert.equal(dedup[0].existingId, 'req-1');
  // Still a dup after the agent moved it to .done (old habit) and after the ledger forgot it.
  fs.renameSync(path.join(hive.root(), 'agents', 'jim-1', 'inbox', 'req-1.json'), path.join(hive.root(), 'agents', 'jim-1', 'inbox', '.done', 'req-1.json'));
  hive.send({ ...m }, 'god-1');
  assert.deepEqual(files('jim-1'), []);
  assert.equal(rows(hive, 'mail-dedup').length, 2);
  // The ledger recorded exactly one delivery.
  assert.equal(rows(hive, 'mail').filter((r) => r.stage === 'delivered' && r.agentId === 'jim-1').length, 1);
});

test('a same-id message with different content is reassigned, never overwrites', async (t) => {
  const { hive, files, inbox } = await floor(t);
  hive.send({ id: 'dup-id', to: 'jim-1', subject: 'first', body: 'one' }, 'god-1');
  hive.send({ id: 'dup-id', to: 'jim-1', subject: 'second', body: 'two' }, 'god-1');
  hive.send({ id: 'dup-id', to: 'jim-1', subject: 'third', body: 'one' }, 'pam-1'); // same body, other sender
  const f = files('jim-1');
  assert.equal(f.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox('jim-1'), 'dup-id.json'), 'utf8')).body, 'one', 'the original is untouched');
  const others = hive.inbox('jim-1').filter((m) => m.id !== 'dup-id');
  assert.deepEqual(others.map((m) => [m.sender_id, m.body]).sort(), [['dup-id', 'one'], ['dup-id', 'two']]);
  const re = rows(hive, 'mail-id-reassigned');
  assert.equal(re.length, 2);
  assert.ok(re.every((r) => r.agentId === 'jim-1' && r.senderId === 'dup-id' && /^collision-/.test(r.reason)));
  // The per-target reassignment is invisible to other recipients: pam gets the sender's id.
  hive.send({ id: 'dup-id', to: 'pam-1', subject: 'to pam', body: 'two' }, 'god-1');
  assert.deepEqual(files('pam-1'), ['dup-id.json']);
  // The ledger knows every copy, with the alias.
  const ledger = hive.mail.ledger('jim-1');
  assert.equal(Object.keys(ledger.entries).length, 3);
  assert.equal(Object.values(ledger.entries).filter((e) => e.senderId === 'dup-id').length, 2);
});

test('a sender cannot forge sender_id', async (t) => {
  const { hive } = await floor(t);
  hive.send({ id: 'ok-1', to: 'jim-1', body: 'x', sender_id: 'forged' }, 'god-1');
  const [m] = hive.inbox('jim-1');
  assert.equal(m.id, 'ok-1');
  assert.equal(m.sender_id, undefined);
});

test('in_reply_to resolves against the reassigned id and the sender_id (reply tracking)', async (t) => {
  const { hive } = await floor(t);
  hive.send({ id: 'ask', to: 'jim-1', act: 'inform', body: 'occupies the id' }, 'pam-1');
  hive.send({ id: 'ask', to: 'jim-1', act: 'request', subject: 'build it', body: 'please build' }, 'god-1');
  hive.send({ id: 'ask2', to: 'jim-1', act: 'query', subject: 'status?', body: 'status?' }, 'god-1');
  const reassigned = hive.inbox('jim-1').find((m) => m.sender_id === 'ask');
  assert.ok(reassigned);
  assert.deepEqual(hive.mail.openRequests('jim-1').map((o) => o.entry.id), [reassigned.id]);

  // Jim answers the request by the SENDER's id (the one god knows)...
  hive.send({ to: 'god-1', act: 'done', in_reply_to: 'ask', body: 'built' }, 'jim-1');
  const e = hive.mail.ledger('jim-1').entries[reassigned.id];
  assert.ok(e.repliedAt, 'the alias resolved to the reassigned entry');
  assert.equal(hive.mail.ledger('jim-1').entries.ask.repliedAt ?? null, null, "pam's inform owning the exact id is not an obligation");
  assert.deepEqual(hive.mail.openRequests('jim-1'), []);
  // ...and the query by the ledger id.
  hive.send({ to: 'god-1', act: 'inform', in_reply_to: 'ask2', body: 'green' }, 'jim-1');
  assert.ok(hive.mail.ledger('jim-1').entries.ask2.repliedAt);
  assert.deepEqual(rows(hive, 'mail').filter((r) => r.stage === 'replied').map((r) => r.id).sort(), ['ask2', reassigned.id].sort());
});

test('the L2 supersede test resolves a reply to a reassigned id against the sender_id', async (t) => {
  const { hive } = await floor(t);
  hive.send({ id: 'x-1', to: 'jim-1', body: 'squatter' }, 'pam-1');
  hive.send({ id: 'x-1', to: 'jim-1', act: 'request', subject: 'do X', body: 'do X' }, 'god-1');
  const req = hive.inbox('jim-1').find((m) => m.sender_id === 'x-1');
  // God cancels its request by the id god knows; it waits unread in jim's inbox.
  hive.send({ to: 'jim-1', act: 'inform', subject: 'cancel X', body: 'never mind', supersedes: ['x-1'] }, 'god-1');
  // Jim replies to the request by the ledger id he was shown.
  hive.send({ to: 'god-1', act: 'done', in_reply_to: req.id, subject: 'X done', body: 'done' }, 'jim-1');
  const reply = hive.inbox('god-1').find((m) => m.in_reply_to === req.id);
  assert.ok(reply.superseded_by, 'flagged as answering a superseded ask');
  assert.match(reply.subject, /^\[superseded by /);
});

test('an outbox file with a traversal id is routed safely by routeOnce', async (t) => {
  const { hive, root, files } = await floor(t);
  const outbox = path.join(root, 'agents', 'god-1', 'outbox');
  fs.writeFileSync(path.join(outbox, 'm.json'), JSON.stringify({ id: '..\\..\\..\\pwn', to: 'jim-1', subject: 's', body: 'b' }));
  assert.equal(hive.routeOnce(), 1);
  const [m] = hive.inbox('jim-1');
  assert.equal(m.sender_id, '..\\..\\..\\pwn');
  assert.equal(files('jim-1').length, 1);
  assert.ok(!fs.existsSync(path.join(root, 'pwn.json')) && !fs.existsSync(path.join(root, 'agents', 'pwn.json')));
});

test('deliver() records delivered in the ledger; bounces are recorded for god', async (t) => {
  const { hive, root } = await floor(t);
  hive.send({ to: 'jim-1', act: 'request', subject: 'one', body: '1' }, 'god-1');
  hive.send({ to: 'nobody', act: 'inform', subject: 'lost', body: '2' }, 'jim-1');
  assert.deepEqual(hive.mail.pending('jim-1').map((e) => e.subject), ['one']);
  assert.deepEqual(hive.mail.pending('god-1').map((e) => e.subject), ['[undeliverable — no agent "nobody" on this floor; check the id against the roster] lost']);
  hive.dispose();
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'state', 'mail', 'jim-1.json'), 'utf8'));
  assert.equal(Object.values(onDisk.entries)[0].state, 'delivered');
  assert.equal(Object.values(onDisk.entries)[0].requiresReply, true);
  assert.equal(fs.existsSync(path.join(root, 'state', 'mail', 'nobody.json')), false);
});
