/**
 * The pre-M1 event-wake bridge: ONE path from "something that could let an agent take a
 * turn" to one guarded inbox-wake submit (plan: floor-self-advance-PLAN.md, section 3).
 *
 *   durable inbox write ─┐
 *   Stop / idle hook ────┤
 *   control release ─────┼─ scheduleWake (setImmediate, coalesced per agent) ─┐
 *   capacity change ─────┤                                                     ├─ requestInboxWake
 *   SEND_AGAIN ──────────┘                        15s reconciliation beat ─────┘
 *
 * `requestInboxWake` re-reads the inbox (the files are authoritative), reconciles the
 * coordinator, gathers the live facts, takes the coordinator's one in-flight claim and
 * submits it through the owner as CAPACITY_GATED work with the claim's stable request id.
 * Every outcome is settled; nothing retries recursively. There is no god branch and no
 * direct PTY write: god wakes exactly as a worker does.
 *
 * The primary path uses `setImmediate` (never a delay or an interval), which also lets the
 * HookServer finish its synchronous Stop response before any submit is attempted.
 * Electron-free; every effect is injected.
 */
import { WORKER_WAKE_IDLE_MS, type TurnEndProof, type InterferenceHow, type ProviderStatus, type WakeCause, type WakeClaim, type WakeMode, type WorkerWakeFacts, type WorkerWakeWatchdog } from './workerWake';

/** §11.10: this many wakes in a row, with no mail block (or no hook traffic at all), degrade. */
export const MAIL_DEGRADE_AFTER_WAKES = 3;

/**
 * ZT-I1-MAIL slice 3: the ledger side of the wake path (main wires HookServer + MailLedger in;
 * absent in deployments and tests that predate the ledger: nothing below runs then).
 */
export interface InboxWakeMail {
  /** The agent's mail channel mode (inject | legacy-read | legacy-move | work-order). */
  mode(agentId: string): string;
  /** Codex (§1.1): rollout task_complete for the SAME turn id closes that turn's epoch. */
  closeTurn(agentId: string, turnId: string): void;
  /** §1.1 submit-unconfirmed: the epochs opened since the carrying wake's claim end abnormally.
   *  `reason` names the abnormal end (default submit-unconfirmed; the stall watchdog: stuck-active). */
  abortSince(agentId: string, since: number, reason?: string): void;
  /** §1.1 / §11.4 backstop: epochs older than 30 min end abnormally (the bridge applies the idle
   *  gate). Returns the epochs closed. */
  closeStale(agentId: string, now: number): string[];
  /** Does the agent have a surfacing epoch open in the ledger? */
  hasOpenEpoch(agentId: string): boolean;
  /** N1 (layer-b dry run #4): the agent's DELIVERED ids whose consecutive unconfirmed surfacings
   *  reached MAIL_UNCONFIRMED_FALLBACK_AFTER (their next surfacing confirms on latency alone).
   *  Optional: absent, nothing is N1-due (the once-budget alone, as before). */
  n1DueIds?(agentId: string): string[];
  /** The agent's ids OPEN in the ledger but not delivered (surfacing, surfaced): reconcile keeps
   *  their re-offer state. Optional: absent, none (as before). */
  openIds?(agentId: string): string[];
  /** §11.10: switch to legacy-read, log `mail-channel-degraded`, raise the UI alert. */
  degrade(agentId: string, reason: 'no-mail-block' | 'zero-hook-traffic', detail: Record<string, unknown>): boolean;
  /** One durable hive log row (main: hive.appendLog). Optional: absent, nothing is logged. */
  log?(row: Record<string, unknown>): void;
  /** READS-QUIET-NOREPLY (1.1.81): of these pending ids, the quiet ones that may still wait at
   *  `now`, each with the time its hold ends (main: shared/mailWakeClass.quietHolds over the
   *  ledger). Optional: absent, or a throw, holds nothing (every id wakes, as before). */
  quietUntil?(agentId: string, ids: readonly string[], now: number): ReadonlyMap<string, number>;
}

/** §11.10: per agent, the wake-by-wake evidence that the mail channel works. */
interface DegradeWatch {
  /** COMMITTED wakes since the last hook traffic from the agent (trigger B). */
  quiet: number;
  /** Consecutive confirmed wake turns that returned no mail block while their ids waited (A). */
  streak: number;
  /** The wake whose turn is being watched. */
  open: { claimedAt: number; ids: readonly string[]; blocks: number } | null;
  degraded: boolean;
  /** §11.19 #1: when a mail block last reached this agent (0 = never), watch or no watch. A block
   *  built between a wake's CLAIM and its COMMITTED (the turn's hook raced the settle), and then
   *  flushed late, used to fall outside every watch: the wake counted as "no mail block" and three
   *  of them degraded a working channel (dry runs #3/#4 B5). */
  lastBlockAt: number;
}

