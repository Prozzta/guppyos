'use strict';
/**
 * PTY-EARLY-KILL-LEAK (1.1.77). node-pty 1.1.0's WindowsTerminal defers kill() until the
 * terminal's FIRST OUTPUT (`_deferNoArgs`, run on the first 'data' event). A child killed before it
 * printed anything never produces one, so ClosePseudoConsole never ran: conhost and the input pipe
 * leaked (Creed, rc/1.1.76 gate, inspector on the hung process). PtyManager.spawn now arms every
 * terminal (pty.ts armEarlyKill): a kill before ready runs the deferred body at once.
 *
 * The real node-pty WindowsTerminal.prototype drives these tests (no native spawn: the instance is
 * built from the prototype with a recording agent), so a node-pty upgrade that changes the
 * internals fails the pins below instead of silently disabling the fix.
 *
 * Named mutants, each must fail this file:
 *   P1 PtyManager.spawn does not arm the terminal
 *   P2 an early kill is deferred like node-pty's (no bypass)
 *   P3 the queued deferreds survive the early kill
 *   P4 a second kill closes the pseudoconsole again
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { armEarlyKill } = loadTs('src/main/pty.ts');
const NODE_PTY = path.dirname(require.resolve('node-pty/package.json'));
const { WindowsTerminal } = require(path.join(NODE_PTY, 'lib', 'windowsTerminal.js'));

/** A WindowsTerminal built from the REAL prototype, with the agent and socket recorded. */
function terminal({ ready = false } = {}) {
  const calls = [];
  const t = Object.create(WindowsTerminal.prototype);
  t._isReady = ready;
  t._deferreds = [];
  t._socket = { readable: true };
  t._agent = { kill: () => calls.push('agent.kill') };
  const realClose = t._close;
  t._close = function () { calls.push('close'); return realClose.call(this); };
  return { t, calls };
}

test('the defect, pinned on the installed node-pty: a kill before the first output is only QUEUED', () => {
  const { t, calls } = terminal();
  t.kill();
  assert.deepEqual(calls, [], 'node-pty 1.1.0 runs nothing: ClosePseudoConsole would wait for output that never comes');
  assert.equal(t._deferreds.length, 1);
  // What would run it: the first data event (simulated by running the queue as node-pty does).
  t._deferreds.forEach((fn) => fn.run());
  assert.deepEqual(calls, ['close', 'agent.kill'], 'the deferred body is _close() then _agent.kill()');
});

test('armed: a kill BEFORE the first output closes the pseudoconsole at once, exactly as the deferred body', () => {
  const { t, calls } = terminal();
  t._deferreds.push({ run: () => calls.push('queued write ran') });
  assert.equal(armEarlyKill(t, 'win32'), true);
  t.kill();
  assert.deepEqual(calls, ['close', 'agent.kill']);
  assert.equal(t._isReady, true, 'a later first-data event finds nothing to run');
  assert.deepEqual(t._deferreds, [], 'queued writes/resizes for the dead terminal are dropped');
  assert.equal(t._writable, false, 'node-pty\'s own _close ran (writes are now no-ops)');
});

test('armed: a second kill does nothing (the pseudoconsole is never closed twice)', () => {
  const { t, calls } = terminal();
  armEarlyKill(t, 'win32');
  t.kill();
  t.kill();
  assert.deepEqual(calls, ['close', 'agent.kill']);
});

test('armed: once READY, kill is node-pty\'s own, unchanged (immediate)', () => {
  const { t, calls } = terminal({ ready: true });
  armEarlyKill(t, 'win32');
  t.kill();
  assert.deepEqual(calls, ['close', 'agent.kill']);
  assert.throws(() => { const r = terminal({ ready: true }); armEarlyKill(r.t, 'win32'); r.t.kill('SIGTERM'); }, /Signals not supported on windows/, 'a signal keeps node-pty\'s behaviour');
});

test('only Windows terminals with the expected internals are armed', () => {
  assert.equal(armEarlyKill(terminal().t, 'linux'), false);
  assert.equal(armEarlyKill({ kill() {}, pid: 1 }, 'win32'), false, 'a UnixTerminal / another node-pty shape is left alone');
  const noAgent = terminal().t; delete noAgent._agent;
  assert.equal(armEarlyKill(noAgent, 'win32'), false);
});

test('pins: node-pty is 1.1.0 and its WindowsTerminal still defers kill until ready (else revisit armEarlyKill)', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(NODE_PTY, 'package.json'), 'utf8')).version, '1.1.0');
  const src = fs.readFileSync(path.join(NODE_PTY, 'lib', 'windowsTerminal.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /WindowsTerminal\.prototype\.kill = function \(signal\) \{\n\s+var _this = this;\n\s+this\._deferNoArgs\(function \(\) \{/);
  assert.match(src, /_this\._close\(\);\n\s+_this\._agent\.kill\(\);/);
  assert.match(src, /if \(this\._isReady\) \{/);
});

test('wiring: PtyManager.spawn arms every terminal right after pty.spawn; the kill sites are unchanged', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pty.ts'), 'utf8').replace(/\r\n/g, '\n');
  const at = src.indexOf('const proc = pty.spawn(file, spawnArgs, {');
  assert.ok(at > 0);
  const after = src.slice(at, at + 1200);
  assert.match(after, /\}\);\n\s+\/\/ PTY-EARLY-KILL-LEAK[^\n]*\n\s+armEarlyKill\(proc\);/);
  assert.equal([...src.matchAll(/s\.proc\.kill\(\)/g)].length, 4, 'every kill path (kill, killByOwner, killAllAsync x2) reaches the armed kill');
});
