'use strict';
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
    assert.deepEqual(f.sent.filter((l) => l.startsWith('set ')), ['set a1-agent 1 1', 'set a1-agent 1 1'], 'limits on at each attach (a live change since is applied too)');
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

test('a shell never seen: after the Post it is done if the job had new processes, else a logged attach-missed; with no Post it waits for the unstarted limit', async () => {
  const f = fakeServe(); const now = { t: 100 };
  const { j, logs } = jobs(f, now);
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  f.state[100] = { shell: 0, alive: 0, total: 9 };
  j.callPost('a1', { command: 'npm ci' });
  await j.poll();
  assert.equal(logs.at(-1).action, 'done-unseen', 'ran inside, too briefly to be seen');
  now.t = 200;
  await j.attachCall('a1', { command: 'npm ci' }, 'unknown-shell');
  j.callPost('a1', { command: 'npm ci' });
  await j.poll();
  assert.equal(logs.at(-1).action, 'attach-missed', 'nothing new in the job: it ran outside (e.g. started by a service)');
  now.t = 300;
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  await j.poll();
  assert.equal(j.agentCallCount('a1'), 1, 'not run yet (its user has not approved it)');
  now.t = 300 + C.HEAVY_JOB_UNSTARTED_MS;
  await j.poll();
  assert.equal(logs.at(-1).action, 'never-started');
  assert.equal(j.agentCallCount('a1'), 0);
});

test('the agent going (exit or respawn) lets its job go; an agent with no process logs a failed attach', async () => {
  const f = fakeServe(); const now = { t: 1 };
  const { j, logs } = jobs(f, now);
  await j.agentGone('a1');
  assert.ok(!f.sent.includes('close a1-agent'), 'no job made yet: nothing to close');
  await j.attachCall('a1', { command: 'npm ci' }, 'ask-first');
  await j.agentGone('a1');
  assert.ok(f.sent.includes('close a1-agent'));
  assert.equal(j.agentCallCount('a1'), 0);
  assert.deepEqual(logs.at(-1), { kind: 'heavy-cpu', action: 'agent-gone', agentId: 'a1', job: 'a1-agent', live: 1 });
  await j.attachCall('gone', { command: 'npm ci' }, 'ask-first', 'codex');
  assert.equal(logs.at(-1).action, 'attach-failed');
  assert.ok(!f.sent.some((l) => l.startsWith('agent gone')));
});

test('WIRING: main gives the agent\'s PTY process as its root and lets its job go at PTY exit and at each new spawn', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /root: \(agentId\) => ptyManager\.list\(\)\.filter\(\(s\) => ptyToAgent\.get\(s\.id\) === agentId && s\.pid > 0\)\.at\(-1\)\?\.pid \?\? null/);
  assert.match(idx, /if \(!\[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\)\) void heavyJobs\.agentGone\(agentId\)/, 'at PTY exit');
  assert.match(idx, /if \(res\.ok && opts\.hive\?\.id\) void heavyJobs\.agentGone\(opts\.hive\.id\)/, 'at a new spawn');
  const hooks = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8');
  assert.match(hooks, /this\.heavyJobs\?\.callPost\(agentId, p\.tool_input\)/);
});

// ── LIVE: the real helper and a Codex-shaped agent ─────────────────────────────────────────

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// A probe: `record <dir>` writes "<affinity mask> <priority class>" to <dir>/<pid>; `fork <dir>`
// records, starts `record` and exits at once; `fork2 <dir>` starts `fork` and exits at once (a
// grandchild that forks and is gone in milliseconds); `hold <ms> <dir>` records and waits;
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
      for (const r of [...rows(heavy), ...rows(light)]) {
        assert.equal(bits(r.mask), half, `pid ${r.pid} on half the processors (mask ${r.mask})`);
        assert.equal(r.prio, 16384, `pid ${r.pid} at BELOW_NORMAL`);
      }
      // The shell is seen while it lives; after its tree is gone the limits come off.
      await j.poll();
      assert.equal(j.agentCallCount('a1'), 1, 'still running (hold)');
      await until('call ends', () => { void j.poll(); return j.agentCallCount('a1') === 0; }, 60_000);
      assert.equal(logs.filter((r) => r.action === 'done').length, 1, JSON.stringify(logs));

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
