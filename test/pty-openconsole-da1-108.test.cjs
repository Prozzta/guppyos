'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-CONHOST-ORPHAN-OWNER-DEATH (option A), second pin. Every PTY runs on node-pty's bundled
 * OpenConsole. At start-up OpenConsole sends a DA1 query (ESC[c) and holds ALL of the child's output
 * until it is answered or 3 s pass (measured 2026-11-20: 3.03 s unanswered, 32 ms answered). Main
 * answers it for every PTY (src/main/openConsoleHandshake.ts) and takes it out of the stream, so:
 *   - a PTY with no renderer attached starts without the 3 s wait;
 *   - the renderer never sees the query, so it cannot answer a second time (a second answer reaches
 *     the child as typed input: measured, ESC[?62;4;22c arrived on its stdin).
 * And the install stages the pair (tools/stage-node-pty-openconsole.cjs) and checks it last.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir, removeDir } = require('./tools/test-temp.cjs');
// The PTY child must be ON the pseudoconsole: a console-subsystem node.exe, never electron.exe (a GUI-subsystem
// program that ConPTY does not attach, so it neither prints to nor reads from the console).
const { consoleNode } = require('./tools/console-node.cjs');

const ROOT = path.resolve(__dirname, '..');
const loadTs = require('./load-ts.cjs');
const { startupHandshake, DA1_ANSWER } = loadTs('src/main/openConsoleHandshake.ts');

test('handshake: the start-up query is answered and taken out; the child\'s own output and queries pass', () => {
  // The chunks as OpenConsole 1.23.251008001 sent them (measured).
  assert.deepEqual(startupHandshake('\x1b[1t'), { data: '\x1b[1t', answer: false, pending: true });
  assert.deepEqual(startupHandshake('\x1b[c\x1b[?1004h\x1b[?9001h'), { data: '\x1b[?1004h\x1b[?9001h', answer: true, pending: false });
  assert.deepEqual(startupHandshake('\x1b[0c'), { data: '', answer: true, pending: false });
  // the child printed first: its bytes, and a query after them, are the child's and pass untouched
  assert.deepEqual(startupHandshake('CHILD-UP\r\n'), { data: 'CHILD-UP\r\n', answer: false, pending: false });
  assert.deepEqual(startupHandshake('hi\x1b[c'), { data: 'hi\x1b[c', answer: false, pending: false });
  // a title (OSC) before the query is not child output
  assert.deepEqual(startupHandshake('\x1b]0;t\x07\x1b[c'), { data: '\x1b]0;t\x07', answer: true, pending: false });
  assert.equal(DA1_ANSWER, '\x1b[?1;2c', 'the answer xterm.js itself gives');
});

test('install: the OpenConsole pair is staged after the rebuild and checked at the end, and this tree has it', () => {
  const steps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.postinstall.split(' && ');
  const stage = steps.indexOf('node tools/stage-node-pty-openconsole.cjs');
  const check = steps.indexOf('node tools/stage-node-pty-openconsole.cjs --check');
  assert.ok(stage > steps.indexOf('electron-rebuild -f -o node-pty'), 'staged after electron-rebuild (which does not run node-pty\'s own post-install)');
  assert.ok(check > stage && check > steps.indexOf('node tools/record-node-pty-race-fix.cjs'), 'and checked among the closing checks');
  if (process.platform !== 'win32') return;
  const { checkStaged, stagedDir, targetArch } = require('../tools/stage-node-pty-openconsole.cjs');
  const np = path.join(ROOT, 'node_modules', 'node-pty');
  assert.deepEqual(checkStaged(np, targetArch()), [], 'Run `npm run postinstall` in this tree: it stages OpenConsole');
  const pins = require('../tools/node-pty-race-fix-pins.cjs');
  for (const [name, want] of Object.entries(pins.OPENCONSOLE_SHA256[targetArch()])) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(stagedDir(np), name))).digest('hex'), want, name);
  }
});

