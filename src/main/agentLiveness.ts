/**
 * ZERO-TOKEN-LIVENESS (1.1.77; design C:/Dunder/_work/dwight-177/ZERO-TOKEN-LIVENESS-DESIGN.md rev 2,
 * contract C:/Dunder/_work/creed-177/LIVENESS-V1.md): the AgentLivenessMonitor.
 *
 * WHAT IT IS. A deterministic observer. It folds facts the harness already has (the registry, the
 * PTY, the wake coordinator, the Codex rollout, wake refusals, PTY exits) into one `liveness-v1`
 * record per agent, and publishes it: `getLiveness(agentId)` in process, `onLivenessChange(cb)` on a
 * classification/lifecycle edge, ONE `{kind:'liveness', ...record}` row per such edge (the injected
 * sink), and the current records for `fleet.json`.
 *
 * WHAT IT NEVER DOES. It never calls a model, writes a terminal, submits or requests a wake, prompts
 * an agent, restarts or kills a process, wakes god or edits the board. It has no dependency that
 * could: it imports only the shared type and the wake constants, and every effect is the injected
 * sink. Recovery stays with the 1.1.76 WWR (InboxWakeBridge.recoverStuckActive); the bridge tells
 * this monitor BEFORE it acts (`noteStuckWake`), so the STUCK_WAKE row is written first. Escalation
 * is ZT-I3's (boardMonitor), from these records only.
 *
 * Electron-free; clock and facts injected, so every case is driven synchronously in tests.
 */
import {
  LIVENESS_REASON_OPERATOR_HOLD,
  type LivenessArchiveReason, type LivenessClassification, type LivenessLifecycle, type LivenessV1
} from '../shared/livenessV1';
import {
  STUCK_ACTIVE_PROOF_MS, WORKER_WAKE_BOOT_GRACE_MS, WORKER_WAKE_HITL_REARM_MS, WORKER_WAKE_IDLE_MS,
  type WakeLifecycle
} from './workerWake';
import { WAKE_STALL_AFTER_MS } from './wakeStall';

/** Recent-evidence window: PTY output, hook traffic or a turn start this recent is progress; an
 *  open turn with none for this long is SUSPECT (diagnostic only). Design row 5/6. */
export const LIVENESS_RECENT_MS = 5 * 60_000;
/** How long a non-LIVE record (ARCHIVED, DELETED) stays in the fleet.json snapshot after its last
 *  edge. In process (`getLiveness`) every record is kept. */
export const LIVENESS_FLEET_RETAIN_MS = 7 * 24 * 60 * 60_000;

/** The bounded machine reasons this producer emits (consumers treat unknown values as opaque). */
export type LivenessReason =
  | 'pty-exit-unrequested' | 'pty-exit-requested'
  | 'no-pty' | 'no-process' | 'deleted' | 'boot-grace'
  | 'wwr-recovering' | 'wwr-max-recoveries'
  | 'rollout-started' | 'pty-traffic' | 'hook-traffic' | 'turn-started'
  | 'rollout-complete-no-stop' | 'no-progress' | 'wake-refusal-stall'
  | typeof LIVENESS_REASON_OPERATOR_HOLD
  | 'turn-ended' | 'quiescent' | 'awaiting-wake';

/** The live PTY of the agent, as the PTY manager reports it. */
export interface LivenessPtyFacts {
  ptyId: string;
  /** PtyManager's process-wide spawn sequence: never reused, so a respawn on the same id differs. */
  incarnation: number;
  spawnedAt: number;
  /** Timestamp of the last REAL output (node-pty onData), 0 = none yet. Never the spawn stamp. */
  lastTrafficAt: number;
}

/** The wake coordinator's read-only facts for the agent (WorkerWakeWatchdog.livenessFacts). */
export interface LivenessWakeFacts {
  lifecycle: WakeLifecycle;
  provisional: boolean;
  activeSince: number;
  openTurnId: string | null;
  /** When the provider last said a turn STARTED. */
  turnStartAt: number;
  /** The last MAIN-session Stop/StopFailure (a SubagentStop never sets it). 0 = none. */
  lastTurnEndAt: number;
  /** The newest hook or provider-status reading. 0 = none. */
  lastHookAt: number;
  lastHumanNeedsAt: number;
}

