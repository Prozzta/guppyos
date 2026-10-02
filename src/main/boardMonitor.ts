/**
 * ZT-I3 §3.2-3.3: the board monitor. It runs the pure stale detector on every ledger
 * change, every liveness change and once a minute, publishes the flags
 * (`hive/state/board-flags.json`, the `hive:boardFlags` IPC) and logs a `board-flag` row
 * only when a flag appears or clears.
 *
 * It makes exactly ONE kind of edit: a `doing` card whose assignee was EXPLICITLY
 * archived (or deleted) goes back to `todo`, assignee kept, with one note line and a
 * `board-auto` log row. It goes through `hive.patchTask` (source 'board-auto'), the same
 * path the UI uses, so the guard attributes it and validation applies. Everything else
 * is a flag, never a silent status change.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from './atomicJson';
import { detectStale, flagKey, type BoardFlag, type BoardStaleConfig, type FleetFacts, type RegistryFacts, type CardMetaFacts } from '../shared/boardStale';
import type { LivenessV1 } from '../shared/livenessV1';
import { firstOccurrenceById } from '../shared/taskLedger';

export const BOARD_FLAGS_FILE = 'board-flags.json';
export const BOARD_MONITOR_TICK_MS = 60_000;
/** At most this many passes per tick, so at most MAX-1 re-runs (one re-run is the normal case:
 *  the auto-move's own writes). */
export const BOARD_MONITOR_MAX_RERUNS = 3;

/** The slice of HiveManager the monitor needs (kept narrow so tests can drive it). */
export interface BoardMonitorHive {
  root(): string | null;
  tasks(): unknown;
  registry(): { agents: Record<string, RegistryFacts> };
  patchTask(id: string, patch: Record<string, unknown>, source: 'board-auto'): boolean;
  appendLog(row: Record<string, unknown>): void;
  ledgerGuard: { taskMeta(): { cards: Record<string, CardMetaFacts | undefined> } };
}

export interface BoardMonitorOptions {
  hive: BoardMonitorHive;
  /** Dwight's in-process getLiveness. When it is absent, or has no record for an agent, the
   *  fleet.json records are used: the top-level liveness[] first, then agents[].liveness. */
  getLiveness?: (agentId: string) => LivenessV1 | undefined;
  cfg?: () => Partial<BoardStaleConfig>;
  now?: () => number;
  onFlags?: (flags: BoardFlag[]) => void;
}

function isLiveness(v: unknown): v is LivenessV1 {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<LivenessV1>;
  return typeof r.agentId === 'string' && typeof r.lifecycle === 'string'
    && typeof r.classification === 'string' && typeof r.classifiedSince === 'number';
}

export function autoMoveNote(at: number, agentId: string, archivedAt: number | undefined): string {
  const when = archivedAt !== undefined ? ` at ${new Date(archivedAt).toISOString()}` : '';
  return `${new Date(at).toISOString()} harness: doing -> todo: assignee ${agentId} archived (explicit)${when}. Assignee kept.`;
}

export class BoardMonitor {
  private current: BoardFlag[] = [];
  private keys = new Set<string>();
  private lastPublished = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private again = false;

  constructor(private readonly opts: BoardMonitorOptions) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  flags(): BoardFlag[] { return this.current.slice(); }

  private fleet(root: string): { fleet: Map<string, FleetFacts>; liveness: Map<string, LivenessV1> } {
    const fleet = new Map<string, FleetFacts>();
    const liveness = new Map<string, LivenessV1>();
    try {
      const snap = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as { ts?: number; agents?: Array<Record<string, unknown>>; liveness?: unknown[] };
      const ts = typeof snap.ts === 'number' ? snap.ts : this.now();
      // fix/177-liveness publishes the records as a TOP-LEVEL liveness[] (agentLiveness
      // fleetRecords), keyed by agentId; agents[].liveness is read too, as a second source.
      for (const rec of Array.isArray(snap.liveness) ? snap.liveness : []) if (isLiveness(rec)) liveness.set(rec.agentId, rec);
      for (const a of Array.isArray(snap.agents) ? snap.agents : []) {
        if (typeof a.id !== 'string') continue;
        const sec = typeof a.lastActiveSecAgo === 'number' ? a.lastActiveSecAgo : null;
        fleet.set(a.id, { lastActiveAt: sec === null ? null : ts - sec * 1000, onHold: a.onHold === true });
        if (isLiveness(a.liveness) && !liveness.has(a.id)) liveness.set(a.id, a.liveness);
      }
    } catch { /* no fleet.json yet: no pre-liveness STALE, which only under-flags */ }
    return { fleet, liveness };
  }

  private compute(root: string, now: number): { flags: BoardFlag[]; tasks: unknown } {
    const { hive } = this.opts;
    const tasks = hive.tasks();
    const registry = new Map<string, RegistryFacts>(Object.entries(hive.registry().agents ?? {}));
    const { fleet, liveness } = this.fleet(root);
    const get = this.opts.getLiveness;
    const lv = new Map<string, LivenessV1 | undefined>();
    for (const id of new Set([...registry.keys(), ...liveness.keys()])) lv.set(id, get?.(id) ?? liveness.get(id));
    if (get) {
      // Assignees outside the registry may still have a record (a DELETED agent).
      const list = (tasks as { tasks?: unknown[] })?.tasks ?? [];
      for (const c of Array.isArray(list) ? list : []) {
        const a = (c as { assignee?: unknown })?.assignee;
        if (typeof a === 'string' && a && !lv.has(a)) lv.set(a, get(a));
      }
    }
    for (const [id, rec] of [...lv]) if (rec === undefined) lv.delete(id);
    const flags = detectStale({ tasks, meta: hive.ledgerGuard.taskMeta().cards, registry, liveness: lv, fleet, now, cfg: this.opts.cfg?.() });
    return { flags, tasks };
  }

