'use strict';

/**
 * HEAVY-HANDOFF-RACE (e) (god, conv-9a2d94, 2026-10-23). Live (log.jsonl, kind heavy-lock): Dwight's bench
 * hold, taken at 12:38Z, was still "held: dwight" after he stopped the job at about 13:15Z, and `heavy
 * release` answered "nothing to release: no slot is reserved for you and you are not queued". No row was
 * written for that call. The slot freed by itself at 13:15:50Z ('process-exit', heldMs 2232994), once the
 * watcher had seen the job gone for two scans, and Creed's cut got it a minute late.
 * Now a HOLDER's `heavy release` drops its held call(s) and grants the next agent at once ('held-released',
 * then release reason 'released'), unless a process of its job still runs: then it is refused truthfully,
 * naming the open calls and the pids ('release-refused'). A failed process listing is unknown, not idle:
 * refused too. A build with no watcher drops it. The answer never says "nothing" to a holder.
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
const H = { heavy: true, kind: 'bench' };
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hrh199-'));
test.after(() => { try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* best effort */ } });

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = [];
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a) => notes.push(a), notifyLapse: () => {}, alive: () => true, ...extra
  });
  return { l, logs, notes, tick: (ms) => { now += ms; }, rows: (action) => logs.filter((r) => r.action === action), held: () => l.snapshot().map((h) => h.agentId) };
}
const reservedFor = (x) => x.l.queueSnapshot().reserved.map((r) => r.agentId);

/** A watcher rig: dwight's PTY root (pid 10) and, while `s.running`, his bench process (pid 11, then 12). */
function watched(M = HJ) {
  const s = { running: true, fail: false };
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const kids = [{ pid: 12, parentPid: 10, commandLine: 'node bench.js', createdMs: 1_000_200 }, { pid: 11, parentPid: 10, commandLine: 'bash bench.sh', createdMs: 1_000_100 }];
  const x = rig(M, { roots: () => [{ agentId: 'dwight', pid: 10 }], probe: async () => (s.fail ? [] : s.running ? [root, ...kids] : [root]) });
  return { ...x, s };
}
const release = (x, agent, to) => x.l.lease(agent, to ? { op: 'unreserve', to } : { op: 'unreserve' });

const K = {};

K.dropsHeld = async (M = HJ) => {
  const x = watched(M);
  x.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  x.l.acquire('creed', H, 'bash cut.sh', 'k1', false);
  await x.l.scan();
  x.s.running = false;                      // the job was stopped; its PostToolUse never came
  const a = await release(x, 'dwight');
  assert.deepEqual(a, { state: 'unreserved', reserved: false, queued: false, next: 'creed', held: { kind: 'bench', calls: ['c1'], pids: [], dropped: true, checked: 'ok' } }, 'A HOLDER\'S RELEASE DROPS ITS HELD CALL AND GRANTS THE NEXT AGENT AT ONCE');
  assert.deepEqual(x.held(), [], 'A HOLDER\'S RELEASE DROPS ITS HELD CALL');
  assert.deepEqual(reservedFor(x), ['creed'], 'THE NEXT AGENT IS GRANTED AT ONCE');
  assert.deepEqual(x.notes, ['creed']);
  assert.deepEqual(x.rows('held-released'), [{ kind: 'heavy-lock', action: 'held-released', agentId: 'dwight', heavyKind: 'bench', calls: ['c1'], checked: 'ok' }], 'THE HELD RELEASE IS LOGGED');
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['released'], 'THE RELEASE REASON SAYS SO');
  assert.deepEqual(x.rows('release-refused'), []);
  // Then a second `heavy release` is the ordinary non-holder answer; heavy status agrees.
  assert.deepEqual(await release(x, 'dwight'), { state: 'unreserved', reserved: false, queued: false, next: null });
  assert.deepEqual((await x.l.lease('dwight', { op: 'status' })).you, { holding: false, reserved: null, position: null });
  // --to names the next holder; a background holder (job detached) is dropped the same way.
  const y = watched(M);
  y.l.acquire('dwight', H, 'bash bench.sh &', 'c1', true);
  y.l.acquire('andy', H, 'bash cut.sh', 'a1', false);
  y.l.acquire('creed', H, 'bash cut.sh', 'k1', false);
  await y.l.scan();
  y.s.running = false;
  const b = await release(y, 'dwight', 'creed');
  assert.equal(b.next, 'creed', 'HAND THE HELD SLOT TO A NAMED QUEUED AGENT');
  assert.deepEqual(reservedFor(y), ['creed'], 'HAND THE HELD SLOT TO A NAMED QUEUED AGENT');
  assert.equal(y.rows('held-released')[0].to, 'creed');
  const z = watched(M);
  z.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  z.s.running = false;
  const c = await release(z, 'dwight', 'nobody');
  assert.equal(c.to, 'not-queued', 'A NAMED AGENT NOT QUEUED IS SAID');
  assert.equal(c.next, null);
  assert.deepEqual(z.held(), []);
};
test('(e) a holder\'s `heavy release` drops its held call (foreground or background) and grants the next agent at once', () => K.dropsHeld());

