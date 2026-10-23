'use strict';

/**
 * HEAVY-HANDOFF-RACE (god, conv-af1bba, 2026-10-23). Three heavy-lock handoff faults, each seen live
 * (hive log.jsonl, kind heavy-lock):
 *  (a) 2026-10-22T22:22Z: Jim's background pack ended, the auto-release ('job-exit') reserved the slot
 *      for the queue head (Andy), and Jim's `heavy release --to creed` right after it found "nothing
 *      to release": the cut's priority was lost. Now `heavy next <agent>` (op 'next') names the NEXT
 *      holder AHEAD of time, by a holder, an agent with a slot reserved, or god; the release at the
 *      job's end honours it (a queued agent moves to the head now; one not queued yet goes to the
 *      head when it next asks).
 *  (b) 2026-10-23T03:25Z (and 2026-10-22T23:37Z): Creed's cut hold was released 'expired-still-running'
 *      at the 1 h TTL while creed-cut199-run.sh still ran; the lock showed free and reserved the slot
 *      on. Now a hold the watcher last SAW running is RENEWED at the hour ('ttl-renewed'), never freed
 *      on age alone; its process exit frees it. A hold never seen running still expires ('ttl').
 *  (c) 2026-10-23T04:33Z: Creed's reservation lapsed while he was idle; he was dropped and kept waiting
 *      for a notice that never came. 12:17Z: Dwight's bench had run and freed the slot, and he believed
 *      he was still queued while heavy status showed him absent. Now a lapsed reservation QUEUES ITS
 *      OWNER AGAIN at the back, once ('queue-again'; told 'requeued', or "HEAVY SLOT FREE" again when
 *      the slot is still free); the second unused reservation drops it, told plainly. `heavy status`
 *      says the caller's own standing (`you`), and the deny text says the same.
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const { HookServer } = loadTs('src/main/hooks.ts');
const CLI = require('../../resources/heavy-cli.cjs');
const H = { heavy: true, kind: 'suite' };
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hhr199-'));
test.after(() => { try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* best effort */ } });

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = []; const lapses = [];
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), notifyLapse: (a, k, why) => lapses.push([a, k, why]),
    alive: () => true, ...extra
  });
  const status = async (a) => l.lease(a, { op: 'status' });
  return { l, logs, notes, lapses, status, tick: (ms) => { now += ms; }, now: () => now, rows: (action) => logs.filter((r) => r.action === action) };
}
const waiters = (x) => x.l.queueSnapshot().waiters.map((w) => w.agentId);
const reservedFor = (x) => x.l.queueSnapshot().reserved.map((r) => r.agentId);

const K = {};

// ── (a) heavy next <agent> ──────────────────────────────────────────────────────────────────

K.nextHonoured = async (M = HJ) => {
  // The live shape: Jim's pack ran in a held job; Andy then Creed were denied behind it.
  const x = rig(M);
  x.l.acquire('jim', H, 'sh pack.sh &', 'j1', true);
  x.l.noteJob('jim', 'j1', 'job-1');
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  x.l.acquire('creed', H, 'npm test', 'c1', false);
  const a = await x.l.lease('jim', { op: 'next', to: 'creed' });
  assert.deepEqual(a, { state: 'next', to: 'creed', queued: true }, 'THE HOLDER NAMES THE NEXT HOLDER AHEAD OF TIME');
  assert.deepEqual(x.rows('next'), [{ kind: 'heavy-lock', action: 'next', agentId: 'jim', to: 'creed', queued: true }], 'THE NAME IS LOGGED');
  assert.deepEqual(waiters(x), ['creed', 'andy'], 'A QUEUED AGENT MOVES TO THE HEAD NOW');
  assert.equal((await x.status('jim')).next, 'creed', 'heavy status SHOWS THE NAME');
  // The job ends: the auto-release reserves the slot for the named agent, not the oldest waiter.
  x.l.jobExited('jim', 'j1', 'job-1');
  assert.equal(x.logs.find((r) => r.action === 'release').reason, 'job-exit');
  assert.deepEqual(reservedFor(x), ['creed'], 'THE AUTO-RELEASE HONOURS heavy next');
  assert.deepEqual(x.notes.map((n) => n.a), ['creed'], 'and the named agent is told HEAVY SLOT FREE');
  assert.deepEqual(waiters(x), ['andy']);
  assert.equal((await x.status('jim')).next, null, 'THE NAME IS FORGOTTEN ONCE RESERVED');
  // A later `heavy release --to` cannot outrank a standing name: the queue is re-read at every grant.
  const y = rig(M);
  y.l.acquire('a', H, 'npm ci', 'a1', false);
  for (const q of ['b', 'creed', 'andy']) y.l.acquire(q, H, 'npm ci', `${q}1`, false);
  y.l.callDone('a', 'a1');
  assert.deepEqual(reservedFor(y), ['b']);
  await y.l.lease('b', { op: 'next', to: 'creed' });
  // b (reserved) hands its slot to andy by name: the standing name still wins at the grant.
  const u = await y.l.lease('b', { op: 'unreserve', to: 'andy' });
  assert.equal(u.next, 'creed', 'THE AUTO-RELEASE HONOURS heavy next over release --to');
  assert.deepEqual(waiters(y), ['andy']);
};
test('(a) `heavy next <agent>`: a holder names the next holder ahead of time and the release at the job end honours it', () => K.nextHonoured());

