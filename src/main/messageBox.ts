/**
 * GTC M3: the Human's message box delivers through TermControl, gated by MAIN's hook state.
 * Design: agents/andy-mtuk4y4x/GOD-TERMINAL-CONTROL-DESIGN.md section 14, Jim OK WITH CHANGES
 * (2026-10-19 01:51Z: MUST 1 the gates re-checked in the write's own slot and the owner locked out
 * until the Enter; MUST 2 the composer checked on the mirror before the Enter; MUST 3 HUMAN
 * provenance is the app window's own IPC, checked by the caller).
 *
 * Only the Human's own queue items (`human: true`, set by MessageQueueComposer alone) come here.
 * Automatic items stay on the submit owner until M4. Config `messageBoxPath: 'owner'` sends the
 * Human's items through the owner too, exactly as before (one release, then deleted).
 *
 * What decides, in order (section 14.4):
 *   idle      main's hook lifecycle (WorkerWakeWatchdog), never the renderer's status or a screen
 *             reading; Send-now (`now`) skips ONLY this;
 *   prompt    the prompt state main already holds (a Human draft or an open picker vetoes);
 *   quiet     no HUMAN/GOD key on the PTY within HUMAN_QUIET_MS;
 *   mirror    a live, unseeded mirror is required, or the item goes to the owner instead (Jim
 *             MUST 2: never an Enter we cannot check);
 *   exclusive the send runs inside the owner's one chain for the PTY AND TermControl's slot for the
 *             agent, and re-checks idle/prompt/quiet there, right before its first write;
 *   composer  after the echo settles, our text's tail must be on the prompt row of the mirror, and
 *             nobody may have typed since our write; otherwise no Enter (TYPED_NOT_SENT);
 *   confirm   UserPromptSubmit carrying our text = DELIVERED; an AGY PreInvocation after the send =
 *             DELIVERED-CORRELATED; a slash command = COMMAND (no hook carries it); neither in the
 *             window = UNKNOWN. Nothing is ever retried: the text was typed.
 * Pure logic over injected deps (unit-testable): no electron, no node-pty.
 */
import type { AgentProvider } from '../shared/agentProvider';
import { automaticEnterGapMs } from '../shared/providerAutomation';
import type { PromptBlock } from '../shared/promptState';
import { claudeModeKey, HUMAN_QUIET_MS, payloadFor, priorTextNeedles } from './automaticSubmit';
import { TERM_SETTLE_QUIET_MS } from './termControl';

export type MessageBoxPath = 'term' | 'owner';

/** A config value as a path: anything but 'owner' is the new path. */
export function messageBoxPathOf(v: unknown): MessageBoxPath {
  return v === 'owner' ? 'owner' : 'term';
}

/** How long the owner's chain may keep a human send from starting (an owner run in flight). */
export const MESSAGE_BOX_OWNER_WAIT_MS = 5_000;
/** DELIVERED must arrive within this (section 6, 10.2). */
export const MESSAGE_BOX_CONFIRM_MS = 10_000;
/** A Send-now into a busy turn is picked up when the turn ends (Jim SHOULD 1): a longer window,
 *  and its expiry is said gently (UNCONFIRMED_BUSY), with no digest item. */
export const MESSAGE_BOX_BUSY_CONFIRM_MS = 120_000;
/** A NOT_IDLE wait past this, with the terminal quiet as long, is stale (section 14.6). */
export const MESSAGE_BOX_STALE_MS = 5 * 60_000;
/** A composer note is shown this long. */
export const MESSAGE_BOX_NOTE_MS = 10 * 60_000;
/** Jim SHOULD 2: answered request ids are kept this long, at most this many. A main restart forgets
 *  them, which is safe: the renderer dropped the item when it was answered SENT. */
export const MESSAGE_BOX_REPLAY_MS = 60 * 60_000;
export const MESSAGE_BOX_REPLAY_MAX = 500;
/** A NOT_IDLE wait not asked about for this long is over (the drain asks every 3 s). */
export const MESSAGE_BOX_WAIT_GAP_MS = 15_000;
/** A digest item stays listed this long. */
export const MESSAGE_BOX_ATTENTION_MS = 60 * 60_000;

export interface IdleFacts {
  lifecycle: 'active' | 'idle' | 'unknown';
  activeSince: number;
  turnStartAt: number;
  lastTurnEndAt: number;
}

