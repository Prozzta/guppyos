/**
 * CLAIMS-CREATE-LEDGER: resumable conversion of a legacy floor.  This module is
 * deliberately main-process only: its `importOne` dependency is wired to the
 * live ClaimStore, so it shares ClaimStore's per-agent serial queue with writes.
 */
export type BootstrapState = {
  version: 1;
  startedAt: number;
  updatedAt: number;
  agents: Record<string, { state: 'done' | 'skipped' | 'failed'; at: number; reason?: string }>;
};

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Retained restart marker; it records progress but never authorizes deletion of a ledger segment. */
export const BOOTSTRAP_MARKER_FILE = 'claims-bootstrap.json';
export const bootstrapMarkerFile = (hiveRoot: string): string => join(hiveRoot, BOOTSTRAP_MARKER_FILE);

function validState(v: unknown): v is BootstrapState {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<BootstrapState>;
  return s.version === 1 && typeof s.startedAt === 'number' && typeof s.updatedAt === 'number'
    && !!s.agents && typeof s.agents === 'object' && !Array.isArray(s.agents);
}

/** A malformed or torn marker is not trusted; the caller starts a fresh, idempotent S0 pass. */
export function loadBootstrapMarker(hiveRoot: string): BootstrapState | null {
  const file = bootstrapMarkerFile(hiveRoot);
  if (!existsSync(file)) return null;
  try { const parsed: unknown = JSON.parse(readFileSync(file, 'utf8')); return validState(parsed) ? parsed : null; } catch { return null; }
}

/** Atomic replacement prevents a crash from publishing a half-written receipt. */
export function saveBootstrapMarker(hiveRoot: string, state: BootstrapState): void {
  const file = bootstrapMarkerFile(hiveRoot);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8');
  renameSync(temp, file);
}

export interface BootstrapDeps {
  now: () => number;
  activeAgents: () => string[];
  isIdle: (agentId: string) => boolean;
  /** Writes ledgerDefault writer while preserving all explicit entries. Idempotent. */
  seedDefault: () => void;
  /** S0 through the app's live ClaimStore; it must never be a second process. */
  importOne: (agentId: string) => Promise<{ refused?: string[] }>;
  load: () => BootstrapState | null;
  save: (state: BootstrapState) => void;
  log: (row: Record<string, unknown>) => void;
}

export class ClaimsBootstrap {
  private running = false;
  constructor(private readonly d: BootstrapDeps) {}

  status(): BootstrapState | null { return this.d.load(); }

  /** One serial, restart-safe pass. Busy agents receive a receipt and are retried on a later run. */
  async run(): Promise<BootstrapState> {
    if (this.running) throw new Error('claims bootstrap is already running');
    this.running = true;
    try {
      const now = this.d.now();
      const state = this.d.load() ?? { version: 1, startedAt: now, updatedAt: now, agents: {} };
      // The marker is intentionally retained: no completed ledger segment is ever deleted.
      this.d.seedDefault();
      for (const agentId of [...new Set(this.d.activeAgents())].sort()) {
        const prior = state.agents[agentId];
        if (prior?.state === 'done') continue;
        // Recheck immediately before this agent's import, not merely once per pass.
        if (!this.d.isIdle(agentId)) {
          state.agents[agentId] = { state: 'skipped', at: this.d.now(), reason: 'agent is busy' };
          state.updatedAt = this.d.now(); this.d.save(state);
          this.d.log({ kind: 'claims-bootstrap-skip', agentId, reason: 'busy' });
          continue;
        }
        try {
          const result = await this.d.importOne(agentId);
          state.agents[agentId] = { state: 'done', at: this.d.now(), ...(result?.refused?.length ? { reason: `refused ${result.refused.length} legacy entries` } : {}) };
          this.d.log({ kind: 'claims-bootstrap-import', agentId, ok: true });
        } catch (e) {
          state.agents[agentId] = { state: 'failed', at: this.d.now(), reason: String(e).slice(0, 160) };
          this.d.log({ kind: 'claims-bootstrap-import', agentId, ok: false, error: String(e).slice(0, 160) });
        }
        state.updatedAt = this.d.now(); this.d.save(state);
      }
      return state;
    } finally { this.running = false; }
  }
}
