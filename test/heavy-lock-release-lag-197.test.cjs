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
  const sh = spawn('bash', ['-c', `"${exe.replace(/\\/g, '/')}" join ${id} 0 0; ${o.body}`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LOCALAPPDATA: local } });
  const t0 = Date.now();
  // A kill ends every process of the job (what stopping a background task does to its tree; a tree
  // kill from the Git Bash launcher alone misses the MSYS children, which then keep the job running).
  if (o.kill) {
    setTimeout(() => {
      const l = spawnSync(exe, ['list', id], { encoding: 'utf8', windowsHide: true });
      for (const line of String(l.stdout).split(/\r?\n/).filter(Boolean)) {
        try { spawnSync('taskkill', ['/F', '/PID', String(JSON.parse(line).pid)], { windowsHide: true }); } catch { /* gone already */ }
      }
    }, o.kill);
  }
  const exitAt = await new Promise((r) => sh.on('exit', () => r(Date.now())));
  const deadline = exitAt + 6_000;
  while (lock.snapshot().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const rel = rows.find((r) => r.kind === 'heavy-lock' && r.action === 'release');
  return { lagMs: rel ? rel.ts - exitAt : null, runMs: exitAt - t0, heldMs: rel ? rel.heldMs : null, reason: rel ? rel.reason : null };
}

function assertFreed(r, what) {
  assert.ok(r.lagMs !== null, `${what}: THE SLOT IS FREED WITHIN 2 S OF THE JOB'S EXIT (not freed 6 s after it)`);
  assert.ok(r.lagMs < 2_000, `${what}: THE SLOT IS FREED WITHIN 2 S OF THE JOB'S EXIT (freed ${r.lagMs} ms after)`);
  assert.equal(r.reason, 'job-exit');
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
  t.diagnostic(`kill: ran ${r.runMs} ms, held ${r.heldMs} ms, freed ${r.lagMs} ms after the exit`);
  assert.ok(r.runMs < 10_000, 'the kill ended the job');
  assertFreed(r, 'kill');
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
const HELPER_MUTANTS = [
  { name: 'serve ties no job to the port', edits: [['                        keys[w[1]] = Watch(port, job, w[1], ref next);\n', '']], body: 'sleep 1; exit 0', what: 'success' },
  { name: 'notices are never written', edits: [['            Write("{\\"event\\":\\"exit\\"', '            if (msg == 0) Write("{\\"event\\":\\"exit\\"']], body: 'sleep 1; exit 0', what: 'success' }
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
      const exe = helper(tt, mutatedText('resources/heavyjob/guppy-heavyjob.cs', m.edits, m.name));
      await assert.rejects(async () => assertFreed(await liveRelease(tt, { exe, body: m.body }), m.what), /THE SLOT IS FREED WITHIN 2 S/);
    });
  }
});