/** The newest SessionStart main saw for the agent, and whether it was a compaction's. */
export interface SessionMark { at: number; compact: boolean }

export type IdleBy = 'turn-ended' | 'session-start' | 'turn-open' | 'no-session-start' | 'compact-start' | 'agy-start-unproven';
export interface HookIdle { idle: boolean; by: IdleBy; at: number }

/**
 * Section 14.3 and 10.1: only an event says idle. `idle` lifecycle = the provider ended its turn
 * (Stop / StopFailure; an AGY Stop only when fully idle; a Codex rollout task_complete; the AGY
 * statusline past its confirm grace) - WorkerWakeWatchdog already applies each of those rules.
 * A fresh session (lifecycle `unknown` after a non-compact SessionStart, no turn since) is READY,
 * except for AGY: whether AGY's SessionStart comes before its composer is up is not proven (Jim
 * SHOULD 3), so an AGY item waits for AGY's own first idle. `unknown` with no SessionStart is not idle.
 */
export function hookIdle(f: IdleFacts, provider: AgentProvider | null, start: SessionMark | undefined): HookIdle {
  if (f.lifecycle === 'idle') return { idle: true, by: 'turn-ended', at: f.lastTurnEndAt };
  if (f.lifecycle === 'active') return { idle: false, by: 'turn-open', at: f.activeSince || f.turnStartAt };
  if (!start) return { idle: false, by: 'no-session-start', at: 0 };
  if (start.compact) return { idle: false, by: 'compact-start', at: start.at };
  if (start.at < f.turnStartAt || start.at < f.lastTurnEndAt) return { idle: false, by: 'no-session-start', at: start.at };
  if (provider === 'antigravity') return { idle: false, by: 'agy-start-unproven', at: start.at };
  return { idle: true, by: 'session-start', at: start.at };
}

export type MessageBoxRefusal =
  | 'BAD_REQUEST' | 'NOT_FROM_APP_WINDOW' | 'NO_PTY' | 'TEXT_ENTERS_MODE' | 'NOT_IDLE'
  | 'DRAFT_IN_TERMINAL' | 'PICKER_OPEN' | 'PROMPT_SETTLING' | 'TERMINAL_EXITED' | 'HUMAN_TYPING' | 'OWNER_BUSY' | 'WRITE_FAILED';
export type TypedNotSent = 'NOT_IN_COMPOSER' | 'HUMAN_TYPED' | 'ENTER_FAILED';
export type Confirm = 'DELIVERED' | 'DELIVERED-CORRELATED' | 'COMMAND' | 'UNKNOWN' | 'UNCONFIRMED_BUSY' | 'SUPERSEDED';

export type MessageBoxOutcome =
  | { kind: 'COMMITTED'; via: 'term'; command: boolean }
  | { kind: 'REFUSED'; reason: MessageBoxRefusal; detail?: string; since?: number; stale?: boolean }
  | { kind: 'TYPED_NOT_SENT'; reason: TypedNotSent };

export interface MessageBoxRequest { requestId: string; agentId: string; text: string; now: boolean }

export interface MessageBoxDeps {
  ptyOf(agentId: string): string | undefined;
  providerOf(agentId: string): AgentProvider | null;
  idleFacts(agentId: string): IdleFacts;
  promptBlock(ptyId: string): PromptBlock | undefined;
  lastHumanInputAt(ptyId: string): number | undefined;
  humanGeneration(ptyId: string): number | undefined;
  /** The mirror's needle reading (GTC M2 `mirrorGateReading`): null with a reason = no live mirror. */
  mirrorNeedle(ptyId: string, needle: string, expectedTail: string): Promise<{ reading: { onPromptRow: boolean; promptTailMatches?: boolean } | null; reason?: string }>;
  /** Run `fn` inside the submit owner's ONE chain for the PTY (no owner STAGE..COMMIT or settle can
   *  interleave). `ran: false` = it did not start within `startMs`, and it never runs. */
  exclusive<T>(ptyId: string, fn: () => Promise<T>, startMs: number): Promise<{ ran: true; value: T } | { ran: false }>;
  /** Run `fn` in TermControl's one-action slot for the agent (shared with god's `term`). */
  slot<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  /** TermControl's echo settle (the output generation still for 150 ms, capped). */
  settle(ptyId: string): Promise<void>;
  /** Writes with origin HUMAN (the caller binds it; this module never chooses an origin). */
  write(ptyId: string, data: string): { ok: boolean; error?: string };
  /** The old path, for 'owner' and for an item the mirror cannot check. */
  ownerSubmit(req: { requestId: string; agentId: string; admissionClass: 'USER_RELEASED' | 'CAPACITY_GATED'; text: string }): Promise<unknown>;
  /** ms since the PTY last printed anything (undefined = unknown). */
  outputQuietMs(ptyId: string): number | undefined;
  log(row: Record<string, unknown>): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
}

