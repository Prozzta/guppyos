'use strict';
require('./tools/own-job.cjs');

// ONBINARY-DROP: legacy X10 uses xterm.onBinary.  The important boundary is
// node-pty's real child, not merely a mocked proc.write: ConPTY consumes ESC[M
// and interprets input as UTF-8, while POSIX PTYs preserve the raw bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const pty = require('node-pty');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const X10_HIGH_COLUMN = '\x1b[M \x85!';
const child = [
  "process.stdin.setRawMode?.(true); process.stdin.resume();",
  "process.stdout.write('READY\\n');",
  "process.stdin.once('data', (data) => { process.stdout.write('BYTES:' + JSON.stringify([...data]) + '\\n'); process.exit(0); });",
  "setTimeout(() => { process.stdout.write('TIMEOUT\\n'); process.exit(2); }, 3000);"
].join(' ');

function childBytes(input) {
  return new Promise((resolve, reject) => {
    const proc = pty.spawn(process.execPath, ['-e', child], {
      name: 'xterm-256color', cols: 120, rows: 24, cwd: process.cwd(), env: process.env
    });
    let output = '';
    let ended = false;
    let wrote = false;
    const timer = setTimeout(() => finish(new Error('PTY child did not answer')), 5000);
    function finish(error, value) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* child already exited */ }
      error ? reject(error) : resolve(value);
    }
    proc.onData((data) => {
      output += data;
      const hit = /BYTES:(\[[^\n]*\])/.exec(output);
      if (hit) finish(null, JSON.parse(hit[1]));
      if (output.includes('TIMEOUT')) finish(new Error('PTY child timed out'));
      if (!wrote && output.includes('READY')) { wrote = true; proc.write(input); }
    });
    proc.onExit(({ exitCode }) => {
      if (!/BYTES:/.test(output)) finish(new Error(`PTY child exited ${exitCode}: ${output}`));
    });
  });
}

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
