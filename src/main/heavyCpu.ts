/**
 * HEAVY-CPU-OPTIONS-191: Settings, beside "Heavy jobs at once", two independent options for heavy
 * jobs (an install, build, full suite or bench an agent runs): run them at background CPU priority
 * (BELOW_NORMAL), and hard-cap them at 50% of the whole machine. Either,
 * neither or both, each independent of the heavy lock (Off or N).
 *
 * How (Windows): every heavy call the PreToolUse hook classifies is rewritten to
 * `guppy-heavyjob join <job> <b> <c>; <the command, verbatim>`. Guppy first creates the named Job
 * Object with the current limits (the helper's `serve` process holds its handle, so the job can be
 * found again); the join line puts the call's shell into it, so every process the command starts is
 * created inside the job and stays there (no breakaway). Every heavy call is wrapped, both options
 * off included (a job with no limits changes nothing), so turning an option on reaches the jobs
 * already running. Elsewhere nothing is wrapped: the options are Windows-only.
 *
 * A shell that outlives its call (a persistent terminal) must not stay limited for later light
 * commands (god b43582): a job whose only processes are ones created BEFORE its call started has
 * nothing of the heavy job left in it, so its limits are lifted and Guppy lets it go.
 *
 * A courtesy limit, not a security boundary: any process of the user's session can open the named
 * job and change or lift its limits (`guppy-heavyjob set <job> 0 0`), so an agent can lift its own.
 * Lifting a limit resets a background member to NORMAL; CPU-rate control never changes any
 * process's affinity.
 *
 * The cap is a JobObjectCpuRateControlInformation hard cap (5000 = 50.00% of the whole machine),
 * not an affinity mask: every logical processor remains available and Electron's GPU workers retain
 * their normal affinity. The app itself never runs in a heavy job.
 */
import { spawn } from 'node:child_process';
import { hookClientTimeoutMs, mailLatencyLimitFor } from './mailSurface';
import { autoModeFlagForProvider, type AgentProvider } from '../shared/agentProvider';

/** JobObjectCpuRateControlInformation uses one-hundredths of one percent. */
export const HEAVY_CPU_CAP_RATE = 5000;
/** The helper's name on the agent PATH (the dir is on every hive agent's pathPrepend). */
export const HEAVY_JOB_COMMAND = 'guppy-heavyjob';
/** A process created up to this long before the call started still counts as the call's own. */
export const HEAVY_JOB_START_SKEW_MS = 250;
/** A job whose call has not started yet (a permission prompt, a wait for the heavy slot) is kept
 *  this long before it is taken for a call that never ran. */
export const HEAVY_JOB_UNSTARTED_MS = 30 * 60_000;
/** How often running jobs are checked for "nothing of the heavy job left". */
export const HEAVY_JOB_POLL_MS = 15_000;
/** One request to the helper: past this it is treated as failed. */
export const HEAVY_JOB_REQUEST_MS = 3_000;
/** HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: a new helper (the .NET start, cold on a loaded machine) may
 *  take this long to give its first answer. Until it has answered once, a request on it waits until
 *  this long after it was spawned, and never less than HEAVY_JOB_REQUEST_MS. */
export const HEAVY_JOB_START_MS = 12_000;
/** A begin whose hook client has this much of its wait left, or less, sends no create. */
export const HEAVY_JOB_DEADLINE_FLOOR_MS = 0;
/** HEAVY-LOCK-RELEASE-LAG-197: after the helper's last exit notice for a job, this long passes before
 *  the one check that may call the job over (a shell that outlives its call starts its next process
 *  right after the join line exits; a new process inside this window keeps the job running). */
export const HEAVY_JOB_EXIT_CONFIRM_MS = 400;

export interface HeavyCpuOptions { background: boolean; cap: boolean }

export interface HeavyCpuConfig { heavyJobsBackgroundPriority?: boolean; heavyJobsCpuCap?: boolean }