export interface InboxWakeSubmit {
  requestId: string;
  agentId: string;
  admissionClass: 'CAPACITY_GATED';
  text: string;
  /** The text of an earlier nudge that was never confirmed as a turn (WakeClaim.recheck):
   *  the owner must see it absent from the prompt before typing this one. */
  priorText?: string;
}

export interface InboxWakeBridgeDeps {
  coordinator: WorkerWakeWatchdog;
  /** The agent's undrained inbox ids, read from disk NOW. */
  inboxIds: (agentId: string) => string[];
  /** Live facts (PTY, last output, control flags, owner inhibition), or null for no terminal. */
  facts: (agentId: string) => Omit<WorkerWakeFacts, 'agentId'> | null;
  /** AutomaticSubmitOwner.submit - the ONLY way a wake reaches a terminal. */
  submit: (req: InboxWakeSubmit) => Promise<{ kind: string }>;
  /** The provider-aware visible payload for a batch of ids. */
  text: (ids: readonly string[], agentId?: string) => string;
  setImmediate: (fn: () => void) => void;
  now: () => number;
  log?: (line: string) => void;
  /** DIAGNOSIS ONLY (diag-1.1.46-wake): one durable breadcrumb per stage of the wake path.
   *  `log` above is console.log, which a PACKAGED Windows Electron app throws away — which
   *  is precisely why the 1.1.46 canary could not say where the path died. This one writes
   *  to the hive event log instead, so the evidence survives the run. */
  diag?: (stage: string, fields: Record<string, unknown>) => void;
  /** FALSEACTIVE-STALL-2 (B1): Codex's own record of its newest turn boundary for this agent,
   *  read from a bounded rollout tail. Undefined = not a Codex agent (no probe). Optional so
   *  every existing deployment and test runs unchanged. */
  codexTurnProbe?: (agentId: string) => import('./codexRolloutLifecycle').CodexLifecycleProbe | undefined;
  /** CODEX-FALSEACTIVE-153: does this agent's provider report its own turn starts? Then
   *  our COMMITTED epoch is provisional until it does. Absent = no (the plain reading). */
  confirmsTurnStart?: (agentId: string) => boolean;
  /** ZT-I1-MAIL slice 3: the mail ledger's epochs and channel (see InboxWakeMail). */
  mail?: InboxWakeMail;
  /** ZERO-TOKEN-LIVENESS: told (synchronously) BEFORE the WWR recovers an agent or reports that it
   *  gave up. Observation only. Optional: absent, the WWR runs exactly as in 1.1.76. */
  liveness?: { stuckWake(agentId: string, reason: 'wwr-recovering' | 'wwr-max-recoveries'): void };
}

export class InboxWakeBridge {
  /** Agents with a wake already scheduled this turn (event coalescing). */
  private readonly scheduled = new Map<string, WakeCause>();

  constructor(private readonly deps: InboxWakeBridgeDeps) {}

  /** Coalesce every event for this agent in this turn into one attempt, after the turn. */
  scheduleWake(agentId: string, cause: WakeCause): void {
    if (!agentId) { this.deps.diag?.('schedule', { agentId, cause, took: 'no-agent-id' }); return; }
    if (this.scheduled.has(agentId)) { this.deps.diag?.('schedule', { agentId, cause, took: 'coalesced' }); return; }
    this.scheduled.set(agentId, cause);
    this.deps.diag?.('schedule', { agentId, cause, took: 'armed' });
    this.deps.setImmediate(() => {
      const c = this.scheduled.get(agentId) ?? cause;
      this.scheduled.delete(agentId);
      // A throw here would otherwise be an uncaught exception in main with nothing said.
      // Reported, then rethrown: the diagnosis branch must not change what happens.
      try {
        this.requestInboxWake(agentId, c, 'event');
      } catch (e) {
        this.deps.diag?.('throw', { agentId, cause: c, mode: 'event', error: String(e) });
        throw e;
      }
    });
  }

