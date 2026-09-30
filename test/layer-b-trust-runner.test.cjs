'use strict';

/**
 * Runner side of TRUST-SEED-175:
 *  - Jim C1: trust enables <cwd>/.codex/config.toml, so no jail agent cwd may hold one before a
 *    launch (refuse);
 *  - god (Dwight's trust-quit trace): every write INTO a pty is captured in main, and the evidence
 *    (pty-input.json) holds classes only: named control bytes and short redacted text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lb = require('./tools/layer-b-run.cjs');
const src = fs.readFileSync(path.join(__dirname, 'tools', 'layer-b-run.cjs'), 'utf8').replace(/\r\n/g, '\n');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-trustrun-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

test('C1: an agent cwd holding .codex/config.toml is named; clean cwds (and a .codex without config.toml) pass', () => {
  const a = fs.mkdtempSync(path.join(JAIL, 'a-'));
  const b = fs.mkdtempSync(path.join(JAIL, 'b-'));
  fs.mkdirSync(path.join(b, '.codex'));
  assert.deepEqual(lb.jailProjectConfigProblems([a, b]), []);
  fs.writeFileSync(path.join(b, '.codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\n');
  assert.match(lb.jailProjectConfigProblems([a, b]).join(' '), /\.codex[\\/]config\.toml exists: trust would enable it/);
  assert.match(lb.jailProjectConfigProblems([a], { existsSync: () => { throw new Error('EPERM (injected)'); } }).join(' '), /cannot check .*EPERM/);
});

test('C1 behaviour: the gate REFUSES the launch (stop + throw) on a project layer; passes otherwise; wired before the app spawns, every launch', () => {
  const cwd = fs.mkdtempSync(path.join(JAIL, 'c-'));
  const run = new lb.LayerB(lb.parseArgs(['--dry-run-stubs']));
  run.spec = [{ id: 'lb-codex', cwd }, { id: 'lb-claude', cwd: path.join(JAIL, 'missing') }];
  let stopped = null; run.stop = (why) => { stopped = why; };
  run.jailProjectConfigGate('before launch x');
  assert.equal(stopped, null);
  fs.mkdirSync(path.join(cwd, '.codex'));
  fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), 'approval_policy = "never"\n');
  assert.throws(() => run.jailProjectConfigGate('before launch 1.1.75 (phase A)'), /jail project config \(before launch 1\.1\.75 \(phase A\)\)/);
  assert.match(stopped, /an agent cwd holds a project config/);
  const launch = src.slice(src.indexOf('  async launch(exe, label) {'), src.indexOf('  async launch(exe, label) {') + 1500);
  const at = launch.indexOf('this.jailProjectConfigGate(`before launch ${label}`);');
  assert.ok(at > 0 && at < launch.indexOf('spawn(exe'), 'before the app is spawned, in launch() (so every launch)');
});

/** A stand-in for node-pty's Terminal and the app's pty:write handler (index.ts:3927). */
function fakeApp() {
  const sent = [];
  class Terminal { constructor(pid) { this.pid = pid; } write(data) { sent.push([this.pid, data]); } }
  const cache = { 'C:\\app\\resources\\app.asar\\node_modules\\node-pty\\lib\\terminal.js': { exports: { Terminal } } };
  const codex = new Terminal(4242);
  const handlers = new Map([['pty:write', (_evt, id, data) => { if (id === 'pty-lb-codex') codex.write(data); return { ok: true }; }]]);
  return { sent, Terminal, cache, codex, ipcMain: { _invokeHandlers: handlers }, root: {} };
}