K.nextAhead = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  const a = await x.l.lease('jim', { op: 'next', to: 'creed' });
  assert.deepEqual(a, { state: 'next', to: 'creed', queued: false }, 'AN AGENT NOT QUEUED YET IS NAMED');
  assert.deepEqual(waiters(x), ['andy'], 'IT IS NOT QUEUED FOR IT (a deny is what tells an agent to wait)');
  const d = x.l.acquire('creed', H, 'bash cut.sh', 'c1', false);
  assert.equal(d.allow, false);
  assert.match(d.reason, /You are QUEUED \(position 1\)/, 'THE NAMED AGENT GOES TO THE HEAD WHEN IT ASKS');
  assert.deepEqual(waiters(x), ['creed', 'andy'], 'THE NAMED AGENT GOES TO THE HEAD WHEN IT ASKS');
  x.l.callDone('jim', 'j1');
  assert.deepEqual(reservedFor(x), ['creed'], 'THE AUTO-RELEASE HONOURS heavy next');
  // Named while the slot is free (nothing to wait for): it simply takes the slot, and the name goes.
  const y = rig(M, { isGod: (a) => a === 'god' });
  await y.l.lease('god', { op: 'next', to: 'creed' });
  assert.equal((await y.status('god')).next, 'creed');
  assert.equal(y.l.acquire('creed', H, 'bash cut.sh', 'c1', false).allow, true);
  assert.equal((await y.status('god')).next, null, 'THE NAME IS FORGOTTEN ONCE IT HOLDS');
  y.l.callDone('creed', 'c1');
  assert.equal(y.l.acquire('andy', H, 'npm test', 'a1', false).allow, true);
  assert.equal(y.l.acquire('creed', H, 'npm test', 'c2', false).allow, false);
  assert.deepEqual(waiters(y), ['creed'], 'and creed waits in queue order afterwards');
};
test('(a) an agent not queued yet goes to the head when it next asks; the name goes once it holds', () => K.nextAhead());

K.nextWho = async (M = HJ) => {
  const x = rig(M, { isGod: (a) => a === 'god' });
  x.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  x.l.acquire('creed', H, 'npm test', 'c1', false);
  x.l.acquire('dwight', H, 'npm test', 'd1', false);
  const no = await x.l.lease('andy', { op: 'next', to: 'dwight' });
  assert.deepEqual(no, { state: 'next', to: 'dwight', queued: true, refused: 'not-a-holder' }, 'ONLY A HOLDER, A RESERVED AGENT OR GOD MAY NAME THE NEXT HOLDER');
  assert.deepEqual(waiters(x), ['andy', 'creed', 'dwight'], 'ONLY A HOLDER, A RESERVED AGENT OR GOD: a queued agent changes nothing');
  assert.equal((await x.status('andy')).next, null);
  assert.deepEqual(x.rows('next').at(-1), { kind: 'heavy-lock', action: 'next', agentId: 'andy', to: 'dwight', queued: true, refused: 'not-a-holder' }, 'a refusal is logged');
  assert.deepEqual(await x.l.lease('jim', { op: 'next', to: 'jim' }), { state: 'next', to: 'jim', queued: false, refused: 'self' }, 'NOT ONESELF');
  const g = await x.l.lease('god', { op: 'next', to: 'dwight' });
  assert.deepEqual(g, { state: 'next', to: 'dwight', queued: true }, 'GOD MAY NAME THE NEXT HOLDER WITHOUT HOLDING A SLOT');
  assert.deepEqual(waiters(x), ['dwight', 'andy', 'creed']);
  // A later name replaces it.
  await x.l.lease('god', { op: 'next', to: 'creed' });
  assert.deepEqual(waiters(x), ['creed', 'dwight', 'andy'], 'A LATER NAME REPLACES IT');
  x.l.callDone('jim', 'j1');
  assert.deepEqual(reservedFor(x), ['creed']);
  // A reserved agent may name who follows it.
  assert.deepEqual(await x.l.lease('creed', { op: 'next', to: 'andy' }), { state: 'next', to: 'andy', queued: true }, 'A RESERVED AGENT MAY NAME THE NEXT HOLDER');
  assert.deepEqual(waiters(x), ['andy', 'dwight']);
  // A gone named agent is forgotten.
  x.l.agentGone('andy');
  assert.equal((await x.status('god')).next, null, 'A GONE AGENT IS FORGOTTEN');
  // Absent isGod: no one is god. A god check that throws refuses (never breaks the lock).
  const y = rig(M);
  assert.equal((await y.l.lease('god', { op: 'next', to: 'creed' })).refused, 'not-a-holder', 'ABSENT isGod: NO ONE IS GOD');
  const z = rig(M, { isGod: () => { throw new Error('registry down'); } });
  assert.equal((await z.l.lease('god', { op: 'next', to: 'creed' })).refused, 'not-a-holder', 'A GOD CHECK THAT THROWS REFUSES');
  await assert.rejects(() => z.l.lease('god', { op: 'next' }), /heavy next needs an agent/, 'no agent: refused on the route');
};
test('(a) who may name: a holder, a reserved agent, or god; not a queued agent, not oneself; a gone name is forgotten', () => K.nextWho());

