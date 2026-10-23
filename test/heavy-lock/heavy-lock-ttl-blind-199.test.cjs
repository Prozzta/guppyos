'use strict';

/**
 * HEAVY-HANDOFF-RACE, Jim's audit of 59c87898, MINOR 3 (god, conv-9594bd, 2026-10-23). (b) renewed a hold the
 * watcher had once seen running at every hour, unbounded: with the probe failing on every scan (P1), or a
 * listing that lacked the holder's PTY root (P1b), a hold stood 24 h: 24 ttl-renewed rows, 288 probe-failed
 * rows, no release (before (b) the cap was 1 h). Now the hour's renewal needs a SIGHTING since the last
 * renewal (or since the acquire / re-entry that moved `touched`): a hold the watcher has not seen since its
 * last renewal is logged loudly ('ttl-blind', with the last probe state and how long the job has been unseen)
 * and expires ('ttl'), as one never seen running does. So at most one blind hour follows the last sighting's
 * renewal. A hold seen running every hour is renewed as before; job-exit, posttool and pty-exit still free it.
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const H = { heavy: true, kind: 'suite' };

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = [];
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: () => {}, notifyLapse: () => {}, alive: () => true, ...extra
  });
  return { l, logs, tick: (ms) => { now += ms; }, now: () => now, rows: (action) => logs.filter((r) => r.action === action), held: () => l.snapshot().map((h) => h.agentId) };
}
const reservedFor = (x) => x.l.queueSnapshot().reserved.map((r) => r.agentId);

/** A watcher rig: creed's PTY root (pid 10) and his pack process (pid 11). `s.mode`: 'running' (both listed),
 *  'idle' (root only), 'failed' (an empty listing: the probe timed out), 'unseen' (a good listing without his root). */
function watched(M = HJ) {
  const s = { mode: 'running' };
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const kid = { pid: 11, parentPid: 10, commandLine: 'sh pack.sh', createdMs: 1_000_100 };
  const others = [{ pid: 20, parentPid: 1, commandLine: 'bash', createdMs: 2 }, { pid: 21, parentPid: 20, commandLine: 'node x.js', createdMs: 1_000_300 }];
  const x = rig(M, { roots: () => [{ agentId: 'creed', pid: 10 }], probe: async () => (s.mode === 'running' ? [root, kid] : s.mode === 'idle' ? [root] : s.mode === 'failed' ? [] : others) });
  return { ...x, s };
}
/** An hour of scans every HEAVY_SCAN_MS (the hold is checked at every one). */
async function hour(x, M) {
  for (let t = 0; t < M.HEAVY_TTL_MS; t += M.HEAVY_SCAN_MS) { x.tick(M.HEAVY_SCAN_MS); await x.l.scan(); }
}

const K = {};

