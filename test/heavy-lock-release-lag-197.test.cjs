'use strict';
require('./tools/own-job.cjs');
/**
 * HEAVY-LOCK-RELEASE-LAG-197: the heavy lock is freed within about a second of the wrapped job
 * exiting, on every exit path (success, a failed gate, a kill, a crash), from the job's own exit
 * notice and not on the watcher's next scan. Measured before (hive log.jsonl, Guppy 1.1.95): a ~1 s
 * command held the slot 40.9 s (17:38:11.892 to 17:38:52.794Z, 2026-10-19), and a cut that exited
 * at 18:05:29Z was freed at 18:06:02.981Z: the watcher frees a background holder only on its second
 * clean scan (HEAVY_SCAN_MS 20 s x HEAVY_SCAN_MISSES 2).
 *
 * How: every heavy call already runs in a Job Object the helper (`guppy-heavyjob serve`) made. The
 * helper ties each job to one completion port and writes an unsolicited exit line when a process of
 * the job exits or the job goes empty. HeavyJobs checks the job once HEAVY_JOB_EXIT_CONFIRM_MS after
 * the last notice of a burst; nothing of the call left tells the lock, which frees the slot when
 * EVERY heavy call of the holder ran in a held job and all have exited. Anything else (an unwrapped
 * call, a lease, a job the helper did not make, a lost notice) is left to the watcher, unchanged.
 *
 * The LIVE tests compile the helper Guppy ships (in-box csc) and run real jobs: each must see the
 * slot freed less than 2 s after the job's shell exits. On the code before this card none is freed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeDir } = require('./tools/test-temp.cjs');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { gitBash, findGitBash, candidates } = require('./tools/git-bash.cjs');

const root = path.join(__dirname, '..');
const CPU_FILE = 'src/main/heavyCpu.ts';
const LOCK_FILE = 'src/main/heavyJob.ts';
const C = loadTs(CPU_FILE);
const HJ = loadTs(LOCK_FILE);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const BENCH = { heavy: true, kind: 'bench' };
const AGENT = 'agent-a';

// ─── fakes ──────────────────────────────────────────────────────────────────────────────────

/** A clock with timers that run only when the test moves it. */
function fakeClock(start = 1_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
  };
}

/** The helper's serve channel: `rows(id)` answers a list (null: the request failed). */
function fakeChannel(rows, createOk = true) {
  let listener = null;
  const reqs = [];
  return {
    reqs,
    lists: () => reqs.filter((l) => l.startsWith('list ')).length,
    emit: (e) => listener && listener(e),
    ch: {
      async request(line) {
        reqs.push(line);
        const [cmd, id] = line.split(' ');
        if (cmd === 'create') return { ok: createOk };
        if (cmd === 'list') { const r = rows(id); return r ? { ok: true, rows: r } : null; }
        return { ok: true };
      },
      close() {},
      onEvent(fn) { listener = fn; }
    }
  };
}

/** HeavyJobs as main builds it, on the fakes; `told` collects what the lock would be told. */
async function jobsRig(Cm, rowsFn, o = {}) {
  const clock = fakeClock();
  const f = fakeChannel((id) => rowsFn(id, clock), o.createOk !== false);
  const told = [];
  const jobs = new Cm.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => 'guppy-heavyjob.exe',
    channel: () => f.ch, now: clock.now, setInterval: () => 1, clearInterval: () => {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: () => {},
    onJob: (e) => told.push(e)
  });
  await jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-1');
  return { clock, f, told, jobs, id: jobs.ids()[0], start: clock.now() };
}
const exits = (told) => told.filter((e) => e.state === 'exited');

/** The lock as main builds it, with no process probe (only the job notices can free it). */
function lockRig(HJm) {
  const rows = [];
  const lock = new HJm.HeavyJobLock({ limit: () => 1, log: (r) => rows.push(r), setTimer: () => 1, clearTimer: () => {} });
  return { lock, rows, held: () => lock.snapshot().length > 0, released: () => rows.filter((r) => r.action === 'release') };
}

// ─── the guarantees (each a killer for the census) ──────────────────────────────────────────

