'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * readAgentUsage incremental-cache tests. Self-contained, no framework — run
 * with `node test/transcript-usage.test.cjs` (mirrors test/breaker.test.cjs).
 * transcript.ts + its dependencies pricing.ts and safeDirectoryWatch.ts are
 * transpiled with the bundled `typescript` compiler.
 *
 * The breaker/cost beat calls readAgentUsage every ~30s per agent (transcript
 * fallback); it used to re-read and re-JSON.parse EVERY transcript in the
 * project dir each call. These tests pin the cached implementation to the same
 * observable results across appends, partial writes, rewrites, and session
 * filters — correctness of the incremental path, not just speed.
 *
 * SCALE-TRANSCRIPT-SCAN: a project dir is now watched (one non-polling watch per
 * dir), and a call only stats the files a change event named. A write by another
 * process (Claude Code) reaches the next call through that event, so a test that
 * writes and then reads first awaits the watch's event for that file (`changed`),
 * never a sleep.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tempDir } = require('./tools/test-temp.cjs');
const ts = require('typescript');

// Sandbox HOME so projectDir() maps into a throwaway dir, never the user's
// real ~/.claude/projects. os.homedir() reads $HOME/$USERPROFILE per call.
const FAKE_HOME = tempDir('home-');
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const SRC = path.join(__dirname, '..', 'src', 'main');
const out = tempDir('transcript-');
for (const name of ['pricing', 'safeDirectoryWatch', 'transcript']) {
  const js = ts.transpileModule(fs.readFileSync(path.join(SRC, `${name}.ts`), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  fs.writeFileSync(path.join(out, `${name}.js`), js, 'utf8');
}
const T = require(path.join(out, 'transcript.js'));
const { readAgentUsage, projectDir } = T;

/** A fake cwd whose projectDir we can write transcripts into. */
function makeProject() {
  const cwd = tempDir('proj-');
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return { cwd, dir };
}

function rec(output, opts = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: opts.sessionId ?? 's1',
    message: {
      model: opts.model ?? 'claude-haiku-4-5',
      usage: { input_tokens: opts.input ?? 10, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    }
  });
}

/** Do `write`, then wait for the dir watch's event naming `file` (the watch must exist: a
 *  read of the dir has been made). Resolves on the event itself: no timer. */
async function changed(dir, file, write) {
  // The watch is persistent: false (it must never hold the app open), so hold the loop open
  // while waiting, or node would exit (rc 0, tests unrun) before the event is delivered.
  const hold = setInterval(() => {}, 60_000);
  const seen = new Promise((resolve) => {
    T.__onTranscriptWatchEvent((d, _event, f) => { if (d === dir && f === file) { T.__onTranscriptWatchEvent(null); resolve(); } });
  });
  write();
  try { await seen; } finally { clearInterval(hold); }
}

/** Spy on the fs calls transcript.js makes (it calls node:fs's functions through the module object). */
function spyFs() {
  const names = ['statSync', 'readdirSync', 'openSync', 'readSync', 'readFileSync', 'existsSync'];
  const orig = Object.fromEntries(names.map((n) => [n, fs[n]]));
  const seen = Object.fromEntries(names.map((n) => [n, []]));
  for (const n of names) fs[n] = function (p, ...a) { seen[n].push(typeof p === 'number' ? `fd` : String(p)); return orig[n].call(this, p, ...a); };
  return { seen, restore: () => Object.assign(fs, orig) };
}

let failures = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('sums usage across records and files', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), rec(100) + '\n' + rec(200) + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), rec(50) + '\n');
  const u = readAgentUsage(cwd, { provider: 'claude' });
  assert.equal(u.outputTokens, 350);
  assert.equal(u.inputTokens, 30);
  assert.ok(u.estimatedCostUsd > 0);
});

test('redacted Claude usage fixture preserves 5m/1h cache writes for exact pricing', () => {
  const { cwd, dir } = makeProject();
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing-cache-ttl-split', 'claude-usage-redacted.jsonl'), 'utf8');
  fs.writeFileSync(path.join(dir, 'redacted.jsonl'), fixture);
  const u = readAgentUsage(cwd, { provider: 'claude' });
  assert.equal(u.cacheWriteTokens, 1_000_000);
  assert.equal(u.cacheWrite5mTokens, 400_000);
  assert.equal(u.cacheWrite1hTokens, 600_000);
  assert.equal(u.estimatedCostUsd, 6.8);
});

test('appended records are picked up (incremental tail parse)', async () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, rec(100) + '\n');
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 100); // primes the cache
  await changed(dir, 'a.jsonl', () => fs.appendFileSync(f, rec(25) + '\n' + rec(75) + '\n'));
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 200);
});