// ── (b) the TTL never frees a hold seen running ──────────────────────────────────────────────

/** A watcher rig: the agent's PTY root (pid 10) and, while `s.running`, its test process (pid 11). */
function watched(M = HJ) {
  const s = { running: true };
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const child = { pid: 11, parentPid: 10, commandLine: 'bash creed-cut199-run.sh', createdMs: 1_000_100 };
  const x = rig(M, { roots: () => [{ agentId: 'creed', pid: 10 }], probe: async () => (s.running ? [root, child] : [root]) });
  return { ...x, s };
}

K.ttlRenewed = async (M = HJ) => {
  const x = watched(M);
  x.l.acquire('creed', H, 'bash creed-cut199-run.sh &', 'c1', true);
  await x.l.scan();
  x.l.acquire('jim', H, 'npm ci', 'j1', false);
  x.tick(M.HEAVY_TTL_MS);
  assert.equal(x.l.snapshot().length, 1, 'A HOLD SEEN RUNNING IS RENEWED AT THE HOUR, NOT FREED');
  assert.deepEqual(x.rows('ttl-renewed'), [{ kind: 'heavy-lock', action: 'ttl-renewed', agentId: 'creed', heavyKind: 'suite', heldMs: M.HEAVY_TTL_MS }], 'A HOLD SEEN RUNNING IS RENEWED AT THE HOUR (logged)');
  assert.deepEqual(x.rows('release'), [], 'NEVER FREED ON AGE ALONE');
  assert.deepEqual(reservedFor(x), [], 'the slot is not passed on');
  assert.equal(x.l.acquire('dwight', H, 'npm test', 'd1', false).allow, false, 'THE SLOT IS NOT FREE');
  // Once per hour: a read a minute later does not renew again.
  x.tick(60_000);
  x.l.snapshot();
  assert.equal(x.rows('ttl-renewed').length, 1, 'RENEWED ONCE PER HOUR');
  // The second hour, still running: renewed again.
  await x.l.scan();
  x.tick(M.HEAVY_TTL_MS - 60_000);
  await x.l.scan();
  assert.equal(x.rows('ttl-renewed').length, 2, 'RENEWED AGAIN WHILE IT RUNS');
  assert.equal(x.rows('ttl-renewed')[1].heldMs, 2 * M.HEAVY_TTL_MS);
  // Its process exits: the watcher frees it (two clean scans), and the queue is served.
  x.s.running = false;
  for (let i = 0; i < 3; i++) { x.tick(M.HEAVY_SCAN_MS); await x.l.scan(); }
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['process-exit'], 'ITS PROCESS EXIT FREES IT');
  assert.deepEqual(reservedFor(x), ['jim']);
};
test('(b) a hold the watcher last SAW running is renewed at the hour (ttl-renewed), never freed on age; its process exit frees it', () => K.ttlRenewed());