K.blind = async (M = HJ) => {
  // P1: seen on the first scan after the acquire, then every listing fails.
  const x = watched(M);
  x.l.acquire('creed', H, 'sh pack.sh &', 'c1', true);
  x.tick(M.HEAVY_SCAN_MS); await x.l.scan();
  x.l.acquire('jim', H, 'npm ci', 'j1', false);
  x.s.mode = 'failed';
  await hour(x, M);
  assert.equal(x.rows('ttl-renewed').length, 1, 'THE HOUR AFTER A SIGHTING IS RENEWED (as (b) requires)');
  assert.deepEqual(x.held(), ['creed']);
  await hour(x, M);
  assert.equal(x.rows('ttl-renewed').length, 1, 'A SECOND HOUR WITHOUT A SIGHTING IS NO RENEWAL');
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['ttl'], 'THE BLIND HOUR EXPIRES THE HOLD');
  assert.deepEqual(x.rows('ttl-blind'), [{ kind: 'heavy-lock', action: 'ttl-blind', agentId: 'creed', heavyKind: 'suite', heldMs: 2 * M.HEAVY_TTL_MS, lastProbe: 'failed', unseenMs: 2 * M.HEAVY_TTL_MS - M.HEAVY_SCAN_MS }], 'THE BLIND HOUR IS LOGGED LOUDLY');
  assert.deepEqual(x.held(), []);
  assert.deepEqual(reservedFor(x), ['jim'], 'the slot passes on');
  assert.ok(x.rows('probe-failed').length >= 300, `the failed probes are logged too (${x.rows('probe-failed').length})`);
  // P1b: seen once, then a good listing that never shows the holder's terminal.
  const y = watched(M);
  y.l.acquire('creed', H, 'sh pack.sh &', 'c1', true);
  y.tick(M.HEAVY_SCAN_MS); await y.l.scan();
  y.s.mode = 'unseen';
  await hour(y, M); await hour(y, M);
  assert.equal(y.rows('ttl-renewed').length, 1, 'UNSEEN: ONE RENEWAL, NOT TWO');
  assert.deepEqual(y.rows('ttl-blind').map((r) => [r.lastProbe, r.unseenMs]), [['ok', 2 * M.HEAVY_TTL_MS - M.HEAVY_SCAN_MS]], 'UNSEEN FOR THE HOUR IS LOGGED');
  assert.deepEqual(y.rows('release').map((r) => r.reason), ['ttl'], 'UNSEEN FOR THE HOUR EXPIRES THE HOLD');
  // Never a day: a blind watcher expires the hold at the second hour, whatever happens after.
  const z = watched(M);
  z.l.acquire('creed', H, 'sh pack.sh &', 'c1', true);
  await z.l.scan();
  z.s.mode = 'failed';
  for (let h = 0; h < 24 && z.held().length; h++) await hour(z, M);
  assert.equal(z.rows('release')[0].heldMs, 2 * M.HEAVY_TTL_MS, 'AT MOST ONE BLIND HOUR AFTER THE LAST RENEWAL (never 24)');
  assert.equal(z.rows('ttl-renewed').length, 1);
};
test('MINOR 3 (P1, P1b): a hold the watcher has not seen since its last renewal is logged loudly and expires: one blind hour at most', () => K.blind());

K.seenRenews = async (M = HJ) => {
  // Seen running at every scan: renewed hour after hour (as (b) requires), never freed on age.
  const x = watched(M);
  x.l.acquire('creed', H, 'sh pack.sh &', 'c1', true);
  await x.l.scan();
  for (let h = 0; h < 3; h++) await hour(x, M);
  assert.deepEqual(x.rows('ttl-renewed').map((r) => r.heldMs), [1, 2, 3].map((n) => n * M.HEAVY_TTL_MS), 'A HOLD SEEN RUNNING EVERY HOUR IS RENEWED EVERY HOUR');
  assert.deepEqual(x.rows('ttl-blind'), []);
  assert.deepEqual(x.rows('release'), [], 'NEVER FREED ON AGE');
  // One sighting in the hour is enough (the probe failed on every other scan), and a sighting at the very
  // instant of the renewal counts for the hour that follows it (the renewal runs before the scan's listing).
  const y = watched(M);
  y.l.acquire('creed', H, 'sh pack.sh &', 'c1', true);
  y.s.mode = 'failed';
  for (let t = 0; t < M.HEAVY_TTL_MS; t += M.HEAVY_SCAN_MS) {
    y.tick(M.HEAVY_SCAN_MS);
    if (t === 30 * M.HEAVY_SCAN_MS) { y.s.mode = 'running'; await y.l.scan(); y.s.mode = 'failed'; } else await y.l.scan();
  }
  assert.equal(y.rows('ttl-renewed').length, 1, 'ONE SIGHTING IN THE HOUR RENEWS');
  assert.deepEqual(y.rows('release'), []);
  y.s.mode = 'running'; await y.l.scan(); y.s.mode = 'failed';   // the scan right after the renewal: same `now`
  await hour(y, M);
  assert.equal(y.rows('ttl-renewed').length, 2, 'A SIGHTING AT THE RENEWAL INSTANT COUNTS FOR THE NEXT HOUR');
  await hour(y, M);
  assert.equal(y.rows('ttl-blind').length, 1, 'then a blind hour expires it');
  assert.deepEqual(y.rows('release').map((r) => r.reason), ['ttl']);
  // A re-entry moves `touched`: a sighting BEFORE it does not count for the hour after it.
  const z = watched(M);
  z.l.acquire('creed', H, 'sh pack.sh &', 'c1', true);
  await z.l.scan();
  z.tick(M.HEAVY_TTL_MS / 2);
  z.l.acquire('creed', H, 'sh pack2.sh', 'c2', false);
  z.s.mode = 'failed';
  await hour(z, M);
  assert.deepEqual(z.rows('ttl-renewed'), [], 'A SIGHTING BEFORE THE RE-ENTRY DOES NOT RENEW THE HOUR AFTER IT');
  assert.deepEqual(z.rows('release').map((r) => r.reason), ['ttl']);
  // An orphan kept on its PostToolUse (seen then) counts as a sighting.
  const w = watched(M);
  w.l.acquire('creed', H, 'sh pack.sh', 'c1', false);   // a foreground call whose job lives on after its PostToolUse
  w.l.callDone('creed', 'c1');
  await new Promise((r) => setImmediate(r));
  assert.equal(w.rows('orphan-kept').length, 1);
  w.s.mode = 'failed';
  await hour(w, M);
  assert.equal(w.rows('ttl-renewed').length, 1, 'THE ORPHAN SIGHTING RENEWS ITS FIRST HOUR');
};
test('MINOR 3: a hold seen running since the last renewal (one sighting is enough) is renewed as before; a re-entry restarts the clock', () => K.seenRenews());