K.refusesRunning = async (M = HJ) => {
  const x = watched(M);
  x.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  x.l.acquire('creed', H, 'bash cut.sh', 'k1', false);
  await x.l.scan();
  const a = await release(x, 'dwight');
  assert.deepEqual(a, { state: 'unreserved', reserved: false, queued: false, next: null, held: { kind: 'bench', calls: ['c1'], pids: [11, 12], dropped: false, checked: 'ok' } }, 'A LIVE JOB: REFUSED, NAMING THE OPEN CALL AND ITS PIDS');
  assert.deepEqual(x.held(), ['dwight'], 'A LIVE JOB: THE SLOT STAYS HELD');
  assert.deepEqual(reservedFor(x), []);
  assert.deepEqual(x.rows('release-refused'), [{ kind: 'heavy-lock', action: 'release-refused', agentId: 'dwight', heavyKind: 'bench', calls: ['c1'], pids: [11, 12], checked: 'ok' }], 'THE REFUSAL IS LOGGED');
  assert.deepEqual(x.rows('release'), []);
  assert.deepEqual((await x.l.lease('dwight', { op: 'status' })).you, { holding: true, reserved: null, position: null }, 'heavy status agrees: holding');
  // The job is stopped: the same command now releases.
  x.s.running = false;
  assert.equal((await release(x, 'dwight')).held.dropped, true, 'ONCE STOPPED, THE SAME COMMAND RELEASES');
  assert.deepEqual(reservedFor(x), ['creed']);
  // A failed listing is unknown, not idle: refused, said so.
  const y = watched(M);
  y.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  await y.l.scan();
  y.s.fail = true;
  const f = await release(y, 'dwight');
  assert.deepEqual(f.held, { kind: 'bench', calls: ['c1'], pids: [11, 12], dropped: false, checked: 'failed' }, 'A FAILED LISTING: REFUSED (fail closed)');
  assert.deepEqual(y.held(), ['dwight'], 'A FAILED LISTING: THE SLOT STAYS HELD');
  // The hold goes during the listing (here: its PTY exits): freed, said so, nothing refused.
  const z = watched(M);
  z.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  const slow = z.l.lease('dwight', { op: 'unreserve' });
  z.l.agentGone('dwight');
  const r = await slow;
  assert.deepEqual(r.held, { kind: 'bench', calls: ['c1'], pids: [], dropped: true, checked: 'ok' });
  assert.deepEqual(z.held(), []);
  assert.deepEqual(z.rows('release-refused'), []);
};
test('(e) a job still running (or a failed listing) refuses the release truthfully, naming the call and pids; once stopped the same command releases', () => K.refusesRunning());

K.noWatcher = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('dwight', H, 'bash bench.sh &', 'c1', true);
  x.l.acquire('creed', H, 'bash cut.sh', 'k1', false);
  const a = await release(x, 'dwight');
  assert.deepEqual(a.held, { kind: 'bench', calls: ['c1'], pids: [], dropped: true, checked: 'none' }, 'NO WATCHER: DROPPED, SAID UNCHECKED');
  assert.deepEqual(x.held(), [], 'NO WATCHER: DROPPED');
  assert.deepEqual(reservedFor(x), ['creed']);
  // The non-holder path is unchanged and still synchronous (exclusive-192 calls it so).
  const y = rig(M);
  y.l.acquire('a', H, 'npm ci', 'a1', false);
  y.l.acquire('b', H, 'npm ci', 'b1', false);
  const s = y.l.unreserve('b');
  assert.ok(!(s instanceof Promise), 'a non-holder\'s release stays synchronous');
  assert.deepEqual(s, { state: 'unreserved', reserved: false, queued: true, next: null });
  assert.ok(readSource(HJF).includes("if (this.holders.has(agentId)) return this.releaseHeld(agentId, to);"), 'the holder branch is inside unreserve (the route line is pinned by rr-198)');
};
test('(e) with no watcher on the build the held call is dropped; a non-holder\'s release is unchanged', () => K.noWatcher());

