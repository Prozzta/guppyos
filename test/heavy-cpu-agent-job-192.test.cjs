'use strict';
// @heavy-lock live: spawns real job helpers and holds them for about 40 s
/**
 * CODEX-AGY-ASKFIRST-HEAVYCPU-192: a heavy call that cannot take a join line (an agent that asks
 * its user first, or a Codex shell Guppy cannot read) runs in its agent's own job. The agent's tree
 * is put in that job at the call's PreToolUse, before the shell exists, so every process of the call
 * is created inside the limits (no snapshot-then-assign window); the limits come off when the
 * shell's tree is gone, not at the PostToolUse; the job is let go when the agent goes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/heavyCpu.ts');

// ── the per-agent count and the end of a call (fake helper) ─────────────────────────────────

/** A fake serve: `call` answers from `state[startMs]` ({shell, alive, total}). */
function fakeServe() {
  const sent = [];
  const state = {};
  return {
    sent,
    state,
    channel: () => ({
      request: async (line) => {
        sent.push(line);
        const w = line.split(' ');
        if (w[0] === 'agent') return { ok: true, jobs: 1, members: 3, added: 3, missed: 0, total: 3 };
        if (w[0] === 'call') return { ok: true, total: 3, ...(state[w[2]] ?? { shell: 0, alive: 0 }) };
        return { ok: true };
      },
      close() {}
    })
  };
}

function jobs(f, now, o = { background: true, half: true }) {
  const logs = [];
  const j = new C.HeavyJobs({ platform: 'win32', options: () => o, exe: () => 'x', channel: f.channel, now: () => now.t, setInterval: () => 1, clearInterval: () => {}, log: (r) => logs.push(r), root: (id) => (id === 'gone' ? null : 777) });
  return { j, logs };
}

test('two calls of one agent overlap: the limits go on once, stay while either lives, and come off when the last ends, in either order', async () => {
  for (const order of [['A', 'B'], ['B', 'A']]) {
    const f = fakeServe(); const now = { t: 1000 };
    const { j, logs } = jobs(f, now);
    await j.attachCall('a1', { command: 'npm ci' }, 'ask-first', 'codex');
    now.t = 2000;
    await j.attachCall('a1', { command: 'npm run build' }, 'unknown-shell', 'codex');
    assert.equal(j.agentCallCount('a1'), 2);
    assert.deepEqual(f.sent.filter((l) => l.startsWith('agent ')), ['agent a1-agent 777 1 1 1000', 'agent a1-agent 777 1 1 2000'], 'limits on at each attach, in the same request as the sweep');
    assert.ok(!f.sent.some((l) => l.startsWith('set ')));
    const startOf = { A: 1000, B: 2000 };
    f.state[1000] = { shell: 11, alive: 2 }; f.state[2000] = { shell: 22, alive: 2 };
    await j.poll();
    f.state[startOf[order[0]]] = { shell: 0, alive: 0 }; // its shell was seen; its tree is gone now
    await j.poll(); await j.poll();
    assert.equal(j.agentCallCount('a1'), 1, `${order[0]} ended`);
    assert.ok(!f.sent.includes('set a1-agent 0 0'), 'the other call still runs: limits stay');
    f.state[startOf[order[1]]] = { shell: 0, alive: 0 };
    await j.poll(); await j.poll();
    assert.equal(j.agentCallCount('a1'), 0, 'the count is back to 0');
    assert.equal(f.sent.filter((l) => l === 'set a1-agent 0 0').length, 1, 'limits off once, when the last call ends');
    assert.deepEqual(logs.filter((r) => r.action === 'done').map((r) => r.live), [1, 0]);
  }
});

test('a call ends when its shell\'s tree is gone, not at its PostToolUse (Codex returns from a long command while it runs)', async () => {
  const f = fakeServe(); const now = { t: 5000 };
  const { j } = jobs(f, now);
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  f.state[5000] = { shell: 9, alive: 4 };
  j.callPost('a1', { command: 'npm ci' });
  await j.poll(); await j.poll(); await j.poll();
  assert.equal(j.agentCallCount('a1'), 1, 'still running after its Post: still limited');
  assert.ok(!f.sent.includes('set a1-agent 0 0'));
  f.state[5000] = { shell: 0, alive: 0 };
  await j.poll(); await j.poll();
  assert.equal(j.agentCallCount('a1'), 0);
  assert.ok(f.sent.includes('set a1-agent 0 0'));
});