test('the holder field and the renewal name the rule', () => {
  const src = readSource(HJF);
  assert.match(src, /Jim HHR MINOR 3 \(P1, P1b\): only a sighting SINCE the last renewal/, 'the rule is documented at the renewal');
  assert.ok(src.includes('seenAt: number | null;'), 'the sighting time is a holder field');
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

const COND = '      if (!h.seenRunning || h.seenAt === null || h.seenAt < h.touched) {';
const MUTANTS = [
  { name: 'a hold once seen is renewed for ever (P1, as before)', edits: [[COND, '      if (!h.seenRunning) {']],
    killer: 'blind', dies: /A SECOND HOUR WITHOUT A SIGHTING IS NO RENEWAL/ },
  { name: 'the blind hour is not logged', edits: [["        if (h.seenRunning) this.log({ kind: 'heavy-lock', action: 'ttl-blind', agentId: h.agentId, heavyKind: h.kind, heldMs: t - h.since, lastProbe: h.lastProbe, unseenMs: t - (h.seenAt ?? h.since) });\n", '']],
    killer: 'blind', dies: /THE BLIND HOUR IS LOGGED LOUDLY/ },
  { name: 'the blind hour is logged but the hold is kept', edits: [["        this.release(h.agentId, 'ttl'); continue;\n      }\n      h.touched = t;", "        h.touched = t; continue;\n      }\n      h.touched = t;"]],
    killer: 'blind', dies: /THE BLIND HOUR EXPIRES THE HOLD/ },
  { name: 'a scan does not record the sighting', edits: [['      if (busy.has(h.agentId)) { h.misses = 0; h.seenRunning = true; h.seenAt = t; continue; }', '      if (busy.has(h.agentId)) { h.misses = 0; h.seenRunning = true; continue; }']],
    killer: 'seenRenews', dies: /A HOLD SEEN RUNNING EVERY HOUR IS RENEWED EVERY HOUR/ },
  { name: 'a sighting at the renewal instant does not count (strict <=)', edits: [[COND, '      if (!h.seenRunning || h.seenAt === null || h.seenAt <= h.touched) {']],
    killer: 'seenRenews', dies: /A SIGHTING AT THE RENEWAL INSTANT COUNTS FOR THE NEXT HOUR/ },
  { name: 'a sighting before the re-entry counts after it (the clock, not the renewal)', edits: [[COND, '      if (!h.seenRunning || h.seenAt === null || t - h.seenAt >= 2 * HEAVY_TTL_MS) {']],
    killer: 'seenRenews', dies: /A SIGHTING BEFORE THE RE-ENTRY DOES NOT RENEW THE HOUR AFTER IT/ },
  { name: 'the orphan sighting is not recorded', edits: [['cur.seenRunning = true; cur.seenAt = this.now(); this.log', 'cur.seenRunning = true; this.log']],
    killer: 'seenRenews', dies: /THE ORPHAN SIGHTING RENEWS ITS FIRST HOUR/ },
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
