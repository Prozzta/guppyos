'use strict';

/**
 * SUITE-LOAD-FLAKES-1027: the clock for a cost bar on synchronous, single-thread code.
 *
 * A bar such as "the model builds in under 500 ms" is a bound on the WORK the code does. Timed with
 * performance.now() or Date.now() in the parallel suite it also counted every millisecond the test's
 * thread waited for a core (cards-tab-190 MUST 2: 13 ms alone, 744 ms in a full run), so the test
 * measured the machine and failed a different bar on each run. This thread's CPU time (user + system,
 * process.threadCpuUsage, Node 23.9+) does not advance while the thread is off the CPU.
 *
 * On Windows it is GetThreadTimes, which advances in scheduler ticks (15.6 ms): a short stretch reads
 * 0 or one tick. Use it for bars that are several ticks wide, never to compare two short stretches.
 * It is the same clock the product's mirror cost guard uses (src/main/terminalMirror.ts threadCpuMs).
 */
if (typeof process.threadCpuUsage !== 'function') {
  throw new Error(`thread-cpu.cjs needs process.threadCpuUsage (Node 23.9+); this is ${process.version}`);
}

/** This thread's CPU time so far, in ms. */
function threadCpuMs() {
  const u = process.threadCpuUsage();
  return (u.user + u.system) / 1000;
}

/** Runs fn (synchronous) and returns the thread CPU ms it used. */
function cpuMsOf(fn) {
  const t0 = threadCpuMs();
  fn();
  return threadCpuMs() - t0;
}

module.exports = { threadCpuMs, cpuMsOf };
