/**
 * The inbox-wake COORDINATOR (pre-M1 event-wake bridge; was the #151 worker watchdog).
 *
 * WHAT IT DECIDES. Which agent - any agent, god included - gets ONE guarded inbox-wake
 * turn, for which inbox message ids, and what happened to those ids afterwards. It types
 * nothing: every wake goes through the one main-owned submit transaction
 * (`AutomaticSubmitOwner.submit`, CAPACITY_GATED), which owns admission, the prompt and
 * human-input guards, the final revalidation and the Enter.
 *
 * WHO FEEDS IT. Events first: a durable inbox write (`HiveManager.setDeliveryObserver`),
 * hook lifecycle edges (Stop, idle Notification, eligible SubagentStop), control releases
 * and capacity changes. The 15s main beat is RECONCILIATION over the same state - it
 * finds ids a lost callback or a restart missed. Both paths claim through `claim()`; there
 * is no second decision path and no god special case.
 *
 * PER AGENT: one pending set, one in-flight claim, one held (INTERFERED) claim, and
 * per-message-id dedup. Duplicate delivery / hook / control / scan signals coalesce; they
 * can never produce a second turn.
 *
 *  - pendingIds    delivered (ZT-I1-MAIL: the LEDGER's delivered ids, not files on disk), not yet
 *                  in a committed wake;
 *  - announcedIds  in a COMMITTED wake, while still delivered. §11.3: at the close of the wake's
 *                  epoch (Stop or abnormal end) the ones still delivered go back to pending ONCE
 *                  (`repend`), then the F4 backoff applies. Nothing re-offers mail by time alone;
 *  - inFlight      the sole claimed submission (immutable: new mail waits for the next edge);
 *  - held          an INTERFERED claim, until a human says SEND_AGAIN or ALREADY_HANDLED.
 *
 * Ids are ANNOUNCED ONLY AFTER COMMITTED. REFUSED / ABORTED / FAILED / REJECTED release
 * them back to pending; INTERFERED holds them; HUMAN_HANDLED is terminal.
 *
 * No electron import, clock injected - every race is driven synchronously in tests.
 */
import { createHash } from 'node:crypto';

// ZT-I1-MAIL §3 / P12: the #151 WORKER_WAKE_NUDGE text (dead since the wake used
// inboxNudgeText) is deleted. The nudge is shared/hiveNudge.ts's inboxNudgeText(ids, mode).

/** Reconciliation fallback: no PTY output for this long = quiescent (renderer QUIESCE_IDLE_MS). */
export const WORKER_WAKE_IDLE_MS = 12_000;
/** Never wake inside the boot sequence (renderer BOOT_GRACE_MS). */
export const WORKER_WAKE_BOOT_GRACE_MS = 35_000;
/** Reconciliation only: minimum gap between two scan-driven attempts for one agent. */
export const WORKER_WAKE_COOLDOWN_MS = 60_000;
/** A permission/HITL notification blocks wakes for this long after it fires. */
export const WORKER_WAKE_HITL_REARM_MS = 5 * 60_000;

/**
 * How long a freshly opened active epoch refuses native IDLE readings (Jim, c4 audit).
 *
 * A statusline tick is dated by GENERATION, not by arrival. Several are in flight at once
 * (one short-lived shim process per render), and agy keeps truthfully rendering `idle`
 * until it has actually processed the prompt we just typed - the typed nudge itself
 * causes renders. So right after a COMMITTED wake there is a systematically populated
 * window of idle readings that describe the turn BEFORE this one. Believing one closes
 * the epoch we just opened, and because event-mode `claim()` tests only the lifecycle -
 * no quiescence - the next pending message is typed straight into the live turn.
 *
 * Five seconds is several times the render period, so a genuinely idle agent is accepted
 * on the next tick after the grace (the statusline goes on rendering while idle - that is
 * the premise of the duplicate-tick test). Stall recovery is measured in minutes and is
 * untouched. It deliberately does NOT require a running tick first: a turn that finishes
 * inside the grace without ever rendering `working` would otherwise be stuck active,
 * which is the very stall c4 exists to remove.
 */
export const PROVIDER_IDLE_CONFIRM_MS = 5_000;

/**
 * AGY-FALSEACTIVE-STALL (Jim, WAKE-BUGS-152 (1)). How long after a terminal Stop a provider
 * `running` reading is presumed to describe the turn that Stop just ended. On the live floor
 * AGY went on rendering `running` for up to 2.6 s after its own Stop hook, and that stale
 * tick opened a new active epoch nothing would ever close. A reading inside this window
 * opens nothing unless a turn start (our COMMITTED submit, UserPromptSubmit, PreInvocation)
 * came after the Stop.
 */
export const STOP_SETTLE_MS = 5_000;

/**
 * CODEX-FALSEACTIVE-153 (Jim). Our own `COMMITTED` is evidence that the Enter went out, not
 * that the provider started a turn: Dwight's typed nudge never became a Codex turn, and with
 * no turn nothing could ever close the epoch. For a provider that reports turn starts, the
 * epoch our submit opens is PROVISIONAL until the provider confirms one; unconfirmed this
 * long, the lifecycle goes back to `unknown` and the claim's ids are re-pended ONCE.
 */
export const SUBMIT_CONFIRM_MS = 60_000;

/**
 * CODEX-WAKE-161 F4 (Jim, CODEX-WAKE-ROOTCAUSE). A wake whose re-announcement ALSO went
 * unconfirmed used to be dropped silently: its ids stayed "announced" forever and every later
 * claim said `no-pending-ids` while the mail sat on disk. Now it is never silent and never
 * final: a `wake-ids-exhausted` edge (a log row) each time, and the ids are offered again after
 * a backoff (5, 10, 20, then every 30 minutes) under a fresh request id. A retry cannot stack a
 * second copy on an unsent one: the claim carries the recheck, and the owner re-presses its
 * own draft or holds the prompt for a person (F2), and verifies a Codex submit (F3).
 */