test('the heavy CLI never says "nothing" to a holder: the held lines', () => {
  const base = { state: 'unreserved', reserved: false, queued: false };
  assert.equal(CLI.describe({ ...base, next: 'creed', held: { kind: 'bench', calls: ['c1'], pids: [], dropped: true, checked: 'ok' } }),
    'heavy: released your held bench slot (call c1 dropped: no process of its job runs); it is now reserved for creed\n');
  assert.equal(CLI.describe({ ...base, next: null, held: { kind: 'suite', calls: [], pids: [], dropped: true, checked: 'none' } }),
    'heavy: released your held suite slot (no open call dropped); it is now free (no one is queued)\n');
  assert.equal(CLI.describe({ ...base, next: null, to: 'not-queued', held: { kind: 'bench', calls: ['c1', 'c2'], pids: [], dropped: true, checked: 'ok' } }),
    'heavy: released your held bench slot (call c1, c2 dropped: no process of its job runs); it is now free (no one is queued) (the agent you named is not queued, so it went in queue order)\n');
  assert.equal(CLI.describe({ ...base, next: null, held: { kind: 'bench', calls: ['c1'], pids: [11, 12], dropped: false, checked: 'ok' } }),
    'heavy: refused: you hold the bench slot and its job still runs (call c1, pids 11, 12); stop the job first, or it frees when the job ends\n', 'THE CLI NAMES THE CALL AND THE PIDS');
  assert.equal(CLI.describe({ ...base, next: null, held: { kind: 'bench', calls: ['c1'], pids: [], dropped: false, checked: 'failed' } }),
    'heavy: refused: you hold the bench slot and the process check failed, so its job may still run (call c1); it frees when the job ends, or run heavy release again\n');
  assert.equal(CLI.describe({ ...base, next: null }), 'heavy: nothing to release: no slot is reserved for you and you are not queued (a slot you hold frees when its job ends)\n', 'a non-holder still hears the old line');
  const src = fs.readFileSync(require.resolve('../../resources/heavy-cli.cjs'), 'utf8');
  assert.match(src, /release: give up my reserved slot, or my place in the queue \(a denial queued me\), or the slot I hold \(once its job is over\)\\n/, 'USAGE says so');
  assert.match(readSource('src/main/hive.ts'), /or the slot you hold once no process of its job runs\. `heavy next <agent>`/, 'FLOOR says so');
});