  /** THE one wake path, for events and reconciliation alike. Returns the claim it submitted. */
  requestInboxWake(agentId: string, cause: WakeCause, mode: WakeMode, readIds?: string[]): WakeClaim | null {
    const { coordinator } = this.deps;
    this.deps.diag?.('enter', { agentId, cause, mode });
    // The beat passes the ids it has just read and reconciled: one inbox read per beat.
    const ids = readIds ?? this.deps.inboxIds(agentId);
    if (!readIds) coordinator.reconcile(agentId, ids, this.openIds(agentId));
    const f = this.deps.facts(agentId);
    const now = this.deps.now();
    this.holdQuiet(agentId, now);
    this.deps.diag?.('facts', {
      agentId, cause, mode,
      inboxIds: ids.length,
      pty: f?.ptyId ?? null,
      idleMs: f && f.lastOutputAt > 0 ? now - f.lastOutputAt : null,
      paused: f?.paused ?? null, halted: f?.halted ?? null,
      autoDeliveryPaused: f?.autoDeliveryPaused ?? null, inhibited: f?.inhibited ?? null
    });
    const claim = coordinator.claim(
      f ? { agentId, ...f } : { agentId, lastOutputAt: 0, autoDeliveryPaused: false, paused: false, halted: false },
      cause, mode, now);
    if (!claim) {
      this.deps.diag?.('no-claim', { agentId, cause, mode, why: coordinator.whyNoClaim(agentId), inboxIds: ids.length });
      return null;
    }
    this.deps.diag?.('claim', { agentId, cause, mode, ids: claim.ids.length, requestId: claim.requestId });
    if (claim.quietReleased) {
      this.deps.diag?.('hold-released', { agentId, reason: claim.quietReleased.reason, ids: claim.quietReleased.ids.length, idList: claim.quietReleased.ids, requestId: claim.requestId });
    }
    this.deps.log?.(`[inbox-wake] claim ${agentId} cause=${cause} mode=${mode} ids=${claim.ids.length}`);
    let submitted: Promise<{ kind: string }>;
    try {
      submitted = this.deps.submit({
        requestId: claim.requestId,
        agentId,
        admissionClass: 'CAPACITY_GATED',
        text: this.deps.text(claim.ids, agentId),
        ...(claim.recheck ? { priorText: this.deps.text(claim.recheck, agentId) } : {})
      });
      this.deps.diag?.('submit', { agentId, cause, mode, requestId: claim.requestId });
    } catch (e) {
      this.deps.diag?.('submit-threw', { agentId, cause, mode, error: String(e) });
      submitted = Promise.resolve({ kind: 'FAILED' });
    }
    void submitted
      .then((outcome) => outcome ?? { kind: 'FAILED' }, () => ({ kind: 'FAILED' }))
      .then((outcome: { kind: string; reason?: unknown; detail?: unknown }) => {
        const kind = outcome.kind;
        // CAPACITY-DUP-CONFIRM-163: `detail` carries WHY (for CAPACITY_HOLD, the admission
        // basis such as UNKNOWN:INDETERMINATE); without it a hold's cause is invisible.
        this.deps.diag?.('settle', {
          agentId, cause, mode, outcome: kind,
          ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}),
          ...(typeof outcome.detail === 'string' ? { detail: outcome.detail.slice(0, 200) } : {}),
          requestId: claim.requestId
        });
        const settled = coordinator.settle(claim, kind, this.deps.now(), kind === 'COMMITTED' && (this.deps.confirmsTurnStart?.(agentId) ?? false));
        if (kind === 'COMMITTED') this.noteMailCommit(agentId, claim);
        // P1: the claim's typed turn already ended before this COMMITTED. Its Stop's repend skipped
        // the in-flight ids; they go through THE SAME repend() now (spent once, n1Due honoured).
        if (settled && settled.endedBeforeSettle) this.onMailEpochClosed(agentId, 'normal', 'stop-before-settle');
        this.deps.log?.(`[inbox-wake] ${kind === 'COMMITTED' ? 'commit' : 'release'} ${agentId} cause=${cause} outcome=${kind}`);
      });
    return claim;
  }

  /**
   * READS-QUIET-NOREPLY (1.1.81): before every claim, the pending ids that are quiet mail still
   * inside their hold leave pending (WorkerWakeWatchdog.hold), so they cannot start a turn on their
   * own; the claim releases them when the oldest hold ends or when other mail wakes the agent.
   * Fails open: no ledger answer = no hold.
   */
  private holdQuiet(agentId: string, now: number): void {
    const quietUntil = this.deps.mail?.quietUntil;
    if (!quietUntil) return;
    const pending = this.deps.coordinator.state(agentId).pending;
    if (!pending.length) return;
    let holds: ReadonlyMap<string, number>;
    try { holds = quietUntil(agentId, pending, now); } catch { return; }
    const held = this.deps.coordinator.hold(agentId, holds, now);
    if (held.length) {
      this.deps.diag?.('held', { agentId, ids: held.length, idList: held, until: Math.min(...held.map((id) => holds.get(id) ?? now)) });
    }
  }

  /** Hive delivery observer: a durable inbox write landed. */
  onDelivery(agentId: string, messageId: string): void {
    const fresh = this.deps.coordinator.noteDelivery(agentId, messageId);
    this.deps.diag?.('delivery', { agentId, messageId, fresh });
    this.scheduleWake(agentId, 'delivery');
  }

  /** HookServer observation (before its response): record lifecycle, retry after the turn. */
  onHook(agentId: string | undefined, event: string | undefined, message: string | undefined, fullyIdle?: boolean, turnId?: string, source?: string): void {
    // §11.10 trigger B: any hook from the agent is hook traffic (the status line is not a hook).
    if (agentId && event && event !== 'Status') { const w = this.degradeWatch.get(agentId); if (w) w.quiet = 0; }
    const edge = this.deps.coordinator.noteHook(agentId, event, message, this.deps.now(), fullyIdle, turnId);
    // §11.10 trigger A: the Stop ends the watched wake's turn.
    if (agentId && event === 'Stop' && fullyIdle !== false) this.endMailWatch(agentId);
    // The lifecycle is sourced ONLY here, from the live hook stream - the one input no
    // in-harness test ever drove. Every hook boundary is recorded so a packaged run shows
    // whether Stop/Notification ever arrive at all, and what the lifecycle became.
    this.deps.diag?.('hook', { agentId: agentId ?? null, event: event ?? null, edge, ...(turnId ? { turn: turnId } : {}), ...(source ? { source } : {}) });
    if (edge && agentId) {
      this.scheduleWake(agentId, 'hook');
    }
  }

  /**
   * A provider-native status reading (today: one validated Antigravity statusline tick).
   *
   * It rides the SAME scheduling path as a hook edge, deliberately: a native idle is one
   * more observation that an agent may be able to take a turn, not a new authority. It
   * coalesces with hook and delivery edges for the turn, goes through `requestInboxWake`,
   * and is refused by every guard a hook-driven wake is refused by. No second request id,
   * no second submit owner, no direct PTY write — the 1.1.46 lesson is that a second
   * producer is a second turn, and there is still exactly one.
   */
  onProviderStatus(agentId: string | undefined, status: ProviderStatus, sessionId: string | null = null, readAt?: number): void {
    // `readAt` is when the shim READ the status. It is passed through in preference to the
    // delivery clock because delivery order says nothing about reading order - the whole
    // point of the coordinator's ordering guard. Absent one, the delivery clock stands in.
    const at = typeof readAt === 'number' && Number.isFinite(readAt) ? readAt : this.deps.now();
    const edge = this.deps.coordinator.noteProviderStatus(agentId, status, at, sessionId);
    // The session is a breadcrumb, not a secret: it is the provider's own conversation id
    // and is exactly what a packaged run needs to explain a discarded tick.
    this.deps.diag?.('provider-status', { agentId: agentId ?? null, status, session: sessionId, at, edge });
    if (edge && agentId) this.scheduleWake(agentId, 'hook');
  }

  /** A blocking control state cleared (unpause, resume, auto-delivery release). */
  onControlRelease(agentId: string): void {
    this.scheduleWake(agentId, 'control');
  }

  /** Capacity changed: retry every agent that still has pending ids (admission decides). */
  onCapacityChange(): void {
    for (const agentId of this.deps.coordinator.pendingAgents()) this.scheduleWake(agentId, 'capacity');
  }

  /** A human resolved an INTERFERED hold. SEND_AGAIN goes back through every guard;
   *  ALREADY_HANDLED resolves the ids with no further submit. */
  onInterferenceResolved(agentId: string, how: InterferenceHow): void {
    if (this.deps.coordinator.resolveInterference(agentId, how) && how === 'SEND_AGAIN') {
      this.scheduleWake(agentId, 'interference');
    }
  }

  // — ZT-I1-MAIL slice 3: epochs and the ledger (§11.3, §11.10, §1.1 backstop) —

  /**
   * §11.3: a mail epoch of this agent closed (its Stop, a Codex task_complete, or an abnormal end:
   * StopFailure, an interrupt, a new session, PTY exit/respawn, submit-unconfirmed, the backstop).
   * Every id a wake announced that the ledger still calls delivered returns to pending ONCE, then
   * the F4 backoff. HookServer calls this BEFORE it reports the hook itself, so a Stop's own retry
   * edge picks the re-pended ids up.
   *
   * §11.18 #41 (Q38): at ANY Stop (and a StopFailure, which ends the turn too, #43) this happens
   * whether or not the turn start was confirmed: provider-neutral, and harmless because an id that
   * is still delivered never reached the model. That case is logged as a `mail-repend` row with
   * `unconfirmedStart: true`.
   */
  onMailEpochClosed(agentId: string, outcome: 'normal' | 'abnormal', reason: string, redelivered: readonly string[] = []): void {
    if (!agentId) return;
    const delivered = this.deps.inboxIds(agentId);
    const turnEnded = reason === 'stop' || reason === 'stop-failure' || reason === 'stop-before-settle';
    let n1Due: string[] = [];
    try { n1Due = this.deps.mail?.n1DueIds?.(agentId) ?? []; } catch { n1Due = []; }
    const r = this.deps.coordinator.repend(agentId, delivered, this.deps.now(), { turnEnded, n1Due });
    if (!r.requeued.length && !r.exhausted.length) return;
    if (r.unconfirmedStart) {
      try {
        this.deps.mail?.log?.({ kind: 'mail-repend', agentId, reason, outcome, unconfirmedStart: true, requeued: r.requeued, ...(r.exhausted.length ? { exhausted: r.exhausted } : {}) });
      } catch { /* logging never breaks the wake path */ }
    }
    this.deps.diag?.('wake-repend', { agentId, outcome, reason, requeued: r.requeued.length, redelivered: redelivered.length, ...(r.requeued.length ? { idList: r.requeued } : {}), ...(r.n1.length ? { n1: r.n1 } : {}) });
    if (r.exhausted.length) this.deps.diag?.('wake-ids-exhausted', { agentId, ids: r.exhausted.length, idList: r.exhausted, attempt: r.attempt, retryInMs: r.retryInMs, requeued: r.requeued.length });
    if (r.requeued.length) this.scheduleWake(agentId, 'hook');
  }

  /** The ledger's open-but-not-delivered ids (reconcile keeps their re-offer state). */
  private openIds(agentId: string): string[] {
    try { return this.deps.mail?.openIds?.(agentId) ?? []; } catch { return []; }
  }

  /** §11.10: a mail block was returned to this agent (HookServer). */
  onMailBlock(agentId: string): void {
    // §11.19 #1: the degrade counts only wakes whose hook ran and built NO block. A block, whenever
    // it was built (inside the watch, before the COMMITTED that opens it, or after the watch ended)
    // and however late its response flushed (late is N1's business, never the degrade's), proves
    // the channel reaches the agent: the no-mail-block streak starts over.
    let w = this.degradeWatch.get(agentId);
    if (!w) { w = { quiet: 0, streak: 0, open: null, degraded: false, lastBlockAt: 0 }; this.degradeWatch.set(agentId, w); }
    w.lastBlockAt = this.deps.now();
    w.streak = 0;
    if (w.open) w.open.blocks += 1;
  }

  private readonly degradeWatch = new Map<string, DegradeWatch>();

  private degradeFor(agentId: string): DegradeWatch | null {
    const mail = this.deps.mail;
    if (!mail) return null;
    let w = this.degradeWatch.get(agentId);
    if (!w) { w = { quiet: 0, streak: 0, open: null, degraded: false, lastBlockAt: 0 }; this.degradeWatch.set(agentId, w); }
    if (w.degraded) return null;
    let mode = '';
    try { mode = mail.mode(agentId); } catch { mode = ''; }
    return mode === 'inject' ? w : null;
  }

  /** §11.10 trigger A: the watched wake's turn is over (its Stop, or the next wake). */
  private endMailWatch(agentId: string): void {
    const w = this.degradeWatch.get(agentId);
    const open = w?.open;
    if (!w || !open) return;
    w.open = null;
    // A block built since this wake's CLAIM counts for it, even one whose hook raced the settle.
    if (open.blocks > 0 || (open.claimedAt > 0 && w.lastBlockAt >= open.claimedAt)) { w.streak = 0; return; }
    const facts = this.deps.coordinator.turnFacts(agentId);
    const confirmed = facts.turnStartAt >= open.claimedAt && open.claimedAt > 0;
    const pending = new Set(this.deps.inboxIds(agentId));
    // A wake whose mail already reached the agent another way (a human turn) proves nothing.
    if (!confirmed || !open.ids.some((id) => pending.has(id))) return;
    w.streak += 1;
    if (w.streak >= MAIL_DEGRADE_AFTER_WAKES) this.degrade(agentId, w, 'no-mail-block', { wakes: w.streak });
  }

  /** §11.10: a wake COMMITTED for this agent. Trigger B counts it; trigger A starts watching it. */
  private noteMailCommit(agentId: string, claim: WakeClaim): void {
    const w = this.degradeFor(agentId);
    if (!w) return;
    this.endMailWatch(agentId);
    if (w.degraded) return;
    w.quiet += 1;
    w.open = { claimedAt: this.deps.coordinator.turnFacts(agentId).claimedAt, ids: claim.ids, blocks: 0 };
    if (w.quiet >= MAIL_DEGRADE_AFTER_WAKES) this.degrade(agentId, w, 'zero-hook-traffic', { wakes: w.quiet });
  }

  private degrade(agentId: string, w: DegradeWatch, reason: 'no-mail-block' | 'zero-hook-traffic', detail: Record<string, unknown>): void {
    w.degraded = true;
    w.open = null;
    let changed = false;
    try { changed = this.deps.mail?.degrade(agentId, reason, detail) ?? false; } catch { changed = false; }
    this.deps.diag?.('mail-channel-degraded', { agentId, reason, changed, ...detail });
  }

  /**
   * §1.1 / §11.4 last backstop: a surfacing epoch open for 30 minutes with no Stop closes as
   * abnormal, ONLY while the lifecycle is idle by the existing signals (recorded idle, or unknown
   * with a quiescent PTY, or no PTY at all): long active turns are never cut. Once per epoch (a
   * closed epoch is not open any more).
   */
  private closeStaleMail(agentId: string): void {
    const mail = this.deps.mail;
    if (!mail) return;
    const now = this.deps.now();
    const st = this.deps.coordinator.state(agentId);
    const f = this.deps.facts(agentId);
    const quiet = !f || (f.lastOutputAt > 0 && now - f.lastOutputAt >= WORKER_WAKE_IDLE_MS);
    if (!(st.lifecycle === 'idle' || (st.lifecycle === 'unknown' && quiet))) return;
    const closed = mail.closeStale(agentId, now);
    if (closed.length) this.deps.diag?.('mail-epoch-stale', { agentId, epochs: closed.length });
  }

  /** Agents a missing/unreadable rollout was already reported for (log once per agent). */
  private readonly rolloutReported = new Set<string>();

  /**
   * FALSEACTIVE-STALL-2 (B1): before the beat's claim, an agent that is ACTIVE with mail
   * waiting may have lost its Stop. Ask Codex's rollout (bounded tail) whether the open turn
   * completed, and close it only with that proof. Everything else fails closed.
   */
  private closeLostCodexTurn(agentId: string, inboxIds: readonly string[]): void {
    const probeFn = this.deps.codexTurnProbe;
    if (!probeFn) return;
    const st = this.deps.coordinator.state(agentId);
    if (st.lifecycle !== 'active') return;
    // A provisional epoch is probed with or without mail: its confirmation is a turn START. So
    // is a turn with a mail epoch open (ZT-I1-MAIL: its task_complete makes that mail acted).
    let mailOpen = false;
    try { mailOpen = this.deps.mail?.hasOpenEpoch(agentId) ?? false; } catch { mailOpen = false; }
    if (inboxIds.length === 0 && !st.provisional && !mailOpen) return;   // nothing waiting: nothing is stuck
    const probe = probeFn(agentId);
    if (!probe) return;                                      // not a Codex agent
    if (!probe.ok) {
      if (!this.rolloutReported.has(agentId)) {
        this.rolloutReported.add(agentId);
        this.deps.diag?.('codex-rollout', { agentId, closed: false, why: probe.why });
      }
      return;
    }
    this.rolloutReported.delete(agentId);
    const latest = probe.latest;
    // WAKE-CODEX-FALSECONFIRM: a completion is NEVER a start. The rollout may replay the
    // previous task_complete after our claim; only a new task_started can prove this Enter.
    if (latest?.kind === 'started' && st.provisional
      && this.deps.coordinator.noteProviderTurnStarted(agentId, latest.turnId, latest.at)) {
      this.deps.diag?.('codex-rollout', { agentId, confirmed: true, turn: latest.turnId, at: latest.at });
    }
    if (!latest || latest.kind !== 'complete') return;       // no boundary, or a turn is running
    if (this.deps.coordinator.recoverStuckCodexActive(agentId, latest.at, this.deps.now())) {
      this.deps.diag?.('codex-stuck-active', { agentId, recovered: true, turn: latest.turnId, at: latest.at });
    }
    const closed = this.deps.coordinator.noteProviderTurnEnded(agentId, latest.turnId, latest.at);
    if (closed) {
      this.deps.diag?.('codex-rollout', { agentId, closed: true, turn: latest.turnId, at: latest.at });
      // §1.1: task_complete for the SAME turn id is a closing source (the ledger epoch is keyed
      // by that turn id, so a stale completion of an earlier turn can never act this turn's mail).
      try { this.deps.mail?.closeTurn(agentId, latest.turnId); } catch { /* the ledger logs its own failures */ }
      this.endMailWatch(agentId);
    }
  }

  /**
   * WAKE-WATCHDOG-RECOVERY (P1b): recover an agent stuck ACTIVE with mail waiting (the decision
   * is workerWake.recoverStuckActive). Deterministic, zero model tokens, and it never submits
   * anything itself: it only ends the stuck epoch, and the reconcile claim below re-offers the
   * mail through every existing guard and the one submit owner. A human hold (paused, halted,
   * auto-delivery paused, an INTERFERED inhibition) is a decision, never a stall.
   *
   * Codex (CODEX-STOP-MISSING): when the rollout's newest turn boundary is a task_complete, that
   * is the provider's proof the turn ended; the epoch closes (to unknown) after a short hook silence,
   * and the turn's mail epoch closes normally, as a Stop would have. Otherwise, after the long
   * quiet window, the open mail epochs end abnormally (`stuck-active`), so their delivered ids go
   * back to pending once (then the F4 backoff).
   */
  private recoverStuckActive(agentId: string, inboxIds: readonly string[]): void {
    if (inboxIds.length === 0) return;
    const st = this.deps.coordinator.state(agentId);
    if (st.lifecycle !== 'active' || st.provisional) return;
    const f = this.deps.facts(agentId);
    if (!f || f.paused || f.halted || f.autoDeliveryPaused || f.inhibited) return;
    let proof: TurnEndProof | null = null;
    const probe = this.deps.codexTurnProbe?.(agentId);
    // The provider's own record says a turn is RUNNING (newest boundary task_started): D3 holds,
    // silence never overrides it, not even the quiet rule.
    if (probe && probe.ok && probe.latest?.kind === 'started') return;
    if (probe && probe.ok && probe.latest?.kind === 'complete') proof = { turnId: probe.latest.turnId, at: probe.latest.at };
    const now = this.deps.now();
    // ZERO-TOKEN-LIVENESS: RECORD FIRST. The same predicate, read without changing anything; the
    // liveness monitor persists STUCK_WAKE (one log row, synchronously) before the recovery below
    // changes the epoch. The monitor decides nothing: the WWR stays the only recovery owner.
    const pre = this.deps.liveness ? this.deps.coordinator.assessStuckActive(agentId, f, inboxIds.length, now, proof) : null;
    if (pre) {
      try { this.deps.liveness?.stuckWake(agentId, pre.kind === 'gave-up' ? 'wwr-max-recoveries' : 'wwr-recovering'); }
      catch { /* a liveness failure never blocks the recovery */ }
    }
    const out = this.deps.coordinator.recoverStuckActive(agentId, f, inboxIds.length, now, proof);
    if (!out) return;
    const row = { agentId, basis: out.basis, quietMs: out.quietMs, activeSince: out.activeSince, ids: inboxIds.length };
    if (out.kind === 'gave-up') {
      this.deps.diag?.('stuck-active', { ...row, recovered: false, why: 'max-recoveries', recoveries: out.recoveries });
      try { this.deps.mail?.log?.({ kind: 'wake-stuck-active', ...row, recovered: false, why: 'max-recoveries', recoveries: out.recoveries }); } catch { /* logging never breaks the beat */ }
      return;
    }
    this.deps.diag?.('stuck-active', { ...row, recovered: true, recovery: out.recovery, ...(out.turnId ? { turn: out.turnId } : {}) });
    try { this.deps.mail?.log?.({ kind: 'wake-stuck-active', ...row, recovered: true, recovery: out.recovery, ...(out.turnId ? { turn: out.turnId } : {}) }); } catch { /* logging never breaks the beat */ }
    if (out.basis === 'rollout-complete' && out.turnId) {
      try { this.deps.mail?.closeTurn(agentId, out.turnId); } catch { /* the ledger logs its own failures */ }
    } else {
      try { this.deps.mail?.abortSince(agentId, 0, 'stuck-active'); } catch { /* best effort */ }
    }
    this.endMailWatch(agentId);
    this.recovered.add(agentId);
  }

  /**
   * ZERO-TOKEN-LIVENESS: a PERSON clicked "re-offer mail" on an agent the watchdog gave up on
   * (liveness STUCK_WAKE / wwr-max-recoveries). The stuck epoch ends (to `unknown`) and its mail
   * epochs end abnormally, exactly as a quiet recovery; the next reconcile beat re-offers through
   * every guard (12 s PTY quiet, the fresh rollout check, the submit owner). Nothing is submitted
   * here, and nothing but this click calls it. Returns false when there is nothing to re-offer.
   */
  onOperatorReoffer(agentId: string): boolean {
    if (!agentId || !this.deps.coordinator.operatorReoffer(agentId, this.deps.inboxIds(agentId))) return false;
    try { this.deps.mail?.abortSince(agentId, 0, 'operator-reoffer'); } catch { /* best effort */ }
    this.endMailWatch(agentId);
    this.recovered.add(agentId);
    this.deps.diag?.('stuck-active', { agentId, recovered: true, why: 'operator-reoffer' });
    return true;
  }

  /** Agents the watchdog recovered whose mail was not re-offered yet (see reofferHeld). */
  private readonly recovered = new Set<string>();

  /**
   * god (WWR audit ruling): before the re-offer after a recovery, a FRESH provider check. While
   * the recovered lifecycle is `unknown`, the reconcile claim already needs 12 s of PTY quiet
   * (claim); for Codex, the rollout is read again right before it, and a turn that STARTED since
   * holds the re-offer this beat (the turn's own hooks then take the lifecycle back to active).
   * Cost: one bounded rollout-tail read per beat, only for a recovered Codex agent until its
   * re-offer (the probe re-reads only when the file changed). Returns true to hold the claim.
   */
  private reofferHeld(agentId: string): boolean {
    if (!this.recovered.has(agentId)) return false;
    if (this.deps.coordinator.state(agentId).lifecycle !== 'unknown') { this.recovered.delete(agentId); return false; }
    const probe = this.deps.codexTurnProbe?.(agentId);
    if (probe && probe.ok && probe.latest?.kind === 'started') {
      this.deps.diag?.('stuck-active', { agentId, recovered: true, reoffer: 'held', why: 'rollout-running' });
      return true;
    }
    return false;
  }

  /** The reconciliation beat: the same path, in reconcile mode, over every live agent. */
  reconcileAll(agentIds: readonly string[]): void {
    for (const agentId of agentIds) {
      // Per agent, so one throwing agent cannot silently take the whole beat down with it
      // (today it does: runWorkerWakeBeat catches at the top and the rest of the fleet is
      // skipped every tick, forever). Reported, then rethrown - unchanged behaviour.
      try {
        const ids = this.deps.inboxIds(agentId);
        this.deps.coordinator.reconcile(agentId, ids, this.openIds(agentId));
        try { this.closeLostCodexTurn(agentId, ids); }
        catch (e) { this.deps.diag?.('codex-rollout', { agentId, closed: false, why: 'probe-threw', error: String(e) }); }
        // WAKE-WATCHDOG-RECOVERY: after B1 (which needs the exact turn), before the beat's edges.
        try { this.recoverStuckActive(agentId, ids); }
        catch (e) { this.deps.diag?.('stuck-active', { agentId, recovered: false, why: 'threw', error: String(e) }); }
        // The beat's own lifecycle edges (deferred idle, unconfirmed submit, F4 retry), after the
        // reconcile so ids that are no longer delivered are not re-pended.
        const claimedAt = this.deps.coordinator.turnFacts(agentId).claimedAt;
        const edge = this.deps.coordinator.beat(agentId, this.deps.now());
        if (edge && (edge.kind === 'submit-unconfirmed' || edge.kind === 'wake-ids-exhausted') && claimedAt > 0) {
          // §1.1: submit-unconfirmed ends the carrying wake's epoch abnormally.
          try { this.deps.mail?.abortSince(agentId, claimedAt); } catch { /* best effort */ }
        }
        try { this.closeStaleMail(agentId); } catch { /* best effort */ }
        if (edge) {
          this.deps.diag?.(edge.kind, {
            agentId, ...('ids' in edge ? { ids: edge.ids.length } : {}),
            // CODEX-WAKE-161 F4: say WHICH mail keeps failing, and when it is offered again.
            ...(edge.kind === 'wake-ids-exhausted' ? { idList: edge.ids, attempt: edge.attempt, retryInMs: edge.retryInMs, requeued: edge.requeued.length } : {}),
            ...(edge.kind === 'wake-retry' ? { idList: edge.ids, attempt: edge.attempt } : {})
          });
        }
        if (this.reofferHeld(agentId)) continue;   // WAKE-WATCHDOG-RECOVERY: fresh rollout check
        this.requestInboxWake(agentId, 'reconcile', 'reconcile', ids);
      } catch (e) {
        this.deps.diag?.('throw', { agentId, cause: 'reconcile', mode: 'reconcile', error: String(e) });
        throw e;
      }
    }
  }
}
