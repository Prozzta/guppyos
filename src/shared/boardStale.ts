/**
 * ZT-I3 §3.2: the stale detector. PURE: it joins the task cards, the guard's sidecar
 * (statusSince / lastEditAt), the registry and liveness-v1 (C:/Dunder/_work/creed-177/
 * LIVENESS-V1.md, whose consumer table is normative here) and returns flags from facts.
 * It never infers liveness itself, and it never edits anything: the board monitor acts
 * on the one flag that moves a card (ASSIGNEE_ARCHIVED, an explicit archive).
 *
 * Before liveness-v1 records exist for an agent, the same rules run on what already
 * exists: the registry's archive reason, and fleet.json's lastActiveSecAgo in place of
 * IDLE (skipping agents on hold, the pre-liveness operator-hold). STUCK is off then.
 */
import { LIVENESS_REASON_OPERATOR_HOLD, type LivenessV1 } from './livenessV1';
import { firstOccurrenceById } from './taskLedger';
import { parseVersion } from './updateState';

export type FlagKind =
  | 'ASSIGNEE_ARCHIVED' | 'ASSIGNEE_UNKNOWN' | 'ASSIGNEE_DOWN' | 'ASSIGNEE_STUCK'
  | 'STALE' | 'DOING_MANY' | 'ASK_ANSWERED_IDLE' | 'SHIPPED_INSTALLED';

export interface BoardFlag {
  cardId: string;
  kind: FlagKind;
  /** The assignee the flag is about ('' for an unassigned card). */
  agentId: string;
  since: number;
  evidence: string;
  /** True when god must decide something (the digest wakes god only for these). */
  decision: boolean;
  /** ASSIGNEE_ARCHIVED / DOWN: when the archive happened, if known (liveness archivedAt, or
   *  the registry's lastSeen, which setArchived stamps at the archive). */
  archivedAt?: number;
  /** SHIPPED_INSTALLED: the card's fixVersion (the digest item's id carries it: once per version). */
  fixVersion?: string;
}

export interface BoardStaleConfig {
  staleAfterMs: number;
  downAfterMs: number;
  downDecisionMs: number;
  /** An orphan archive is a boot sweep only for this bounded restore window. */
  bootGraceMs: number;
  answeredIdleMs: number;
  maxDoing: number;
}

export const BOARD_STALE_DEFAULTS: BoardStaleConfig = {
  staleAfterMs: 6 * 60 * 60_000,
  downAfterMs: 10 * 60_000,
  downDecisionMs: 30 * 60_000,
  bootGraceMs: 5 * 60_000,
  answeredIdleMs: 30 * 60_000,
  maxDoing: 3
};

export interface RegistryFacts { archived?: boolean; archiveReason?: string; onHold?: boolean; lastSeen?: number }
/** Pre-liveness facts from fleet.json: when the agent last used tokens (ms epoch, or null). */
export interface FleetFacts { lastActiveAt: number | null; onHold?: boolean }
export interface CardMetaFacts { statusSince: number; lastEditAt: number }

export interface DetectStaleInput {
  tasks: unknown;
  meta: Record<string, CardMetaFacts | undefined>;
  registry: ReadonlyMap<string, RegistryFacts>;
  liveness: ReadonlyMap<string, LivenessV1 | undefined>;
  fleet: ReadonlyMap<string, FleetFacts>;
  now: number;
  cfg?: Partial<BoardStaleConfig>;
  /** READS-QUIET-NOREPLY (1.1.81): the version of the running app (main: app.getVersion(), the
   *  version its app-start row records). Absent or unparseable = unknown: a card waiting for an
   *  install keeps waiting. */
  runningVersion?: string | null;
}

type Card = Record<string, unknown> & { id: string };

function cards(tasks: unknown): Card[] {
  const list = Array.isArray(tasks) ? tasks
    : (tasks && typeof tasks === 'object' && Array.isArray((tasks as { tasks?: unknown }).tasks)) ? (tasks as { tasks: unknown[] }).tasks : [];
  const ok = list.filter((c): c is Card => !!c && typeof c === 'object' && !Array.isArray(c)
    && typeof (c as { id?: unknown }).id === 'string' && !!(c as { id: string }).id);
  return firstOccurrenceById(ok, (c) => c.id);
}

function assigneeOf(card: Card): string {
  const a = card.assignee;
  return typeof a === 'string' && a && a !== 'unassigned' ? a : '';
}

/** A registry archive counts as explicit when its reason is 'explicit' or absent (archived
 *  before 1.1.75: hive.ts archivedForMail counts that as explicit too). The 'orphan' reason is
 *  the boot sweep's temporary archive, before autostart restores workers; it is not down. */
function registryArchive(r: RegistryFacts | undefined): 'explicit' | 'down' | 'boot' | null {
  if (!r?.archived) return null;
  const reason = r.archiveReason ?? 'explicit';
  if (reason === 'explicit') return 'explicit';
  if (reason === 'orphan') return 'boot';
  return 'down';
}

const hours = (ms: number): string => `${Math.round(ms / 360_000) / 10} h`;

