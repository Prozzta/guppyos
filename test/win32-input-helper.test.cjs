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
  const typing = helper.type('hello FEAT-X', '4242');
  assert.equal(children.length, 2, 'the next request starts a replacement helper');
  assert.deepEqual(children[1].writes[0], { op: 'type', text: 'hello FEAT-X', hwnd: '4242' });
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
    child.stdin.write('{"op":"selftest"}\n'); { const d = await wait(3); assert.equal(d.ev, 'down'); assert.match(d.hwnd, /^[0-9]+$/, 'a down names the foreground window'); } assert.deepEqual(await wait(4), { ev: 'up' }); assert.deepEqual(await wait(5), { ok: true, op: 'selftest', swallow: [false, false, true, true, false, false, false] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.write('{"op":"quit"}\n'); assert.deepEqual(await wait(6), { ok: true, op: 'quit' });
    await exited;
  } finally { if (!child.killed) child.kill(); }
});

// ---------------------------------------------------------------- GUPPY-DICTATION-P2: S2 / S3 / S5
function fakeTimers() {
  let seq = 0; const live = new Map();
  return { set(fn, ms) { const id = ++seq; live.set(id, { fn, ms }); return id; }, clear(id) { live.delete(id); }, pending() { return [...live.values()].map((t) => t.ms); }, fire(ms) { for (const [id, t] of [...live]) if (t.ms === ms) { live.delete(id); t.fn(); } } };
}
const tick = () => new Promise((r) => setImmediate(r));
const rearms = (timers) => timers.pending().filter((ms) => I.INPUT_HELPER_REARM_MS.includes(ms));

test('S3: a child that dies mid-hold gets a synthetic up, and the hook is re-armed on a fresh child with backoff', async () => {
  const children = []; const timers = fakeTimers();
  const helper = new I.Win32InputHelper(() => 'C:/input/guppy-input.exe', () => { const c = new FakeChild(); children.push(c); return c; }, 3000, timers);
  const seen = []; const states = [];
  helper.onEvent((ev, info) => seen.push([ev, !!info.synthetic])); helper.onHookState((s) => states.push(s));
  const armed = helper.startHook('Ctrl+Alt+Space');
  children[0].reply({ ok: true, op: 'hook' }); await armed;
  children[0].reply({ ev: 'down' }); await tick();
  children[0].emit('exit');
  assert.deepEqual(seen, [['down', false], ['up', true]], 'the orphaned down is closed, flagged synthetic');
  assert.deepEqual(rearms(timers), [I.INPUT_HELPER_REARM_MS[0]]);
  timers.fire(I.INPUT_HELPER_REARM_MS[0]);
  assert.equal(children.length, 2, 'the re-arm spawns a replacement');
  assert.deepEqual(children[1].writes[0], { op: 'hook', chord: 'Ctrl+Alt+Space' });
  children[1].reply({ ok: true, op: 'hook' }); await tick();
  assert.deepEqual(states, ['armed', 'rearming', 'armed']);
  // A death without a pending down emits no extra up; consecutive deaths back off.
  children[1].emit('exit');
  assert.equal(seen.length, 2, 'no up without a down');
  timers.fire(I.INPUT_HELPER_REARM_MS[0]);
  children[2].emit('exit');
  assert.deepEqual(rearms(timers), [I.INPUT_HELPER_REARM_MS[1]], 'the second consecutive failure waits longer');
  helper.kill();
  assert.deepEqual(rearms(timers), [], 'kill cancels the re-arm');
});

test('S3: stopHook cancels re-arming; a request-timeout kill re-arms; a refused hook reports failed', async () => {
  const children = []; const timers = fakeTimers();
  const helper = new I.Win32InputHelper(() => 'C:/input/guppy-input.exe', () => { const c = new FakeChild(); children.push(c); return c; }, 3000, timers);
  const states = []; helper.onHookState((s, e) => states.push(e ? `${s}:${e}` : s));
  const a = helper.startHook(); children[0].reply({ ok: true, op: 'hook' }); await a;
  const slow = helper.request({ op: 'ping' });
  timers.fire(3000);   // the M4 timeout kills the child...
  assert.equal(await slow, null); assert.equal(children[0].killed, true);
  assert.deepEqual(rearms(timers), [I.INPUT_HELPER_REARM_MS[0]], '...and hold-to-talk is re-armed rather than silently dead');
  await helper.stopHook();
  assert.deepEqual(rearms(timers), [], 'stopHook cancels the re-arm');
  const b = helper.startHook(); children[1].reply({ ok: false, error: 'SetWindowsHookEx failed (5)' }); await b; await tick();
  assert.ok(states.includes('failed:SetWindowsHookEx failed (5)'));
  assert.deepEqual(rearms(timers), [I.INPUT_HELPER_REARM_MS[0]], 'a refused hook is retried too');
  helper.kill();
  const none = new I.Win32InputHelper(() => null, () => { throw new Error('never spawned'); }, 3000, fakeTimers());
  const ns = []; none.onHookState((s, e) => ns.push(`${s}:${e}`));
  assert.equal(await none.startHook(), null);
  assert.deepEqual(ns, ['failed:input helper not found']);
});

