'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 4: every harness reader of "inbox file position" reads the ledger
 * (INBOX-DESIGN.md §3 #5/#6, §11.8 #9-#16, §11.15 C8). The HARNESS now moves a message file into
 * inbox/.done when it is acted, so a rename into .done, and any inbox/.done mtime, is never
 * activity, coordination or "handled" on its own. Zero model tokens: a real (jailed) hive and the
 * pure reader module; index.ts itself is an Electron entry point, so its call sites are pinned
 * by source. HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-readers-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager } = loadTs('src/main/hive.ts');
const R = loadTs('src/main/mailReaders.ts');
const { detectCompletion } = loadTs('src/main/realtimeCompletionWatcher.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  const dir = (id, ...p) => path.join(hive.root(), 'agents', id, ...p);
  let n = 0;
  /** Surface + confirm + close normally: the ids become acted and the harness archives them. */
  const act = (agent, ids) => {
    const epoch = `e-${++n}`;
    hive.mail.claimSurfacing(agent, ids, epoch, 'UserPromptSubmit');
    hive.mail.confirmSurfaced(agent, ids, epoch, 'evidence');
    const r = hive.mail.closeEpoch(agent, epoch, 'normal');
    hive.mail.flush(agent);
    return r;
  };
  return { hive, dir, act };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── #6 fleet: inboxBacklog / awaitingReply / openRequests ────────────────────────────────────

test('#6: inboxBacklog = ledger not-acted (delivered + surfacing + surfaced); acted leaves it even though .done is the harness\'s doing', async (t) => {
  const { hive, dir, act } = await floor(t);
  const a = hive.send({ to: 'andy-1', act: 'inform', subject: 'a', body: '1' }, 'god-1');
  const b = hive.send({ to: 'andy-1', act: 'inform', subject: 'b', body: '2' }, 'god-1');
  const c = hive.send({ to: 'andy-1', act: 'inform', subject: 'c', body: '3' }, 'god-1');
  assert.equal(hive.inboxBacklog('andy-1'), 3);
  hive.mail.claimSurfacing('andy-1', [b.id], 'live', 'PostToolUse');
  assert.equal(hive.inboxBacklog('andy-1'), 3, 'surfacing is not acted');
  act('andy-1', [a.id]);
  assert.ok(fs.existsSync(dir('andy-1', 'inbox', '.done', `${a.id}.json`)), 'the harness archived it');
  assert.equal(hive.inboxBacklog('andy-1'), 2);
  // A file the harness (or anyone) moved into .done while the ledger says delivered is still backlog.
  fs.renameSync(dir('andy-1', 'inbox', `${c.id}.json`), dir('andy-1', 'inbox', '.done', `${c.id}.json`));
  assert.equal(hive.inboxBacklog('andy-1'), 2, 'file position means nothing: the ledger still says delivered');
  // An archived agent is counted by files and its ledger is never loaded (§7.1 step 2 is slice 6's).
  assert.equal(hive.inboxBacklog('andy-1', { archived: true }), 1);
});

test('#6: a terminal work order is acted by definition: never backlog (N2)', async (t) => {
  const { hive } = await floor(t);
  hive.mail.recordWorkOrder('andy-1', { id: 'wo-1', from: 'god-1', act: 'request', subject: 'w', body: 'x' });
  assert.equal(hive.inboxBacklog('andy-1'), 0);
  assert.equal(R.fleetMailFields(hive.mail, 'andy-1').inboxBacklog, 0);
});

test('#6: fleetMailFields: awaitingReply (acted, requires_reply, not replied) and option-B openRequests, with ages, bounded', async (t) => {
  const { hive, act } = await floor(t);
  const q = hive.send({ to: 'andy-1', act: 'query', subject: 'which branch?', body: 'q', requires_reply: true }, 'god-1');
  const r = hive.send({ to: 'andy-1', act: 'request', subject: 'build Z', body: 'go' }, 'god-1');
  const i = hive.send({ to: 'andy-1', act: 'inform', subject: 'fyi', body: 'x' }, 'god-1');
  let f = R.fleetMailFields(hive.mail, 'andy-1');
  assert.equal(f.inboxBacklog, 3);
  assert.deepEqual(f.awaitingReply, [], 'not acted yet: nothing awaits a reply');
  assert.deepEqual(f.openRequests.map((o) => [o.id, o.state]), [[r.id, 'delivered']], 'a request is open in ANY state');
  act('andy-1', [q.id, r.id, i.id]);
  f = R.fleetMailFields(hive.mail, 'andy-1');
  assert.equal(f.inboxBacklog, 0);
  assert.deepEqual(f.awaitingReply.map((o) => o.id).sort(), [q.id, r.id].sort(), 'requires_reply (query, request default) acted, not replied');
  assert.equal(f.awaitingReplyCount, 2);
  assert.deepEqual(f.openRequests.map((o) => [o.id, o.from, o.subject, o.state]), [[r.id, 'god-1', 'build Z', 'acted']]);
  assert.equal(typeof f.openRequests[0].ageSec, 'number');
  // A reply closes it (router: in_reply_to from the recipient).
  fs.writeFileSync(path.join(hive.root(), 'agents', 'andy-1', 'outbox', 'r.json'), JSON.stringify({ to: 'god', act: 'inform', subject: 'Z built', in_reply_to: r.id }));
  hive.routeOnce();
  f = R.fleetMailFields(hive.mail, 'andy-1');
  assert.deepEqual(f.openRequests, []);
  assert.deepEqual(f.awaitingReply.map((o) => o.id), [q.id]);
  // Bounded lists, full counts.
  const many = [];
  for (let k = 0; k < 14; k++) many.push(hive.send({ to: 'andy-1', act: 'request', subject: `r${k}`, body: String(k) }, 'god-1'));
  f = R.fleetMailFields(hive.mail, 'andy-1');
  assert.equal(f.openRequests.length, R.FLEET_OBLIGATIONS_MAX);
  assert.equal(f.openRequestCount, 14);
  // Jim (slices 4/4b/5 follow-up 1): the awaitingReply list has the same cap, with its full count.
  act('andy-1', many.map((m) => m.id));
  f = R.fleetMailFields(hive.mail, 'andy-1');
  assert.equal(f.awaitingReplyCount, 15, 'q (requires_reply) + the 14 acted requests');
  assert.equal(f.awaitingReply.length, R.FLEET_OBLIGATIONS_MAX);
  assert.deepEqual(f.awaitingReply.map((o) => o.id)[0], q.id, 'oldest first');
});

// ── #9 / #13 / #12: standup, god actionable, digest ─────────────────────────────────────────

test('#9/#13: actionable = ledger not-acted minus system senders; handled mail stops counting at acted, not at a file move', async (t) => {
  const { hive, dir, act } = await floor(t);
  const w = hive.send({ to: 'god-1', act: 'inform', subject: 'worker result', body: 'r' }, 'andy-1');
  hive.send({ to: 'god-1', act: 'request', subject: 'Heartbeat', body: 'digest' }, 'heartbeat');
  hive.send({ to: 'god-1', act: 'request', subject: 'standup', body: 's' }, 'scheduler');
  assert.equal(R.actionableBacklog(hive.mail, 'god-1'), 1);
  // god (1.1.74 habit) moves the file itself: NOT handled in the ledger (inject mode).
  fs.renameSync(dir('god-1', 'inbox', `${w.id}.json`), dir('god-1', 'inbox', '.done', `${w.id}.json`));
  assert.equal(R.actionableBacklog(hive.mail, 'god-1'), 1);
  act('god-1', [w.id]);
  assert.equal(R.actionableBacklog(hive.mail, 'god-1'), 0);
  assert.equal(R.hasBacklog(hive.mail, 'god-1'), true, '#12: the system mail is still not acted');
  assert.equal(R.hasBacklog(hive.mail, 'andy-1'), false);
});

test('#13 gate (Creed Q23): the re-engage count is DELIVERED mail only (minus system senders); mail god is already shown does not re-engage it', async (t) => {
  const { hive, act } = await floor(t);
  const w = hive.send({ to: 'god-1', act: 'inform', subject: 'worker result', body: 'r' }, 'andy-1');
  hive.send({ to: 'god-1', act: 'request', subject: 'Heartbeat', body: 'digest' }, 'heartbeat');
  assert.equal(R.actionablePending(hive.mail, 'god-1'), 1);
  hive.mail.claimSurfacing('god-1', [w.id], 'mid', 'PostToolUse');
  assert.equal(R.actionablePending(hive.mail, 'god-1'), 0, 'surfacing: god is looking at it');
  assert.equal(R.actionableBacklog(hive.mail, 'god-1'), 1, 'the standup / digest count still has it until acted');
  hive.mail.confirmSurfaced('god-1', [w.id], 'mid', 'evidence');
  assert.equal(R.actionablePending(hive.mail, 'god-1'), 0, 'surfaced');
  hive.mail.closeEpoch('god-1', 'mid', 'abnormal', { reason: 'interrupted' });
  assert.equal(R.actionablePending(hive.mail, 'god-1'), 1, 're-delivered: counts again');
  act('god-1', [w.id]);
  assert.equal(R.actionablePending(hive.mail, 'god-1'), 0);
});

test('#9: a ledger that throws is a failure to observe, not a zero', () => {
  const broken = { backlog: () => { throw new Error('boom'); } };
  assert.throws(() => R.actionableBacklog(broken, 'x'), /boom/);
});

// ── #10 / #11: activity and coordination (C8) ───────────────────────────────────────────────

test('#10/#11 (C8): a harness rename into .done is neither floor activity nor the agent coordinating', async (t) => {
  const { hive, dir, act } = await floor(t);
  const m = hive.send({ to: 'andy-1', act: 'inform', subject: 'x', body: 'y' }, 'god-1');
  const delivered = R.floorMailActivityAt(hive.mail, ['god-1', 'andy-1']).at;
  assert.equal(typeof delivered, 'number', 'a delivery is activity (the sender acted)');
  assert.equal(R.mailCoordinationAt(hive.mail, 'andy-1'), 0, 'a delivery is not THIS agent coordinating');
  await sleep(15);
  act('andy-1', [m.id]);
  const acted = hive.mail.lastActedAt('andy-1');
  assert.ok(acted > delivered);
  assert.equal(R.mailCoordinationAt(hive.mail, 'andy-1'), acted, '#11: the acted transition is the coordination signal');
  assert.equal(R.floorMailActivityAt(hive.mail, ['andy-1']).at, acted);
  // Harness-only events afterwards: the archive rename (retried), a back-edge, a restart.
  await sleep(15);
  const n = hive.send({ to: 'andy-1', act: 'inform', subject: 'x2', body: 'y2' }, 'god-1');
  const afterDelivery = hive.mail.lastActivityAt('andy-1');
  await sleep(15);
  hive.mail.claimSurfacing('andy-1', [n.id], 'e-late', 'PostToolUse');
  const afterClaim = hive.mail.lastActivityAt('andy-1');
  await sleep(15);
  hive.mail.closeEpoch('andy-1', 'e-late', 'abnormal', { reason: 'pty-exit' });   // harness back-edge
  fs.renameSync(dir('andy-1', 'inbox', `${n.id}.json`), dir('andy-1', 'inbox', '.done', `${n.id}.json`)); // a rename
  hive.mail.flush('andy-1');
  assert.ok(afterClaim >= afterDelivery);
  assert.equal(hive.mail.lastActivityAt('andy-1'), afterClaim, 'the back-edge and the rename moved nothing');
  assert.equal(R.mailCoordinationAt(hive.mail, 'andy-1'), acted, 'no new acted: no new coordination');
  // ...while the inbox/.done directory mtimes (the 1.1.74 signal) did move.
  assert.ok(fs.statSync(dir('andy-1', 'inbox', '.done')).mtimeMs >= acted);
});

test('#10: an unreadable ledger is reported, so the caller can fall back (never a false "quiet")', () => {
  const mail = { lastActivityAt: (id) => { if (id === 'bad') throw new Error('x'); return id === 'a' ? 5 : null; } };
  assert.deepEqual(R.floorMailActivityAt(mail, ['a', 'bad', 'c']), { at: 5, failed: ['bad'] });
  assert.deepEqual(R.floorMailActivityAt(mail, []), { at: null, failed: [] });
  assert.equal(R.mailCoordinationAt({ lastActedAt: () => { throw new Error('x'); } }, 'a'), 0);
});

// ── #14 voice completion watcher ─────────────────────────────────────────────────────────────

test('#14: a done-reply archived at god\'s Stop is still seen by the completion watcher (ledger entries, any state)', async (t) => {
  const { hive, act } = await floor(t);
  const dispatchedAt = Date.now() - 1000;
  const reply = hive.send({ to: 'god-1', act: 'done', subject: 'Z done', body: 'ok', in_reply_to: 'disp-1' }, 'andy-1');
  act('god-1', [reply.id]);
  assert.deepEqual(hive.inbox('god-1').filter((m) => m.id === reply.id), [], 'the file left inbox/');
  const msgs = R.ledgerInboxMessages(hive.mail, 'god-1');
  const got = msgs.find((m) => m.id === reply.id);
  assert.deepEqual({ from: got.from, in_reply_to: got.in_reply_to, act: got.act }, { from: 'andy-1', in_reply_to: 'disp-1', act: 'done' });
  const res = detectCompletion({ correlationId: 'c', targetAgentId: 'andy-1', dispatchedAt, dispatchMessageId: 'disp-1' }, { tasks: [], inbox: msgs });
  assert.equal(res.done, true);
  assert.equal(res.messageId, reply.id);
  // Work orders have no inbox message: not listed.
  hive.mail.recordWorkOrder('god-1', { id: 'wo-9', from: 'andy-1', act: 'inform', subject: 'w', body: 'x' });
  assert.ok(!R.ledgerInboxMessages(hive.mail, 'god-1').some((m) => m.id === 'wo-9'));
});

// ── #15 Threads ─────────────────────────────────────────────────────────────────────────────

test('#15: mailHistory lists inbox/ AND .done/ with the ledger state as a column, so the view does not empty at Stop', async (t) => {
  const { hive, dir, act } = await floor(t);
  const a = hive.send({ to: 'andy-1', act: 'request', subject: 'first', body: '1', conversation: 'c1' }, 'god-1');
  const b = hive.send({ to: 'andy-1', act: 'inform', subject: 'second', body: '2', conversation: 'c1' }, 'god-1');
  // An old handled file from before 1.1.75: .done, no ledger entry.
  fs.writeFileSync(dir('andy-1', 'inbox', '.done', 'old-1.json'), JSON.stringify({ id: 'old-1', from: 'god-1', to: 'andy-1', act: 'inform', subject: 'old', body: 'o', conversation: 'c0', created_at: '2026-01-01T00:00:00.000Z' }));
  act('andy-1', [a.id]);
  const rows = hive.mailHistory('andy-1');
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), [a.id, b.id, 'old-1'].sort());
  assert.deepEqual([by[a.id].mail_state, by[a.id].archived], ['acted', true]);
  assert.deepEqual([by[b.id].mail_state, by[b.id].archived], ['delivered', false]);
  assert.deepEqual([by['old-1'].mail_state, by['old-1'].archived], ['archived', true]);
  assert.equal(by[a.id].body, '1', 'the body is there for the panel');
  // Everything handled: the panel still has the history.
  act('andy-1', [b.id]);
  assert.equal(hive.inbox('andy-1').length, 0);
  assert.equal(hive.mailHistory('andy-1').length, 3);
  // Bounded: inbox first, then the newest .done files.
  assert.equal(hive.mailHistory('andy-1', { limit: 1 }).length, 1);
});

