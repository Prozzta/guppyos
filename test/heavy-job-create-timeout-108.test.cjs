'use strict';
require('./tools/own-job.cjs');
/**
 * HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: under load the helper's `create` came back null after
 * HEAVY_JOB_REQUEST_MS (3 s), the job was never held, and the slot was not freed within 8 s of the
 * job's exit (UHera, HEAVY-LOCK-RELEASE-LAG-197-RECUR-108: 4/6 and 2/6 runs at 64 burners, 1/8 at 32).
 *
 * Measured (quiet, the shipped helper, 8 runs each): create on a WARM helper answers in 0.2-0.3 ms;
 * a COLD helper (spawn to its first answer, the .NET start) takes 40-49 ms. The 3 s budget starts
 * when the request is written, so a cold start counts against it. Under load that start is what
 * passes 3 s. Two things make it recur:
 *   - HeavyJobs.req closes the channel on ANY null, so one slow answer kills a live helper and the
 *     next request pays the cold start again;
 *   - the new helper has no handle for the jobs the old one held: `list` says "no job", the poll
 *     skips them as unknown, and they can never end through HeavyJobs again.
 * A create that lands late does not help either: a job's name lives only while a handle is open, so
 * once the call's join line ran first (and exited), the helper's late create makes a NEW empty job
 * under that name; the call's processes are not in it (probe: list [] while the shell ran).
 *
 * No timeout is changed here. The fake test runs on a fake clock; the LIVE test uses the shipped
 * helper source with one added wait at the start of serve (a cold start of 4 s, past the 3 s budget).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeDir } = require('./tools/test-temp.cjs');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { gitBash } = require('./tools/git-bash.cjs');

const root = path.join(__dirname, '..');
const C = loadTs('src/main/heavyCpu.ts');
const HJ = loadTs('src/main/heavyJob.ts');
const AGENT = 'agent-a';
const BENCH = { heavy: true, kind: 'bench' };

/** One helper as the real one behaves: it knows only the jobs IT created (a `list` of any other is
 *  {ok:false, "no job"}), and it is alive until it is closed. `answer(cmd, id, n)` may return
 *  undefined (the real answer), null (this request timed out) or an answer of its own; n counts
 *  that command on this helper. */
function fakeHelper(answer = () => undefined) {
  let listener = null;
  let closed = false;
  const known = new Set();
  const reqs = [];
  const count = {};
  return {
    reqs,
    ch: {
      async request(line) {
        reqs.push(line);
        const [cmd, id] = line.split(' ');
        count[cmd] = (count[cmd] ?? 0) + 1;
        const a = answer(cmd, id, count[cmd]);
        if (cmd === 'create' && a === undefined) known.add(id);
        if (a !== undefined) return a;
        if (cmd === 'create') return { ok: true };
        if (!known.has(id)) return { ok: false, error: `no job ${id}` };
        return cmd === 'list' ? { ok: true, rows: [] } : { ok: true };
      },
      close() { closed = true; },
      alive() { return !closed; },
      onEvent(fn) { listener = fn; }
    }
  };
}

test('one timed-out request on a live helper does not orphan the jobs it holds', async () => {
  let running = true;
  let now = 1_000_000;
  // The helper: its second list is slow (null); it answers again after that. Its job has a process
  // of the call until `running` goes false.
  const h1 = fakeHelper((cmd, id, n) => {
    if (cmd !== 'list') return undefined;
    if (n === 2) return null;
    return { ok: true, rows: running ? [{ pid: 9, name: 'node.exe', createdMs: now }] : [] };
  });
  const h2 = fakeHelper();   // a second helper: it holds no job of the first one
  const told = [];
  let opened = 0;
  const jobs = new C.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => 'guppy-heavyjob.exe',
    channel: () => (opened++ === 0 ? h1 : h2).ch,
    now: () => now, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    log: () => {}, onJob: (e) => told.push(e)
  });
  await jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-1');
  assert.equal(told.filter((e) => e.state === 'held').length, 1, 'the job is held');
  await jobs.poll();   // a process of the call: started
  await jobs.poll();   // the slow list (null)
  running = false;
  for (let i = 0; i < 4 && !told.some((e) => e.state === 'exited'); i++) { now += 15_000; await jobs.poll(); }
  assert.equal(opened, 1, `A SLOW ANSWER IS NOT A DEAD HELPER: it is kept (helpers opened ${opened}; the second one answered ${JSON.stringify(h2.reqs)})`);
  assert.equal(told.filter((e) => e.state === 'exited').length, 1, 'A JOB HELD BEFORE ONE SLOW ANSWER STILL ENDS THROUGH HEAVYJOBS');
});