K.ttlNeverSeen = async (M = HJ) => {
  // No watcher (no roots): the TTL stands.
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci &', 'a1', true);
  x.tick(M.HEAVY_TTL_MS);
  x.l.snapshot();
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['ttl'], 'A HOLD NEVER SEEN RUNNING STILL EXPIRES');
  assert.deepEqual(x.rows('ttl-renewed'), []);
  assert.ok(!readSource(HJF).includes("'expired-still-running'"), "no 'expired-still-running' release is left");
  // Seen running, then seen idle (one miss so far): the TTL frees it as before.
  const y = watched(M);
  y.l.acquire('creed', H, 'bash run.sh &', 'c1', true);
  await y.l.scan();
  y.s.running = false;
  y.tick(M.HEAVY_SCAN_MS);
  await y.l.scan();
  assert.equal(y.l.snapshot().length, 1, 'one miss keeps it');
  y.tick(M.HEAVY_TTL_MS);
  y.l.snapshot();
  assert.deepEqual(y.rows('release').map((r) => r.reason), ['ttl'], 'LAST SEEN IDLE: THE TTL FREES IT');
};
test('(b) a hold never seen running (no watcher, or last seen idle) still expires at the hour', () => K.ttlNeverSeen());

// ── (c) a lapsed reservation queues its owner again, once ────────────────────────────────────

K.requeueOnce = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('h', H, 'npm ci', 'h1', false);
  x.l.acquire('creed', H, 'npm test', 'c1', false);
  x.l.acquire('dwight', H, 'npm test', 'd1', false);
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  x.l.callDone('h', 'h1');
  assert.deepEqual(reservedFor(x), ['creed']);
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(waiters(x), ['andy', 'creed'], 'THE OWNER IS QUEUED AGAIN AT THE BACK');
  assert.deepEqual(x.lapses, [['creed', 'suite', 'requeued']], 'THE OWNER IS QUEUED AGAIN AT THE BACK AND TOLD SO');
  assert.deepEqual((await x.status('creed')).you, { holding: false, reserved: null, position: 2 }, 'heavy status AGREES WITH WHAT IT WAS TOLD');
  assert.deepEqual(x.logs.slice(-3).map((r) => [r.action, r.agentId]), [['reserve-expired', 'creed'], ['queue-again', 'creed'], ['reserve', 'dwight']]);
  assert.deepEqual(x.rows('queue-again'), [{ kind: 'heavy-lock', action: 'queue-again', agentId: 'creed', heavyKind: 'suite', position: 3 }], 'the position counts dwight, still queued at that moment');
  // Not an ordinary deny: a re-deny keeps its (new) place.
  assert.equal(x.l.acquire('creed', H, 'npm test', 'c2', false).allow, false);
  assert.deepEqual(waiters(x), ['andy', 'creed']);
  // dwight then andy run; the slot comes back to creed, reserved again and told HEAVY SLOT FREE again.
  x.l.acquire('dwight', H, 'npm test', 'd2', false);
  x.l.callDone('dwight', 'd2');
  assert.deepEqual(reservedFor(x), ['andy']);
  x.l.acquire('andy', H, 'npm test', 'a2', false);
  x.l.callDone('andy', 'a2');
  assert.deepEqual(reservedFor(x), ['creed']);
  assert.deepEqual(x.notes.map((n) => n.a), ['creed', 'dwight', 'andy', 'creed']);
  assert.deepEqual((await x.status('creed')).you, { holding: false, reserved: new Date(x.now() + M.HEAVY_RESERVE_MS).toISOString(), position: null });
  // Unused again: out, told plainly; heavy status agrees.
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(waiters(x), [], 'THE SECOND LAPSE DROPS IT');
  assert.deepEqual(x.lapses, [['creed', 'suite', 'requeued'], ['creed', 'suite', 'expired']], 'THE SECOND LAPSE DROPS IT, TOLD PLAINLY');
  assert.deepEqual(x.logs.at(-1), { kind: 'heavy-lock', action: 'reserve-expired', agentId: 'creed', heavyKind: 'suite', again: true });
  assert.deepEqual((await x.status('creed')).you, { holding: false, reserved: null, position: null }, 'heavy status AGREES: not queued');
  assert.equal(x.rows('queue-again').length, 1, 'queued again ONCE');
};
test('(c) a lapsed reservation queues its owner again at the back, once, and tells it; the second lapse drops it, told plainly', () => K.requeueOnce());

K.requeueAlone = async (M = HJ) => {
  // No one else waits: the slot is reserved for it again at once, and it is told HEAVY SLOT FREE again.
  const x = rig(M);
  x.l.acquire('h', H, 'npm ci', 'h1', false);
  x.l.acquire('creed', H, 'npm test', 'c1', false);
  x.l.callDone('h', 'h1');
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(x.logs.slice(-3).map((r) => r.action), ['reserve-expired', 'queue-again', 'reserve']);
  assert.deepEqual(x.notes.map((n) => n.a), ['creed', 'creed'], 'TOLD HEAVY SLOT FREE AGAIN');
  assert.deepEqual(x.lapses, [], 'TOLD HEAVY SLOT FREE AGAIN, NOT REQUEUED');
  assert.deepEqual(reservedFor(x), ['creed']);
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(x.lapses, [['creed', 'suite', 'expired']], 'THE SECOND LAPSE DROPS IT, TOLD PLAINLY');
  assert.deepEqual(reservedFor(x), []);
};
test('(c) alone in the queue, the lapsed owner is reserved again at once (HEAVY SLOT FREE again); the second lapse drops it', () => K.requeueAlone());

