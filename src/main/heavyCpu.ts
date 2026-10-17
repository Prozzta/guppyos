/**
 * HEAVY-CPU-OPTIONS-191: Settings, beside "Heavy jobs at once", two independent options for heavy
 * jobs (an install, build, full suite or bench an agent runs): run them at background CPU priority
 * (BELOW_NORMAL), and limit them to half the logical processors (floor(n/2), at least 1). Either,
 * neither or both, each independent of the heavy lock (Off or N).
 *
 * How (Windows): every heavy call the PreToolUse hook classifies is rewritten to
 * `guppy-heavyjob join <job> <b> <h>; <the command, verbatim>`. Guppy first creates the named Job
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
 * Lifting a limit resets the members (the helper's SetJob): priority NORMAL and affinity the whole
 * machine, even for a process that had narrowed its own affinity before.
 *
 * Option 2 and Electron: under an affinity limit Electron 32's SwiftShader GPU process deadlocks
 * (heavycpu/ROOTCAUSE.md), so on Windows a test always starts Electron from a view of its folder
 * whose SwiftShader.ini keeps those workers on option 2's processors, limit or not, since the limit
 * can be turned on while a suite runs (test/electron-harness/electron-bin.cjs). The app itself never runs in a heavy job.
 */
import { spawn } from 'node:child_process';
import { autoModeFlagForProvider, type AgentProvider } from '../shared/agentProvider';

/** Option 2's switch (god 123473: held off until the harness SwiftShader stall was fixed; 7ef310: on). */
export const HEAVY_HALF_CORES_AVAILABLE = true;
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

export interface HeavyCpuOptions { background: boolean; half: boolean }

export interface HeavyCpuConfig { heavyJobsBackgroundPriority?: boolean; heavyJobsHalfCores?: boolean }

/** The options in force. Option 2 counts only when it is available. */
export function heavyCpuOptions(cfg: HeavyCpuConfig, halfAvailable: boolean = HEAVY_HALF_CORES_AVAILABLE): HeavyCpuOptions {
  return { background: cfg.heavyJobsBackgroundPriority === true, half: halfAvailable && cfg.heavyJobsHalfCores === true };
}

/** Option 2's processor count: floor(n/2), at least 1 (32 -> 16). */
export function halfCoreCount(logical: number): number {
  return Math.max(1, Math.floor(logical / 2));
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
  return `${HEAVY_JOB_COMMAND} join ${id} ${o.background ? 1 : 0} ${o.half ? 1 : 0}${cmd ? ' & ' : '; '}`;
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
export interface HeavyJobChannel { request(line: string): Promise<Record<string, unknown> | null>; close(): void }

/** The real channel: the helper's serve mode on stdin/stdout. Requests are answered in order. */
export function serveChannel(exe: string): HeavyJobChannel {
  const child = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const queue: Array<(r: Record<string, unknown> | null) => void> = [];
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
      queue.shift()?.(r);
    }
  });
  return {
    request(line: string) {
      if (dead) return Promise.resolve(null);
      return new Promise((resolve) => {
        let settled = false;
        const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, HEAVY_JOB_REQUEST_MS);
        t.unref?.();
        queue.push((r) => { if (!settled) { settled = true; clearTimeout(t); resolve(r); } });
        try { child.stdin.write(line + '\n'); } catch { fail(); }
      });
    },
    close() { try { child.stdin.end(); } catch { /* gone */ } }
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
  /** The agent's PTY process (the root of its process tree), or null when it has none. */
  root?: (agentId: string) => number | null;
}

interface TrackedJob { id: string; agentId: string; startMs: number; idleScans: number; started: boolean }

/** A heavy call that runs in its agent's own job (no join line): CODEX-AGY-ASKFIRST-HEAVYCPU-192. */
interface AgentCall { agentId: string; command: string; startMs: number; total0: number; started: boolean; idleScans: number; postSeen: boolean }

/** The command a tool input runs (`command`: Claude, Codex; `CommandLine`: AGY), or null. */
function commandOf(toolInput: unknown): string | null {
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return null;
  const r = toolInput as Record<string, unknown>;
  for (const key of ['command', 'CommandLine']) if (typeof r[key] === 'string' && (r[key] as string).trim()) return r[key] as string;
  return null;
}

/** The id of an agent's own job in the helper's serve. */
export function agentJobId(agentId: string): string {
  return `${agentId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'agent'}-agent`;
}

/** The jobs Guppy made for heavy calls: created before the call, changed live, let go when done. */
export class HeavyJobs {
  private ch: HeavyJobChannel | null = null;
  private readonly jobs = new Map<string, TrackedJob>();
  private readonly agentCalls = new Map<string, AgentCall[]>();
  /** Agents with a job in the helper's serve (closed when the agent goes). */
  private readonly agentSeen = new Set<string>();
  private seq = 0;
  private timer: unknown = null;
  private readonly now: () => number;