test('repeat reads with no change are stable', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), rec(100) + '\n');
  const a = readAgentUsage(cwd, { provider: 'claude' });
  const b = readAgentUsage(cwd, { provider: 'claude' });
  assert.deepEqual(b, a);
});

test('a partial trailing line is not counted until completed', async () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  const full = rec(500);
  fs.writeFileSync(f, rec(100) + '\n' + full.slice(0, 40)); // torn mid-write
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 100);
  await changed(dir, 'a.jsonl', () => fs.appendFileSync(f, full.slice(40) + '\n')); // writer finishes the line
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 600, 'completed line counts exactly once');
});

test('a rewritten (shrunk) file is re-parsed from scratch', async () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, rec(100) + '\n' + rec(200) + '\n');
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 300);
  await changed(dir, 'a.jsonl', () => fs.writeFileSync(f, rec(40) + '\n')); // smaller rewrite
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 40);
});

test('a deleted file drops out of the totals', async () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), rec(100) + '\n');
  fs.writeFileSync(path.join(dir, 'b.jsonl'), rec(50) + '\n');
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 150);
  await changed(dir, 'b.jsonl', () => fs.rmSync(path.join(dir, 'b.jsonl')));
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 100);
});

test('sessionId filter sums only that session, incrementally too', async () => {
  const { cwd, dir } = makeProject();
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, rec(100, { sessionId: 's1' }) + '\n' + rec(999, { sessionId: 's2' }) + '\n');
  assert.equal(readAgentUsage(cwd, { sessionId: 's1', provider: 'claude' }).outputTokens, 100);
  await changed(dir, 'a.jsonl', () => fs.appendFileSync(f, rec(11, { sessionId: 's1' }) + '\n' + rec(888, { sessionId: 's2' }) + '\n'));
  assert.equal(readAgentUsage(cwd, { sessionId: 's1', provider: 'claude' }).outputTokens, 111);
  assert.equal(readAgentUsage(cwd, { sessionId: 's2', provider: 'claude' }).outputTokens, 1887);
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 1998, 'unfiltered still sums everything');
});

test('malformed lines and non-assistant records are skipped', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'),
    'not json\n' + JSON.stringify({ type: 'user' }) + '\n' + rec(70) + '\n\n');
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 70);
});

test('model is the last one seen (per current semantics)', () => {
  const { cwd, dir } = makeProject();
  fs.writeFileSync(path.join(dir, 'a.jsonl'),
    rec(1, { model: 'claude-haiku-4-5' }) + '\n' + rec(2, { model: 'claude-opus-4-8' }) + '\n');
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).model, 'claude-opus-4-8');
});

test('missing project dir yields zeros', () => {
  const u = readAgentUsage('/nonexistent/cwd/for/testing', { provider: 'claude' });
  assert.equal(u.outputTokens, 0);
  assert.equal(u.estimatedCostUsd, 0);
});

// ---- SCALE-TRANSCRIPT-SCAN (Jim's STARTUP-SCALE-YEAR audit A14) ----

/** A year-like dir: many old sessions, mixed models, and records of two sessions per file. */
function yearDir(n = 40) {
  const p = makeProject();
  for (let i = 0; i < n; i += 1) {
    const lines = [rec(100 + i, { sessionId: `s${i}`, model: i % 3 ? 'claude-haiku-4-5' : 'claude-opus-4-8', input: 7 + i }), rec(3 * i + 1, { sessionId: `s${(i + 1) % n}` })];
    fs.writeFileSync(path.join(p.dir, `${String(i).padStart(3, '0')}.jsonl`), lines.join('\n') + '\n');
  }
  return p;
}

/** The totals a from-scratch, stat-every-file read gives (a fresh module: no cache, no watch). */
function coldRead(cwd, opts) {
  const fresh = path.join(out, `transcript-cold-${Math.random().toString(36).slice(2)}.js`);
  fs.copyFileSync(path.join(out, 'transcript.js'), fresh);
  const cold = require(fresh);
  try { return cold.readAgentUsage(cwd, opts); } finally { cold.closeTranscriptWatches(); }
}

test('SCALE-TRANSCRIPT-SCAN: a second beat with no change reads, lists and stats no transcript (fs spy)', () => {
  const { cwd, dir } = yearDir();
  const first = readAgentUsage(cwd, { provider: 'claude' });
  assert.equal(T.__transcriptWatchOpen(cwd), true, 'the first read armed the dir watch');
  const spy = spyFs();
  let again;
  try {
    for (let i = 0; i < 20; i += 1) again = readAgentUsage(cwd, { provider: 'claude' });
  } finally { spy.restore(); }
  assert.deepEqual(again, first, 'same totals');
  assert.deepEqual(spy.seen.readdirSync, [], 'no listing');
  assert.deepEqual(spy.seen.statSync, [], 'no file stat');
  assert.deepEqual(spy.seen.openSync, [], 'no file opened');
  // projectDir() resolves the dir with one existsSync and the beat checks it is still there with another: O(dirs).
  assert.ok(spy.seen.existsSync.length <= 40 && spy.seen.existsSync.every((p) => p === dir), `only the dir is checked, at most twice a beat: ${spy.seen.existsSync.length}`);
});

