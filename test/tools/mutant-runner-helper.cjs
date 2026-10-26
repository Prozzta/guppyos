'use strict';

// A finally block cannot run after taskkill/SIGKILL.  Keep the original bytes on
// disk before each edit so the next mutant-runner invocation repairs an interrupted
// run before it reads a baseline or writes another mutant.
// The journal names its owner (pid + process start time).  A second runner started
// while the owner is still mutating must not restore the owner's live mutant (the
// owner would then measure the original source and report a false survival), so
// recovery refuses while that exact process lives.  The start time tells a reused
// pid apart from the owner.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const journalPath = (root) => path.join(root, '.mutant-runner-recovery.json');

// Every tree a census mutates in place: TypeScript under src/, the shipped CLI under resources/ (m1), the
// release scripts under scripts/ (release-worktrees). Anything else is not a mutant and is never restored.
// test/ too (god 5cc045): the runner censuses mutate test/tools/run-tests.cjs, the temp-jail helpers, the electron
// harness and one suite in place; they are gated by hand (gate below) because load-ts never sees them.
const MUTABLE = ['src', 'resources', 'scripts', 'test'];
function checked(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !MUTABLE.some((dir) => rel.startsWith(`${dir}${path.sep}`))) {
    throw new Error(`refusing mutant recovery path outside ${MUTABLE.join('/, ')}/: ${file}`);
  }
  return path.resolve(file);
}

// The OS's start time for pid, as an opaque string, or null when the pid is gone or unreadable.
// MUTANT_RUNNER_UNREADABLE_START_PID simulates a failed read (powershell error or timeout) for one pid.
function processStart(pid) {
  if (String(pid) === process.env.MUTANT_RUNNER_UNREADABLE_START_PID) return null;
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null;
    } catch { return null; }
  }
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: require('./ps-env.cjs').psEnv() })
    : spawnSync('ps', ['-o', 'lstart=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 60_000 });
  const out = r.status === 0 ? String(r.stdout || '').trim() : '';
  return out || null;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// A live pid whose start time cannot be read now (a failed or timed-out read) may be the owner:
// fail closed.  The cost is a manual journal delete when a reused pid stays unreadable.
function ownerLive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid === process.pid || !alive(owner.pid)) return false;
  const start = processStart(owner.pid);
  return start === null || start === owner.start;
}

let self = null;
function selfOwner() {
  if (self) return self;
  const start = processStart(process.pid);
  if (!start) throw new Error(`cannot read this runner's own process start time (pid ${process.pid}); refusing to mutate without an owner guard`);
  return (self = { pid: process.pid, start });
}

function readJournal(root) {
  const journal = journalPath(root);
  if (!fs.existsSync(journal)) return { owner: null, records: [] };
  const parsed = JSON.parse(fs.readFileSync(journal, 'utf8'));
  // A journal from before the owner guard is a bare array: no owner, so nothing can be live.
  const owner = Array.isArray(parsed) ? null : parsed && parsed.owner;
  const records = Array.isArray(parsed) ? parsed : parsed && parsed.records;
  if (!Array.isArray(records)) throw new Error(`invalid mutant recovery journal: ${journal}`);
  return {
    owner: owner && typeof owner === 'object' ? owner : null,
    records: records.map((record) => ({
      file: checked(root, record.file),
      original: Buffer.from(record.original, 'base64').toString('utf8')
    }))
  };
}

