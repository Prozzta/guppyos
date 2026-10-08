/**
 * CLAIM-LEDGER W4 delivery (Jim CL-W4-INT S-1: moved out of index.ts so it is tested): the live
 * working set an agent gets at SessionStart (startup, resume, clear, compact), from `memory
 * wake-up`, and once per Codex spawn in its instruction file (G4.5). Main-only: it reads the
 * VERIFIED ledger (only main holds the MAC key).
 *   - M-1: the read-only warning is for a broken chain or a level below writer, never a healthy writer.
 *   - M-2: only W3's verifiedPrefix is delivered; on null (head-anchor, key-missing) no claims at all.
 *   - M-3: the briefing ceiling is 9,000 chars; actual delivery also respects the smaller current
 *     joined-context envelope after compact-carry and mail reserves. A Claude SessionStart gets it
 *     at the full ceiling from its own second hook entry (CL-M4-BRIEFING-BUDGET C: Claude Code
 *     spills each hook OUTPUT past 10,000 chars, not each event, so a separate entry has its own room).
 *   - S-2: the git evidence is bounded (concurrency, a deadline) and cached per ledger head and HEAD.
 *   - S-3: a receipt is appended only when the delivered text changed, and receipts.jsonl rotates.
 * Same inputs, same bytes (G4.2): the Codex instruction file and wake-up match (G4.5).
 */
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { join, resolve } from 'node:path';
import type { ClaimsState, KeyRegistry, LedgerLevel, LedgerRec, ReadResult, ReconcileItem, UsageRec, WorldInputs, WorldView } from '../../shared/claims';
import { COMPACT_CARRY_MAX } from '../compactHealth';
import { MAIL_JOINED_BUDGET } from '../mailSurface';
import { verifiedPrefix } from './indexSync';
import { createClaimViews, DEFAULT_WORKING_SET_BUDGET, type CountTokens } from './views';
import { reconcilePromptText } from './reconcile';
import { buildClaimsWorldSnapshot, runGit, WORLD_SNAPSHOT_DEADLINE_MS, type ClaimsWorldSnapshot, type GitRunner } from './worldSnapshot';

/** M-3: what the mail block keeps at a SessionStart(compact) beside a full working set and the carry. */
export const WORKING_SET_MAIL_RESERVE = 3_500;
/** God's briefing ceiling. The joined hook envelope can make the effective delivery cap lower. */
export const WORKING_SET_MAX_CHARS = 9_000;
/** Available room inside the current 9,500-char joined envelope after carry and mail reserves. */
export const WORKING_SET_DELIVERY_MAX_CHARS = Math.min(WORKING_SET_MAX_CHARS, MAIL_JOINED_BUDGET - COMPACT_CARRY_MAX - WORKING_SET_MAIL_RESERVE);
/** S-3: receipts.jsonl rotates past this size; this many rotated files are kept. */
export const RECEIPTS_ROTATE_BYTES = 1024 * 1024;
export const RECEIPTS_KEEP = 3;

export const READ_ONLY_WARNING = 'Warning: this agent is read-only for claims; ledger writes are disabled.';

export interface TaskRow { id: string; status: string; result?: string }

/** God's cardOutcomes ruling: done with a non-empty result = helped; blocked or cancelled = hurt;
 *  anything else (done without a result included) = no outcome. */
export function cardOutcomes(usage: UsageRec[], taskById: (id: string) => TaskRow | undefined): Record<string, 'helped' | 'hurt'> {
  const out: Record<string, 'helped' | 'hurt'> = {};
  for (const row of usage) if (row.card) {
    const task = taskById(row.card);
    if (task?.status === 'done' && typeof task.result === 'string' && task.result.trim()) out[row.card] = 'helped';
    else if (task?.status === 'blocked' || task?.status === 'cancelled') out[row.card] = 'hurt';
  }
  return out;
}

/** The W2 world callbacks over a git snapshot. Unknown is neutral (god): an unknown commit exists,
 *  an unknown file did not change, so nothing unknown ever raises a flag. */
export function worldInputs(o: { now: string; tasks: TaskRow[]; cwd: string; snapshot: ClaimsWorldSnapshot; usage: UsageRec[]; fileExists?: (abs: string) => boolean }): WorldInputs {
  const byTask = new Map(o.tasks.map((t) => [t.id, t]));
  const exists = o.fileExists ?? nodeFs.existsSync;
  return {
    now: o.now,
    taskStatus: (id) => byTask.get(id)?.status ?? null,
    fileExists: (p) => exists(resolve(o.cwd, p)),
    commitExists: (sha) => o.snapshot.commits.get(sha) ?? true,
    fileChangedSince: (p, since) => o.snapshot.changedFiles.get(`${p}\0${since}`) ?? false,
    cardOutcomes: cardOutcomes(o.usage, (id) => byTask.get(id)),
  };
}