test('install check: --check fails on a missing or changed binary', { skip: process.platform !== 'win32' }, () => {
  const { checkStaged, stage, targetArch } = require('../tools/stage-node-pty-openconsole.cjs');
  const pins = require('../tools/node-pty-race-fix-pins.cjs');
  const arch = targetArch();
  const jail = tempDir('ocstage-');
  try {
    const src = path.join(ROOT, 'node_modules', 'node-pty', 'third_party', 'conpty', pins.CONPTY_THIRD_PARTY_VERSION, `win10-${arch}`);
    const tp = path.join(jail, 'third_party', 'conpty', pins.CONPTY_THIRD_PARTY_VERSION, `win10-${arch}`);
    fs.mkdirSync(tp, { recursive: true });
    for (const n of ['conpty.dll', 'OpenConsole.exe']) fs.copyFileSync(path.join(src, n), path.join(tp, n));
    assert.equal(checkStaged(jail, arch).length, 2, 'nothing staged: both missing');
    stage(jail, arch);
    assert.deepEqual(checkStaged(jail, arch), []);
    fs.appendFileSync(path.join(jail, 'build', 'Release', 'conpty', 'OpenConsole.exe'), 'x');
    assert.match(checkStaged(jail, arch).join(), /OpenConsole\.exe is [0-9a-f]{12}, not the pinned/);
    fs.appendFileSync(path.join(tp, 'conpty.dll'), 'x');
    assert.throws(() => stage(jail, arch), /conpty\.dll is [0-9a-f]{12}, not the pinned/, 'a changed source is never staged');
  } finally { fs.rmSync(jail, { recursive: true, force: true }); }
});

/** An unanswered DA1 holds the child's LAUNCH: OpenConsole starts the child only after the answer or
 *  its 3 s timeout (measured: spawn -> the child's process start 3060 ms unanswered, 59 ms answered).
 *  The bar is spawn -> performance.timeOrigin (the child's process creation), so node's own runtime
 *  start-up under load does not count against it, and the unanswered case can never pass. */
const NO_WAIT_MS = 2_000;