/** A digest item (section 14.4 step 9, 14.6): something the Human or god should look at. */
export interface MessageBoxAttention { agentId: string; why: 'UNKNOWN' | TypedNotSent | 'STALE_WAIT'; at: number }

interface Pending { requestId: string; fingerprint: string; sentAt: number; agy: boolean; done: boolean }

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** The head of our text as UserPromptSubmit's `prompt` would carry it. */
export function fingerprintOf(text: string): string {
  return norm(text).slice(0, 64);
}

/** A large paste is shown collapsed to one token, not as its text: Claude's `[Pasted text #N …]`
 *  (tuiComposer.ts CLAUDE_PASTE_TOKEN), Codex's `[Pasted Content …]`. Only multi-line text goes
 *  as a paste (payloadFor), and the generation check proves nobody else typed since our write. */
export const PASTE_TOKENS = ['[Pasted text #', '[Pasted Content'] as const;
export function composerNeedles(text: string, tail: string[]): string[] {
  return text.includes('\n') ? [...tail, ...PASTE_TOKENS] : tail;
}

export class MessageBox {
  private readonly answered = new Map<string, { outcome: MessageBoxOutcome; at: number }>();
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly sessions = new Map<string, SessionMark>();
  private readonly pending = new Map<string, Pending>();
  private readonly waits = new Map<string, { since: number; staleSaid: boolean; lastRowAt: number; seen: number }>();
  private readonly refusalRows = new Map<string, number>();
  private readonly notes = new Map<string, { text: string; at: number }>();
  private attention: MessageBoxAttention[] = [];

  constructor(private readonly d: MessageBoxDeps, private readonly path: () => MessageBoxPath) {}

  /** Every main-session hook, as the hook server saw it (section 14.4 step 9). */
  noteHook(agentId: string | undefined, event: string, f: { prompt?: string; source?: string }): void {
    if (!agentId) return;
    const at = this.d.now();
    if (event === 'SessionStart') { this.sessions.set(agentId, { at, compact: f.source === 'compact' }); return; }
    const p = this.pending.get(agentId);
    if (!p || p.done) return;
    // A Human's own UPS with other text never confirms ours (Jim 9.6).
    if (event === 'UserPromptSubmit' && typeof f.prompt === 'string' && norm(f.prompt).includes(p.fingerprint)) this.confirm(agentId, p, 'DELIVERED');
    else if (event === 'PreInvocation' && p.agy) this.confirm(agentId, p, 'DELIVERED-CORRELATED');
  }

  /** The renderer's snapshot view: the path, and the note the composer shows. */
  view(agentId: string): { path: MessageBoxPath; note: string | null; stale: boolean } {
    const n = this.notes.get(agentId);
    const fresh = n && this.d.now() - n.at < MESSAGE_BOX_NOTE_MS ? n.text : null;
    if (n && !fresh) this.notes.delete(agentId);
    const now = this.d.now();
    const stale = [...this.waits.entries()].some(([k, w]) => k.startsWith(`${agentId}\u0000`) && w.staleSaid && now - w.seen <= MESSAGE_BOX_WAIT_GAP_MS);
    return { path: this.path(), note: fresh, stale };
  }

  /** The digest's items of the last MESSAGE_BOX_ATTENTION_MS, newest last (the digest wakes god
   *  once per item id). */
  attentionItems(): MessageBoxAttention[] {
    const now = this.d.now();
    this.attention = this.attention.filter((a) => now - a.at < MESSAGE_BOX_ATTENTION_MS);
    return [...this.attention];
  }