K.requeueNot = async (M = HJ) => {
  // An owner queued only by its waiting test process (no PreToolUse deny): its process asks again by itself.
  const x = rig(M);
  x.l.acquire('h', H, 'npm ci', 'h1', false);
  x.l.acquire('p', H, 'node --test (pid 5)', 'lease:5:1', false);
  x.l.acquire('q', H, 'npm test', 'q1', false);
  x.l.callDone('h', 'h1');
  assert.deepEqual(reservedFor(x), ['p']);
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(waiters(x), [], 'A LEASE-ONLY OWNER IS NOT QUEUED AGAIN');
  assert.deepEqual(reservedFor(x), ['q']);
  assert.deepEqual(x.lapses, [], 'and not told (it was never told to wait for a notice)');
  // A gone owner: the slot passes on; nothing to queue or tell.
  let gone = false;
  const y = rig(M, { alive: (a) => !(gone && a === 'creed') });
  y.l.acquire('h', H, 'npm ci', 'h1', false);
  y.l.acquire('creed', H, 'npm test', 'c1', false);
  y.l.acquire('dwight', H, 'npm test', 'd1', false);
  y.l.callDone('h', 'h1');
  gone = true;
  y.tick(M.HEAVY_RESERVE_MS);
  y.l.queueSnapshot();
  assert.deepEqual(waiters(y), [], 'A GONE OWNER IS NOT QUEUED AGAIN');
  assert.deepEqual(y.rows('queue-again'), [], 'A GONE OWNER IS NOT QUEUED AGAIN (no row either)');
  assert.deepEqual(reservedFor(y), ['dwight']);
  assert.deepEqual(y.lapses, []);
  // The owner's own call meets the lapse: its answer says it all (the free slot is its).
  const z = rig(M);
  z.l.acquire('h', H, 'npm ci', 'h1', false);
  z.l.acquire('creed', H, 'npm test', 'c1', false);
  z.l.callDone('h', 'h1');
  z.tick(M.HEAVY_RESERVE_MS);
  assert.equal(z.l.acquire('creed', H, 'npm test', 'c2', false).allow, true, 'THE CALLER TAKES THE SLOT ITSELF');
  assert.deepEqual(z.rows('queue-again'), [], 'THE CALLER IS NOT QUEUED AGAIN');
  assert.deepEqual(z.lapses, []);
};
test('(c) not queued again: a lease-only owner, a gone owner, or the caller whose own call meets the lapse', () => K.requeueNot());

K.wordsAgree = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('h', H, 'npm ci', 'h1', false);
  const d = x.l.acquire('creed', H, 'npm test', 'c1', false);
  assert.match(d.reason, /until you are told\. A reservation you leave unused for 5 min passes on and queues you again at the back, once; `heavy status` shows your standing and `heavy release` leaves the queue\.$/, 'THE DENY TEXT SAYS A LAPSE QUEUES AGAIN ONCE');
  const r = M.heavyWaitLapsedNotice('creed', 'bench', 'requeued');
  assert.equal(r.message.subject, 'HEAVY SLOT LAPSED: the bench slot reserved for you was not used in 5 min; you are queued again, at the back');
  assert.match(r.message.body, /You are QUEUED AGAIN, at the back, once: when a slot frees it is reserved for you again and you are told "HEAVY SLOT FREE"; a second unused reservation takes you out of the queue\./, 'THE REQUEUED NOTICE SAYS ONCE');
  assert.match(r.message.body, /`heavy release` to leave the queue; `heavy status` shows your place/);
  assert.deepEqual({ to: r.message.to, act: r.message.act, requires_reply: r.message.requires_reply, wake: r.message.wake, from: r.from, steer: r.steer }, { to: 'creed', act: 'inform', requires_reply: false, wake: 'now', from: 'system', steer: `${r.message.subject}.` }, 'the same rails as HEAVY SLOT FREE');
  const e = M.heavyWaitLapsedNotice('creed', 'bench', 'expired');
  assert.match(e.message.subject, /you are no longer queued$/);
  assert.match(e.message.body, /You are NOT queued: if you still need your bench, run it again to queue again \(`heavy status` shows your standing\)/, 'THE EXPIRED NOTICE SAYS NOT QUEUED');
  // heavy status: the caller's own standing in every state.
  assert.deepEqual((await x.status('h')).you, { holding: true, reserved: null, position: null }, 'you: holding');
  assert.deepEqual((await x.status('creed')).you, { holding: false, reserved: null, position: 1 }, 'you: queued');
  x.l.callDone('h', 'h1');
  assert.deepEqual((await x.status('creed')).you, { holding: false, reserved: new Date(x.now() + M.HEAVY_RESERVE_MS).toISOString(), position: null }, 'you: reserved');
  assert.deepEqual((await x.status('nobody')).you, { holding: false, reserved: null, position: null }, 'you: none');
};
test('(c) the deny text, the notices and heavy status say the same thing', () => K.wordsAgree());

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────

