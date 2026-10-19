/**
 * GTC M4: an automatic inbox wake, a boot prompt and a Stop-continue go by MAIN's hook state, a
 * typed send and the provider's own confirm. Design: agents/andy-mtuk4y4x/GOD-TERMINAL-CONTROL-DESIGN.md
 * section 15, with Jim's review 82a3ae folded in 15.10 (OK WITH CHANGES, 2026-10-19).
 *
 * The coordinator (WorkerWakeWatchdog + InboxWakeBridge) stays the authority: it claims, batches,
 * names the request and settles. This module only replaces the TRANSPORT and the CONFIRM of a claim
 * it already made, and adds the Stop-continue edge. Config `wakePath: 'owner'` (the default in
 * 1.1.97) sends every request to the submit owner exactly as before.
 *
 * Typed wake, in order (15.4):
 *   owner     priorText (the owner's erase oracle), lifecycle unknown, short text, no mirror;
 *   idle      hookIdle over the coordinator's facts (never a screen reading);
 *   vetoes    a draft, a picker, a settling or exited prompt, a person's key within HUMAN_QUIET_MS,
 *             an owner hold;
 *   capacity  admitted before typing; the grant is confirmed at the Enter, cancelled otherwise;
 *   exclusive the owner's one chain for the PTY, then TermControl's slot; the gates again inside;
 *   write     origin PROGRAMMATIC: the human generation must not move during the send at all;
 *   composer  our text on the prompt row, or no Enter (TYPED_NOT_SENT: held for a person, nothing
 *             erased; a boot not in the composer goes to the owner instead, Jim SHOULD 1);
 *   confirm   Claude: the whole nudge in a UserPromptSubmit (Jim MUST 1: the 64-character M3
 *             fingerprint is not a send id); Codex: the sentinel, by-writer (Jim SHOULD 2); AGY: a
 *             PreInvocation, correlated. Nothing is ever retried here.
 *
 * Stop-continue (15.5, 15.10): HookServer asks `stopClaim` inside the Stop hook, builds the reason
 * itself from the mail ledger, and reports back through `stopSettle`.
 *
 * The shadow (15.7): each typed wake also asks the screen gate's class over the mirror through a
 * deps object that can only READ (Jim INFO 2); it decides nothing.
 * Pure logic over injected deps (unit-testable): no electron, no node-pty.
 */
import type { AgentProvider } from '../shared/agentProvider';
import { CODEX_INBOX_WAKE_SENTINEL } from '../shared/hiveNudge';
import { automaticEnterGapMs } from '../shared/providerAutomation';
import type { PromptBlock } from '../shared/promptState';
import { claudeModeKey, HUMAN_QUIET_MS, payloadFor, priorTextNeedles } from './automaticSubmit';
import { composerNeedles, hookIdle, type HookIdle, type IdleFacts, type SessionMark } from './messageBox';
import { TERM_SETTLE_QUIET_MS } from './termControl';
import { gateClass, type GateReading } from './termShadow';

export type WakePath = 'owner' | 'term';
export interface StopContinueConfig { claude?: boolean; codex?: boolean; antigravity?: boolean }

/** A config value as a path: only 'term' is the new path (the 1.1.97 default is the owner). */
export function wakePathOf(v: unknown): WakePath {
  return v === 'term' ? 'term' : 'owner';
}

/** Is the Stop-continue on for this provider? Only a literal true, and only on the term path. */
export function stopContinueOn(path: WakePath, v: unknown, provider: AgentProvider | null | undefined): boolean {
  if (path !== 'term' || !v || typeof v !== 'object' || !provider) return false;
  if (provider !== 'claude' && provider !== 'codex' && provider !== 'antigravity') return false;
  return (v as Record<string, unknown>)[provider] === true;
}

/** DELIVERED must arrive within this (15.4); AGY's PreInvocation is given longer. */
export const WAKE_CONFIRM_MS = 10_000;
export const WAKE_CONFIRM_AGY_MS = 15_000;
/** A continued turn's first hook can be its next Stop, after a long tool-free answer (15.10 MUST 3):
 *  the coordinator's epoch and this confirm wait this long. */