/** The hard cap is on by default; an explicit settings change reaches existing jobs. */
export function heavyCpuOptions(cfg: HeavyCpuConfig): HeavyCpuOptions {
  return { background: cfg.heavyJobsBackgroundPriority === true, cap: cfg.heavyJobsCpuCap !== false };
}

/** A job id the helper accepts ([A-Za-z0-9_-]), unique per call. */
export function heavyJobId(agentId: string, seq: number, now: number): string {
  const who = agentId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'agent';
  return `${who}-${now.toString(36)}-${seq.toString(36)}`;
}

/** The line put before the command. `;` separates it in bash, sh and PowerShell. cmd has no `;`:
 *  where the call is known to run in cmd, `&` separates it, so cmd parses the line once, as it would
 *  have, and runs the command itself inside the job. Elsewhere cmd passes the rest of the line to
 *  the helper, which runs it under a second cmd. */
export function joinLine(id: string, o: HeavyCpuOptions, cmd = false): string {
  return `${HEAVY_JOB_COMMAND} join ${id} ${o.background ? 1 : 0} ${o.cap ? 1 : 0}${cmd ? ' & ' : '; '}`;
}

/** Whether an agent started with this command line runs commands without asking its user: its
 *  provider's own auto-approve flag is on it. Codex applies a rewrite only with permissionDecision
 *  'allow', and AGY's rewrite is an allow; for an agent that asks first that allow could skip the
 *  user's prompt, so such an agent's calls are not rewritten (Jim SHOULD-2). Only the flag on the
 *  command line counts: Codex auto-approval set by config (approval_policy = "never" in config.toml,
 *  or -a never / --full-auto) reads as ask-first, so those calls run unlimited. That is the safe
 *  direction: a wrong guess never skips a prompt (Jim NIT1). */
export function approvesWithoutAsking(provider: AgentProvider, argv: string[]): boolean {
  const flag = autoModeFlagForProvider(provider).split(/\s+/).filter(Boolean);
  return flag.length > 0 && flag.every((f) => argv.includes(f));
}

/** The command without a leading join line: a PostToolUse carries the rewritten command, and a
 *  provider with no tool-use id pairs Pre with Post by the command (Jim SHOULD-1). */
export function withoutJoinLine(command: string): string {
  const m = /^guppy-heavyjob join [A-Za-z0-9_-]+ [01] [01](?:; | & )/.exec(command);
  return m ? command.slice(m[0].length) : command;
}

/** The tool input with the join line before its command (`command`: Claude Bash/PowerShell and
 *  Codex exec_command as its hooks see it; `CommandLine`: AGY run_command), or null when there is
 *  no command to wrap. */
export function wrapToolInput(toolInput: unknown, id: string, o: HeavyCpuOptions, cmd = false): Record<string, unknown> | null {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const r = toolInput as Record<string, unknown>;
  for (const key of ['command', 'CommandLine']) {
    const v = r[key];
    if (typeof v === 'string' && v.trim()) return { ...r, [key]: joinLine(id, o, cmd) + v };
  }
  return null;
}

export interface HeavyJobRow { pid: number; name: string; priorityClass: number; cpus: number; mask: string; createdMs: number }

/** One line-oriented channel to `guppy-heavyjob serve` (injectable for tests). */
export interface HeavyJobChannel {
  /** `ms`: how long to wait for the answer (default HEAVY_JOB_REQUEST_MS). */
  request(line: string, ms?: number): Promise<Record<string, unknown> | null>;
  close(): void;
  /** HEAVY-LOCK-RELEASE-LAG-197: the helper's unsolicited lines ({"event": ...}), never a reply. */
  onEvent?(fn: (e: Record<string, unknown>) => void): void;
  /** HEAVYCPU-SERVE-REQ-TIMEOUT-DROPS-ALL-JOBS-108: the helper behind this channel is gone (its
   *  process ended or its pipe broke). A request that was only not answered in time does not set it. */
  dead?(): boolean;
}

/** HEAVYCPU-SERVE-REQ-TIMEOUT-DROPS-ALL-JOBS-108: this many requests in a row with no answer from a
 *  helper that still runs, and it is taken as wedged and replaced (any answer starts the count
 *  again). One unanswered request closes nothing: the helper still holds every job. */