test('a shell never seen, after its Post: held while anything created in the jobs since the call began lives (it may be the call), then unseen; attach-missed when the jobs got nothing new', async () => {
  const f = fakeServe(); const now = { t: 100 };
  const { j, logs } = jobs(f, now);
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  f.state[100] = { shell: 0, alive: 0, fresh: 2, total: 9 }; // a shell whose command line does not show the command, still running
  j.callPost('a1', { command: 'npm ci' });
  await j.poll(); await j.poll(); await j.poll();
  assert.equal(j.agentCallCount('a1'), 1, 'still held (and limited) after its Post while it may run');
  assert.ok(!f.sent.includes('set a1-agent 0 0'));
  f.state[100] = { shell: 0, alive: 0, fresh: 0, total: 9 };
  await j.poll();
  assert.equal(j.agentCallCount('a1'), 1, 'one empty check is not the end');
  await j.poll();
  assert.equal(j.agentCallCount('a1'), 0);
  assert.equal(logs.at(-1).action, 'unseen', 'not "done": its shell was never identified');
  now.t = 200;
  await j.attachCall('a1', { command: 'npm ci' }, 'unknown-shell');
  j.callPost('a1', { command: 'npm ci' });
  await j.poll(); await j.poll();
  assert.equal(logs.at(-1).action, 'attach-missed', 'nothing new in the jobs: it ran outside (e.g. started by a service)');
});

test('a shell never seen, after its Post, with something fresh that never ends (a server it started): held only up to the unstarted limit', async () => {
  const f = fakeServe(); const now = { t: 100 };
  const { j, logs } = jobs(f, now);
  await j.attachCall('a1', { command: 'npm run dev' }, 'unknown-shell');
  f.state[100] = { shell: 0, alive: 0, fresh: 1, total: 9 };
  j.callPost('a1', { command: 'npm run dev' });
  now.t = 100 + C.HEAVY_JOB_UNSTARTED_MS - 1;
  await j.poll(); await j.poll();
  assert.equal(j.agentCallCount('a1'), 1, 'held while it may still be the call');
  now.t = 100 + C.HEAVY_JOB_UNSTARTED_MS;
  await j.poll();
  assert.equal(j.agentCallCount('a1'), 0);
  assert.equal(logs.at(-1).action, 'unseen-capped');
  assert.ok(f.sent.includes('set a1-agent 0 0'), 'the agent is no longer limited');
});

test('the attach row says whether the agent holds its jobs\' names (kept false: a serve restart would lose them)', async () => {
  for (const kept of [true, false]) {
    const logs = [];
    const j = new C.HeavyJobs({ platform: 'win32', options: () => ({ background: true, half: true }), exe: () => 'x', now: () => 1, setInterval: () => 1, clearInterval: () => {}, log: (r) => logs.push(r), root: () => 777,
      channel: () => ({ request: async (line) => (line.startsWith('agent ') ? { ok: true, members: 1, missed: 0, total: 1, kept } : { ok: true }), close() {} }) });
    await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
    assert.equal(logs.find((r) => r.action === 'attach').kept, kept);
  }
});

test('a call with no Post: held until the agent\'s turn ends (a declined call), else the unstarted limit; a started or Posted call is not ended by the turn', async () => {
  const f = fakeServe(); const now = { t: 300 };
  const { j, logs } = jobs(f, now);
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first', 'codex');
  await j.poll();
  assert.equal(j.agentCallCount('a1'), 1, 'not run yet (its user has not answered)');
  await j.turnEnded('a1', 'Stop');
  assert.equal(j.agentCallCount('a1'), 0);
  assert.deepEqual([logs.at(-1).action, logs.at(-1).why], ['not-run', 'Stop']);
  assert.ok(f.sent.includes('set a1-agent 0 0'), 'limits off at once, not after 30 min');
  now.t = 400;
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  f.state[400] = { shell: 9, alive: 1 };
  await j.poll();
  now.t = 500;
  await j.attachCall('a1', { command: 'npm test' }, 'ask-first');
  j.callPost('a1', { command: 'npm test' });
  await j.turnEnded('a1', 'UserPromptSubmit');
  assert.equal(j.agentCallCount('a1'), 2, 'a running call and a Posted one stay');
  now.t = 600;
  const g = jobs(fakeServe(), now);
  await g.j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  now.t = 600 + C.HEAVY_JOB_UNSTARTED_MS;
  await g.j.poll();
  assert.equal(g.logs.at(-1).action, 'never-started', 'no turn end seen: the unstarted limit');
});