/** S-3: append one line, rotating the file first when it is over `max` (keeps `keep` old files). */
export function appendRotating(file: string, line: string, max = RECEIPTS_ROTATE_BYTES, keep = RECEIPTS_KEEP, fs: Pick<typeof nodeFs, 'statSync' | 'renameSync' | 'rmSync' | 'appendFileSync' | 'existsSync'> = nodeFs): void {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { size = 0; }
  if (size > 0 && size + line.length > max) {
    try { fs.rmSync(`${file}.${keep}`, { force: true }); } catch { /* none */ }
    for (let i = keep - 1; i >= 1; i--) if (fs.existsSync(`${file}.${i}`)) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch { /* keep going */ } }
    try { fs.renameSync(file, `${file}.1`); } catch { /* append to the old one */ }
  }
  fs.appendFileSync(file, line, 'utf8');
}

export interface ClaimDeliveryDeps {
  hiveRoot: () => string | null;
  level: (agentId: string) => LedgerLevel;
  readLedger: (agentId: string) => ReadResult;
  registry: (root: string) => KeyRegistry;
  derive: (records: LedgerRec[], registry: KeyRegistry, ruleConfig: { r4: boolean }) => ClaimsState;
  worldView: (state: ClaimsState, records: LedgerRec[], usage: UsageRec[], world: WorldInputs) => WorldView;
  /** The agent's working directory (its git evidence); the hive root when unknown. */
  agentCwd: (agentId: string) => string | null;
  tasks: () => TaskRow[];
  usage: (agentId: string) => UsageRec[];
  /** The native-memory tokenizer (null: unavailable, then nothing is delivered). */
  countTokens: () => CountTokens | null;
  /**
   * THE RECONCILE SLOT (god's ruling, Creed W5 S3): W5's reconcile items for this agent's turn
   * (ReconcileApi, n <= 3). They render ONCE, as the working set's T1 ⚠ markers (the 0.10 share),
   * inside the effective delivery cap (bounded by the 9,500 joint budget). None until W5 is wired.
   */
  reconcileCandidates?: (agentId: string, day: string, source?: string) => ReconcileItem[];
  commitReconcile?: (agentId: string, day: string, renderedIds: string[], source?: string) => void;
  /** W5 (Dwight, onTurnCompleted): told at each completed turn (the Stop hook). No-op until wired. */
  onTurnCompleted?: (agentId: string) => void;
  git?: GitRunner;
  snapshot?: typeof buildClaimsWorldSnapshot;
  now?: () => Date;
  fileExists?: (abs: string) => boolean;
  /** Receipts go to `<hive>/agents/<id>/memory/receipts.jsonl` (rotating). */
  appendReceipt?: (file: string, line: string) => void;
  log?: (row: Record<string, unknown>) => void;
}

export interface ClaimDelivery {
  /** The working set text for this agent now, or null (level off/shadow, no tokenizer, no hive).
   *  maxChars: the character cap (default WORKING_SET_DELIVERY_MAX_CHARS, the joined-envelope room);
   *  Claude's own SessionStart briefing hook passes WORKING_SET_MAX_CHARS (CL-M4-BRIEFING-BUDGET C). */
  workingSet(agentId: string, source?: string, maxChars?: number): Promise<string | null>;
  /** The completed-turn boundary (HookServer's Stop): W5's reconcile lease hook. */
  turnCompleted(agentId: string): void;
}