export interface LivenessFacts {
  agentId: string;
  registry: {
    archived: boolean;
    /** Registry ArchiveReason; absent on an archived agent = archived before 1.1.75 (explicit). */
    archiveReason?: LivenessArchiveReason;
    archivedAt?: number;
    onHold: boolean;
  };
  pty: LivenessPtyFacts | null;
  wake: LivenessWakeFacts;
  control: { paused: boolean; halted: boolean; autoDeliveryPaused: boolean };
  /** The agent's delivered, not-yet-acted mail ids (the wake path's pending source). */
  mailWaiting: number;
  /** Codex only: the newest turn boundary in the agent's rollout (undefined = not Codex / unreadable). */
  rollout?: { kind: 'started' | 'complete'; turnId: string; at: number } | null;
}

/** One PTY incarnation ended. `explicit`: the harness asked for it (a kill, a window close). */
export interface LivenessPtyEnd {
  ptyId: string;
  incarnation: number;
  explicit: boolean;
  exitCode: number | null;
  at: number;
}

/** What the monitor remembers per agent between samples (never a decision of anyone else's). */
interface Memo {
  ended?: LivenessPtyEnd;
  /** STUCK_WAKE: written by the bridge BEFORE the WWR acts; sticky until the agent shows progress. */
  stuck?: { at: number; reason: 'wwr-recovering' | 'wwr-max-recoveries'; incarnation: number | null };
  lastRolloutStartedAt?: number;
  lastRolloutCompleteAt?: number;
  lastWakeRefusalAt?: number;
  wakeRefusalSince?: number;
  /** The last incarnation seen, for an agent whose PTY is gone. */
  lastIncarnation?: string;
}

export interface LivenessVerdict {
  lifecycle: LivenessLifecycle;
  archiveReason?: LivenessArchiveReason;
  archivedAt?: number;
  classification: LivenessClassification;
  reason: LivenessReason;
  incarnation: string;
  evidence: LivenessV1['evidence'];
}

export function incarnationKey(ptyId: string, incarnation: number): string {
  return `${ptyId}#${incarnation}`;
}

/**
 * THE PURE REDUCER. Precedence (design table): CRASHED/EXITED, then no-process UNKNOWN, boot grace,
 * STUCK_WAKE (only as the bridge recorded it: no second stuck decision here), BUSY_PROGRESSING,
 * SUSPECT, IDLE, UNKNOWN. `facts === null` = the agent is no longer in the registry (DELETED).
 */