const K = {
  async notice(Cm) {
    const r = await jobsRig(Cm, () => []);
    r.f.emit({ event: 'exit', job: r.id, msg: 7, pid: 1 });
    await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS - 1);
    assert.equal(exits(r.told).length, 0, 'NO JOB IS CALLED OVER BEFORE THE CONFIRM (a shell starts its next process right after the join line)');
    await r.clock.tick(1);
    assert.equal(exits(r.told).length, 1, 'AN EXIT NOTICE ENDS THE JOB WITHIN THE CONFIRM');
    assert.deepEqual(exits(r.told)[0], { agentId: AGENT, callId: 'call-1', job: r.id, state: 'exited' }, 'THE LOCK IS TOLD THE CALL THE JOB WAS MADE FOR');
  },
  async stillRunning(Cm) {
    const r = await jobsRig(Cm, (id, clock) => [{ pid: 9, name: 'node.exe', createdMs: clock.now() - 10 }]);
    r.f.emit({ event: 'exit', job: r.id, msg: 7, pid: 1 });
    await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
    assert.equal(r.f.lists(), 1, 'the confirm lists the job');
    assert.equal(exits(r.told).length, 0, 'A JOB WITH A PROCESS OF ITS CALL LEFT IS NOT OVER');
  },
  async oldShell(Cm) {
    let start = 0;
    const r = await jobsRig(Cm, () => [{ pid: 9, name: 'bash.exe', createdMs: start - 60_000 }]);
    start = r.start;
    r.f.emit({ event: 'exit', job: r.id, msg: 7, pid: 1 });
    await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
    assert.equal(exits(r.told).length, 1, 'A SHELL FROM BEFORE THE CALL IS NOT THE CALL: its job is over');
  },
  async burst(Cm) {
    const r = await jobsRig(Cm, () => []);
    r.f.emit({ event: 'exit', job: r.id, msg: 7, pid: 1 });
    await r.clock.tick(300);
    r.f.emit({ event: 'exit', job: r.id, msg: 7, pid: 2 });
    await r.clock.tick(300);
    assert.equal(r.f.lists(), 0, 'A BURST OF NOTICES IS CHECKED ONCE, AFTER THE LAST (a newer notice restarts the confirm)');
    await r.clock.tick(100);
    assert.equal(r.f.lists(), 1, 'A BURST OF NOTICES IS CHECKED ONCE, AFTER THE LAST');
    assert.equal(exits(r.told).length, 1);
  },
  async failedList(Cm) {
    const r = await jobsRig(Cm, () => null);
    r.f.emit({ event: 'exit', job: r.id, msg: 7, pid: 1 });
    await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
    assert.equal(exits(r.told).length, 0, 'A FAILED LIST SAYS NOTHING: the job is not called over');
  },
  async once(Cm) {
    const r = await jobsRig(Cm, () => []);
    r.f.emit({ event: 'exit', job: r.id, msg: 7, pid: 1 });
    await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
    r.f.emit({ event: 'exit', job: r.id, msg: 4, pid: 0 });
    await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
    await r.jobs.poll(); await r.jobs.poll();
    assert.equal(exits(r.told).length, 1, 'EXITED IS TOLD ONCE PER JOB');
  },
  async otherJob(Cm) {
    const r = await jobsRig(Cm, () => []);
    r.f.emit({ event: 'exit', job: 'someone-else', msg: 7, pid: 1 });
    r.f.emit({ event: 'start', job: r.id });
    await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
    assert.equal(r.f.lists(), 0, 'ONLY AN EXIT NOTICE OF A TRACKED JOB IS CHECKED');
  },
  async poll(Cm) {
    let rows = [];
    const r = await jobsRig(Cm, () => rows);
    rows = [{ pid: 9, name: 'node.exe', createdMs: r.start + 5 }];
    await r.jobs.poll();
    rows = [];
    await r.jobs.poll(); await r.jobs.poll();
    assert.equal(exits(r.told).length, 1, 'THE POLL STILL ENDS A JOB NO NOTICE REACHED (Windows does not promise the notices)');
  },
  async held(Cm) {
    const r = await jobsRig(Cm, () => []);
    assert.deepEqual(r.told, [{ agentId: AGENT, callId: 'call-1', job: r.id, state: 'held' }], 'A HELD JOB IS TOLD TO THE LOCK WITH ITS CALL');
    const n = await jobsRig(Cm, () => [], { createOk: false });
    assert.deepEqual(n.told, [], 'A JOB THE HELPER DID NOT MAKE IS NOT TOLD (no notice can come for it)');
  },
  lockFrees(HJm) {
    const L = lockRig(HJm);
    L.lock.acquire(AGENT, BENCH, 'bash cut.sh', 'call-1', true);
    L.lock.noteJob(AGENT, 'call-1', 'job-1');
    L.lock.jobExited(AGENT, 'call-1', 'job-1');
    assert.equal(L.held(), false, 'EVERY CALL EXITED FREES THE SLOT AT ONCE');
    assert.equal(L.released()[0].reason, 'job-exit', 'the release names the job exit');
  },
  lockUnwrapped(HJm) {
    const L = lockRig(HJm);
    L.lock.acquire(AGENT, BENCH, 'bash cut.sh', 'call-1', true);
    L.lock.noteJob(AGENT, 'call-1', 'job-1');
    L.lock.acquire(AGENT, BENCH, 'npm ci', 'call-2', true);   // re-entry, never wrapped
    L.lock.jobExited(AGENT, 'call-1', 'job-1');
    assert.equal(L.held(), true, 'A CALL WITHOUT A HELD JOB LEAVES THE SLOT TO THE WATCHER');
  },
  lockSecond(HJm) {
    const L = lockRig(HJm);
    L.lock.acquire(AGENT, BENCH, 'bash cut.sh', 'call-1', true);
    L.lock.noteJob(AGENT, 'call-1', 'job-1');
    L.lock.acquire(AGENT, BENCH, 'npm ci', 'call-2', false);
    L.lock.noteJob(AGENT, 'call-2', 'job-2');
    L.lock.jobExited(AGENT, 'call-1', 'job-1');
    assert.equal(L.held(), true, 'A CALL STILL RUNNING IN ITS JOB KEEPS THE SLOT');
    L.lock.jobExited(AGENT, 'call-2', 'job-2');
    assert.equal(L.held(), false, 'the last job out frees it');
  },
  lockSameCall(HJm) {
    // Jim MUST 1: with no tool_use_id the callId is 'cmd:<command>', so the same heavy command run twice
    // (a background npm test, then again in the foreground) is two windows and two jobs under ONE callId.
    const CALL = 'cmd:npm test';
    const L = lockRig(HJm);
    L.lock.acquire(AGENT, BENCH, 'npm test', CALL, true);
    L.lock.noteJob(AGENT, CALL, 'job-a');
    L.lock.acquire(AGENT, BENCH, 'npm test', CALL, false);
    L.lock.noteJob(AGENT, CALL, 'job-b');
    L.lock.jobExited(AGENT, CALL, 'job-a');
    assert.equal(L.held(), true, 'A SECOND JOB OF ONE CALL STILL RUNNING KEEPS THE SLOT');
    L.lock.jobExited(AGENT, CALL, 'job-a');
    assert.equal(L.held(), true, 'A SECOND JOB OF ONE CALL STILL RUNNING KEEPS THE SLOT (a repeated exit of the first)');
    L.lock.jobExited(AGENT, CALL, 'job-b');
    assert.equal(L.held(), false, 'THE LAST JOB OF THE CALL OUT FREES THE SLOT');
    assert.equal(L.released()[0].reason, 'job-exit', 'the release names the job exit');
    // The second run's job is not held yet (or never will be): the first job's exit frees nothing.
    const M = lockRig(HJm);
    M.lock.acquire(AGENT, BENCH, 'npm test', CALL, true);
    M.lock.noteJob(AGENT, CALL, 'job-a');
    M.lock.acquire(AGENT, BENCH, 'npm test', CALL, false);
    M.lock.jobExited(AGENT, CALL, 'job-a');
    assert.equal(M.held(), true, 'A SECOND RUN OF ONE CALL WITHOUT ITS OWN HELD JOB KEEPS THE SLOT');
  },
  lockStrange(HJm) {
    const L = lockRig(HJm);
    L.lock.acquire(AGENT, BENCH, 'bash cut.sh', 'call-1', true);
    L.lock.jobExited(AGENT, 'call-1', 'job-1');
    assert.equal(L.held(), true, 'AN EXIT FOR A CALL WITH NO HELD JOB FREES NOTHING');
    // A job noted for a call the holder never took must not stand in for that call's own job later.
    L.lock.noteJob(AGENT, 'call-9', 'job-9');
    L.lock.jobExited(AGENT, 'call-9', 'job-9');
    L.lock.acquire(AGENT, BENCH, 'npm ci', 'call-9', true);   // now taken; its own job is not held
    L.lock.noteJob(AGENT, 'call-1', 'job-1');
    L.lock.jobExited(AGENT, 'call-1', 'job-1');
    assert.equal(L.held(), true, "ANOTHER CALL'S JOB IS NOT THIS HOLDER'S: a job noted before its call was taken frees nothing");
  },
  wiring() {
    const hooks = read('src/main/hooks.ts');
    const index = read('src/main/index.ts');
    assert.ok(hooks.includes('begin(wrap.agentId, wrap.toolInput, wrap.cmd, wrap.callId)'), 'THE WRAP CARRIES THE CALL ID TO THE JOB');
    assert.ok(/this\.heavyWrap = \{[^}]*callId \}/.test(hooks), 'THE WRAP CARRIES THE CALL ID TO THE JOB (the PreToolUse call id)');
    assert.ok(index.includes("onJob: (e) => { if (e.state === 'held') heavyLock.noteJob(e.agentId, e.callId, e.job); else heavyLock.jobExited(e.agentId, e.callId, e.job); }"), 'MAIN TELLS THE LOCK EVERY HELD AND EXITED JOB');
  },
  helper() {
    const cs = read('resources/heavyjob/guppy-heavyjob.cs');
    assert.ok(cs.includes('keys[w[1]] = Watch(port, job, w[1], ref next);'), 'EVERY JOB SERVE MAKES IS TIED TO THE PORT');
    assert.ok(cs.includes('WatchMembers(job, w[1], memberWatch);'), 'EVERY JOB SERVE MAKES HAS A MEMBER WATCHER (the port may never report)');
    assert.ok(/msg != MSG_EXIT_PROCESS && msg != MSG_ABNORMAL_EXIT_PROCESS && msg != MSG_ACTIVE_PROCESS_ZERO/.test(cs), 'A CRASH (ABNORMAL EXIT) AND AN EMPTY JOB ARE NOTICES TOO');
    assert.ok(cs.includes('Write(reply);') && !/Console\.Out\.WriteLine\(reply\)/.test(cs), 'REPLIES AND NOTICES SHARE ONE WRITER (a notice never lands inside a reply)');
  }
};

