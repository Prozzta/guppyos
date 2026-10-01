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
  /** Dwight's in-process getLiveness; absent until the liveness monitor lands, when
   *  records riding in fleet.json (`agents[].liveness`) are used if present. */
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

export function autoMoveNote(at: number, agentId: string, archivedAt: number): string {
  return `${new Date(at).toISOString()} harness: doing -> todo: assignee ${agentId} archived (explicit) at ${new Date(archivedAt).toISOString()}. Assignee kept.`;
}

export class BoardMonitor {
  private current: BoardFlag[] = [];
  private keys = new Set<string>();
  private lastPublished = '';
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: BoardMonitorOptions) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }

  flags(): BoardFlag[] { return this.current.slice(); }

  private fleet(root: string): { fleet: Map<string, FleetFacts>; liveness: Map<string, LivenessV1> } {
    const fleet = new Map<string, FleetFacts>();
    const liveness = new Map<string, LivenessV1>();
    try {
      const snap = JSON.parse(readFileSync(join(root, 'fleet.json'), 'utf8')) as { ts?: number; agents?: Array<Record<string, unknown>> };
      const ts = typeof snap.ts === 'number' ? snap.ts : this.now();
      for (const a of Array.isArray(snap.agents) ? snap.agents : []) {
        if (typeof a.id !== 'string') continue;
        const sec = typeof a.lastActiveSecAgo === 'number' ? a.lastActiveSecAgo : null;
        fleet.set(a.id, { lastActiveAt: sec === null ? null : ts - sec * 1000, onHold: a.onHold === true });
        if (isLiveness(a.liveness)) liveness.set(a.id, a.liveness);
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
    for (const id of new Set([...registry.keys(), ...liveness.keys()])) lv.set(id, get ? get(id) : liveness.get(id));
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

  /** Run once: detect, apply the one auto-move, publish, log changes. */
  /** Run once. The auto-move's own write notifies the guard, which runs a nested tick; that
   *  tick reads the already-moved card (todo), so it finds nothing to move. */
  tick(): BoardFlag[] {
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
        const line = autoMoveNote(now, f.agentId, f.since);
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
    const body = JSON.stringify(flags);
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
    this.stop();
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