// ── #5 L2 supersede "unread" ────────────────────────────────────────────────────────────────

test('#5 (L2): "unread" is the sender\'s LEDGER: a cancel already SURFACED into its context is not unread, even though its file is still in inbox/', async (t) => {
  const { hive, dir } = await floor(t);
  const ask = hive.send({ to: 'andy-1', act: 'request', subject: 'X', body: 'x' }, 'god-1');
  const cancel = hive.send({ to: 'andy-1', act: 'request', subject: 'cancel X', body: 'stop', supersedes: [ask.id] }, 'god-1');
  hive.mail.claimSurfacing('andy-1', [cancel.id], 'turn-1', 'PostToolUse');
  hive.mail.confirmSurfaced('andy-1', [cancel.id], 'turn-1', 'evidence');
  assert.ok(fs.existsSync(dir('andy-1', 'inbox', `${cancel.id}.json`)), 'still in inbox/ (acted only at Stop)');
  fs.writeFileSync(dir('andy-1', 'outbox', 'r1.json'), JSON.stringify({ to: 'god', act: 'inform', subject: 'X anyway', in_reply_to: ask.id }));
  hive.routeOnce();
  const got = hive.inbox('god-1').find((m) => m.in_reply_to === ask.id);
  assert.equal(got.superseded_by, undefined, 'the reply was sent knowingly');
  assert.equal(got.subject, 'X anyway');
});