export function createClaimDelivery(d: ClaimDeliveryDeps): ClaimDelivery {
  const git = d.git ?? runGit;
  const snapshotFn = d.snapshot ?? buildClaimsWorldSnapshot;
  const now = d.now ?? (() => new Date());
  const appendReceipt = d.appendReceipt ?? ((file, line) => appendRotating(file, line));
  const lastReceipt = new Map<string, string>();
  const snapCache = new Map<string, { key: string; snapshot: ClaimsWorldSnapshot }>();

  /** S-2: the snapshot for this ledger head and git HEAD, reused while neither moves. */
  const snapshotFor = async (agentId: string, records: LedgerRec[], state: ClaimsState, cwd: string): Promise<ClaimsWorldSnapshot> => {
    const started = Date.now();
    const head = (await git(cwd, ['rev-parse', 'HEAD'], undefined, WORLD_SNAPSHOT_DEADLINE_MS))?.trim() || null;
    const last = records[records.length - 1];
    const key = head ? `${cwd}\0${records.length}\0${last?.mac ?? ''}\0${head}` : null;
    const hit = snapCache.get(agentId);
    if (key && hit?.key === key) return hit.snapshot;
    const snapshot = await snapshotFn(records, state, cwd, { git, deadlineMs: Math.max(0, WORLD_SNAPSHOT_DEADLINE_MS - (Date.now() - started)) });
    if (key) snapCache.set(agentId, { key, snapshot });
    return snapshot;
  };

  return {
    async workingSet(agentId, source, maxChars = WORKING_SET_DELIVERY_MAX_CHARS) {
      const cap = Math.min(WORKING_SET_MAX_CHARS, Math.max(0, maxChars));
      const root = d.hiveRoot();
      if (!root) return null;
      const level = d.level(agentId);
      if (level !== 'reader' && level !== 'writer') return null;
      const read = d.readLedger(agentId);
      // M-2: never a line past a chain or MAC break; nothing at all on head-anchor or key-missing.
      const prefix = verifiedPrefix(read);
      const readOnly = read.chain !== 'ok' || level !== 'writer';   // M-1
      if (!prefix) return READ_ONLY_WARNING;
      const countTokens = d.countTokens();
      if (!countTokens) return null;
      const records = prefix.records;
      const registry = d.registry(root);
      const state = d.derive(records, registry, { r4: false });
      const cwd = d.agentCwd(agentId) || root;
      const snapshot = await snapshotFor(agentId, records, state, cwd);
      const usage = d.usage(agentId);
      const view = d.worldView(state, records, usage, worldInputs({ now: now().toISOString(), tasks: d.tasks(), cwd, snapshot, usage, fileExists: d.fileExists }));
      const day = now().toISOString().slice(0, 10);
      // Peek has no lease/charge/log side effects. T1 decides the set committed below.
      let items: ReconcileItem[] = [];
      try { items = (d.reconcileCandidates?.(agentId, day, source) ?? []).slice(0, 3); } catch { items = []; }
      const { buildWorkingSetDetailed } = createClaimViews(records, countTokens, items, registry);
      const warning = readOnly ? `\n\n${READ_ONLY_WARNING}` : '';
      const tail = warning;
      // M-3: B8 shares at the plan's B, scaled down until the text fits the character cap.
      let budget = DEFAULT_WORKING_SET_BUDGET;
      let built = buildWorkingSetDetailed(state, view, budget);
      for (let i = 0; i < 6 && built.text.length + tail.length > cap && budget > 1; i++) {
        budget = Math.max(1, Math.floor(budget * (cap - tail.length) / (built.text.length + 1) * 0.95));
        built = buildWorkingSetDetailed(state, view, budget);
      }
      // Last resort (Jim's note): cut the working set at a LINE boundary and keep the warning whole.
      let body = built.text;
      if (body.length + tail.length > cap) {
        const room = Math.max(0, cap - tail.length);
        const cut = body.lastIndexOf('\n', room);
        body = cut > 0 ? body.slice(0, cut) : body.slice(0, room);
      }
      const text = body + tail;
      const bodyLines = new Set(body.split('\n'));
      const renderedItems = items.filter((item) => bodyLines.has(reconcilePromptText(item)));
      const renderedIds = new Set(renderedItems.map((item) => item.itemId));
      for (const item of items) if (!renderedIds.has(item.itemId)) {
        const prior = built.droppedReconcileItems.find((drop) => drop.item.itemId === item.itemId);
        d.log?.({ kind: 'claims-reconcile-dropped', agentId, itemId: item.itemId, reason: prior?.reason ?? 'character-cap' });
      }
      try { d.commitReconcile?.(agentId, day, renderedItems.map((item) => item.itemId), source); }
      catch (e) { d.log?.({ kind: 'claims-reconcile-commit-failed', agentId, error: String(e).slice(0, 160) }); }
      // S-3: one receipt per DISTINCT delivered text (B14), on a rotating file.
      const digest = createHash('sha256').update(text).digest('hex');
      if (lastReceipt.get(agentId) !== digest) {
        try {
          const dir = join(root, 'agents', agentId, 'memory');
          nodeFs.mkdirSync(dir, { recursive: true });
          appendReceipt(join(dir, 'receipts.jsonl'), JSON.stringify(built.receipt) + '\n');
          lastReceipt.set(agentId, digest);
        } catch (e) { d.log?.({ kind: 'claims-receipt-failed', agentId, error: String(e).slice(0, 160) }); }
      }
      return text;
    },
    turnCompleted(agentId) {
      try { d.onTurnCompleted?.(agentId); } catch (e) { d.log?.({ kind: 'claims-turn-hook-failed', agentId, error: String(e).slice(0, 160) }); }
    },
  };
}