for (const [name, k] of Object.entries(K)) {
  test(`guarantee: ${name}`, async () => { await k(name.startsWith('lock') ? HJ : C); });
}

// ─── LIVE: the real helper, real jobs, the real lock ────────────────────────────────────────

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const LIVE_SKIP = process.platform !== 'win32' ? 'Windows only (Job Objects)' : !fs.existsSync(CSC) ? 'no in-box csc' : false;
let helperExe = null;
const helperDirs = [];
// Removed once every test is done: a helper's serve process may still be exiting after its test.
test.after(async () => { for (const d of helperDirs) await removeDir(d); });
function helper(t, src) {
  if (!src && helperExe) return helperExe;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hlr197-'));
  helperDirs.push(dir);
  const exe = path.join(dir, 'guppy-heavyjob.exe');
  const cs = path.join(dir, 'guppy-heavyjob.cs');
  fs.writeFileSync(cs, src ?? fs.readFileSync(path.join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')));
  const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, cs], { encoding: 'utf8', windowsHide: true });
  assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
  if (!src) helperExe = exe;
  return exe;
}

/** A deterministic helper mutant: `create` succeeds, but its completion-port association returns no
 * key, so no PortLoop exit event can reach HeavyJobs. The release assertion below therefore judges
 * the event/fallback path, not scheduling or a synthetic clock. */
