/**
 * PROBE-REISSUE (B), 1.1.72: WHY did a post-reset probe produce nothing?
 *
 * Live 2026-09-28: Dwight's one post-reset probe was typed at 03:03Z (the wake COMMITTED and the
 * PTY printed 28 KB). Then no hook came, so no turn ran, and no rate-limit reading arrived; the
 * hold stayed for hours. Nothing recorded what the terminal showed. Codex may have printed a
 * usage-limit banner, or its composer may have swallowed the input; nobody could tell.
 *
 * So after every launched probe this waits WAIT_MS. If the agent's hooks stayed silent over that
 * time, it writes ONE capacity-probe-no-turn row with the terminal's last visible line and its
 * idle time. The next occurrence explains itself. Diagnostics only: it decides nothing and
 * re-issues nothing (the admission backoff does that).
 */
import { redactSecrets } from './hive';

export const PROBE_NO_TURN_WAIT_MS = 2 * 60_000;

/**
 * PROBE-172-AUDIT NIT 1 (Andy): the tail line goes to log.jsonl, which every agent reads, and it can
 * be the composer's contents or anything a CLI printed. So: the hive's own secret-shape battery
 * (redactSecrets: provider keys, JWTs, PEM, Bearer, key=value), plus any 32+ character
 * base64/hex-like run. Over-redaction (a git SHA) is fine for a diagnostic line.
 */
export function redactTail(line: string | null): string | null {
  if (!line) return line;
  return redactSecrets(line).replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]');
}

export interface ProbeWatchDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  /** When this agent's hooks last reported anything (ms epoch), or undefined if never. */
  lastHookAt: (agentId: string) => number | undefined;
  /** The terminal's last non-empty visible line for this agent (control sequences stripped). */
  tailLine: (agentId: string) => string | null;
  /** Milliseconds since the agent's terminal last printed, or undefined. */
  idleMs: (agentId: string) => number | undefined;
  log: (row: Record<string, unknown>) => void;
  waitMs?: number;
}

export class CapacityProbeWatch {
  constructor(private readonly deps: ProbeWatchDeps) {}

  launched(probe: { agentId: string; poolKey: string; attempt: number }): void {
    const launchedAt = this.deps.now();
    const waitMs = this.deps.waitMs ?? PROBE_NO_TURN_WAIT_MS;
    this.deps.setTimer(() => {
      try {
        const hookAt = this.deps.lastHookAt(probe.agentId);
        if (hookAt !== undefined && hookAt >= launchedAt) return; // a turn started: the reading will follow
        this.deps.log({
          kind: 'capacity-probe-no-turn', agentId: probe.agentId, poolKey: probe.poolKey, attempt: probe.attempt,
          waitedMs: this.deps.now() - launchedAt, lastHookAgoMs: hookAt !== undefined ? this.deps.now() - hookAt : null,
          ptyIdleMs: this.deps.idleMs(probe.agentId) ?? null, tail: redactTail(this.deps.tailLine(probe.agentId))
        });
      } catch { /* diagnostics never break anything */ }
    }, waitMs);
  }
}

/** The last non-empty visible line of raw terminal output: CSI/OSC/other escapes and control
 *  characters stripped, at most `max` characters. Null when nothing visible is left. */
export function lastVisibleLine(raw: string, max = 200): string | null {
  const text = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '\n') // CSI (cursor moves often mean a new line)
    .replace(/\x1b[@-Z\\-_]/g, '') // other two-byte escapes
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === '\r' ? '\n' : ''));
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  return last.length > max ? last.slice(0, max) : last;
}