test('two checks at once end a call once (no second done row, no second lift)', async () => {
  const f = fakeServe(); const now = { t: 700 };
  const { j, logs } = jobs(f, now);
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  f.state[700] = { shell: 9, alive: 1 };
  await j.poll();
  f.state[700] = { shell: 9, alive: 0 };
  await Promise.all([j.poll(), j.poll(), j.poll()]);
  await Promise.all([j.poll(), j.poll(), j.poll()]);
  await Promise.all([j.poll(), j.poll(), j.poll()]);
  assert.equal(logs.filter((r) => r.action === 'done').length, 1);
  assert.equal(f.sent.filter((l) => l === 'set a1-agent 0 0').length, 1);
});

test('the agent going (exit or respawn) lifts its limits first (what outlives it gets its own values back), then lets its job go; an agent with no process logs a failed attach', async () => {
  const f = fakeServe(); const now = { t: 1 };
  const { j, logs } = jobs(f, now);
  await j.agentGone('a1');
  assert.ok(!f.sent.includes('close a1-agent'), 'no job made yet: nothing to close');
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  await j.agentGone('a1');
  assert.deepEqual(f.sent.slice(-2), ['set a1-agent 0 0', 'close a1-agent'], 'mid-call: lift, then close');
  assert.equal(j.agentCallCount('a1'), 0);
  assert.deepEqual(logs.at(-1), { kind: 'heavy-cpu', action: 'agent-gone', agentId: 'a1', job: 'a1-agent', live: 1 });
  f.state[1] = { shell: 9, alive: 0 };
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  await j.poll(); await j.poll();
  assert.equal(j.agentCallCount('a1'), 0);
  const n = f.sent.length;
  await j.agentGone('a1');
  assert.deepEqual(f.sent.slice(n), ['close a1-agent'], 'no call live: the limits are off already');
  await j.attachCall('gone', { command: 'npm ci' }, 'ask-first', 'codex');
  assert.equal(logs.at(-1).action, 'attach-failed');
  assert.ok(!f.sent.some((l) => l.startsWith('agent gone')));
});

test('a sweep that fails takes back the limits it may have set when no other call of the agent is live', async () => {
  const sent = [];
  const logs = [];
  const j = new C.HeavyJobs({ platform: 'win32', options: () => ({ background: true, half: true }), exe: () => 'x', now: () => 1, setInterval: () => 1, clearInterval: () => {}, log: (r) => logs.push(r), root: () => 777,
    channel: () => ({ request: async (line) => { sent.push(line); return line.startsWith('agent ') ? { ok: false, error: 'no process 777' } : { ok: true }; }, close() {} }) });
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  assert.deepEqual(sent, ['agent a1-agent 777 1 1 1', 'set a1-agent 0 0']);
  assert.deepEqual([logs.at(-1).action, logs.at(-1).why], ['attach-failed', 'no process 777']);
  await j.agentGone('a1');
  assert.equal(sent.at(-1), 'close a1-agent', 'its job is still let go');
});

test('a reply in error (slow or unreadable) keeps the helper: only a dead one is started again, so the agent jobs in it are not lost', async () => {
  let made = 0;
  const sent = [];
  const reply = { v: { ok: false, error: 'no reply in time' } };
  const j = new C.HeavyJobs({ platform: 'win32', options: () => ({ background: true, half: true }), exe: () => 'x', now: () => 1, setInterval: () => 1, clearInterval: () => {}, log: () => {}, root: () => 777,
    channel: () => { made++; return { request: async (line) => { sent.push(line); return line.startsWith('agent ') ? { ok: true, total: 1 } : reply.v; }, close() {} }; } });
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  await j.poll();
  reply.v = { ok: false, error: 'unreadable reply' };
  await j.poll();
  assert.equal(made, 1, 'one helper for all of it');
  assert.equal(j.agentCallCount('a1'), 1, 'the call is not ended by an unknown answer');
  reply.v = null; // gone
  await j.poll();
  await j.poll();
  assert.equal(made, 2, 'a dead helper is started again');
});

test('WIRING: the helper\'s error reply is one line (a message with a line break would be read as two replies)', () => {
  const cs = fs.readFileSync(path.join(__dirname, '..', 'resources', 'heavyjob', 'guppy-heavyjob.cs'), 'utf8');
  assert.ok(cs.includes('reply = "{\\"ok\\":false,\\"error\\":\\"" + e.Message.Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"").Replace("\\r", " ").Replace("\\n", " ") + "\\"}";'));
});

