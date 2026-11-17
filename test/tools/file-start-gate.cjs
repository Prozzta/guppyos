'use strict';
/**
 * LOAD-BURST-196: run-tests.cjs loads this into every process of its `node --test` through
 * NODE_OPTIONS. node --test starts a file process per core at once, and every one of them loads
 * its code (TypeScript transpiles, job joins, harness setup) in the same first seconds: the FULL's
 * opening burst, where a stub hook took 30 s and five files failed only there (Jim a094f1).
 *
 * In a test-file process, before any test code loads, the file takes one of SLOTS start slots and
 * gives it back once its top level has run (setImmediate: CommonJS loads the main module before the
 * event loop turns). So at most SLOTS files load at once, whatever the lane count; later starts are
 * staggered by the run itself and rarely wait. A slot whose holder is gone (dead pid, or held past
 * STALE_MS) is taken over; a file that waited WAIT_MS goes on without one (said on stderr), so the
 * gate can slow a start but never hang it.
 *
 * A slot is a FOLDER, <gate>/slot-<k>, holding one marker file NAMED by its holder's pid
 * (TEST-GATE-SLOT-TAKEOVER-107). The holder builds the folder and its marker aside and renames it
 * into place, so a slot never exists without its holder in it. A waiter clears a holder that is gone
 * by removing THAT holder's marker by name, then the folder only if it is empty. So a waiter that
 * read an old holder can never remove a newer one: the old marker is not there, and the folder is
 * not empty. (Before, the slot was one file with the pid inside. A waiter read the pid, the holder
 * gave the slot back and exited, another file took the slot, and the waiter then removed the file by
 * its path: the newer holder's. One file more than SLOTS got past the gate.)
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

/**
 * Takes the slot folder p for this process, or throws: EEXIST when it is held, ENOENT when the gate
 * folder is gone. The folder is built aside with this process's marker in it and renamed into place:
 * one step, so no other process ever sees the slot without its holder.
 */
function claim(p) {
  const mine = path.join(path.dirname(p), `claim-${process.pid}`);
  try { fs.mkdirSync(mine); } catch (e) { if (e.code !== 'EEXIST') throw e; /* left by an earlier pass */ }
  fs.writeFileSync(path.join(mine, String(process.pid)), '');
  try { fs.renameSync(mine, p); } catch (e) {
    // Windows refuses a rename onto a folder (EPERM); POSIX refuses one that is not empty.
    if (fs.existsSync(p)) throw Object.assign(new Error(`${p} is held`), { code: 'EEXIST' });
    throw e;
  }
}

/** This process's claim folder, when it goes on without a slot. */
function unclaim(dir) {
  try { fs.rmSync(path.join(dir, `claim-${process.pid}`), { recursive: true, force: true }); } catch { /* the gate is gone */ }
}

/**
 * Clears the holders of slot folder p that are gone. Each is removed by its own name, never by the
 * slot's path; the folder goes only if that left it empty (rmdir refuses one that is not).
 */
function clearGone(p, now) {
  let names;
  try { names = fs.readdirSync(p); } catch { return; /* gone meanwhile: the next pass takes it */ }
  for (const name of names) {
    const m = path.join(p, name);
    try {
      const pid = Number(name);
      const held = now() - fs.statSync(m).mtimeMs;
      if ((pid > 0 && !alive(pid)) || held > STALE_MS) fs.rmSync(m, { force: true });
    } catch { /* that holder gave it back meanwhile */ }
  }
  try { fs.rmdirSync(p); } catch { /* held (not empty), or gone meanwhile */ }
}

/**
 * Takes a free slot (or clears one whose holder is gone, for the next pass); -1 when none is free now,
 * -2 when the gate is gone, -3 when no slot could even be created (every create failed with neither
 * EEXIST nor a missing folder).
 */
function tryTake(dir, slots, now = Date.now, make = claim) {
  let faults = 0;
  for (let k = 0; k < slots; k++) {
    const p = path.join(dir, `slot-${k}`);
    try {
      make(p);
      return k;
    } catch (e) {
      // No gate folder (the run removed it, or it never was): there is nothing to wait for. Any
      // other failure is a busy slot: Windows refuses a create (EPERM) while another process's
      // delete of that folder is still pending (the after FULL: 13 starts went on without a slot).
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return -2;
      if (e.code !== 'EEXIST') { faults++; continue; }
    }
    clearGone(p, now);
  }
  return faults === slots ? -3 : -1;
}

/**
 * Waits for a slot, up to waitMs; returns the slot (or -1) and the time waited. A create fault on every
 * slot is a pending delete for a moment; FAULT_POLLS of them in a row is a gate folder that cannot be
 * written (EACCES, EPERM), and waiting the full waitMs in every file would add that to every wave.
 */
function take(dir, slots, { waitMs = WAIT_MS, now = Date.now, sleep = pause, make = claim } = {}) {
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
  // Its own marker, by name; then the folder, which goes only if no newer holder is in it.
  try { fs.rmSync(path.join(p, String(process.pid)), { force: true }); fs.rmdirSync(p); } catch { /* taken over */ }
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
  if (got.slot < 0) unclaim(dir);
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

module.exports = { claim, tryTake, take, give, gate, burstSummary, STALE_MS, WAIT_MS, FAULT_POLLS };

if (require.main !== module && process.env.GUPPY_START_GATE) gate();
