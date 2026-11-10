'use strict';
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const I = loadTs('src/main/win32Input.ts');
const root = path.join(__dirname, '..');

class FakeChild extends EventEmitter {
  constructor() { super(); this.stdout = new PassThrough(); this.writes = []; this.killed = false; this.stdin = new Writable({ write: (chunk, _, done) => { this.writes.push(JSON.parse(String(chunk))); done(); } }); }
  kill() { this.killed = true; this.emit('exit'); return true; }
  reply(row) { this.stdout.write(JSON.stringify(row) + '\n'); }
}

test('Win32InputHelper sends JSON, separates unsolicited hook events, restarts, and kills', async () => {
  const children = [];
  const helper = new I.Win32InputHelper(() => 'C:/input/guppy-input.exe', () => { const c = new FakeChild(); children.push(c); return c; });
  const seen = []; helper.onEvent((ev) => seen.push(ev));
  const pending = helper.startHook();
  assert.deepEqual(children[0].writes[0], { op: 'hook', chord: 'Ctrl+Alt+Space' });
  children[0].reply({ ev: 'down' }); children[0].reply({ ok: true, op: 'hook' });
  assert.deepEqual(await pending, { ok: true, op: 'hook' }); assert.deepEqual(seen, ['down']);
  children[0].emit('exit');
  const typing = helper.type('hello FEAT-X');
  assert.equal(children.length, 2, 'the next request starts a replacement helper');
  assert.deepEqual(children[1].writes[0], { op: 'type', text: 'hello FEAT-X' });
  children[1].reply({ ok: true, fallback: false });
  assert.deepEqual(await typing, { ok: true, fallback: false });
  helper.kill(); assert.equal(children[1].killed, true);
});

test('Win32InputHelper kills an overdue child so a late reply cannot desynchronise the next request', async () => {
  const children = [];
  const helper = new I.Win32InputHelper(() => 'C:/input/guppy-input.exe', () => { const c = new FakeChild(); children.push(c); return c; }, 5);
  assert.equal(await helper.request({ op: 'ping' }), null);
  assert.equal(children[0].killed, true, 'timeout terminates the old protocol stream');
  const next = helper.request({ op: 'ping' });
  children[0].reply({ ok: true, op: 'stale' });
  children[1].reply({ ok: true, op: 'ping' });
  assert.deepEqual(await next, { ok: true, op: 'ping' });
  helper.kill();
});

test('input helper path selects packaged and development resource locations', () => {
  assert.equal(I.inputHelperPath('C:/app', 'C:/resources', false), path.join('C:/app', 'resources', 'input', 'bin', 'guppy-input.exe'));
  assert.equal(I.inputHelperPath('C:/app', 'C:/resources', true), path.join('C:/resources', 'input', 'guppy-input.exe'));
});

test('build wiring ships only the generated input helper', () => {
  const pkg = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const yml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
  assert.match(pkg, /node tools\/build-input-helper\.cjs/);
  assert.match(yml, /from: resources\/input\/bin\s+to: input\s+filter:\s+- guppy-input\.exe/s);
  assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^resources\/input\/bin\/$/m);
});

test('built helper accepts safe UTF-8 echo and hook transition self-test without desktop input', { skip: process.platform !== 'win32' ? 'Windows only' : false, timeout: 15_000 }, async () => {
  const build = spawnSync(process.execPath, ['tools/build-input-helper.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
  const exe = path.join(root, 'resources', 'input', 'bin', 'guppy-input.exe'); assert.equal(fs.existsSync(exe), true);
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
    let buffered = ''; const rows = []; child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { buffered += d; let i; while ((i = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, i).trim(); buffered = buffered.slice(i + 1); if (line) rows.push(JSON.parse(line)); } });
    const wait = (n) => new Promise((resolve, reject) => { const until = Date.now() + 4000; const tick = () => rows.length >= n ? resolve(rows[n - 1]) : Date.now() > until ? reject(new Error('helper response timed out')) : setTimeout(tick, 10); tick(); });
    child.stdin.write('{"op":"ping"}\n'); assert.deepEqual(await wait(1), { ok: true, op: 'ping' });
    child.stdin.write(JSON.stringify({ op: 'echo', text: 'café 日本 😀' }) + '\n'); assert.deepEqual(await wait(2), { ok: true, op: 'echo', text: 'café 日本 😀' });
    child.stdin.write('{"op":"selftest"}\n'); assert.deepEqual(await wait(3), { ev: 'down' }); assert.deepEqual(await wait(4), { ev: 'up' }); assert.deepEqual(await wait(5), { ok: true, op: 'selftest' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.write('{"op":"quit"}\n'); assert.deepEqual(await wait(6), { ok: true, op: 'quit' });
    await exited;
  } finally { if (!child.killed) child.kill(); }
});
