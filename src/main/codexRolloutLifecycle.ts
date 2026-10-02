/**
 * FALSEACTIVE-STALL-2 (B1, god's ruling): Codex's OWN record of whether a turn is over.
 *
 * The hook stream can lose a Stop (Oscar, 2026-09-25: Codex completed turn 01a0d9c2 at
 * 20:12:25.27, and no Stop for it ever reached the app), and then the wake coordinator
 * knows the agent is active and has nothing authoritative to close the turn with. D3 is
 * ratified and stays: PTY silence never stands in for a positively active turn.
 *
 * Codex writes every turn boundary to the rollout the app already tails for capacity:
 * `event_msg` lines of type `task_started` and `task_complete`, each with the `turn_id`.
 * That is a provider-native lifecycle reading, the same kind the design already ratified
 * for Antigravity's statusline. Read on the reconcile beat, only for an ACTIVE agent with
 * mail waiting, from a bounded tail.
 *
 * Fails CLOSED everywhere: no home, no rollout, an unreadable file, a tail with no turn
 * boundary in it, or a newest boundary that is a START all mean "no proof", and the agent
 * stays active.
 */
import { statSync } from 'node:fs';
import { findNewestRollout, readTail } from './codexRolloutCapacity';

/** How much of the rollout tail is read. The newest turn boundary is normally in the last
 *  few KB (after task_complete Codex writes only a token count); a boundary beyond this
 *  window means "no proof" and the agent stays active. Bounded on purpose: 1.1.49's
 *  logTail read a whole growing file on every poll. */
export const CODEX_LIFECYCLE_TAIL_BYTES = 64 * 1024;

export interface CodexTurnEvent {
  kind: 'started' | 'complete';
  turnId: string;
  /** The event's own timestamp (ms), as Codex wrote it. */
  at: number;
}

/** The NEWEST turn boundary in a rollout tail, or null. Unknown event types are skipped;
 *  a partial first line (the tail cut mid-line) fails to parse and is skipped too. */
export function latestCodexTurnEvent(tail: string): CodexTurnEvent | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"task_started"') && !line.includes('"task_complete"')) continue;
    let j: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown; turn_id?: unknown } };
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'event_msg' || !j.payload) continue;
    const t = j.payload.type;
    if (t !== 'task_started' && t !== 'task_complete') continue;
    const turnId = typeof j.payload.turn_id === 'string' ? j.payload.turn_id : '';
    const at = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
    if (!turnId || !Number.isFinite(at)) continue;
    return { kind: t === 'task_complete' ? 'complete' : 'started', turnId, at };
  }
  return null;
}

/**
 * Is this reading proof that the agent's open turn is over? (god's guardrails 1-2)
 *  - The NEWEST boundary must be a completion: a later start means a turn is running.
 *  - When the app knows which turn is open (a Codex hook named it), the completion must be
 *    THAT turn. The ids are exact, so no clock is involved: on the live floor the app's
 *    active epoch was stamped by a straggler's ARRIVAL, 5 s after the real completion, and
 *    a clock rule would have refused exactly the case this exists for.
 *  - When the app does not know the open turn (it began with our own submit, which has no
 *    turn id), the completion must be newer than the active epoch.
 */
export function codexTurnEnded(latest: CodexTurnEvent | null, openTurnId: string | null, activeSince: number): boolean {
  if (!latest || latest.kind !== 'complete') return false;
  if (openTurnId) return latest.turnId === openTurnId;
  return activeSince > 0 && latest.at > activeSince;
}

export type CodexLifecycleProbe =
  | { ok: true; latest: CodexTurnEvent | null }
  | { ok: false; why: 'no-rollout' | 'unreadable' };

/**
 * DWIGHT-INPUT-DEAD-179 F4: the timestamp (ms) of the NEWEST `thread_settings_applied` event in a
 * rollout tail, or null. Codex 0.157.1 writes it when a thread's settings are applied: when the
 * chat starts or is resumed (inside App::run, after the onboarding screens - trust, login - have
 * run, tui/src/lib.rs:1306 before :2027), and on a /model change. Unparsable lines are skipped.
 */
export function latestThreadSettingsAt(tail: string): number | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"thread_settings_applied"')) continue;
    let j: { type?: unknown; timestamp?: unknown; payload?: { type?: unknown } };
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'event_msg' || !j.payload || j.payload.type !== 'thread_settings_applied') continue;
    const at = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}

/** DWIGHT-INPUT-DEAD-179 F4: is a `thread_settings_applied` stamped at `at` this incarnation's?
 *  A resumed chat appends to its old rollout, so an event from the previous process (older than
 *  the spawn) proves nothing; an unknown spawn time proves nothing either. */
export function threadSettingsAppliedSince(at: number | null, spawnedAt: number): boolean {
  return at !== null && spawnedAt > 0 && at > spawnedAt;
}

/** Reads the newest rollout's tail, re-reading only when the file changed. */
export class CodexRolloutLifecycleSource {
  private cache = new Map<string, { file: string; mtimeMs: number; latest: CodexTurnEvent | null }>();
  private settings = new Map<string, { file: string; mtimeMs: number; at: number | null }>();

  probe(codexHome: string): CodexLifecycleProbe {
    const file = findNewestRollout(codexHome);   // rotation / a new session file: re-resolved each probe
    if (!file) return { ok: false, why: 'no-rollout' };
    let mtimeMs: number;
    try { mtimeMs = statSync(file).mtimeMs; } catch { return { ok: false, why: 'unreadable' }; }
    const hit = this.cache.get(codexHome);
    if (hit && hit.file === file && hit.mtimeMs === mtimeMs) return { ok: true, latest: hit.latest };
    const tail = readTail(file, CODEX_LIFECYCLE_TAIL_BYTES);
    if (!tail) return { ok: false, why: 'unreadable' };
    const latest = latestCodexTurnEvent(tail);
    this.cache.set(codexHome, { file, mtimeMs, latest });
    return { ok: true, latest };
  }

  /** DWIGHT-INPUT-DEAD-179 F4: when Codex last applied this home's thread settings (its newest
   *  rollout), or null. Fails CLOSED: no rollout, an unreadable file, or no such event = null. */
  threadSettingsAt(codexHome: string): number | null {
    const file = findNewestRollout(codexHome);
    if (!file) return null;
    let mtimeMs: number;
    try { mtimeMs = statSync(file).mtimeMs; } catch { return null; }
    const hit = this.settings.get(codexHome);
    if (hit && hit.file === file && hit.mtimeMs === mtimeMs) return hit.at;
    const tail = readTail(file, CODEX_LIFECYCLE_TAIL_BYTES);
    if (!tail) return null;
    const at = latestThreadSettingsAt(tail);
    this.settings.set(codexHome, { file, mtimeMs, at });
    return at;
  }

  forget(codexHome: string): void {
    this.cache.delete(codexHome);
    this.settings.delete(codexHome);
  }
}