test('input capture: TRANSPARENT; a renderer IPC write is attributed to the renderer with its origin, a main-side write to main; installing twice wraps once', () => {
  const app = fakeApp();
  let t = 1000;
  const r = JSON.parse(lb.installPtyInputCapture(() => { throw new Error('the cache must be used'); }, app.cache, app.ipcMain, app.root, () => t++));
  assert.deepEqual([r.wrapped, r.ipcWrapped], [true, true]);
  JSON.parse(lb.installPtyInputCapture(null, app.cache, app.ipcMain, app.root, () => t++));
  assert.deepEqual(app.ipcMain._invokeHandlers.get('pty:write')(null, 'pty-lb-codex', 'hi', 'HUMAN'), { ok: true });
  app.codex.write('[hive] check inbox');   // the main-side submit owner (ptyManager.write)
  app.codex.write('\r');
  assert.deepEqual(app.sent, [[4242, 'hi'], [4242, '[hive] check inbox'], [4242, '\r']], 'every write still reaches the pty, once');
  const q = JSON.parse(lb.ptyInputQuery(app.root));
  assert.deepEqual(q.rows.map((x) => [x.source, x.ptyId, x.origin, x.pid, x.len]), [['renderer-ipc', 'pty-lb-codex', 'HUMAN', 4242, 2], ['main', null, null, 4242, 18], ['main', null, null, 4242, 1]]);
});

test('input evidence: control bytes NAMED, printable runs short and REDACTED (a secret-shaped string never appears); the pty id from the app pid map', () => {
  const app = fakeApp();
  lb.installPtyInputCapture(null, app.cache, app.ipcMain, app.root, () => Date.parse('2026-09-30T10:00:00Z'));
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  app.codex.write('\x1b[200~[hive] check inbox\x1b[201~');
  app.codex.write('\r');
  app.codex.write(`token ${secret}\n\x03\x03\x7f\t\x00`);
  app.codex.write('x'.repeat(500));
  const ev = lb.ptyInputEvidence(JSON.parse(lb.ptyInputQuery(app.root)), { 4242: 'pty-lb-codex' });
  assert.equal(ev[0].ptyId, 'pty-lb-codex');
  assert.equal(ev[0].at, '2026-09-30T10:00:00.000Z');
  assert.deepEqual(ev[0].classes, [{ ctrl: 'ESC', n: 1 }, { text: '[200~[hive] check inbox', chars: 23 }, { ctrl: 'ESC', n: 1 }, { text: '[201~', chars: 5 }]);
  assert.deepEqual(ev[1].classes, [{ ctrl: 'CR', n: 1 }]);
  const all = JSON.stringify(ev);
  assert.ok(!all.includes(secret) && !all.includes('abcdefghijklmnopqrstuvwxyz0123'), 'the secret is redacted');
  assert.deepEqual(ev[2].classes.filter((c) => c.ctrl).map((c) => [c.ctrl, c.n]), [['LF', 1], ['Ctrl-C', 2], ['DEL', 1], ['TAB', 1], ['NUL', 1]]);
  assert.deepEqual([ev[3].classes[0].text.length, ev[3].classes[0].chars, ev[3].classes[0].capped], [80, 500, true], 'a long run is capped');
  assert.ok(!/[\x00-\x1f\x7f]/.test(all.replace(/\\[nrtu]/g, '')), 'no raw control byte in the evidence');
});

test('input capture wiring: installed at every launch next to the output capture; queried before every stop; written to evidence/pty-input.json (redacted)', () => {
  const launch = src.slice(src.indexOf('  async launch(exe, label) {'), src.indexOf('  /** BrowserWindow.isVisible()'));
  assert.ok(launch.indexOf("await this.ptyInputCapture('install')") > launch.indexOf("await this.ptyCapture('install')"));
  const stop = src.slice(src.indexOf('  async stopApp(label) {'), src.indexOf('  async stopApp(label) {') + 600);
  assert.ok(stop.indexOf("await this.ptyInputCapture('query', label)") > 0 && stop.indexOf("await this.ptyInputCapture('query', label)") < stop.indexOf('this.procs.killAll()'), 'before the app is killed');
  assert.match(src, /W\.write\(path\.join\(dst, 'pty-input\.json'\), redact\(JSON\.stringify\(this\.ptyInputs \|\| \[\], null, 2\)\)\);/);
  const m = src.slice(src.indexOf('  async ptyInputCapture(kind, label) {'), src.indexOf('  async stopApp(label) {'));
  assert.match(m, /writes: ptyInputEvidence\(out, pidToId\)/, 'only classified rows are kept');
  assert.match(m, /process\.mainModule\.constructor\._cache/, 'the module cache: the node-pty the app really loaded');
});