async function broker(t, M) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hrh199-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  const st = { running: true };
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const kid = { pid: 11, parentPid: 10, commandLine: 'bash bench.sh', createdMs: Date.now() + 1000 };
  const logs = []; const notes = [];
  const lock = new M.HeavyJobLock({ limit: () => 1, log: (r) => logs.push(r), notify: (a) => notes.push(a), roots: () => [{ agentId: 'dwight', pid: 10 }], probe: async () => (st.running ? [root, kid] : [root]) });
  s.setHeavyLock(lock);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return { lock, logs, notes, st, url: (a) => s.hookUrl(a).replace('/hook/', '/ledger/') };
}
async function cli(argv, env) {
  let out = ''; let err = '';
  const code = await CLI.main(argv, env, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

test('E2E: a holder\'s `heavy release` over the real hook broker route: refused while the job runs, released once it is stopped', { timeout: 30_000 }, async (t) => {
  const b = await broker(t, HJ);
  b.lock.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  b.lock.acquire('creed', H, 'bash cut.sh', 'k1', false);
  await b.lock.scan();
  const no = await cli(['release'], { HIVE_LEDGER_URL: b.url('dwight') });
  assert.equal(no.code, 1, no.err);   // Jim HHR NIT 2: a refusal exits non-zero
  assert.equal(no.out, 'heavy: refused: you hold the bench slot and its job still runs (call c1, pids 11); stop the job first, or it frees when the job ends\n', 'THE CLI REFUSES TRUTHFULLY OVER THE ROUTE');
  assert.match((await cli(['status'], { HIVE_LEDGER_URL: b.url('dwight') })).out, /^held: dwight; reserved: none; queue: creed\nyou: holding a slot/);
  b.st.running = false;
  const ok = await cli(['release'], { HIVE_LEDGER_URL: b.url('dwight') });
  assert.equal(ok.out, 'heavy: released your held bench slot (call c1 dropped: no process of its job runs); it is now reserved for creed\n', 'THE CLI RELEASES THE HELD SLOT OVER THE ROUTE');
  assert.deepEqual(b.notes, ['creed']);
  assert.match((await cli(['status'], { HIVE_LEDGER_URL: b.url('dwight') })).out, /^held: none; reserved: creed until \d\d:\d\d:\d\dZ; queue: empty\nyou: not queued, nothing reserved, nothing held\n$/);
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
  { name: 'a holder hears "nothing to release" (today)', edits: [['    if (this.holders.has(agentId)) return this.releaseHeld(agentId, to);\n', '']],
    killer: 'dropsHeld', dies: /A HOLDER'S RELEASE DROPS ITS HELD CALL AND GRANTS THE NEXT AGENT AT ONCE/ },
  { name: 'a running job is dropped', edits: [["      else { checked = 'ok'; running = probed.busy.has(agentId); }", "      else { checked = 'ok'; }"]],
    killer: 'refusesRunning', dies: /A LIVE JOB: REFUSED, NAMING THE OPEN CALL AND ITS PIDS|A LIVE JOB: THE SLOT STAYS HELD/ },
  { name: 'a failed listing counts as idle', edits: [["    if (running || checked === 'failed' || checked === 'unseen' || arrived.length) {", "    if (running || checked === 'unseen' || arrived.length) {"]],
    killer: 'refusesRunning', dies: /A FAILED LISTING: REFUSED/ },
  { name: 'the process check is skipped', edits: [['    if (this.d.probe && this.d.roots) {\n      const probed = await this.heavyAgents();', '    if (false) {\n      const probed = await this.heavyAgents();']],
    killer: 'refusesRunning', dies: /A LIVE JOB: REFUSED, NAMING THE OPEN CALL AND ITS PIDS/ },
  { name: 'the pids are not named', edits: [['    const pids = [...cur.attributed.keys()].sort((a, b) => a - b);', '    const pids = [];']],
    killer: 'refusesRunning', dies: /A LIVE JOB: REFUSED, NAMING THE OPEN CALL AND ITS PIDS/ },
  { name: 'the refusal is not logged', edits: [["      this.log({ kind: 'heavy-lock', action: 'release-refused', agentId, heavyKind: cur.kind, calls: open, pids, checked, ...(arrived.length ? { arrived } : {}) });\n", '']],
    killer: 'refusesRunning', dies: /THE REFUSAL IS LOGGED/ },
  { name: 'the held release is not logged', edits: [["    this.log({ kind: 'heavy-lock', action: 'held-released', agentId, heavyKind: cur.kind, calls, checked, ...(to ? { to } : {}) });\n", '']],
    killer: 'dropsHeld', dies: /THE HELD RELEASE IS LOGGED/ },
  { name: 'the release reason hides who freed it', edits: [["    this.release(agentId, 'released');", "    this.release(agentId, 'posttool');"]],
    killer: 'dropsHeld', dies: /THE RELEASE REASON SAYS SO/ },
  { name: '--to ignored for a held slot', edits: [['      if (i > 0) this.waiters.unshift(...this.waiters.splice(i, 1));   // (e): to the head, as unreserve does\n', '']],
    killer: 'dropsHeld', dies: /HAND THE HELD SLOT TO A NAMED QUEUED AGENT/ },
  { name: 'a missed --to not said', edits: [["    return { state: 'unreserved', reserved: false, queued: false, next, ...(missed ? { to: 'not-queued' as const } : {}), held:", "    return { state: 'unreserved', reserved: false, queued: false, next, held:"]],
    killer: 'dropsHeld', dies: /A NAMED AGENT NOT QUEUED IS SAID/ },
  { name: 'no watcher: refused forever', edits: [["    let checked: HeavyHeldRelease['checked'] = 'none';", "    let checked: HeavyHeldRelease['checked'] = 'failed';"]],
    killer: 'noWatcher', dies: /NO WATCHER: DROPPED/ },
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