test('#5 (L2): a cancel still DELIVERED in the ledger flags the reply; the router parses no inbox file for it', async (t) => {
  const { hive, dir } = await floor(t);
  const ask = hive.send({ to: 'andy-1', act: 'request', subject: 'X', body: 'x' }, 'god-1');
  const cancel = hive.send({ to: 'andy-1', act: 'request', subject: 'cancel X', body: 'stop', supersedes: [ask.id] }, 'god-1');
  // Corrupt the file body: the ledger alone carries id/from/subject/supersedes.
  fs.writeFileSync(dir('andy-1', 'inbox', `${cancel.id}.json`), '{ not json');
  fs.writeFileSync(dir('andy-1', 'outbox', 'r2.json'), JSON.stringify({ to: 'god', act: 'inform', subject: 'X done', in_reply_to: ask.id }));
  hive.routeOnce();
  const got = hive.inbox('god-1').find((m) => m.in_reply_to === ask.id);
  assert.equal(got.superseded_by, cancel.id);
  assert.match(got.subject, /^\[superseded by .* \(god-1: cancel X\): sent before andy-1 read it\] X done$/);
});

// ── index.ts / renderer call sites (index.ts is an Electron entry: pinned by source) ──────────

const INDEX = codeOnly(readSource('src/main/index.ts'), 'index.ts');
const fn = (name, end) => {
  const i = INDEX.indexOf(name);
  assert.ok(i >= 0, `found ${name}`);
  return INDEX.slice(i, end ? INDEX.indexOf(end, i) : i + 2500);
};