test('SCALE-TRANSCRIPT-SCAN: an append stats and tail-reads only that file; totals equal a cold full read', async () => {
  const { cwd, dir } = yearDir();
  readAgentUsage(cwd, { provider: 'claude' });
  const f = path.join(dir, '007.jsonl');
  await changed(dir, '007.jsonl', () => fs.appendFileSync(f, rec(55, { sessionId: 's7', model: 'claude-opus-4-8' }) + '\n'));
  const spy = spyFs();
  let u;
  try { u = readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
  assert.deepEqual(spy.seen.statSync, [f], 'only the appended file is stat\'ed');
  assert.deepEqual(spy.seen.openSync, [f], 'only the appended file is opened');
  assert.deepEqual(spy.seen.readdirSync, [], 'a change (not a create) does not re-list');
  assert.deepEqual(u, coldRead(cwd, { provider: 'claude' }), 'the same totals, model and float cost as a stat-all read');
  for (const sid of ['s7', 's8', 's0']) {
    assert.deepEqual(readAgentUsage(cwd, { provider: 'claude', sessionId: sid }), coldRead(cwd, { provider: 'claude', sessionId: sid }), `session ${sid}`);
  }
});

test('SCALE-TRANSCRIPT-SCAN: a new session filter reads no file already parsed (it used to re-read every one)', () => {
  const { cwd } = yearDir();
  readAgentUsage(cwd, { provider: 'claude' });
  const spy = spyFs();
  let u;
  try { u = readAgentUsage(cwd, { provider: 'claude', sessionId: 's12' }); } finally { spy.restore(); }
  assert.deepEqual([spy.seen.statSync, spy.seen.openSync, spy.seen.readdirSync], [[], [], []], 'a new session id: nothing read, opened, listed or stat\'ed');
  assert.deepEqual(u, coldRead(cwd, { provider: 'claude', sessionId: 's12' }));
  assert.equal(u.outputTokens, 112 + 34, 'its own file\'s first record plus the neighbour file\'s second');
});

test('SCALE-TRANSCRIPT-SCAN: a new transcript file re-lists once and keeps readdir order', async () => {
  const { cwd, dir } = yearDir(5);
  readAgentUsage(cwd, { provider: 'claude' });
  await changed(dir, '0025.jsonl', () => fs.writeFileSync(path.join(dir, '0025.jsonl'), rec(9, { model: 'claude-opus-4-8' }) + '\n'));
  const spy = spyFs();
  let u;
  try { u = readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
  assert.deepEqual(spy.seen.readdirSync, [dir], 'one listing');
  assert.deepEqual(spy.seen.statSync, [path.join(dir, '0025.jsonl')], 'only the new file is stat\'ed');
  assert.deepEqual(u, coldRead(cwd, { provider: 'claude' }), 'the summing order (and so the last model) is readdir\'s');
});

test('SCALE-TRANSCRIPT-SCAN: an overflow (an event with no name) or a watch error falls back to stat-all for one beat', () => {
  const { cwd, dir } = yearDir(6);
  readAgentUsage(cwd, { provider: 'claude' });
  const scans = T.transcriptWatchStats.fullScans;
  T.__transcriptWatcher(cwd).emit('change', 'change', null);   // what libuv reports when its buffer overflowed
  let spy = spyFs();
  try { readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
  assert.equal(spy.seen.statSync.length, 6, 'overflow: every file is stat\'ed');
  assert.equal(T.transcriptWatchStats.fullScans, scans + 1);
  spy = spyFs();
  try { readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
  assert.deepEqual(spy.seen.statSync, [], 'and the beat after is quiet again');
  const armed = T.transcriptWatchStats.watchers;
  T.__transcriptWatcher(cwd).emit('error', new Error('EPERM'));   // watchDirectorySafely closes on error
  assert.equal(T.__transcriptWatchOpen(cwd), false, 'an errored watch is closed');
  spy = spyFs();
  try { readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
  assert.equal(spy.seen.statSync.length, 6, 'error: the next beat stats every file');
  assert.equal(T.transcriptWatchStats.watchers, armed + 1, 'and re-arms one watch');
  assert.equal(T.__transcriptWatchOpen(cwd), true);
  assert.equal(path.dirname(spy.seen.statSync[0]), dir);
});

test('SCALE-TRANSCRIPT-SCAN N1: an append through a held-open handle (Windows fires no event) is caught by the 5-min full rescan', () => {
  let clock = 5_000_000;
  T.__setTranscriptWatchClock(() => clock);
  try {
    const { cwd, dir } = yearDir(3);
    readAgentUsage(cwd, { provider: 'claude' });
    const file = path.join(dir, '001.jsonl');
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, rec(500, { sessionId: 'held' }) + '\n');
      clock += 5 * 60_000 - 1;
      let spy = spyFs();
      try { readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
      // Inside the window only a file an event named may be stat'ed (none on Windows for a held-open write).
      assert.ok(spy.seen.statSync.every((f) => f === file), `inside the window no other file is stat'ed: ${spy.seen.statSync.length}`);
      assert.deepEqual(spy.seen.readdirSync, []);
      clock += 1;
      spy = spyFs();
      let u;
      try { u = readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
      assert.equal(spy.seen.statSync.length, 3, 'at 5 min every file is stat\'ed once');
      assert.deepEqual(u, coldRead(cwd, { provider: 'claude' }), 'and the held-open append is counted');
      assert.equal(readAgentUsage(cwd, { provider: 'claude', sessionId: 'held' }).outputTokens, 500);
      spy = spyFs();
      try { readAgentUsage(cwd, { provider: 'claude' }); } finally { spy.restore(); }
      assert.deepEqual(spy.seen.statSync, [], 'the beat after the rescan is quiet again');
    } finally { fs.closeSync(fd); }
  } finally { T.__setTranscriptWatchClock(null); }
});

test('SCALE-TRANSCRIPT-SCAN N2: a listing that throws while the dir exists keeps the pending change for the next beat', async () => {
  const { cwd, dir } = yearDir(3);
  readAgentUsage(cwd, { provider: 'claude' });
  // A changed old file (dirty) plus a new one (relist): losing the dirty set served the old file stale.
  await changed(dir, '000.jsonl', () => fs.appendFileSync(path.join(dir, '000.jsonl'), rec(900, { sessionId: 'n2old' }) + '\n'));
  await changed(dir, 'new.jsonl', () => fs.writeFileSync(path.join(dir, 'new.jsonl'), rec(77, { sessionId: 'n2' }) + '\n'));
  const orig = fs.readdirSync;
  fs.readdirSync = () => { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; };
  try { readAgentUsage(cwd, { provider: 'claude' }); } catch { /* the beat may surface it; the next one must recover */ }
  finally { fs.readdirSync = orig; }
  const u = readAgentUsage(cwd, { provider: 'claude' });
  assert.deepEqual(u, coldRead(cwd, { provider: 'claude' }), 'the next beat lists again and counts the new file');
  assert.equal(readAgentUsage(cwd, { provider: 'claude', sessionId: 'n2' }).outputTokens, 77);
  assert.equal(readAgentUsage(cwd, { provider: 'claude', sessionId: 'n2old' }).outputTokens, 900, 'the dirty old file was re-read');
});

test('SCALE-TRANSCRIPT-SCAN: deleting a watched dir leaves the CPU idle, closes the watch, and the dir reads as zeros', async () => {
  const { cwd, dir } = yearDir(4);
  const before = readAgentUsage(cwd, { provider: 'claude' });
  assert.ok(before.outputTokens > 0);
  assert.equal(T.__transcriptWatchOpen(cwd), true);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  const after = readAgentUsage(cwd, { provider: 'claude' });   // the beat's existsSync closes the watch
  assert.equal(after.outputTokens, 0);
  assert.equal(T.__transcriptWatchOpen(cwd), false, 'the watch on a deleted dir is closed');
  // The Node 22+ Windows spin pins a core at 100%; an idle process uses a few ms of CPU per second.
  const cpu = process.cpuUsage();
  const wall = process.hrtime.bigint();
  await new Promise((r) => setTimeout(r, 1000));
  const used = process.cpuUsage(cpu);
  const ms = (used.user + used.system) / 1000;
  const wallMs = Number(process.hrtime.bigint() - wall) / 1e6;
  assert.ok(ms < wallMs * 0.25, `CPU stayed idle after the delete: ${ms.toFixed(1)} ms CPU in ${wallMs.toFixed(0)} ms`);
  // The dir comes back (Claude starts a session there again): a full scan and a new watch.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.jsonl'), rec(42) + '\n');
  assert.equal(readAgentUsage(cwd, { provider: 'claude' }).outputTokens, 42);
  assert.equal(T.__transcriptWatchOpen(cwd), true);
});

// Not vacuous: an exit before every test has run is a failure (a lost event would otherwise
// end the process with rc 0).
let ran = 0;
process.on('exit', (code) => { if (code === 0 && ran !== tests.length) { console.error(`FAIL  only ${ran} of ${tests.length} tests ran`); process.exitCode = 1; } });
(async () => {
  for (const [name, fn] of tests) {
    ran += 1;
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  T.closeTranscriptWatches();
  process.exit(failures ? 1 : 0);
})();
