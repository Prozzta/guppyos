'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-LOOP-LIGHT-CAP (god 71c5fd, from Jim's note on HEAVY-PRELOAD-SHORT-TEST 19d95b96). A serial
 * loop over the whole suite (`for f in $(ls test/*.test.cjs); do node --test "$f"; done`) matched its
 * call's loop run (ANY_TEST_FILE) for every file, so at the preload it ran light end to end; only the
 * hook layer's deny stopped it.
 *
 * The cap: one call may run at most HEAVY_CALL_LIGHT_MAX test processes light, counted over every path
 * that ties a process to its call (the call's own run, a loop's run, a shown single file). After that its
 * test processes are leases: they take the slot, or wait for it. A count, not a runtime: a light run
 * never reports its end, so its runtime is not known; a count is exact and costs nothing per lease.
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
const MAX = HJ.HEAVY_CALL_LIGHT_MAX;

function rig(M = HJ) {
  let now = 1_000_000; const logs = []; const images = new Map(); const alive = new Set();
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, log: (r) => logs.push(r), setTimer: () => ({}), clearTimer: () => {},
    notify: () => {}, notifyLapse: () => {}, parentImage: async (pid) => images.get(pid) ?? null, pidAlive: (pid) => alive.has(pid), leasePollMs: 0
  });
  images.set(50, 'C:\\Program Files\\Git\\usr\\bin\\bash.exe');
  return { l, logs, images, alive, tick: (ms) => { now += ms; } };
}
const ask = (x, agentId, pid, more = {}) => x.l.lease(agentId, { op: 'acquire', pid, createdMs: C0, ppid: 50, files: [], ...more });

// The loop path (node by name: the call's loop run) and the shown path (node by variable).
const SUITE_LOOPS = [
  ['a loop run (node by name)', 'for f in $(ls test/*.test.cjs); do node --test "$f"; done'],
  ['a shown run (node by variable)', 'N=C:/n/node.exe; for f in $(ls test/*.test.cjs); do timeout 60 $N --test "$f"; done']
];

const K = {};

K.fewLight = async (M = HJ) => {
  assert.ok(MAX >= 8 && MAX <= 32, `the cap is a few files, not one and not the suite (${MAX})`);
  for (const [what, cmd] of [...SUITE_LOOPS, ['a literal loop', 'for f in a b c; do node --test test/$f.test.cjs; done']]) {
    const x = rig(M);
    x.l.acquire('b', H, 'npm test', 'hb', false);
    x.l.noteCall('a', 'c1', cmd);
    for (let i = 0; i < 3; i++) {
      const a = await ask(x, 'a', 100 + i, { files: [`test/f${i}.test.cjs`] });
      assert.equal(a.state, 'light', `A LOOP OF A FEW FILES STAYS LIGHT: ${what}, run ${i + 1}`);
      x.tick(5_000);
    }
  }
};
test('a loop of a few files stays light while another agent holds', () => K.fewLight());

K.suiteLease = async (M = HJ) => {
  for (const [what, cmd] of SUITE_LOOPS) {
    const x = rig(M);
    x.l.acquire('b', H, 'npm test', 'hb', false);
    x.l.noteCall('a', 'c1', cmd);
    for (let i = 0; i < MAX; i++) {
      assert.equal((await ask(x, 'a', 100 + i, { files: [`test/f${i}.test.cjs`] })).state, 'light', `${what}: run ${i + 1} of ${MAX} is light`);
      x.tick(2_000);
    }
    const over = await ask(x, 'a', 200, { files: ['test/over.test.cjs'] });
    assert.equal(over.state, 'wait', `A WHOLE-SUITE LOOP TAKES THE SLOT: past ${MAX} light runs it waits for the holder (${what})`);
    assert.equal(x.logs.filter((r) => r.action === 'call-light-spent' && r.callId === 'c1' && r.light === MAX).length, 1, 'the spent cap is logged once');
    x.l.callDone('b', 'hb');
    const held = await ask(x, 'a', 201, { files: ['test/over.test.cjs'] });
    assert.equal(held.state, 'held', `A WHOLE-SUITE LOOP TAKES THE SLOT: once free, its next file is a lease (${what})`);
    assert.ok(held.leaseId, 'a real lease');
    assert.deepEqual(x.l.snapshot().map((s) => s.agentId), ['a']);
  }
};
test('a whole-suite loop is turned into a lease: past the cap its files take the slot (loop and shown paths)', () => K.suiteLease());

