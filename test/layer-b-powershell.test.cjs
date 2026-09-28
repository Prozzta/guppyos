'use strict';
/**
 * ZT-I1-MAIL layer (b): the runner's PowerShell scripts REALLY RUN (the 62daa6ba dry run aborted at
 * 0 s because a multi-line script fed to `powershell -Command -` over stdin is silently not executed).
 * This starts the real window watcher (PS_WATCH) on THIS test process for about 5 s and the real
 * process scan (PS_SCAN) once, both as hidden PowerShell via -EncodedCommand, and asserts parseable
 * ok results. No app, no Electron, no CLI; nothing is ever shown; every process is killed after.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const lb = require('./tools/layer-b-run.cjs');

const T = { timeout: 120_000, skip: process.platform !== 'win32' ? 'Windows only' : false };

test('psArgs: -EncodedCommand (UTF-16LE base64) that decodes back to the script, never -Command -, bounded length', () => {
  const script = lb.PS_WATCH(1234);
  const args = lb.psArgs(script);
  assert.equal(args[args.length - 2], '-EncodedCommand');
  assert.equal(Buffer.from(args[args.length - 1], 'base64').toString('utf16le'), script);
  assert.ok(!args.includes('-Command') && !args.includes('-'));
  assert.ok(args.join(' ').length < lb.PS_MAX_CMDLINE);
  assert.ok(lb.psArgs(lb.PS_SCAN(Array.from({ length: 200 }, (_, i) => 10000 + i))).join(' ').length < lb.PS_MAX_CMDLINE, 'a scan over 200 pids still fits');
  assert.throws(() => lb.psArgs('x'.repeat(20_000)), /command line too long/);
});

test('REAL: the window watcher runs for ~5 s on this process and reports ok:true lines with a tree of at least 1', T, async (t) => {
  const blind = [];
  const hits = [];
  const w = new lb.WindowWatch(process.pid, { onHit: (x) => hits.push(x), onBlind: (x) => blind.push(x) }).start();
  t.after(() => w.stop());
  const until = Date.now() + 60_000;
  while (w.lines < 2 && Date.now() < until && !blind.length) await new Promise((r) => setTimeout(r, 250));   // Add-Type compiles first
  const firstAt = Date.now();
  while (Date.now() - firstAt < 5_000 && !blind.length) await new Promise((r) => setTimeout(r, 250));
  w.stop();
  assert.deepEqual(blind, [], `the watcher went blind: ${blind.join('; ')}`);
  assert.ok(w.lines >= 3, `ok lines arrived (${w.lines})`);
  assert.equal(w.errors, 0);
  assert.ok(w.last && w.last.ok === true, `last line ok: ${JSON.stringify(w.last)}`);
  assert.ok(w.last.tree >= 1, `tree count ${w.last.tree}`);
  assert.ok(Array.isArray(w.last.visible) && Array.isArray(w.last.browsers) && Array.isArray(w.last.alerts));
  assert.deepEqual(hits, [], 'this headless test process tree shows no window');
  assert.equal(w.healthy(), true);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(w.child.exitCode !== null || w.child.signalCode !== null, 'the watcher process was killed');
});

test('REAL: the process scan runs once (async and sync) and returns a parseable result that includes this process', T, async () => {
  const tr = new lb.ProcTracker();
  tr.addRoot(process.pid);
  const r = await tr.scan();
  assert.ok(Array.isArray(r.procs) && r.procs.length > 10, `processes listed: ${r.procs.length}`);
  assert.ok(r.procs.some((p) => p.pid === process.pid), 'this process is in the scan');
  assert.ok(Array.isArray(r.visible));
  assert.notEqual(tr.known.get(process.pid).created, null, 'the root got its creation time (identity for the kill)');
  const s = tr.scanSync();
  assert.ok(s.procs.length > 10 && s.procs.some((p) => p.pid === process.pid));
});
