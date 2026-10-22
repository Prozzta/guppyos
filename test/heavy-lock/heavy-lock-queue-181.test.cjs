'use strict';

/**
 * HEAVY-LOCK-SELF-WAIT (1.1.81), with HEAVY-LOCK-MISSED-RUNS-177 (the env `$(...)` escape) and
 * HEAVY-LOCK-SCRIPT-WRAPPER folded in (the same file and classifier).
 *
 * The lock was deny-only: "run it later", never WHEN. Agents wrote pollers; a poller in the same call
 * as a suite waited on that call's own slot (Jim, 2026-10-02 20:31Z, 10 min, orphan-kept). Now:
 *   - a denied agent is QUEUED once, FIFO, and told so;
 *   - a freed slot is RESERVED for the oldest live waiter (5 min) and it is NOTIFIED;
 *     nobody else may take it meanwhile; an unused reservation passes on;
 *   - fleet.json shows the queue.
 * And the classifier sees `env $(...) node test/tools/run-tests.cjs` and a suite in `bash suite.sh`.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJ = loadTs('src/main/heavyJob.ts');
const H = { heavy: true, kind: 'suite' };
// HEAVY-SLOT-EXCLUSIVE-192: a suite runs alone at 2+ slots; the slot-counting tests use a class that shares.
const S = { heavy: true, kind: 'install' };

function rig(M = HJ, limit = 1, extra = {}) {
  let now = 1_000_000; let lim = limit; const logs = []; const notes = []; const gone = new Set();
  const l = new M.HeavyJobLock({
    limit: () => lim, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), alive: (a) => !gone.has(a), ...extra
  });
  return { l, logs, notes, gone, tick: (ms) => { now += ms; }, setLimit: (v) => { lim = v; }, now: () => now };
}

const K = {};

// ─── the queue ───────────────────────────────────────────────────────────────────────────────

K.fifoReserveNotify = (M = HJ) => {
  const x = rig(M);
  assert.equal(x.l.acquire('a', H, 'node test/tools/run-tests.cjs', 'a1', false).allow, true);
  const db = x.l.acquire('b', H, 'npm ci', 'b1', false);
  const dc = x.l.acquire('c', H, 'npm run build', 'c1', false);
  assert.match(db.reason, /You are QUEUED \(position 1\)/);
  assert.match(dc.reason, /You are QUEUED \(position 2\)/);
  assert.match(x.l.acquire('b', H, 'npm ci', 'b2', false).reason, /position 1\)/, 'QUEUED ONCE: A RETRY KEEPS ITS PLACE');
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => [w.agentId, w.position]), [['b', 1], ['c', 2]], 'QUEUED ONCE: A RETRY KEEPS ITS PLACE');
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.notes.map((n) => n.a), ['b'], 'THE OLDEST WAITER IS RESERVED AND NOTIFIED');
  assert.equal(x.notes[0].until, x.now() + M.HEAVY_RESERVE_MS);
  const d = x.l.acquire('c', H, 'npm run build', 'c2', false);
  assert.equal(d.allow, false, 'NOBODY ELSE TAKES A RESERVED SLOT');
  assert.match(d.reason, /no job is running \(reserved for b until \d\d:\d\d:\d\dZ\)/);
  assert.deepEqual(x.l.acquire('b', H, 'npm ci', 'b3', false), { allow: true, acquired: true }, 'THE RESERVED AGENT TAKES ITS SLOT');
  assert.equal(x.logs.find((r) => r.action === 'acquire' && r.agentId === 'b').reserved, true);
  x.l.callDone('b', 'b3');
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'c'], 'THEN THE NEXT WAITER');
};
test('FIFO: denied agents are queued once; a freed slot is reserved for the oldest and it is told; others are kept out', () => K.fifoReserveNotify());

K.reservationExpires = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.l.callDone('a', 'a1');
  x.tick(M.HEAVY_RESERVE_MS - 1);
  assert.equal(x.l.acquire('c', H, 'npm ci', 'c2', false).allow, false, 'still b\'s');
  x.tick(1);
  assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => r.agentId), ['c'], 'AN UNUSED RESERVATION PASSES ON');
  assert.ok(x.logs.some((r) => r.action === 'reserve-expired' && r.agentId === 'b'));
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'c']);
};
test('an unused reservation expires after 5 min and passes to the next waiter', () => K.reservationExpires());

K.goneWaiterSkipped = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.gone.add('b');
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.notes.map((n) => n.a), ['c'], 'A GONE WAITER IS SKIPPED');
  assert.ok(x.logs.some((r) => r.action === 'queue-dropped' && r.agentId === 'b'));
};
test('a waiter whose PTY is gone is skipped', () => K.goneWaiterSkipped());

test('a reserved agent whose PTY exits drops its reservation; the next waiter gets the slot', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.l.callDone('a', 'a1');
  x.l.agentGone('b');
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'c']);
  assert.ok(x.logs.some((r) => r.action === 'reserve-dropped' && r.agentId === 'b'));
  x.l.agentGone('c');
  assert.deepEqual(x.l.queueSnapshot(), { waiters: [], reserved: [] });
});

test('a raised limit serves the queue before a newcomer; Off keeps no queue', () => {
  const x = rig();
  x.l.acquire('a', S, 'npm ci', 'a1', false);
  x.l.acquire('b', S, 'npm ci', 'b1', false);
  x.setLimit(2);
  assert.equal(x.l.acquire('n', S, 'npm ci', 'n1', false).allow, false, 'the free slot went to b first');
  assert.deepEqual(x.notes.map((n) => n.a), ['b']);
  x.setLimit('off');
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.l.queueSnapshot(), { waiters: [], reserved: [] });
});

test('REGRESSION: raising the limit immediately reserves the new slot for the oldest queued agent', () => {
  // HEAVY-SLOT-EXCLUSIVE-192: a class that shares (a suite runs alone; the next test pins that side).
  const x = rig();
  x.l.acquire('a', S, 'npm ci', 'a1', false);
  x.l.acquire('b', S, 'npm ci', 'b1', false);
  x.l.acquire('c', S, 'npm ci', 'c1', false);
  x.setLimit(2);
  x.l.limitChanged();
  assert.deepEqual(x.notes.map((n) => n.a), ['b'], 'the first queued agent is notified without a release');
  assert.deepEqual(x.l.queueSnapshot(), {
    waiters: [{ agentId: 'c', kind: 'install', since: new Date(x.now()).toISOString(), position: 1 }],
    reserved: [{ agentId: 'b', kind: 'install', until: new Date(x.now() + HJ.HEAVY_RESERVE_MS).toISOString() }]
  });
});

test('REGRESSION: raising the limit while a suite holds reserves nothing; the queued suite is granted when it releases', () => {
  // HEAVY-SLOT-EXCLUSIVE-192 x LIMIT-REEVAL: the raised limit is not a slot beside a suite.
  const x = rig();
  x.l.acquire('a', H, 'node test/tools/run-tests.cjs', 'a1', false);
  x.l.acquire('b', H, 'node test/tools/run-tests.cjs', 'b1', false);
  x.setLimit(2);
  x.l.limitChanged();
  assert.deepEqual(x.notes, [], 'NOTHING IS RESERVED BESIDE A SUITE THAT HOLDS');
  assert.deepEqual(x.l.queueSnapshot().reserved, []);
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['b']);
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.notes.map((n) => n.a), ['b'], 'THE QUEUED SUITE IS GRANTED WHEN THE SUITE RELEASES');
  assert.deepEqual(x.l.acquire('b', H, 'node test/tools/run-tests.cjs', 'b2', false), { allow: true, acquired: true });
  // and a class that shares gets no slot beside the suite either
  const y = rig();
  y.l.acquire('a', H, 'node test/tools/run-tests.cjs', 'a1', false);
  y.l.acquire('b', S, 'npm ci', 'b1', false);
  y.setLimit(2);
  y.l.limitChanged();
  assert.deepEqual(y.notes, [], 'NOTHING SHARES A SLOT WITH A SUITE THAT HOLDS');
  y.l.callDone('a', 'a1');
  assert.deepEqual(y.notes.map((n) => n.a), ['b']);
  // and a queued suite gets no raised slot beside a holder that shares
  const z = rig();
  z.l.acquire('a', S, 'npm ci', 'a1', false);
  z.l.acquire('b', H, 'node test/tools/run-tests.cjs', 'b1', false);
  z.setLimit(2);
  z.l.limitChanged();
  assert.deepEqual(z.notes, [], 'A QUEUED SUITE WAITS FOR AN EMPTY MACHINE');
  z.l.callDone('a', 'a1');
  assert.deepEqual(z.notes.map((n) => n.a), ['b']);
});

test('REGRESSION: switching the limit Off tells every queued agent to run', () => {
  const notes = []; const x = rig(HJ, 1, { notifyUnlimited: (a, k) => notes.push([a, k]) });
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.setLimit('off'); x.l.limitChanged();
  assert.deepEqual(notes, [['b', 'suite'], ['c', 'suite']]);
  assert.deepEqual(x.l.queueSnapshot(), { waiters: [], reserved: [] });
});

test('REGRESSION: switching the limit Off does not notify a gone waiter or reservation', () => {
  const notes = []; const x = rig(HJ, 1, { notifyUnlimited: (a, k) => notes.push([a, k]) });
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.gone.add('b'); x.setLimit('off'); x.l.limitChanged();
  assert.deepEqual(notes, [['c', 'suite']], 'the gone reservation receives no impossible wake');
  assert.deepEqual(x.l.queueSnapshot(), { waiters: [], reserved: [] });
});

test('the re-entrant holder is unchanged, and a holder is never queued', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  assert.deepEqual(x.l.acquire('a', H, 'npm run build', 'a2', false), { allow: true, acquired: false });
  assert.deepEqual(x.l.queueSnapshot().waiters, []);
});

test('the deny text: queued, told, and no polling (the old "run it later" is gone)', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  const d = x.l.acquire('b', H, 'npm ci', 'b1', false);
  assert.doesNotMatch(d.reason, /run it later/);
  assert.match(d.reason, /do not poll for the slot/);
  assert.equal(x.logs.find((r) => r.action === 'deny').position, 1);
});

// ─── the classifier escapes ──────────────────────────────────────────────────────────────────

K.envSubstitution = (M = HJ) => {
  assert.equal(M.classifyCommand('env $(echo -u X) node test/tools/run-tests.cjs').heavy, true, 'ENV $(...) OPTIONS DO NOT HIDE THE SUITE');
  assert.equal(M.classifyCommand("env $(env | grep -oE '^HIVE_[A-Z_]*' | sed 's/^/-u /') HOME=/tmp node test/tools/run-tests.cjs").kind, 'suite');
  assert.equal(M.classifyCommand('env $(echo -u X) node test/one.test.cjs').heavy, false, 'still light for one file');
};
test('MISSED-RUNS (3rd escape): `env $(...) node test/tools/run-tests.cjs` is a suite', () => K.envSubstitution());

function scripts(files) {
  return { readScript: (p, cd) => files[cd ? `${cd}|${p}` : p] ?? null };
}

K.scriptWrapper = (M = HJ) => {
  const ctx = scripts({ 'suite.sh': '#!/bin/bash\nset -e\nfor v in $(env | grep -oE x); do unset $v; done\nnode test/tools/run-tests.cjs > log 2>&1\n', 'light.sh': 'echo hi\nnode test/one.test.cjs\n', 'test/one.test.cjs': "require('node:test');\n", './gate.sh': 'npm ci\n' });
  const c = M.classifyCommand('bash suite.sh', 0, ctx);
  assert.equal(c.heavy, true, 'A SUITE IN A SCRIPT FILE IS SEEN');
  assert.match(c.why, /\(in suite\.sh\)$/);
  assert.equal(M.classifyCommand('sh -x ./gate.sh', 0, ctx).kind, 'install');
  assert.equal(M.classifyCommand('./gate.sh', 0, ctx).kind, 'install', 'a script run directly');
  assert.equal(M.classifyCommand('bash light.sh', 0, ctx).heavy, false);
  // HEAVY-LOCK-BG-LAPSE-189: unreadable fails closed (heavy, provisional).
  assert.equal(M.classifyCommand('bash missing.sh', 0, ctx).provisional, true, 'unreadable: heavy until it reads');
  assert.equal(M.classifyCommand('bash suite.sh').heavy, false, 'no reader: the pure default is unchanged');
  assert.equal(M.classifyHeavy('Bash', { command: 'bash suite.sh' }, ctx).heavy, true);
};
test('SCRIPT-WRAPPER: `bash suite.sh`, `sh -x ./gate.sh` and `./gate.sh` are classified by the script\'s text', () => K.scriptWrapper());

K.cdFollowed = (M = HJ) => {
  const ctx = scripts({ 'C:/Dunder/_work/x|suite.sh': 'node test/tools/run-tests.cjs\n' });
  // HEAVY-LOCK-BG-LAPSE-189: not followed, it would be unreadable (heavy, provisional); read, it is the suite.
  const c = M.classifyCommand('cd C:/Dunder/_work/x && bash suite.sh', 0, ctx);
  assert.deepEqual([c.heavy, c.kind, c.provisional], [true, 'suite', undefined], 'CD IS FOLLOWED');
  assert.equal(M.classifyCommand('bash suite.sh', 0, ctx).provisional, true, 'without the cd it is not read: fails closed');
};
test('`cd X && bash suite.sh` reads X/suite.sh', () => K.cdFollowed());

test('scriptReaderFor: resolves against the cwd and an earlier cd, refuses $-paths, caps the size', () => {
  const seen = [];
  const files = { 'C:/w/suite.sh': 'A', 'C:/w/sub/s.sh': 'B', 'D:/abs/t.sh': 'C', 'C:/w/big.sh': 'x'.repeat(HJ.HEAVY_SCRIPT_MAX_BYTES + 1) };
  const ctx = HJ.scriptReaderFor('C:/w/', (abs) => { seen.push(abs); const t = files[abs]; return t === undefined ? null : { size: t.length, text: () => t }; });
  assert.equal(ctx.readScript('suite.sh'), 'A');
  assert.equal(ctx.readScript('s.sh', 'sub'), 'B');
  assert.equal(ctx.readScript('t.sh', 'D:/abs'), 'C');
  assert.equal(ctx.readScript('"suite.sh"'), 'A');
  assert.equal(ctx.readScript('$HOME/x.sh'), null);
  assert.equal(ctx.readScript('x.sh', '~/y'), null);
  assert.equal(ctx.readScript('big.sh'), null, 'over the cap: not read');
});

test('the hook reader: a real file in a temp dir, by a Git Bash /x/ path too; a directory is not a script', () => {
  const HS = loadTs('src/main/hooks.ts').HookServer;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl181-'));
  try {
    fs.writeFileSync(path.join(dir, 'suite.sh'), 'node test/tools/run-tests.cjs\n');
    const ctx = HS.heavyScriptCtx(dir);
    assert.match(ctx.readScript('suite.sh'), /run-tests/);
    if (process.platform === 'win32') {
      const posix = '/' + dir[0].toLowerCase() + dir.slice(2).replace(/\\/g, '/');
      assert.match(HS.heavyScriptCtx(null).readScript(`${posix}/suite.sh`), /run-tests/);
    }
    assert.equal(ctx.readScript('.'), null);
    assert.equal(HS.heavyScriptCtx(dir).readScript('nope.sh'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ─── the wiring ──────────────────────────────────────────────────────────────────────────────

K.wiring = (idx = readSource('src/main/index.ts'), hooks = readSource('src/main/hooks.ts')) => {
  assert.match(idx, /if \(patch && 'heavyJobsAtOnce' in patch\) heavyLock\.limitChanged\(\);/, 'A SETTINGS LIMIT CHANGE PROMOTES EXISTING WAITERS');
  assert.match(idx, /alive: \(agentId\) => \[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\),\n  notify: \(agentId, kind, until\) => notifyHeavySlotFree\(agentId, kind, until\),\n  notifyUnlimited: \(agentId, kind\) => notifyHeavyUnlimited\(agentId, kind\),\n  notifyLapse: \(agentId, kind, why\) => notifyHeavyWaitLapsed\(agentId, kind, why\)\n\}\);/);
  assert.match(idx, /const n = heavySlotFreeNotice\(agentId, kind, until\);\n  try \{ hive\.send\(n\.message as Partial<HiveMessage>, n\.from\); \}/, 'THE NOTICE IS SENT AS BUILT (SYSTEM SENDER + WAKE NOW)');
  assert.match(idx, /try \{ control\.steer\(agentId, n\.steer\); \}/, 'AND REACHES A BUSY AGENT');
  assert.match(hooks, /const scripts = HookServer\.heavyScriptCtx\(p\.cwd\);\n(?:      \/\/[^\n]*\n)*      const own = p\.hook_tool_input;\n      const toolName = own \? 'Bash' : p\.tool_name;\n      const toolInput = own \?\? p\.tool_input;\n      let cls = classifyHeavy\(toolName, toolInput, scripts\);/, 'THE HOOK READS SCRIPTS AT PRETOOLUSE');
  assert.match(hooks, /const k = classifyCommand\(c, 0, scripts\);/);
  // Andy N1: Post frees by the held call id, never by classifying again.
  // HEAVY-LOCK-BG-LAPSE-189: a call held only for an unreadable script is classified again
  // (settle), every other one is freed by its call id alone.
  assert.match(hooks, /if \(\(event === 'PostToolUse' \|\| event === 'PostToolUseFailure'\) && agentId && this\.heavyLock\) \{\n(?:      \/\/.*\n)*      this\.heavyLock\.settle\(agentId, HookServer\.heavyCallId\(p\), \(\) => classifyHeavy\(p\.tool_name, p\.tool_input, HookServer\.heavyScriptCtx\(p\.cwd\)\)\);\n      this\.heavyLock\.callDone\(agentId, HookServer\.heavyCallId\(p\)\);/, 'POST SETTLES A PROVISIONAL CALL, THEN FREES BY THE HELD CALL');
  assert.equal(hooks.split('heavyScriptCtx(p.cwd)').length - 1, 2, 'the script is read at PreToolUse, and at Post only by settle');
};
test('wiring: the notice on both rails (wake-proof mail + steer); scripts read at Pre; Post frees by the held call id', () => K.wiring());

// ─── Andy's notes N1-N3 (1.1.81 follow-up) ──────────────────────────────────────────────────

K.postFreesWhenScriptChanged = (M = HJ) => {
  // The Post no longer classifies, so a script deleted during its run still frees the slot.
  const x = rig(M);
  x.l.acquire('a', H, 'bash round.sh', 'id:t1', false);
  x.l.callDone('a', 'id:t1');
  assert.equal(x.l.snapshot().length, 0, 'freed by its call id');
  x.l.callDone('a', 'id:unknown');
  x.l.callDone('nobody', 'id:t1');
  assert.deepEqual(x.l.snapshot(), [], 'callDone on an unheld call is a no-op');
};
test('N1: a call is freed by its own id; callDone on an unknown call or agent is a no-op', () => K.postFreesWhenScriptChanged());

// HEAVY-QUEUE-WAIT-DROPS: the old Andy N2 "stale" drop (a waiter not denied again for HEAVY_TTL_MS
// left the queue) bounded the wait to 60 min while a stage bench holds the slot ~90 min, and an
// agent told "you will be told" never asks again: Andy fell out 3x on 2026-10-21 and re-queued at
// the back. A waiter now keeps its place until it is served, leaves on purpose, or its agent is gone.
K.waiterOutlivesHour = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', true);              // a live background holder (a ~90 min bench)
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.tick(10 * 60_000);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  for (let i = 0; i < 10; i++) {                            // b waits 100 min, c 90, asking again never
    x.tick(10 * 60_000);
    x.l.acquire('a', H, 'npm run build', `a${i + 2}`, false); x.l.callDone('a', `a${i + 2}`);   // the holder keeps working
    x.l.queueSnapshot();                                    // the watcher's tick (or any read): the sweep runs
  }
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => [w.agentId, w.position]), [['b', 1], ['c', 2]], 'A LIVE WAITER OUTLIVES THE HOUR IN ITS PLACE');
  assert.ok(!x.logs.some((r) => r.action === 'queue-dropped'), 'A LIVE WAITER OUTLIVES THE HOUR IN ITS PLACE');
  x.l.release('a', 'process-exit');
  assert.deepEqual(x.notes.map((n) => n.a), ['b'], 'A LIVE WAITER OUTLIVES THE HOUR IN ITS PLACE');
  assert.ok(x.logs.find((r) => r.action === 'reserve' && r.agentId === 'b').waitedMs >= 100 * 60_000, 'the wait is logged as it was');
};
test('HEAVY-QUEUE-WAIT-DROPS: a waiter is NOT dropped by age: 100 min behind a live holder, it is still #1 and gets the slot', () => K.waiterOutlivesHour());

K.deadWaiterReaped = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', true);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.l.acquire('d', H, 'npm ci', 'd1', false);
  x.tick(60_000);
  x.gone.add('c');                                          // c's PTY is gone (no agentGone: a liveness read)
  x.l.queueSnapshot();                                      // the watcher's tick (or any read) while the holder runs
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => [w.agentId, w.position]), [['b', 1], ['d', 2]], 'A DEAD WAITER IS REAPED BY LIVENESS; THE ORDER IS KEPT');
  assert.deepEqual(x.logs.filter((r) => r.action === 'queue-dropped').map((r) => [r.agentId, r.reason]), [['c', 'gone']], 'A DEAD WAITER IS REAPED BY LIVENESS; THE ORDER IS KEPT');
  x.l.release('a', 'process-exit');
  assert.deepEqual(x.notes.map((n) => n.a), ['b'], 'A DEAD WAITER IS REAPED BY LIVENESS; THE ORDER IS KEPT');
};
test('HEAVY-QUEUE-WAIT-DROPS: a dead waiter is reaped at the watcher tick (reason gone, no notice); the others keep their order', () => K.deadWaiterReaped());

K.aliveThrowsKeepsPlace = (M = HJ) => {
  const x = rig(M, 1, { alive: (a) => { if (a === 'b') throw new Error('ptyToAgent read failed'); return true; } });
  x.l.acquire('a', H, 'npm ci', 'a1', true);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  x.tick(60_000);
  x.l.queueSnapshot();                                      // the watcher's tick: the sweep asks alive, which throws for b
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => [w.agentId, w.position]), [['b', 1], ['c', 2]], 'A THROWING ALIVE CHECK COUNTS AS LIVE: THE WAITER KEEPS ITS PLACE');
  assert.ok(!x.logs.some((r) => r.action === 'queue-dropped'), 'A THROWING ALIVE CHECK COUNTS AS LIVE: THE WAITER KEEPS ITS PLACE');
};
test('HEAVY-QUEUE-WAIT-DROPS (Andy SHOULD1): an alive check that throws never reaps the waiter; it keeps its place across a tick', () => K.aliveThrowsKeepsPlace());

K.grantAliveThrows = (M = HJ) => {
  const D = 'A THROWING ALIVE CHECK IN GRANT BREAKS NOTHING';
  for (const end of ['release', 'callDone']) {
    const x = rig(M, 1, { alive: () => { throw new Error('ptyToAgent read failed'); } });
    x.l.acquire('a', H, 'npm ci', 'a1', false);
    x.l.acquire('b', H, 'npm ci', 'b1', false);
    x.tick(60_000);
    assert.doesNotThrow(() => (end === 'release' ? x.l.release('a', 'process-exit') : x.l.callDone('a', 'a1')), `${D} (${end})`);
    assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => r.agentId), ['b'], `${D}: ${end}: b is reserved, not dropped`);
    assert.deepEqual(x.logs.filter((r) => r.action === 'queue-dropped'), [], `${D}: ${end}: no drop`);
    assert.deepEqual(x.notes.map((n) => n.a), ['b'], `${D}: ${end}: b is told`);
    assert.equal(x.l.acquire('b', H, 'npm ci', 'b2', false).allow, true, `${D}: ${end}: b takes the slot`);
  }
};
test('HEAVY-QUEUE-WAIT-DROPS (Andy SHOULD2): an alive check that throws inside grant() breaks neither release nor callDone; the waiter is reserved', () => K.grantAliveThrows());

test('HEAVY-QUEUE-WAIT-DROPS: a re-deny keeps the place, and a waiter that never asks again is still served in order', () => {
  const x = rig();
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  x.l.acquire('c', H, 'npm ci', 'c1', false);
  const M50 = 50 * 60_000;
  x.tick(M50); x.l.acquire('a', H, 'npm run build', 'a2', false); x.l.callDone('a', 'a2');   // the holder's re-entries keep ITS TTL fresh
  assert.match(x.l.acquire('c', H, 'npm ci', 'c2', false).reason, /position 2\)/, 'c asks again and keeps its place');
  x.tick(M50); x.l.acquire('a', H, 'npm run build', 'a3', false); x.l.callDone('a', 'a3');
  x.tick(M50); x.l.acquire('a', H, 'npm run build', 'a4', false);
  assert.equal(x.l.queueSnapshot().waiters.length, 2, 'b (silent 150 min) and c (silent 100 min) still wait');
  x.l.callDone('a', 'a1'); x.l.callDone('a', 'a4');
  assert.deepEqual(x.notes.map((n) => n.a), ['b'], 'b, silent for 150 min, is served first');
  assert.ok(!x.logs.some((r) => r.action === 'queue-dropped'));
});

K.noSelfNotify = (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', S, 'npm ci', 'a1', false);
  x.l.acquire('b', S, 'npm ci', 'b1', false);
  x.setLimit(2);
  assert.deepEqual(x.l.acquire('b', S, 'npm ci', 'b2', false), { allow: true, acquired: true });
  assert.deepEqual(x.notes, [], 'THE CALLER IS NOT TOLD ABOUT THE SLOT IT IS TAKING');
};
test('N3: when the limit is raised, the first waiter calling again takes its slot without a "slot free" notice', () => K.noSelfNotify());

// ─── the notice itself, and Andy's pin for the merged rc ────────────────────────────────────

test('the notice: system sender, wake "now", inform with no reply, plain words, the steer repeats the subject', () => {
  const n = HJ.heavySlotFreeNotice('jim', 'suite', Date.parse('2026-10-03T06:30:00Z'));
  assert.equal(n.from, 'system');
  assert.deepEqual([n.message.to, n.message.act, n.message.requires_reply, n.message.wake], ['jim', 'inform', false, 'now']);
  assert.equal(n.message.subject, 'HEAVY SLOT FREE: the suite you were denied can run now; the slot is reserved for you until 06:30Z');
  assert.match(n.message.body, /No reply is needed\.$/);
  assert.equal(n.steer, `${n.message.subject}.`);
});

// READS-QUIET-NOREPLY lives on fix/181-reads-quiet; this runs once both are merged (rc/1.1.81).
const QUIET = fs.existsSync(path.join(__dirname, '..', '..', 'src/shared/mailWakeClass.ts'));
test('merged rc: the notice as sent is classified WAKE (from system, wakeNow), never held quiet', { skip: QUIET ? false : 'needs READS-QUIET-NOREPLY (mailWakeClass) in this tree' }, () => {
  const W = loadTs('src/shared/mailWakeClass.ts');
  const n = HJ.heavySlotFreeNotice('jim', 'suite', 0);
  const entry = { id: 'x', from: n.from, act: n.message.act, requiresReply: n.message.requires_reply, wakeNow: n.message.wake === 'now', deliveredAt: 0 };
  assert.equal(W.mailWakeClass(entry, 'inject'), 'wake');
  assert.equal(W.mailWakeClass({ ...entry, from: 'jim-mtujpe28' }, 'inject'), 'wake', 'wake:"now" alone wakes too');
  assert.equal(W.mailWakeClass({ ...entry, wakeNow: false }, 'inject'), 'wake', 'the system sender alone wakes too');
  assert.deepEqual(W.normalizeWakeField(n.message.wake), { wake: 'now' }, 'normalize keeps it');
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
const HJF = 'src/main/heavyJob.ts';
const MUTANTS = [
  { name: 'others may take a reserved slot', file: HJF, module: true,
    // HEAVY-SLOT-EXCLUSIVE-192: the acquire's count moved into admits()/fits() (the grant asks fits()
    // too, so the acquire's own check is what goes: it counts the holders only, as before).
    edits: [['if (!reserved && !this.admits(agentId, excl, limit)) return this.deny(agentId, cls, limit, callId);', 'if (!reserved && this.holders.size >= limit) return this.deny(agentId, cls, limit, callId);']],
    killer: 'fifoReserveNotify', dies: /NOBODY ELSE TAKES A RESERVED SLOT/ },
  { name: 'LIFO instead of FIFO', file: HJF, module: true,
    edits: [['const w = this.waiters.shift()!;', 'const w = this.waiters.pop()!;']],
    killer: 'fifoReserveNotify', dies: /THE OLDEST WAITER IS RESERVED AND NOTIFIED/ },
  { name: 'the reserved agent is never told', file: HJF, module: true,
    edits: [['      try { this.d.notify?.(w.agentId, w.kind, until); } catch { /* best effort: the reservation stands */ }\n', '']],
    killer: 'fifoReserveNotify', dies: /THE OLDEST WAITER IS RESERVED AND NOTIFIED/ },
  { name: 'a retry queues the agent again', file: HJF, module: true,
    edits: [['    if (i >= 0) { this.waiters[i].since = this.now(); this.waiters[i].exclusive ||= exclusive; return i + 1; }\n    this.waiters.push', '    this.waiters.push']],
    killer: 'fifoReserveNotify', dies: /QUEUED ONCE: A RETRY KEEPS ITS PLACE/ },
  { name: 'a reservation never expires', file: HJF, module: true,
    edits: [['      if (t < r.until) continue;', '      if (t < r.until || r.until > 0) continue;']],
    killer: 'reservationExpires', dies: /AN UNUSED RESERVATION PASSES ON/ },
  { name: 'a gone waiter is reserved anyway', file: HJF, module: true,
    edits: [["      if (!this.alive(w.agentId)) { this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'gone' }); this.changed(); continue; }\n", '']],
    killer: 'goneWaiterSkipped', dies: /A GONE WAITER IS SKIPPED/ },
  { name: 'env $(...) ends the option run (as 1.1.80)', file: HJF, module: true,
    edits: [["(ws[i].startsWith('-') || ws[i].startsWith('$(') || /^", "(ws[i].startsWith('-') || /^"]],
    killer: 'envSubstitution', dies: /ENV \$\(\.\.\.\) OPTIONS DO NOT HIDE THE SUITE/ },
  { name: 'script files are not read (as 1.1.80)', file: HJF, module: true,
    edits: [['  if (depth >= MAX_DEPTH) return capped(name);', '  if (ctx || depth >= 0) return { heavy: false };']],
    killer: 'scriptWrapper', dies: /A SUITE IN A SCRIPT FILE IS SEEN/ },
  { name: 'cd is not followed', file: HJF, module: true,
    edits: [["      here = { ...here, cd: /^([A-Za-z]:[\\\\/]|[\\\\/]|~)/.test(to) || !here.cd ? to : `${here.cd.replace(/[\\\\/]+$/, '')}/${to}` };\n", '']],
    killer: 'cdFollowed', dies: /CD IS FOLLOWED/ },
  { name: 'the notice is sent as plain worker mail (held by READS-QUIET)', file: 'src/main/index.ts',
    edits: [['  const n = heavySlotFreeNotice(agentId, kind, until);\n  try { hive.send(n.message as Partial<HiveMessage>, n.from); }', '  const n = heavySlotFreeNotice(agentId, kind, until);\n  try { hive.send({ ...n.message, wake: undefined } as Partial<HiveMessage>, agentId); }']],
    killer: 'wiring', dies: /THE NOTICE IS SENT AS BUILT \(SYSTEM SENDER \+ WAKE NOW\)/ },
  { name: 'Post re-classifies before freeing (as 130d276c; a changed script keeps the slot)', file: 'src/main/hooks.ts', hooks: true,
    edits: [["if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && agentId && this.heavyLock) {", "if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && agentId && this.heavyLock && classifyHeavy(p.tool_name, p.tool_input, HookServer.heavyScriptCtx(p.cwd)).heavy) {"]],
    killer: 'wiring', dies: /POST SETTLES A PROVISIONAL CALL, THEN FREES BY THE HELD CALL/ },
  { name: 'HEAVY-QUEUE-WAIT-DROPS: the sweep drops by age again (the old stale drop)', file: HJF, module: true,
    edits: [['      if (!this.d.alive || this.alive(w.agentId)) continue;\n', '      if ((!this.d.alive || this.alive(w.agentId)) && t - w.since < HEAVY_TTL_MS) continue;\n']],
    killer: 'waiterOutlivesHour', dies: /A LIVE WAITER OUTLIVES THE HOUR IN ITS PLACE/ },
  { name: 'HEAVY-QUEUE-WAIT-DROPS: the grant drops by age again (the old stale drop)', file: HJF, module: true,
    edits: [['      const until = this.now() + HEAVY_RESERVE_MS;\n      this.reservations.set', "      if (this.now() - w.since >= HEAVY_TTL_MS) { this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'stale' }); this.changed(); continue; }\n      const until = this.now() + HEAVY_RESERVE_MS;\n      this.reservations.set"]],
    killer: 'waiterOutlivesHour', dies: /A LIVE WAITER OUTLIVES THE HOUR IN ITS PLACE/ },
  { name: 'HEAVY-QUEUE-WAIT-DROPS: the liveness sweep is gone', file: HJF, module: true,
    edits: [['      if (!this.d.alive || this.alive(w.agentId)) continue;\n      this.dequeue(w.agentId);', '      continue;\n      this.dequeue(w.agentId);']],
    killer: 'deadWaiterReaped', dies: /A DEAD WAITER IS REAPED BY LIVENESS; THE ORDER IS KEPT/ },
  { name: 'HEAVY-QUEUE-WAIT-DROPS: the sweep reaps the wrong waiter (order lost)', file: HJF, module: true,
    edits: [["      this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'gone' });\n      this.changed();\n      left = true;", "      this.log({ kind: 'heavy-lock', action: 'queue-dropped', agentId: w.agentId, reason: 'gone' });\n      this.changed();\n      left = true;\n      this.waiters.push(this.waiters.shift()!);"]],
    killer: 'deadWaiterReaped', dies: /A DEAD WAITER IS REAPED BY LIVENESS; THE ORDER IS KEPT/ },
  { name: 'HEAVY-QUEUE-WAIT-DROPS (Andy M3): a throwing alive check counts as gone', file: HJF, module: true,
    edits: [['    try { return !this.d.alive || this.d.alive(agentId); } catch { return true; }\n', '    try { return !this.d.alive || this.d.alive(agentId); } catch { return false; }\n']],
    killer: 'aliveThrowsKeepsPlace', dies: /A THROWING ALIVE CHECK COUNTS AS LIVE: THE WAITER KEEPS ITS PLACE/ },
  { name: 'HEAVY-QUEUE-WAIT-DROPS (Andy SHOULD2): grant() reads the raw alive again', file: HJF, module: true,
    edits: [["      if (!this.alive(w.agentId)) { this.log({ kind: 'heavy-lock', action: 'queue-dropped'", "      if (this.d.alive && !this.d.alive(w.agentId)) { this.log({ kind: 'heavy-lock', action: 'queue-dropped'"]],
    killer: 'grantAliveThrows', dies: /A THROWING ALIVE CHECK IN GRANT BREAKS NOTHING/ },
  { name: 'N3 off: the caller is told about its own slot', file: HJF, module: true,
    edits: [['      if (w.agentId === caller) continue;\n', '']],
    killer: 'noSelfNotify', dies: /THE CALLER IS NOT TOLD ABOUT THE SLOT IT IS TAKING/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const text = mutateText(m.file, m.edits, m.name);
      const run = m.module ? () => K[m.killer](loadTs.fromText(m.file, text))
        : m.hooks ? () => K[m.killer](undefined, text)
        : () => K[m.killer](text);
      assert.throws(run, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