test('WIRING: main gives the agent\'s PTY process as its root and lets its job go at PTY exit and at each new spawn', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /root: \(agentId\) => ptyManager\.list\(\)\.filter\(\(s\) => ptyToAgent\.get\(s\.id\) === agentId && s\.pid > 0\)\.at\(-1\)\?\.pid \?\? null/);
  assert.match(idx, /if \(!\[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\)\) void heavyJobs\.agentGone\(agentId\)/, 'at PTY exit');
  assert.match(idx, /if \(res\.ok && opts\.hive\?\.id && !\[\.\.\.ptyToAgent\]\.some\(\(\[id, a\]\) => a === opts\.hive\?\.id && id !== opts\.id\)\) void heavyJobs\.agentGone\(opts\.hive\.id\)/, 'at a new spawn, when no other PTY of the agent runs');
  const hooks = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8');
  assert.match(hooks, /this\.heavyJobs\?\.callPost\(agentId, p\.tool_input\)/);
  assert.match(hooks, /if \(agentId && !fromSubagent && \(\(event === 'Stop' && p\.fully_idle !== false\) \|\| event === 'StopFailure' \|\| event === 'UserPromptSubmit'\)\) \{\r?\n\s+void this\.heavyJobs\?\.turnEnded\(agentId, event\)/, 'a turn end reaches the unstarted calls');
});

// ── LIVE: the real helper and a Codex-shaped agent ─────────────────────────────────────────

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// A probe: `record <dir>` writes "<affinity mask> <priority class>" to <dir>/<pid>; `fork <dir>`
// records, starts `record` and exits at once; `fork2 <dir>` starts `fork` and exits at once (a
// grandchild that forks and is gone in milliseconds); `hold <ms> <dir>` records and waits;
// `watch <d1> <d2> <d3>` sets its own ABOVE_NORMAL and a first-and-last-processor affinity, records to d1, and to each next folder once the one before holds a `go`
// file (a long-lived process of the agent, read back from inside before, during and after a call);
// `breakaway <dir>` records whether a child may be created with CREATE_BREAKAWAY_FROM_JOB.
const PROBE = `
using System; using System.Diagnostics; using System.IO; using System.Runtime.InteropServices;
static class Probe {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string r, d, t; public int x, y, w, h, cx, cy, fa, fl; public short sw, r2; public IntPtr r3, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inh, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  static string Self() { return Process.GetCurrentProcess().MainModule.FileName; }
  static void Record(string dir) { var p = Process.GetCurrentProcess(); File.WriteAllText(Path.Combine(dir, p.Id.ToString()), ((long)p.ProcessorAffinity).ToString() + " " + ((int)p.PriorityClass).ToString()); }
  static void Start(string args) { Process.Start(new ProcessStartInfo(Self(), args) { UseShellExecute = false, CreateNoWindow = true }); }
  static int Main(string[] a) {
    if (a[0] == "record") Record(a[1]);
    else if (a[0] == "fork") { Record(a[1]); Start("record \\"" + a[1] + "\\""); }
    else if (a[0] == "fork2") Start("fork \\"" + a[1] + "\\"");
    else if (a[0] == "hold") { Record(a[2]); System.Threading.Thread.Sleep(int.Parse(a[1])); }
    else if (a[0] == "watch") {
      var me = Process.GetCurrentProcess(); int n = Environment.ProcessorCount;
      me.PriorityClass = ProcessPriorityClass.AboveNormal; me.ProcessorAffinity = (IntPtr)(n > 1 ? (1L | (1L << (n - 1))) : 1L);
      for (int i = 1; i < a.Length; i++) { Record(a[i]); if (i + 1 < a.Length) while (!File.Exists(Path.Combine(a[i], "go"))) System.Threading.Thread.Sleep(20); } }
    else if (a[0] == "breakaway") {
      var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); PI pi;
      bool ok = CreateProcessW(Self(), "probe record \\"" + a[1] + "\\"", IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, null, ref si, out pi);
      File.WriteAllText(Path.Combine(a[1], "breakaway"), ok ? "ok" : ("err " + Marshal.GetLastWin32Error()));
    }
    return 0;
  }
}`;