test('the heavy CLI: `heavy next <agent>`, and the `you:` line of `heavy status`', () => {
  assert.deepEqual(CLI.parseArgs(['next', 'creed-mukyiphw']), { op: 'next', to: 'creed-mukyiphw' });
  for (const bad of [['next'], ['next', 'a b'], ['next', '$(x)'], ['next', 'a', 'b'], ['next', '--to', 'a']]) assert.throws(() => CLI.parseArgs(bad), undefined, JSON.stringify(bad));
  assert.equal(CLI.describe({ state: 'next', to: 'creed', queued: true }), 'heavy: the next freed slot goes to creed (queued: now at the head of the queue)\n');
  assert.equal(CLI.describe({ state: 'next', to: 'creed', queued: false }), 'heavy: the next freed slot goes to creed (not queued yet: it goes to the head when it next asks)\n');
  assert.equal(CLI.describe({ state: 'next', to: 'creed', queued: false, refused: 'not-a-holder' }), 'heavy: refused: only a holder, an agent with a slot reserved, or god may name the next holder\n');
  assert.equal(CLI.describe({ state: 'next', to: 'jim', queued: false, refused: 'self' }), 'heavy: name another agent, not yourself\n');
  const st = (you, next = null) => CLI.describe({ state: 'status', holders: ['jim'], reserved: [], waiters: ['creed'], next, you });
  assert.equal(st({ holding: true, reserved: null, position: null }), 'held: jim; reserved: none; queue: creed\nyou: holding a slot (it frees when your job ends)\n');
  assert.equal(st({ holding: false, reserved: '2026-10-23T12:22:05.265Z', position: null }, 'creed'), 'held: jim; reserved: none; queue: creed; next: creed\nyou: the slot is reserved for you until 12:22:05Z (run your job now, or `heavy release`)\n');
  assert.equal(st({ holding: false, reserved: null, position: 1 }), 'held: jim; reserved: none; queue: creed\nyou: queued #1 (you are told "HEAVY SLOT FREE" when it is yours)\n');
  assert.equal(st({ holding: false, reserved: null, position: null }), 'held: jim; reserved: none; queue: creed\nyou: not queued, nothing reserved, nothing held\n');
  assert.equal(CLI.describe({ state: 'status', holders: [], reserved: [], waiters: [] }), 'held: none; reserved: none; queue: empty\n', 'an older app without `you` gets the one line');
  assert.match(CLI.describe === undefined ? '' : require('node:fs').readFileSync(require.resolve('../../resources/heavy-cli.cjs'), 'utf8'), /usage: heavy status \| heavy release \[--to <agent>\] \| heavy next <agent>\\n {2}release: [^\n]*\\n {2}next: the next freed slot goes to that agent first/);
});