function helperSource() {
  return fs.readFileSync(path.join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs'), 'utf8').replace(/\r\n/g, '\n');
}

function noPortNoticesHelperSource(source = helperSource()) {
  const needle = '    static long Watch(IntPtr port, IntPtr job, string id, ref long next)\n    {';
  assert.ok(source.includes(needle), 'the helper still has the completion-port Watch seam');
  return source.replace(needle, `${needle}\n        return 0; // test mutant: suppress every completion-port notice`);
}

function goneOnOpenHelperSource(source = helperSource()) {
  const needle = `                            IntPtr h = OpenProcess(SYNCHRONIZE, false, pid);
                            if (h == IntPtr.Zero)
                            {
                                int err = Marshal.GetLastWin32Error();`;
  assert.ok(source.includes(needle), 'the helper still has the open-member race seam');
  return source.replace(needle, `                            IntPtr h = IntPtr.Zero; // test mutant: the process vanished before OpenProcess
                            if (h == IntPtr.Zero)
                            {
                                int err = ERROR_INVALID_PARAMETER;`);
}

/** One heavy call held by the real lock in a real job; `body` is the bash after the join line, or
 *  `kill` ends the shell's tree from outside. Resolves with the ms from the shell's exit to the release. */
async function liveRelease(t, o) {
  const Cm = o.C ?? C;
  const exe = o.exe ?? helper(t);
  const rows = [];
  const lock = new HJ.HeavyJobLock({ limit: () => 1, log: (r) => rows.push({ ...r, ts: Date.now() }) });
  const jobs = new Cm.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => exe, log: (r) => rows.push({ ...r, ts: Date.now() }),
    onJob: (e) => { if (e.state === 'held') lock.noteJob(e.agentId, e.callId, e.job); else lock.jobExited(e.agentId, e.callId, e.job); }
  });
  t.after(() => jobs.dispose());
  assert.equal(lock.acquire(AGENT, BENCH, 'bash cut.sh', 'call-1', true).acquired, true);
  const wrapped = await jobs.begin(AGENT, { command: o.body }, false, 'call-1');
  assert.ok(wrapped, 'the call is wrapped');
  const id = jobs.ids()[0];
  // INT 1.1.102: cap-199's join writes its shell marker under LOCALAPPDATA; give it a folder of this
  // file's own, removed with the helpers (it was a TEMP LEAK, "Munder Difflin", under the runner's jail).
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hlr197-local-'));
  helperDirs.push(local);
  // TEST-BASH-PATH-197: Git Bash by path. A bare `bash` is found only when the suite was started
  // from a Git Bash shell; from PowerShell (a Codex agent) it was `spawn bash ENOENT`.
  const sh = spawn(gitBash(), ['-c', `"${exe.replace(/\\/g, '/')}" join ${id} 0 0; ${o.body}`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LOCALAPPDATA: local } });
  const t0 = Date.now();
  // A kill ends every process of the job (what stopping a background task does to its tree; a tree
  // kill from the Git Bash launcher alone misses the MSYS children, which then keep the job running).
  // FLAKE-LAG197-NOPORT-KILL-NOT-ENDED-108: the kill never blocks this process, and every taskkill
  // starts at once. It was one spawnSync after another, so this process could not see the shell's
  // exit until the last taskkill returned, and runMs measured the kill tool under load, not the job.
  const kills = [];
  if (o.kill) {
    setTimeout(() => {
      let out = '';
      const l = spawn(exe, ['list', id], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      l.stdout.on('data', (d) => { out += d; });
      l.on('error', () => { /* no list: no kill, and the cell's exit-code check says so */ });
      l.on('close', () => {
        for (const line of out.split(/\r?\n/).filter(Boolean)) {
          let pid;
          try { pid = JSON.parse(line).pid; } catch { continue; }
          const k = { pid, startedAt: Date.now(), endedAt: null };
          kills.push(k);
          const go = () => {
            const tk = spawn('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
            tk.on('error', () => { k.endedAt = Date.now(); });
            tk.on('exit', () => { k.endedAt = Date.now(); });
          };
          // o.slowKill: the kill tool takes this long per process, as taskkill does on a loaded machine
          if (o.slowKill) setTimeout(go, o.slowKill); else go();
        }
      });
    }, o.kill);
  }
  const exit = await new Promise((r) => sh.on('exit', (code, signal) => r({ at: Date.now(), code, signal })));
  const exitAt = exit.at;
  const deadline = exitAt + 6_000;
  while (lock.snapshot().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const rel = rows.find((r) => r.kind === 'heavy-lock' && r.action === 'release');
  return { lagMs: rel ? rel.ts - exitAt : null, runMs: exitAt - t0, heldMs: rel ? rel.heldMs : null, reason: rel ? rel.reason : null, rows, code: exit.code, signal: exit.signal, kills };
}

// What this process reads from a Git Bash shell that taskkill /F ended: exit code 1, no signal.
// MEASURED on this file's own kill cells (see the card), not assumed. `sleep 30` that runs out on
// its own ends the shell with 0.
const KILLED_EXIT = 1;

/** The shell ended BECAUSE it was killed: the fact `runMs < 10 s` stood in for. */
function assertKilled(r, what) {
  assert.ok(r.kills.length > 0, `${what}: THE JOB LISTED ITS PROCESSES AND EACH WAS KILLED (none listed)`);
  assert.equal(r.signal, null, `${what}: the shell's exit carries no signal`);
  assert.equal(r.code, KILLED_EXIT, `${what}: THE KILL ENDED THE JOB (exit code ${r.code}; a killed shell reports ${KILLED_EXIT}, one that ran out on its own reports 0)`);
}

function assertFreed(r, what) {
  assert.ok(r.lagMs !== null, `${what}: THE SLOT IS FREED WITHIN 2 S OF THE JOB'S EXIT (not freed 6 s after it)`);
  assert.ok(r.lagMs >= 0, `${what}: THE SLOT IS NOT RELEASED BEFORE THE JOB EXITS (released ${r.lagMs} ms before it)`);
  assert.ok(r.lagMs < 2_000, `${what}: THE SLOT IS FREED WITHIN 2 S OF THE JOB'S EXIT (freed ${r.lagMs} ms after)`);
  assert.equal(r.reason, 'job-exit');
}

/** The member watcher's last line: it counts the handles it opened and the ones CloseHandle closed.
 *  Exact counts of its own handles, not the process-wide handle count (other threads move that). */
function assertHandlesClosed(row, what, atLeast = 1) {
  assert.ok(row, `${what}: THE MEMBER WATCHER REPORTS ITS HANDLES WHEN IT ENDS (no closed row)`);
  assert.ok(Number.isInteger(row.opened) && row.opened >= atLeast, `${what}: the member watcher retained a handle (opened ${row.opened})`);
  assert.equal(row.closed, row.opened, `${what}: EVERY RETAINED MEMBER HANDLE IS CLOSED (opened ${row.opened}, closed ${row.closed})`);
}
function assertWatcherClosed(r, what, atLeast = 1) {
  assertHandlesClosed(r.rows.find((x) => x.kind === 'heavy-cpu' && x.action === 'watch' && x.what === 'closed'), what, atLeast);
}

/** The helper's serve mode driven directly: a job is closed while its members still run (what the
 *  scan does to a job it lifts with other processes left in it). Resolves with the watcher's last line. */
async function closeWhileRunning(t, exe) {
  const id = `hlr197c${process.pid}x${Date.now()}`;
  const serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const lines = [];
  let buf = '';
  serve.stdout.on('data', (d) => {
    buf += d;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { try { lines.push(JSON.parse(buf.slice(0, i))); } catch { /* not a line of ours */ } buf = buf.slice(i + 1); }
  });
  const members = () => String(spawnSync(exe, ['list', id], { encoding: 'utf8', windowsHide: true }).stdout).split(/\r?\n/).filter(Boolean);
  const until = async (find, ms, what) => {
    for (const end = Date.now() + ms; ;) {
      const hit = find();
      if (hit) return hit;
      assert.ok(Date.now() < end, what);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  let sh = null;
  t.after(() => { try { serve.kill(); } catch { /* gone */ } try { sh?.kill(); } catch { /* gone */ } });
  serve.stdin.write(`create ${id} 0 0\n`);
  await until(() => lines.find((x) => x.ok === true), 10_000, 'the helper made the job');
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hlr197-local-'));
  helperDirs.push(local);
  sh = spawn(gitBash(), ['-c', `"${exe.replace(/\\/g, '/')}" join ${id} 0 0; sleep 30`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LOCALAPPDATA: local } });
  const gone = new Promise((r) => sh.on('exit', r));
  await until(() => members().length > 0, 10_000, 'the shell joined the job');
  // The watcher snapshots every 25 ms while the job is empty: it holds the members' handles by now.
  await new Promise((r) => setTimeout(r, 500));
  serve.stdin.write(`close ${id}\n`);
  const row = await until(() => lines.find((x) => x.event === 'watch' && x.action === 'closed'), 10_000, 'THE MEMBER WATCHER REPORTS ITS HANDLES WHEN IT ENDS (no closed line after the close)');
  for (const line of members()) { try { spawnSync('taskkill', ['/F', '/PID', String(JSON.parse(line).pid)], { windowsHide: true }); } catch { /* gone already */ } }
  await gone;
  return row;
}

/** A member the watcher's first snapshot cannot hold: a detached node started 1 s in, with a console
 *  of its own, that runs 3 s more. (A plain `sleep 3 &` shares the shell's console host, which is in
 *  the first snapshot and lives as long as the sleep does: the re-query would never be needed.) */
const LATE_MEMBER_BODY = `sleep 1; node -e "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{detached:true,stdio:'ignore',windowsHide:true}).unref()"`;
/** The shell exits at ~1 s, the late member ~3 s after that. */
function assertLateMember(r) {
  assert.ok(r.lagMs === null || r.lagMs >= 1_500, `A MEMBER THAT JOINED AFTER THE SNAPSHOT KEEPS THE SLOT (freed ${r.lagMs} ms after the shell, the member runs 3 s more)`);
  assert.ok(r.lagMs !== null && r.lagMs < 5_000, `THE SLOT IS FREED WITHIN 2 S OF THE LATE MEMBER'S EXIT (${r.lagMs === null ? 'not freed 6 s after the shell' : `freed ${r.lagMs} ms after the shell`}, the member ends 3 s after it)`);
  assert.equal(r.reason, 'job-exit');
}

/** The helper with no member watcher: only the completion port reports exits. */
function noMemberWatchHelperSource(source = helperSource()) {
  const needle = '                        WatchMembers(job, w[1], memberWatch);\n';
  assert.equal(source.split(needle).length - 1, 1, 'the helper still starts one member watcher per job');
  return source.replace(needle, '');
}

test('LIVE: a job that succeeds frees the slot within 2 s of its exit', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: 'sleep 1; exit 0' });
  t.diagnostic(`success: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit`);
  assertFreed(r, 'success');
});