export const HEAVY_JOB_UNANSWERED_DEAD = 3;

/** The real channel: the helper's serve mode on stdin/stdout. Requests are answered in order. */
export function serveChannel(exe: string, spawnFn: typeof spawn = spawn): HeavyJobChannel {
  const child = spawnFn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const queue: Array<(r: Record<string, unknown> | null) => void> = [];
  let onEvent: ((e: Record<string, unknown>) => void) | null = null;
  let buf = '';
  let dead = false;
  const fail = (): void => { dead = true; while (queue.length) queue.shift()!(null); };
  child.on('error', fail);
  child.on('exit', fail);
  child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let r: Record<string, unknown> | null = null;
      try { r = JSON.parse(line) as Record<string, unknown>; } catch { r = null; }
      // An event line is not the answer to the oldest request: it goes to its listener only.
      if (r && typeof r.event === 'string') { try { onEvent?.(r); } catch { /* a listener never breaks the channel */ } continue; }
      queue.shift()?.(r);
    }
  });
  return {
    request(line: string, ms: number = HEAVY_JOB_REQUEST_MS) {
      if (dead) return Promise.resolve(null);
      return new Promise((resolve) => {
        let settled = false;
        const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, ms);
        t.unref?.();
        queue.push((r) => { if (!settled) { settled = true; clearTimeout(t); resolve(r); } });
        try { child.stdin.write(line + '\n'); } catch { fail(); }
      });
    },
    close() { try { child.stdin.end(); } catch { /* gone */ } },
    onEvent(fn) { onEvent = fn; },
    dead() { return dead; }
  };
}

export interface HeavyJobsDeps {
  platform: NodeJS.Platform;
  options: () => HeavyCpuOptions;
  /** The helper, or null when it is not there (then nothing is wrapped). */
  exe: () => string | null;
  channel?: (exe: string) => HeavyJobChannel;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
  log?: (row: Record<string, unknown>) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
  /** HEAVY-LOCK-RELEASE-LAG-197: a job the helper holds was made for `callId` ('held'), and nothing of
   *  that call is left in it any more ('exited', once per job). The heavy lock frees its slot on it.
   *  HEAVY-LOCK-NOHUP-DRIVER-UNREGISTERED-108: a held job Guppy stopped tracking before its exit was
   *  seen ('lost', with why: helper-dead | helper-unanswered | no-job | never-started | dispose). The
   *  lock stops counting it as running and falls back to its own process listing; no slot is freed. */
  onJob?: (e: { agentId: string; callId: string; job: string; state: 'held' | 'exited' | 'lost'; why?: string }) => void;
}

interface TrackedJob {
  id: string; agentId: string; startMs: number; idleScans: number; started: boolean;
  /** HEAVY-LOCK-RELEASE-LAG-197: the heavy call it was made for (none: nobody is told it ended). */
  callId: string | null;
  exited: boolean;
  /** The pending confirm after an exit notice, and when the first notice of this burst came. */
  confirm: unknown;
  noticeAt: number | null;
  /** The helper said the job is EMPTY (msg 4): the list runs at once, and a later notice changes nothing. A list that keeps the job clears it. */
  empty: boolean;
  /** A notice that landed while `empty` was set and was dropped: a list that keeps the job must judge it. */
  missed: boolean;
  /** The helper that holds the job's handle: when that helper is replaced the job cannot be read again. */
  ch: HeavyJobChannel;
}

