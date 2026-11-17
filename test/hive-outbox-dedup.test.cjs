'use strict';
require('./tools/own-job.cjs');

/**
 * HIVE-DUP-DONE-MAIL: an agent that checks "is my file still in outbox/?" finds it gone (the router
 * delivered it and moved it to outbox/.sent/ within milliseconds) and writes the same message again.
 * One done mail reached god three times that way. The router now archives an exact repeat (same
 * sender, to, act, in_reply_to, subject and body) within OUTBOX_DEDUP_WINDOW_MS instead of
 * delivering it, logs outbox-duplicate with both ids, and keeps the window across a restart.
 * Invented subjects and bodies only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const H = loadTs('src/main/hive.ts');
const { HiveManager, outboxDedupClock, OUTBOX_DEDUP_WINDOW_MS, OUTBOX_DEDUP_FILE } = H;

async function floor(t, home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-dedup-')), { keepHome = false } = {}) {
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const hive = new HiveManager(() => home, () => {});
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorUserProfile;
    try { hive.dispose(); } catch { /* disposed by the test */ }
    if (!keepHome) fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { hive, home, outbox: path.join(hive.root(), 'agents', 'jim-1', 'outbox') };
}
const send = (outbox, name, msg) => fs.writeFileSync(path.join(outbox, name), JSON.stringify(msg));
const MSG = { to: 'god-1', act: 'done', in_reply_to: '2026-10-04T06-22-26-774Z-aaaaaa', subject: 'invented: audit finished', body: 'invented result body' };
const logRows = (hive, kind) => {
  const f = path.join(hive.root(), 'log.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === kind) : [];
};
function useClock(t, start = Date.now()) {
  let now = start;
  const prior = outboxDedupClock.now;
  outboxDedupClock.now = () => now;
  t.after(() => { outboxDedupClock.now = prior; });
  return { advance: (ms) => { now += ms; } };
}

test('an exact repeat within the window is archived, not delivered, and logged with both ids', async (t) => {
  const { hive, outbox } = await floor(t);
  useClock(t);
  send(outbox, 'reply.json', MSG);
  assert.equal(await hive.routeOnce(), 1);
  const first = hive.inbox('god-1');
  assert.equal(first.length, 1);
  // The sender sees reply.json gone and writes it again: same name, then a new name.
  send(outbox, 'reply.json', MSG);
  assert.equal(await hive.routeOnce(), 0, 'the repeat is not delivered');
  send(outbox, 'reply-again.json', MSG);
  assert.equal(await hive.routeOnce(), 0, 'nor under another file name');
  assert.equal(hive.inbox('god-1').length, 1, 'god has the message once');
  assert.deepEqual(fs.readdirSync(outbox).filter((n) => n.endsWith('.json')), [], 'nothing left pending');
  const sent = fs.readdirSync(path.join(outbox, '.sent'));
  assert.ok(sent.includes('reply.json'), 'the delivered original is in .sent');
  assert.equal(sent.filter((n) => /\.duplicate-\d+$/.test(n)).length, 2, `both repeats are kept, not deleted: ${sent}`);
  const rows = logRows(hive, 'outbox-duplicate');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].firstId, first[0].id, 'the row names the delivered message');
  assert.ok(rows[0].duplicateId && rows[0].duplicateId !== first[0].id, 'and the repeat');
  assert.equal(rows[0].from, 'jim-1');
  // Jim M1: never silent. The sender gets a system notice per suppressed repeat, naming the first.
  assert.equal(rows[0].notified, true);
  const notices = hive.inbox('jim-1').filter((m) => m.from === 'system' && /^\[duplicate not delivered\]/.test(m.subject));
  assert.equal(notices.length, 2, 'one notice per suppressed repeat, to the sender');
  assert.match(notices[0].body, new RegExp(`repeats ${first[0].id} \\(delivered `), 'it names the delivered message');
  assert.match(notices[0].body, /change its text/);
  assert.equal(notices[0].act, 'inform');
});

test('Jim S1: a recorded delivery far in the future (the clock went back) does not keep suppressing', async (t) => {
  const { hive, outbox } = await floor(t);
  const clock = useClock(t);
  send(outbox, 'a.json', MSG);
  assert.equal(await hive.routeOnce(), 1);
  clock.advance(-60 * 60_000); // the system clock is set back an hour
  send(outbox, 'b.json', MSG);
  assert.equal(await hive.routeOnce(), 1, 'an entry an hour ahead is dropped: delivered');
  assert.equal(hive.inbox('god-1').length, 2);
});

test('Jim S2: an escalated resend (needs_human, requires_reply) is a new message', async (t) => {
  const { hive, outbox } = await floor(t);
  useClock(t);
  send(outbox, 'a.json', MSG);
  assert.equal(await hive.routeOnce(), 1);
  send(outbox, 'b.json', { ...MSG, needs_human: true });
  assert.equal(await hive.routeOnce(), 1, 'needs_human now set: delivered');
  send(outbox, 'c.json', { ...MSG, requires_reply: true });
  assert.equal(await hive.routeOnce(), 1, 'requires_reply now set: delivered');
  assert.equal(hive.inbox('god-1').length, 3);
});

