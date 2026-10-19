'use strict';
/**
 * LOAD-BURST-196: run-tests.cjs loads this into every process of its `node --test` through
 * NODE_OPTIONS. node --test starts a file process per core at once, and every one of them loads
 * its code (TypeScript transpiles, job joins, harness setup) in the same first seconds: the FULL's
 * opening burst, where a stub hook took 30 s and five files failed only there (Jim a094f1).
 *
 * In a test-file process, before any test code loads, the file takes one of SLOTS start slots (a
 * slot file made with 'wx' in the run's gate folder) and gives it back once its top level has run
 * (setImmediate: CommonJS loads the main module before the event loop turns). So at most SLOTS files
 * load at once, whatever the lane count; later starts are staggered by the run itself and rarely wait.
 * A slot whose holder is gone (dead pid, or held past STALE_MS) is taken over; a file that waited
 * WAIT_MS goes on without one (said on stderr), so the gate can slow a start but never hang it.
 *
 * Every file appends its start record to <gate>/starts.jsonl (the runner sums the burst from it):
 *   { file, bornMs, takenMs, waitMs, loadMs, slot }  bornMs = process start, takenMs = slot taken,
 *   waitMs = gate wait, loadMs = top level done minus process start (the wait included);
 *   slot = -1 when it went on without one.
 * SLOTS 0 records only (the before measurement). The file takes this back out of NODE_OPTIONS, so
 * nothing it starts loads it again.
 */
const fs = require('fs');
const path = require('path');

const STALE_MS = 60_000;
const WAIT_MS = 120_000;
const POLL_MS = 25;
// Every slot failing to be created (not EEXIST) this many polls in a row: the gate folder is unusable.
const FAULT_POLLS = 40;

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const create = (p) => fs.writeFileSync(p, String(process.pid), { flag: 'wx' });

/**
 * Takes a free slot (or one whose holder is gone); -1 when none is free now, -2 when the gate is gone,
 * -3 when no slot could even be created (every create failed with neither EEXIST nor a missing folder).
 */
function tryTake(dir, slots, now = Date.now, make = create) {
  let faults = 0;
  for (let k = 0; k < slots; k++) {
    const p = path.join(dir, `slot-${k}`);
    try {
      make(p);
      return k;
    } catch (e) {
      // No gate folder (the run removed it, or it never was): there is nothing to wait for. Any
      // other failure is a busy slot: Windows refuses a create (EPERM) while another process's
      // delete of that file is still pending (the after FULL: 13 starts went on without a slot).
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return -2;
      if (e.code !== 'EEXIST') { faults++; continue; }
    }
    try {
      const pid = Number(fs.readFileSync(p, 'utf8'));
      const held = now() - fs.statSync(p).mtimeMs;
      // An empty file is a holder between its create and its write: young, so never stale here.
      if ((pid > 0 && !alive(pid)) || held > STALE_MS) fs.rmSync(p, { force: true });
    } catch { /* gone meanwhile: the next pass takes it */ }
  }
  return faults === slots ? -3 : -1;
}

/**
 * Waits for a slot, up to waitMs; returns the slot (or -1) and the time waited. A create fault on every
 * slot is a pending delete for a moment; FAULT_POLLS of them in a row is a gate folder that cannot be
 * written (EACCES, EPERM), and waiting the full waitMs in every file would add that to every wave.
 */
function take(dir, slots, { waitMs = WAIT_MS, now = Date.now, sleep = pause, make = create } = {}) {
  const t0 = now();
  if (slots <= 0) return { slot: -1, waitMs: 0, timedOut: false };
  let faulted = 0;
  for (;;) {
    const slot = tryTake(dir, slots, now, make);
    faulted = slot === -3 ? faulted + 1 : 0;
    if (faulted >= FAULT_POLLS) return { slot: -1, waitMs: now() - t0, timedOut: false, faulted: true };
    if (slot !== -1 && slot !== -3) return { slot: Math.max(slot, -1), waitMs: now() - t0, timedOut: false };
    if (now() - t0 >= waitMs) return { slot: -1, waitMs: now() - t0, timedOut: true };
    sleep(POLL_MS);
  }
}