test('type gets the longer timeout (modifier wait + paste settle); other requests keep the short one', async () => {
  const children = []; const timers = fakeTimers();
  const helper = new I.Win32InputHelper(() => 'C:/input/guppy-input.exe', () => { const c = new FakeChild(); children.push(c); return c; }, 3000, timers);
  const t = helper.type('hi', '7');
  assert.deepEqual(timers.pending(), [I.INPUT_HELPER_TYPE_MS]);
  children[0].reply({ ok: true, fallback: false });
  assert.deepEqual(await t, { ok: true, fallback: false });
  const p = helper.request({ op: 'ping' });
  assert.deepEqual(timers.pending(), [3000]);
  children[0].reply({ ok: true, op: 'ping' }); await p;
  helper.kill();
});

test('S2/S5 source pins: only the writer thread touches stdout; hook commands are queued; the clipboard is snapshotted and kept out of history', () => {
  const cs = fs.readFileSync(path.join(root, 'resources', 'input', 'guppy-input.cs'), 'utf8');
  const consoleOut = cs.split(/\r?\n/).filter((l) => /Console\.(Write|Out\.)/.test(l));
  assert.equal(consoleOut.length, 1, 'one stdout writer'); assert.match(consoleOut[0], /static void Writer\(\)/);
  assert.match(cs, /static void Reply\(string json\) \{ try \{ Output\.Add\(json\); \}/, 'Reply only enqueues: the hook callback never blocks on the pipe');
  assert.doesNotMatch(cs, /lock \(/, 'no lock is shared between the hook callback and command replies');
  assert.match(cs, /ConcurrentQueue<int> HookCommands/);
  assert.match(cs, /while \(HookCommands\.TryDequeue\(out cmd\)\)/, 'every queued hook/unhook is applied and answered');
  assert.match(cs, /saved = CopyFormats\(Clipboard\.GetDataObject\(\)\);\s*Clipboard\.SetDataObject\(TransientText\(text\), true\);/, 'snapshot before replacing');
  assert.match(cs, /if \(GetClipboardSequenceNumber\(\) == ours\)/, 'a newer clipboard entry is never overwritten by the restore');
  assert.match(cs, /Thread\.Sleep\(PASTE_SETTLE_MS\);/, 'the target app reads the paste before the restore');
  assert.match(cs, /else if \(!WaitModifiersReleased\(\)\) Error\("type", "modifier keys still held"\);/, 'never types while Ctrl/Alt are held (letters would become shortcuts)');
  assert.match(cs, /bool fallback = n == 0 && PasteFallback\(text, want, out restored, out why\);/, 'a partial SendInput never pastes the whole text again');
});

test('F1 source pins: text goes only to the chord-down window; every reply names its op; a failed restore keeps ok', () => {
  const cs = fs.readFileSync(path.join(root, 'resources', 'input', 'guppy-input.cs'), 'utf8');
  assert.match(cs, /Reply\("\{\\"ev\\":\\"down\\",\\"hwnd\\":\\"" \+ Foreground\(\) \+ "\\"\}"\);/, 'a real chord-down carries the foreground window');
  assert.match(cs, /static string FocusRefusal\(long want, long now\) \{ if \(want == 0\) return "no target window"; if \(now != want\) return "focus changed"; return null; \}/);
  // In the type branch: focus is checked before the modifier wait AND after it, and only then is anything sent.
  const type = cs.slice(cs.indexOf('else if (op == "type")'), cs.indexOf('else if (op == "echo")'));
  const at = (re) => { const m = re.exec(type); assert.ok(m, `type branch: ${re}`); return m.index; };
  const first = at(/else if \(\(refuse = FocusRefusal\(want, Foreground\(\)\)\) != null\) Error\("type", refuse\);\s*else if \(!WaitModifiersReleased/);
  const wait = at(/else if \(!WaitModifiersReleased\(\)\)/);
  const second = at(/WaitModifiersReleased\(\)\) Error\("type", "modifier keys still held"\);\s*else if \(\(refuse = FocusRefusal\(want, Foreground\(\)\)\) != null\) Error\("type", refuse\);/);
  const send = at(/uint n = SendUnicode\(text\);/);
  assert.ok(first < wait && second < send && wait < send, 'focus check, modifier wait, focus check, then SendInput');
  assert.match(type, /long want = ParseHwnd\(StringValue\(line, "hwnd"\)\);/, 'the window comes from the request');
  // The paste is focus-checked too, and the restore sits in its own try.
  const pf = cs.slice(cs.indexOf('static bool PasteFallback('), cs.indexOf('static void ClipTest('));
  assert.match(pf, /why = FocusRefusal\(want, Foreground\(\)\);\s*if \(why == null\) \{\s*INPUT\[\] rows/, 'Ctrl+V only into the chord-down window');
  assert.match(pf, /catch \{ ok = false; \}\s*\/\/[^\n]*\n\s*try \{ if \(GetClipboardSequenceNumber\(\) == ours\)[\s\S]*?\}\s*catch \{ restored = false; \}\s*return ok;/, 'a failed restore reports restored:false, never ok:false after a real paste');
  assert.doesNotMatch(cs, /Error\("[^"]*"\)/, 'every error reply names its op');
});

test('built helper: clipboard snapshot + transient marking on private objects, and empty text types nothing', { skip: process.platform !== 'win32' ? 'Windows only' : false, timeout: 15_000 }, async () => {
  const build = spawnSync(process.execPath, ['tools/build-input-helper.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(build.status, 0, `${build.stdout}${build.stderr}`);
  const exe = path.join(root, 'resources', 'input', 'bin', 'guppy-input.exe');
  const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
    let buffered = ''; const rows = []; child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { buffered += d; let i; while ((i = buffered.indexOf('\n')) >= 0) { const line = buffered.slice(0, i).trim(); buffered = buffered.slice(i + 1); if (line) rows.push(JSON.parse(line)); } });
    const wait = (n) => new Promise((resolve, reject) => { const until = Date.now() + 4000; const t = () => rows.length >= n ? resolve(rows[n - 1]) : Date.now() > until ? reject(new Error('helper response timed out')) : setTimeout(t, 10); t(); });
    child.stdin.write('{"op":"cliptest"}\n');
    assert.deepEqual(await wait(1), { ok: true, op: 'cliptest', text: 'orig \u00fc', custom: '07-08-09', transient: true, transientText: 'dictated' });
    child.stdin.write('{"op":"type","text":""}\n'); assert.deepEqual(await wait(2), { ok: false, op: 'type', error: 'empty text' });
    // F1 on the real binary without typing anything: focustest only evaluates FocusRefusal.
    child.stdin.write('{"op":"focustest","want":"5","now":"5"}\n'); assert.deepEqual(await wait(3), { ok: true, op: 'focustest', refusal: '' });
    child.stdin.write('{"op":"focustest","want":"5","now":"6"}\n'); assert.deepEqual(await wait(4), { ok: true, op: 'focustest', refusal: 'focus changed' });
    child.stdin.write('{"op":"focustest","now":"6"}\n'); assert.deepEqual(await wait(5), { ok: true, op: 'focustest', refusal: 'no target window' });
    child.stdin.write('{"op":"focustest","want":"1"}\n'); assert.deepEqual(await wait(6), { ok: true, op: 'focustest', refusal: 'focus changed' }, 'the real foreground window is never 1');
    child.stdin.write('{"op":"nope"}\n'); assert.deepEqual(await wait(7), { ok: false, op: 'nope', error: 'unknown op' });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.write('{"op":"quit"}\n'); assert.deepEqual(await wait(8), { ok: true, op: 'quit' });
    await exited;
  } finally { if (!child.killed) child.kill(); }
});

test('replies are matched by op (hook/unhook and the rest come from different helper threads); a down carries its window', async () => {
  const children = []; const timers = fakeTimers();
  const helper = new I.Win32InputHelper(() => 'C:/input/guppy-input.exe', () => { const c = new FakeChild(); children.push(c); return c; }, 3000, timers);
  const infos = []; helper.onEvent((ev, info) => infos.push([ev, info.hwnd]));
  const hook = helper.startHook();
  const ping = helper.request({ op: 'ping' });
  children[0].reply({ ok: true, op: 'ping' });   // the reader thread answers first
  children[0].reply({ ok: true, op: 'hook' });
  assert.deepEqual(await ping, { ok: true, op: 'ping' }, 'the ping reply is not handed to the older hook request');
  assert.deepEqual(await hook, { ok: true, op: 'hook' });
  const legacy = helper.request({ op: 'echo', text: 'x' });
  children[0].reply({ ok: true });   // no op: the oldest pending request
  assert.deepEqual(await legacy, { ok: true });
  children[0].reply({ ev: 'down', hwnd: '123456' }); children[0].reply({ ev: 'up', hwnd: '9' });
  children[0].reply({ ev: 'down', hwnd: 77 });
  await tick();
  assert.deepEqual(infos, [['down', '123456'], ['up', undefined], ['down', undefined]], 'only a string hwnd on a down is passed on');
  helper.kill();
});