test('PIN #9: collectFloorState counts the ledger (actionableBacklog), not hive.inbox()', () => {
  const body = fn('function collectFloorState', 'const countDir');
  assert.match(body, /actionableInbox = actionableBacklog\(hive\.mail, id\)/);
  assert.ok(!/hive\.inbox\(/.test(body));
});

test('PIN #10/#12/#13 (ZT-I4): the heartbeat that read them is retired; no quiet/stuck heuristic or re-engage digest remains', () => {
  // isFloorQuiet, looksStuck, buildHeartbeatDigest, godActionableInboxCount and reengageGod were
  // the heartbeat's; the floor digest (floorDigest.ts) replaces them and wakes god for decisions only.
  for (const gone of ['function isFloorQuiet', 'function looksStuck', 'function buildHeartbeatDigest', 'function godActionableInboxCount', 'function reengageGod', 'function armHeartbeat']) {
    assert.ok(!INDEX.includes(gone), `${gone} is retired`);
  }
  assert.match(INDEX, /if \(m\.kind === 'heartbeat'\) continue;/, 'a heartbeat mission is never armed');
});

test('PIN #11: lastCoordinationAt = acted transitions + own outbox/memory writes; no inbox or .done mtime', () => {
  const body = fn('function lastCoordinationAt', 'hive.setHumanInputSource');
  assert.match(body, /mailCoordinationAt\(hive\.mail, agentId\)/);
  assert.ok(!/'inbox'|'\.done'/.test(body), body);
  assert.match(body, /'outbox'/);
});


test('PIN #6: fleet.json rows carry the ledger mail fields (backlog, awaitingReply, openRequests)', () => {
  assert.match(fn('function fleetMail(', 'function writeFleetSnapshot'), /fleetMailFields\(hive\.mail, id\)/);
  assert.match(fn('function writeFleetSnapshot', 'function armHeartbeat'), /\.\.\.fleetMail\(id\)/);
});

test('PIN #14: the completion watcher reads god\'s ledger entries as well as the inbox files', () => {
  assert.match(fn('initCompletionWatcher({', 'onNotify'), /ledgerInboxMessages\(hive\.mail, godId\)/);
});

test('PIN #15/#16: hive:inbox returns mailHistory (inbox + .done + state); the queue precondition asks hive:mailPending', () => {
  assert.match(fn("ipcMain.handle('hive:inbox'", "ipcMain.handle('hive:mailPending'"), /hive\.mailHistory\(id, \{ archived \}\)/);
  assert.match(fn("ipcMain.handle('hive:mailPending'", '\n'), /mailPendingIds\(id\)/);
  const useHive = codeOnly(readSource('src/renderer/src/hooks/useHive.ts'), 'useHive.ts');
  assert.match(useHive, /checkPrecondition\(next, \(\) => window\.cth\.hiveMailPending\(srcId\)\)/);
  assert.ok(!/hiveInbox\(/.test(useHive), 'the renderer queue no longer reads the inbox listing');
  assert.match(readSource('src/preload/index.ts'), /hiveMailPending: \(id: string\): Promise<string\[\]> => ipcRenderer\.invoke\('hive:mailPending', id\)/);
});

test('PIN: no main-process reader counts inbox/ files as "unhandled" any more (hive.inbox( only where justified)', () => {
  // Allowed: the legacy-move / work-order fallback of the coordinator's pending source (§11.7)
  // and the voice watcher's own inbox files (michael-voice, plus god's files alongside its
  // ledger entries). (#12's ledger-failure fallback left with the retired heartbeat, ZT-I4.)
  const calls = [...INDEX.matchAll(/hive\.inbox\(/g)].length;
  assert.equal(calls, 3, 'a new hive.inbox( reader must read the ledger or be justified in NOTES');
});