test('LIVE: a failed gate (exit 1) frees the slot within 2 s', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: 'sleep 1; node -e "process.exit(1)"; exit 1' });
  t.diagnostic(`gate failure: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit`);
  assertFreed(r, 'gate failure');
});

test('LIVE: a killed job (every process of it ended from outside) frees the slot within 2 s', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: 'sleep 30', kill: 1_500 });
  t.diagnostic(`kill: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit; shell exit code ${r.code}, signal ${r.signal}, ${r.kills.length} killed`);
  assertKilled(r, 'kill');
  assertFreed(r, 'kill');
});

test('LIVE: a killed job frees the slot when completion-port notices are absent', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: 'sleep 30', kill: 1_500, exe: helper(t, noPortNoticesHelperSource()) });
  t.diagnostic(`no-port kill: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit; shell exit code ${r.code}, signal ${r.signal}, ${r.kills.length} killed`);
  assertKilled(r, 'no-port kill');
  assertFreed(r, 'no-port kill');
  assertWatcherClosed(r, 'no-port kill');
});

// FLAKE-LAG197-NOPORT-KILL-NOT-ENDED-108: under full-suite load the no-port kill "ran 10066 ms" and
// was read as a job the kill did not end, although the slot was freed 640 ms after the exit. The
// run time measured the kill TOOL (one taskkill after another, each blocking this process), not the
// job. Here the tool is slow on purpose: the job is still killed, and the slot is still freed.
test('LIVE: a kill tool that is slow under load is not read as a job the kill did not end', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: 'sleep 30', kill: 1_500, slowKill: 6_000 });
  t.diagnostic(`slow kill: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit; shell exit code ${r.code}, signal ${r.signal}, ${r.kills.length} killed`);
  assertKilled(r, 'slow kill');
  // the kills run together: every one had started before the first one ended
  const firstEnd = Math.min(...r.kills.map((k) => k.endedAt ?? Infinity));
  assert.ok(r.kills.every((k) => k.startedAt <= firstEnd), `THE KILLS RUN TOGETHER, not one after another: ${JSON.stringify(r.kills)}`);
  assertFreed(r, 'slow kill');
});

test('the killed check fails a shell that ran out on its own, and one nothing was killed in', () => {
  const kills = [{ pid: 1, startedAt: 1, endedAt: 2 }];
  assert.doesNotThrow(() => assertKilled({ code: KILLED_EXIT, signal: null, kills }, 'x'));
  assert.throws(() => assertKilled({ code: 0, signal: null, kills }, 'x'), /THE KILL ENDED THE JOB \(exit code 0/);
  assert.throws(() => assertKilled({ code: KILLED_EXIT, signal: null, kills: [] }, 'x'), /none listed/);
  assert.throws(() => assertKilled({ code: null, signal: 'SIGTERM', kills }, 'x'), /no signal/);
});

test('LIVE: a member that joins after a snapshot keeps the slot until its own exit', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: LATE_MEMBER_BODY, exe: helper(t, noPortNoticesHelperSource()) });
  t.diagnostic(`late member: shell ran ${r.runMs} ms, slot freed ${r.lagMs} ms after the shell exit`);
  assertLateMember(r);
  assertWatcherClosed(r, 'late member');
});

test('LIVE: the completion port alone still frees the slot within 2 s (no member watcher)', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: 'sleep 1; exit 0', exe: helper(t, noMemberWatchHelperSource()) });
  t.diagnostic(`port only: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit`);
  assertFreed(r, 'port only');
});

test('LIVE: member watcher returns every handle to baseline across runs', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const exe = helper(t, noPortNoticesHelperSource());
  for (let i = 0; i < 3; i++) {
    const r = await liveRelease(t, { body: 'sleep 1; exit 0', exe });
    assertFreed(r, `handle run ${i + 1}`);
    assertWatcherClosed(r, `handle run ${i + 1}`);
  }
});