function agentFlag(card: Card, agent: string, input: DetectStaleInput, cfg: BoardStaleConfig): BoardFlag | null {
  const { now } = input;
  const lv = input.liveness.get(agent);
  const reg = input.registry.get(agent);
  const base = { cardId: card.id, agentId: agent };

  // 1. The only flag that moves a card: an EXPLICIT archive (either source) or DELETED.
  const regArchive = registryArchive(reg);
  if (lv?.lifecycle === 'DELETED') {
    return { ...base, kind: 'ASSIGNEE_ARCHIVED', since: lv.classifiedSince, evidence: `${agent} deleted`, decision: false };
  }
  // A registry archive's time is its lastSeen (setArchived stamps it); stable across ticks.
  const regAt = reg?.archived && typeof reg.lastSeen === 'number' ? reg.lastSeen : undefined;
  if ((lv?.lifecycle === 'ARCHIVED' && lv.archiveReason === 'explicit') || regArchive === 'explicit') {
    const archivedAt = lv?.lifecycle === 'ARCHIVED' ? lv.archivedAt : regAt;
    return { ...base, kind: 'ASSIGNEE_ARCHIVED', since: archivedAt ?? input.meta[card.id]?.statusSince ?? now,
      evidence: `${agent} archived (explicit)`, decision: false, ...(archivedAt !== undefined ? { archivedAt } : {}) };
  }
  // 2. A pty exit wins over a stale boot-sweep fact from the other source: it is DOWN, never a move.
  const lvReason = lv?.lifecycle === 'ARCHIVED' ? lv.archiveReason : undefined;
  const regReason = reg?.archived ? reg?.archiveReason : undefined;
  if (lvReason === 'pty-exit' || regReason === 'pty-exit') {
    const livenessPtyExit = lvReason === 'pty-exit';
    const since = livenessPtyExit ? (lv?.archivedAt ?? lv?.classifiedSince ?? now) : (regAt ?? now);
    return { ...base, kind: 'ASSIGNEE_DOWN', since, evidence: `${agent} archived (pty-exit)`, decision: now - since >= cfg.downDecisionMs };
  }
  // The boot sweep's orphan archive is transient before autostart restores workers. Its archive
  // time is stamped by setArchived; without that timestamp we cannot safely call it a boot sweep.
  const orphanAt = lvReason === 'orphan' ? (lv?.archivedAt ?? regAt) : regArchive === 'boot' ? regAt : undefined;
  if (orphanAt !== undefined && now - orphanAt < cfg.bootGraceMs) return null;
  if (lv?.lifecycle === 'ARCHIVED' || regArchive === 'down' || regArchive === 'boot') {
    const reason = lv?.lifecycle === 'ARCHIVED' ? lv.archiveReason : reg?.archiveReason;
    const since = lv?.lifecycle === 'ARCHIVED' ? (lv.archivedAt ?? lv.classifiedSince) : (regAt ?? now);
    return { ...base, kind: 'ASSIGNEE_DOWN', since, evidence: `${agent} archived (${reason ?? 'unknown'})`, decision: now - since >= cfg.downDecisionMs };
  }
  // 3. Nobody by that name.
  if (!reg && !lv) {
    return { ...base, kind: 'ASSIGNEE_UNKNOWN', since: input.meta[card.id]?.statusSince ?? now, evidence: `${agent} is not a registered agent`, decision: true };
  }
  if (lv) {
    if ((lv.classification === 'CRASHED' || lv.classification === 'EXITED') && now - lv.classifiedSince >= cfg.downAfterMs) {
      return { ...base, kind: 'ASSIGNEE_DOWN', since: lv.classifiedSince,
        evidence: `${agent} ${lv.classification.toLowerCase()} ${hours(now - lv.classifiedSince)}`, decision: now - lv.classifiedSince >= cfg.downDecisionMs };
    }
    if (lv.classification === 'STUCK_WAKE') {
      return { ...base, kind: 'ASSIGNEE_STUCK', since: lv.classifiedSince, evidence: `${agent} stuck on a wake (${lv.reason})`, decision: true };
    }
  }
  // 4. STALE: idle long enough AND the card unedited long enough AND not on hold.
  const meta = input.meta[card.id];
  if (!meta || now - meta.lastEditAt < cfg.staleAfterMs) return null;
  if (lv) {
    if (lv.classification !== 'IDLE' || lv.reason === LIVENESS_REASON_OPERATOR_HOLD) return null;
    if (now - lv.classifiedSince < cfg.staleAfterMs) return null;
    return { ...base, kind: 'STALE', since: Math.max(lv.classifiedSince, meta.lastEditAt),
      evidence: `${agent} idle ${hours(now - lv.classifiedSince)}, card unedited ${hours(now - meta.lastEditAt)}`, decision: true };
  }
  // Pre-liveness fallback: fleet.json lastActiveSecAgo in place of IDLE (Jim nit b: skip onHold).
  const fleet = input.fleet.get(agent);
  if (reg?.onHold || fleet?.onHold) return null;
  if (!fleet || fleet.lastActiveAt === null || now - fleet.lastActiveAt < cfg.staleAfterMs) return null;
  return { ...base, kind: 'STALE', since: Math.max(fleet.lastActiveAt, meta.lastEditAt),
    evidence: `${agent} inactive ${hours(now - fleet.lastActiveAt)}, card unedited ${hours(now - meta.lastEditAt)}`, decision: true };
}