/** The jobs Guppy made for heavy calls: created before the call, changed live, let go when done. */
export class HeavyJobs {
  private ch: HeavyJobChannel | null = null;
  private readonly jobs = new Map<string, TrackedJob>();
  private seq = 0;
  /** Requests in a row the current helper did not answer. */
  private unanswered = 0;
  private timer: unknown = null;
  /** HEAVYJOBS-DISPOSE-RESPAWNS-SERVE-108: set by dispose(). From then on no helper is started and
   *  the poll timer is not armed, whatever is still in flight or arrives late. */
  private disposed = false;
  private readonly now: () => number;
  /** HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: when the current helper was spawned; whether it has given a
   *  parsed answer yet (an event line or a garbage line is none); whether warm() started it; whether
   *  its one helper-start row is logged. Each new helper starts them again. */
  private chSpawnAt = 0;
  private answered = false;
  private chWarm = false;
  private chLogged = false;
  /** warm() runs once. */
  private warmed = false;

  constructor(private readonly d: HeavyJobsDeps) {
    this.now = d.now ?? Date.now;
  }

  private log(row: Record<string, unknown>): void { try { this.d.log?.({ kind: 'heavy-cpu', ...row }); } catch { /* best effort */ } }

  private channel(): HeavyJobChannel | null {
    if (this.disposed) return null;
    if (this.ch) return this.ch;
    const exe = this.d.exe();
    if (!exe) return null;
    this.ch = (this.d.channel ?? serveChannel)(exe);
    this.chSpawnAt = this.now();
    this.answered = false;
    this.chWarm = false;
    this.chLogged = false;
    this.ch.onEvent?.((e) => this.onEvent(e));
    return this.ch;
  }

  private async req(line: string): Promise<Record<string, unknown> | null> {
    return (await this.send(line, null)).r;
  }

  /** HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: the wait for an answer on the current helper. Until its first
   *  answer it is the start budget, counted from its spawn (a request queued behind a slow start gets
   *  only what is left of it), and never less than HEAVY_JOB_REQUEST_MS. */
  private budget(): number {
    if (this.answered) return HEAVY_JOB_REQUEST_MS;
    return Math.max(this.chSpawnAt + HEAVY_JOB_START_MS - this.now(), HEAVY_JOB_REQUEST_MS);
  }

  /** One request. `deadline` (epoch ms, or null): the hook client stops waiting then, so the request
   *  waits no longer. `cut`: no answer because of that deadline: the helper missed nothing, so it
   *  counts toward no replace. `cold`: sent before the helper's first answer. */
  private async send(line: string, deadline: number | null): Promise<{ r: Record<string, unknown> | null; cut: boolean; cold: boolean; ms: number }> {
    const ch = this.channel();
    if (!ch) return { r: null, cut: false, cold: false, ms: 0 };
    const cold = !this.answered;
    const full = this.budget();
    const wait = deadline === null ? full : Math.max(0, Math.min(full, deadline - this.now()));
    const t0 = this.now();
    const r = await ch.request(line, wait);
    const ms = this.now() - t0;
    if (this.ch !== ch) return { r, cut: false, cold, ms };   // replaced meanwhile: its jobs are already let go
    const gone = ch.dead?.() === true;
    const cut = r === null && !gone && wait < full;
    if (!this.chLogged && !cut) {
      this.chLogged = true;
      this.log({ action: 'helper-start', ok: r !== null, ms: this.now() - this.chSpawnAt, warm: this.chWarm });
    }
    if (r !== null) { this.unanswered = 0; this.answered = true; return { r, cut, cold, ms }; }
    if (cut) return { r, cut, cold, ms };
    // HEAVYCPU-SERVE-REQ-TIMEOUT-DROPS-ALL-JOBS-108: no answer in time is not a dead helper. Closing
    // the channel ends the helper and with it the handle of EVERY job it holds, so the helper is
    // replaced only when it is gone, or wedged (HEAVY_JOB_UNANSWERED_DEAD in a row with no answer).
    if (!gone && ++this.unanswered < HEAVY_JOB_UNANSWERED_DEAD) return { r, cut, cold, ms };
    this.replace(ch, gone ? 'helper-dead' : 'helper-unanswered');
    return { r, cut, cold, ms };
  }

  /** The helper is closed and started again on the next request. Its job handles went with it and a
   *  new helper cannot read those jobs, so each is let go as lost. */
  private replace(ch: HeavyJobChannel, why: string): void {
    try { ch.close(); } catch { /* gone */ }
    this.ch = null;
    this.unanswered = 0;
    for (const j of [...this.jobs.values()]) if (j.ch === ch) this.lose(j, why);
  }