test('LIVE: a member that exits before OpenProcess does not stall the watcher', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const source = noPortNoticesHelperSource(goneOnOpenHelperSource());
  const r = await liveRelease(t, { body: 'sleep 1; exit 0', exe: helper(t, source) });
  assertFreed(r, 'open PID-gone race');
  assertWatcherClosed(r, 'open PID-gone race', 0); // no open succeeds here: nothing retained, nothing to close
});

test('LIVE: a job closed while its members still run closes every retained handle', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const row = await closeWhileRunning(t, helper(t));
  t.diagnostic(`closed early: opened ${row.opened}, closed ${row.closed}`);
  assertHandlesClosed(row, 'closed early');
});

test('LIVE: a crash (an abnormal exit inside the job) frees the slot within 2 s', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const r = await liveRelease(t, { body: 'sleep 1; node -e "process.abort()"; exit 134' });
  t.diagnostic(`crash: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit`);
  assertFreed(r, 'crash');
});

test('LIVE: a job still running keeps the slot (a sequential command after the first exit)', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  // The first node exits at ~0.3 s (a notice); the job then runs a second for 2 s more.
  const r = await liveRelease(t, { body: 'node -e "setTimeout(()=>{},300)"; sleep 2; exit 0' });
  assert.ok(r.heldMs >= r.runMs - 50, `A JOB STILL RUNNING KEEPS THE SLOT (held ${r.heldMs} ms of a ${r.runMs} ms run)`);
  assertFreed(r, 'sequential');
});

// ─── TEST-BASH-PATH-197: the Git Bash locator ────────────────────────────────

const PF = 'C:\\Program Files';
const STD = PF + '\\Git\\bin\\bash.exe';
const only = (...files) => { const set = new Set(files.map((x) => x.toLowerCase())); return (p) => set.has(p.toLowerCase()); };

test('BASH: the LIVE tests take Git Bash by path, never a bare name from PATH', () => {
  const me = fs.readFileSync(__filename, 'utf8');
  assert.doesNotMatch(me, new RegExp('spawn(Sync)?\\(' + "'(ba)?sh'"), 'no spawn of a bare shell name in this file');
  const file = gitBash();
  if (process.platform !== 'win32') return assert.equal(file, 'bash');
  assert.ok(path.win32.isAbsolute(file), file);
  assert.ok(fs.existsSync(file), file);
  // Found with no PATH at all: what a process started from PowerShell has to work with, and less.
  const noPath = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'path'));
  assert.equal(findGitBash({ env: noPath }).file, file);
  // And it is a bash of this filesystem (MSYS), not WSL's.
  const r = spawnSync(file, ['-c', 'uname -o'], { encoding: 'utf8', windowsHide: true, env: { ...noPath, PATH: process.env.SystemRoot + '\\System32' } });
  assert.equal(r.status, 0, String(r.error || r.stderr));
  assert.match(r.stdout, /msys|cygwin/i);
});