  /** The agent's PTY closed: its session, pending confirm and waits are gone with it. */
  forget(agentId: string): void {
    this.sessions.delete(agentId);
    this.pending.delete(agentId);
    for (const k of [...this.waits.keys()]) if (k.startsWith(`${agentId}\u0000`)) this.waits.delete(k);
  }

  deliver(req: MessageBoxRequest): Promise<MessageBoxOutcome | unknown> {
    this.prune();
    const known = this.answered.get(req.requestId);
    if (known) return Promise.resolve(known.outcome);
    const inFlight = this.running.get(req.requestId);
    if (inFlight) return inFlight;
    const run = this.run(req).then((o) => {
      // Only this box's own typed answers are kept: a refusal is "ask again", and an item the
      // owner took is the owner's to replay (its INTERFERED later becomes HUMAN_HANDLED).
      const k = o && typeof o === 'object' ? o as MessageBoxOutcome : null;
      if (k && ((k.kind === 'COMMITTED' && (k as { via?: string }).via === 'term') || k.kind === 'TYPED_NOT_SENT')) {
        this.answered.set(req.requestId, { outcome: o as MessageBoxOutcome, at: this.d.now() });
        this.prune();
      }
      return o;
    }).finally(() => { this.running.delete(req.requestId); });
    this.running.set(req.requestId, run);
    return run;
  }

  private async run(req: MessageBoxRequest): Promise<MessageBoxOutcome | unknown> {
    const d = this.d;
    const old = { requestId: req.requestId, agentId: req.agentId, admissionClass: req.now ? 'USER_RELEASED' as const : 'CAPACITY_GATED' as const, text: req.text };
    if (this.path() === 'owner') return this.viaOwner(req, old, 'config');
    const ptyId = d.ptyOf(req.agentId);
    if (!ptyId) return this.refuse(req, 'NO_PTY');
    const provider = d.providerOf(req.agentId);
    if (provider === 'claude' && claudeModeKey(req.text)) return this.refuse(req, 'TEXT_ENTERS_MODE', claudeModeKey(req.text) ?? undefined);
    const early = this.gates(req, ptyId, provider);
    if (early) return early;
    // Jim MUST 2: an Enter is pressed only when the mirror can show our text on the prompt row.
    const needles = priorTextNeedles(req.text);
    if (needles.length === 0) return this.viaOwner(req, old, 'short-text');
    let probe: { reading: { onPromptRow: boolean } | null; reason?: string };
    try { probe = await d.mirrorNeedle(ptyId, needles[0], req.text); } catch { probe = { reading: null, reason: 'unreadable' }; }
    if (!probe.reading) return this.viaOwner(req, old, `mirror-${probe.reason ?? 'unreadable'}`);

    const slot = await d.exclusive(ptyId, () => d.slot(req.agentId, () => this.send(req, ptyId, provider, needles)), MESSAGE_BOX_OWNER_WAIT_MS);
    if (!slot.ran) return this.refuse(req, 'OWNER_BUSY');
    return slot.value;
  }

  /** Steps 3-5 of section 14.4. Run before the slot and AGAIN inside it, right before the write. */
  private gates(req: MessageBoxRequest, ptyId: string, provider: AgentProvider | null): MessageBoxOutcome | null {
    const d = this.d;
    if (!req.now) {
      const idle = hookIdle(d.idleFacts(req.agentId), provider, this.sessions.get(req.agentId));
      if (!idle.idle) return this.notIdle(req, ptyId, idle);
    }
    const block = d.promptBlock(ptyId);
    if (block === 'draft') return this.refuse(req, 'DRAFT_IN_TERMINAL');
    if (block === 'picker') return this.refuse(req, 'PICKER_OPEN');
    if (block === 'settling') return this.refuse(req, 'PROMPT_SETTLING');
    if (block === 'exited') return this.refuse(req, 'TERMINAL_EXITED');
    const last = d.lastHumanInputAt(ptyId);
    if (last !== undefined && d.now() - last < HUMAN_QUIET_MS) return this.refuse(req, 'HUMAN_TYPING');
    return null;
  }