  /** A job nobody can read any more is no longer tracked. Its exit is NOT told: processes of the
   *  call may still run, and telling it frees the heavy slot at once. The lock's own watcher frees it. */
  private lose(j: TrackedJob, why: string): void {
    if (this.jobs.get(j.id) !== j) return;
    this.cancelConfirm(j);
    this.jobs.delete(j.id);
    this.log({ action: 'lost', job: j.id, agentId: j.agentId, why });
    if (!this.jobs.size) this.disarm();
    if (j.callId && !j.exited) this.tell(j.agentId, j.callId, j.id, 'lost', why);
  }

  /** The helper's own answer that it holds no job of this id (guppy-heavyjob.cs list/set/query). */
  private noJob(r: Record<string, unknown> | null, id: string): boolean {
    return r !== null && r.ok === false && r.error === `no job ${id}`;
  }

  /** A heavy call that is not wrapped because its agent asks its user before running commands
   *  (Codex, AGY): logged, so the gap is visible (Jim SHOULD-1). */
  skipAskFirst(agentId: string, provider: string): void {
    if (this.d.platform !== 'win32' || !this.d.exe()) return;
    this.log({ action: 'skip-ask-first', agentId, provider });
  }

  /** A heavy call is about to run: its job is created with the limits in force now, and the tool
   *  input to run instead is returned (null: leave the call as it is). `cmd`: the call is known to
   *  run in Windows cmd. */
  async begin(agentId: string, toolInput: unknown, cmd = false, callId: string | null = null, transport?: string, arrivedMs: number | null = null): Promise<Record<string, unknown> | null> {
    if (this.d.platform !== 'win32' || !this.d.exe()) return null;
    // HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: a one-way hook gets no reply, so nothing it is told can wrap it.
    if (transport === 'pipe-oneway') return null;
    const o = this.d.options();
    const start = this.now();
    const id = heavyJobId(agentId, ++this.seq, start);
    const wrapped = wrapToolInput(toolInput, id, o, cmd);
    if (!wrapped) return null;
    // 5000 means 50% of all logical processors. Under the legacy heavyJobsHalfCores affinity job
    // that equals the affinity ceiling, so the rate cap adds nothing there; with half-cores off it
    // bites against the full set. Keep the shipped half-machine rate unchanged.
    // HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: the hook client waits for its reply only so long (its own
    // timeout, less the same margin as the mail latency limit), from when the hook arrived. A create
    // answered after that is of no use: the call runs unwrapped, so it waits no longer. None left:
    // nothing is sent.
    const deadline = (arrivedMs ?? start) + mailLatencyLimitFor(hookClientTimeoutMs(transport));
    if (deadline - this.now() <= HEAVY_JOB_DEADLINE_FLOOR_MS) {
      this.log({ action: 'start-timeout', agentId, job: id, cause: 'deadline', ms: 0, transport: transport ?? null, early: true });
      return null;
    }
    const ch = this.channel();
    const s = await this.send(`create ${id} ${o.background ? 1 : 0} ${o.cap ? 1 : 0}`, deadline);
    const r = s.r;
    if (r === null && (s.cut || s.cold)) this.log({ action: 'start-timeout', agentId, job: id, cause: s.cut ? 'deadline' : 'start', ms: s.ms, transport: transport ?? null });
    // Not created: the join line still makes the job with these limits itself (the options hold);
    // only a later live change cannot reach it.
    const held = r?.ok === true && ch !== null && this.ch === ch;   // not held when its helper was replaced meanwhile
    // An unanswered create may still be carried out late by a helper that is kept: the job is not
    // tracked, so its handle is dropped (best effort, not waited for).
    if (r === null && ch !== null && this.ch === ch) void this.req(`close ${id}`);
    if (held && ch) {
      this.jobs.set(id, { id, agentId, startMs: start, idleScans: 0, started: false, callId, exited: false, confirm: null, noticeAt: null, empty: false, missed: false, ch });
      this.arm();
      if (callId) this.tell(agentId, callId, id, 'held');
    }
    this.log({ action: 'wrap', agentId, job: id, background: o.background, cap: o.cap, rate: o.cap ? HEAVY_CPU_CAP_RATE : 0, held });
    return wrapped;
  }

