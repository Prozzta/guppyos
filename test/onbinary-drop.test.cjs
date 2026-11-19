'use strict';
require('./tools/own-job.cjs');

// ONBINARY-DROP: legacy X10 uses xterm.onBinary.  The important boundary is
// node-pty's real child, not merely a mocked proc.write: ConPTY consumes ESC[M
// and interprets input as UTF-8, while POSIX PTYs preserve the raw bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { childBytes, electronExe } = require('./tools/pty-child.cjs');
const { consoleNode, peSubsystem, KEY } = require('./tools/console-node.cjs');

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

// The child must be ON the pseudoconsole: a console-subsystem Node, never electron.exe (see console-node.cjs).
test('ONBINARY-DROP: win32 ConPTY preserves the high coordinate only via string (Buffer mutant is red)', { skip: process.platform !== 'win32' }, async (t) => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  assert.deepEqual(await childBytes(ptyBinaryInput(X10_HIGH_COLUMN, 'win32'), { file: node.file }), [0x20, 0xc2, 0x85, 0x21]);
  assert.deepEqual(await childBytes(Buffer.from(X10_HIGH_COLUMN, 'latin1'), { file: node.file }), [0x20, 0x21],
    'the Buffer mutant loses 0x85 at ConPTY UTF-8 decoding');
});

test('ONBINARY-DROP: POSIX real PTY receives the raw X10 bytes', { skip: process.platform === 'win32' }, async (t) => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  assert.deepEqual(await childBytes(ptyBinaryInput(X10_HIGH_COLUMN, process.platform), { file: node.file }),
    [0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x21]);
});

test('ONBINARY-DROP: consoleNode() rejects electron.exe and any GUI-subsystem exe by name, and never falls back', (t) => {
  const electron = electronExe();
  const asElectron = { versions: { ...process.versions, electron: '0.0.0' }, execPath: electron };
  // The env key is used first, and a bad one is a named failure (not passed over for PATH).
  assert.throws(() => consoleNode({ ...asElectron, env: { [KEY]: electron, PATH: process.env.PATH } }),
    (e) => e.message.startsWith(`no console node.exe: ${KEY} is electron.exe (${electron})`));
  // None found under Electron: fail by name; process.execPath is not a fallback.
  assert.throws(() => consoleNode({ ...asElectron, env: { PATH: '' } }),
    { message: `no console node.exe: set ${KEY} or put node on PATH` });
  if (process.platform !== 'win32') return;
  assert.equal(peSubsystem(electron), 2, 'electron.exe is a GUI-subsystem program');
  // The subsystem is read from the file: a GUI exe is refused under any name, before it is run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-console-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'node.exe');
  const head = Buffer.alloc(0x40 + 24 + 70);
  head.write('MZ', 0, 'latin1'); head.writeUInt32LE(0x40, 0x3c);
  head.write('PE\0\0', 0x40, 'latin1'); head.writeUInt16LE(2, 0x40 + 24 + 68);
  fs.writeFileSync(fake, head);
  const ran = [];
  assert.throws(() => consoleNode({ ...asElectron, env: { [KEY]: fake }, run: (...a) => { ran.push(a); return 'v1.2.3'; } }),
    (e) => e.message.startsWith(`no console node.exe: ${KEY} (${fake}) has PE subsystem 2 (GUI), not 3 (console)`));
  assert.deepEqual(ran, [], 'a refused exe is never started');
  // What it does accept on this machine is a console exe that answers --version.
  const real = consoleNode();
  assert.equal(peSubsystem(real.file), 3);
  assert.match(real.version, /^v\d+\.\d+\.\d+/);
  assert.doesNotMatch(path.basename(real.file), /^electron/i);
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
    // Two names for the one failure, whichever clock is first: the child's own 3 s timer (counted from
    // its start, which is slow on a loaded machine) or the helper's 5 s wait for an answer.
    await assert.rejects(run, { message: /^PTY child (exited 2: $|did not answer$)/ }, 'no READY reached the PTY');
    let t;
    await Promise.race([exited, new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error('the conout worker of the terminal never exited: the kill did not run (node-pty waits for a first data chunk, and this child sends none)')), 8000);
    })]).finally(() => clearTimeout(t));
  } finally {
    await worker.terminate();   // a red run must still let this file end
  }
});

// The child reports isTTY itself and the helper asserts it. A console node on the PTY always says true,
// so this child is made to say false: it answers with its bytes, and the helper must still refuse it by
// name (Jim 393e0b MUST 1: without this case nothing reached that assertion).
test('ONBINARY-DROP: a child that answers but says its stdout is no TTY is refused by name, and leaves no conout worker', { skip: process.platform !== 'win32' }, async (t) => {
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  let worker;
  let exited;
  const run = childBytes(ptyBinaryInput(X10_HIGH_COLUMN, 'win32'), {
    file: node.file,
    prelude: "Object.defineProperty(process.stdout, 'isTTY', { value: false });",
    onSpawn: (proc) => { worker = proc._agent._conoutSocketWorker._worker; exited = new Promise((res) => worker.once('exit', res)); }
  });
  try {
    await assert.rejects(run, { message: /^PTY child is not on the console \(its stdout\/stdin isTTY is not true\): [\s\S]*READY:false[\s\S]*BYTES:/ });
    let timer;
    await Promise.race([exited, new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('the conout worker of the refused terminal never exited')), 8000);
    })]).finally(() => clearTimeout(timer));
  } finally {
    await worker.terminate();
  }
});