  /** Inside the owner's chain and TermControl's slot: nothing else can write to this PTY's prompt. */
  private async send(req: MessageBoxRequest, ptyId: string, provider: AgentProvider | null, needles: string[]): Promise<MessageBoxOutcome> {
    const d = this.d;
    // Jim MUST 1: the hook state or the prompt may have changed while the slot was awaited.
    const again = this.gates(req, ptyId, provider);
    if (again) return again;
    const busy = req.now && !hookIdle(d.idleFacts(req.agentId), provider, this.sessions.get(req.agentId)).idle;
    const gen0 = d.humanGeneration(ptyId);
    const payload = payloadFor(req.text);
    const wrote = d.write(ptyId, payload);
    if (!wrote.ok) return this.refuse(req, 'WRITE_FAILED', wrote.error);
    const typedAt = d.now();
    await d.settle(ptyId);
    const gapMs = Math.max(TERM_SETTLE_QUIET_MS, automaticEnterGapMs(provider ?? 'custom', req.text.length) ?? 0);
    const waited = d.now() - typedAt;
    if (waited < gapMs) await d.sleep(gapMs - waited);
    // Jim MUST 2: nobody typed during the gap (the Enter would submit the mixed text) ...
    const gen1 = d.humanGeneration(ptyId);
    if (gen0 === undefined || gen1 !== gen0 + 1) return this.typedNotSent(req, 'HUMAN_TYPED');
    // ... and our text reached the composer (a popup, dialog or trust prompt would eat it, and the
    // Enter would pick an option). The owner's COMMIT accepts the same two answers.
    let onPrompt = false;
    for (const n of composerNeedles(req.text, needles)) {
      try {
        const r = (await d.mirrorNeedle(ptyId, n, req.text)).reading;
        if (r && (r.onPromptRow || r.promptTailMatches === true)) { onPrompt = true; break; }
      } catch { /* not evidence */ }
    }
    if (!onPrompt) return this.typedNotSent(req, 'NOT_IN_COMPOSER');
    const enter = d.write(ptyId, '\r');
    if (!enter.ok) return this.typedNotSent(req, 'ENTER_FAILED');
    const command = req.text.trimStart().startsWith('/');
    this.waits.delete(this.waitKey(req));
    this.log(req, { outcome: 'COMMITTED', len: req.text.length, gapMs, busy, command });
    if (command) this.note(req.agentId, null);
    else this.arm(req, provider, busy);
    return { kind: 'COMMITTED', via: 'term', command };
  }

  private arm(req: MessageBoxRequest, provider: AgentProvider | null, busy: boolean): void {
    const p: Pending = { requestId: req.requestId, fingerprint: fingerprintOf(req.text), sentAt: this.d.now(), agy: provider === 'antigravity', done: false };
    // Jim SHOULD 1 (9e6216): one pending confirm per agent, so an older one still waiting is settled
    // with its own row, never silently overwritten.
    const prior = this.pending.get(req.agentId);
    if (prior && !prior.done) this.confirm(req.agentId, prior, 'SUPERSEDED');
    this.pending.set(req.agentId, p);
    this.d.setTimer(() => {
      if (p.done || this.pending.get(req.agentId) !== p) return;
      this.confirm(req.agentId, p, busy ? 'UNCONFIRMED_BUSY' : 'UNKNOWN');
    }, busy ? MESSAGE_BOX_BUSY_CONFIRM_MS : MESSAGE_BOX_CONFIRM_MS);
  }

  private confirm(agentId: string, p: Pending, how: Confirm): void {
    p.done = true;
    if (this.pending.get(agentId) === p) this.pending.delete(agentId);
    const ms = this.d.now() - p.sentAt;
    try { this.d.log({ kind: 'message-box-confirm', agentId, requestId: p.requestId, confirm: how, confirmMs: ms }); } catch { /* logging only */ }
    if (how === 'UNKNOWN') {
      this.note(agentId, 'sent, but the agent has not confirmed it - check the terminal');
      this.attention.push({ agentId, why: 'UNKNOWN', at: this.d.now() });
    } else if (how === 'UNCONFIRMED_BUSY') {
      this.note(agentId, 'sent into a busy turn - it is picked up when the turn ends; check the terminal if not');
    } else {
      this.note(agentId, null);
    }
  }