  /** HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: start the helper before the first heavy call needs it, so its
   *  cold start is not paid inside a hook's wait. Once, fire-and-forget (never awaited): it sends a
   *  close of a job no one made, whose answer only proves the helper is up. A miss counts like any
   *  other unanswered request. Nothing on another platform, without the helper, after dispose(), or
   *  when a helper is already running. */
  warm(): void {
    if (this.d.platform !== 'win32' || this.disposed || this.warmed || this.ch !== null || !this.d.exe()) return;
    this.warmed = true;
    if (!this.channel()) return;
    this.chWarm = true;
    void this.send('close guppy-warm', null).then(() => undefined, () => undefined);
  }

  /** Settings changed: every running job gets the options now in force. */
  async applyLive(): Promise<void> {
    const o = this.d.options();
    for (const j of [...this.jobs.values()]) {
      const r = await this.req(`set ${j.id} ${o.background ? 1 : 0} ${o.cap ? 1 : 0}`);
      this.log({ action: 'apply-live', job: j.id, background: o.background, cap: o.cap, rate: o.cap ? HEAVY_CPU_CAP_RATE : 0, ok: r?.ok === true });
    }
  }

  /** One check of every job: one with nothing of its call left (no process, or only processes
   *  created before the call started) on two checks in a row has its limits lifted and is let go.
   *  An empty job whose call never put a process in it has not started yet: it is kept, so a
   *  Settings change still reaches it, until HEAVY_JOB_UNSTARTED_MS. */
  async poll(): Promise<void> {
    for (const j of [...this.jobs.values()]) {
      if (this.jobs.get(j.id) !== j) continue;   // let go while an earlier job was asked about
      const r = await this.req(`list ${j.id}`);
      if (this.jobs.get(j.id) !== j) continue;   // lost with its helper
      if (this.noJob(r, j.id)) { this.lose(j, 'no-job'); continue; }   // the helper holds no such job: it can never be read
      if (!r || r.ok !== true || !Array.isArray(r.rows)) continue; // unanswered or failed: says nothing, no miss counted
      const rows = r.rows as HeavyJobRow[];
      if (rows.length) j.started = true;
      else if (!j.started) {
        if (this.now() - j.startMs < HEAVY_JOB_UNSTARTED_MS) continue;
        await this.req(`close ${j.id}`);
        this.jobs.delete(j.id);
        this.log({ action: 'never-started', job: j.id, agentId: j.agentId });
        if (j.callId) this.tell(j.agentId, j.callId, j.id, 'lost', 'never-started');
        continue;
      }
      const own = this.own(j, rows);
      if (own.length) { j.idleScans = 0; continue; }
      if (++j.idleScans < 2) continue;
      if (rows.length) await this.req(`set ${j.id} 0 0`);
      await this.req(`close ${j.id}`);
      this.jobs.delete(j.id);
      this.cancelConfirm(j);
      // The fallback when no exit notice came (Windows does not promise them).
      this.exited(j, 'poll');
      this.log({ action: rows.length ? 'lifted' : 'done', job: j.id, agentId: j.agentId, kept: rows.map((x) => x.name) });
    }
    if (!this.jobs.size) this.disarm();
  }