export function classifyLiveness(facts: LivenessFacts | null, memo: Readonly<Memo>, prev: LivenessV1 | undefined, now: number): LivenessVerdict {
  const evidence: LivenessV1['evidence'] = { sampledAt: now };
  if (memo.lastRolloutStartedAt !== undefined) evidence.lastRolloutStartedAt = memo.lastRolloutStartedAt;
  if (memo.lastRolloutCompleteAt !== undefined) evidence.lastRolloutCompleteAt = memo.lastRolloutCompleteAt;
  if (memo.lastWakeRefusalAt !== undefined) evidence.lastWakeRefusalAt = memo.lastWakeRefusalAt;
  if (memo.wakeRefusalSince !== undefined) evidence.wakeRefusalSince = memo.wakeRefusalSince;

  if (!facts) {
    return {
      lifecycle: 'DELETED', classification: prev?.classification ?? 'UNKNOWN', reason: 'deleted',
      incarnation: prev?.incarnation ?? memo.lastIncarnation ?? 'none', evidence: { ...(prev?.evidence ?? {}), ...evidence }
    };
  }
  const lifecycle: LivenessLifecycle = facts.registry.archived ? 'ARCHIVED' : 'LIVE';
  const archive = lifecycle === 'ARCHIVED'
    ? { archiveReason: facts.registry.archiveReason ?? 'explicit' as const, ...(facts.registry.archivedAt !== undefined ? { archivedAt: facts.registry.archivedAt } : {}) }
    : {};
  const pty = facts.pty;
  const w = facts.wake;
  // Evidence of the LIVE incarnation only (a new incarnation never inherits the old one's).
  if (pty && pty.lastTrafficAt > 0) evidence.lastPtyTrafficAt = pty.lastTrafficAt;
  if (w.lastHookAt > 0) evidence.lastHookAt = w.lastHookAt;
  if (w.lastTurnEndAt > 0) evidence.lastTurnEndAt = w.lastTurnEndAt;
  const verdict = (classification: LivenessClassification, reason: LivenessReason, incarnation: string): LivenessVerdict =>
    ({ lifecycle, ...archive, classification, reason, incarnation, evidence });

  // 1-2. The incarnation ended and no newer one is live: CRASHED unless the harness asked for it.
  //      The exit code is evidence only (a requested kill and a crash both exit non-zero on ConPTY).
  const ended = memo.ended && (!pty || pty.incarnation === memo.ended.incarnation) ? memo.ended : undefined;
  if (ended) {
    evidence.processExitAt = ended.at;
    evidence.exitCode = ended.exitCode;
    return verdict(ended.explicit ? 'EXITED' : 'CRASHED', ended.explicit ? 'pty-exit-requested' : 'pty-exit-unrequested',
      incarnationKey(ended.ptyId, ended.incarnation));
  }
  if (!pty) return verdict('UNKNOWN', lifecycle === 'LIVE' ? 'no-pty' : 'no-process', memo.lastIncarnation ?? prev?.incarnation ?? 'none');
  const inc = incarnationKey(pty.ptyId, pty.incarnation);
  // 8 (boot). Never judged inside the boot sequence.
  if (now - pty.spawnedAt < WORKER_WAKE_BOOT_GRACE_MS) return verdict('UNKNOWN', 'boot-grace', inc);
  // 4. STUCK_WAKE exactly as the WWR's owner recorded it (sticky; see AgentLivenessMonitor).
  if (memo.stuck) return verdict('STUCK_WAKE', memo.stuck.reason, inc);

  // A rollout boundary counts only for THIS incarnation (a crashed session's last `task_started`
  // must not make its successor look busy).
  const r = facts.rollout && facts.rollout.at >= pty.spawnedAt ? facts.rollout : null;
  const rolloutRunning = r?.kind === 'started';
  const ptyAt = pty.lastTrafficAt;
  const hookAt = w.lastHookAt;
  const hitl = w.lastHumanNeedsAt > 0 && (now - w.lastHumanNeedsAt < WORKER_WAKE_HITL_REARM_MS
    || (w.lifecycle === 'active' && w.activeSince > 0 && w.lastHumanNeedsAt >= w.activeSince));
  const operatorHold = facts.control.paused || facts.control.halted || facts.control.autoDeliveryPaused
    || facts.registry.onHold || hitl;

  if (w.lifecycle === 'active' || rolloutRunning) {
    // 5. The provider's own record says a turn is running: busy however sparse its output.
    if (rolloutRunning) return verdict('BUSY_PROGRESSING', 'rollout-started', inc);
    // The provider's record says the OPEN turn completed (that turn by id, or newer than an
    // unnamed epoch), and no hook has spoken since for the WWR's proof window: the Stop is missing.
    const completeProof = r?.kind === 'complete'
      && (w.openTurnId ? r.turnId === w.openTurnId : w.activeSince > 0 && r.at > w.activeSince);
    if (completeProof && now - Math.max(w.activeSince, hookAt) >= STUCK_ACTIVE_PROOF_MS) {
      return verdict(operatorHold ? 'IDLE' : 'SUSPECT', operatorHold ? LIVENESS_REASON_OPERATOR_HOLD : 'rollout-complete-no-stop', inc);
    }
    const progressAt = Math.max(w.activeSince, ptyAt, hookAt);
    if (now - progressAt < LIVENESS_RECENT_MS) {
      return verdict('BUSY_PROGRESSING', progressAt === ptyAt && ptyAt > 0 ? 'pty-traffic' : progressAt === hookAt && hookAt > 0 ? 'hook-traffic' : 'turn-started', inc);
    }
    // 7 before 6: a turn waiting on a person (HITL, a pause) is a hold, never a suspect.
    if (operatorHold) return verdict('IDLE', LIVENESS_REASON_OPERATOR_HOLD, inc);
    return verdict('SUSPECT', 'no-progress', inc);
  }
  // No turn open. The screen is moving where nothing says a turn ended: busy (not judged idle).
  if (w.lifecycle === 'unknown' && ptyAt > 0 && now - ptyAt < WORKER_WAKE_IDLE_MS) return verdict('BUSY_PROGRESSING', 'pty-traffic', inc);
  if (operatorHold) return verdict('IDLE', LIVENESS_REASON_OPERATOR_HOLD, inc);
  // Mail waiting and the same wake refusal for the stall window (the wake-stall row's condition).
  if (facts.mailWaiting > 0 && memo.wakeRefusalSince !== undefined && now - memo.wakeRefusalSince >= WAKE_STALL_AFTER_MS) {
    return verdict('SUSPECT', 'wake-refusal-stall', inc);
  }
  if (w.lifecycle === 'idle') return verdict('IDLE', 'turn-ended', inc);
  return facts.mailWaiting > 0 ? verdict('UNKNOWN', 'awaiting-wake', inc) : verdict('IDLE', 'quiescent', inc);
}