  constructor(private readonly d: HeavyJobsDeps) {
    this.now = d.now ?? Date.now;
  }

  private log(row: Record<string, unknown>): void { try { this.d.log?.({ kind: 'heavy-cpu', ...row }); } catch { /* best effort */ } }

  private channel(): HeavyJobChannel | null {
    if (this.ch) return this.ch;
    const exe = this.d.exe();
    if (!exe) return null;
    this.ch = (this.d.channel ?? serveChannel)(exe);
    return this.ch;
  }

  private async req(line: string): Promise<Record<string, unknown> | null> {
    const ch = this.channel();
    if (!ch) return null;
    const r = await ch.request(line);
    // A dead helper is started again on the next request.
    if (r === null && this.ch === ch) { ch.close(); this.ch = null; }
    return r;
  }

  /**
   * CODEX-AGY-ASKFIRST-HEAVYCPU-192: a heavy call that cannot take a join line (its agent asks its
   * user first, so a rewrite with an allow could skip that prompt; or a Codex shell Guppy cannot
   * read, CODEX-CMD-COMPUTED-SHELL-192) runs in its agent's own job. At the PreToolUse, before the
   * hook answers, the agent's whole process tree is put in that job: the call's shell does not exist
   * yet, so everything the call starts is created inside it. The job has the options in force while
   * one such call of the agent lives; the whole agent runs limited for that time. A call ends when
   * its shell's tree is gone (not at its PostToolUse: Codex returns from a long command while it
   * still runs), and an agent with no live call has its limits lifted.
   */
  async attachCall(agentId: string, toolInput: unknown, reason: string, provider = ''): Promise<void> {
    if (this.d.platform !== 'win32' || !this.d.exe()) return;
    const command = commandOf(toolInput);
    if (!command) return;
    const root = this.d.root?.(agentId) ?? null;
    const aid = agentJobId(agentId);
    if (!root) { this.log({ action: 'attach-failed', reason, agentId, provider, why: 'no agent process' }); return; }
    const start = this.now();
    const r = await this.req(`agent ${aid} ${root}`);
    if (r?.ok !== true) { this.log({ action: 'attach-failed', reason, agentId, provider, why: String(r?.error ?? 'no helper') }); return; }
    this.agentSeen.add(agentId);
    const calls = this.agentCalls.get(agentId) ?? [];
    this.agentCalls.set(agentId, [...calls, { agentId, command, startMs: start, total0: Number(r.total) || 0, started: false, idleScans: 0, postSeen: false }]);
    const o = this.d.options();
    // The call's shell starts only after this hook answers: the limits are on before it exists.
    const set = await this.req(`set ${aid} ${o.background ? 1 : 0} ${o.half ? 1 : 0}`);
    this.log({ action: 'attach', reason, agentId, provider, job: aid, background: o.background, half: o.half, members: r.members, missed: r.missed, ok: set?.ok === true });
    this.arm();
  }

  /** The PostToolUse of a call run in its agent's job: a call whose shell was never seen ends at
   *  the next check. */
  callPost(agentId: string, toolInput: unknown): void {
    const command = commandOf(toolInput);
    const c = (this.agentCalls.get(agentId) ?? []).find((x) => !x.postSeen && x.command === command);
    if (c) c.postSeen = true;
  }

  /** The agent's PTY is gone or replaced: its job is let go (no handle kept for a dead tree). */
  async agentGone(agentId: string): Promise<void> {
    const had = this.agentCalls.get(agentId);
    this.agentCalls.delete(agentId);
    if (!this.agentSeen.delete(agentId)) return;
    await this.req(`close ${agentJobId(agentId)}`);
    this.log({ action: 'agent-gone', agentId, job: agentJobId(agentId), live: had?.length ?? 0 });
    if (!this.jobs.size && !this.agentCalls.size) this.disarm();
  }

  /** A heavy call is about to run: its job is created with the limits in force now, and the tool
   *  input to run instead is returned (null: leave the call as it is). `cmd`: the call is known to
   *  run in Windows cmd. */
  async begin(agentId: string, toolInput: unknown, cmd = false): Promise<Record<string, unknown> | null> {
    if (this.d.platform !== 'win32' || !this.d.exe()) return null;
    const o = this.d.options();
    const start = this.now();
    const id = heavyJobId(agentId, ++this.seq, start);
    const wrapped = wrapToolInput(toolInput, id, o, cmd);
    if (!wrapped) return null;
    const r = await this.req(`create ${id} ${o.background ? 1 : 0} ${o.half ? 1 : 0}`);
    // Not created: the join line still makes the job with these limits itself (the options hold);
    // only a later live change cannot reach it.
    if (r?.ok === true) {
      this.jobs.set(id, { id, agentId, startMs: start, idleScans: 0, started: false });
      this.arm();
    }
    this.log({ action: 'wrap', agentId, job: id, background: o.background, half: o.half, held: r?.ok === true });
    return wrapped;
  }

