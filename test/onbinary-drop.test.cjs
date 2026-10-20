'use strict';

// ONBINARY-DROP: legacy X10 mouse reports use xterm.onBinary. This test pairs
// the rendered harness (terminal -> preload-shaped bridge) with the actual
// node-pty handoff (main -> native socket), and has explicit guards for the two
// regression mutants: drop the listener, or UTF-8 re-encode its high byte.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

test('ONBINARY-DROP: binary xterm input is wired to the shared forwarder (listener-drop mutant is red)', () => {
  const pool = readSource('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /term\.onData\(\(data\) => forwardTerminalInput\(data\)\);/);
  assert.match(pool, /term\.onBinary\(\(data\) => forwardTerminalInput\(data, true\)\);/,
    'removing the onBinary listener makes this mutant guard fail');
  assert.match(pool, /binary \? binaryStringToBytes\(data\) : data/,
    'the binary listener must send bytes, never its Unicode string');
});

test('ONBINARY-DROP: a high binary code unit reaches node-pty as one unchanged byte', () => {
  const { binaryStringToBytes, isPtyInput } = loadTs('src/shared/ptyInput.ts');
  const bytes = binaryStringToBytes('\x1b[M \x85!');
  assert.deepEqual([...bytes], [0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x21]);
  assert.equal(isPtyInput(bytes), true);

  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  let received;
  pm.sessions.set('mouse', {
    id: 'mouse', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true,
    humanInputGeneration: 0, proc: { write: (data) => { received = data; } }
  });
  assert.deepEqual(pm.write('mouse', Buffer.from(bytes), 'HUMAN'), { ok: true });
  assert.ok(Buffer.isBuffer(received), 'main gives node-pty a Buffer, not a UTF-8 string');
  assert.deepEqual([...received], [...bytes], '0x85 remains one octet at node-pty');

  const main = readSource('src/main/index.ts');
  const handler = main.slice(main.indexOf("ipcMain.handle('pty:write'"), main.indexOf("ipcMain.handle('pty:inputState'"));
  assert.match(handler, /isPtyInput\(data\)/, 'IPC admits the typed-array form from preload');
  assert.match(handler, /Buffer\.from\(data\)/, 'IPC converts that form to node-pty bytes, not UTF-8 text');
});