test('BASH: probe order is the named variable, the standard installs, beside git.exe, then PATH', () => {
  const env = { CLAUDE_CODE_GIT_BASH_PATH: 'D:\\G\\bin\\bash.exe', ProgramFiles: PF, 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\U\\L', PATH: 'C:\\Windows\\System32;E:\\Git\\cmd;F:\\msys\\usr\\bin' };
  const w = { platform: 'win32', env };
  assert.equal(findGitBash({ ...w, exists: () => true }).file, 'D:\\G\\bin\\bash.exe');
  assert.equal(findGitBash({ ...w, exists: () => true }).why, 'CLAUDE_CODE_GIT_BASH_PATH');
  // A variable that names no file is passed over, not trusted.
  assert.equal(findGitBash({ ...w, exists: only(STD) }).file, STD);
  assert.equal(findGitBash({ ...w, exists: only('C:\\Program Files (x86)\\Git\\bin\\bash.exe') }).file, 'C:\\Program Files (x86)\\Git\\bin\\bash.exe');
  assert.equal(findGitBash({ ...w, exists: only('C:\\U\\L\\Programs\\Git\\bin\\bash.exe') }).file, 'C:\\U\\L\\Programs\\Git\\bin\\bash.exe');
  // Beside git.exe: only where a git.exe is.
  assert.equal(findGitBash({ ...w, exists: only('E:\\Git\\cmd\\git.exe', 'E:\\Git\\bin\\bash.exe') }).file, 'E:\\Git\\bin\\bash.exe');
  assert.equal(findGitBash({ ...w, exists: only('E:\\Git\\bin\\bash.exe') }).file, null, 'a ..\\bin\\bash.exe beside no git.exe is not Git Bash');
  // A bash on PATH: the install's launcher before its usr\bin, and the standard install before both.
  assert.equal(findGitBash({ ...w, exists: only('F:\\msys\\usr\\bin\\bash.exe', 'F:\\msys\\bin\\bash.exe') }).file, 'F:\\msys\\bin\\bash.exe');
  assert.equal(findGitBash({ ...w, exists: only('F:\\msys\\usr\\bin\\bash.exe') }).file, 'F:\\msys\\usr\\bin\\bash.exe');
  assert.equal(findGitBash({ ...w, exists: only('F:\\msys\\usr\\bin\\bash.exe', STD) }).file, STD);
  // Env names are matched as Windows matches them (a spread copy of process.env is case-sensitive).
  assert.equal(findGitBash({ platform: 'win32', env: { PROGRAMFILES: PF, Path: '' }, exists: only(STD) }).file, STD);
  assert.equal(findGitBash({ platform: 'linux', env: {}, exists: () => false }).file, 'bash');
});

test('BASH: the bash of WSL (System32, WindowsApps) is never taken', () => {
  for (const dir of ['C:\\Windows\\System32', 'C:\\WINDOWS\\system32\\', 'C:\\Windows\\Sysnative', 'C:\\U\\AppData\\Local\\Microsoft\\WindowsApps']) {
    const env = { PATH: dir };
    const inDir = (p) => /bash\.exe$/i.test(p) && p.toLowerCase().startsWith(dir.replace(/\\$/, '').toLowerCase() + '\\');
    assert.equal(findGitBash({ platform: 'win32', env, exists: inDir }).file, null, dir);
    assert.ok(!candidates(env).some((c) => /^PATH /.test(c.why)), dir);
  }
});

test('BASH: no Git Bash is a failure that says what was probed, never a skip', () => {
  const env = { ProgramFiles: PF, LOCALAPPDATA: 'C:\\U\\L', PATH: 'C:\\Windows\\System32;C:\\tools' };
  assert.throws(() => gitBash({ platform: 'win32', env, exists: () => false }), (e) => {
    assert.match(e.message, /^Git Bash not found: /);
    assert.match(e.message, /CLAUDE_CODE_GIT_BASH_PATH/);
    assert.ok(e.message.endsWith('Probed (3): C:\\Program Files\\Git\\bin\\bash.exe; C:\\U\\L\\Programs\\Git\\bin\\bash.exe; C:\\tools\\bash.exe'), e.message);
    return true;
  });
  assert.throws(() => gitBash({ platform: 'win32', env: {}, exists: () => false }), /Probed \(0\): nothing: no ProgramFiles, LOCALAPPDATA or PATH/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutatedText(file, edits, tag) {
  let text = read(file);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  { name: 'no confirm: the first notice is checked at once', file: CPU_FILE, edits: [['}, HEAVY_JOB_EXIT_CONFIRM_MS);', '}, 0);']], killer: 'notice', dies: /NO JOB IS CALLED OVER BEFORE THE CONFIRM/ },
  { name: 'a notice does not restart the confirm', file: CPU_FILE, edits: [['    this.cancelConfirm(j);\n    const st =', '    if (j.confirm !== null) return;\n    const st =']], killer: 'burst', dies: /A BURST OF NOTICES IS CHECKED ONCE, AFTER THE LAST/ },
  { name: 'the confirm ignores the processes left', file: CPU_FILE, edits: [['    if (this.own(j, r.rows as HeavyJobRow[]).length) { j.noticeAt = null; return; }\n', '']], killer: 'stillRunning', dies: /A JOB WITH A PROCESS OF ITS CALL LEFT IS NOT OVER/ },
  { name: 'every process in the job is the call', file: CPU_FILE, edits: [['x.createdMs >= j.startMs - HEAVY_JOB_START_SKEW_MS);', 'x.createdMs >= 0);']], killer: 'oldShell', dies: /A SHELL FROM BEFORE THE CALL IS NOT THE CALL/ },
  { name: 'a failed list is an empty job', file: CPU_FILE, edits: [["    if (!r || r.ok !== true || !Array.isArray(r.rows)) return;\n    if (j.confirm !== null", "    if (!r || r.ok !== true || !Array.isArray(r.rows)) { this.exited(j, 'notice'); return; }\n    if (j.confirm !== null"]], killer: 'failedList', dies: /A FAILED LIST SAYS NOTHING/ },
  { name: 'exited is told again', file: CPU_FILE, edits: [['    if (j.exited) return;\n    j.exited = true;', '    j.exited = true;']], killer: 'once', dies: /EXITED IS TOLD ONCE PER JOB/ },
  { name: 'any event line is an exit', file: CPU_FILE, edits: [["    if (e.event !== 'exit' || typeof e.job !== 'string') return;", "    if (typeof e.job !== 'string') return;"]], killer: 'otherJob', dies: /ONLY AN EXIT NOTICE OF A TRACKED JOB IS CHECKED/ },
  { name: 'the poll does not tell the lock', file: CPU_FILE, edits: [["      this.exited(j, 'poll');\n", '']], killer: 'poll', dies: /THE POLL STILL ENDS A JOB NO NOTICE REACHED/ },
  { name: 'a held job is not told', file: CPU_FILE, edits: [["      if (callId) this.tell(agentId, callId, id, 'held');\n", '']], killer: 'held', dies: /A HELD JOB IS TOLD TO THE LOCK/ },
  { name: 'a job the helper did not make is told', file: CPU_FILE, edits: [["      if (callId) this.tell(agentId, callId, id, 'held');\n    }", "    }\n    if (callId) this.tell(agentId, callId, id, 'held');"]], killer: 'held', dies: /A JOB THE HELPER DID NOT MAKE IS NOT TOLD/ },
  { name: 'the exit does not name its call', file: CPU_FILE, edits: [["    if (j.callId) this.tell(j.agentId, j.callId, j.id, 'exited');", "    if (j.callId) this.tell(j.agentId, 'call', j.id, 'exited');"]], killer: 'notice', dies: /THE LOCK IS TOLD THE CALL THE JOB WAS MADE FOR/ },
  { name: 'event lines answer requests', file: CPU_FILE, live: true, edits: [["      if (r && typeof r.event === 'string') { try { onEvent?.(r); } catch { /* a listener never breaks the channel */ } continue; }\n", '']], dies: /THE SLOT IS FREED WITHIN 2 S/ },
  { name: 'the lock frees on the first exited job', file: LOCK_FILE, edits: [['    if (!h.windows.every((w) => this.callJobsExited(h, w.callId))) return;\n', '']], killer: 'lockUnwrapped', dies: /A CALL WITHOUT A HELD JOB LEAVES THE SLOT TO THE WATCHER/ },
  { name: 'an unwrapped call counts as exited', file: LOCK_FILE, edits: [['    if (!js) return false;', '    if (!js) return true;']], killer: 'lockUnwrapped', dies: /A CALL WITHOUT A HELD JOB LEAVES THE SLOT TO THE WATCHER/ },
  { name: 'a job exit is never a release', file: LOCK_FILE, edits: [["    this.release(agentId, 'job-exit');\n", '']], killer: 'lockFrees', dies: /EVERY CALL EXITED FREES THE SLOT AT ONCE/ },
  { name: 'a running job is marked exited when held', file: LOCK_FILE, edits: [['    if (!js.has(job)) js.set(job, false);', '    if (!js.has(job)) js.set(job, true);']], killer: 'lockSecond', dies: /A CALL STILL RUNNING IN ITS JOB KEEPS THE SLOT/ },
  { name: "another call's job is noted", file: LOCK_FILE, edits: [['    if (!h || !h.windows.some((w) => w.callId === callId)) return;\n    const js', '    if (!h) return;\n    const js']], killer: 'lockStrange', dies: /ANOTHER CALL'S JOB IS NOT THIS HOLDER'S/ },
  { name: 'an exit with no held job is taken', file: LOCK_FILE, edits: [['    if (!h || !js || !js.has(job)) return;\n    js.set(job, true);', '    if (!h) return;\n    h.jobs.set(callId, new Map([...(js ?? []), [job, true]]));']], killer: 'lockStrange', dies: /AN EXIT FOR A CALL WITH NO HELD JOB FREES NOTHING/ },
  // Jim MUST 1: keyed by callId again (one job per call), a second job of the same call is never counted.
  { name: 'keyed by call: a second job of one call is not counted', file: LOCK_FILE, edits: [['    if (!js.has(job)) js.set(job, false);', '    if (!js.size) js.set(job, false);']], killer: 'lockSameCall', dies: /THE LAST JOB OF THE CALL OUT FREES THE SLOT/ },
  { name: 'keyed by call: the first job of a call stands for every window of it', file: LOCK_FILE, edits: [['    if (js.size < h.windows.filter((w) => w.callId === callId).length) return false;\n', '']], killer: 'lockSameCall', dies: /A SECOND RUN OF ONE CALL WITHOUT ITS OWN HELD JOB KEEPS THE SLOT/ },
  { name: 'keyed by call: any exited job ends the call', file: LOCK_FILE, edits: [['    return [...js.values()].every((exited) => exited);', '    return [...js.values()].some((exited) => exited);']], killer: 'lockSameCall', dies: /A SECOND JOB OF ONE CALL STILL RUNNING KEEPS THE SLOT/ }
];

// (Dropping MSG_ABNORMAL_EXIT_PROCESS alone is equivalent here: the shell's own exit and the job going
// empty still come after a crash. It stays in the filter for a job whose shell outlives the crash.)
const NO_MEMBER_WATCH = ['                        WatchMembers(job, w[1], memberWatch);\n', ''];
const FREED = /THE SLOT IS FREED WITHIN 2 S OF THE JOB'S EXIT/;
const HELPER_MUTANTS = [
  // The completion port, judged alone: the member watcher is taken out of these two, or it would
  // report the exit the mutant drops.
  { name: 'serve ties no job to the port', edits: [NO_MEMBER_WATCH, ['                        keys[w[1]] = Watch(port, job, w[1], ref next);\n', '']], body: 'sleep 1; exit 0', what: 'success', dies: FREED },
  { name: 'notices are never written', edits: [NO_MEMBER_WATCH, ['out id)) continue;\n            Write("{\\"event\\":\\"exit\\"', 'out id)) continue;\n            if (msg == 0) Write("{\\"event\\":\\"exit\\"']], body: 'sleep 1; exit 0', what: 'success', dies: FREED },
  {
    name: 'the helper suppresses every exit event',
    edits: [['static void Write(string line) { lock', 'static void Write(string line) { if (line.Contains("\\\"event\\\":\\\"exit\\\"")) return; lock']], body: 'sleep 1; exit 0', what: 'success', dies: FREED
  },
  // The member watcher, judged alone (no port notices).
  { name: 'the member watcher never reports an empty job', edits: [['                                Write("{\\"event\\":\\"exit\\",\\"job\\":\\"" + id + "\\",\\"msg\\":4,\\"pid\\":0}");\n', '']], body: 'sleep 30', kill: 1_500, noPort: true, what: 'no-port kill', dies: FREED },
  {
    // It reports the exit once its first snapshot has exited. The lock's confirm then finds the
    // late member and keeps the slot, and no second report ever comes.
    name: 'the member watcher skips its empty-confirm re-query',
    edits: [['                    if (handles.Count != 0) System.Threading.Thread.Sleep(25);', '                    if (handles.Count != 0) System.Threading.Thread.Sleep(25); else { Write("{\\"event\\":\\"exit\\",\\"job\\":\\"" + id + "\\",\\"msg\\":4,\\"pid\\":0}"); return; }']],
    body: LATE_MEMBER_BODY, noPort: true, verify: assertLateMember, dies: /THE SLOT IS FREED WITHIN 2 S OF THE LATE MEMBER'S EXIT/
  },
  {
    name: 'an exited member handle is left open',
    edits: [['{ if (CloseHandle(handles[pid])) closed++; handles.Remove(pid); }', '{ handles.Remove(pid); }']],
    body: 'sleep 1; exit 0', noPort: true, verify: (r) => assertWatcherClosed(r, 'leak'), dies: /EVERY RETAINED MEMBER HANDLE IS CLOSED/
  },
  {
    name: 'the handles still held at the end are left open',
    edits: [['                foreach (var pair in handles) if (CloseHandle(pair.Value)) closed++;\n', '']],
    closeEarly: true, dies: /EVERY RETAINED MEMBER HANDLE IS CLOSED/
  }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', { timeout: 300_000 }, async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, { skip: m.live ? LIVE_SKIP : false }, async (tt) => {
      const M = loadTs.fromText(m.file, mutatedText(m.file, m.edits, m.name));
      await assert.rejects(async () => {
        if (m.live) assertFreed(await liveRelease(tt, { C: M, body: 'sleep 1; exit 0' }), 'mutant');
        else await K[m.killer](M);
      }, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
  // The helper: a mutated copy compiled and run live; the source pins name the same guarantee.
  for (const m of HELPER_MUTANTS) {
    await t.test(`helper mutant: ${m.name}`, { skip: LIVE_SKIP }, async (tt) => {
      let source = mutatedText('resources/heavyjob/guppy-heavyjob.cs', m.edits, m.name);
      if (m.noPort) source = noPortNoticesHelperSource(source);
      const exe = helper(tt, source);
      await assert.rejects(async () => {
        if (m.closeEarly) return assertHandlesClosed(await closeWhileRunning(tt, exe), 'closed early');
        const r = await liveRelease(tt, { exe, body: m.body, kill: m.kill });
        tt.diagnostic(`ran ${r.runMs} ms, ${r.lagMs === null ? 'not freed 6 s after the exit' : `freed ${r.lagMs} ms after the exit`}; ${JSON.stringify(r.rows.filter((x) => x.kind === 'heavy-cpu').map((x) => [x.action, x.what, x.by, x.opened, x.closed]))}`);
        if (m.verify) m.verify(r); else assertFreed(r, m.what);
      }, (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
