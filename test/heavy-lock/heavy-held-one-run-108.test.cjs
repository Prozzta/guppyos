'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-LOCK-ADMITTED-BENCH-WHILE-HELD-108 (F-B; the Human, 2026-11-28: 'OK F-B, ship in 108').
 *
 * 2026-11-25 10:16:53-10:17:45Z: while creed-mukyiphw held the heavy slot for a full suite, UHera's
 * clbase-bench2.sh (an sh script: four sequential single-file runs of one test file, node and Electron
 * legs, a mutant cp between them) was admitted at once. Each run was one named test file, so the
 * runtime single-file rule ran it light, up to HEAVY_CALL_LIGHT_MAX per call, whoever held the machine.
 *
 * F-B: while ANOTHER agent holds the machine, one call runs ONE test process light; the next waits its
 * turn in the queue, like any heavy job. Scripts, loops and both legs ask the same way (one named file
 * per process), so one rule covers them. Nothing changes when nobody holds, or when the agent itself
 * is the only holder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const H = { heavy: true, kind: 'suite' };
const C0 = 1_000_000 - 5_000;
const FILE = 'test/changelog-history-gate.test.cjs';

function rig(M = HJ) {
  let now = 1_000_000; const logs = []; const images = new Map(); const alive = new Set();
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, log: (r) => logs.push(r), setTimer: () => ({}), clearTimer: () => {},
    notify: () => {}, notifyLapse: () => {}, parentImage: async (pid) => images.get(pid) ?? null, pidAlive: (pid) => alive.has(pid), leasePollMs: 0
  });
  images.set(50, 'C:\\Program Files\\Git\\usr\\bin\\sh.exe');
  images.set(51, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  return { l, logs, images, alive, tick: (ms) => { now += ms; } };
}
const ask = (x, agentId, pid, more = {}) => x.l.lease(agentId, { op: 'acquire', pid, createdMs: C0, ppid: 50, files: [FILE], ...more });

// The call shapes: UHera's script (the runtime single-file path), the same runs as an inline loop
// (the loop path), and node by variable (the shown path). Each runs the file four times, node and
// Electron legs in turn (ELECTRON_RUN_AS_NODE=1 electron.exe --test <file> asks as a test process).
const SHAPES = [
  ["UHera's script (sh clbase-bench2.sh)", 'sh clbase-bench2.sh'],
  ['an inline loop (node by name)', 'for i in 1 2; do node --test test/changelog-history-gate.test.cjs; cp m.ts src/x.ts; ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe --test test/changelog-history-gate.test.cjs; done'],
  ['an inline loop (node by variable)', 'N=C:/n/node.exe; E=node_modules/electron/dist/electron.exe; for i in 1 2; do $N --test test/changelog-history-gate.test.cjs; ELECTRON_RUN_AS_NODE=1 $E --test test/changelog-history-gate.test.cjs; done']
];
// Four sequential runs: each ends before the next starts (never two alive at once).
async function fourRuns(x, agentId, base) {
  const states = [];
  for (let i = 0; i < 4; i++) {
    const a = await ask(x, agentId, base + i, { ppid: i % 2 ? 51 : 50 });
    states.push(a.state);
    x.tick(12_000);
  }
  return states;
}

const K = {};

K.held = async (M = HJ) => {
  for (const [what, cmd] of SHAPES) {
    const x = rig(M);
    x.l.acquire('b', H, 'npm test', 'hb', false);
    x.l.noteCall('a', 'c1', cmd);
    const states = await fourRuns(x, 'a', 100);
    assert.deepEqual(states, ['light', 'wait', 'wait', 'wait'], `ONE RUN WHILE ANOTHER AGENT HOLDS: the first is light, the rest wait their turn (${what})`);
    assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['a'], `the second run queues its agent (${what})`);
    // Its turn: the holder ends, the slot is reserved for the waiting agent, and its run goes ahead
    // (light: nobody else holds now, so the plain rules apply).
    x.l.callDone('b', 'hb');
    assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => r.agentId), ['a'], `THE SECOND RUN WAITS ITS TURN: the freed slot is its agent's (${what})`);
    assert.equal((await ask(x, 'a', 103)).state, 'light', `THE SECOND RUN WAITS ITS TURN, THEN RUNS (${what})`);
  }
};
test("UHera's 4-run case: while another agent holds, one call runs one test light and the rest wait (script, loops, both legs)", () => K.held());