function writeJournal(root, records) {
  const journal = journalPath(root);
  if (!records.length) {
    fs.rmSync(journal, { force: true });
    return;
  }
  const temp = `${journal}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({
    owner: selfOwner(),
    records: records.map(({ file, original }) => ({
      file, original: Buffer.from(original, 'utf8').toString('base64')
    }))
  }), 'utf8');
  fs.renameSync(temp, journal);
}

/**
 * MUTANT-JOURNAL-GATE (Jim 1b5d87/b0a10e): what the tree's journal says, for a runner that must not run on
 * mutated bytes. files: the journaled (still mutated) files, relative to root; live: their owner still runs.
 */
function journalState(root) {
  const { owner, records } = readJournal(root);
  return { owner, live: records.length > 0 && ownerLive(owner), files: records.map((record) => path.relative(root, record.file)) };
}

function recover(root, log = (line) => console.log(line)) {
  const { owner, records } = readJournal(root);
  if (records.length && ownerLive(owner)) {
    throw new Error(`mutant runner pid ${owner.pid} (started ${owner.start}) is still running, or its start time cannot be read to confirm it is not, `
      + `and owns ${journalPath(root)}; not restoring its live mutant. Wait for it to finish, or stop that runner first `
      + '(if that pid is not a mutant runner, delete the journal by hand).');
  }
  for (const record of records) {
    fs.writeFileSync(record.file, record.original, 'utf8');
    // Never silent: the next runner's log shows a mutant was left behind (Jim b0a10e).
    log(`[mutant-runner] restored ${path.relative(root, record.file)} left mutated by an interrupted run (pid ${owner ? owner.pid : 'unknown'})`);
  }
  if (records.length) writeJournal(root, []);
  return records.length;
}

/**
 * MUTANT-JOURNAL-GATE (god 5b1c57, Jim NIT): a bare `node --test <file>` never goes through run-tests.cjs, so
 * test/load-ts.cjs asks this before it loads any TypeScript. The suites a census spawns run while its journal
 * is live: they are the measurement, and they inherit MUTANT_RUNNER_PID (set by mutateFile) naming that owner.
 * The runner itself (owner pid == this pid) may load too. Every other process refuses, never silently.
 * gate names the caller: load-ts, or a suite that reads a journaled non-TS file itself (god 9cb49c NIT 1).
 */
function assertUnmutated(root, gate = 'load-ts') {
  const { owner, live, files } = journalState(root);
  if (!files.length) return;
  if (owner && owner.pid === process.pid) return;
  if (live && String(owner.pid) === process.env.MUTANT_RUNNER_PID) return;
  const who = live ? `mutant runner pid ${owner.pid} (started ${owner.start}) is still mutating this tree; wait for it or stop it`
    : `an interrupted mutant runner${owner ? ` (pid ${owner.pid}, dead)` : ''} left mutated files behind; run: node test/tools/claims90-m1-mutants.cjs --recover-only`;
  throw new Error(`[${gate}] refusing to load mutated source: ${who}. Journaled: ${files.join(', ')}`);
}

function mutateFile(root, file, original, mutated) {
  const abs = checked(root, file);
  const { owner, records } = readJournal(root);
  // Another runner started between our mutants and is now mutating: do not take its journal over.
  if (records.length && owner && owner.pid !== process.pid && ownerLive(owner)) {
    throw new Error(`mutant runner pid ${owner.pid} is mutating this tree concurrently; stopping`);
  }
  if (records.some((record) => record.file === abs)) throw new Error(`already mutating ${abs}`);
  writeJournal(root, [...records, { file: abs, original }]);
  // The suites this runner spawns inherit the owner pid: load-ts lets exactly them load the mutant.
  process.env.MUTANT_RUNNER_PID = String(process.pid);
  fs.writeFileSync(abs, mutated, 'utf8');
  const pause = Number(process.env.MUTANT_RUNNER_PAUSE_AFTER_MUTATE_MS || 0);
  if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
}

function restoreFile(root, file, original) {
  const abs = checked(root, file);
  fs.writeFileSync(abs, original, 'utf8');
  writeJournal(root, readJournal(root).records.filter((record) => record.file !== abs));
}

/** The one-line suite gate (god 5cc045/ed8032): a suite that loads a file a census mutates (a non-TS file load-ts
 * never sees) calls gate(__filename) at module top and refuses a mutated tree under its own repo-relative name. */
function gate(filename) {
  const root = path.resolve(__dirname, '..', '..');
  assertUnmutated(root, path.relative(root, filename).split(path.sep).join('/'));
}

module.exports = { recover, mutateFile, restoreFile, journalPath, journalState, assertUnmutated, gate, processStart };
