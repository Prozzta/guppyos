'use strict';
require('./tools/own-job.cjs');

// ONBINARY-DROP: legacy X10 uses xterm.onBinary.  The important boundary is
// node-pty's real child, not merely a mocked proc.write: ConPTY consumes ESC[M
// and interprets input as UTF-8, while POSIX PTYs preserve the raw bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { childBytes, electronExe } = require('./tools/pty-child.cjs');

const X10_HIGH_COLUMN = '\x1b[M \x85!';

test('ONBINARY-DROP: binary xterm input is wired to the platform handoff', () => {
  const pool = readSource('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /term\.onData\(\(data\) => forwardTerminalInput\(data\)\);/);
  assert.match(pool, /term\.onBinary\(\(data\) => forwardTerminalInput\(data, true\)\);/,
    'removing the onBinary listener makes this mutant guard fail');
  assert.match(pool, /writePtyBinary\(ptyId, data, classifyOutbound\(ptyId, data\)\)/,
    'the binary marker must reach main rather than be silently dropped');
  const preload = readSource('src/preload/index.ts');
  assert.match(preload, /writePtyBinary:[\s\S]*?sendPtyWrite\(id, data, origin, true\)/,
    'the binary bridge must retain its true transport flag through preload');
});

test('ONBINARY-DROP: helper keeps a JS string for ConPTY and raw latin-1 bytes for POSIX', () => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  assert.equal(ptyBinaryInput(X10_HIGH_COLUMN, 'win32'), X10_HIGH_COLUMN);
  const posix = ptyBinaryInput(X10_HIGH_COLUMN, 'linux');
  assert.ok(Buffer.isBuffer(posix));
  assert.deepEqual([...posix], [0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x21]);
});

test('ONBINARY-DROP: win32 ConPTY preserves the high coordinate only via string (Buffer mutant is red)', { skip: process.platform !== 'win32' }, async () => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  assert.deepEqual(await childBytes(ptyBinaryInput(X10_HIGH_COLUMN, 'win32')), [0x20, 0xc2, 0x85, 0x21]);
  assert.deepEqual(await childBytes(Buffer.from(X10_HIGH_COLUMN, 'latin1')), [0x20, 0x21],
    'the Buffer mutant loses 0x85 at ConPTY UTF-8 decoding');
});

test('ONBINARY-DROP: POSIX real PTY receives the raw X10 bytes', { skip: process.platform === 'win32' }, async () => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  assert.deepEqual(await childBytes(ptyBinaryInput(X10_HIGH_COLUMN, process.platform)),
    [0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x21]);
});

// ONBINARY-DROP-ELECTRON-FILE-NEVER-EXITS-108. electron.exe is a GUI-subsystem program: Windows does not
// attach it to the pseudoconsole, so (also as Node) it prints nothing to the PTY and reads nothing from it.
// node-pty holds kill() back until a terminal's first data chunk, and its exit path frees only the output
// socket: after such a child the conout worker thread stayed for good and the test file never ended (every
// Electron leg waited out the 30 min file limit). The same child, on both runtimes: the helper must name
// the failure AND leave no worker behind.
test('ONBINARY-DROP: a PTY child that is not on the console fails by name and leaves no conout worker', { skip: process.platform !== 'win32' }, async () => {
  let worker;
  let exited;
  const run = childBytes(X10_HIGH_COLUMN, {
    file: electronExe(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    onSpawn: (proc) => { worker = proc._agent._conoutSocketWorker._worker; exited = new Promise((res) => worker.once('exit', res)); }
  });
  try {
    await assert.rejects(run, { message: 'PTY child exited 2: ' }, 'no READY reached the PTY: the child ran its 3 s timer out');
    let t;
    await Promise.race([exited, new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error('the conout worker of the terminal never exited: the kill did not run (node-pty waits for a first data chunk, and this child sends none)')), 8000);
    })]).finally(() => clearTimeout(t));
  } finally {
    await worker.terminate();   // a red run must still let this file end
  }
});