export const STOP_CONFIRM_MS = 5 * 60_000;
/** Boot: the provider's ready event, then this settle (Jim SHOULD 1: G1's SessionStart + 1 s). */
export const WAKE_BOOT_SETTLE_MS = 1_000;
/** Boot: no ready event this long after the spawn = the owner decides (a boot never goes dark). */
export const WAKE_BOOT_READY_MS = 20_000;
/** How long the owner's chain may keep a wake from starting. */
export const WAKE_OWNER_WAIT_MS = 5_000;
/** Codex keeps a Stop block's reason in its history (CODEX-BLOAT-165): its mail block is capped. */
export const CODEX_STOP_MAIL_BUDGET = 2_000;
/** Answered request ids are kept this long, at most this many (the renderer's boot retries). */
export const WAKE_REPLAY_MS = 60 * 60_000;
export const WAKE_REPLAY_MAX = 500;
/** A wake for the same ids within this of a DELIVERED one is a double submit (15.7). It covers the
 *  coordinator's STOP_CONFIRM_MS re-pend. */
export const WAKE_DOUBLE_WINDOW_MS = 10 * 60_000;
export const WAKE_SHADOW_SUMMARY_MS = 10 * 60_000;

export type WakeKind = 'inbox' | 'boot' | 'stop';
export type WakeConfirm = 'DELIVERED' | 'DELIVERED-CORRELATED' | 'UNKNOWN' | 'SUPERSEDED';
/** What a confirm proves (10.2): our send id came back, our text came back (not which claim),
 *  the provider's own continuation of the turn we blocked, or only a turn start after the send. */
export type ConfirmBy = 'send-id' | 'writer' | 'stop' | 'correlated';

export interface WakeRequest {
  requestId: string;
  agentId: string;
  admissionClass: string;
  text: string;
  priorText?: string;
  settleMs?: number;
}

export interface StopClaim { requestId: string; ids: readonly string[] }

export interface WakeSenderDeps {
  ptyOf(agentId: string): string | undefined;
  providerOf(agentId: string): AgentProvider | null;
  idleFacts(agentId: string): IdleFacts;
  /** When this PTY incarnation was spawned (0 = unknown). */
  spawnedAt(ptyId: string): number;
  promptBlock(ptyId: string): PromptBlock | undefined;
  lastHumanInputAt(ptyId: string): number | undefined;
  /** Moves on every HUMAN or GOD write, never on PROGRAMMATIC. */
  humanGeneration(ptyId: string): number | undefined;
  /** The owner holds this PTY (an INTERFERED wake waits for a person). */
  inhibited(ptyId: string): boolean;
  mirrorNeedle(ptyId: string, needle: string, expectedTail: string): Promise<{ reading: { onPromptRow: boolean; promptTailMatches?: boolean } | null; reason?: string }>;
  exclusive<T>(ptyId: string, fn: () => Promise<T>, startMs: number): Promise<{ ran: true; value: T } | { ran: false }>;
  slot<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  settle(ptyId: string): Promise<void>;
  /** Writes with origin PROGRAMMATIC (the caller binds it; this module never chooses an origin). */
  write(ptyId: string, data: string): { ok: boolean; error?: string };
  /** The submit owner, byte for byte (the 'owner' path and every fallback). */
  ownerSubmit(req: WakeRequest): Promise<unknown>;
  /** Capacity admission for an automatic turn; `decision` goes back to confirm or cancel. */
  admit(agentId: string): { proceed: boolean; basis: string; decision: unknown };
  confirmLaunch(decision: unknown): void;
  cancelGrant(decision: unknown): void;
  /** Install the owner's hold for our typed-but-unsent text (no grant: it was cancelled), so the
   *  existing SEND_AGAIN / ALREADY_HANDLED rulings and notices apply. Never erases. */
  holdTyped(ptyId: string, req: WakeRequest, reason: 'WAKE_TYPED_NOT_SENT' | 'BOOT_NOT_SUBMITTED', detail: string): void;
  /** The coordinator's Stop claim (every event-mode refusal but the lifecycle one). */
  claimAtStop(agentId: string): StopClaim | null;
  /** Settle that claim: blocked = COMMITTED (a provisional epoch of STOP_CONFIRM_MS), else REFUSED. */
  settleAtStop(claim: StopClaim, blocked: boolean): void;
  log(row: Record<string, unknown>): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
}

/** Jim INFO 2: the shadow read gets ONLY this. No write, settle or align member exists to call. */
export interface WakeShadowDeps {
  codexFacts(ptyId: string): Promise<{ reading: GateReading | null; reason?: string }>;
}