K.perCall = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.noteCall('a', 'c1', SUITE_LOOPS[0][1]);
  for (let i = 0; i < MAX; i++) await ask(x, 'a', 100 + i, { files: [`test/f${i}.test.cjs`] });
  assert.equal((await ask(x, 'a', 150, { files: ['test/x.test.cjs'] })).state, 'wait');
  x.l.noteCallEnd('a', 'c1');
  x.l.noteCall('a', 'c2', 'node --test test/x.test.cjs');
  const a = await ask(x, 'a', 151, { files: ['test/x.test.cjs'] });
  assert.deepEqual([a.state, a.why], ['light', "the call's own node --test"], 'THE CAP IS PER CALL: THE NEXT SINGLE-FILE CALL IS LIGHT AT ONCE');
  x.l.noteCall('c', 'c3', SUITE_LOOPS[1][1]);
  assert.equal((await ask(x, 'c', 152, { files: ['test/x.test.cjs'] })).state, 'light', "THE CAP IS PER CALL: another agent's call has its own");
};
test('the cap is per call: a new call, or another agent\'s call, starts light again', () => K.perCall());

K.single = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('b', H, 'npm test', 'hb', false);
  x.l.noteCall('a', 'c1', 'node --test test/a.test.cjs');
  const a = await ask(x, 'a', 101, { files: ['test/a.test.cjs'] });
  assert.deepEqual([a.state, a.why], ['light', "the call's own node --test"], 'THE SINGLE-FILE CASE STILL PASSES');
  x.l.noteCall('a', 'c2', 'N=C:/n/node.exe; timeout -k 5 40 $N --test test/b.test.cjs');
  const b = await ask(x, 'a', 102, { files: ['test/b.test.cjs'] });
  assert.deepEqual([b.state, b.why], ['light', 'one test file under a shell'], 'THE SINGLE-FILE CASE STILL PASSES (node by variable)');
};
test('the single-file case still passes while another agent holds', () => K.single());

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

const MUTANTS = [
  { name: 'no cap', edits: [['    return (this.callLight.get(`${agentId}\\0${callId}`) ?? 0) < HEAVY_CALL_LIGHT_MAX;', '    return true;']], killer: 'suiteLease', dies: /A WHOLE-SUITE LOOP TAKES THE SLOT/ },
  { name: 'the loop path is not counted', edits: [['    if (!loop(c)) c.used = true;\n    this.spendLight(agentId, c.callId);', '    if (!loop(c)) c.used = true;']], killer: 'suiteLease', dies: /A WHOLE-SUITE LOOP TAKES THE SLOT: .*\(a loop run/ },
  { name: 'the shown path is not counted', edits: [['    this.spendLight(agentId, call.callId);\n', '']], killer: 'suiteLease', dies: /A WHOLE-SUITE LOOP TAKES THE SLOT: .*\(a shown run/ },
  { name: 'the loop path ignores the cap', edits: [['\n      && this.lightLeft(agentId, c.callId));', ');']], killer: 'suiteLease', dies: /A WHOLE-SUITE LOOP TAKES THE SLOT: .*\(a loop run/ },
  { name: 'the shown path ignores the cap', edits: [['this.callOpen(c, t) && this.lightLeft(agentId, c.callId)).pop();', 'this.callOpen(c, t)).pop();']], killer: 'suiteLease', dies: /A WHOLE-SUITE LOOP TAKES THE SLOT/ },
  { name: 'one count per agent, not per call', edits: [['  private lightLeft(agentId: string, callId: string): boolean {\n    return (this.callLight.get(`${agentId}\\0${callId}`)', '  private lightLeft(agentId: string, callId: string): boolean {\n    return (this.callLight.get(`${agentId}\\0x`)'], ['    const k = `${agentId}\\0${callId}`;', '    const k = `${agentId}\\0x`;'], ['!ids.has(k.slice(agentId.length + 1))) this.callLight.delete(k);', '!ids.has(k.slice(agentId.length + 1))) void k;']], killer: 'perCall', dies: /THE CAP IS PER CALL/ },
  { name: 'a cap of one', edits: [['export const HEAVY_CALL_LIGHT_MAX = 10;', 'export const HEAVY_CALL_LIGHT_MAX = 1;']], killer: 'fewLight', dies: /A LOOP OF A FEW FILES STAYS LIGHT/ }
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