test('a changed body, another in_reply_to, another act or another recipient is delivered', async (t) => {
  const { hive, outbox } = await floor(t);
  await hive.ensureAgent({ id: 'dwight-1', name: 'Dwight', provider: 'claude', cwd: hive.root() });
  useClock(t);
  send(outbox, 'a.json', MSG);
  assert.equal(await hive.routeOnce(), 1);
  send(outbox, 'b.json', { ...MSG, body: 'invented result body, corrected' });
  assert.equal(await hive.routeOnce(), 1, 'a changed body is a new message');
  send(outbox, 'c.json', { ...MSG, in_reply_to: '2026-10-04T06-22-26-774Z-bbbbbb' });
  assert.equal(await hive.routeOnce(), 1, 'a reply to another request is a new message');
  send(outbox, 'd.json', { ...MSG, act: 'inform', in_reply_to: undefined });
  assert.equal(await hive.routeOnce(), 1, 'another act is a new message');
  send(outbox, 'e.json', { ...MSG, to: 'dwight-1' });
  assert.equal(await hive.routeOnce(), 1, 'the same text to another recipient is delivered');
  assert.equal(hive.inbox('god-1').length, 4);
  assert.equal(logRows(hive, 'outbox-duplicate').length, 0);
});

test('a repeat after the window is delivered again', async (t) => {
  const { hive, outbox } = await floor(t);
  const clock = useClock(t);
  send(outbox, 'a.json', MSG);
  assert.equal(await hive.routeOnce(), 1);
  clock.advance(OUTBOX_DEDUP_WINDOW_MS - 1);
  send(outbox, 'b.json', MSG);
  assert.equal(await hive.routeOnce(), 0, 'just inside the window: suppressed');
  clock.advance(1);
  send(outbox, 'c.json', MSG);
  assert.equal(await hive.routeOnce(), 1, 'at the window: delivered');
  assert.equal(hive.inbox('god-1').length, 2);
});