// ─── LIVE: the shipped helper with a cold start of 4 s ──────────────────────────────────────

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const LIVE_SKIP = process.platform !== 'win32' ? 'Windows only (Job Objects)' : !fs.existsSync(CSC) ? 'no in-box csc' : false;
const COLD_MS = 4_000;
const dirs = [];
test.after(async () => { for (const d of dirs) await removeDir(d); });

/** The shipped helper with one change: `serve` waits `ms` before it starts (a slow cold start). */
function slowStartHelper(ms) {
  const src = fs.readFileSync(path.join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs'), 'utf8').replace(/\r\n/g, '\n');
  const serve = '    static int Serve()\n    {';
  assert.ok(src.includes(serve), 'the helper still has the Serve seam');
  const out = src.replace(serve, `${serve}\n        System.Threading.Thread.Sleep(${ms}); // test: a slow cold start`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hjct108-'));
  dirs.push(dir);
  const exe = path.join(dir, 'guppy-heavyjob.exe');
  const cs = path.join(dir, 'guppy-heavyjob.cs');
  fs.writeFileSync(cs, out);
  const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, cs], { encoding: 'utf8', windowsHide: true });
  assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
  return exe;
}

test('LIVE: a helper slow to start (past the request timeout) still holds the job and frees the slot within 2 s of its exit, on one helper', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  assert.ok(COLD_MS > C.HEAVY_JOB_REQUEST_MS, 'the cold start is longer than the request timeout');
  const exe = slowStartHelper(COLD_MS);
  const rows = [];
  let helpers = 0;
  const lock = new HJ.HeavyJobLock({ limit: () => 1, log: (r) => rows.push({ ...r, ts: Date.now() }) });
  const jobs = new C.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => exe,
    channel: (x) => {
      helpers++;
      const base = C.serveChannel(x);
      // Every answer and event is logged, so a red names what came back and when.
      const w = Object.create(base);
      w.request = async (...a) => { const r = await base.request(...a); rows.push({ kind: 'heavy-cpu', action: `req ${String(a[0]).split(' ')[0]}=${r ? r.ok : 'null'}`, ts: Date.now() }); return r; };
      w.onEvent = (fn) => base.onEvent((e) => { rows.push({ kind: 'heavy-cpu', action: `event ${e.event}`, what: String(e.msg ?? e.action ?? ''), ts: Date.now() }); fn(e); });
      return w;
    },
    log: (r) => rows.push({ ...r, ts: Date.now() }),
    onJob: (e) => { if (e.state === 'held') lock.noteJob(e.agentId, e.callId, e.job); else lock.jobExited(e.agentId, e.callId, e.job); }
  });
  t.after(() => jobs.dispose());
  assert.equal(lock.acquire(AGENT, BENCH, 'bash cut.sh', 'call-1', true).acquired, true);
  const body = 'sleep 2';
  // As the agent's CLI does: the wrapped command starts once begin has returned it.
  assert.ok(await jobs.begin(AGENT, { command: body }, false, 'call-1'), 'the call is wrapped');
  const id = rows.find((r) => r.action === 'wrap').job;
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hjct108-local-'));
  dirs.push(local);
  const sh = spawn(gitBash(), ['-c', `"${exe.replace(/\\/g, '/')}" join ${id} 0 0; ${body}`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LOCALAPPDATA: local } });
  const exitAt = await new Promise((r) => sh.on('exit', () => r(Date.now())));
  const deadline = exitAt + 6_000;
  while (lock.snapshot().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const rel = rows.find((r) => r.kind === 'heavy-lock' && r.action === 'release');
  const lag = rel ? rel.ts - exitAt : null;
  const trail = rows.filter((x) => x.kind === 'heavy-cpu').map((x) => `${x.ts - exitAt}ms ${x.action}${x.what ? ' ' + x.what : ''}${x.held !== undefined ? ' held=' + x.held : ''}`).join(', ');
  assert.equal(rows.find((r) => r.action === 'wrap').held, true, `A COLD START IS NOT A FAILED CREATE: THE JOB IS HELD (${trail})`);
  assert.ok(lag !== null && lag >= 0 && lag < 2_000,
    `THE SLOT IS FREED WITHIN 2 S OF THE JOB'S EXIT (${lag === null ? 'not freed 6 s after it' : `freed ${lag} ms after`}; ${trail})`);
  assert.equal(rel.reason, 'job-exit');
  assert.equal(helpers, 1, 'ONE HELPER: a slow start does not start another');
});