  private typedNotSent(req: MessageBoxRequest, reason: TypedNotSent): MessageBoxOutcome {
    this.waits.delete(this.waitKey(req));
    this.log(req, { outcome: 'TYPED_NOT_SENT', reason, len: req.text.length });
    this.note(req.agentId, reason === 'HUMAN_TYPED'
      ? 'typed but not sent: someone typed in the terminal during the send - check it, press Enter there if wanted'
      : reason === 'NOT_IN_COMPOSER'
        ? 'typed but not sent: the text did not show on the prompt (a dialog or popup?) - check the terminal'
        : 'typed but not sent: the Enter could not be written - check the terminal');
    this.attention.push({ agentId: req.agentId, why: reason, at: this.d.now() });
    return { kind: 'TYPED_NOT_SENT', reason };
  }

  private notIdle(req: MessageBoxRequest, ptyId: string, idle: HookIdle): MessageBoxOutcome {
    const now = this.d.now();
    const key = this.waitKey(req);
    // A wait the drain stopped asking about (another refusal came between, or the item was
    // removed) is over; the drain asks every few seconds while it lasts.
    const old = this.waits.get(key);
    const w = old && now - old.seen <= MESSAGE_BOX_WAIT_GAP_MS ? old : { since: now, staleSaid: false, lastRowAt: 0, seen: now };
    w.seen = now;
    this.waits.set(key, w);
    const quiet = this.d.outputQuietMs(ptyId);
    const stale = now - w.since >= MESSAGE_BOX_STALE_MS && quiet !== undefined && quiet >= MESSAGE_BOX_STALE_MS;
    if (stale && !w.staleSaid) {
      w.staleSaid = true;
      this.attention.push({ agentId: req.agentId, why: 'STALE_WAIT', at: now });
      try { this.d.log({ kind: 'term-disagree', agentId: req.agentId, requestId: req.requestId, hook: idle.by, since: w.since, outputQuietMs: quiet, hint: `term read ${req.agentId}` }); } catch { /* logging only */ }
    }
    if (now - w.lastRowAt >= 60_000) { w.lastRowAt = now; this.log(req, { outcome: 'REFUSED', reason: 'NOT_IDLE', idle }); }
    return { kind: 'REFUSED', reason: 'NOT_IDLE', detail: idle.by, since: w.since, stale };
  }

  private refuse(req: MessageBoxRequest, reason: MessageBoxRefusal, detail?: string): MessageBoxOutcome {
    // The drain asks again every few seconds: one row per item and reason per minute.
    const key = `${this.waitKey(req)}\u0000${reason}`;
    const now = this.d.now();
    if (now - (this.refusalRows.get(key) ?? -Infinity) >= 60_000) {
      this.refusalRows.set(key, now);
      this.log(req, { outcome: 'REFUSED', reason, ...(detail ? { detail } : {}) });
    }
    return detail === undefined ? { kind: 'REFUSED', reason } : { kind: 'REFUSED', reason, detail };
  }

  private async viaOwner(req: MessageBoxRequest, old: Parameters<MessageBoxDeps['ownerSubmit']>[0], why: string): Promise<unknown> {
    const outcome = await this.d.ownerSubmit(old);
    const kind = outcome && typeof outcome === 'object' ? (outcome as { kind?: unknown }).kind : undefined;
    this.log(req, { outcome: typeof kind === 'string' ? kind : 'unknown', path: 'owner', why });
    return outcome;
  }

  private log(req: MessageBoxRequest, row: Record<string, unknown>): void {
    try { this.d.log({ kind: 'message-box', agentId: req.agentId, requestId: req.requestId, path: row.path ?? 'term', now: req.now, ...row }); } catch { /* logging only */ }
  }

  private note(agentId: string, text: string | null): void {
    if (text) this.notes.set(agentId, { text, at: this.d.now() });
    else this.notes.delete(agentId);
  }

  private waitKey(req: MessageBoxRequest): string { return `${req.agentId}\u0000${req.requestId}`; }

  private prune(): void {
    const now = this.d.now();
    for (const [id, a] of this.answered) if (now - a.at > MESSAGE_BOX_REPLAY_MS) this.answered.delete(id);
    while (this.answered.size > MESSAGE_BOX_REPLAY_MAX) this.answered.delete(this.answered.keys().next().value as string);
    for (const [k, w] of this.waits) if (now - w.seen > MESSAGE_BOX_WAIT_GAP_MS) this.waits.delete(k);
    for (const [k, at] of this.refusalRows) if (now - at > 60_000) this.refusalRows.delete(k);
  }
}