test('a router restart keeps the window: no repeat is delivered and nothing is delivered twice', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-dedup-'));
  useClock(t);
  const one = await floor(t, home, { keepHome: true });
  send(one.outbox, 'reply.json', MSG);
  assert.equal(await one.hive.routeOnce(), 1);
  const firstId = one.hive.inbox('god-1')[0].id;
  assert.ok(fs.existsSync(path.join(one.hive.root(), OUTBOX_DEDUP_FILE)), 'the window is persisted');
  one.hive.dispose();

  const two = await floor(t, home, { keepHome: true });
  assert.equal(await two.hive.routeOnce(), 0, 'a restart delivers nothing again');
  send(two.outbox, 'reply.json', MSG);
  assert.equal(await two.hive.routeOnce(), 0, 'the repeat after the restart is suppressed');
  assert.equal(two.hive.inbox('god-1').length, 1);
  assert.equal(logRows(two.hive, 'outbox-duplicate').at(-1).firstId, firstId);
  // Registered last, so it runs after both hives are disposed.
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test('a message whose sender set its own id is left to the mail ledger (its §4.1 same-id dedup)', async (t) => {
  const { hive, outbox } = await floor(t);
  useClock(t);
  send(outbox, 'a.json', { ...MSG, id: 'invented-id-1' });
  assert.equal(await hive.routeOnce(), 1);
  send(outbox, 'b.json', { ...MSG, id: 'invented-id-2' });
  assert.equal(await hive.routeOnce(), 1, 'a new sender id is a new message here');
  assert.equal(logRows(hive, 'outbox-duplicate').length, 0);
  send(outbox, 'c.json', MSG);
  assert.equal(await hive.routeOnce(), 1, 'an id-less message is not matched against id-carrying ones');
  send(outbox, 'd.json', MSG);
  assert.equal(await hive.routeOnce(), 0, 'but its own repeat is suppressed');
  send(outbox, 'e.json', { ...MSG, id: 'invented-id-3' });
  assert.equal(await hive.routeOnce(), 1, 'the same text WITH a sender id goes to the ledger admission, not this check');
});

// ROUTER-ASYNC-DELIVER-107: the window was rewritten whole on each delivery (60 mails/min x an 80 KB
// window = 4.78 MB/min under Jim's load). It is now an append-only log: one line per delivery.
const dedupLines = (hive) => fs.readFileSync(path.join(hive.root(), OUTBOX_DEDUP_FILE), 'utf8').split('\n').filter(Boolean);

test('ROUTER-ASYNC-DELIVER-107: each delivery appends ONE line; the log is never rewritten per delivery', async (t) => {
  const { hive, outbox } = await floor(t);
  useClock(t);
  const sizes = [];
  for (let i = 0; i < 5; i++) {
    send(outbox, `m${i}.json`, { ...MSG, body: `invented body ${i}` });
    assert.equal(await hive.routeOnce(), 1);
    sizes.push(fs.statSync(path.join(hive.root(), OUTBOX_DEDUP_FILE)).size);
  }
  assert.equal(OUTBOX_DEDUP_FILE, 'outbox-dedup.jsonl');
  assert.equal(dedupLines(hive).length, 5, 'one line per delivery');
  const steps = sizes.slice(1).map((v, i) => v - sizes[i]);
  // a whole-window rewrite grows each write by the window so far; an append adds only its own line
  for (const d of steps) assert.ok(d > 0 && d < 400, `each delivery adds one short line: ${steps}`);
  const line = JSON.parse(dedupLines(hive)[0]);
  assert.deepEqual(Object.keys(line).sort(), ['id', 'key', 'ts']);
});

test('ROUTER-ASYNC-DELIVER-107: a torn last line (a crash mid-append) is skipped and the next append starts on its own line', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-dedup-'));
  useClock(t);
  const one = await floor(t, home, { keepHome: true });
  send(one.outbox, 'a.json', MSG);
  assert.equal(await one.hive.routeOnce(), 1);
  one.hive.dispose();
  const file = path.join(one.hive.root(), OUTBOX_DEDUP_FILE);
  fs.appendFileSync(file, '{"key":"torn');
  const two = await floor(t, home, { keepHome: true });
  send(two.outbox, 'a2.json', MSG);
  assert.equal(await two.hive.routeOnce(), 0, 'the whole line before the torn tail still suppresses');
  send(two.outbox, 'b.json', { ...MSG, body: 'invented: after the tear' });
  assert.equal(await two.hive.routeOnce(), 1);
  const lines = dedupLines(two.hive);
  assert.equal(lines.length, 3, `the torn line stays a line of its own: ${lines}`);
  assert.equal(lines[1], '{"key":"torn');
  assert.equal(JSON.parse(lines[2]).id, two.hive.inbox('god-1').at(-1).id, 'the new entry is parseable, not glued to the tear');
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test('ROUTER-ASYNC-DELIVER-107: compaction drops expired lines once they outnumber live ones, and only then', async (t) => {
  const { hive, outbox } = await floor(t);
  const clock = useClock(t);
  for (let i = 0; i < 64; i++) {
    send(outbox, `old${i}.json`, { ...MSG, body: `invented old ${i}` });
    assert.equal(await hive.routeOnce(), 1);
  }
  assert.equal(dedupLines(hive).length, 64, '64 live lines: no compaction');
  clock.advance(OUTBOX_DEDUP_WINDOW_MS);
  send(outbox, 'new.json', { ...MSG, body: 'invented new' });
  assert.equal(await hive.routeOnce(), 1);
  const lines = dedupLines(hive);
  assert.equal(lines.length, 1, `64 expired lines and one live one: compacted to the live window (${lines.length})`);
  assert.equal(JSON.parse(lines[0]).id, hive.inbox('god-1').at(-1).id);
  assert.equal(logRows(hive, 'outbox-dedup-compacted').length, 1);
  // after compaction the window still works
  send(outbox, 'new-again.json', { ...MSG, body: 'invented new' });
  assert.equal(await hive.routeOnce(), 0);
});

test('ROUTER-ASYNC-DELIVER-107: the legacy outbox-dedup.json window is read once, kept, and replaced by the log', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-dedup-'));
  const clock = useClock(t);
  const one = await floor(t, home, { keepHome: true });
  send(one.outbox, 'a.json', MSG);
  assert.equal(await one.hive.routeOnce(), 1);
  const root = one.hive.root();
  // turn the log into the 1.1.106 file: { entries: [{ key, id, ts }] }
  const entries = dedupLines(one.hive).map((l) => JSON.parse(l));
  one.hive.dispose();
  fs.rmSync(path.join(root, OUTBOX_DEDUP_FILE));
  fs.writeFileSync(path.join(root, 'outbox-dedup.json'), JSON.stringify({ entries }));
  clock.advance(1000);
  const two = await floor(t, home, { keepHome: true });
  send(two.outbox, 'a-again.json', MSG);
  assert.equal(await two.hive.routeOnce(), 0, 'a repeat of a legacy-window entry is suppressed');
  assert.equal(fs.existsSync(path.join(root, 'outbox-dedup.json')), false, 'the legacy file is gone after the first pass');
  assert.deepEqual(dedupLines(two.hive).map((l) => JSON.parse(l)), entries, 'its window moved into the log');
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
});

test('PROTOCOL.md says a file gone from outbox/ was delivered, and prefers the ledger command', () => {
  // The injected prompt is deliberately NOT changed: any instruction edit rotates every agent's
  // session at that install (session-prompt-rotation tripwire). PROTOCOL.md is a file.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(src, /A file gone from \\`outbox\/\\` WAS delivered, so never write it again/);
  assert.match(src, /it sends at once and confirms with \\`ok op=/);
});