export const WAKE_RETRY_BASE_MS = 5 * 60_000;
export const WAKE_RETRY_MAX_MS = 30 * 60_000;
export function wakeRetryDelayMs(attempt: number): number {
  return Math.min(WAKE_RETRY_MAX_MS, WAKE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** A hook event message that means "the agent needs the human" — permission /
 *  approve / confirm prompts (mirrors the renderer's needsHuman detection in
 *  useHive.ts). Anything matching the idle-waiting shape is NOT a HITL hold. */
export type HookClass = 'needsHuman' | 'idle' | null;

export function classifyHook(event: string | undefined, message: string | undefined): HookClass {
  if (event === 'Notification') {
    const msg = (message ?? '').toLowerCase();
    const idleWaiting = !msg
      || msg.includes('waiting for your input')
      || msg.includes('is idle')
      || msg.includes('waiting for input');
    const needsHuman = msg.includes('permission')
      || msg.includes('approve')
      || msg.includes('confirm')
      || msg.includes('needs your');
    if (needsHuman && !idleWaiting) return 'needsHuman';
    return 'idle';
  }
  return null;
}

/**
 * Hook events that prove the main agent is working (a stale idle assertion is cleared).
 *
 * `SessionStart` is deliberately NOT one of them, and this is the 1.1.46 floor-stall in one
 * line. Every CLI fires it while it BOOTS, before anything has been submitted to it, so
 * counting it as an active turn labelled every freshly spawned agent active while it sat
 * parked at its prompt. The only way back to `idle` is a `Stop`, which a turn that never
 * started cannot emit, so event wakes (which need recorded idle) and the reconciliation
 * beat (which under D3 lets PTY silence stand in only for an UNKNOWN lifecycle) both
 * refused every wake for the life of the process. In 1.1.45 the renderer's 4s inbox poll
 * had covered it regardless of lifecycle; C3 deleted that, and no producer was left.
 *
 * A session boundary means the PREVIOUS turn is moot, not that a new one is running, so it
 * is handled as `unknown` below — which routes it into the already-ratified
 * `unknown && quiescent` recovery, behind boot grace. D3 is untouched: a turn that really
 * starts supplies `UserPromptSubmit` (and then `PreToolUse`) immediately, and stays
 * unclaimable through any length of silent tool until it says `Stop`.
 */
const ACTIVE_EVENTS = new Set(['UserPromptSubmit', 'PreInvocation', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact']);

/**
 * The canonical provider-native lifecycle, as the AGY statusline normaliser states it.
 * It is NOT derived here and never inferred from silence, from the renderer, from inbox
 * age or from the stall watchdog — it is read off a version-validated tick and nothing
 * else. This is the authoritative recovery input the 1.1.47 false-active stall lacked:
 * a `COMMITTED` wake opens an active epoch, and before this there was no observation in
 * the main process capable of closing one once its terminal hook was lost.
 */
export type ProviderStatus = 'idle' | 'running' | 'waiting_for_confirmation';

export type WakeLifecycle = 'active' | 'idle' | 'unknown';
/** Why a wake was attempted (breadcrumbs only; never a decision input). */
export type WakeCause = 'delivery' | 'hook' | 'control' | 'capacity' | 'interference' | 'reconcile' | 'renderer';
/** `event`: needs recorded lifecycle-idle evidence. `reconcile`: may also use PTY quiescence. */
export type WakeMode = 'event' | 'reconcile';

/** One agent's live facts, gathered by the caller immediately before a claim. */
export interface WorkerWakeFacts {
  agentId: string;
  /** Live PTY id, or undefined when the agent has no terminal. */
  ptyId?: string;
  /** Timestamp of the PTY's last output (0 = never output). */
  lastOutputAt: number;
  /** ControlRegistry snapshot flags. */
  autoDeliveryPaused: boolean;
  paused: boolean;
  halted: boolean;
  /** The submit owner holds an unresolved INTERFERED inhibition on this PTY. */
  inhibited?: boolean;
}

/** One immutable claimed batch. */
export interface WakeClaim {
  agentId: string;
  requestId: string;
  /** Sorted, unique. Never enlarged after the claim. */
  ids: readonly string[];
  cause: WakeCause;
  /** The ids of an earlier nudge that was typed but never confirmed as a provider turn.
   *  That nudge may still sit UNSENT in the composer, so the owner must see it absent from
   *  the prompt before typing this one (never double-typed). Absent = no such check. */
  recheck?: readonly string[];
}

export type InterferenceHow = 'SEND_AGAIN' | 'ALREADY_HANDLED';

interface AgentWake {
  pending: Set<string>;
  announced: Set<string>;
  inFlight: WakeClaim | null;
  held: WakeClaim | null;
  lifecycle: WakeLifecycle;
  lastHumanNeedsAt: number;
  lastReconcileAttemptAt: number;
  /** The provider session this agent's native status ticks speak for, once one has
   *  been learned. Null = nothing learned yet (accept and learn from the next tick). */
  providerSession: string | null;
  /** When the most recent active epoch opened (0 = none ever). Terminal proof must be
   *  newer than this, so a reading that predates the turn cannot close it. It is only
   *  ever read while the lifecycle IS active, so the hook path deliberately leaves a
   *  spent value in place rather than spending a write clearing it. */
  activeSince: number;
  /** Turns whose Stop has been recorded, newest last, bounded (FALSEACTIVE-STALL-2). A
   *  tool event that names one of these arrived after its own turn ended. */
  closedTurns: string[];
  /** The Codex turn the lifecycle is active FOR, when a hook named it (null otherwise).
   *  B1 closes a lost Stop only with a completion of exactly this turn. */
  openTurnId: string | null;
  /** When the last terminal Stop was recorded (0 = none). */
  stoppedAt: number;
  /** When the provider last said a turn STARTED (an active hook, a confirming reading). */
  turnStartAt: number;
  /** The active epoch was opened by our COMMITTED and the provider has not confirmed a
   *  turn yet (only for a provider that reports turn starts). */
  provisional: boolean;
  /** When the current in-flight claim was taken (a turn start after it confirms it). */
  claimedAt: number;
  /** The ids of the commit that opened the provisional epoch. */
  commitIds: readonly string[];
  /** An idle reading refused only by the confirm grace, applied on a later beat unless
   *  something newer said active (0 = none). */
  pendingIdleAt: number;
  /** Ids already re-pended once (an unconfirmed submit, or still delivered at the close of their
   *  wake's epoch). A second time goes to the F4 backoff instead. */
  reannounced: Set<string>;
  /** F4: ids whose re-announcement was unconfirmed too: attempt count and when to offer again. */
  retries: Map<string, { attempt: number; at: number }>;
  /** See WakeClaim.recheck; carried until a claim that checked it COMMITS. */
  recheck: readonly string[] | null;
  /** AGY's last invocation hook was PreInvocation (a model call is running): a deferred
   *  idle is not applied until PostInvocation or a Stop says it ended. */
  invoking: boolean;
}

/** What a reconcile beat changed for one agent (null = nothing). */
export type WakeBeatEdge =
  | { kind: 'deferred-idle' }
  | { kind: 'submit-unconfirmed'; ids: readonly string[] }
  /** F4: the re-announced ids went unconfirmed AGAIN (`ids`); offered again in `retryInMs`.
   *  `requeued`: first-time unconfirmed ids of the same commit, re-pended now as before. */
  | { kind: 'wake-ids-exhausted'; ids: readonly string[]; attempt: number; retryInMs: number; requeued: readonly string[] }
  /** F4: exhausted ids whose backoff ended are pending again. */
  | { kind: 'wake-retry'; ids: readonly string[]; attempt: number };

/** How many closed turn ids are remembered per agent. Only a straggler of a RECENT turn
 *  can still be in flight, so a short window is enough. */
const CLOSED_TURN_MEMORY = 16;
/** Events that can only happen INSIDE a turn. A late one from a closed turn is stale. A
 *  UserPromptSubmit is not in here: a new prompt is never a straggler of an old turn. */
const IN_TURN_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/** `inbox-wake:<agent>:<sha256 of the sorted ids>` - the same batch always has the same BASE. */
export function inboxWakeRequestId(agentId: string, ids: readonly string[]): string {
  const digest = createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
  return `inbox-wake:${agentId}:${digest}`;
}

/**
 * ZT-I1-MAIL 1.1.75 (layer-b dry run #2, god c59e35): the request id of a wake CLAIM is
 * `<base>:<generation>`. The owner (automaticSubmit) delivers a request id AT MOST ONCE and
 * replays a remembered COMMITTED without typing, so every NEW announcement of the same id set
 * needs a NEW id, however often the set comes back: a re-pend at Stop (§11.3 / Q38), an N1
 * unconfirmed back-edge, an unconfirmed submit, an F4 retry. The old scheme allowed one `:again`
 * and `:retryN`, and it keyed "already re-announced" on state that reconcile() drops while an id is
 * surfacing (the ledger's delivered set), so the third announcement reused a COMMITTED id and was
 * replayed untyped (a 5-minute stall). The generation is per agent and per id set, survives
 * reconcile() and forget(), and is bounded by the claims themselves (N1: at most 2 unconfirmed
 * re-surfacings; F4: the backoff). A GENUINE duplicate, the same claim asked again, keeps its id
 * and still dedups in the owner.
 */
export function inboxWakeClaimId(agentId: string, ids: readonly string[], generation: number): string {
  return `${inboxWakeRequestId(agentId, ids)}:${generation}`;
}
/** Generations remembered per agent (most recent id sets). Far above anything one agent's mail
 *  can hold at once; the oldest set is dropped first. */
export const WAKE_GENERATION_MEMORY = 512;

export class WorkerWakeWatchdog {
  /** ptyId → spawn timestamp (boot grace). */
  private spawnedAt = new Map<string, number>();
  private agents = new Map<string, AgentWake>();
  /** agentId -> (claim base id -> last generation used). Deliberately OUTSIDE AgentWake: neither
   *  reconcile() nor forget() may reset it, or a later announcement of the same set would reuse a
   *  COMMITTED request id and be replayed without typing. */
  private generations = new Map<string, Map<string, number>>();

  /** The next generation for this agent's id set (0 for the first announcement). */
  private nextGeneration(agentId: string, base: string): number {
    let m = this.generations.get(agentId);
    if (!m) { m = new Map(); this.generations.set(agentId, m); }
    const gen = (m.get(base) ?? -1) + 1;
    m.delete(base);
    m.set(base, gen);
    while (m.size > WAKE_GENERATION_MEMORY) m.delete(m.keys().next().value as string);
    return gen;
  }
  /** DIAGNOSIS ONLY (diag-1.1.46-wake): the guard that refused this agent's last claim. */
  private lastWhy = new Map<string, string>();

  /** DIAGNOSIS ONLY: why `claim()` last returned null for this agent ('' = it claimed). */
  whyNoClaim(agentId: string): string {
    return this.lastWhy.get(agentId) ?? '';
  }

  private rec(agentId: string): AgentWake {
    let r = this.agents.get(agentId);
    if (!r) {
      r = {
        pending: new Set(), announced: new Set(), inFlight: null, held: null, lifecycle: 'unknown', lastHumanNeedsAt: 0, lastReconcileAttemptAt: 0, providerSession: null, activeSince: 0, closedTurns: [], openTurnId: null,
        stoppedAt: 0, turnStartAt: 0, provisional: false, claimedAt: 0, commitIds: [], pendingIdleAt: 0, reannounced: new Set(), retries: new Map(), recheck: null, invoking: false
      };
      this.agents.set(agentId, r);
    }
    return r;
  }

  /** The provider said a turn started: a provisional epoch is confirmed, and an idle
   *  reading deferred before this is overtaken. */
  private turnStarted(r: AgentWake, at: number): void {
    r.turnStartAt = Math.max(r.turnStartAt, at);
    r.provisional = false;
    if (r.pendingIdleAt > 0 && at > r.pendingIdleAt) r.pendingIdleAt = 0;
  }

  /** The lifecycle leaves `active`: every epoch-scoped fact goes with it. */
  private endEpoch(r: AgentWake, to: WakeLifecycle): void {
    r.lifecycle = to;
    r.provisional = false;
    r.pendingIdleAt = 0;
  }

  /**
   * ZT-I1-MAIL §11.3 (C3; replaces the time-based re-announce): the epoch of a wake has CLOSED
   * (its Stop, a Codex task_complete, or an abnormal end), and `deliveredIds` are the ledger's
   * delivered ids NOW. An announced id that is still delivered was not surfaced in that turn (a
   * budget overflow in a text-only turn, an abnormal end): it goes back to pending ONCE; a second
   * time it goes to the F4 backoff (never burned, never silent). "Announced" is thereby keyed to
   * the ledger: no id stays announced and delivered after its epoch closed.
   *
   * Never over our own unconfirmed nudge: while the lifecycle is active on a PROVISIONAL epoch the
   * nudge may still sit in the composer (the submit-unconfirmed path owns those ids), EXCEPT at a
   * turn end (`turnEnded`: any Stop or StopFailure, §11.18 #41 / Q38): the provider says a turn
   * ran and ended, so an unsurfaced id never reached the model and goes back to pending whether or
   * not the turn start was confirmed (a Codex UserPromptSubmit that never arrives, and a turn
   * shorter than one beat). `unconfirmedStart` says the guard was passed that way.
   */
  repend(agentId: string, deliveredIds: readonly string[], now = Date.now(), opts: { turnEnded?: boolean } = {}): { requeued: string[]; exhausted: string[]; attempt: number; retryInMs: number; unconfirmedStart: boolean } {
    const out = { requeued: [] as string[], exhausted: [] as string[], attempt: 0, retryInMs: 0, unconfirmedStart: false };
    const r = this.agents.get(agentId);
    if (!r) return out;
    if (r.lifecycle === 'active' && r.provisional) {
      if (!opts.turnEnded) return out;
      out.unconfirmedStart = true;
    }
    const delivered = new Set(deliveredIds);
    for (const id of [...r.announced].sort()) {
      if (!delivered.has(id)) continue;
      r.announced.delete(id);
      if (r.reannounced.has(id)) {
        const next = (r.retries.get(id)?.attempt ?? 0) + 1;
        r.retries.set(id, { attempt: next, at: now + wakeRetryDelayMs(next) });
        out.attempt = Math.max(out.attempt, next);
        out.exhausted.push(id);
        continue;
      }
      r.reannounced.add(id);
      r.pending.add(id);
      out.requeued.push(id);
    }
    if (out.attempt) out.retryInMs = wakeRetryDelayMs(out.attempt);
    return out;
  }

  private known(r: AgentWake, id: string): boolean {
    // F4: an exhausted id waiting out its backoff is known too, or reconcile would re-pend it
    // on the very next beat and the backoff would be a tight loop.
    return r.pending.has(id) || r.announced.has(id) || r.retries.has(id) || !!r.inFlight?.ids.includes(id) || !!r.held?.ids.includes(id);
  }

  /** Record a PTY spawn: its boot sequence is left alone, its lifecycle starts unknown, and a
   *  held INTERFERED claim from the previous incarnation goes back to pending (the owner
   *  retires that inhibition with the process). */
  noteSpawn(ptyId: string, at = Date.now(), agentId?: string): void {
    this.spawnedAt.set(ptyId, at);
    if (!agentId) return;
    const r = this.rec(agentId);
    this.endEpoch(r, 'unknown');
    r.recheck = null;   // the new incarnation's composer is empty; the old one died with it
    r.invoking = false;
    // A new PTY incarnation is a new provider session. Forget the old one BEFORE any
    // tick of the new one arrives: keeping it would make the first tick of the fresh
    // session look like a mismatch and be discarded, and the agent would then have no
    // native lifecycle at all — the exact blindness this commit exists to remove.
    r.providerSession = null;
    if (r.held) {
      for (const id of r.held.ids) if (!r.announced.has(id)) r.pending.add(id);
      r.held = null;
    }
  }

  /** A durable inbox write landed. True when the id is new to this agent. */
  noteDelivery(agentId: string, messageId: string): boolean {
    if (!agentId || typeof messageId !== 'string' || !messageId) return false;
    const r = this.rec(agentId);
    if (this.known(r, messageId)) return false;
    r.pending.add(messageId);
    return true;
  }

  /**
   * Feed a hook event. Returns true when it is a RETRY EDGE for pending work.
   *
   * `fullyIdle` is Antigravity's own terminal qualifier, preserved through the agy hook
   * shim. It is read ONLY to REFUSE a Stop that says it is not terminal: Claude has no
   * such field, so an absent one keeps the long-standing "any Stop means idle" reading
   * and nothing about Claude moves. `false` is a provider statement that the turn is
   * still running, and believing it over the event name is what stops a mid-chain Stop
   * from opening a window for a second prompt.
   */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now(), fullyIdle?: boolean, turnId?: string): boolean {
    if (!agentId || !event) return false;
    const r = this.rec(agentId);
    // §11.18 #43 (Q40): StopFailure (an API error) ends the turn exactly as Stop does. Without
    // this the lifecycle stayed active until Claude's own idle Notification (~60 s), and a mail
    // wake re-pended by the abnormal close was refused as lifecycle-active until then.
    if (event === 'Stop' || event === 'StopFailure') {
      if (fullyIdle === false) return false;   // the provider says the turn is not over
      this.endEpoch(r, 'idle');
      r.openTurnId = null;
      r.stoppedAt = at;
      r.invoking = false;
      if (turnId && !r.closedTurns.includes(turnId)) {
        r.closedTurns.push(turnId);
        if (r.closedTurns.length > CLOSED_TURN_MEMORY) r.closedTurns.shift();
      }
      return true;
    }
    // FALSEACTIVE-STALL-2. Each hook is its own short-lived shim process on the pipe, so
    // arrival order is not event order: on the live floor a Codex PostToolUse arrived 5 s
    // AFTER its turn's end (and a PreToolUse 8 s after its tool finished). Read as a fresh
    // edge, that straggler re-opened a turn that was already over, and nothing would ever
    // close it again, because the turn's Stop had already come and gone: every wake was
    // then refused as lifecycle-active, for good. Codex stamps turn_id on its hooks, so a
    // tool event naming a turn we have already seen END is recognised for what it is and
    // ignored. Scoped to in-turn events on purpose: a UserPromptSubmit always opens.
    if (turnId && IN_TURN_EVENTS.has(event) && r.closedTurns.includes(turnId)) return false;
    if (event === 'SubagentStop') return r.lifecycle === 'idle';   // never turns active into idle
    if (event === 'Notification') {
      if (classifyHook(event, message) === 'needsHuman') { r.lastHumanNeedsAt = at; return false; }
      this.endEpoch(r, 'idle');
      return true;
    }
    // Jim (WAKE-CONFIRM-AUDIT-153 note 1): AGY brackets every model call with Pre/PostInvocation,
    // and its running ticks can pause >5 s inside one. A deferred idle must not land there.
    if (event === 'PostInvocation') { r.invoking = false; return false; }
    if (ACTIVE_EVENTS.has(event)) {
      if (event === 'PreInvocation') r.invoking = true;
      this.turnStarted(r, at);   // the provider's own turn start: confirms our submit
      r.lifecycle = 'active'; r.activeSince = at;
      r.openTurnId = turnId ?? null;   // no id (Claude, our own submit): the turn is unnamed
      return false;
    }
    // A session boundary moots whatever the previous session was doing, in both directions:
    // it never asserts a turn is running (the cold-boot deadlock above), and it must not
    // let a stale `active` from the old session survive into the new one either — a
    // --resume'd agent would inherit exactly the same deadlock. Not a retry edge: nothing
    // is known to be idle yet, so the reconciliation beat decides, behind boot grace.
    if (event === 'SessionStart' || event === 'SessionEnd') { this.endEpoch(r, 'unknown'); r.invoking = false; return false; }
    return false;
  }

  /**
   * Feed one PROVIDER-NATIVE status reading. Returns true when it is a RETRY EDGE.
   *
   * THE FIX FOR THE FALSE-ACTIVE STALL. `settle(COMMITTED)` opens an active epoch, and
   * until now only a terminal HOOK could close one. When that hook was never delivered —
   * as in the 1.1.47 incident, where no AGY lifecycle event reached main at all — the
   * agent was known-active forever: event mode refuses anything but idle, and D3
   * deliberately refuses to let PTY silence stand in for a positively active lifecycle.
   * The watchdog could see the contradiction and say so, but had nothing authoritative
   * to say it WITH. This is that input.
   *
   * THE MAPPING (design 4.1), and it is the whole of it:
   *
   *   idle                     -> lifecycle idle,   RETRY EDGE
   *   running                  -> lifecycle active, no edge
   *   waiting_for_confirmation -> lifecycle active + HITL hold, no edge
   *
   * Confirmation is BOTH: the turn is alive (so silence still cannot claim it) and a
   * human is being asked something (so the existing HITL rearm blocks the claim for its
   * full window). Mail can never be typed through a permission prompt.
   *
   * THE INCARNATION GUARD. A tick naming a session other than the learned one is
   * discarded entirely — it cannot set idle, cannot set active, cannot arm HITL. A late
   * tick from a session the PTY has already replaced is the one way a native reading
   * could make a genuinely busy new turn look finished, and `noteSpawn` clears the
   * learned session so the new incarnation starts by learning its own. A tick that names
   * no session at all is accepted: it is one stream per PTY and receive order settles it.
   *
   * Nothing here claims, submits or types. It records what the provider said; the
   * ordinary guarded path decides what, if anything, follows.
   */
  noteProviderStatus(agentId: string | undefined, status: ProviderStatus, at = Date.now(), sessionId: string | null = null): boolean {
    if (!agentId) return false;
    const r = this.rec(agentId);
    if (sessionId) {
      if (r.providerSession !== null && r.providerSession !== sessionId) return false;
      r.providerSession = sessionId;
    }
    // TERMINAL PROOF MUST BE NEWER THAN THE EDGE IT CLOSES, and it must be old enough to
    // be ABOUT this turn.
    //
    // HONEST BOOKKEEPING (Jim, c4 re-audit P6): these two are NOT independent. While the
    // lifecycle is active the grace SUBSUMES the ordering check, because `at < activeSince`
    // implies `at - activeSince < 0 < PROVIDER_IDLE_CONFIRM_MS` - so deleting the ordering
    // line alone changes nothing any test can see, exactly as c3's safety override is
    // subsumed by the ratified gating rule. Its only behavioural residue is in the
    // NOT-active case, where a pre-epoch reading yields a spurious (and harmless) retry
    // edge instead of silence. It is kept as NARROWING INSURANCE: the grace is a tuning
    // constant and someone will shorten it one day, and the ordering rule must not leave
    // with it. Two rules, one guarantee - said plainly rather than implied.
    //
    // (1) ORDERING. Each tick is its own short-lived shim process on the named pipe, so
    //     two in flight can be received out of order. `at` is the shim's READING time, not
    //     the arrival time - arrival through one process is monotone and would make this
    //     unreachable, which is exactly how the first version of this guard was decoration
    //     (Jim, c4 audit). Stamped by the shim on the same clock as `activeSince`.
    //
    // (2) CONFIRM GRACE. Ordering alone cannot help when the reading is HONESTLY newer:
    //     agy goes on rendering `idle` until it has processed the prompt we just typed, so
    //     a tick generated after the Enter but before the state flips is both truthful and
    //     about the previous turn. Refuse - never defer - for the grace; the next tick
    //     after it decides. See PROVIDER_IDLE_CONFIRM_MS.
    //
    // (3) DEFER, NEVER DROP (AGY-FALSEACTIVE-STALL (b)). "The next tick after the grace
    //     decides" assumed ticks keep coming; AGY goes silent while idle, so a refused
    //     idle was the last word and the epoch never closed. A grace-refused reading is
    //     remembered and applied by the next beat after the grace (`beat`), unless
    //     something newer said active first. The beat already runs: no new timer.
    if (status === 'idle') {
      if (r.activeSince > 0 && at < r.activeSince) return false;
      if (r.lifecycle === 'active' && r.activeSince > 0 && at - r.activeSince < PROVIDER_IDLE_CONFIRM_MS) {
        r.pendingIdleAt = Math.max(r.pendingIdleAt, at);
        return false;
      }
      this.closeUnconfirmed(r);
      this.endEpoch(r, 'idle');
      r.activeSince = 0;
      return true;
    }
    // (4) STOP IS TERMINAL PROOF (AGY-FALSEACTIVE-STALL (a)). AGY goes on rendering
    //     `running` for seconds after its own Stop; that reading is about the turn the Stop
    //     ended. Inside STOP_SETTLE_MS of a Stop it opens nothing, unless a turn start came
    //     after the Stop (which, being active, is not re-opened here anyway), and it is
    //     never taken as confirmation of our submit.
    const afterStop = r.stoppedAt > 0 && at < r.stoppedAt + STOP_SETTLE_MS;
    if (r.lifecycle !== 'active') {
      if (afterStop && r.turnStartAt <= r.stoppedAt) return false;
      r.activeSince = at;   // a new epoch, not a repeat of one
    }
    r.lifecycle = 'active';
    if (!afterStop && at >= r.activeSince && at >= r.claimedAt) this.turnStarted(r, at);
    if (status === 'waiting_for_confirmation') r.lastHumanNeedsAt = at;
    return false;
  }

  /**
   * FALSEACTIVE-STALL-2 (B1): Codex's own rollout says a turn COMPLETED. Returns true when
   * that closed the open turn (a retry edge), false when it proves nothing.
   *
   * The companion of noteProviderStatus for a provider whose lifecycle is recorded per
   * turn rather than ticked. It closes ONLY an active lifecycle, and only with proof about
   * THAT turn: the same turn id when the app knows which turn is open, otherwise a
   * completion newer than the active epoch (codexTurnEnded). It never opens anything and
   * never touches an idle or unknown agent. D3 is untouched: this is the provider saying
   * the turn ended, not silence standing in for it.
   */
  noteProviderTurnEnded(agentId: string | undefined, turnId: string, at: number): boolean {
    if (!agentId || !turnId) return false;
    const r = this.agents.get(agentId);
    if (!r || r.lifecycle !== 'active') return false;
    if (r.openTurnId ? r.openTurnId !== turnId : !(r.activeSince > 0 && at > r.activeSince)) return false;
    this.endEpoch(r, 'idle');
    r.activeSince = 0;
    r.openTurnId = null;
    if (!r.closedTurns.includes(turnId)) {
      r.closedTurns.push(turnId);
      if (r.closedTurns.length > CLOSED_TURN_MEMORY) r.closedTurns.shift();
    }
    return true;
  }

  /**
   * CODEX-FALSECONFIRM-155: only a NEW Codex `task_started` can confirm the provisional
   * epoch. A task_complete is proof about the old turn, even if its delayed rollout read
   * arrives after claim(); accepting it was how a lost Enter became permanently active.
   */
  noteProviderTurnStarted(agentId: string | undefined, turnId: string, at: number): boolean {
    if (!agentId || !turnId || !Number.isFinite(at)) return false;
    const r = this.agents.get(agentId);
    // claim() is the handoff boundary: a real task_started after it belongs to this
    // wake even when rollout observes it before the async owner settle completes.
    if (!r || r.lifecycle !== 'active' || !r.provisional
      || !(r.claimedAt > 0 && at >= r.claimedAt)
      || r.closedTurns.includes(turnId)) return false;
    r.openTurnId = turnId;
    this.turnStarted(r, at);
    return true;
  }

  /**
   * CODEX-FALSECONFIRM-155 recovery for the legacy false-confirm state. Versions before
   * this guard could make an active epoch non-provisional from a delayed task_complete;
   * it then blocked every later inbox delivery forever. A completion older than the epoch
   * cannot close it, so turn it back into the bounded provisional path and let beat()
   * re-pend the ids once. This is intentionally Codex-specific at the bridge call site.
   */
  recoverStuckCodexActive(agentId: string | undefined, completedAt: number, now = Date.now()): boolean {
    if (!agentId || !Number.isFinite(completedAt) || !Number.isFinite(now)) return false;
    const r = this.agents.get(agentId);
    if (!r || r.lifecycle !== 'active' || r.provisional || !(r.activeSince > 0) || r.commitIds.length === 0
      || !(completedAt < r.activeSince && r.turnStartAt <= completedAt)
      || now - r.activeSince < SUBMIT_CONFIRM_MS) return false;
    r.provisional = true;
    r.openTurnId = null;
    return true;
  }

  /**
   * One reconcile beat for one agent (call after `reconcile`, so ids that left the disk are
   * gone). At most one edge, in this order:
   *
   *  - deferred-idle       an idle reading refused by the confirm grace, with nothing newer
   *                        saying active, is applied now that the grace is over;
   *  - submit-unconfirmed  our COMMITTED epoch was never confirmed by the provider within
   *                        SUBMIT_CONFIRM_MS: lifecycle unknown (quiescence rules apply
   *                        again), the claim's ids back to pending ONCE, and the next claim
   *                        must first see the unsent nudge absent from the prompt;
   *  - wake-retry          F4: exhausted ids whose backoff ended are pending again.
   * ZT-I1-MAIL: there is no time-based re-announce any more (§3 #2, §11.3); see `repend`.
   */
  beat(agentId: string, now = Date.now()): WakeBeatEdge | null {
    const r = this.agents.get(agentId);
    if (!r) return null;
    if (r.lifecycle === 'active' && r.pendingIdleAt > 0 && !r.invoking && now - r.activeSince >= PROVIDER_IDLE_CONFIRM_MS) {
      this.closeUnconfirmed(r);
      this.endEpoch(r, 'idle');
      r.activeSince = 0;
      return { kind: 'deferred-idle' };
    }
    if (r.lifecycle === 'active' && r.provisional && now - r.activeSince >= SUBMIT_CONFIRM_MS) {
      const ids: string[] = [];
      const exhausted: string[] = [];
      let attempt = 0;
      for (const id of r.commitIds) {
        if (!r.announced.has(id)) continue;
        r.announced.delete(id);
        if (r.reannounced.has(id)) {
          // F4: unconfirmed again. Not dropped: offered again after a backoff.
          const next = (r.retries.get(id)?.attempt ?? 0) + 1;
          r.retries.set(id, { attempt: next, at: now + wakeRetryDelayMs(next) });
          attempt = Math.max(attempt, next);
          exhausted.push(id);
          continue;
        }
        r.reannounced.add(id);
        r.pending.add(id);
        ids.push(id);
      }
      this.closeUnconfirmed(r);
      this.endEpoch(r, 'unknown');
      if (exhausted.length) return { kind: 'wake-ids-exhausted', ids: exhausted.sort(), attempt, retryInMs: wakeRetryDelayMs(attempt), requeued: ids };
      return { kind: 'submit-unconfirmed', ids };
    }
    if (r.lifecycle !== 'active' && !r.inFlight && !r.held) {
      const due: string[] = [];
      let attempt = 0;
      for (const [id, t] of r.retries) {
        if (t.at > now || r.pending.has(id) || r.announced.has(id)) continue;
        r.pending.add(id);
        attempt = Math.max(attempt, t.attempt);
        due.push(id);
      }
      if (due.length) return { kind: 'wake-retry', ids: due.sort(), attempt };
    }
    return null;
  }

  /** A provisional epoch ends without the provider ever confirming a turn: the nudge that
   *  opened it may still be unsent in the composer, so the next claim checks first. */
  private closeUnconfirmed(r: AgentWake): void {
    if (r.provisional && r.commitIds.length) r.recheck = r.commitIds;
  }

  /**
   * Align with the authoritative pending set. ZT-I1-MAIL §3 #1: for a ledger agent that is the
   * LEDGER's delivered ids (the caller passes them); files on disk imply nothing. Ids no longer
   * delivered (surfaced, acted) leave every set; delivered ids that nothing knows about become
   * pending (a lost callback, a restart, a back-edge). No ordering is inferred from the id strings.
   */
  reconcile(agentId: string, currentInboxIds: readonly string[]): void {
    const current = new Set(currentInboxIds.filter((id) => typeof id === 'string' && id.length > 0));
    const r = this.rec(agentId);
    for (const id of [...r.pending]) if (!current.has(id)) r.pending.delete(id);
    for (const id of [...r.announced]) if (!current.has(id)) r.announced.delete(id);
    for (const id of [...r.reannounced]) if (!current.has(id)) r.reannounced.delete(id);
    for (const id of [...r.retries.keys()]) if (!current.has(id)) r.retries.delete(id);
    if (r.held && !r.held.ids.some((id) => current.has(id))) r.held = null;
    for (const id of current) if (!this.known(r, id)) r.pending.add(id);
  }

  /**
   * At most ONE immutable batch, or null. Both modes fail closed on: no PTY, pause, halt,
   * auto-delivery pause, an owner inhibition, a recent HITL prompt, boot grace, an existing
   * in-flight or held claim. `event` mode needs recorded lifecycle-idle evidence;
   * `reconcile` may also accept PTY quiescence, but ONLY for an agent whose lifecycle is
   * unknown (never one known to be active), rate-limited per agent.
   */
  claim(f: WorkerWakeFacts, cause: WakeCause, mode: WakeMode, now = Date.now()): WakeClaim | null {
    const r = this.rec(f.agentId);
    // DIAGNOSIS ONLY (diag-1.1.46-wake): every `return null` below names itself, so a
    // packaged run can say WHICH guard is holding instead of just "no wake". `no()` is
    // pure bookkeeping — it returns null and changes nothing the guards decide.
    const no = (why: string): null => { this.lastWhy.set(f.agentId, why); return null; };
    if (r.inFlight) return no('in-flight');
    if (r.held) return no('held-interfered');
    if (r.pending.size === 0) return no('no-pending-ids');
    if (!f.ptyId) return no('no-pty');
    if (f.paused) return no('paused');
    if (f.halted) return no('halted');
    if (f.autoDeliveryPaused) return no('auto-delivery-paused');
    if (f.inhibited) return no('owner-inhibited');
    if (r.lastHumanNeedsAt > 0 && now - r.lastHumanNeedsAt < WORKER_WAKE_HITL_REARM_MS) return no('hitl-hold');
    const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
    if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) return no('boot-grace');
    if (mode === 'event') {
      if (r.lifecycle !== 'idle') return no(`lifecycle-${r.lifecycle}`);
    } else {
      const quiescent = f.lastOutputAt > 0 && now - f.lastOutputAt >= WORKER_WAKE_IDLE_MS;
      // D3 (god ruling, Dwight's tightening): PTY silence stands in ONLY when the lifecycle is
      // UNKNOWN (start-up, lost history, a lost Stop). A positively ACTIVE agent is never claimed
      // on quiescence: a silent tool, build or network wait can outlast 12s, and the owner
      // proves the prompt and the human, not that the model's turn ended.
      if (!(r.lifecycle === 'idle' || (r.lifecycle === 'unknown' && quiescent))) {
        return no(`lifecycle-${r.lifecycle}${quiescent ? '' : '-not-quiescent'}`);
      }
      if (r.lastReconcileAttemptAt > 0 && now - r.lastReconcileAttemptAt < WORKER_WAKE_COOLDOWN_MS) return no('reconcile-cooldown');
      r.lastReconcileAttemptAt = now;
    }
    this.lastWhy.delete(f.agentId);
    const ids = [...r.pending].sort();
    r.pending.clear();
    r.claimedAt = now;
    // Every announcement of this id set is a NEW request (see inboxWakeClaimId): the owner replays
    // a remembered COMMITTED without typing, so a re-pend, an N1 back-edge, an unconfirmed submit or
    // an F4 retry must never reuse an earlier id.
    const requestId = inboxWakeClaimId(f.agentId, ids, this.nextGeneration(f.agentId, inboxWakeRequestId(f.agentId, ids)));
    const claim: WakeClaim = Object.freeze({
      agentId: f.agentId, requestId, ids: Object.freeze(ids), cause,
      ...(r.recheck ? { recheck: r.recheck } : {})
    });
    r.inFlight = claim;
    return claim;
  }

  /**
   * The owner's outcome for a claim. Only the CURRENT in-flight claim is settled.
   *
   * `confirms`: this agent's provider reports its own turn starts (a UserPromptSubmit or
   * PreInvocation hook, Codex's task_started). Then a COMMITTED epoch is PROVISIONAL until
   * one arrives (see SUBMIT_CONFIRM_MS). A provider with no such signal keeps the plain
   * reading - COMMITTED is active until its Stop - since waiting for a confirmation that can
   * never come would re-announce every turn.
   */
  settle(claim: WakeClaim, outcomeKind: string, at = Date.now(), confirms = false): void {
    const r = this.agents.get(claim.agentId);
    if (!r || r.inFlight?.requestId !== claim.requestId) return;
    r.inFlight = null;
    if (outcomeKind === 'COMMITTED') {
      for (const id of claim.ids) r.announced.add(id);
      r.lifecycle = 'active';          // a turn just started; new mail waits for its Stop
      r.activeSince = at;              // and THIS is the edge terminal proof must be newer than
      r.pendingIdleAt = 0;
      // Already confirmed if the provider's turn start beat our settle here.
      r.provisional = confirms && !(r.claimedAt > 0 && r.turnStartAt >= r.claimedAt);
      r.commitIds = claim.ids;
      if (claim.recheck) r.recheck = null;   // the prompt was seen clear, and this went out
    } else if (outcomeKind === 'HUMAN_HANDLED') {
      for (const id of claim.ids) r.announced.add(id);
      r.recheck = null;
    } else if (outcomeKind === 'INTERFERED') {
      r.held = claim;                  // no automatic retry until a human rules
    } else {
      for (const id of claim.ids) if (!r.announced.has(id)) r.pending.add(id);
    }
  }

  /** A human resolved the owner's INTERFERED hold. Returns true when a held claim moved. */
  resolveInterference(agentId: string, how: InterferenceHow): boolean {
    const r = this.agents.get(agentId);
    if (!r?.held) return false;
    const held = r.held;
    r.held = null;
    if (how === 'SEND_AGAIN') {
      for (const id of held.ids) if (!r.announced.has(id)) r.pending.add(id);
    } else {
      for (const id of held.ids) r.announced.add(id);
      r.recheck = null;                // a person dealt with the prompt
    }
    return true;
  }

  /** Agents with pending ids (bounded retries after a capacity change or at startup). */
  pendingAgents(): string[] {
    return [...this.agents].filter(([, r]) => r.pending.size > 0).map(([id]) => id).sort();
  }

  /** Read-only view for diagnostics and tests. */
  state(agentId: string): { pending: string[]; announced: string[]; inFlight: WakeClaim | null; held: WakeClaim | null; lifecycle: WakeLifecycle; providerSession: string | null; provisional: boolean } {
    const r = this.agents.get(agentId);
    return {
      pending: r ? [...r.pending].sort() : [],
      announced: r ? [...r.announced].sort() : [],
      inFlight: r?.inFlight ?? null,
      held: r?.held ?? null,
      lifecycle: r?.lifecycle ?? 'unknown',
      providerSession: r?.providerSession ?? null,
      provisional: r?.provisional ?? false
    };
  }

  /** Read-only: the open turn as the hooks named it, the active epoch (FALSEACTIVE-STALL-2), and
   *  when the last claim was taken and the provider last said a turn started (§11.10 input). */
  turnFacts(agentId: string): { openTurnId: string | null; activeSince: number; claimedAt: number; turnStartAt: number } {
    const r = this.agents.get(agentId);
    return { openTurnId: r?.openTurnId ?? null, activeSince: r?.activeSince ?? 0, claimedAt: r?.claimedAt ?? 0, turnStartAt: r?.turnStartAt ?? 0 };
  }

  /** Forget per-agent state (the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.agents.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }
}

/** The plan's name for the same class. */
export { WorkerWakeWatchdog as InboxWakeCoordinator };