async function broker(t, M) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hhr199-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  const logs = []; const notes = [];
  const lock = new M.HeavyJobLock({ limit: () => 1, log: (r) => logs.push(r), notify: (a) => notes.push(a), isGod: (a) => a === 'god' });
  s.setHeavyLock(lock);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return { lock, logs, notes, url: (a) => s.hookUrl(a).replace('/hook/', '/ledger/') };
}
async function cli(argv, env) {
  let out = ''; let err = '';
  const code = await CLI.main(argv, env, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

test('E2E: `heavy next` and the status standing over the real hook broker route and per-spawn token', { timeout: 30_000 }, async (t) => {
  const b = await broker(t, HJ);
  b.lock.acquire('jim', H, 'sh pack.sh', 'j1', false);
  b.lock.acquire('andy', H, 'npm test', 'a1', false);
  b.lock.acquire('creed', H, 'npm test', 'c1', false);
  const no = await cli(['next', 'creed'], { HIVE_LEDGER_URL: b.url('andy') });
  assert.equal(no.code, 0, no.err);
  assert.equal(no.out, 'heavy: refused: only a holder, an agent with a slot reserved, or god may name the next holder\n', 'THE TOKEN NAMES THE CALLER: a queued agent is refused');
  const ok = await cli(['next', 'creed'], { HIVE_LEDGER_URL: b.url('jim') });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, 'heavy: the next freed slot goes to creed (queued: now at the head of the queue)\n', 'THE CLI NAMES THE NEXT HOLDER OVER THE /heavy ROUTE');
  const st = await cli(['status'], { HIVE_LEDGER_URL: b.url('creed') });
  assert.equal(st.out, 'held: jim; reserved: none; queue: creed, andy; next: creed\nyou: queued #1 (you are told "HEAVY SLOT FREE" when it is yours)\n');
  b.lock.callDone('jim', 'j1');
  assert.deepEqual(b.notes, ['creed']);
  const god = await cli(['next', 'andy'], { HIVE_LEDGER_URL: b.url('god') });
  assert.equal(god.out, 'heavy: the next freed slot goes to andy (queued: now at the head of the queue)\n', 'god over the route');
  const me = await cli(['status'], { HIVE_LEDGER_URL: b.url('jim') });
  assert.match(me.out, /^held: none; reserved: creed until \d\d:\d\d:\d\dZ; queue: andy; next: andy\nyou: not queued, nothing reserved, nothing held\n$/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  // (a)
  { name: 'the grant ignores the name (required: it is re-read at every grant)', edits: [['    const ni = this.nextUp ? this.waiters.findIndex((w) => w.agentId === this.nextUp) : -1;', '    const ni = -1;']],
    killer: 'nextHonoured', dies: /THE AUTO-RELEASE HONOURS heavy next over release --to/ },
  { name: 'a named agent not queued yet joins at the back', edits: [['    if (agentId === this.nextUp) { this.waiters.unshift(this.waiters.pop()!); return 1; }\n', '']],
    killer: 'nextAhead', dies: /THE NAMED AGENT GOES TO THE HEAD WHEN IT ASKS/ },
  { name: 'the name is not kept', edits: [['    this.nextUp = to;\n', '']],
    killer: 'nextAhead', dies: /THE NAMED AGENT GOES TO THE HEAD WHEN IT ASKS/ },
  { name: 'anyone may name the next holder', edits: [["      : !(this.holders.has(agentId) || this.reservations.has(agentId) || this.isGod(agentId)) ? 'not-a-holder' as const : undefined;", '      : undefined;']],
    killer: 'nextWho', dies: /ONLY A HOLDER, A RESERVED AGENT OR GOD MAY NAME THE NEXT HOLDER/ },
  { name: 'god may not', edits: [['|| this.reservations.has(agentId) || this.isGod(agentId))', '|| this.reservations.has(agentId))']],
    killer: 'nextWho', dies: /GOD MAY NAME THE NEXT HOLDER WITHOUT HOLDING A SLOT/ },
  { name: 'a god check that throws breaks the lock', edits: [['    try { return !!this.d.isGod?.(agentId); } catch { return false; }', '    return !!this.d.isGod?.(agentId);']],
    killer: 'nextWho', dies: /A GOD CHECK THAT THROWS REFUSES|registry down/ },
  { name: 'the name outlives its reservation', edits: [['      if (w.agentId === this.nextUp) this.nextUp = null;\n', '']],
    killer: 'nextHonoured', dies: /THE NAME IS FORGOTTEN ONCE RESERVED/ },
  { name: 'the name outlives its hold', edits: [['    if (this.nextUp === agentId) this.nextUp = null;\n    this.holders.set(agentId, {', '    this.holders.set(agentId, {']],
    killer: 'nextAhead', dies: /THE NAME IS FORGOTTEN ONCE IT HOLDS/ },
  { name: 'a gone named agent is kept', edits: [['    if (this.nextUp === agentId) this.nextUp = null;\n    if (queued || had) this.changed();', '    if (queued || had) this.changed();']],
    killer: 'nextWho', dies: /A GONE AGENT IS FORGOTTEN/ },
  // (b)
  { name: 'the TTL frees a hold seen running (as before)', edits: [["      if (!h.seenRunning) { this.release(h.agentId, 'ttl'); continue; }", "      this.release(h.agentId, 'ttl'); continue;"]],
    killer: 'ttlRenewed', dies: /A HOLD SEEN RUNNING IS RENEWED AT THE HOUR/ },
  { name: 'every hold is renewed (required: one never seen running expires)', edits: [['      if (!h.seenRunning) { this.release', '      if (false) { this.release']],
    killer: 'ttlNeverSeen', dies: /A HOLD NEVER SEEN RUNNING STILL EXPIRES/ },
  { name: 'the renewal does not restart the hour', edits: [['      h.touched = t;\n      this.log({ kind: \'heavy-lock\', action: \'ttl-renewed\'', '      this.log({ kind: \'heavy-lock\', action: \'ttl-renewed\'']],
    killer: 'ttlRenewed', dies: /RENEWED ONCE PER HOUR/ },
  // (c)
  { name: 'a lapsed owner is dropped (as before)', edits: [['      if (!r.lapsed && r.hooked && agentId !== this.calling && this.alive(agentId)) {', '      if (false) {']],
    killer: 'requeueOnce', dies: /THE OWNER IS QUEUED AGAIN AT THE BACK/ },
  { name: 'a lapsed owner is queued again every time', edits: [['      if (!r.lapsed && r.hooked && agentId !== this.calling && this.alive(agentId)) {', '      if (r.hooked && agentId !== this.calling && this.alive(agentId)) {']],
    killer: 'requeueOnce', dies: /THE SECOND LAPSE DROPS IT/ },
  { name: 'a lease-only owner is queued again', edits: [['      if (!r.lapsed && r.hooked && agentId !== this.calling && this.alive(agentId)) {', '      if (!r.lapsed && agentId !== this.calling && this.alive(agentId)) {']],
    killer: 'requeueNot', dies: /A LEASE-ONLY OWNER IS NOT QUEUED AGAIN/ },
  { name: 'a gone owner is queued again', edits: [['      if (!r.lapsed && r.hooked && agentId !== this.calling && this.alive(agentId)) {', '      if (!r.lapsed && r.hooked && agentId !== this.calling) {']],
    killer: 'requeueNot', dies: /A GONE OWNER IS NOT QUEUED AGAIN/ },
  { name: 'the caller is queued again', edits: [['      if (!r.lapsed && r.hooked && agentId !== this.calling && this.alive(agentId)) {', '      if (!r.lapsed && r.hooked && this.alive(agentId)) {']],
    killer: 'requeueNot', dies: /THE CALLER TAKES THE SLOT ITSELF|THE CALLER IS NOT QUEUED AGAIN/ },
  { name: 'queued again at the head', edits: [['        this.waiters.push({ agentId, kind: r.kind, since: t, procs: r.procs, hooked: true, exclusive: r.exclusive, lapsed: true });', '        this.waiters.unshift({ agentId, kind: r.kind, since: t, procs: r.procs, hooked: true, exclusive: r.exclusive, lapsed: true });']],
    killer: 'requeueOnce', dies: /THE OWNER IS QUEUED AGAIN AT THE BACK/ },
  { name: 'the second reservation is a first one', edits: [['lapsed: w.lapsed });', 'lapsed: false });']],
    killer: 'requeueOnce', dies: /THE SECOND LAPSE DROPS IT/ },
  { name: 'told requeued even when reserved again at once', edits: [['    for (const a of again) if (!this.reservations.has(a.agentId)) this.lapse(a.agentId, a.kind, \'requeued\');', '    for (const a of again) this.lapse(a.agentId, a.kind, \'requeued\');']],
    killer: 'requeueAlone', dies: /TOLD HEAVY SLOT FREE AGAIN, NOT REQUEUED/ },
  { name: 'never told requeued', edits: [['    for (const a of again) if (!this.reservations.has(a.agentId)) this.lapse(a.agentId, a.kind, \'requeued\');\n', '']],
    killer: 'requeueOnce', dies: /THE OWNER IS QUEUED AGAIN AT THE BACK AND TOLD SO/ },
  { name: 'heavy status hides the queue place', edits: [['position: at >= 0 ? at + 1 : null };', 'position: null };']],
    killer: 'requeueOnce', dies: /heavy status AGREES WITH WHAT IT WAS TOLD/ },
  { name: 'the deny text is silent about the lapse', edits: [[' A reservation you leave unused for ${Math.round(HEAVY_RESERVE_MS / 60_000)} min passes on and queues you again at the back, once;', '']],
    killer: 'wordsAgree', dies: /THE DENY TEXT SAYS A LAPSE QUEUES AGAIN ONCE/ },
  { name: 'the requeued notice says nothing of once', edits: [['You are QUEUED AGAIN, at the back, once: when a slot frees', 'You are QUEUED AGAIN, at the back: when a slot frees']],
    killer: 'wordsAgree', dies: /THE REQUEUED NOTICE SAYS ONCE/ },
  { name: 'the expired notice does not say not queued', edits: [['You are NOT queued: if you still need your ${kind}, run it again to queue again (\\`heavy status\\` shows your standing).', 'If you still need your ${kind}, run it again to queue again.']],
    killer: 'wordsAgree', dies: /THE EXPIRED NOTICE SAYS NOT QUEUED/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mutated = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      await assert.rejects(async () => K[m.killer](mutated), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