K.free = async (M = HJ) => {
  const MAX = M.HEAVY_CALL_LIGHT_MAX;
  for (const [what, cmd] of SHAPES) {
    const x = rig(M);
    x.l.noteCall('a', 'c1', cmd);
    assert.deepEqual(await fourRuns(x, 'a', 100), ['light', 'light', 'light', 'light'], `NOTHING CHANGES WHEN NOBODY HOLDS: four runs stay light (${what})`);
    assert.equal(x.l.queueSnapshot().waiters.length, 0, 'nobody queued');
  }
  // The call cap itself is unchanged when nobody holds: MAX light, then the slot.
  const x = rig(M);
  x.l.noteCall('a', 'c1', SHAPES[0][1]);
  for (let i = 0; i < MAX; i++) {
    assert.equal((await ask(x, 'a', 200 + i)).state, 'light', `NOTHING CHANGES WHEN NOBODY HOLDS: run ${i + 1} of ${MAX} is light`);
    x.tick(2_000);
  }
  assert.equal((await ask(x, 'a', 300)).state, 'held', `NOTHING CHANGES WHEN NOBODY HOLDS: past ${MAX} the call takes the slot`);
};
test('nothing changes when nobody holds the machine: four runs stay light, and the call cap is still HEAVY_CALL_LIGHT_MAX', () => K.free());

K.self = async (M = HJ) => {
  // The agent itself holds (its own bench): its own runs are not held back by its own slot.
  const x = rig(M);
  x.l.acquire('a', H, 'npm test', 'ha', false);
  x.l.noteCall('a', 'c1', SHAPES[0][1]);
  assert.deepEqual(await fourRuns(x, 'a', 100), ['light', 'light', 'light', 'light'], 'ITS OWN SLOT DOES NOT HOLD AN AGENT BACK: four runs stay light');
};
test('an agent that holds the slot itself is not held back: its four runs stay light', () => K.self());

K.perCall = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.noteCall('a', 'c1', SHAPES[0][1]);
  assert.deepEqual(await fourRuns(x, 'a', 100), ['light', 'wait', 'wait', 'wait']);
  x.l.noteCallEnd('a', 'c1');
  x.tick(HJ.HEAVY_CALL_SLACK_MS + 1);
  // A new command of the same agent gets its own one run. (It is queued already, so a run past it
  // waits as before.)
  x.l.noteCall('a', 'c2', 'node --test ' + FILE);
  assert.equal((await ask(x, 'a', 110)).state, 'light', 'THE HELD CAP IS PER CALL: a new command runs its one test light');
  // Another agent's command has its own one run too.
  x.l.noteCall('c', 'c3', SHAPES[0][1]);
  assert.deepEqual(await fourRuns(x, 'c', 120), ['light', 'wait', 'wait', 'wait'], "THE HELD CAP IS PER CALL: another agent's command has its own one run");
};
test("the held cap is per command: a new command, or another agent's, runs its one test light", () => K.perCall());

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

const MUTANTS = [
  { name: 'no held cap (the 2026-11-25 behaviour)', edits: [['    for (const h of this.holders.keys()) if (h !== agentId) return HEAVY_CALL_LIGHT_MAX_HELD;\n', '']], killer: 'held', dies: /ONE RUN WHILE ANOTHER AGENT HOLDS/ },
  { name: 'the held cap is two', edits: [['export const HEAVY_CALL_LIGHT_MAX_HELD = 1;', 'export const HEAVY_CALL_LIGHT_MAX_HELD = 2;']], killer: 'held', dies: /ONE RUN WHILE ANOTHER AGENT HOLDS/ },
  { name: 'the held cap always applies', edits: [['    for (const h of this.holders.keys()) if (h !== agentId) return HEAVY_CALL_LIGHT_MAX_HELD;\n    return HEAVY_CALL_LIGHT_MAX;', '    return HEAVY_CALL_LIGHT_MAX_HELD;']], killer: 'free', dies: /NOTHING CHANGES WHEN NOBODY HOLDS/ },
  { name: 'the agent\'s own slot counts as another holder', edits: [['if (h !== agentId) return HEAVY_CALL_LIGHT_MAX_HELD;', 'if (h) return HEAVY_CALL_LIGHT_MAX_HELD;']], killer: 'self', dies: /ITS OWN SLOT DOES NOT HOLD AN AGENT BACK/ },
  { name: 'the cap check reads the plain call cap', edits: [['    return (this.callLight.get(`${agentId}\\0${callId}`) ?? 0) < this.lightMax(agentId);', '    return (this.callLight.get(`${agentId}\\0${callId}`) ?? 0) < HEAVY_CALL_LIGHT_MAX;']], killer: 'held', dies: /ONE RUN WHILE ANOTHER AGENT HOLDS/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      let text = readSource(HJF).replace(/\r\n/g, '\n');
      for (const [from, to] of m.edits) {
        const hits = text.split(from).length - 1;
        assert.equal(hits, 1, `mutant ${m.name}: edit target must match EXACTLY ONCE, matched ${hits}`);
        text = text.replace(from, () => to);
      }
      const M = loadTs.fromText(HJF, text);
      await assert.rejects(async () => K[m.killer](M), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