  /** Settings changed: every running job gets the options now in force. */
  async applyLive(): Promise<void> {
    const o = this.d.options();
    for (const j of [...this.jobs.values()]) {
      const r = await this.req(`set ${j.id} ${o.background ? 1 : 0} ${o.half ? 1 : 0}`);
      this.log({ action: 'apply-live', job: j.id, background: o.background, half: o.half, ok: r?.ok === true });
    }
    for (const agentId of [...this.agentCalls.keys()]) {
      const r = await this.req(`set ${agentJobId(agentId)} ${o.background ? 1 : 0} ${o.half ? 1 : 0}`);
      this.log({ action: 'apply-live', job: agentJobId(agentId), background: o.background, half: o.half, ok: r?.ok === true });
    }
  }

  /** One check of each call run in its agent's job: it ends when its shell's tree is gone on two
   *  checks in a row. A shell never seen: after its PostToolUse it ran too briefly to be seen if the
   *  job had new processes since the call began, and else ran outside the job (logged); with no
   *  PostToolUse it never started (HEAVY_JOB_UNSTARTED_MS). */
  private async pollAgentCalls(): Promise<void> {
    for (const [agentId, calls] of [...this.agentCalls]) {
      for (const c of [...calls]) {
        const r = await this.req(`call ${agentJobId(agentId)} ${c.startMs} ${Buffer.from(c.command, 'utf8').toString('base64')}`);
        if (!r || r.ok !== true) continue; // unknown: no miss counted
        if (Number(r.shell) > 0) c.started = true;
        if (c.started) {
          if (Number(r.alive) > 0) { c.idleScans = 0; continue; }
          if (++c.idleScans >= 2) await this.endCall(c, 'done');
        } else if (c.postSeen) await this.endCall(c, Number(r.total) > c.total0 ? 'done-unseen' : 'attach-missed');
        else if (this.now() - c.startMs >= HEAVY_JOB_UNSTARTED_MS) await this.endCall(c, 'never-started');
      }
    }
  }

  private async endCall(c: AgentCall, how: string): Promise<void> {
    const rest = (this.agentCalls.get(c.agentId) ?? []).filter((x) => x !== c);
    if (rest.length) this.agentCalls.set(c.agentId, rest);
    else {
      this.agentCalls.delete(c.agentId);
      await this.req(`set ${agentJobId(c.agentId)} 0 0`);
    }
    this.log({ action: how, agentId: c.agentId, job: agentJobId(c.agentId), live: rest.length });
  }

  /** The calls of each agent running in its own job (for tests and the live proof). */
  agentCallCount(agentId: string): number { return this.agentCalls.get(agentId)?.length ?? 0; }

  /** One check of every job: one with nothing of its call left (no process, or only processes
   *  created before the call started) on two checks in a row has its limits lifted and is let go.
   *  An empty job whose call never put a process in it has not started yet: it is kept, so a
   *  Settings change still reaches it, until HEAVY_JOB_UNSTARTED_MS. */
  async poll(): Promise<void> {
    for (const j of [...this.jobs.values()]) {
      const r = await this.req(`list ${j.id}`);
      if (!r || r.ok !== true || !Array.isArray(r.rows)) continue; // unknown: no miss counted
      const rows = r.rows as HeavyJobRow[];
      if (rows.length) j.started = true;
      else if (!j.started) {
        if (this.now() - j.startMs < HEAVY_JOB_UNSTARTED_MS) continue;
        await this.req(`close ${j.id}`);
        this.jobs.delete(j.id);
        this.log({ action: 'never-started', job: j.id, agentId: j.agentId });
        continue;
      }
      const own = rows.filter((x) => typeof x.createdMs !== 'number' || x.createdMs === 0 || x.createdMs >= j.startMs - HEAVY_JOB_START_SKEW_MS);
      if (own.length) { j.idleScans = 0; continue; }
      if (++j.idleScans < 2) continue;
      if (rows.length) await this.req(`set ${j.id} 0 0`);
      await this.req(`close ${j.id}`);
      this.jobs.delete(j.id);
      this.log({ action: rows.length ? 'lifted' : 'done', job: j.id, agentId: j.agentId, kept: rows.map((x) => x.name) });
    }
    await this.pollAgentCalls();
    if (!this.jobs.size && !this.agentCalls.size) this.disarm();
  }

  /** The jobs being tracked (for tests and the live proof). */
  ids(): string[] { return [...this.jobs.keys()]; }

  private arm(): void {
    if (this.timer || (!this.jobs.size && !this.agentCalls.size)) return;
    const si = this.d.setInterval ?? ((fn: () => void, ms: number) => { const t = setInterval(fn, ms); t.unref?.(); return t; });
    this.timer = si(() => { void this.poll(); }, HEAVY_JOB_POLL_MS);
  }

  private disarm(): void {
    if (!this.timer) return;
    (this.d.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
  }

  dispose(): void { this.disarm(); this.ch?.close(); this.ch = null; }
}