test('an unattached PTY starts with no DA1 wait, the query never reaches the sink, and the child types nothing', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir('ocda1-');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const m = new PtyManager();
  const stdinLog = path.join(dir, 'stdin.log');
  fs.writeFileSync(path.join(dir, 'child.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    'process.stdin.setRawMode(true); process.stdin.resume();',
    `process.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(stdinLog)}, b.toString('hex') + '\\n'));`,
    "process.stdout.write('CHILD-UP ' + Math.round(performance.timeOrigin) + ' ' + Date.now() + '\\r\\n');",
    'setTimeout(() => process.exit(0), 1500);'
  ].join('\n'));
  let stream = '';
  let upAt = 0; let stamp = 0; let startedAt = 0; let spawnAt = 0;
  // A sink that never answers anything: no renderer is attached to this terminal.
  const sink = { isDestroyed: () => false, send: (ch, d) => {
    if (typeof d !== 'string') return;
    stream += d;
    const mm = /CHILD-UP (\d+) (\d+)/.exec(stream);
    if (mm && !upAt) { upAt = Date.now(); startedAt = Number(mm[1]); stamp = Number(mm[2]); }
  } };
  const exited = new Promise((r) => { const orig = sink.send; sink.send = (ch, d) => { orig(ch, d); if (ch === 'pty:exit:da1') r(); }; });
  try {
    spawnAt = Date.now();
    const r = await m.spawn({ id: 'da1', cwd: dir, command: consoleNode().file, args: [path.join(dir, 'child.cjs')], cols: 80, rows: 24, env: {} }, sink);
    assert.ok(r.ok, `spawn: ${r.error}`);
    await Promise.race([exited, new Promise((r2) => setTimeout(r2, 15_000))]);
    assert.ok(upAt, `the child's output arrived: ${JSON.stringify(stream.slice(0, 200))}`);
    const waited = startedAt - spawnAt;
    assert.ok(waited < NO_WAIT_MS, `DA1 WAIT: the child process started ${waited} ms after spawn (OpenConsole holds the launch 3 s for an unanswered DA1); it wrote ${stamp - startedAt} ms later, main got it ${upAt - stamp} ms after that`);
    assert.doesNotMatch(stream, /\x1b\[0?c/, 'the start-up query never reaches the renderer, so it is never answered twice');
    assert.equal(fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8') : '', '', 'nothing reached the child as typed input');
  } finally {
    await m.killAllAsync(5_000);
    await removeDir(dir);
  }
});

/** OpenConsole holds an unanswered DA1 for 3 s; a main thread busy longer than that, with a root
 *  that exits at once, writes the answer while the console is going away (measured: EAGAIN 5 of 5;
 *  busy 1 s: 0 of 3, the launch was still held). */
const BUSY_PAST_DA1_MS = 4_500;

test('a write the console can no longer take is said, not thrown outside any caller (EAGAIN)', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir('ocin-');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const m = new PtyManager();
  fs.writeFileSync(path.join(dir, 'gone.cjs'), '');
  const thrown = [];
  const onUncaught = (e) => thrown.push(`${e && e.code} ${e && e.message}`);
  process.on('uncaughtException', onUncaught);
  const warn = console.warn; const said = [];
  console.warn = (...a) => { said.push(a.join(' ')); };
  let exited = false;
  const sink = { isDestroyed: () => false, send: (ch) => { if (ch === 'pty:exit:ocin') exited = true; } };
  try {
    const r = await m.spawn({ id: 'ocin', cwd: dir, command: consoleNode().file, args: [path.join(dir, 'gone.cjs')], cols: 80, rows: 24, env: {} }, sink);
    assert.ok(r.ok, `spawn: ${r.error}`);
    // The answer goes out from the output handler, in the first turn after this block.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUSY_PAST_DA1_MS);
    const t0 = Date.now();
    while (!exited && Date.now() - t0 < 10_000) await new Promise((r2) => setTimeout(r2, 50));
    await new Promise((r2) => setImmediate(r2));
    assert.ok(exited, 'the terminal reported its exit');
    assert.deepEqual(thrown, [], 'NOTHING IS THROWN OUTSIDE A CALLER: the failed write meets the input pipe\'s error listener');
    assert.ok(said.some((l) => /a write to terminal \d+ failed \(EAGAIN\)/.test(l)), `the failed write is said: ${JSON.stringify(said)}`);
  } finally {
    process.off('uncaughtException', onUncaught);
    console.warn = warn;
    await m.killAllAsync(5_000);
    await removeDir(dir);
  }
});

test('the input-pipe guard: one listener per terminal, said once; a node-pty without the socket is left alone', () => {
  const { guardInputErrors } = loadTs('src/main/pty.ts');
  const { EventEmitter } = require('node:events');
  const sock = new EventEmitter();
  const proc = { pid: 7, _agent: { _inSocket: sock } };
  const warn = console.warn; const said = [];
  console.warn = (...a) => { said.push(a.join(' ')); };
  try {
    assert.equal(guardInputErrors(proc, 'linux'), false, 'unix: nothing to guard');
    assert.equal(sock.listenerCount('error'), 0);
    assert.equal(guardInputErrors(proc, 'win32'), true);
    assert.equal(sock.listenerCount('error'), 1);
    sock.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }));
    sock.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.deepEqual(said, ['[pty] a write to terminal 7 failed (EAGAIN): its console is gone or going; the input is dropped']);
    assert.equal(guardInputErrors({ pid: 8, _agent: {} }, 'win32'), false, 'no input socket: left as it was');
    assert.match(said[1], /input-pipe error guard not installed/);
  } finally { console.warn = warn; }
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'pty.ts'), 'utf8'), /rootHandoff\(proc\)\);\r?\n(?: *\/\/[^\n]*\n)* *guardInputErrors\(proc\);/, 'every spawn installs it, in the spawn\'s own turn');
});