  /** HEAVY-LOCK-RELEASE-LAG-197: a process of a job exited (or the job went empty). Every notice
   *  restarts the confirm, so the check runs HEAVY_JOB_EXIT_CONFIRM_MS after the last one of a burst. */
  private onEvent(e: Record<string, unknown>): void {
    if (e.event === 'watch') {
      // The helper's own `action` (closed, open-failed, wait-failed, failed) is logged as `what`.
      this.log({ ...e, action: 'watch', what: e.action });
      return;
    }
    if (e.event !== 'exit' || typeof e.job !== 'string') return;
    const j = this.jobs.get(e.job);
    if (!j || j.exited) return;
    j.started = true;
    if (j.noticeAt === null) j.noticeAt = this.now();
    if (j.empty) { j.missed = true; return; }
    if (e.msg === 4) { this.cancelConfirm(j); j.empty = true; j.missed = false; void this.confirmExit(j); return; }
    this.armConfirm(j);
  }

  private armConfirm(j: TrackedJob): void {
    this.cancelConfirm(j);
    const st = this.d.setTimeout ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    j.confirm = st(() => { j.confirm = null; void this.confirmExit(j); }, HEAVY_JOB_EXIT_CONFIRM_MS);
  }

  private cancelConfirm(j: TrackedJob): void {
    if (j.confirm === null) return;
    (this.d.clearTimeout ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(j.confirm);
    j.confirm = null;
  }

  /** One list after the notices settle: nothing of the call left (only processes from before it) is
   *  an exit now. A failed list says nothing: the poll still decides. */
  private async confirmExit(j: TrackedJob): Promise<void> {
    if (j.exited || this.jobs.get(j.id) !== j) return;
    const r = await this.req(`list ${j.id}`);
    if (this.jobs.get(j.id) !== j) return;   // lost with its helper
    if (this.noJob(r, j.id)) { this.lose(j, 'no-job'); return; }
    if (!r || r.ok !== true || !Array.isArray(r.rows)) { j.empty = false; if (j.missed) { j.missed = false; this.armConfirm(j); } return; }   // a failed list says nothing: later notices count again, and a notice dropped under the mark is judged
    if (j.confirm !== null || this.jobs.get(j.id) !== j) return;   // a newer notice re-armed it, or it was let go
    const left = this.own(j, r.rows as HeavyJobRow[]).length;
    if (left) j.empty = false;
    if (left) { j.noticeAt = null; if (j.missed) { j.missed = false; this.armConfirm(j); } return; }
    this.exited(j, 'notice');
  }

  private own(j: TrackedJob, rows: HeavyJobRow[]): HeavyJobRow[] {
    return rows.filter((x) => typeof x.createdMs !== 'number' || x.createdMs === 0 || x.createdMs >= j.startMs - HEAVY_JOB_START_SKEW_MS);
  }

  private exited(j: TrackedJob, by: 'notice' | 'poll'): void {
    if (j.exited) return;
    j.exited = true;
    this.log({ action: 'exited', job: j.id, agentId: j.agentId, by, ...(j.noticeAt !== null ? { afterNoticeMs: this.now() - j.noticeAt } : {}) });
    if (j.callId) this.tell(j.agentId, j.callId, j.id, 'exited');
  }

  private tell(agentId: string, callId: string, job: string, state: 'held' | 'exited' | 'lost', why?: string): void {
    try { this.d.onJob?.({ agentId, callId, job, state, ...(why ? { why } : {}) }); } catch { /* the lock's own checks still run */ }
  }

  /** The jobs being tracked (for tests and the live proof). */
  ids(): string[] { return [...this.jobs.keys()]; }

  private arm(): void {
    if (this.disposed || this.timer || !this.jobs.size) return;
    const si = this.d.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); return t; });
    this.timer = si(() => { void this.poll(); }, HEAVY_JOB_POLL_MS);
  }

  private disarm(): void {
    if (!this.timer) return;
    (this.d.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
  }

  /** HEAVY-LOCK-NOHUP-DRIVER-UNREGISTERED-108: a held job tracked at dispose can no longer be seen to
   *  exit, so the lock is told it is lost (the jobs stay in the map: only the flag stops arm()). */
  dispose(): void { this.disposed = true; this.disarm(); for (const j of this.jobs.values()) { this.cancelConfirm(j); if (j.callId && !j.exited) this.tell(j.agentId, j.callId, j.id, 'lost', 'dispose'); } this.ch?.close(); this.ch = null; }
}