  /**
   * Run: detect, apply the one auto-move, publish, log changes.
   *
   * Jim R1: NOT re-entrant. The auto-move's own write notifies the guard, whose listener
   * calls tick() again on the same stack; that nested call only marks the run dirty and
   * returns, and the outer tick re-runs once after its loop. Without the latch a nested
   * tick moved the remaining cards and the outer loop re-patched them from its stale
   * snapshot: N(N+1)/2 writes and board-auto rows for N cards.
   */
  tick(): BoardFlag[] {
    if (this.running) { this.again = true; return this.flags(); }
    this.running = true;
    try {
      let flags: BoardFlag[];
      let runs = 0;
      do {
        this.again = false;
        flags = this.tickOnce();
        // Bounded: a re-run is only needed once (the moves' own writes). If the board keeps
        // changing under the monitor, stop and log rather than spin the main process.
        if (this.again && ++runs >= BOARD_MONITOR_MAX_RERUNS) {
          this.opts.hive.appendLog({ kind: 'board-monitor-rerun-limit', reruns: runs });
          this.again = false;
        }
      } while (this.again);
      return flags;
    } finally { this.running = false; }
  }

  private tickOnce(): BoardFlag[] {
    const { hive } = this.opts;
    const root = hive.root();
    if (!root) return [];
    const now = this.now();
    let { flags, tasks } = this.compute(root, now);
    const moves = flags.filter((f) => f.kind === 'ASSIGNEE_ARCHIVED');
    if (moves.length > 0) {
      const raw = (tasks as { tasks?: unknown[] })?.tasks;
      const byId = new Map(firstOccurrenceById(Array.isArray(raw) ? raw : [], (c) => (c as { id?: string })?.id ?? null)
        .map((c) => [(c as { id: string }).id, c as Record<string, unknown>]));
      for (const f of moves) {
        const card = byId.get(f.cardId);
        // Idempotent by construction: the detector flags only DOING cards, and this list was
        // computed from the same ledger read, so a moved (todo) card is never flagged again.
        if (!card) continue;
        const line = autoMoveNote(now, f.agentId, f.archivedAt);
        const notes = typeof card.notes === 'string' && card.notes ? `${card.notes}\n${line}` : line;
        try {
          if (hive.patchTask(f.cardId, { status: 'todo', notes }, 'board-auto')) {
            hive.appendLog({ kind: 'board-auto', cardId: f.cardId, from: 'doing', to: 'todo', assignee: f.agentId, reason: f.evidence });
          }
        } catch (e) {
          hive.appendLog({ kind: 'board-auto-failed', cardId: f.cardId, error: String(e).slice(0, 300) });
        }
      }
      ({ flags } = this.compute(root, now));
    }
    this.publish(root, flags, now);
    return flags;
  }

  private publish(root: string, flags: BoardFlag[], now: number): void {
    const keys = new Set(flags.map(flagKey));
    for (const f of flags) {
      if (!this.keys.has(flagKey(f))) {
        this.opts.hive.appendLog({ kind: 'board-flag', event: 'raised', flag: f.kind, cardId: f.cardId, agentId: f.agentId, decision: f.decision, evidence: f.evidence });
      }
    }
    for (const f of this.current) {
      if (!keys.has(flagKey(f))) this.opts.hive.appendLog({ kind: 'board-flag', event: 'cleared', flag: f.kind, cardId: f.cardId, agentId: f.agentId });
    }
    this.keys = keys;
    this.current = flags;
    // K14: republish only when a flag's identity, time or decision changed. The evidence
    // text carries rolling ages ("idle 6.1 h"), which alone must not rewrite the file.
    const body = JSON.stringify(flags.map((f) => [f.kind, f.cardId, f.agentId, f.since, f.decision]));
    if (body !== this.lastPublished) {
      this.lastPublished = body;
      try {
        mkdirSync(join(root, 'state'), { recursive: true });
        atomicWriteJson(join(root, 'state', BOARD_FLAGS_FILE), { v: 1, at: now, flags });
      }
      catch (e) { try { this.opts.hive.appendLog({ kind: 'board-flags-write-failed', error: String(e) }); } catch { /* noop */ } }
      try { this.opts.onFlags?.(flags); } catch { /* a listener never breaks the monitor */ }
    }
  }

  start(intervalMs = BOARD_MONITOR_TICK_MS): void {
    // `start` may follow a ledger-guard tick during bootstrap. Re-arm only the timer: clearing
    // `keys` here would make that already-raised flag appear new and log a duplicate raise.
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.tick(); } catch (e) { try { this.opts.hive.appendLog({ kind: 'board-monitor-error', error: String(e).slice(0, 300) }); } catch { /* noop */ } }
    this.timer = setInterval(() => {
      try { this.tick(); } catch (e) { try { this.opts.hive.appendLog({ kind: 'board-monitor-error', error: String(e).slice(0, 300) }); } catch { /* noop */ } }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.current = [];
    this.keys = new Set();
    this.lastPublished = '';
  }
}