function give(dir, slot) {
  if (slot < 0) return;
  const p = path.join(dir, `slot-${slot}`);
  try { if (Number(fs.readFileSync(p, 'utf8')) === process.pid) fs.rmSync(p, { force: true }); } catch { /* taken over */ }
}

/** The preload proper. */
function gate(env = process.env) {
  const spec = env.GUPPY_START_GATE; // `<slots>|<dir>`
  const opt = env.GUPPY_START_OPT;   // the exact text run-tests added to NODE_OPTIONS
  if (!spec || !opt || !String(env.NODE_TEST_CONTEXT || '').startsWith('child')) return;
  env.NODE_OPTIONS = String(env.NODE_OPTIONS || '').replace(opt, '').trim();
  if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS;
  delete env.GUPPY_START_GATE;
  delete env.GUPPY_START_OPT;
  const bar = spec.indexOf('|');
  const slots = Number(spec.slice(0, bar));
  const dir = spec.slice(bar + 1);
  const bornMs = Math.round(Date.now() - process.uptime() * 1000);
  const gateMs = Date.now();
  const got = take(dir, slots);
  const file = path.relative(process.cwd(), process.argv[1] || '') || '?';
  if (got.timedOut) process.stderr.write(`[test-runner] ${file} waited ${got.waitMs} ms for a start slot (LOAD-BURST-196) and starts without one\n`);
  if (got.faulted) process.stderr.write(`[test-runner] ${file}: no start slot can be created in ${dir} (LOAD-BURST-196); it starts without one\n`);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const doneMs = Date.now();
    give(dir, got.slot);
    const rec = { file, bornMs, takenMs: gateMs + got.waitMs, waitMs: got.waitMs, loadMs: doneMs - bornMs, slot: got.slot };
    try { fs.appendFileSync(path.join(dir, 'starts.jsonl'), `${JSON.stringify(rec)}\n`); } catch { /* the gate folder is gone: the run is over */ }
  };
  setImmediate(finish);
  process.once('exit', finish);
}

/**
 * The runner's summary of the opening burst, from starts.jsonl: the files born in the first
 * windowMs of the run, their load time (p50/p95/max) and gate wait (max), and the most loading at once.
 */
function burstSummary(text, { windowMs = 60_000 } = {}) {
  const recs = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (Number.isFinite(r.bornMs) && Number.isFinite(r.loadMs)) recs.push(r); } catch { /* a torn line */ }
  }
  if (!recs.length) return null;
  const t0 = Math.min(...recs.map((r) => r.bornMs));
  const early = recs.filter((r) => r.bornMs - t0 < windowMs);
  const sorted = (f) => early.map(f).sort((a, b) => a - b);
  const pctOf = (xs, q) => xs[Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1)];
  const loads = sorted((r) => r.loadMs);
  // Load net of the gate wait: the work itself, comparable with a run without the gate.
  const nets = sorted((r) => r.loadMs - (r.waitMs || 0));
  const pct = (q) => pctOf(loads, q);
  // The most files at one moment between two points of their start: born to top level done
  // (loading, the wait included), and slot taken to top level done (holding: what the cap bounds).
  const peakOf = (from) => {
    const edges = recs.flatMap((r) => [[from(r), 1], [r.bornMs + r.loadMs, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0; let peak = 0;
    for (const [, d] of edges) { open += d; peak = Math.max(peak, open); }
    return peak;
  };
  return {
    files: recs.length, early: early.length, windowMs,
    loadP50: pct(0.5), loadP95: pct(0.95), loadMax: loads[loads.length - 1],
    netP50: pctOf(nets, 0.5), netP95: pctOf(nets, 0.95), netMax: nets[nets.length - 1],
    waitMax: Math.max(...early.map((r) => r.waitMs || 0)),
    peakLoading: peakOf((r) => r.bornMs), peakHolding: peakOf((r) => r.takenMs ?? r.bornMs + (r.waitMs || 0)),
    noSlot: recs.filter((r) => r.slot === -1 && r.waitMs > 0).length
  };
}

module.exports = { tryTake, take, give, gate, burstSummary, STALE_MS, WAIT_MS, FAULT_POLLS };

if (require.main !== module && process.env.GUPPY_START_GATE) gate();