export interface AgentLivenessDeps {
  /** Every agent the registry knows (live and archived). */
  agents: () => string[];
  /** The facts for one agent, or null when the registry no longer has it. */
  facts: (agentId: string) => LivenessFacts | null;
  /** One durable row per edge (main: hive.appendLog). Called synchronously. */
  sink: (row: Record<string, unknown>) => void;
  now: () => number;
}

export class AgentLivenessMonitor {
  private readonly records = new Map<string, LivenessV1>();
  private readonly memos = new Map<string, Memo>();
  private readonly listeners = new Set<(rec: LivenessV1, prev: LivenessV1 | undefined) => void>();

  constructor(private readonly deps: AgentLivenessDeps) {}

  private memo(agentId: string): Memo {
    let m = this.memos.get(agentId);
    if (!m) { m = {}; this.memos.set(agentId, m); }
    return m;
  }

  /** The latest record (in process). */
  getLiveness(agentId: string): LivenessV1 | undefined {
    return this.records.get(agentId);
  }

  /** Every record held (live, archived, deleted), by agent id. */
  all(): LivenessV1[] {
    return [...this.records.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  /** Fires only when `classification` or `lifecycle` changes. Returns the unsubscribe. */
  onLivenessChange(cb: (rec: LivenessV1, prev: LivenessV1 | undefined) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /** The records that ride in fleet.json: every LIVE one, and a non-LIVE one for a week after its edge. */
  fleetRecords(now = this.deps.now()): LivenessV1[] {
    return this.all().filter((r) => r.lifecycle === 'LIVE' || now - r.classifiedSince < LIVENESS_FLEET_RETAIN_MS);
  }

  /** A PTY incarnation ended (PtyManager's end observer, before its session is removed). */
  notePtyEnd(agentId: string, end: LivenessPtyEnd): void {
    if (!agentId) return;
    const m = this.memo(agentId);
    m.ended = { ...end };
    m.stuck = undefined;
    this.sample(agentId);
  }

  /** A wake refusal for this agent (the bridge's no-claim). `since` = when the current run of the
   *  same refusal began (WakeStallWatch), when known. */
  noteWakeRefusal(agentId: string, at: number, since?: number): void {
    if (!agentId) return;
    const m = this.memo(agentId);
    m.lastWakeRefusalAt = at;
    if (since !== undefined) m.wakeRefusalSince = since;
  }

  /** The agent took a wake (or its refusal run ended): no refusal run is open. */
  clearWakeRefusal(agentId: string): void {
    const m = this.memos.get(agentId);
    if (m) m.wakeRefusalSince = undefined;
  }

  /**
   * The WWR (InboxWakeBridge) is ABOUT to recover this agent (`wwr-recovering`), or gave up after its
   * cap (`wwr-max-recoveries`, offered to the Human). Recorded and persisted synchronously, before the
   * WWR changes anything, so the row exists even if the recovery then throws. Never a decision here.
   */
  noteStuckWake(agentId: string, reason: 'wwr-recovering' | 'wwr-max-recoveries'): LivenessV1 | undefined {
    if (!agentId) return undefined;
    const facts = this.deps.facts(agentId);
    const m = this.memo(agentId);
    m.stuck = { at: this.deps.now(), reason, incarnation: facts?.pty?.incarnation ?? null };
    return this.sample(agentId, facts);
  }

  /** Recompute every agent (the 15-second beat). Agents that left the registry become DELETED. */
  sampleAll(): void {
    const ids = new Set(this.deps.agents());
    for (const id of this.records.keys()) ids.add(id);
    for (const id of [...ids].sort()) {
      try { this.sample(id); } catch { /* one agent's facts never take the beat down */ }
    }
  }

  /** Recompute one agent; appends one row and notifies only on a classification/lifecycle edge. */
  sample(agentId: string, preread?: LivenessFacts | null): LivenessV1 | undefined {
    const now = this.deps.now();
    const facts = preread !== undefined ? preread : this.deps.facts(agentId);
    const prev = this.records.get(agentId);
    if (!facts && !prev) return undefined;   // never known: nothing to delete
    const m = this.memo(agentId);
    if (facts) this.fold(m, facts);
    const v = classifyLiveness(facts, m, prev, now);
    if (v.incarnation !== 'none') m.lastIncarnation = v.incarnation;
    const edge = !prev || prev.classification !== v.classification || prev.lifecycle !== v.lifecycle;
    const rec: LivenessV1 = {
      agentId,
      incarnation: v.incarnation,
      lifecycle: v.lifecycle,
      ...(v.lifecycle === 'ARCHIVED' && v.archivedAt !== undefined ? { archivedAt: v.archivedAt } : {}),
      ...(v.lifecycle === 'ARCHIVED' ? { archiveReason: v.archiveReason ?? 'explicit' } : {}),
      classification: v.classification,
      classifiedSince: edge ? now : prev!.classifiedSince,
      reason: v.reason,
      evidence: v.evidence
    };
    this.records.set(agentId, rec);
    if (edge) {
      try { this.deps.sink({ kind: 'liveness', ...rec }); } catch { /* the sink logs its own failures */ }
      for (const cb of [...this.listeners]) { try { cb(rec, prev); } catch { /* a listener never breaks the monitor */ } }
    }
    return rec;
  }

  /** Fold this sample's facts into the memo: rollout maxima, and the end of a stale STUCK mark. */
  private fold(m: Memo, f: LivenessFacts): void {
    const r = f.rollout;
    if (r && Number.isFinite(r.at)) {
      if (r.kind === 'started') m.lastRolloutStartedAt = Math.max(m.lastRolloutStartedAt ?? 0, r.at);
      else m.lastRolloutCompleteAt = Math.max(m.lastRolloutCompleteAt ?? 0, r.at);
    }
    // A newer incarnation is live: the ended one is history.
    if (m.ended && f.pty && f.pty.incarnation !== m.ended.incarnation) m.ended = undefined;
    const s = m.stuck;
    if (s) {
      const w = f.wake;
      const progressed = (f.pty?.incarnation ?? null) !== s.incarnation
        || f.mailWaiting === 0
        || w.turnStartAt > s.at
        || w.lastTurnEndAt > s.at
        || (r?.kind === 'started' && r.at > s.at);
      if (progressed) m.stuck = undefined;
    }
  }

  /** Forget everything about an agent (tests; never called on a PTY exit: CRASHED must survive it). */
  forget(agentId: string): void {
    this.records.delete(agentId);
    this.memos.delete(agentId);
  }
}
