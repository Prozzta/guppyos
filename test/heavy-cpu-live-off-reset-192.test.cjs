'use strict';
// @heavy-lock live: it compiles the job helper and holds real processes in real job objects.
/**
 * HEAVY-CPU-LIVE-OFF-RESET-192. A heavy call's job (a per-call job, `create <id>`) whose limits the
 * Human changes in Settings mid-call (`set <id>`): Windows leaves a member where a lifted limit put
 * it, so the helper puts members back. It used to reset EVERY member on EVERY change to NORMAL and
 * the system mask, for each limit that was off after the change, on or not before: a process of the
 * call that had lowered its own priority, or narrowed its own affinity, was widened for good.
 *
 * Now, as for an agent's job: a limit is given back only when it comes OFF (it was on); a member's
 * own values are recorded when a limit comes ON with it already in the job, and given back exactly;
 * any other member goes back to normal.
 *
 * Named mutants, each must fail this file:
 *   G1 the priority is given back with background off, on before or not
 *   G2 the affinity is given back with half off, on before or not
 *   R1 nothing is recorded when a limit comes on   R2 a recorded priority is not given back
 *   R3 a recorded mask is not given back           S1 serve keeps no record for a per-call job
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/heavyCpu.ts');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const NORMAL = 0x20, BELOW_NORMAL = 0x4000, IDLE = 0x40;

// A process of the call: it joins the job by name, then changes its own priority and/or affinity
// (`-` leaves one alone), says `ready`, and ends when its stdin closes.
const PROBE = `
using System;
using System.Runtime.InteropServices;
static class Probe {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint a, bool i, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetPriorityClass(IntPtr h, uint c);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessAffinityMask(IntPtr h, UIntPtr m);
  static int Main(string[] a) {
    IntPtr j = OpenJobObjectW(0x1F001F, false, a[0]);
    if (j == IntPtr.Zero || !AssignProcessToJobObject(j, GetCurrentProcess())) { Console.WriteLine("nojoin " + Marshal.GetLastWin32Error()); return 2; }
    bool ok = true;
    if (a[1] != "-") ok &= SetPriorityClass(GetCurrentProcess(), Convert.ToUInt32(a[1], 16));
    if (a[2] != "-") ok &= SetProcessAffinityMask(GetCurrentProcess(), (UIntPtr)Convert.ToUInt64(a[2], 16));
    Console.WriteLine(ok ? "ready" : "selfset-failed " + Marshal.GetLastWin32Error());
    Console.Out.Flush();
    Console.In.ReadToEnd();
    return 0;
  }
}
`;

const skip = process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false;
const n = Math.min(os.cpus().length, 64);
const FULL = n >= 64 ? (1n << 64n) - 1n : (1n << BigInt(n)) - 1n;
const HALF = (1n << BigInt(C.halfCoreCount(n))) - 1n;

/** One helper serve and the probes of one test; everything ends (stdin closed) and is awaited. */
async function rig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-lor-'));
  const procs = [];
  let ch = null;
  try {
    const exe = path.join(dir, 'guppy-heavyjob.exe'); const probe = path.join(dir, 'probe.exe');
    let c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, path.join(__dirname, '..', 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
    assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
    fs.writeFileSync(path.join(dir, 'probe.cs'), PROBE);
    c = spawnSync(CSC, ['-nologo', '-O', `-out:${probe}`, path.join(dir, 'probe.cs')], { encoding: 'utf8', windowsHide: true });
    assert.equal(c.status, 0, `csc probe: ${c.stdout}${c.stderr}`);
    ch = C.serveChannel(exe);
    const req = async (line) => { const r = await ch.request(line); assert.equal(r?.ok, true, `${line}: ${JSON.stringify(r)}`); return r; };
    /** A probe in job `id` that sets its own priority (hex) and/or mask (hex) once it is in. */
    const member = async (id, prio, mask) => {
      const p = spawn(probe, [`Local\\guppy-heavy-${id}`, prio ?? '-', mask ?? '-'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      procs.push(p);
      const said = await new Promise((resolve) => { let s = ''; p.stdout.on('data', (d) => { s += d; if (s.includes('\n')) resolve(s.trim()); }); p.once('exit', () => resolve(s.trim() || 'exited')); });
      assert.equal(said, 'ready', `probe ${prio}/${mask}: ${said}`);
      return p.pid;
    };
    /** That member's priority class and mask, as the helper lists them. */
    const now = async (id, pid) => {
      const row = (await req(`list ${id}`)).rows.find((r) => r.pid === pid);
      assert.ok(row, `pid ${pid} is in job ${id}`);
      return { prio: row.priorityClass, mask: BigInt(row.mask) };
    };
    await fn({ req, member, now });
  } finally {
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) { const g = new Promise((r) => p.once('exit', r)); try { p.stdin.end(); } catch { /* gone */ } await g; }
    ch?.close();
    for (let i = 0; i < 100; i++) { try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  }
}

test('LIVE: background going off leaves the affinity a member chose for itself (half was never on)', { skip, timeout: 120_000 }, async () => {
  await rig(async ({ req, member, now }) => {
    await req('create lor-a 1 0');
    const pid = await member('lor-a', null, '1');           // narrows itself to one processor
    assert.deepEqual(await now('lor-a', pid), { prio: BELOW_NORMAL, mask: 1n }, 'in the background limit, on one processor of its own');
    await req('set lor-a 0 0');
    assert.deepEqual(await now('lor-a', pid), { prio: NORMAL, mask: 1n }, 'the priority comes back; its own affinity is not widened (G2)');
    await req('close lor-a');
  });
});

test('LIVE: half going off leaves the priority a member chose for itself (background was never on)', { skip, timeout: 120_000 }, async () => {
  await rig(async ({ req, member, now }) => {
    await req('create lor-b 0 1');
    const pid = await member('lor-b', (BELOW_NORMAL).toString(16), null);   // lowers itself
    assert.deepEqual(await now('lor-b', pid), { prio: BELOW_NORMAL, mask: HALF }, 'in the half limit, lowered by itself');
    await req('set lor-b 0 0');
    assert.deepEqual(await now('lor-b', pid), { prio: BELOW_NORMAL, mask: FULL }, 'the affinity comes back; its own priority is not raised (G1)');
    await req('close lor-b');
  });
});

test('LIVE: limits switched on mid-call record a member\'s own values first and give them back exactly when they come off', { skip, timeout: 120_000 }, async () => {
  await rig(async ({ req, member, now }) => {
    await req('create lor-c 0 0');
    const pid = await member('lor-c', IDLE.toString(16), '1');   // idle, on one processor, before any limit
    await req('set lor-c 1 1');
    assert.equal((await now('lor-c', pid)).prio, BELOW_NORMAL, 'the background limit holds it');
    await req('set lor-c 0 0');
    assert.deepEqual(await now('lor-c', pid), { prio: IDLE, mask: 1n }, 'its own values, not NORMAL and the system mask (R1, R2)');
    await req('close lor-c');
  });
});

// The Windows fact the helper relies on: inside the affinity limit a member cannot narrow itself
// (the call succeeds, the job's mask stands), so the limit coming off has only a record to go by.
test('LIVE: inside the half limit a member\'s own narrower mask does not hold: the job\'s mask stands', { skip, timeout: 120_000 }, async () => {
  await rig(async ({ req, member, now }) => {
    await req('create lor-d 0 1');
    const pid = await member('lor-d', null, '1');            // one processor, inside the half mask
    assert.equal((await now('lor-d', pid)).mask, HALF, 'the job\'s mask, not the one it asked for');
    await req('set lor-d 0 0');
    assert.equal((await now('lor-d', pid)).mask, FULL, 'and the system mask when half comes off');
    await req('close lor-d');
  });
});

test('LIVE: a member the limits held (no choice of its own) goes back to normal when they come off', { skip, timeout: 120_000 }, async () => {
  await rig(async ({ req, member, now }) => {
    await req('create lor-e 1 1');
    const pid = await member('lor-e', null, null);
    assert.deepEqual(await now('lor-e', pid), { prio: BELOW_NORMAL, mask: HALF });
    await req('set lor-e 0 1');
    assert.deepEqual(await now('lor-e', pid), { prio: NORMAL, mask: HALF }, 'background off: priority back, half stays');
    await req('set lor-e 0 0');
    assert.deepEqual(await now('lor-e', pid), { prio: NORMAL, mask: FULL }, 'half off: the system mask');
    await req('close lor-e');
  });
});