/** The screen gate's class for this PTY right now, or why there is none. Read only; never throws. */
export async function shadowClass(sd: WakeShadowDeps, provider: AgentProvider | null, ptyId: string): Promise<string> {
  try {
    const r = await sd.codexFacts(ptyId);
    if (!r.reading) return `none:${r.reason ?? 'unreadable'}`;
    if (!r.reading.codex) return 'none:no-facts';
    return gateClass(provider, r.reading.codex);
  } catch {
    return 'none:threw';
  }
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Jim MUST 1: a wake's send id is its WHOLE nudge (every id token), not a 64-character head. */
export function wakeMatch(prompt: string, text: string): boolean {
  const want = norm(text);
  return want.length > 0 && norm(prompt).includes(want);
}

/** The id-set part of a coordinator request id (`inbox-wake:<agent>:<sha>:<gen>`). */
export function idSetOf(requestId: string): string {
  const parts = requestId.split(':');
  return parts.length >= 4 ? parts[parts.length - 2] : requestId;
}

interface Pending {
  requestId: string; kind: WakeKind; provider: AgentProvider | null; text: string; sentAt: number;
  hook: string; screen: Promise<string> | null; decision: unknown; done: boolean;
}

interface StopHeld { claim: StopClaim; decision: unknown; provider: AgentProvider | null }

type Counters = Record<string, number | Record<string, number>>;

export class WakeSender {
  private readonly answered = new Map<string, { outcome: unknown; at: number }>();
  /** Boot ids typed here and then handed to the owner (Jim SHOULD 1). */
  private readonly handed = new Map<string, { req: WakeRequest; at: number }>();
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly sessions = new Map<string, SessionMark>();
  private readonly pending = new Map<string, Pending>();
  private readonly stops = new Map<string, StopHeld>();
  private readonly bootIdleSince = new Map<string, number>();
  private readonly delivered = new Map<string, number>();
  private readonly lastPath = new Map<string, string>();
  private summary: Record<string, Counters> = {};
  private summaryAt: number;

  constructor(
    private readonly d: WakeSenderDeps,
    private readonly sd: WakeShadowDeps,
    private readonly config: () => { path: WakePath; stopContinue: unknown }
  ) {
    this.summaryAt = d.now();
  }

  /** Every main-session hook, as the hook server saw it. */
  noteHook(agentId: string | undefined, event: string, f: { prompt?: string; source?: string; stopHookActive?: boolean }): void {
    if (!agentId) return;
    if (event === 'SessionStart') { this.sessions.set(agentId, { at: this.d.now(), compact: f.source === 'compact' }); return; }
    const p = this.pending.get(agentId);
    if (!p || p.done) {
      // Jim SHOULD 2: the sentinel names no claim. With none in flight it confirms nothing.
      if (event === 'UserPromptSubmit' && typeof f.prompt === 'string' && norm(f.prompt) === CODEX_INBOX_WAKE_SENTINEL && this.d.providerOf(agentId) === 'codex') {
        this.row({ kind: 'wake-confirm-orphan', agentId, event });
      }
      return;
    }
    if (p.kind === 'stop') {
      // The turn we blocked went on: its next Stop says so, or any hook of the continued turn.
      if ((event === 'Stop' && f.stopHookActive === true) || event === 'PreToolUse' || event === 'PostToolUse' || event === 'PreInvocation') {
        this.confirm(agentId, p, 'DELIVERED', 'stop');
      }
      return;
    }
    if (event === 'UserPromptSubmit') {
      const prompt = typeof f.prompt === 'string' ? f.prompt : undefined;
      if (p.provider === 'codex') {
        if (prompt === undefined) this.confirm(agentId, p, 'DELIVERED-CORRELATED', 'correlated');
        else if (norm(prompt) === CODEX_INBOX_WAKE_SENTINEL) this.confirm(agentId, p, 'DELIVERED', 'writer');
        // A person's own prompt is not ours.
      } else if (prompt !== undefined && wakeMatch(prompt, p.text)) {
        this.confirm(agentId, p, 'DELIVERED', 'send-id');
      }
    } else if (event === 'PreInvocation' && p.provider === 'antigravity') {
      this.confirm(agentId, p, 'DELIVERED-CORRELATED', 'correlated');
    }
  }

  /** The agent's PTY closed: its session, confirms and boot clock are gone with it. */
  forget(agentId: string, ptyId?: string): void {
    this.sessions.delete(agentId);
    const p = this.pending.get(agentId);
    if (p) { p.done = true; this.pending.delete(agentId); }
    this.stops.delete(agentId);
    if (ptyId) this.bootIdleSince.delete(ptyId);
  }

  /** THE wake transport (the bridge's deps.submit, and the boot IPC). */
  submit(req: WakeRequest): Promise<unknown> {
    const path = this.config().path;
    this.notePath(req.agentId, path);
    if (path === 'owner') return this.d.ownerSubmit(req);
    if (req.admissionClass !== 'CAPACITY_GATED' && req.admissionClass !== 'BOOT_SEQUENCE') return this.d.ownerSubmit(req);
    this.prune();
    const known = this.answered.get(req.requestId);
    if (known) {
      // A typed-not-sent hold a person has since ruled on is the owner's from now on: it answers
      // HUMAN_HANDLED (ALREADY_HANDLED) or delivers through its own gates (SEND_AGAIN).
      const k = known.outcome as { kind?: unknown };
      const pty = this.d.ptyOf(req.agentId);
      if (k.kind === 'INTERFERED' && pty && !this.d.inhibited(pty)) {
        this.answered.delete(req.requestId);
        this.handed.set(req.requestId, { req, at: this.d.now() });
        return this.d.ownerSubmit(req);
      }
      return Promise.resolve(known.outcome);
    }
    const handed = this.handed.get(req.requestId);
    if (handed) return this.d.ownerSubmit(handed.req);
    const inFlight = this.running.get(req.requestId);
    if (inFlight) return inFlight;
    const run = this.run(req).then((o) => {
      // Only this sender's own typed answers are kept: a refusal is "ask again", and an answer the
      // owner gave is the owner's to replay (Jim SHOULD 1: never a stale TYPED_NOT_SENT for boot).
      const k = o && typeof o === 'object' ? o as { kind?: unknown; via?: unknown } : null;
      if (k && k.via === 'term' && (k.kind === 'COMMITTED' || k.kind === 'INTERFERED')) {
        this.answered.set(req.requestId, { outcome: o, at: this.d.now() });
        this.prune();
      }
      return o;
    }).finally(() => { this.running.delete(req.requestId); });
    this.running.set(req.requestId, run);
    return run;
  }

  private async run(req: WakeRequest): Promise<unknown> {
    const d = this.d;
    const boot = req.admissionClass === 'BOOT_SEQUENCE';
    const kind: WakeKind = boot ? 'boot' : 'inbox';
    if (req.priorText !== undefined) return this.viaOwner(req, kind, 'prior-text');
    const ptyId = d.ptyOf(req.agentId);
    if (!ptyId) return this.refuse(req, kind, 'NO_PTY');
    const provider = d.providerOf(req.agentId);
    if (provider === 'claude' && claudeModeKey(req.text)) return this.refuse(req, kind, 'TEXT_ENTERS_MODE', claudeModeKey(req.text) ?? undefined);
    let ready: HookIdle;
    if (boot) {
      const b = this.bootReady(req.agentId, ptyId, provider);
      if (b.owner) return this.viaOwner(req, kind, b.owner);
      if (!b.ready) return this.refuse(req, kind, 'TERMINAL_NOT_READY', 'boot:awaiting-ready-event');
      ready = { idle: true, by: 'session-start', at: b.at };
    } else {
      const f = d.idleFacts(req.agentId);
      ready = hookIdle(f, provider, this.sessions.get(req.agentId));
      // Q3: after a restart the lifecycle is unknown until the first event; the owner keeps today's
      // reconcile wake rather than a dark wait.
      if (!ready.idle && f.lifecycle === 'unknown') return this.viaOwner(req, kind, 'lifecycle-unknown');
    }
    const early = this.gates(req, kind, ptyId, provider, boot);
    if (early) return early;
    const needles = priorTextNeedles(req.text);
    if (needles.length === 0) return this.viaOwner(req, kind, 'short-text');
    let probe: { reading: { onPromptRow: boolean } | null; reason?: string };
    try { probe = await d.mirrorNeedle(ptyId, needles[0], req.text); } catch { probe = { reading: null, reason: 'unreadable' }; }
    if (!probe.reading) return this.viaOwner(req, kind, `mirror-${probe.reason ?? 'unreadable'}`);
    // The shadow: started now, read only, never awaited by the send.
    const screen = shadowClass(this.sd, provider, ptyId);
    let decision: unknown = null;
    if (!boot) {
      let adm: { proceed: boolean; basis: string; decision: unknown };
      try { adm = d.admit(req.agentId); } catch (e) { return this.refuse(req, kind, 'CAPACITY_HOLD', `admit-threw:${String(e)}`); }
      decision = adm.decision;
      if (!adm.proceed) { this.cancel(decision); return this.refuse(req, kind, 'CAPACITY_HOLD', adm.basis); }
    }
    const slot = await d.exclusive(ptyId, () => d.slot(req.agentId, () => this.send(req, kind, ptyId, provider, needles, decision, ready, screen)), WAKE_OWNER_WAIT_MS);
    if (!slot.ran) { this.cancel(decision); return this.refuse(req, kind, 'OWNER_BUSY'); }
    return slot.value;
  }

  /** Run before the slot and AGAIN inside it, right before the write (M3 MUST 1). */
  private gates(req: WakeRequest, kind: WakeKind, ptyId: string, provider: AgentProvider | null, boot: boolean): unknown | null {
    const d = this.d;
    if (!boot) {
      const idle = hookIdle(d.idleFacts(req.agentId), provider, this.sessions.get(req.agentId));
      if (!idle.idle) return this.refuse(req, kind, 'NOT_IDLE', idle.by);
    }
    if (d.inhibited(ptyId)) return this.refuse(req, kind, 'PTY_INHIBITED');
    const block = d.promptBlock(ptyId);
    if (block === 'draft') return this.refuse(req, kind, 'HUMAN_DRAFT');
    if (block === 'picker') return this.refuse(req, kind, 'PICKER_OPEN');
    if (block === 'settling') return this.refuse(req, kind, 'PROMPT_SETTLING');
    if (block === 'exited') return this.refuse(req, kind, 'TERMINAL_EXITED');
    const last = d.lastHumanInputAt(ptyId);
    if (last !== undefined && d.now() - last < HUMAN_QUIET_MS) return this.refuse(req, kind, 'HUMAN_TYPING');
    return null;
  }

  /** Inside the owner's chain and TermControl's slot: nothing else writes to this PTY's prompt. */
  private async send(req: WakeRequest, kind: WakeKind, ptyId: string, provider: AgentProvider | null, needles: string[],
    decision: unknown, ready: HookIdle, screen: Promise<string>): Promise<unknown> {
    const d = this.d;
    const again = this.gates(req, kind, ptyId, provider, kind === 'boot');
    if (again) { this.cancel(decision); return again; }
    const gen0 = d.humanGeneration(ptyId);
    const wrote = d.write(ptyId, payloadFor(req.text));
    if (!wrote.ok) { this.cancel(decision); return this.refuse(req, kind, 'WRITE_FAILED', wrote.error); }
    const typedAt = d.now();
    await d.settle(ptyId);
    const gapMs = Math.max(TERM_SETTLE_QUIET_MS, automaticEnterGapMs(provider ?? 'custom', req.text.length) ?? 0);
    const waited = d.now() - typedAt;
    if (waited < gapMs) await d.sleep(gapMs - waited);
    // Our write is PROGRAMMATIC: ANY move of the human generation is a person's (or god's) key.
    const gen1 = d.humanGeneration(ptyId);
    if (gen0 === undefined || gen1 !== gen0) return this.typedNotSent(req, kind, ptyId, 'HUMAN_TYPED', decision, ready, screen);
    let onPrompt = false;
    for (const n of composerNeedles(req.text, needles)) {
      try {
        const r = (await d.mirrorNeedle(ptyId, n, req.text)).reading;
        if (r && (r.onPromptRow || r.promptTailMatches === true)) { onPrompt = true; break; }
      } catch { /* not evidence */ }
    }
    if (!onPrompt) {
      // Jim SHOULD 1: a boot prompt that did not reach the composer, with no person's key, is the
      // owner's (its readiness gate and erase oracle, our text named as prior text).
      if (kind === 'boot') {
        // Our text may be on the screen: every retry of this id is the owner's from now on, so it
        // is never typed a second time here.
        const handed = { ...req, priorText: req.text };
        this.handed.set(req.requestId, { req: handed, at: d.now() });
        this.shadowRow(req.agentId, provider, req.requestId, kind, ready.by, screen, 'OWNER', 'boot-not-in-composer');
        return this.viaOwner(handed, kind, 'boot-not-in-composer');
      }
      return this.typedNotSent(req, kind, ptyId, 'NOT_IN_COMPOSER', decision, ready, screen);
    }
    const enter = d.write(ptyId, '\r');
    if (!enter.ok) return this.typedNotSent(req, kind, ptyId, 'ENTER_FAILED', decision, ready, screen);
    if (decision !== null) { try { d.confirmLaunch(decision); } catch { /* capacity bookkeeping only */ } }
    this.row({ kind: 'wake-send', agentId: req.agentId, requestId: req.requestId, wake: kind, provider, outcome: 'COMMITTED', len: req.text.length, gapMs, hook: ready.by });
    this.arm(req.agentId, { requestId: req.requestId, kind, provider, text: req.text, sentAt: d.now(), hook: ready.by, screen, decision: null, done: false });
    return { kind: 'COMMITTED', via: 'term' };
  }

  /** Typed, never Entered: held for a person (Q4: the grant is cancelled and nothing is erased). */
  private typedNotSent(req: WakeRequest, kind: WakeKind, ptyId: string, reason: 'HUMAN_TYPED' | 'NOT_IN_COMPOSER' | 'ENTER_FAILED',
    decision: unknown, ready: HookIdle, screen: Promise<string>): unknown {
    this.cancel(decision);
    const held = kind === 'boot' ? 'BOOT_NOT_SUBMITTED' as const : 'WAKE_TYPED_NOT_SENT' as const;
    try { this.d.holdTyped(ptyId, req, held, reason); } catch { /* the outcome still says INTERFERED */ }
    this.row({ kind: 'wake-send', agentId: req.agentId, requestId: req.requestId, wake: kind, provider: this.d.providerOf(req.agentId), outcome: 'TYPED_NOT_SENT', reason, len: req.text.length });
    this.shadowRow(req.agentId, this.d.providerOf(req.agentId), req.requestId, kind, ready.by, screen, 'TYPED_NOT_SENT', reason);
    return { kind: 'INTERFERED', reason: held, detail: reason, via: 'term' };
  }

  /** Jim SHOULD 1: Claude's SessionStart of this incarnation + 1 s; AGY's first idle + 1 s; Codex
   *  sends SessionStart only at its first turn, so its boot stays the owner's; no event in 20 s = the
   *  owner. */
  private bootReady(agentId: string, ptyId: string, provider: AgentProvider | null): { ready: boolean; at: number; owner?: string } {
    const now = this.d.now();
    const spawned = this.d.spawnedAt(ptyId);
    if (!(spawned > 0)) return { ready: false, at: 0, owner: 'boot-no-spawn-time' };
    if (provider === 'codex') return { ready: false, at: 0, owner: 'boot-codex-lazy-session-start' };
    let at = 0;
    if (provider === 'claude') {
      const s = this.sessions.get(agentId);
      if (s && !s.compact && s.at >= spawned) at = s.at;
    } else if (provider === 'antigravity') {
      if (this.d.idleFacts(agentId).lifecycle === 'idle') {
        if (!this.bootIdleSince.has(ptyId)) this.bootIdleSince.set(ptyId, now);
        at = this.bootIdleSince.get(ptyId) ?? now;
      }
    } else {
      return { ready: false, at: 0, owner: 'boot-provider' };
    }
    if (at > 0 && now - at >= WAKE_BOOT_SETTLE_MS) return { ready: true, at };
    if (now - spawned >= WAKE_BOOT_READY_MS) return { ready: false, at: 0, owner: 'boot-no-ready-event' };
    return { ready: false, at };
  }

  // — Stop-continue (15.5, 15.10) —

  /**
   * Inside the Stop hook, synchronously. HookServer has already checked guards 1, 4 and 7
   * (stop_hook_active or a subagent, one block per turn, AGY fullyIdle false) and the mail mode.
   * Here: the flags, guard 3 (a draft, a person's key), an owner hold, guard 6 (capacity) and the
   * coordinator's own claim (guards 2 and 5). Null = no block; the Stop goes on as today.
   */
  stopClaim(agentId: string): StopClaim | null {
    const d = this.d;
    const provider = d.providerOf(agentId);
    const cfg = this.config();
    if (!stopContinueOn(cfg.path, cfg.stopContinue, provider)) return null;
    const ptyId = d.ptyOf(agentId);
    if (!ptyId) return null;
    if (d.inhibited(ptyId)) return null;
    const block = d.promptBlock(ptyId);
    if (block === 'draft' || block === 'picker' || block === 'exited') return null;
    const last = d.lastHumanInputAt(ptyId);
    if (last !== undefined && d.now() - last < HUMAN_QUIET_MS) return null;
    let adm: { proceed: boolean; basis: string; decision: unknown };
    try { adm = d.admit(agentId); } catch { return null; }
    if (!adm.proceed) { this.cancel(adm.decision); return null; }
    let claim: StopClaim | null = null;
    try { claim = d.claimAtStop(agentId); } catch { claim = null; }
    if (!claim) { this.cancel(adm.decision); return null; }
    this.stops.set(agentId, { claim, decision: adm.decision, provider });
    return claim;
  }

  /** HookServer built the mail block (blocked) or had nothing to carry (the claim goes back). */
  stopSettle(agentId: string, requestId: string, blocked: boolean, reasonChars = 0): void {
    const s = this.stops.get(agentId);
    if (!s || s.claim.requestId !== requestId) return;
    this.stops.delete(agentId);
    try { this.d.settleAtStop(s.claim, blocked); } catch { /* the coordinator logs its own */ }
    if (!blocked) {
      this.cancel(s.decision);
      this.row({ kind: 'wake-stop', agentId, requestId, provider: s.provider, outcome: 'NOT_BLOCKED' });
      return;
    }
    this.row({ kind: 'wake-stop', agentId, requestId, provider: s.provider, outcome: 'BLOCKED', ids: s.claim.ids.length, reasonChars });
    this.arm(agentId, { requestId, kind: 'stop', provider: s.provider, text: '', sentAt: this.d.now(), hook: 'stop', screen: null, decision: s.decision, done: false });
  }

  // — confirm, rows and the shadow summary —

  private arm(agentId: string, p: Pending): void {
    const prior = this.pending.get(agentId);
    if (p.kind !== 'boot') this.checkDouble(agentId, p.requestId, p.provider);
    if (prior && !prior.done) this.confirm(agentId, prior, 'SUPERSEDED', 'correlated');
    this.pending.set(agentId, p);
    const ms = p.kind === 'stop' ? STOP_CONFIRM_MS : p.provider === 'antigravity' ? WAKE_CONFIRM_AGY_MS : WAKE_CONFIRM_MS;
    this.d.setTimer(() => {
      if (p.done || this.pending.get(agentId) !== p) return;
      this.confirm(agentId, p, 'UNKNOWN', 'correlated');
    }, ms);
  }

  /** 15.7: a wake that went out for ids a wake already delivered, or for the ids of a wake still
   *  waiting for its confirm, on either path (a boot prompt carries no mail ids). */
  private checkDouble(agentId: string, requestId: string, provider: AgentProvider | null): void {
    const ids = idSetOf(requestId);
    const was = this.delivered.get(`${agentId}\u0000${ids}`);
    const prior = this.pending.get(agentId);
    if ((was !== undefined && this.d.now() - was < WAKE_DOUBLE_WINDOW_MS)
      || (prior !== undefined && !prior.done && prior.kind !== 'boot' && idSetOf(prior.requestId) === ids)) {
      this.count(provider, 'doubleSubmit');
    }
  }

  private confirm(agentId: string, p: Pending, how: WakeConfirm, by: ConfirmBy): void {
    p.done = true;
    if (this.pending.get(agentId) === p) this.pending.delete(agentId);
    if (p.decision !== null) {
      // A continued turn is an automatic start: its grant is spent when the turn is seen going on.
      if (how === 'DELIVERED') { try { this.d.confirmLaunch(p.decision); } catch { /* bookkeeping */ } }
      else this.cancel(p.decision);
      p.decision = null;
    }
    if (p.kind !== 'boot' && (how === 'DELIVERED' || how === 'DELIVERED-CORRELATED')) this.delivered.set(`${agentId}\u0000${idSetOf(p.requestId)}`, this.d.now());
    this.row({
      kind: 'wake-confirm', agentId, requestId: p.requestId, wake: p.kind, provider: p.provider, confirm: how,
      ...(how === 'DELIVERED' || how === 'DELIVERED-CORRELATED' ? { by } : {}), confirmMs: this.d.now() - p.sentAt
    });
    if (how === 'UNKNOWN') this.row({ kind: 'wake-attention', agentId, why: 'WAKE_UNKNOWN', hint: `term read ${agentId}` });
    this.shadowRow(agentId, p.provider, p.requestId, p.kind, p.hook, p.screen, 'COMMITTED', how);
  }

  /** One `wake-shadow` row per wake: what the screen gate would have said, beside what happened. */
  private shadowRow(agentId: string, provider: AgentProvider | null, requestId: string, kind: WakeKind, hook: string,
    screen: Promise<string> | null, outcome: string, confirm: string): void {
    const write = (cls: string): void => {
      this.row({ kind: 'wake-shadow', agentId, provider, requestId, wake: kind, hook, screen: cls, outcome, confirm });
      this.count(provider, 'wakes');
      if (confirm === 'DELIVERED') this.count(provider, 'delivered');
      else if (confirm === 'DELIVERED-CORRELATED') this.count(provider, 'correlated');
      else if (confirm === 'UNKNOWN') this.count(provider, 'unknown');
      if (outcome === 'TYPED_NOT_SENT') this.count(provider, 'typedNotSent');
      if (outcome === 'OWNER') this.countIn(provider, 'ownerFallback', confirm);
      const allows = cls === 'READY';
      const failed = outcome === 'TYPED_NOT_SENT' || confirm === 'UNKNOWN';
      if (kind !== 'stop' && !cls.startsWith('none:')) {
        if (!allows) this.countIn(provider, 'screenWouldRefuse', cls);
        if (!allows && (confirm === 'DELIVERED' || confirm === 'DELIVERED-CORRELATED')) this.count(provider, 'screenRefusedButDelivered');
        if (allows && failed) this.count(provider, 'screenAllowedButFailed');
      }
    };
    if (!screen) { write('n/a'); return; }
    void screen.then(write, () => write('none:threw'));
  }

  private count(provider: AgentProvider | null, k: string): void {
    const s = (this.summary[provider ?? 'unknown'] ??= {});
    s[k] = ((s[k] as number | undefined) ?? 0) + 1;
  }

  private countIn(provider: AgentProvider | null, k: string, sub: string): void {
    const s = (this.summary[provider ?? 'unknown'] ??= {});
    const m = (s[k] ??= {}) as Record<string, number>;
    m[sub] = (m[sub] ?? 0) + 1;
  }

  /** The shadow counters so far (tests; the summary row carries the same). */
  counters(): Record<string, Counters> {
    return JSON.parse(JSON.stringify(this.summary)) as Record<string, Counters>;
  }

  private row(r: Record<string, unknown>): void {
    try { this.d.log(r); } catch { /* logging only */ }
    const now = this.d.now();
    if (now - this.summaryAt >= WAKE_SHADOW_SUMMARY_MS) {
      this.summaryAt = now;
      const s = this.summary;
      this.summary = {};
      try { this.d.log({ kind: 'wake-shadow-summary', providers: s }); } catch { /* logging only */ }
    }
  }

  private notePath(agentId: string, path: WakePath): void {
    if (this.lastPath.get(agentId) === path) return;
    this.lastPath.set(agentId, path);
    this.row({ kind: 'wake-path', agentId, path });
  }

  private cancel(decision: unknown): void {
    if (decision === null || decision === undefined) return;
    try { this.d.cancelGrant(decision); } catch { /* bookkeeping only */ }
  }

  private refuse(req: WakeRequest, kind: WakeKind, reason: string, detail?: string): unknown {
    this.row({ kind: 'wake-send', agentId: req.agentId, requestId: req.requestId, wake: kind, outcome: 'REFUSED', reason, ...(detail ? { detail } : {}) });
    return detail === undefined ? { kind: 'REFUSED', reason } : { kind: 'REFUSED', reason, detail };
  }

  private async viaOwner(req: WakeRequest, kind: WakeKind, why: string): Promise<unknown> {
    const outcome = await this.d.ownerSubmit(req);
    const k = outcome && typeof outcome === 'object' ? (outcome as { kind?: unknown }).kind : undefined;
    if (kind === 'inbox' && k === 'COMMITTED') this.checkDouble(req.agentId, req.requestId, this.d.providerOf(req.agentId));
    this.row({ kind: 'wake-send', agentId: req.agentId, requestId: req.requestId, wake: kind, path: 'owner', why, outcome: typeof k === 'string' ? k : 'unknown' });
    if (why !== 'boot-not-in-composer') this.countIn(this.d.providerOf(req.agentId), 'ownerFallback', why);
    return outcome;
  }

  private prune(): void {
    const now = this.d.now();
    for (const [id, a] of this.answered) if (now - a.at > WAKE_REPLAY_MS) this.answered.delete(id);
    while (this.answered.size > WAKE_REPLAY_MAX) this.answered.delete(this.answered.keys().next().value as string);
    for (const [id, h] of this.handed) if (now - h.at > WAKE_REPLAY_MS) this.handed.delete(id);
    while (this.handed.size > WAKE_REPLAY_MAX) this.handed.delete(this.handed.keys().next().value as string);
    for (const [k, at] of this.delivered) if (now - at > WAKE_DOUBLE_WINDOW_MS) this.delivered.delete(k);
  }
}