function answeredIdle(card: Card, now: number, cfg: BoardStaleConfig): BoardFlag | null {
  // Jim S3: god parks a card it is deliberately holding ("parked": true); an answer god
  // already resolved (resolvedBy) is not "answered, act on it".
  if (card.parked === true) return null;
  const qa = Array.isArray(card.humanQA) ? card.humanQA as Array<Record<string, unknown>> : [];
  let latest: number | null = null;
  for (const e of qa) {
    if (!e || typeof e !== 'object' || typeof e.a !== 'string' || !e.a || e.dismissedAt || e.resolvedBy) continue;
    const t = typeof e.answeredAt === 'string' ? Date.parse(e.answeredAt) : NaN;
    if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t;
  }
  // Still waiting on an unanswered question: the human, not god, is the blocker.
  if (qa.some((e) => e && typeof e === 'object' && typeof e.q === 'string' && !e.a && !e.dismissedAt)) return null;
  if (latest === null || now - latest < cfg.answeredIdleMs) return null;
  return { cardId: card.id, agentId: assigneeOf(card), kind: 'ASK_ANSWERED_IDLE', since: latest,
    evidence: `answered ${hours(now - latest)} ago, still blocked`, decision: true };
}

/**
 * READS-QUIET-NOREPLY (1.1.81, god c95516): a card whose fix has shipped but is not installed yet
 * carries `waitingFor: "install"` and `fixVersion: "1.1.80"`. While the running app is older (or
 * its version unknown) the card is `waiting`: never STALE, since nobody can act on it. Once the
 * running app reaches fixVersion it is `installed`: flagged SHIPPED_INSTALLED instead (verify and
 * close). A card without both fields, or with a fixVersion that is not x.y.z, is an ordinary card.
 */
export function installWait(card: Record<string, unknown>, runningVersion: string | null | undefined): 'waiting' | 'installed' | null {
  if (card.waitingFor !== 'install') return null;
  const fix = typeof card.fixVersion === 'string' ? parseVersion(card.fixVersion) : null;
  if (!fix) return null;
  const run = typeof runningVersion === 'string' ? parseVersion(runningVersion) : null;
  if (!run) return 'waiting';
  for (let i = 0; i < 3; i++) if (run[i] !== fix[i]) return run[i] > fix[i] ? 'installed' : 'waiting';
  return 'installed';
}

function installedFlag(card: Card, input: DetectStaleInput): BoardFlag {
  const fixVersion = String(card.fixVersion).trim();
  const meta = input.meta[card.id];
  return { cardId: card.id, agentId: assigneeOf(card), kind: 'SHIPPED_INSTALLED', fixVersion,
    since: meta?.lastEditAt ?? meta?.statusSince ?? input.now,
    evidence: `fix ${fixVersion} is installed (running ${String(input.runningVersion)})`, decision: true };
}

export function detectStale(input: DetectStaleInput): BoardFlag[] {
  const cfg = { ...BOARD_STALE_DEFAULTS, ...(input.cfg ?? {}) };
  const flags: BoardFlag[] = [];
  const doingBy = new Map<string, Card[]>();
  for (const card of cards(input.tasks)) {
    const wait = card.status === 'doing' || card.status === 'blocked' ? installWait(card, input.runningVersion) : null;
    if (wait === 'installed') flags.push(installedFlag(card, input));
    if (card.status === 'blocked') {
      const f = answeredIdle(card, input.now, cfg);
      if (f) flags.push(f);
      continue;
    }
    if (card.status !== 'doing') continue;
    const agent = assigneeOf(card);
    if (!agent) continue;
    const list = doingBy.get(agent);
    if (list) list.push(card); else doingBy.set(agent, [card]);
    const f = agentFlag(card, agent, input, cfg);
    // A card waiting for (or just reaching) its install is never STALE: the wait is not idleness.
    if (f && !(f.kind === 'STALE' && wait !== null)) flags.push(f);
  }
  for (const [agent, list] of doingBy) {
    if (list.length <= cfg.maxDoing) continue;
    // Stable across ticks: since the newest of the agent's doing cards entered doing.
    const since = Math.max(...list.map((c) => input.meta[c.id]?.statusSince ?? input.now));
    for (const card of list) {
      flags.push({ cardId: card.id, agentId: agent, kind: 'DOING_MANY', since,
        evidence: `${agent} has ${list.length} doing cards (max ${cfg.maxDoing})`, decision: false });
    }
  }
  return flags;
}

/** A stable key per flag, for change-only logging and the digest's dedupe. */
export function flagKey(f: BoardFlag): string { return `${f.kind}:${f.cardId}`; }