// The agent: a node shim (the PTY's process) that starts the CLI, as the npm Codex does; the CLI
// runs each stdin line as Codex 0.157 runs a command (observed 2026-10-17): Windows PowerShell,
// -Command, an encoding prefix and the command, a direct child of the CLI.
const SHIM = `const { spawn } = require('child_process'); const c = spawn(process.execPath, [process.argv[2]], { stdio: 'inherit' }); c.on('exit', (code) => process.exit(code ?? 0));`;
const CLI = `
const { spawn } = require('child_process'); const rl = require('readline').createInterface({ input: process.stdin });
const prefix = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}' + String.fromCharCode(10);
rl.on('line', (line) => { const { cmd } = JSON.parse(line); spawn('powershell.exe', ['-NoProfile', '-Command', prefix + cmd], { stdio: 'ignore', windowsHide: true }); });
rl.on('close', () => process.exit(0));`;

const until = async (what, ok, ms = 30_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)); } };
const rows = (dir) => fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).map((n) => { const [mask, prio] = fs.readFileSync(path.join(dir, n), 'utf8').split(' ').map(Number); return { pid: Number(n), mask, prio }; });

test('LIVE: an ask-first call\'s whole tree, a grandchild that forks and exits at once included, runs inside the limits; a light call beside it completes; after it the agent is as before',
  { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 180_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-agent-'));
    let shim = null; let j = null;
    try {
      const exe = path.join(dir, 'guppy-heavyjob.exe'); const probe = path.join(dir, 'probe.exe');
      let c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, path.join(__dirname, '..', 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
      fs.writeFileSync(path.join(dir, 'probe.cs'), PROBE);
      c = spawnSync(CSC, ['-nologo', '-O', `-out:${probe}`, path.join(dir, 'probe.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc probe: ${c.stdout}${c.stderr}`);
      fs.writeFileSync(path.join(dir, 'shim.js'), SHIM); fs.writeFileSync(path.join(dir, 'cli.js'), CLI);
      shim = spawn(process.execPath, [path.join(dir, 'shim.js'), path.join(dir, 'cli.js')], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      const run = (cmd) => shim.stdin.write(`${JSON.stringify({ cmd })}\n`);
      const sub = (name) => { const d = path.join(dir, name); fs.mkdirSync(d); return d; };
      const half = C.halfCoreCount(os.cpus().length);
      const bits = (m) => { let n = 0; for (let x = BigInt(m); x; x >>= 1n) n += Number(x & 1n); return n; };
      const logs = [];
      j = new C.HeavyJobs({ platform: 'win32', options: () => ({ background: true, half: true }), exe: () => exe, setInterval: () => 1, clearInterval: () => {}, log: (r) => logs.push(r), root: () => shim.pid });

      // Before: what the agent's processes get with no call (and whether they may break away).
      const before = sub('before');
      run(`& '${probe}' breakaway '${before}'; & '${probe}' record '${before}'`);
      await until('baseline', () => fs.existsSync(path.join(before, 'breakaway')) && rows(before).length >= 1);
      const base = rows(before)[0];
      assert.ok(bits(base.mask) > half, 'the baseline is not limited');
      // A long-lived process of the agent, there before the call and after it.
      const [w1, w2, w3] = [sub('w1'), sub('w2'), sub('w3')];
      run(`& '${probe}' watch '${w1}' '${w2}' '${w3}'`);
      await until('long-lived member', () => rows(w1).length >= 1);
      assert.equal(rows(w1)[0].prio, 32768, 'its own priority (ABOVE_NORMAL), not a default');
      const go = (d) => fs.writeFileSync(path.join(d, 'go'), '');

      // The gated PreToolUse: the agent goes in its job and the limits go on; THEN the CLI starts the shell.
      const heavy = sub('heavy');
      const command = `& '${probe}' fork2 '${heavy}'; & '${probe}' hold 4000 '${heavy}'`;
      await j.attachCall('a1', { command }, 'ask-first', 'codex');
      assert.equal(logs.at(-1).action, 'attach', JSON.stringify(logs.at(-1)));
      run(command);
      await until('heavy tree recorded', () => rows(heavy).length >= 3);
      // A light call beside it (same agent): limited, and it completes.
      const light = sub('light');
      run(`& '${probe}' record '${light}'`);
      await until('light call completes', () => rows(light).length >= 1);
      go(w1);
      await until('long-lived member during the call', () => rows(w2).length >= 1);
      for (const r of [...rows(heavy), ...rows(light), ...rows(w2)]) {
        assert.equal(bits(r.mask), half, `pid ${r.pid} on half the processors (mask ${r.mask})`);
        assert.equal(r.prio, 16384, `pid ${r.pid} at BELOW_NORMAL`);
      }
      // The shell is seen while it lives; after its tree is gone the limits come off.
      await j.poll();
      assert.equal(j.agentCallCount('a1'), 1, 'still running (hold)');
      await until('call ends', () => { void j.poll(); return j.agentCallCount('a1') === 0; }, 60_000);
      assert.equal(logs.filter((r) => r.action === 'done').length, 1, JSON.stringify(logs));
      // A process that was in the job all along has its own affinity and priority back.
      go(w2);
      await until('long-lived member after the call', () => rows(w3).length >= 1);
      assert.deepEqual([rows(w3)[0].mask, rows(w3)[0].prio], [rows(w1)[0].mask, rows(w1)[0].prio], 'a member present during the call reads back its own affinity and priority after it');

      // After: the agent's new processes are as they were before, breakaway included.
      const after = sub('after');
      run(`& '${probe}' breakaway '${after}'; & '${probe}' record '${after}'`);
      await until('after', () => fs.existsSync(path.join(after, 'breakaway')) && rows(after).length >= 1);
      const a = rows(after).find((r) => !rows(before).some((b) => b.pid === r.pid)) ?? rows(after)[0];
      assert.equal(a.mask, base.mask, 'affinity as before');
      assert.equal(a.prio, base.prio, 'priority as before');
      assert.equal(fs.readFileSync(path.join(after, 'breakaway'), 'utf8'), fs.readFileSync(path.join(before, 'breakaway'), 'utf8'), 'an explicit breakaway behaves as before');

      // The agent goes: its job is let go.
      await j.agentGone('a1');
      assert.equal(logs.at(-1).action, 'agent-gone');
    } finally {
      j?.dispose();
      if (shim && shim.exitCode === null && shim.signalCode === null) {
        const gone = new Promise((r) => shim.once('exit', r));
        try { shim.stdin.end(); } catch { /* gone */ }
        await gone;
      }
      // The probes that hold are short-lived; wait for the folder to be free.
      for (let i = 0; i < 100; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    }
  });

test('LIVE: a call whose shell is not identified stays limited after its Post while it runs; a detached process started after a call outlives the agent, as with no call',
  { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 180_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-agent2-'));
    const shims = []; let j = null; const held = [];
    try {
      const exe = path.join(dir, 'guppy-heavyjob.exe'); const probe = path.join(dir, 'probe.exe');
      let c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, path.join(__dirname, '..', 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
      fs.writeFileSync(path.join(dir, 'probe.cs'), PROBE);
      c = spawnSync(CSC, ['-nologo', '-O', `-out:${probe}`, path.join(dir, 'probe.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc probe: ${c.stdout}${c.stderr}`);
      fs.writeFileSync(path.join(dir, 'shim.js'), SHIM); fs.writeFileSync(path.join(dir, 'cli.js'), CLI);
      const agent = () => { const bornAt = Date.now(); const s = spawn(process.execPath, [path.join(dir, 'shim.js'), path.join(dir, 'cli.js')], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }); s.bornAt = bornAt; shims.push(s); return s; };
      const run = (s, cmd) => s.stdin.write(`${JSON.stringify({ cmd })}\n`);
      const end = (s) => new Promise((r) => { if (s.exitCode !== null || s.signalCode !== null) r(); else { s.once('exit', r); s.stdin.end(); } });
      const sub = (name) => { const d = path.join(dir, name); fs.mkdirSync(d); return d; };
      const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      const half = C.halfCoreCount(os.cpus().length);
      const bits = (m) => { let n = 0; for (let x = BigInt(m); x; x >>= 1n) n += Number(x & 1n); return n; };
      const logs = []; let root = 0; let nowAt = null;
      j = new C.HeavyJobs({ platform: 'win32', options: () => ({ background: true, half: true }), exe: () => exe, now: () => nowAt ?? Date.now(), setInterval: () => 1, clearInterval: () => {}, log: (r) => logs.push(r), root: () => root });

      // A detached process started with no call ever made: it outlives the agent (the baseline).
      const a0 = agent();
      const d0 = sub('d0');
      run(a0, `& '${probe}' hold 15000 '${d0}'`);
      await until('baseline detached', () => rows(d0).length >= 1);
      held.push(rows(d0)[0].pid);
      await end(a0);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(alive(rows(d0)[0].pid), 'baseline: a process the agent started outlives it');

      const a1 = agent(); root = a1.pid;
      // The agent is up (its CLI runs commands) before the call: what it started earlier is not the call's.
      const up = sub('up');
      run(a1, `& '${probe}' record '${up}'`);
      await until('agent up', () => rows(up).length >= 1);
      // A call whose shell Guppy cannot identify (its command line is not the command), still
      // running after Codex's early Post: held in the limits while it runs.
      const u = sub('u');
      // Its first call begins as the agent starts (the start as early as the agent's own spawn): what
      // its sweep found is the agent, not the call, however new it is.
      nowAt = a1.bornAt;
      await j.attachCall('a1', { command: 'npm run build -- --not-as-run' }, 'unknown-shell', 'codex');
      nowAt = null;
      run(a1, `& '${probe}' hold 3000 '${u}'`);
      await until('unidentified call runs', () => rows(u).length >= 1);
      j.callPost('a1', { command: 'npm run build -- --not-as-run' });
      await j.poll(); await j.poll(); await j.poll();
      assert.equal(j.agentCallCount('a1'), 1, 'held after its Post while it runs');
      assert.equal(bits(rows(u)[0].mask), half); assert.equal(rows(u)[0].prio, 16384);
      try {
        await until('unidentified call ends', () => { void j.poll(); return j.agentCallCount('a1') === 0; }, 60_000);
      } catch (e) {
        const ch = C.serveChannel(exe); // what the jobs hold now, for the failure message
        const r = await ch.request(`call a1-agent ${j.agentCalls.get('a1')?.[0]?.startMs ?? 0} ${Buffer.from('x').toString('base64')}`);
        ch.close();
        const own = require('./tools/own-procs.cjs');
        const rowsNow = own.processTable();
        const late = own.treeOf(rowsNow, rowsNow.find((x) => x.pid === root) ?? { pid: root, created: 0 }).map((x) => `${x.pid}<${x.ppid} ${x.name} ${x.created}`);
        throw new Error(`${e.message}: ${JSON.stringify(r)} ${JSON.stringify(logs.slice(-6))} tree: ${late.join(', ')} start=${j.agentCalls.get('a1')?.[0]?.startMs} a1Spawned=${a1.bornAt}`);
      }
      assert.ok(logs.some((r) => r.action === 'unseen'), JSON.stringify(logs));

      // After the call (no limit on): a detached process the agent starts outlives the agent.
      const d1 = sub('d1');
      run(a1, `& '${probe}' hold 15000 '${d1}'`);
      await until('detached after a call', () => rows(d1).length >= 1);
      held.push(rows(d1)[0].pid);
      assert.ok(bits(rows(d1)[0].mask) > half, 'not limited: no call is live');
      await end(a1);
      await new Promise((r) => setTimeout(r, 500));
      assert.ok(alive(rows(d1)[0].pid), 'a process started after a call outlives the agent, as with no call');
      await j.agentGone('a1');
    } finally {
      j?.dispose();
      for (const s of shims) if (s.exitCode === null && s.signalCode === null) { const g = new Promise((r) => s.once('exit', r)); try { s.stdin.end(); } catch { /* gone */ } await g; }
      // The held probes end by themselves (15 s); wait for them, then for the folder to be free.
      for (const pid of held) for (let i = 0; i < 200; i++) { try { process.kill(pid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 100)); }
      for (let i = 0; i < 100; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    }
  });

test('LIVE: a serve that dies leaves its agent jobs to the next one: it opens them by name, answers for the call and lifts the limits',
  { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 120_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-agent-'));
    let watch = null; let a = null; let ch = null;
    try {
      const exe = path.join(dir, 'guppy-heavyjob.exe'); const probe = path.join(dir, 'probe.exe');
      let c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, path.join(__dirname, '..', 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
      fs.writeFileSync(path.join(dir, 'probe.cs'), PROBE);
      c = spawnSync(CSC, ['-nologo', '-O', `-out:${probe}`, path.join(dir, 'probe.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc probe: ${c.stdout}${c.stderr}`);
      const [w1, w2, w3] = ['w1', 'w2', 'w3'].map((n) => { const d = path.join(dir, n); fs.mkdirSync(d); return d; });
      const go = (d) => fs.writeFileSync(path.join(d, 'go'), '');
      const half = C.halfCoreCount(os.cpus().length);
      const bits = (m) => { let n = 0; for (let x = BigInt(m); x; x >>= 1n) n += Number(x & 1n); return n; };
      watch = spawn(probe, ['watch', w1, w2, w3], { stdio: 'ignore', windowsHide: true });
      await until('agent up', () => rows(w1).length >= 1);

      // Serve A puts the "agent" in its job with the limits on, then dies.
      a = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const first = await new Promise((resolve) => { a.stdout.once('data', (d) => resolve(String(d))); a.stdin.write(`agent t1-agent ${watch.pid} 1 1 ${Date.now()}\n`); });
      assert.equal(JSON.parse(first).ok, true, first);
      assert.equal(JSON.parse(first).kept, true, 'the agent holds its jobs\' names');
      go(w1);
      await until('limited in the job', () => rows(w2).length >= 1);
      assert.ok(bits(rows(w2)[0].mask) <= half, 'limited while serve A lives');
      const gone = new Promise((r) => a.once('exit', r));
      a.kill();
      await gone;

      // Serve B: the call is answered and the limits come off.
      ch = C.serveChannel(exe);
      const call = await ch.request(`call t1-agent ${Date.now()} ${Buffer.from('x', 'utf8').toString('base64')}`);
      assert.equal(call?.ok, true, JSON.stringify(call));
      assert.ok(Number(call.total) >= 1, 'the agent is still in the job it opened again');
      const lift = await ch.request('set t1-agent 0 0');
      assert.deepEqual(lift, { ok: true });
      go(w2);
      await until('after the lift', () => rows(w3).length >= 1);
      assert.ok(bits(rows(w3)[0].mask) > half, 'the limits came off');
      assert.notEqual(rows(w3)[0].prio, 0x4000, 'no longer below normal');
      assert.deepEqual(await ch.request('close t1-agent'), { ok: true });
    } finally {
      ch?.close();
      if (a && a.exitCode === null && a.signalCode === null) { const g = new Promise((r) => a.once('exit', r)); a.kill(); await g; }
      if (watch && watch.exitCode === null && watch.signalCode === null) { const g = new Promise((r) => watch.once('exit', r)); watch.kill(); await g; }
      for (let i = 0; i < 100; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    }
  });

// A stand-in serve: `slow` answers after 4 s (past the request limit), `hang` never answers, `bad`
// answers with a line that is not JSON, anything else answers {"ok":true,"r":<line>}.
const FAKE_SERVE = `
using System;
static class Fake { static void Main() { string l; while ((l = Console.ReadLine()) != null) {
  if (l == "slow") { System.Threading.Thread.Sleep(4000); Console.WriteLine("{\\"ok\\":true,\\"r\\":\\"slow\\"}"); }
  else if (l == "hang") System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);
  else if (l == "bad") Console.WriteLine("not json");
  else Console.WriteLine("{\\"ok\\":true,\\"r\\":\\"" + l + "\\"}");
  Console.Out.Flush(); } } }
`;

test('LIVE: the serve channel answers a slow or unreadable reply with an error, not as a dead helper, and stays in step',
  { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 60_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-chan-'));
    let ch = null;
    try {
      const exe = path.join(dir, 'fake.exe');
      fs.writeFileSync(path.join(dir, 'fake.cs'), FAKE_SERVE);
      const c = spawnSync(CSC, ['-nologo', `-out:${exe}`, path.join(dir, 'fake.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
      ch = C.serveChannel(exe);
      assert.deepEqual(await ch.request('slow'), { ok: false, error: 'no reply in time' });
      assert.deepEqual(await ch.request('bad'), { ok: false, error: 'unreadable reply' });
      assert.deepEqual(await ch.request('x'), { ok: true, r: 'x' }, 'the late reply took its own place');
    } finally {
      ch?.close();
      for (let i = 0; i < 100; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    }
  });

test('LIVE: a serve that stops answering is hung after two requests in a row: it is ended and answers as a dead helper, so the next request starts a new one',
  { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 60_000 },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-chan-'));
    let ch = null;
    try {
      const exe = path.join(dir, 'fake.exe');
      fs.writeFileSync(path.join(dir, 'fake.cs'), FAKE_SERVE);
      const c = spawnSync(CSC, ['-nologo', `-out:${exe}`, path.join(dir, 'fake.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
      ch = C.serveChannel(exe);
      assert.deepEqual(await ch.request('slow'), { ok: false, error: 'no reply in time' });
      assert.deepEqual(await ch.request('x'), { ok: true, r: 'x' }, 'answered: the count of silences starts again');
      assert.deepEqual(await ch.request('hang'), { ok: false, error: 'no reply in time' }, 'one silence is a slow helper');
      assert.equal(await ch.request('y'), null, 'the second in a row: hung, answered as dead');
      assert.equal(await ch.request('z'), null);
      // Ended: its .exe is no longer in use.
      await until('the hung serve ended', () => { try { fs.unlinkSync(exe); return true; } catch { return false; } }, 10_000);
    } finally {
      ch?.close();
      for (let i = 0; i < 100; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    }
  });
