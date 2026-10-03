/**
 * The Hive — the on-disk multi-agent coordination layer.
 *
 * Lives under `<harnessHome>/hive/` as a single git repo that ONLY this main
 * process commits to (agents never call git — they just write files). See
 * HIVE.md for the full design. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/)
 *   - hive identity (registry.json: id/role/cwd/session — what agents read),
 *     separate from the UI floor roster (`<harnessHome>/roster.json`)
 *   - shared blackboard (board.md), task ledger, and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). The hive keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the floor.
 *
 * Everything here runs in the Electron main process.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, statSync, rmSync, appendFileSync, symlinkSync, copyFileSync, chmodSync,
  lstatSync, readlinkSync, unlinkSync,
  openSync, readSync, closeSync,
  watch, type FSWatcher
} from 'node:fs';
import { basename, join, dirname, isAbsolute, win32, posix } from 'node:path';
import { homedir } from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { AppendFile, LOG_KEEP_ROTATED, rotatedFiles } from './appendLog';
import { atomicWriteJson as atomicWriteJsonFile } from './atomicJson';
import { MailLedger, freshMailId, isValidMailId } from './mailLedger';
import { mailObligationsView, type MailObligationsAgent } from './mailReaders';
import { UNDELIVERED_DIR, dropUndeliveredItems, mailMigrationDone, markUndeliveredSeen, readUndeliveredReport, restoreUndeliveredFiles, runMailMigration, setAsideUndelivered, type MailMigrationResult, type UndeliveredReport } from './mailMigration';
import { mailChannelMode, mailPromptMode, type MailPromptMode } from './mailSurface';
import { rolloverMemory, seedPinnedSection, pinnedOverCapDue, PINNED_SEED, PINNED_SOFT_CAP_BYTES } from './memoryRollover';
import { shouldSeedCodexTrust, withAgentTrust, codexProjectLayerRiskKeys } from './codexTrustSeed';
import { codexProjectLayers, decideCodexLayers, type CodexLayerNotice } from './codexProjectLayers';
import { CODEX_TUI_KEYS, codexAutoCompactTokenLimitForAgent, disableCodexPlugins, isCodexAutoCompactTokenLimitOverride, codexTopLevelString, setCodexFeatureFlags, setCodexModel, setCodexReasoningEffort, setCodexRootTableKeys, setCodexTuiKeys } from './codexAgentConfig';
import { applyLiveModel, CODEX_EFFORT_KEY, normEffort, resolveSpawnModel, type ModelPinFields } from '../shared/modelPin';
import { codexToolOutputLimitForConfig } from '../shared/codexToolOutputLimit';
import { randomBytes, createHash } from 'node:crypto';
import {
  DEV_ISOLATION, sanitizeCodexConfigForDev, hookPipeId,
  codexAuthSeedSource, migrateCodexAuthLink
} from './devIsolation';
import type { AgentUsageSample } from './usage';
import { COMMAND_GROUPS } from '../shared/claudeCommands';
import {
  isClaudeProvider,
  isHiveAwareProvider,
  canReceiveInbox,
  providerPreset,
  bridgeOf,
  normalizeAgentProvider,
  type AgentProvider
} from '../shared/agentProvider';
import { MCP_CATALOG } from '../shared/mcpCatalog';
import { rosterActivity } from '../shared/activityView';
import type { LivenessV1 } from '../shared/livenessV1';
import { selectBroadcastTargets } from '../shared/broadcast';
import { normalizeWakeField } from '../shared/mailWakeClass';
import { preferredAgentRole } from '../shared/agentRole';
import { introducedErrors, mergeTaskLedger, validateLedger, type LedgerIssue } from '../shared/taskLedger';
import { TaskLedgerGuard, type TaskEditSource } from './taskLedgerGuard';
import { expandTilde } from './fs';
import {
  AgyStatuslineOwner, PROCESS_STARTED_AT, buildStatuslineCommand, newOwnerToken, osLiveness,
  recoverStatuslineLeftovers, removeStatuslineLocator, writeStatuslineLocator, type StatuslineEnv
} from './agyStatuslineOwnership';

/** How often a live instance refreshes its statusline lease (see LEASE_STALE_MS). */
const AGY_LEASE_HEARTBEAT_MS = 60 * 60 * 1000;
import { AGY_STATUSLINE_SHIM } from './agyStatuslineShim';
import { geminiHome } from './capacityScope';
import { codexMcpHookToml, MCP_HOOK_EVENTS, type McpHookEvent } from './codexHookMcp';
import { CANONICAL_PROMPT, canonicalPromptFingerprint, promptVariant, withSessionStamp } from './sessionRotation';
import { godHandoffFit } from './godStartup';
import { MAIL_JOINED_BUDGET } from './mailSurface';
import { FLOOR_DIGEST_FILE } from './floorDigest';
import { BOARD_STATUS_FILE } from './boardStatus';

/** The subset of HarnessConfig the hive consumes for the default-MCP merge.
 *  Kept as a local shape so hive.ts never imports the foundation-owned config
 *  module just for a type. */
type McpDefaultsMap = { [id: string]: { enabled: boolean } } | undefined;

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
const MESSAGE_ACTS = new Set<MessageAct>(['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done']);

function isMessageAct(value: unknown): value is MessageAct {
  return typeof value === 'string' && MESSAGE_ACTS.has(value as MessageAct);
}

export interface HiveMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
  /** MIDTURN-MAIL-BLIND (1.1.55): the ids of earlier messages this one cancels or corrects
   *  (a retraction, a changed decision). Optional; the router uses it to flag a reply that was
   *  written before its sender read this. */
  supersedes?: string[];
  /** Set by the ROUTER, never trusted from a sender: this message answers one that the sender's
   *  own unread inbox had already superseded when it was sent (see routeMessage). */
  superseded_by?: string;
  /** ZT-I1-MAIL §4.1: set by the ROUTER only, when it replaced an invalid or colliding
   *  sender-supplied id: the sender's original value. in_reply_to / supersedes resolve against
   *  either value. */
  sender_id?: string;
  /** READS-QUIET-NOREPLY (1.1.81): "now" = wake the recipient at once even for an inform/agree
   *  that would otherwise wait for its next turn (shared/mailWakeClass.ts). Any other value is
   *  dropped. */
  wake?: 'now';
}

/** A sender's `supersedes` (a string or an array), bounded: up to 10 non-empty ids of at most
 *  200 characters. Anything else is dropped rather than failing the whole message. */
export function normalizeSupersedes(v: unknown): { supersedes?: string[] } {
  const list = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 200)
    .map((x) => x.trim())
    .slice(0, 10);
  return list.length ? { supersedes: list } : {};
}

/** One hive message reshaped for the voice read-layer (`hive:messages`): the
 *  operator-briefing view of an inbox/outbox message. `subject` and `body` are
 *  REDACTED main-side (see {@link redactSecrets}) before this ever leaves the
 *  main process — the renderer/voice layer never sees a raw body, and never a
 *  secret. PII-free + secret-free by construction. */
export interface VoiceMessage {
  id: string;
  conversation: string;
  from: string;
  to: string;
  act: MessageAct;
  /** REDACTED subject line. */
  subject: string;
  /** REDACTED message body. */
  body: string;
  requires_reply: boolean;
  /** Which mailbox folder this copy was read from, relative to `owner`. */
  direction: 'inbox' | 'outbox';
  /** The agent whose mailbox this copy lives in. */
  owner: string;
  /** True when read from an archived/handled subfolder (inbox/.done, outbox/.sent). */
  archived: boolean;
  created_at: string;
}

/** One question→answer exchange with the human, recorded ON the task card so
 *  the decision trail stays with the work it unblocked. */
export interface HumanQA {
  q: string;
  a?: string;
  askedAt?: string;
  answeredAt?: string;
  dismissedAt?: string;
  /** ASKME-REVAMP (optional; a string-only entry still works): choices shown as buttons, */
  /** the index of the recommended one, whether several may be picked, and the indexes the */
  /** human picked (written with `a`, which carries the chosen labels and any note). */
  options?: Array<{ label: string; detail?: string }>;
  recommended?: number;
  multi?: boolean;
  chosen?: number[];
}

export interface HiveTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** First-class human feedback: the god appends {q} when a card can only
   *  proceed with the human's input (status goes blocked); the harness UI
   *  fills in {a}. The full history stays on the card forever. */
  humanQA?: HumanQA[];
  /** Outcome summary, surfaced by the Slack done-notifier when this card reaches
   *  'done'. Optional; the notifier falls back to description/title. */
  result?: string;
  /** Set when this task originated from a Slack message — the thread the
   *  done-summary reply is posted back into. Consumed OUTBOUND only; populating
   *  it is the inbound/kanban side's job and does not affect routing. */
  slack?: { channel: string; thread_ts: string };
  /** Set when this task originated from a generic webhook POST. Stores the SHA-256
   *  of the capability token (never the raw token — that's returned to the caller
   *  once and never persisted), so a GET status lookup can match by hashing the
   *  presented token. Read-only capability: it never widens routing or exposure. */
  webhook?: { tokenHash: string };
  /** Free-text history god (and the harness's one auto-move, ZT-I3 §3.3) appends to.
   *  Typed for Jim C8; the raw patch path keeps every other untyped field. */
  notes?: string;
}

export interface AgentMeta {
  id: string;
  name: string;
  /** Which CLI this agent runs on. Defaults to 'claude' when unset (legacy). */
  provider?: AgentProvider;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — enriches prompts and forwards them to Michael.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
}

/** Q32: why an agent is archived (see RegistryAgent.archiveReason). */
export type ArchiveReason = 'explicit' | 'orphan' | 'pty-exit';
/** Q32: the archive reasons that keep mail flowing (delivered, surfaced on restore). */
const NON_BOUNCING_ARCHIVE_REASONS: ReadonlySet<string> = new Set<ArchiveReason>(['orphan', 'pty-exit']);
/** Q32 / §4.2: an archived agent whose mail bounces (and whose inbox the §7.1 step-2 migration
 *  sets aside): archived for an explicit reason, or with no reason (archived before 1.1.75). */
export function archivedForMail(a: { archived?: boolean; archiveReason?: string } | undefined | null): boolean {
  return a?.archived === true && !NON_BOUNCING_ARCHIVE_REASONS.has(a.archiveReason ?? '');
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
  /** ZT-I1-MAIL Q32 (god 7048a1 + 0f1672): WHY the agent is archived; absent while active.
   *  'explicit' (a Human/god archive: IPC, realtime action, tab kill, voice kill) bounces mail
   *  (§4.2); 'orphan' (the boot sweep) and 'pty-exit' (the process died on its own) do NOT: the
   *  mail is delivered and surfaced when the agent is restored. Absent on an archived agent =
   *  archived before 1.1.75, counted as explicit. Cleared on restore. */
  archiveReason?: ArchiveReason;
  /** The human has this agent 1:1 and Michael must leave it alone until they
   *  flip it back. Held agents stay ACTIVE and keep their terminal — this is
   *  "do not dispatch to them", not "they are gone", which is why it is its own
   *  flag rather than a reuse of `archived` or a breaker level. */
  onHold?: boolean;
  /** READS-181 B: this agent's tool-output cap (overrides the config's `toolOutputCap`; 0 = off). */
  toolOutputCap?: number;
  /** Most recent Claude Code session_id seen for this agent (Lane A #6.6a),
   *  captured from hook payloads. Doubles as the `--resume` key (idempotent
   *  resume after a crash/restart) AND the cost accounting/dedup key on every
   *  AgentUsageSample / cost-ledger row. */
  sessionId?: string;
  /** The `sessionId` before the current one (START-FIXES-163 (1)): the fallback resume
   *  key when the current one has no transcript, e.g. a phantom OTel start-up id. */
  previousSessionId?: string;
  /** SESSION-CROSSWIRE: who wrote `sessionId`. 'hook' = a hook payload from this
   *  agent's own process (authoritative); 'sample' = the OTel cost sample. Absent on
   *  keys written before 1.1.70. A sample never replaces a 'hook' key. */
  sessionSource?: 'hook' | 'sample';
  /** SESSION-CROSSWIRE: the session ids this agent's own hooks have reported (newest
   *  last, capped). The ownership record: a restart never resumes, and a sample is
   *  never charged against, a session id another agent's hooks claim. */
  hookSessionIds?: string[];
  /** SESSION-PROMPT-ROTATION: session id -> fingerprint of the system prompt the session was
   *  STARTED with (newest last, capped). An automatic resume of a session whose stamp differs
   *  from the prompt it would now get, or that has none, starts fresh (sessionRotation.ts). */
  sessionPrompts?: Record<string, string>;
  /** The PINNED model: a live in-TUI `/model` switch (Claude status line, Codex rollout
   *  turn_context, Antigravity statusline), kept so a respawn stays on it. Per agent because a
   *  CLI's global settings cannot preserve independent choices across a hive. See
   *  src/shared/modelPin.ts (MODEL-PINBACK) for when it is set, used and dropped. */
  model?: string;
  /** MODEL-PINBACK: the requested (picker) model the pin replaced; the pin applies only while
   *  the spawn still requests it. Absent = pinned while nothing was requested. */
  modelPinnedFrom?: string;
  /** MODEL-PINBACK: the renderer's `--model` at the last spawn (absent = none). */
  requestedModel?: string;
  /** MODEL-PINBACK: the `--model` the current process was launched with (absent = CLI default). */
  launchModel?: string;
  /** MODEL-PINBACK: the last live model observed from the current process. */
  liveModel?: string;
  /** MODEL-PINBACK: when the current process was launched (ms since epoch). */
  launchedAt?: number;
  /** MODEL-PINBACK: who made the pin: 'user' (human terminal input preceded it, kept on
   *  respawn) or 'auto' (none did: shown and logged, not kept). Absent = a pre-rule pin. */
  modelPinSource?: 'user' | 'auto';
  /** AGENT-MODEL-NOT-KEPT M2: the reasoning effort that goes with the model (Codex), as the
   *  pin, the picker's request, this process's launch, the last live observation, and the
   *  no-switch default. See src/shared/modelPin.ts (EFFORT). */
  modelEffort?: string;
  modelPinnedFromEffort?: string;
  requestedEffort?: string;
  launchEffort?: string;
  liveEffort?: string;
  defaultEffort?: string;
  /** Whether `cwd` is actually usable for a (re)spawn — i.e. an ABSOLUTE path
   *  that exists as a directory. Computed + persisted at spawn so the roster
   *  reliably exposes each worker's environment validity. A non-absolute fragment
   *  (e.g. "ClaudeTerminalHarness") spawns into a nonexistent dir and fails; this
   *  flag makes that visible instead of letting it slip through silently. */
  cwdValid?: boolean;
  /** Optional operator-set per-agent Codex compaction threshold. Unset keeps the fleet default;
   * applied into the agent's generated config.toml on its next spawn. */
  codexAutoCompactTokenLimit?: number;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** A read-only warning for a damaged source of truth.  Writes which would use
 * this source remain refused; the UI can still show the rest of the floor. */
export interface HiveIntegrityIssue {
  file: string;
  quarantine: string | null;
  error: string;
  /** ZT-I1-MAIL: the source was already rebuilt (a mail ledger); nothing is paused. */
  repaired?: boolean;
  /** ZT-I1-MAIL N1: a notice that is not a damaged file (mail-evidence-missing); nothing is paused. */
  notice?: string;
}

/** ZT-I3: an API write refused because it would INTRODUCE a ledger error (a new duplicate id,
 *  an unknown status). Errors already in the file never refuse a write (Jim C1). */
export class TaskLedgerInvalidError extends Error {
  constructor(readonly issues: LedgerIssue[]) {
    super(`Task ledger write refused: ${issues.map((i) => i.message).join('; ')}`);
  }
}

class HiveAuthorityCorruptError extends Error {
  constructor(readonly issue: HiveIntegrityIssue) {
    super(`Hive authority ${issue.file} is invalid JSON; refusing to overwrite it.`);
    this.name = 'HiveAuthorityCorruptError';
  }
}

/** How many hook-reported session ids an agent keeps as its ownership record. */
export const HOOK_SESSION_IDS_CAP = 20;

/** SESSION-CROSSWIRE: does an agent other than `agentId` claim `sessionId`?
 *  - This agent's own hooks reported it → never foreign.
 *  - Another agent's hooks reported it → foreign.
 *  - Another agent holds it as its current or previous key → foreign too. That also
 *    covers keys written before 1.1.70, which carry no hook record: an id two agents
 *    both hold is contested and resumes for neither, rather than for the wrong one. */
export function sessionClaimedByOther(reg: Registry, agentId: string, sessionId: string): boolean {
  if (!sessionId) return false;
  if (reg.agents[agentId]?.hookSessionIds?.includes(sessionId)) return false;
  for (const [id, a] of Object.entries(reg.agents)) {
    if (id === agentId) continue;
    if (a.hookSessionIds?.includes(sessionId) || a.sessionId === sessionId || a.previousSessionId === sessionId) return true;
  }
  return false;
}

/** Build env + extra spawn args that make an agent process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
  /** The hive-protocol seed to TYPE into the TUI after boot rather than pass on
   *  argv — set only for `seedDelivery:'type-into-tui'` providers (Crush), whose
   *  bare TUI rejects a positional seed. The renderer types it through the same
   *  per-pty write-chain as the inbox-wake nudge. (ondev-b) */
  seedPrompt?: string;
  /** F1 — set when provisioning REFUSED to make this agent safe to start, and the
   *  spawn must be BLOCKED rather than downgraded. Today the only source is the
   *  Dev Codex credential migration: if an external credential link cannot be
   *  classified or removed, starting Codex anyway would leave that live link in
   *  place, which is exactly the state F1 exists to prevent. The caller must check
   *  this BEFORE merging `args`/`env` and before reaching `ptyManager.spawn` — an
   *  empty injection would silently downgrade the spawn instead of refusing it. */
  refusal?: string;
  /** CODEX-TRUST-LAYER: with a refusal for an unreviewed codex project layer, the folder key
   *  the one-click opt-in records (HarnessConfig.codexLayerOptIns). */
  codexLayerOptIn?: string;
}

const HOP_CAP = 12;
/**
 * Agents normally write mail atomically, but the protocol also permits ordinary
 * file writers. A poll can see one of those files between its create and close;
 * give it a few later polls to become valid JSON before declaring it rejected.
 */
const OUTBOX_PARSE_RETRY_LIMIT = 3;
const OUTBOX_PARSE_RETRY_DEBOUNCE_MS = 250;
const OUTBOX_FRESH_WRITE_GRACE_MS = 1_000;

/** First window logTail() reads off the end of log.jsonl. Sized so the default 200 rows
 *  (~170 B each on this floor) land in one read with room to spare; it quadruples from
 *  here if a caller asks for more than fits, so a large `n` still works, just not for free. */
const LOG_TAIL_WINDOW_BYTES = 256 * 1024;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/**
 * HOOK-BROKER P4 (AGY): `<hive>/bin/agy-oneway.cmd`, the cheap one-way delivery for AGY's
 * observational hooks and its statusline. AGY 1.2.11 can only run commands (no http or MCP hook,
 * no socket statusline), so every event is a process: this makes it cmd built-ins + findstr.exe
 * (~34 ms, two small signed OS binaries) instead of cmd + the Electron shim (~450 ms).
 *   - A .cmd, because AGY already runs our .cmd hooks, whatever way it launches commands, and
 *     because AGY passes quote characters literally (so no quotes appear anywhere).
 *   - AGENT_ID is read from the environment inside the batch (empty for a user's own session).
 *   - One-way: nothing is printed (AGY fail-closes on stdout JSON) and no reply is read, so only
 *     events that never need a directive come this way. The OUTER `2>nul` also swallows cmd's
 *     own "cannot find the file" when the pipe is gone (measured: an inner one does not), and
 *     `exit /b 0`: a closed app fails fast and silently.
 */
export function agyOnewayCmd(pipe: string): string {
  return ['@echo off', `((echo %1 %2 %AGENT_ID%& findstr /v /c:@@m@@) > ${pipe}) 2>nul`, 'exit /b 0', ''].join('\r\n');
}

/** HOOK-BROKER: what the hive asks the in-process hook endpoint for at spawn. */
export interface HookBroker {
  /** A Claude agent's HTTP hook URL (fresh token), or null: command hooks. */
  urlFor(agentId: string): string | null;
  /** P3: a Codex agent's MCP endpoint + the token its mcp_tool hooks carry, or null. */
  mcpFor?(agentId: string): { url: string; token: string } | null;
  revoke(agentId: string): void;
}

/** HOOK-BROKER: how long Claude waits for an HTTP hook (seconds). A hung app never holds an
 *  agent longer than this, and a failed HTTP hook is non-blocking in Claude. */
export const HOOK_HTTP_TIMEOUT_S = 30;

/** The exact `.gitignore` older builds wrote into each agent dir for a retired indexer (see
 *  pruneRetiredHiveFiles). Line endings normalised to \n before comparing. */
export const RETIRED_AGENT_GITIGNORE = 'settings.json\ncursor.json\ninbox/\noutbox/\n.codex/\n';

/** NO_PROXY with loopback added (merged with any existing value, no duplicates). */
export function mergeNoProxy(existing: string | undefined): string {
  const parts = (existing ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost']) if (!parts.includes(host)) parts.push(host);
  return parts.join(',');
}

/**
 * Strip secret-shaped substrings out of free text before it leaves the main
 * process toward the voice / renderer layer. This is the MAIN-SIDE privacy gate
 * for the voice read-layer's message-content path (`hive:messages`): a message
 * body can quote a key, paste a token, or echo a credential, so every body and
 * subject is run through this before it crosses IPC. The renderer holds ZERO
 * redaction policy — it only ever receives the already-cleaned string.
 *
 * Deliberately CONSERVATIVE: it matches known credential SHAPES (provider key
 * prefixes, JWTs, PEM private keys, bearer tokens) and sensitive key=value /
 * key: value assignments, then replaces the secret with `[redacted]`. It does
 * NOT blanket-redact on entropy, so operator-meaningful content the briefing
 * needs — git SHAs, agent ids, file paths, ordinary prose — survives intact.
 * Over-redaction (e.g. a non-secret `apikey:openai` ref) is acceptable; leaking
 * a real secret is not.
 *
 * LOCKSTEP: the regex battery below is mirrored character-identically in
 * test/voice-messages.test.cjs (a .cjs test cannot import this TS module). If
 * you change a pattern here, mirror it there — the test is what PROVES a
 * secret-shaped value is stripped.
 */
export function redactSecrets(text: unknown): string {
  if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
  let s = text;
  // 1. PEM private-key blocks (RSA/EC/OPENSSH/PGP — header through footer).
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[redacted]');
  // 2. JSON Web Tokens — three base64url segments separated by dots.
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]');
  // 3. Known credential prefixes: OpenAI/Anthropic (sk-, sk-ant-), Slack
  //    (xoxb/xoxp/xoxa/xoxr/xoxs-, xapp-), GitHub (ghp_/gho_/ghu_/ghs_/ghr_,
  //    github_pat_), AWS access-key ids (AKIA…), Google API keys (AIza…).
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    '[redacted]'
  );
  // 4. Bearer tokens — keep the label, drop the credential.
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
  // 5. Sensitive key = value / key: value — keep the key name, drop the value.
  //    An optional namespace prefix (aws_, gcp_, …) is folded into the captured
  //    key so a LABELED secret survives the \b boundary: `aws_secret_access_key`
  //    is all word chars, so a bare `\b(secret)\b` never sees it. Listing
  //    secret_access_key / private_key alone is not enough — the prefix run is
  //    what lets `aws_secret_access_key=…` (no AKIA shape on the value) redact.
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`
  );
  return s;
}

// ─── HiveManager ────────────────────────────────────────────────────────────

/** Pre-M1 event-wake bridge: one successful, durable inbox write (see `deliver()`). */
export interface InboxDelivery {
  agentId: string;
  messageId: string;
}

/**
 * The router's effects, injectable so a test can drive the event path with no timer at
 * all. `watch` is only a LATENCY HINT: its callback never carries meaning (no filename,
 * no count), it only asks for one authoritative whole-tree scan.
 */
export interface RouterRuntime {
  watch: (dir: string, onHint: () => void) => Pick<FSWatcher, 'close' | 'on'>;
  setImmediate: (fn: () => void) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const NODE_ROUTER_RUNTIME: RouterRuntime = {
  watch: (dir, onHint) => watch(dir, { persistent: false }, () => onHint()),
  setImmediate: (fn) => { setImmediate(fn); },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout)
};

export class HiveManager {
  /**
   * @param getHome  Lazily resolve harnessHome so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to animate routed
   *                 messages on the office floor; a no-op in tests/headless.
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => boolean | void,
    routerRuntime: Partial<RouterRuntime> = {},
    /**
     * May THIS hive write the user's GLOBAL provider config? See `mayWriteGlobalConfig`.
     *
     * DEFAULT-CLOSED, AND THAT IS THE POINT. A HiveManager built anywhere other than the
     * app's one live instance - a probe, a test, a script - refuses every global write
     * without having to know it should. Only `index.ts` supplies the real predicate.
     */
    private isLiveHarnessHome: (home: string) => boolean = () => false
  ) {
    this.routerRuntime = { ...NODE_ROUTER_RUNTIME, ...routerRuntime };
  }

  /**
   * The one gate in front of every write to the USER'S GLOBAL provider config:
   * `~/.gemini/config/hooks.json` and `~/.gemini/antigravity-cli/hooks.json`
   * (`installAgyHooks`), `~/.grok/hooks/munder-hive.json` (`installGrokHooks`), and the
   * Antigravity `statusLine` lease (`startAgyStatusline`). Everything else this class
   * writes lives under the hive root or an agent directory and is not affected.
   *
   * WHY IT EXISTS. These files are global and single-valued: whoever writes them last
   * owns the user's Antigravity and Grok integrations. On 2026-09-23 a scratch probe
   * built a HiveManager on a temp hive without redirecting HOME, and `installAgyHooks`
   * pointed the human's real `~/.gemini` hooks at a directory that was then deleted -
   * breaking hook delivery for the live floor AND for the user's own `agy` sessions.
   * Nothing was malicious and nothing was wrong with the probe's intent: the writer was
   * simply reachable from any HiveManager at all.
   *
   * So a global write now needs BOTH: this hive's home is the one the app is configured
   * to run (not a temp dir, not a second hive), and we are not the dev build (which has
   * its own pipe and would silently re-point Stable's agents at it). A refusal is named
   * and logged, never silent - the same shape as the existing dev-isolation skip.
   */
  private mayWriteGlobalConfig(what: string): boolean {
    if (DEV_ISOLATION) {
      console.warn(`[dev-isolation] skipping global ${what} install (would re-point Stable agents)`);
      return false;
    }
    const home = this.getHome();
    if (!home || !this.isLiveHarnessHome(home)) {
      console.warn(`[hive] refusing to write global ${what} config: ${home ? 'not the live harness home' : 'no home'}`);
      try { this.appendLog({ kind: 'global-config-skipped', what, reason: home ? 'not-live-home' : 'no-home' }); }
      catch { /* a hive we may not write to may have nowhere to log either */ }
      return false;
    }
    return true;
  }

  private readonly routerRuntime: RouterRuntime;
  /** HOOK-BROKER: the in-process HTTP hook endpoint (HookServer), injected by main. Null in
   *  tests and until wired; every spawn then writes command hooks exactly as before. */
  private hookBroker: HookBroker | null = null;
  /** CODEX-TRUST-LAYER: where a refused or warned Codex spawn is shown (index.ts pushes it to
   *  the window). Null in tests and before the app wires it; the log row is written anyway. */
  codexLayerSink: ((notice: CodexLayerNotice) => void) | null = null;
  /** LOG-STALL-AV: the kept-open, rotated append files, per hive root (see appendLog.ts). */
  private readonly appendFiles = new Map<string, AppendFile>();
  private keepAppendOpen = true;
  private appendFileFor(path: string, keep: number): AppendFile {
    let f = this.appendFiles.get(path);
    if (!f) { f = new AppendFile(path, { keep, keepOpen: this.keepAppendOpen }); this.appendFiles.set(path, f); }
    return f;
  }
  /** The log and ledger descriptors stay open by default (no antivirus rescan per row). Off
   *  opens and closes per row (the old cost); kept for a caller that measures that path. */
  keepAppendFilesOpen(on: boolean): void {
    if (on === this.keepAppendOpen) return;
    this.closeAppendFiles();
    this.keepAppendOpen = on;
  }
  /** Close the kept-open log and ledger descriptors. Rows are already on disk; the next row
   *  reopens. */
  closeAppendFiles(): void {
    for (const f of this.appendFiles.values()) f.close();
    this.appendFiles.clear();
  }
  /**
   * Release what this manager holds open in the hive folder (Jim, LOG-STALL-AUDIT-153 B1/B3):
   * the log and ledger descriptors. Call it BEFORE deleting or copying the folder (reset,
   * change home) and at quit: Windows cannot remove a directory while a file in it is open,
   * and a copy must see the rows. Safe to call more than once; a later row simply reopens.
   */
  dispose(): void {
    // ZT-I1-MAIL: the coalesced ledger writes land before the log closes (quit, home change).
    try { this.mail.dispose(); } catch (e) { try { this.appendLog({ kind: 'mail-ledger-write-failed', error: String(e) }); } catch { /* noop */ } }
    this.closeAppendFiles();
  }
  setHookBroker(broker: HookBroker | null): void {
    this.hookBroker = broker;
  }

  /** ZT-I1-MAIL: the harness-owned per-agent mail ledger (`hive/state/mail/<agentId>.json`).
   *  Lazy per agent; every closure reads the live root, so a home change needs no rewiring. */
  readonly mail = new MailLedger({
    root: () => this.root(),
    appendLog: (row) => this.appendLog(row),
    // A corrupt-ledger rebuild reads the recent log (bounded; rotated files included).
    readLogRows: () => this.logTail(HiveManager.MAIL_REBUILD_LOG_ROWS)
  });
  static readonly MAIL_REBUILD_LOG_ROWS = 50_000;

  private routerTimer: unknown = null;
  /** One non-recursive watcher per active outbox, keyed by its absolute path. */
  private readonly outboxWatchers = new Map<string, Pick<FSWatcher, 'close' | 'on'>>();
  /** Parse failures awaiting the next polling debounce, keyed by full outbox path. */
  private readonly outboxParseRetries = new Map<string, { attempts: number; retryAfter: number }>();
  /** A rejected file whose archival is temporarily locked has already notified its sender. */
  private readonly outboxRejectNotices = new Map<string, string | null>();
  /** A delivered file whose normal archive failed must never be delivered twice. */
  private readonly outboxDeliveredArchives = new Map<string, string | null>();
  /** A corrupt authority file is copied aside once per bad contents. Repeating a
   *  read must still fail closed, but must not fill the hive with identical copies. */
  private readonly quarantinedJsonFingerprints = new Map<string, string>();
  /** Sources currently known corrupt. Kept separately from the fingerprint so
   * the renderer can make the safety stop visible to the human. */
  private readonly authorityIssues = new Map<string, HiveIntegrityIssue>();
  /** ZT-I3: watches tasks.json (never writes it) and keeps the per-card sidecar. */
  readonly ledgerGuard = new TaskLedgerGuard({
    root: () => this.root(),
    agentIds: () => {
      try { return new Set(Object.keys(this.registry().agents)); } catch { return new Set<string>(); }
    },
    appendLog: (row) => this.appendLog(row)
  });
  /** At most one queued scan; hints arriving in the same turn coalesce into it. */
  private routeQueued = false;
  /** Bumped by start/stop, so a scan queued before a stop never runs after it. */
  private routerGeneration = 0;

  /** The embedded OTLP collector's loopback URL, set by the main process once the
   *  collector is bound (telemetry.ts). null = telemetry off → no OTel env is
   *  injected at spawn (the transcript reconciler remains the cost source). */
  private _otelEndpoint: string | null = null;
  /** Point newly-spawned agents at the live telemetry collector. Call after the
   *  collector starts; only affects spawns made afterwards. */
  setOtelEndpoint(url: string | null): void {
    this._otelEndpoint = url;
  }
  /** The collector URL agents are pointed at, or null when telemetry is off. */
  otelEndpoint(): string | null {
    return this._otelEndpoint;
  }

  /** What the app running this hive actually IS: its version, and whether it is a
   *  packaged build or a local dev run.
   *
   *  Agents could not see this before, and it cost real time. A multi-agent
   *  investigation into anomalous file modes ran for hours before the explanation
   *  turned out to be that the operator had quit a downloaded build and started a
   *  local one, which inherits the launching shell's umask instead of Finder's
   *  022. No agent could observe that, several published conclusions had to be
   *  withdrawn, and log.jsonl carried no app-start marker to notice the switch
   *  from either. */
  private _runtime: { version: string; packaged: boolean; appPath?: string } | null = null;
  setRuntimeInfo(info: { version: string; packaged: boolean; appPath?: string } | null): void {
    this._runtime = info;
  }
  runtimeInfo(): { version: string; packaged: boolean; appPath?: string } | null {
    return this._runtime;
  }

  /** Whether config.orchestratorMaySpawn is on, mirrored here so the prompt
   *  builder can decide whether to tell god the spawn queue is available. Set at
   *  bootstrap and on every config write; hive.ts deliberately does not import
   *  the config module. */
  private _maySpawn = false;
  setOrchestratorMaySpawn(on: boolean): void {
    this._maySpawn = on;
  }
  orchestratorMaySpawn(): boolean {
    return this._maySpawn;
  }

  // — paths —
  root(): string | null {
    const home = this.getHome();
    return home ? join(home, 'hive') : null;
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  /** L0 — the per-agent CODEX_HOME, when this agent actually has one.
   *  Existence of the directory IS the discriminator: installCodexHooks creates it
   *  only for Codex workers, so no roster lookup is needed to tell a Codex agent
   *  from a Claude one. Returns null otherwise. */
  codexHomeFor(id: string): string | null {
    const home = join(this.agentDir(id), '.codex');
    return existsSync(home) ? home : null;
  }

  /** MIDTURN-MAIL-BLIND L1: the message file names in an agent's inbox (not inbox/.done), with
   *  no parsing: a directory listing is all a per-hook check may cost. [] when there is none. */
  inboxFileNames(id: string): string[] {
    try { return readdirSync(join(this.agentDir(id), 'inbox')).filter((f) => f.endsWith('.json')); } catch { return []; }
  }

  /** MIDTURN-MAIL-BLIND L1: one inbox message's header (read once per new file), or null. */
  inboxHeader(id: string, file: string): { id: string; from: string; subject: string; supersedes?: string[] } | null {
    if (!/^[^\\/]+\.json$/.test(file)) return null;
    try {
      const m = JSON.parse(readFileSync(join(this.agentDir(id), 'inbox', file), 'utf8')) as Partial<HiveMessage>;
      return { id: String(m.id ?? file.replace(/\.json$/, '')), from: String(m.from ?? '?'), subject: String(m.subject ?? ''), ...normalizeSupersedes(m.supersedes) };
    } catch { return null; }
  }

  /** ZT-I1-MAIL slice 2: one inbox message, parsed, for the <hive-mail> block (bounded: a file
   *  over 1 MB or unparseable is null, as is a file the agent already moved). */
  inboxMessage(agentId: string, id: string): { path: string; msg: Partial<HiveMessage> } | null {
    // A ledger id is valid (§4.1), or a legacy file stem imported from this inbox: never a path.
    if (!isValidMailId(id) && !/^[^\\/:*?"<>|]+$/.test(id)) return null;
    if (id.includes('..')) return null;
    const path = join(this.agentDir(agentId), 'inbox', `${id}.json`);
    try {
      if (statSync(path).size > HiveManager.INBOX_MESSAGE_MAX_BYTES) return null;
      const msg = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return msg && typeof msg === 'object' && !Array.isArray(msg) ? { path, msg: msg as Partial<HiveMessage> } : null;
    } catch { return null; }
  }
  static readonly INBOX_MESSAGE_MAX_BYTES = 1024 * 1024;

  /**
   * ZT-I1-MAIL Q13 (god's ruling): a delivered message's body for the <hive-mail> block. From
   * inbox/, else from inbox/.done/ when the agent already moved it (`moved`: the 1.1.74 habit; a
   * move is never "handled"). Failures say why: `missing` (in neither place), `unreadable`
   * (oversize, not JSON, not an object), or `transient` (a lock or permission error the next hook
   * retries). `sig` fingerprints both files, so a skipped body is retried once either changes.
   */
  mailBody(agentId: string, id: string):
    | { ok: true; path: string; msg: Partial<HiveMessage>; moved: boolean }
    | { ok: false; reason: 'missing' | 'unreadable' | 'transient' | 'set-aside'; sig: string } {
    const sig = (): string => this.mailBodySig(agentId, id);
    if ((!isValidMailId(id) && !/^[^\\/:*?"<>|]+$/.test(id)) || id.includes('..')) return { ok: false, reason: 'unreadable', sig: 'invalid' };
    const inbox = join(this.agentDir(agentId), 'inbox');
    let transient = false;
    for (const [path, moved] of [[join(inbox, `${id}.json`), false], [join(inbox, '.done', `${id}.json`), true]] as const) {
      let raw: string;
      try {
        if (statSync(path).size > HiveManager.INBOX_MESSAGE_MAX_BYTES) return { ok: false, reason: 'unreadable', sig: sig() };
        raw = readFileSync(path, 'utf8');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        transient = true;   // EBUSY / EPERM / EACCES / EMFILE ...: try again at the next hook
        continue;
      }
      try {
        const msg = JSON.parse(raw) as unknown;
        if (msg && typeof msg === 'object' && !Array.isArray(msg)) return { ok: true, path, msg: msg as Partial<HiveMessage>, moved };
      } catch { /* unparseable */ }
      return { ok: false, reason: 'unreadable', sig: sig() };
    }
    // God db52b8: set aside by an explicit archive (inbox/.undelivered/): not missing. Skipped
    // until the restore brings it back.
    if (!transient && existsSync(join(inbox, UNDELIVERED_DIR, `${id}.json`))) return { ok: false, reason: 'set-aside', sig: sig() };
    return { ok: false, reason: transient ? 'transient' : 'missing', sig: sig() };
  }

  /** The inbox/ and .done/ files of one message (size + mtime, or absent), as one string. */
  mailBodySig(agentId: string, id: string): string {
    const inbox = join(this.agentDir(agentId), 'inbox');
    return [join(inbox, `${id}.json`), join(inbox, '.done', `${id}.json`)].map((p) => {
      try { const s = statSync(p); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; }
    }).join('|');
  }

  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }

  /** READS-181 A: a registered agent's folder (<hive>/agents/<id>), or null. */
  agentHome(id: string): string | null {
    const root = this.root();
    if (!root || !id || !this.registry().agents[id]) return null;
    return join(root, 'agents', id);
  }

  /** READS-181 B: where an agent's condensed tool outputs are kept in full, or null (no hive). */
  toolOutputDir(id: string): string | null {
    const root = this.root();
    return root && id ? join(root, 'agents', id, 'tool-output') : null;
  }
  /** IPC endpoint the cth-hook shim talks to (Phase 1 autonomy).
   *  On POSIX this is a Unix-domain socket file under the hive root. On Windows,
   *  Node's `net` IPC uses named pipes (a flat `\\.\pipe\` namespace, not the
   *  filesystem), so a raw file path fails to bind with EACCES — derive a stable,
   *  per-root pipe name instead. Both the server (`listen`) and the shim
   *  (`createConnection`) read this same value, so they stay in sync. */
  sockPath(): string | null {
    const root = this.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = createHash('sha1').update(root).digest('hex').slice(0, 12);
      // MUNDER_DEV=1 adds a `dev-` marker: the id already differs (it hashes the
      // dev hive root) but the marker makes the pipe obviously not Stable's.
      return `\\\\.\\pipe\\munder-difflin-${DEV_ISOLATION ? 'dev-' : ''}${id}`;
    }
    return join(root, 'hooks.sock');
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }
  /** The proxy-bridge sidecar (qwen). Pure-Node loopback reverse-proxy that
   *  observes a hookless CLI's LLM traffic and synthesizes the same HIVE_SOCK
   *  payloads the hook shims emit. Written in ensureHive alongside cth-hook.cjs. */
  private proxyShimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'hive-proxy.cjs') : null;
  }

  /**
   * The BUNDLED-NODE launcher: `<root>/bin/hive-node` (POSIX) / `hive-node.cmd`
   * (Windows). Every `.cjs` shim in the hive is executed through it.
   *
   * Why it exists: hooks are run by the agent CLI through a plain
   * `/bin/sh -c` with a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A user whose
   * node comes from nvm (PATH set only by an interactive login shell) has NO node
   * there, so a hook written as `node "<shim>"` exits **127 — command not found**
   * and every payload is silently lost: no live status, no Stop→inbox drain, no
   * session ids. Electron's own binary IS a full Node runtime under
   * `ELECTRON_RUN_AS_NODE=1`, and it is guaranteed present (it is us).
   *
   * A wrapper SCRIPT rather than an inline `ELECTRON_RUN_AS_NODE=1 "<exe>" …`
   * prefix because that prefix is POSIX-sh syntax — it is a hard error under
   * cmd.exe, which is what runs hook commands on Windows. The wrapper also gives
   * agents a `$HIVE_NODE` they can invoke directly (running the Electron binary
   * WITHOUT the env var would launch a second app window, not a script).
   *
   * Rewritten on every bootstrap, so an app update/move re-bakes execPath.
   */
  private nodeLauncherPath(): string | null {
    const root = this.root();
    if (!root) return null;
    return join(root, 'bin', process.platform === 'win32' ? 'hive-node.cmd' : 'hive-node');
  }

  /** Write the launcher described above. Best-effort: on failure callers fall
   *  back to bare `node`, i.e. exactly the pre-fix behavior. */
  private writeNodeLauncher(): void {
    const p = this.nodeLauncherPath();
    if (!p) return;
    try {
      if (process.platform === 'win32') {
        writeFileSync(p, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`, 'utf8');
      } else {
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeNodeLauncher failed:', e);
    }
  }

  /**
   * NATIVE-MEMORY section 6: `<root>/bin/memory/`, the directory the app PREPENDS to an agent's
   * PATH (whenever semantic memory is on), so `memory` resolves to the app's memory command.
   * Two wrappers, both running the command's script on Electron-as-Node: `memory.cmd` (cmd.exe,
   * PowerShell) and `memory` (Git bash, POSIX sh). The directory holds ONLY these: anything else
   * in it (a wrapper an older build wrote) is removed, so no other command name resolves from it.
   * Written only when the content changed, via temp + rename: a shell may be reading it.
   * Returns the directory, or null (no hive, or the write failed).
   */
  writeMemoryCommand(script: string): string | null {
    return this.writeCommandDir('memory', script);
  }

  /**
   * READS-181 A: `<root>/bin/ledger/`, the `ledger` command (one call that updates a card, writes
   * an outbox message and appends to memory.md, through the app). Same shape and rules as
   * writeMemoryCommand; prepended to every hive agent's PATH. Returns the directory, or null.
   */
  writeLedgerCommand(script: string): string | null {
    return this.writeCommandDir('ledger', script);
  }

  /** `<root>/bin/<name>/` holding ONLY `<name>.cmd` + `<name>` (Windows) or `<name>` (POSIX). */
  private writeCommandDir(name: string, script: string): string | null {
    const root = this.root();
    if (!root) return null;
    const dir = join(root, 'bin', name);
    const exe = process.execPath;
    const files: Array<[string, string, number]> = process.platform === 'win32'
      ? [
          [`${name}.cmd`, `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${script}" %*\r\n`, 0o644],
          [name, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}" "$@"\n`, 0o755]
        ]
      : [[name, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${exe}" "${script}" "$@"\n`, 0o755]];
    try {
      mkdirSync(dir, { recursive: true });
      const keep = new Set(files.map(([f]) => f));
      for (const f of readdirSync(dir)) {
        if (keep.has(f)) continue;
        try { rmSync(join(dir, f), { force: true, recursive: true }); } catch { /* in use: retried at the next spawn */ }
      }
      for (const [f, content, mode] of files) {
        const p = join(dir, f);
        let cur: string | null = null;
        try { cur = readFileSync(p, 'utf8'); } catch { /* not yet written */ }
        if (cur === content) continue;
        const tmp = `${p}.${process.pid}.tmp`;
        writeFileSync(tmp, content, 'utf8');
        if (process.platform !== 'win32') chmodSync(tmp, mode);
        renameSync(tmp, p);
      }
      return dir;
    } catch (e) {
      console.error(`[hive] write the ${name} command failed:`, e);
      return null;
    }
  }

  /** The launcher path if it is actually on disk, else null (→ callers fall back
   *  to bare `node`, i.e. exactly the pre-fix behavior — never worse than before). */
  private nodeLauncher(): string | null {
    const p = this.nodeLauncherPath();
    return p && existsSync(p) ? p : null;
  }

  /** The ABSOLUTE bundled-node command to BAKE into any text an agent is expected
   *  to run (`<launcher> <script> …`), falling back to bare `node`.
   *
   *  Exactly the value of the agent's `HIVE_NODE` env var — but agent-facing text
   *  must never spell it as `$HIVE_NODE`: that is POSIX shell syntax. A Windows
   *  agent runs its commands through cmd.exe/PowerShell, where `$HIVE_NODE`
   *  expands to NOTHING (cmd) or to an undefined variable (PowerShell), so every
   *  such instruction is dead on arrival there. The absolute path is correct on
   *  every platform and needs no expansion at all. */
  nodeCommand(): string {
    return this.nodeLauncher() ?? 'node';
  }

  /**
   * `<root>/bin/runtime` — the same bundled-node trick as `hive-node`, but the
   * wrapper is NAMED `node`, so anything that resolves `node` off PATH finds one.
   *
   * `hive-node` only covers commands WE generate. It does nothing for node that
   * the agent's own work needs at runtime: an MCP server declared as
   * `node ./server.js`, a provider CLI that shells out to node, a `.cjs` helper an
   * agent wrote itself. On a machine with no system node those all die with 127
   * exactly like the hooks did.
   *
   * This dir is APPENDED to the agent's PATH (see pty.spawn), never prepended: a
   * user who has their own node keeps their own version — we are strictly the
   * fallback. Prepending would silently swap every agent's node for Electron's
   * (20.18.1 as of Electron 32.3.3) underneath the user's own projects.
   *
   * NOTE: `node` only — deliberately no `npm`/`npx`. Electron bundles the Node
   * RUNTIME, not the npm CLI (which is ~12MB of JS we do not ship), so an `npm`
   * wrapper here could only be a stub that fails confusingly. A missing `npm` is
   * the honest signal; the install ladder (main/cliInstall.ts) detects it and
   * installs a REAL system Node — which brings npm with it. This shim is only the
   * last resort for when that install could not run (offline, or a platform with
   * no official installer).
   */
  runtimeBinDir(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'runtime') : null;
  }

  /** Write the `node` shim described above. Best-effort: on failure the dir is
   *  simply absent from PATH and behavior is exactly as before. */
  private writeRuntimeShims(): void {
    const dir = this.runtimeBinDir();
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'node.cmd'),
          `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" %*\r\n`,
          'utf8'
        );
      } else {
        const p = join(dir, 'node');
        writeFileSync(p, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, 'utf8');
        chmodSync(p, 0o755);
      }
    } catch (e) {
      console.error('[hive] writeRuntimeShims failed:', e);
    }
  }

  /** Build a hook command string that runs `script` under the guaranteed node,
   *  DOUBLE-QUOTED (safe for paths with spaces). */
  private nodeRun(script: string, ...args: string[]): string {
    const launcher = this.nodeLauncher();
    return [launcher ? `"${launcher}"` : 'node', `"${script}"`, ...args].join(' ');
  }

  /** Same, but UNQUOTED — for the CLIs whose hook config mangles embedded quotes
   *  (agy on cmd.exe) or stores the command in a quote-sensitive literal (codex's
   *  single-quoted TOML). Safe because both the hive root and the launcher inside
   *  it are space-free by construction; this only preserves each installer's
   *  existing quoting convention while swapping `node` for the bundled runtime. */
  private nodeRunUnquoted(script: string, ...args: string[]): string {
    return [this.nodeLauncher() ?? 'node', script, ...args].join(' ');
  }

  /** One proxy sidecar per live proxy-tier agent, keyed by agentId. Spawned in
   *  ensureAgent, killed on PTY exit / removeAgent / app quit (index.ts) — so a
   *  dead agent never leaks an orphan loopback listener. */
  private proxyChildren = new Map<string, ChildProcess>();

  /** AGY 1.1.48 - this run's lease on Antigravity's global statusline, or null when it
   *  was never started (dev isolation, no hive) or has been stopped. */
  private agyStatusline: AgyStatuslineOwner | null = null;
  /** The owner token the locator was last written with, so a new lease rewrites it. */
  private agyLocatorToken: string | null = null;
  /** The lease heartbeat, running only while a lease is held. */
  private agyHeartbeat: NodeJS.Timeout | null = null;

  // — bootstrap —

  /** Create the hive skeleton + git repo if missing. Idempotent. */
  ensureHive(): void {
    const root = this.root();
    if (!root) return;
    mkdirSync(join(root, 'agents'), { recursive: true });

    // Refreshed each bootstrap, like COMMANDS.md just below. It used to be
    // written only when absent, which meant a hive created once never saw a
    // protocol change again: this repo's own hive still carried the file from
    // the day it was initialised, so every protocol addition since had reached
    // new hives only. The file is generated, not user-authored, and agents are
    // pointed at it as the authority, so a stale copy is worse than a rewrite.
    writeFileSync(join(root, 'PROTOCOL.md'), PROTOCOL_MD, 'utf8');

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Hive board\n\n_Shared plans live here. The god agent is the scribe._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // The Claude Code command reference Michael consults (refreshed each bootstrap
    // so it tracks the bundled list).
    writeFileSync(join(root, 'COMMANDS.md'), COMMANDS_MD, 'utf8');

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. Refreshed
    // on every bootstrap so it tracks code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');
    // The proxy-bridge sidecar for hookless CLIs (qwen). Same refresh policy.
    writeFileSync(this.proxyShimPath()!, PROXY_BRIDGE_SHIM, 'utf8');
    // The bundled-node launcher every shim above is invoked through — MUST be
    // written before any hook installer runs (they probe for it).
    this.writeNodeLauncher();
    // …and the PATH-visible `node` fallback for the agent's OWN subprocesses.
    this.writeRuntimeShims();

    // 1.1.53 (the Human's decision): the hive is no longer a git repo the app maintains. Nothing
    // read its history, and every commit cost ~59 process starts (git plus the identity-guard
    // hooks), each an antivirus scan. A new hive is not git-initialised; an existing hive/.git
    // is LEFT ON DISK untouched (the Human can remove it), and its hooks simply stop firing.
    this.pruneRetiredHiveFiles(root);
  }

  /**
   * 1.1.60: remove files older builds generated that nothing reads any more. Only files the app
   * wrote itself go: `<hive>/memory-engine.json` (the old memory mode switch), and an agent's
   * `.gitignore` whose content is EXACTLY the list the app used to write there (an edited one is
   * the user's and stays). Idempotent and best-effort: a failure leaves the file for next time.
   */
  pruneRetiredHiveFiles(root: string): void {
    try { rmSync(join(root, 'memory-engine.json'), { force: true }); } catch { /* next start */ }
    let ids: string[] = [];
    try { ids = readdirSync(join(root, 'agents')); } catch { return; }
    for (const id of ids) {
      const p = join(root, 'agents', id, '.gitignore');
      try {
        if (readFileSync(p, 'utf8').replace(/\r\n/g, '\n') === RETIRED_AGENT_GITIGNORE) rmSync(p, { force: true });
      } catch { /* absent or unreadable: leave it */ }
    }
  }

  /** Validate an agent's cwd the way a spawn does — it must be an ABSOLUTE path
   *  that exists as a directory. Surfaced as `cwdValid` on the registry entry so
   *  the roster reliably exposes whether a worker's working directory is usable.
   *  Best-effort; never throws (a stat error degrades to invalid). */
  private cwdValidity(cwd: string | undefined): { valid: boolean; issue: string | null } {
    if (!cwd || typeof cwd !== 'string') return { valid: false, issue: 'missing' };
    // Defense-in-depth: a `~/…` cwd from an older registry entry (written before
    // ingestion-time expansion) would read as 'not-absolute' forever. Expand first
    // so the roster reports the truth about the directory the spawn would use.
    cwd = expandTilde(cwd);
    if (!isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
    try {
      return statSync(cwd).isDirectory()
        ? { valid: true, issue: null }
        : { valid: false, issue: 'not-a-directory' };
    } catch {
      return { valid: false, issue: 'missing-dir' };
    }
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (provider-specific args + env) that makes the process hive-aware.
   */
  async ensureAgent(
    meta: AgentMeta,
    opts: {
      semanticMemory?: boolean;
      knowledgeGraph?: boolean;
      /** ABSOLUTE path to the Knowledge-Graph CLI (`knowledge.env().KG_CLI`), baked
       *  into the agent's prompt instead of a `$KG_CLI` shell reference — `$VAR` is
       *  POSIX-only and expands to nothing under cmd.exe/PowerShell, so the KG
       *  instructions were unusable on Windows. Optional: undefined degrades to the
       *  old env-var spelling. */
      kgCliPath?: string;
      theme?: 'light' | 'dark';
      /** Consent state for the default-MCP bundle (W3). Threaded from the live
       *  HarnessConfig by the caller; undefined → catalog defaults apply. */
      mcpDefaults?: { [id: string]: { enabled: boolean } };
      /** App-resources `skills/` source dir (W3). The bundled read-only skills are
       *  copied into the agent's `.claude/skills/` per spawn; undefined or missing
       *  is a no-op (tolerated until Kevin populates the resource dir). */
      skillsDir?: string;
      /** CODEX-WAKE-161 (a): add `--no-daemon`. CODEX-NODAEMON-HARDENING: only an explicit
       *  `false` (a CLI KNOWN to predate the flag, codexNoDaemonGate) leaves it out; absent = on. */
      codexNoDaemon?: boolean;
      /** CODEX-BLOAT-165 fix 2: HarnessConfig.codexToolOutputTokenLimit (a number, 'off', or
       *  absent = the default), written into this agent's own config.toml. */
      codexToolOutputTokenLimit?: number | 'off';
      /** CODEX-BLOAT-165 fix 5: HarnessConfig.codexInheritPlugins. Only `true` keeps the
       *  inherited plugins; absent or false turns them off in this agent's config.toml. */
      codexInheritPlugins?: boolean;
      /** MODEL-PINBACK: the spawn's model. `requested` is the renderer's `--model`, `launch` the
       *  one the CLI is really given (the pin, when it applies). Recorded on the registry entry;
       *  a Codex agent's config.toml carries `launch`. Absent = not recorded (older callers).
       *  AGENT-MODEL-NOT-KEPT M2 (Codex): `requestedEffort` is the picker's effort, `launchEffort`
       *  the one this spawn runs (config.toml `model_reasoning_effort`), `defaultEffort` the
       *  seed's (what runs with neither). */
      spawnModel?: { requested?: string; launch?: string; requestedEffort?: string; launchEffort?: string; defaultEffort?: string };
      /** CODEX-TRUST-LAYER: the codex CLI version this agent gets (null = unknown), and the
       *  folders the Human allowed (HarnessConfig.codexLayerOptIns). */
      codexVersion?: string | null;
      codexLayerOptIns?: string[];
    } = {}
  ): Promise<SpawnInjection> {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureHive();

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });
    // A newly hired agent's outbox is watched at once, not at the next reconciliation.
    if (this.routerTimer) this.refreshOutboxWatchers();

    // Resolve role BEFORE writing identity.md. A restart passes the floor
    // roster's `description`, which can be a status caption ("on standby").
    // identity.md and registry.role are the durable job from the hire.
    const reg = this.registryForMutation();
    const prev = reg.agents[meta.id];
    if (meta.cwd) meta = { ...meta, cwd: expandTilde(meta.cwd) };
    const role = preferredAgentRole(meta.role, prev?.role, !!meta.isGod);
    meta = { ...meta, role };

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta), 'utf8'); // refresh on each spawn

    // W3 — bundled read-only skills: refresh the agent's .claude/skills/ from the
    // app-resources skills/ dir on every spawn (same policy as identity.md), so an
    // agent always rides with the shipped safe skill set. Tolerant: a missing or
    // partial source dir is a no-op (Kevin populates the resource dir in lp-manifest).
    if (opts.skillsDir) this.copyBundledSkills(opts.skillsDir, join(dir, '.claude', 'skills'));

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(memory, `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n\n${PINNED_SEED}`, 'utf8');
    } else {
      // PINNED-MEMORY: seed an empty "## How I work (standing lessons)" section under the header
      // (idempotent; an existing one is adopted). BEFORE the rollover, which keeps it at the top.
      let pinnedBytes = 0;
      try {
        const sd = seedPinnedSection(dir);
        pinnedBytes = sd.pinnedBytes;
        if (sd.raced) this.appendLog({ kind: 'memory-pinned-seed-raced', agentId: meta.id });
      } catch (e) { console.warn('[hive] memory pinned seed failed:', e); }
      // CODEX-BLOAT-165 fix 3: cap memory.md. Above MEMORY_ROLLOVER_BYTES the older part moves
      // to memory-archive-<date>.md (still indexed and searchable). At spawn, so no live
      // process of this agent is appending to it. Best-effort: never blocks a spawn.
      try {
        const r = rolloverMemory(dir);
        if (r.pinnedBytes !== undefined) pinnedBytes = r.pinnedBytes;
        if (r.rotated) this.appendLog({ kind: 'memory-rollover', agentId: meta.id, bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter, archive: r.archive ? basename(r.archive) : null });
        else if (r.raced) this.appendLog({ kind: 'memory-rollover-raced', agentId: meta.id, bytesBefore: r.bytesBefore });
        else if (r.pinnedTooLarge) this.appendLog({ kind: 'memory-pinned-too-large', agentId: meta.id, pinnedBytes: r.pinnedBytes, bytesBefore: r.bytesBefore });
      } catch (e) { console.warn('[hive] memory rollover failed:', e); }
      // Over the soft cap nothing is cut; the row (once per agent per day) makes it visible.
      try {
        if (pinnedBytes > PINNED_SOFT_CAP_BYTES && pinnedOverCapDue(dir)) this.appendLog({ kind: 'memory-pinned-over-cap', agentId: meta.id, pinnedBytes });
      } catch (e) { console.warn('[hive] memory pinned cap check failed:', e); }
    }

    // upsert registry — spread the PRIOR entry first so a respawn preserves
    // fields the spawn `meta` doesn't carry, above all `sessionId`. Without this,
    // ensureAgent (which runs before the resume lookup in the pty:spawn handler)
    // would wipe the recorded session id, so `lastSession()` returns undefined and
    // `--resume` is never attached — i.e. every restart starts a fresh thread.
    // Validate the working directory at the source so a bad value is visible on
    // the roster (cwdValid) rather than silently spawning into a nonexistent dir.
    // Store the EXPANDED cwd, never the raw `~/…` the user typed — the registry is
    // read by hooks, the roster and the worker watcher, none of which run a shell.
    const cwd = this.cwdValidity(meta.cwd);
    reg.agents[meta.id] = {
      ...prev,
      ...meta,
      capabilities: meta.capabilities ?? prev?.capabilities ?? [],
      role,
      status: 'idle',
      cwdValid: cwd.valid,
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      archived: false,
      lastSeen: Date.now()
    };
    // Q32: a restore clears the archive reason with the flag.
    delete reg.agents[meta.id].archiveReason;
    if (opts.spawnModel) this.recordLaunchModel(reg.agents[meta.id], meta.id, opts.spawnModel);
    if (meta.isGod) reg.godId = meta.id;
    this.atomicWriteJson(join(root, 'registry.json'), reg);
    // Jim LOW residual (god-approved): the registry entry (its provider above all) was just
    // (re)written by a spawn, respawn or relaunch; a reader's cached copy is stale NOW.
    for (const cb of this.provisionedListeners) { try { cb(meta.id); } catch { /* a listener never breaks a spawn */ } }
    // ZERO-TOKEN-LIVENESS (Dwight F2): a (re)spawn of an ARCHIVED agent is a restore edge.
    if (prev?.archived === true) this.emitArchiveChange(meta.id, false);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    // Q32 refinement (god 0f1672): a restore brings back mail set aside in inbox/.undelivered/.
    this.restoreUndelivered(meta.id);
    // Only logs on an invalid cwd (rare) — not a per-spawn line, so no log spam.
    if (!cwd.valid) {
      this.appendLog({ kind: 'cwd_invalid', agentId: meta.id, cwd: meta.cwd, issue: cwd.issue });
    }

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir
    };
    // The bundled-node launcher, so an agent can run the hive's .cjs helpers (KG
    // CLI, Slack reply helper) even when `node` is not on its PATH. Invoking the
    // Electron binary directly would open a second app window, so this must stay
    // the wrapper path and never process.execPath.
    //
    // Kept as an env var for agent CONVENIENCE and for anything that reads it
    // programmatically — but agent-facing TEXT no longer references it by name:
    // `$HIVE_NODE` is POSIX-only syntax and expands to nothing under cmd.exe /
    // PowerShell, so every such instruction was dead on a Windows floor. Commands
    // we write for an agent to run bake `nodeCommand()`'s absolute path instead.
    env.HIVE_NODE = this.nodeCommand();
    // HOOK-BROKER: loopback must never go through a proxy. Claude refuses an HTTP hook when its
    // proxy settings would route it, and uses the env proxy when one is set.
    env.NO_PROXY = mergeNoProxy(process.env.NO_PROXY ?? process.env.no_proxy);
    env.no_proxy = env.NO_PROXY;
    // Generic light/dark hint for TUIs that paint their own background. The app
    // defaults to light but every agent CLI assumed a dark terminal, so Crush and
    // OpenCode looked pasted into a light window. COLORFGBG is the classic
    // "fg;bg" convention (rxvt/konsole) that lipgloss/termenv fall back to when
    // an OSC 11 query gets no answer. Claude Code gets the same hint through its
    // per-session settings.json (hookSettings); Crush and OpenCode through their
    // per-agent config dirs below. A running TUI does not re-read this: new
    // agents pick up the current theme, running ones keep the one they started with.
    if (opts.theme) env.COLORFGBG = opts.theme === 'dark' ? '15;0' : '0;15';

    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');

    // Non-hive-aware providers (Antigravity's `agy`, OpenAI's `codex`, xAI's
    // `grok`) don't
    // understand Claude Code's flags (no `--append-system-prompt`, no telemetry,
    // no `--settings`). Instead: (1) the hive identity+protocol rides in as the
    // session's INITIAL prompt — the closest thing to `--append-system-prompt`
    // these CLIs offer (after the first turn the session continues normally); and
    // (2) lifecycle hooks are wired via the preset's `hookBridge` below. Together
    // that makes a Gemini/Codex worker a full hive citizen — live status +
    // Stop→inbox-drain — without Claude installed at all.
    //
    // How the prompt rides in differs by CLI:
    //  - agy takes it under a flag (`agy -i "<prompt>"`) → push [flag, prompt].
    //  - codex/grok take it POSITIONALLY (`codex|grok "<prompt>"`) → push the
    //    bare prompt as a trailing arg (node-pty passes argv literally, so it
    //    arrives as one positional argument after codex's own flags).
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag = preset.initialPromptFlag;
      const prompt = this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath);
      // agy, codex, and grok expose a Claude-style lifecycle-hook surface, so each
      // gets the SAME live status + Stop→inbox-drain Claude does — selected by the
      // preset's `hookBridge`. agy needs a translating shim (its hook stdin/stdout
      // shape differs from Claude's); codex reuses the Claude `cth-hook` shim
      // verbatim (its hook payload + response contract are already Claude-shaped)
      // and is isolated to a per-agent CODEX_HOME so the user's global ~/.codex
      // CONFIG is never mutated. (The credential is a separate question: outside DEV
      // the global auth.json is still linked into that home — see installCodexHooks
      // and F1. Under MUNDER_DEV=1 it is not.) Both share the HIVE_SOCK wiring below.
      const preArgs: string[] = [];
      // Codex: set when the protocol went into its developer_instructions (no positional prompt).
      let developerInstructionsSet = false;
      // Dispatch on the structured bridge descriptor (the foundation's `bridgeOf`
      // derives {kind:'hooks'} from the legacy `hookBridge` for agy/codex, and
      // returns the explicit {kind:'proxy'} for qwen). Two ways a hookless CLI
      // becomes a hive citizen:
      //   - 'hooks' → install a config-file hook shim (agy translator / codex verbatim).
      //   - 'proxy' → spawn a loopback reverse-proxy sidecar that observes the CLI's
      //               LLM traffic and SYNTHESIZES the same HIVE_SOCK payloads.
      const desc = bridgeOf(meta.provider);
      const sock = this.sockPath();
      if (desc && sock) {
        env.HIVE_SOCK = sock;
        try {
          if (desc.kind === 'hooks') {
            // The agy and grok bridges write GLOBAL config (~/.gemini/…/hooks.json,
            // ~/.grok/hooks/munder-hive.json) whose socket is THIS process's pipe, so
            // both go through `mayWriteGlobalConfig` — which refuses for a dev build and
            // for any hive that is not the configured one. The refusal lives INSIDE each
            // installer, so a future caller cannot route around it.
            if (desc.shim === 'agy') {
              this.installAgyHooks();
              // The statusline lease is checked immediately before every interactive
              // AGY spawn: a user may have replaced it since startup, and then capture
              // stays off for this run rather than being forced back over their choice.
              this.reconcileAgyStatusline();
            }
            else if (desc.shim === 'codex') {
              const configuredCompactLimit = reg.agents[meta.id]?.codexAutoCompactTokenLimit;
              // The registry is operator-editable JSON. Do not let an accidental low or
              // over-window value create an expensive compaction loop or disable compaction.
              // Log once for this spawn so the operator can correct the field without a noisy
              // per-request event.
              if (configuredCompactLimit !== undefined && !isCodexAutoCompactTokenLimitOverride(configuredCompactLimit)) {
                this.appendLog({ kind: 'codex-compact-limit-ignored', agentId: meta.id, value: configuredCompactLimit });
              }
              const codex = this.installCodexHooks(dir, meta.id, preset.systemPromptChannel === 'codex-developer-instructions' ? prompt : null, codexToolOutputLimitForConfig(opts.codexToolOutputTokenLimit), opts.codexInheritPlugins === true, opts.spawnModel?.launch, configuredCompactLimit, meta.cwd, { codexVersion: opts.codexVersion ?? null, optIns: opts.codexLayerOptIns }, opts.spawnModel?.launchEffort);
              // F1 fail-closed: provisioning refused, so this agent must not start.
              if (codex.refusal) return { args: [], env: {}, refusal: codex.refusal, ...(codex.codexLayerOptIn ? { codexLayerOptIn: codex.codexLayerOptIn } : {}) };
              env.CODEX_HOME = codex.home;
              if (codex.developerInstructions) developerInstructionsSet = true;
              // WAKE-SCREEN-GUARD R2-2: no startup update prompt on any Codex argv (fresh and
              // `codex resume` alike: `-c` is a global flag). The same key is in its config.toml.
              preArgs.push('-c', 'check_for_update_on_startup=false');
              // CODEX-TIMER-CALL: curated-plugin startup sync falls through to an unauthenticated
              // outbound archive request after its two 30-second retries. An argv override is
              // higher priority than every generated or project layer, so every hive Codex spawn
              // (including resume, which reuses these args) keeps that feature off.
              preArgs.push('-c', 'features.plugins=false');
              // Codex refuses to run hooks from a config dir without persisted
              // "hook trust" (normally an interactive gate). Our hooks.json is
              // hive-authored inside an isolated CODEX_HOME, so we bypass that gate
              // for this automated spawn — the flag's documented use ("automation
              // that already vets hook sources"). Without it the hooks silently
              // never fire. Must precede the positional prompt.
              preArgs.push('--dangerously-bypass-hook-trust');
              // CODEX-WAKE-161 (a): pin the in-process app-server each agent already runs (no
              // shared background server across agents; silences the "running without the
              // shared background server" notice). CODEX-NODAEMON-HARDENING: fail closed. Only a
              // caller that KNOWS the CLI predates the flag passes false (an older CLI refuses
              // unknown flags). A daemon target spawns git with visible windows, and a resume over
              // it skips the hook-trust bypass for the startup review (a screen nobody answers).
              if (opts.codexNoDaemon !== false) preArgs.push('--no-daemon');
              // CODEX-NODAEMON-HARDENING: codex's startup plugin sync (and the agent's own git) must
              // never raise a credential prompt or a Git Credential Manager window on an unattended
              // floor: a stored credential still works, a missing one fails visibly in the log.
              env.GIT_TERMINAL_PROMPT = '0';
              env.GCM_INTERACTIVE = 'never';
            }
            else if (desc.shim === 'pi') {
              // Pi (earendil-works) has a rich pi.on(event) lifecycle. We drop a
              // bundled extension into a PER-AGENT PI_CODING_AGENT_DIR (so the user's
              // global ~/.pi is never touched) that posts cth-hook-shaped payloads to
              // HIVE_SOCK on tool_call/agent_end and auto-approves tools when the floor
              // is in auto mode. HIVE_AUTO_APPROVE (set in spawnAgentCore from
              // config.autoMode) gates the auto-allow — Pam guardrail #5.
              // LIVE-UNVERIFIED: the exact extension API surface needs BYOK keys to
              // prove; the renderer idle inbox-wake nudge is the guaranteed drain.
              env.PI_CODING_AGENT_DIR = this.installPiHooks(dir);
            }
            else if (desc.shim === 'opencode') {
              // OpenCode (anomalyco/opencode) has no Claude-shaped Stop hook, but its
              // plugin API exposes a real session.idle event (god Decision 1). We drop
              // a bundled plugin into a PER-AGENT OPENCODE config dir that posts
              // HIVE_SOCK payloads on tool.execute.before/after + session.idle — the
              // same Stop→drain semantics, provider-agnostic, no traffic interception.
              // LIVE-UNVERIFIED (plugin auto-load + session.idle firing); the renderer
              // idle inbox-wake nudge is the guaranteed drain fallback.
              env.OPENCODE_CONFIG_DIR = this.installOpenCodePlugin(dir, opts.theme);
            }
            else if (desc.shim === 'gemini') {
              // Point only this worker at a per-agent system settings file so
              // the bridge is trusted and ~/.gemini/settings.json stays untouched.
              env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = this.installGeminiHooks(dir);
            }
            else if (desc.shim === 'grok') {
              this.installGrokHooks();
            }
          } else if (desc.kind === 'proxy') {
            // Stable per-spawn session id, stamped on every synthesized payload so
            // recordSession (registry resume key) and the cost ledger persist.
            const spawnTs = String(Date.now());
            const sessionId = `proxy-${meta.id}-${createHash('sha1').update(root + meta.id + spawnTs).digest('hex').slice(0, 12)}`;
            env.HIVE_PROXY_SESSION = sessionId;
            // The CLI normally reads its upstream base URL from `baseUrlEnv`; capture
            // the user's configured value as the sidecar's UPSTREAM, then point the
            // CLI at the loopback proxy instead. Fall back to the cloud default if
            // the user hasn't set one.
            const upstream = process.env[desc.baseUrlEnv]
              || (desc.api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
            const port = await this.startProxyBridge(meta.id, { sock, sessionId, api: desc.api, upstream });
            // Only redirect the CLI through the proxy if the sidecar actually bound a
            // port. On failure leave routing untouched → the CLI talks to its real
            // upstream directly (degraded: no synthesized hive events, but it still
            // runs). The degradation is logged, not hidden (1e).
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
              if (meta.provider === 'crush') {
                // Crush has NO base-URL env override, so the generic env-rewrite is a
                // no-op for it. Route it instead via a per-agent CRUSH_GLOBAL_CONFIG
                // whose chosen provider's base_url points at the loopback proxy
                // (installCrushConfig — sibling of installCodexHooks). `upstream`
                // (captured above from the inert sentinel env or cloud default) is the
                // proxy's real target. Per-agent CRUSH_GLOBAL_DATA isolates session
                // state from the user's global ~/.config/crush.
                const crush = this.installCrushConfig(dir, loopback, desc.api, opts.theme);
                env.CRUSH_GLOBAL_CONFIG = dir;
                env.CRUSH_GLOBAL_DATA = crush.data;
              } else {
                env[desc.baseUrlEnv] = loopback;
              }
            }
            else console.error(`[hive] proxy bridge for ${meta.id} did not bind — spawning without hive events`);
          }
        } catch (e) { console.error(`[hive] install ${desc.kind} bridge failed:`, e); }
      }
      // Inject the protocol text whichever way the CLI accepts it.
      // type-into-tui (Crush): the bare TUI reads a positional as a Cobra subcommand
      // → `Unknown command`. So DROP the positional and hand the protocol back as
      // seedPrompt; the renderer types it into the TUI after boot (ondev-b).
      // AGY-STARTUP-TURN: agy's real system channel. The protocol becomes the SYSTEM prompt of
      // a per-agent custom agent, and agy starts with NO initial prompt, so it comes up idle
      // (an `-i` prompt is a first USER turn, which AGY runs as a task). Refused (dev build,
      // not the live hive) or failed: the initial-prompt path below, as before.
      if (preset.systemPromptChannel === 'agy-custom-agent') {
        const agent = this.installAgyAgent(meta, prompt);
        if (agent) return { args: [...preArgs, '--agent', agent], env };
      }
      // Codex: the protocol is already its developer_instructions (installCodexHooks), so NO
      // positional prompt: `codex` (and `codex resume <sid>`) start without a user turn.
      if (developerInstructionsSet) return { args: [...preArgs], env };
      if (preset.seedDelivery === 'type-into-tui') return { args: [...preArgs], env, seedPrompt: prompt };
      // If a provider somehow exposes neither a flag nor a positional prompt, spawn bare.
      if (flag) return { args: [...preArgs, flag, prompt], env };
      if (preset.positionalInitialPrompt) return { args: [...preArgs, prompt], env };
      return { args: preArgs, env };
    }

    // Stage 7A — first-party Claude Code telemetry → the embedded loopback OTLP
    // collector (telemetry.ts). Pure env, no --settings change. Only injected
    // for Claude Code once the collector is up (otelEndpoint set), so telemetry-
    // off installs and non-Claude providers spawn exactly as before.
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000'; // 5s — near-live without spamming
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args: string[] = [];
    if (!claudeProvider) return { args, env };
    // JOB-ENV-IDENTITY: keep every hive agent out of Claude Code's shared background daemon.
    // Parking a session there (agent view, /background, --bg) moves it into ONE daemon whose
    // env belongs to whichever agent started it (live 2026-09-27: Andy's session ran with
    // AGENT_ID=jim, a dead OTel port after a restart, Jim's OTel label). This is the CLI's
    // own switch ("Disable agent view (`claude agents`, `--bg`, /background, the on-demand
    // daemon)"); the per-agent settings file sets disableAgentView too.
    env.CLAUDE_CODE_DISABLE_AGENT_VIEW = '1';

    args.push('--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath));

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      // HOOK-BROKER: this spawn's HTTP hook URL (a fresh token), or null -> command hooks.
      const hookUrl = this.hookBroker?.urlFor(meta.id) ?? null;
      this.writeJson(settingsPath, this.hookSettings(shim, meta.cwd, opts.mcpDefaults, opts.theme, hookUrl, meta.id));
      // READS-181 A: the `ledger` command posts to the same broker with this spawn's token.
      if (hookUrl) env.HIVE_LEDGER_URL = hookUrl.replace('/hook/', '/ledger/');
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /** Update the durable job string (hire role) without respawning. Refreshes
   *  registry.json + identity.md so the floor editor and the hive stay aligned. */
  patchAgentRole(id: string, role: string): { ok: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled' };
    const next = role.trim();
    if (!next) return { ok: false, error: 'empty role' };
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'unknown agent' };
      if (agent.role === next) return { ok: true };
      agent.role = next;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      writeFileSync(join(this.agentDir(id), 'identity.md'), this.identityText(agent), 'utf8');
      this.appendLog({ kind: 'role', agentId: id, role: next });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   *
   * ZT-I1-MAIL Q32 (god 7048a1 + 0f1672): `reason` is recorded as `archiveReason` (see
   * RegistryAgent). An explicit archive of an agent archived for a non-bouncing reason upgrades
   * the reason; a non-bouncing reason never downgrades an explicit one. Un-archiving clears the
   * reason and moves inbox/.undelivered back into inbox/ and the ledger (restoreUndelivered).
   */
  setArchived(id: string, archived: boolean, reason: ArchiveReason = 'explicit'): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[id];
      // An archived agent's hook token is revoked even when the flag is already set.
      if (archived) this.hookBroker?.revoke(id);
      if (!agent) return;
      if (archived) {
        if (agent.archived === true && (reason !== 'explicit' || archivedForMail(agent))) {
          if (reason === 'explicit') this.setAsideUndelivered(id);   // idempotent re-check
          return;
        }
        agent.archived = true;
        agent.archiveReason = reason;
      } else {
        if (agent.archived !== true && agent.archiveReason === undefined) { this.restoreUndelivered(id); return; }
        agent.archived = false;
        delete agent.archiveReason;
      }
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived, ...(archived ? { reason } : {}) });
      this.emitArchiveChange(id, archived);
      if (!archived) this.restoreUndelivered(id);
      else if (reason === 'explicit') this.setAsideUndelivered(id);
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /**
   * God df70e4 / 016ccd: an EXPLICIT archive sets the agent's unread inbox files aside exactly as
   * the §7.1 step-2 migration does (mailMigration.setAsideUndelivered: the same moveUndelivered and
   * directory-built report; the banner re-shows for new items). Orphan and pty-exit archives move
   * nothing. The agent's ledger is left as it is: its not-acted entries keep their ids, nothing
   * reads pending for an archived agent (no PTY, no wake, no fleet ledger backlog), and the restore
   * gives each file its own name back (restoreUndelivered). Logged; never throws.
   */
  setAsideUndelivered(id: string): number {
    const root = this.root();
    if (!root || !isValidMailId(id)) return 0;
    try {
      const r = setAsideUndelivered(root, id);
      // God db52b8: in the same step, every not-acted ledger entry whose file is now in
      // .undelivered/ is marked set-aside, so a still-live session (an explicit archive without a
      // teardown: the IPC or the voice action) neither surfaces it, nor finds it "missing", nor
      // acts it at its Stop.
      try {
        if (this.mail.hasAgent(id)) {
          const stems = readdirSync(join(root, 'agents', id, 'inbox', UNDELIVERED_DIR)).filter((n) => n.endsWith('.json') && !n.includes('.tmp')).map((n) => n.slice(0, -'.json'.length));
          this.mail.setAside(id, stems, true);
        }
      } catch { /* no .undelivered/ (nothing set aside) */ }
      if (r.moved) this.appendLog({ kind: 'mail-undelivered-set-aside', agentId: id, count: r.moved });
      if (r.errors.length) this.appendLog({ kind: 'mail-undelivered-set-aside-error', agentId: id, errors: r.errors.slice(0, 5) });
      return r.moved;
    } catch (e) {
      try { this.appendLog({ kind: 'mail-undelivered-set-aside-error', agentId: id, error: String(e).slice(0, 300) }); } catch { /* noop */ }
      return 0;
    }
  }

  /**
   * ZT-I1-MAIL Q32 refinement (god 0f1672): a restored agent gets back the mail the §7.1 step-2
   * migration set aside in inbox/.undelivered/: each file returns to inbox/ (a name already taken
   * in inbox/, .done/ or the ledger gets `<stem>.N`) and enters the ledger as delivered
   * (`reason:"undelivered-restored"`), so a 1.1.74 archive that was really a crash loses nothing.
   * The ledger is touched FIRST, so the §7.1 first-touch import can never take the returned files
   * for legacy mail. Idempotent (an empty or missing .undelivered/ is a no-op), logged
   * `mail-undelivered-restored`; the restored items leave the undelivered report. Never throws.
   */
  restoreUndelivered(id: string): string[] {
    const root = this.root();
    if (!root || !isValidMailId(id)) return [];
    try {
      if (!existsSync(join(root, 'agents', id, 'inbox', UNDELIVERED_DIR))) return [];
      if (!this.mail.hasAgent(id)) return [];
      this.mail.ledger(id);
      // df70e4: a NOT-acted entry of the same stem is this very message (set aside by an explicit
      // archive after 1.1.75): it takes its name back and its entry is reused; an acted one is not.
      const moved = restoreUndeliveredFiles(root, id, (stem) => this.mail.ledger(id).entries[stem]?.state === 'acted');
      if (!moved.length) return [];
      // God db52b8: the returned entries are no longer set aside.
      this.mail.setAside(id, moved.map((m) => m.id), false);
      const ids = this.mail.admitRestored(id, moved.map((m) => m.id));
      // An entry still surfacing/surfaced from before the archive goes back to delivered (re-shown).
      const open = moved.map((m) => m.id).filter((m) => { const st = this.mail.ledger(id).entries[m]?.state; return st === 'surfacing' || st === 'surfaced'; });
      if (open.length) this.mail.redeliver(id, open, 'undelivered-restored');
      try { dropUndeliveredItems(root, id, moved.map((m) => m.file)); } catch { /* the report is informational */ }
      this.appendLog({ kind: 'mail-undelivered-restored', agentId: id, count: moved.length, ids: moved.map((m) => m.id).slice(0, 50) });
      return ids;
    } catch (e) {
      try { this.appendLog({ kind: 'mail-undelivered-restore-error', agentId: id, error: String(e).slice(0, 300) }); } catch { /* noop */ }
      return [];
    }
  }

  /**
   * Change an agent's display name without changing its durable identity.
   * The registry key, agent directory, session id, and every mailbox path remain
   * keyed by `id`; only the human-facing name is updated.
   *
   * `fleet.json` is patched in the same operation so god's next prompt receives
   * the new name immediately rather than waiting for the periodic fleet refresh.
   */
  /**
   * Put an agent on hold, or take it off, and tell Michael immediately.
   *
   * `fleet.json` is patched in the same operation for the same reason
   * `renameAgent` does it: god's roster is injected from that file on its next
   * prompt, and waiting up to 8s for the periodic refresh means one more
   * dispatch can still land on someone the human has just claimed.
   */
  setAgentHold(id: string, hold: boolean): { ok: boolean; onHold?: boolean; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      if (!!agent.onHold === hold) return { ok: true, onHold: hold };

      agent.onHold = hold;
      this.writeJson(join(root, 'registry.json'), reg);

      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; onHold?: boolean }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) { row.onHold = hold; this.writeJson(fleetPath, fleet); }
          }
        } catch { /* fleet is a cache — the registry above is the record */ }
      }
      this.appendLog({ kind: 'agent-hold', id, onHold: hold });
      return { ok: true, onHold: hold };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  renameAgent(id: string, name: string): { ok: boolean; name?: string; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, error: 'hive disabled (no harnessHome)' };

    const nextName = name.trim();
    if (!nextName) return { ok: false, error: 'Name is required' };

    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: 'Agent not found' };
      if (agent.name === nextName) return { ok: true, name: nextName };

      const previousName = agent.name;
      agent.name = nextName;
      this.writeJson(join(root, 'registry.json'), reg);

      // fleet.json is ephemeral and may not exist yet. When it does, keep its
      // display name in lockstep with the registry so rosterContext() is fresh.
      const fleetPath = join(root, 'fleet.json');
      if (existsSync(fleetPath)) {
        try {
          const fleet = this.readJson<{ agents?: Array<{ id?: string; name?: string }> }>(fleetPath, {});
          if (Array.isArray(fleet.agents)) {
            const row = fleet.agents.find((candidate) => candidate.id === id);
            if (row) {
              row.name = nextName;
              this.writeJson(fleetPath, fleet);
            }
          }
        } catch { /* periodic snapshot will repair a malformed/stale fleet file */ }
      }

      this.appendLog({ kind: 'rename', agentId: id, previousName, name: nextName });
      return { ok: true, name: nextName };
    } catch {
      return { ok: false, error: 'Could not rename agent' };
    }
  }

  /**
   * Persist the agent's Claude Code session_id (Lane A #6.6a). Captured from hook
   * payloads; written only when it actually changes (a new session), so this is a
   * no-op on the vast majority of hook events. The id is the `--resume` key for
   * idempotent resume after a crash/restart AND the accounting/dedup key for cost
   * samples. Best-effort — never throws into a hook handler.
   */
  recordSession(agentId: string, sessionId: string, source: 'hook' | 'sample' = 'hook'): void {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[agentId];
      if (!agent) return; // unknown agent → no write
      const hookIds = agent.hookSessionIds ?? [];
      if (this.retiredSessions.get(agentId)?.has(sessionId)) return; // SESSION-PROMPT-ROTATION
      // SESSION-PROMPT-ROTATION: a session this process started (not the one it resumed) is
      // stamped with the process's prompt fingerprint, once, from its own hook.
      const note = this.spawnPrompt.get(agentId);
      const stamp = source === 'hook' && note && note.resumedSid !== sessionId && !agent.sessionPrompts?.[sessionId] ? note.fp : null;
      if (source === 'sample') {
        // SESSION-CROSSWIRE: the OTel sample's agent.id label is not proof of ownership.
        // Claude Code background jobs report under the resource attributes of whichever
        // agent's process hosts them, so the sample carried Andy's live session as
        // Jim's. The sample may not replace a key this agent's own hooks wrote, nor take
        // an id another agent claims.
        if (agent.sessionId === sessionId) return;
        if (agent.sessionId && agent.sessionSource === 'hook') return;
        if (sessionClaimedByOther(reg, agentId, sessionId)) return;
      } else if (!stamp && agent.sessionId === sessionId && agent.sessionSource === 'hook' && hookIds.includes(sessionId)) {
        return; // unchanged and already owned → no write (the common hook case)
      }
      const changed = agent.sessionId !== sessionId;
      if (changed) {
        // START-FIXES-163 (1): keep the id this one replaces. If the new key later turns
        // out to have no transcript, the next spawn resumes this one instead of silently
        // starting fresh (index.ts, the Claude resume block).
        if (agent.sessionId) agent.previousSessionId = agent.sessionId;
        agent.sessionId = sessionId;
      }
      agent.sessionSource = source;
      if (source === 'hook' && !hookIds.includes(sessionId)) agent.hookSessionIds = [...hookIds, sessionId].slice(-HOOK_SESSION_IDS_CAP);
      if (stamp) agent.sessionPrompts = withSessionStamp(agent.sessionPrompts, sessionId, stamp);
      agent.lastSeen = Date.now();
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      if (changed) this.appendLog({ kind: 'session', agentId, sessionId, source });
    } catch { /* best-effort — never crash a hook handler */ }
  }

  /** SESSION-CROSSWIRE: does another agent claim `sessionId`? The resume guard. */
  sessionClaimedByOther(agentId: string, sessionId: string): boolean {
    return sessionClaimedByOther(this.registry(), agentId, sessionId);
  }

  /** SESSION-CROSSWIRE: session id → the agent whose own hooks reported it. Cost
   *  attribution follows this, not the OTel agent.id label. */
  hookSessionOwners(): Map<string, string> {
    const owners = new Map<string, string>();
    for (const [id, a] of Object.entries(this.registry().agents)) {
      for (const sid of a.hookSessionIds ?? []) owners.set(sid, id);
    }
    return owners;
  }

  /**
   * Claude status-line model (kept for its callers): `appDefault` is the model a Claude agent runs
   * when nothing is requested, so a pre-MODEL-PINBACK entry keeps the old rule (pin a divergence
   * from the default, clear it on a return). See observeLiveModel.
   */
  recordModel(agentId: string, model: string, appDefault: string | undefined): void {
    this.observeLiveModel(agentId, 'claude', model, { fallbackBaseline: appDefault });
  }

  /**
   * MODEL-PINBACK G2: one live-model observation from a provider bridge. Pins a user's in-TUI
   * switch (and clears it on a return to the requested model) per src/shared/modelPin.ts. The
   * entry must be of `provider`: a bridged provider's display model never becomes another
   * provider's CLI argument. Writes the registry only when something changed.
   */
  observeLiveModel(
    agentId: string,
    provider: 'claude' | 'codex' | 'antigravity',
    model: string,
    opts: { observedAt?: number; fallbackBaseline?: string; effort?: string | null } = {}
  ): void {
    const root = this.root();
    if (!root || !model.trim()) return;
    const now = Date.now();
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[agentId];
      if (!agent || (agent.provider ?? 'claude') !== provider) return;
      const before = agent.model;
      const beforeFrom = agent.modelPinnedFrom;
      const beforeEffort = agent.modelEffort;
      const fromEffort = agent.liveEffort ?? agent.launchEffort ?? null;
      // What the live model moved FROM: the last live model of this process, else its launch
      // model (for a pre-MODEL-PINBACK entry, the previous pin).
      const from = agent.liveModel ?? agent.launchModel ?? before ?? null;
      // USER OR AUTO: did HUMAN input reach this agent's pty since the previous observation (or
      // since launch)? Unknown (no source wired, no live pty) is not proof of a human: 'auto'.
      const since = this.modelObservedAt.get(agentId) ?? agent.launchedAt ?? 0;
      const human = this.humanInputAt?.(agentId);
      const humanInputSince = typeof human === 'number' && human > since;
      const r = applyLiveModel(agent, model, { ...opts, humanInputSince });
      // M1: the window marker is the observation's OWN time (a Codex turn_context's stamp; capped
      // at now, since a stamp is never in the future), never the reading hook's clock, and it
      // only moves forward. Re-reading the previous turn's turn_context at UserPromptSubmit must
      // not move it past the person's `/model` keys.
      if (r.action !== 'stale' && r.action !== 'unknown-launch') {
        const at = Math.min(opts.observedAt ?? now, now);
        if (at > (this.modelObservedAt.get(agentId) ?? -Infinity)) this.modelObservedAt.set(agentId, at);
      }
      if (!r.changed) return;
      agent.lastSeen = now;
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      // Jim SHOULD-FIX: an automatic CLI fallback (a plan-limit Opus->Sonnet switch, or a Codex/AGY
      // equivalent reported as the live model) cannot be told apart from a user's /model, and it
      // pins too. Every pin and every clear is therefore logged with its source, so a pin can be
      // traced to the observation that made it. No expiry: that is the Human's decision.
      const evidence = HiveManager.MODEL_EVIDENCE[provider];
      // M2: the effort is on the row only when the CLI reports one.
      const effortCols = agent.modelEffort !== undefined || fromEffort !== null ? { effort: agent.modelEffort ?? null, fromEffort } : {};
      if (agent.model !== undefined && (agent.model !== before || agent.modelPinnedFrom !== beforeFrom || agent.modelEffort !== beforeEffort)) {
        this.appendLog({ kind: 'model-pinned', agentId, provider, source: agent.modelPinSource ?? null, from, to: agent.model, requested: agent.requestedModel ?? null, evidence, ...effortCols });
      } else if (agent.model === undefined && before !== undefined) {
        this.appendLog({ kind: 'model-pin-cleared', agentId, provider, pinned: before, from, to: model.trim(), requested: agent.requestedModel ?? null, evidence });
      }
    } catch { /* best-effort - never crash a status line or a hook */ }
  }

  /** MODEL-PINBACK user/auto: when a live model was last observed per agent (in memory; a new
   *  process starts from its launch time). */
  private modelObservedAt = new Map<string, number>();
  /** SESSION-PROMPT-ROTATION: per agent, the prompt fingerprint of its CURRENT process and the
   *  session that process resumed (null = it started fresh). A session this process opens other
   *  than the resumed one was started with that prompt, so its first hook stamps it. */
  private spawnPrompt = new Map<string, { fp: string; resumedSid: string | null }>();
  /** Session ids retired by a Start fresh or a rotation: a late hook from the old process may
   *  not write them back as the resume key. In memory; a restart has no old process left. */
  private retiredSessions = new Map<string, Set<string>>();
  /** MODEL-PINBACK user/auto: when HUMAN-origin input last reached the agent's live pty (main
   *  wires this to PtyManager.lastHumanInputAt). Unset = never a human: every pin is 'auto'. */
  private humanInputAt: ((agentId: string) => number | undefined) | null = null;
  setHumanInputSource(fn: ((agentId: string) => number | undefined) | null): void { this.humanInputAt = fn; }

  /** MODEL-PINBACK: which observation a live model came from (the `evidence` of a pin log row). */
  static readonly MODEL_EVIDENCE: Readonly<Record<'claude' | 'codex' | 'antigravity', 'status-line' | 'rollout-turn_context' | 'agy-statusline'>> = {
    claude: 'status-line',
    codex: 'rollout-turn_context',
    antigravity: 'agy-statusline'
  };

  /** MODEL-PINBACK: record a spawn's requested/launch model on its (about to be written) entry.
   *  A pin that no longer applies (the picker changed the request since) is dropped here. */
  private recordLaunchModel(entry: ModelPinFields, agentId: string, spawn: { requested?: string; launch?: string; requestedEffort?: string; launchEffort?: string; defaultEffort?: string }): void {
    const requested = spawn.requested?.trim() || undefined;
    const launch = spawn.launch?.trim() || undefined;
    const requestedEffort = normEffort(spawn.requestedEffort);
    const launchEffort = normEffort(spawn.launchEffort);
    const resolved = resolveSpawnModel(entry, requested, requestedEffort);
    if (resolved.dropPin) {
      this.appendLog({
        kind: 'model-pin-dropped', agentId, reason: resolved.dropReason ?? null, source: entry.modelPinSource ?? null, pinned: entry.model ?? null, from: entry.modelPinnedFrom ?? null, requested: requested ?? null,
        ...(entry.modelEffort !== undefined || requestedEffort !== undefined ? { pinnedEffort: entry.modelEffort ?? null, requestedEffort: requestedEffort ?? null } : {})
      });
      delete entry.model;
      delete entry.modelPinnedFrom;
      delete entry.modelPinSource;
      delete entry.modelEffort;
      delete entry.modelPinnedFromEffort;
    }
    this.modelObservedAt.delete(agentId);
    if (requested) entry.requestedModel = requested; else delete entry.requestedModel;
    if (launch) entry.launchModel = launch; else delete entry.launchModel;
    delete entry.liveModel;
    // M2: the effort side of the same record. A spawn that names no effort (a Claude or AGY agent,
    // an older caller) leaves no effort fields behind.
    if (requestedEffort) entry.requestedEffort = requestedEffort; else delete entry.requestedEffort;
    if (launchEffort) entry.launchEffort = launchEffort; else delete entry.launchEffort;
    const defaultEffort = normEffort(spawn.defaultEffort);
    if (defaultEffort) entry.defaultEffort = defaultEffort; else delete entry.defaultEffort;
    delete entry.liveEffort;
    entry.launchedAt = Date.now();
  }

  /**
   * AGENT-MODEL-NOT-KEPT M3: the Human says an 'auto' pin was theirs ("keep this model"). The pin
   * becomes a 'user' pin, so the next spawn keeps it (while the picker is unchanged). Returns
   * false when there is no auto pin to keep. Logged as `model-pin-kept`.
   */
  keepModelPin(agentId: string): boolean {
    const root = this.root();
    if (!root) return false;
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[agentId];
      if (!agent?.model || agent.modelPinSource !== 'auto') return false;
      agent.modelPinSource = 'user';
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'model-pin-kept', agentId, pinned: agent.model, effort: agent.modelEffort ?? null, requested: agent.requestedModel ?? null });
      return true;
    } catch { return false; }
  }

  /** M2: the reasoning effort a Codex agent gets when nothing is picked or pinned: the seed's
   *  top-level `model_reasoning_effort` (the user's ~/.codex/config.toml, read only). */
  codexSeedEffort(): string | undefined {
    try {
      const seed = join(homedir(), '.codex', 'config.toml');
      return existsSync(seed) ? normEffort(codexTopLevelString(readFileSync(seed, 'utf8'), CODEX_EFFORT_KEY)) : undefined;
    } catch { return undefined; }
  }

  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionId;
  }

  /** SESSION-PROMPT-ROTATION: the prompt fingerprint session `sessionId` was started with, or
   *  undefined (a session from before 1.1.76, or one never stamped). */
  sessionPromptStamp(agentId: string, sessionId: string): string | undefined {
    return this.registry().agents[agentId]?.sessionPrompts?.[sessionId];
  }

  /**
   * SESSION-PROMPT-ROTATION: the fingerprint of the NORMALISED prompt this agent gets now, and
   * its variant key (provider|mail mode|role), which selects the build-time 1.1.75 stamp for a
   * session recorded before stamps existed. The normalisation is the canonical render of
   * injectedPrompt; what it fixes is listed on CANONICAL_PROMPT (sessionRotation.ts).
   */
  sessionPromptFingerprint(meta: AgentMeta): { fp: string; variant: string; legacyBlock: 'mail-channel-override' | 'spawn-toggle-changed' | null } {
    const mailMode = this.promptMailMode(meta);
    const text = this.injectedPrompt(meta, '', '', false, false, undefined, { mailMode });
    // Creed R3: the build-time 1.1.75 stamp assumes the session was spawned with TODAY's variant.
    // A mail channel override, or god's spawn toggle away from its 1.1.75 default (off), may have
    // changed that since the 1.1.75 launch, so such a session is not legacy-stamped: it rotates.
    let override: unknown = null;
    try { override = this.mail.channelOverride(meta.id); } catch { override = null; }
    const legacyBlock = override ? 'mail-channel-override' as const
      : meta.isGod && this.orchestratorMaySpawn() ? 'spawn-toggle-changed' as const
      : null;
    return {
      legacyBlock,
      fp: canonicalPromptFingerprint(text),
      variant: promptVariant(meta.provider ?? 'claude', mailMode, meta.isGod ? (this.orchestratorMaySpawn() ? 'god+spawn' : 'god') : meta.isAssistant ? 'assistant' : 'worker')
    };
  }

  /** SESSION-PROMPT-ROTATION: stamp an UNSTAMPED session (a 1.1.75-era one, with the build-time
   *  1.1.75 fingerprint). Never overwrites a stamp. Returns whether it wrote. */
  stampSession(agentId: string, sessionId: string, fp: string): boolean {
    const root = this.root();
    if (!root || !sessionId || !fp) return false;
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionPrompts?.[sessionId]) return false;
      agent.sessionPrompts = withSessionStamp(agent.sessionPrompts, sessionId, fp);
      this.atomicWriteJson(join(root, 'registry.json'), reg);
      return true;
    } catch { return false; }
  }

  /** SESSION-PROMPT-ROTATION: note the prompt fingerprint of the process just spawned for
   *  `agentId`, and the session it resumed (null = fresh). A null fp forgets the note. */
  noteSpawnPrompt(agentId: string, fp: string | null, resumedSid: string | null): void {
    if (fp) this.spawnPrompt.set(agentId, { fp, resumedSid });
    else this.spawnPrompt.delete(agentId);
  }

  /** SESSION-PROMPT-ROTATION: a late hook from an old process may not bring `sessionId` back. */
  retireSession(agentId: string, sessionId: string): void {
    if (!sessionId) return;
    const set = this.retiredSessions.get(agentId) ?? new Set<string>();
    set.add(sessionId);
    this.retiredSessions.set(agentId, set);
  }

  /**
   * SESSION-PROMPT-ROTATION "Start fresh": drop the agent's resume key so its next spawn starts
   * a new conversation (the supported form of fresh-start-175.cjs `clear <id>`). Removes
   * sessionId, previousSessionId and sessionSource; keeps hookSessionIds (ownership) and the
   * stamps. The dropped ids are retired so a straggling hook cannot restore them. Identity,
   * memory.md, inbox and mail ledger are keyed by agent id and are untouched.
   */
  clearSession(agentId: string, reason: string): { ok: boolean; cleared: string[]; error?: string } {
    const root = this.root();
    if (!root) return { ok: false, cleared: [], error: 'The hive is not enabled.' };
    try {
      const reg = this.registryForMutation();
      const agent = reg.agents[agentId];
      if (!agent) return { ok: false, cleared: [], error: `Unknown agent: ${agentId}` };
      const cleared = [agent.sessionId, agent.previousSessionId].filter((s): s is string => typeof s === 'string' && !!s);
      for (const s of cleared) this.retireSession(agentId, s);
      const had = 'sessionId' in agent || 'previousSessionId' in agent || 'sessionSource' in agent;
      delete agent.sessionId;
      delete agent.previousSessionId;
      delete agent.sessionSource;
      if (had) this.atomicWriteJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'session-fresh', agentId, reason, cleared });
      return { ok: true, cleared };
    } catch (e) {
      return { ok: false, cleared: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The session id `lastSession` replaced, or undefined. The resume fallback when
   *  the last id has no transcript on disk (START-FIXES-163 (1)). */
  previousSession(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.previousSessionId;
  }

  /** The per-agent pinned model (a live in-TUI switch), if any. */
  lastModel(agentId: string): string | undefined {
    return this.registry().agents[agentId]?.model;
  }

  /** Claude Code settings that route every relevant hook through the shim, plus
   *  (W3) the default MCP bundle merged into this PER-SESSION settings file. cwd
   *  scopes the filesystem/git servers; cfg (the consent map) gates which servers
   *  are written. Claude-only — this is invoked solely on the Claude spawn path. */
  private hookSettings(shim: string, cwd: string, cfg: McpDefaultsMap, theme?: 'light' | 'dark', hookUrl: string | null = null, agentId?: string): unknown {
    // Bundled node, NOT bare `node` — see nodeLauncherPath(). Claude runs each of
    // these through `sh -c` with a stripped PATH, where `node` is often absent.
    // JOB-ENV (SessionStart): the agent id rides in the command itself, from this per-agent
    // file, because a background job's env can belong to another agent (hookShimArgs).
    const cmd = this.nodeRun(shim, ...hookShimArgs(agentId));
    const entry = (matcher?: string) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd }]
    });
    // HOOK-BROKER: with the broker up, a hook is a POST to the in-process HookServer (0
    // processes). SessionStart stays a command (Claude does not run HTTP hooks for it), and
    // so does the status line. An event is EITHER http OR command, never both. With no URL
    // this function's output is byte-identical to before.
    const hook = (matcher?: string) => hookUrl
      ? { ...(matcher ? { matcher } : {}), hooks: [{ type: 'http', url: hookUrl, timeout: HOOK_HTTP_TIMEOUT_S }] }
      : entry(matcher);
    // 1.1.53 AV R1: with the broker up (on Windows), the status line is a sourced builtins-only
    // script that POSTs to the broker: 0 processes per refresh instead of ~5 (incl. Electron as
    // Node). The status line cannot simply go: it is the only source of the subscription's
    // rate_limits (the capacity seam), the model and the exact context window.
    const statusParts = brokerUrlParts(hookUrl);
    const statusScript = statusParts ? this.writeClaudeStatusScript() : null;
    const statusCommand = statusParts && statusScript ? claudeStatusCommand(statusScript, statusParts) : `${cmd} --status`;
    const mcpServers = this.buildDefaultMcpServers(cwd, cfg);
    return {
      // Match the TUI's truecolor palette to the harness terminal theme —
      // PER SESSION, so the user's global Claude theme (their own terminals
      // outside the app) is never touched.
      //
      // 'auto', not the literal light/dark. Pinning the value matched the theme at
      // SPAWN and then ignored every change: Claude Code supports DEC 2031 theme
      // notifications, but a pinned theme has nothing to reconsider, so flipping
      // the app left a running agent painting its message blocks in the old
      // palette (black highlight on a cream terminal). 'auto' is the value that
      // listens. The terminal reports the current theme the moment the CLI enables
      // 2031, so startup still matches without pinning anything.
      ...(theme ? { theme: 'auto' } : {}),
      // JOB-ENV-IDENTITY: no agent view / background daemon for a hive agent (see the
      // CLAUDE_CODE_DISABLE_AGENT_VIEW spawn env; this is the settings form of the same switch).
      disableAgentView: true,
      // W3 — default skills/MCP bundle. Written into the PER-SESSION settings file
      // only (never ~/.claude), so the user's own MCP servers are never clobbered;
      // Claude merges this additively. Omitted entirely when empty so a settings
      // file with no enabled servers is unchanged from before.
      ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
      // The status line gets the session status JSON after every response —
      // including context_window.{total_input_tokens,context_window_size},
      // the only clean programmatic source for the session's REAL context
      // window. The shim prints a compact in-terminal gauge and forwards the
      // payload to the harness (agent-card context gauge, exact limit).
      statusLine: { type: 'command', command: statusCommand, padding: 0 },
      hooks: {
        Stop: [hook()],
        // ZT-I1-MAIL §11.4: an API error (rate_limit, overloaded, server_error, max_output_tokens)
        // ends the turn with StopFailure instead of Stop: the mail epoch closes as abnormal.
        StopFailure: [hook()],
        SubagentStop: [hook()],
        PreToolUse: [hook('*')],
        PostToolUse: [hook('*')],
        // HEAVY-JOB-SERIALIZE (Jim MF1): a FAILED tool call (e.g. a test suite exiting 1) fires
        // PostToolUseFailure, not PostToolUse; without it a heavy job's slot would never be freed
        // by its own call. (Claude Code 2.1.283 has this event.)
        PostToolUseFailure: [hook('*')],
        UserPromptSubmit: [hook()],
        Notification: [hook()],
        SessionStart: [entry()],
        // #5C: surface mid-`/compact` so an agent boxing up its context reads as
        // 'compacting' on the floor instead of looking frozen.
        PreCompact: [hook()],
        PostCompact: [hook()]
      }
    };
  }

  /**
   * W3 — build the per-agent `mcpServers` map from the default catalog. Includes a
   * server only when it's enabled (catalog ∩ consent), scopes filesystem/git to the
   * agent cwd (never whole-disk), and namespaces every id `munder-<id>` so a server
   * of the same name in the user's own ~/.claude is never clobbered. A write/secret
   * server is included ONLY on an explicit `enabled:true` consent — never via a
   * default — so a malformed/partial config can't silently arm a keyed server.
   */
  private buildDefaultMcpServers(
    cwd: string,
    cfg: McpDefaultsMap
  ): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
    const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
    for (const e of MCP_CATALOG) {
      const consented = cfg?.[e.id]?.enabled;
      const enabled = consented ?? e.defaultEnabled;
      if (!enabled) continue;
      // Defense-in-depth: a write/secret server requires an EXPLICIT opt-in; it can
      // never ride in on a default (the catalog already ships these OFF, but this
      // guards a hand-edited/partial mcpDefaults map too).
      if (e.tier !== 'safe-readonly' && consented !== true) continue;
      // Replace the `<cwd>` placeholder (filesystem/git) with the agent cwd at merge
      // time so these stay strictly workspace-scoped.
      const args = e.spec.args.map((a) => (a === '<cwd>' ? cwd : a));
      out[`munder-${e.id}`] = {
        command: e.spec.command,
        args,
        ...(e.spec.env ? { env: e.spec.env } : {})
      };
    }
    return out;
  }

  /**
   * W3 — refresh an agent's bundled skills from the app-resources `skills/` dir.
   * Mirrors `identity.md`: overwritten every spawn so the shipped safe set tracks
   * the app. Best-effort and fully tolerant — a missing/empty source dir is a no-op
   * (Kevin populates the resource dir in lp-manifest), and any IO error is swallowed
   * so skill provisioning can never block a spawn.
   */
  private copyBundledSkills(srcDir: string, destDir: string): void {
    try {
      if (!existsSync(srcDir)) return;
      const copyTree = (from: string, to: string): void => {
        const entries = readdirSync(from, { withFileTypes: true });
        if (!entries.length) return;
        mkdirSync(to, { recursive: true });
        for (const ent of entries) {
          const s = join(from, ent.name);
          const d = join(to, ent.name);
          if (ent.isDirectory()) copyTree(s, d);
          else if (ent.isFile()) copyFileSync(s, d);
        }
      };
      copyTree(srcDir, destDir);
    } catch (e) { console.error('[hive] copyBundledSkills failed:', e); }
  }

  /**
   * W1 — start a proxy-bridge sidecar for a hookless proxy-tier agent (qwen).
   * Spawns `<root>/bin/hive-proxy.cjs` under Node, which binds a loopback port and
   * reports it back as a one-line `{"port":N}` on stdout. Resolves the bound port
   * (or 0 on failure, so the caller degrades gracefully without redirecting the
   * CLI). Idempotent: any prior sidecar for the agent is killed first, so a respawn
   * never leaks a listener. Tracked in `proxyChildren` for teardown.
   */
  private startProxyBridge(
    agentId: string,
    cfg: { sock: string; sessionId: string; api: 'openai' | 'anthropic'; upstream: string }
  ): Promise<number> {
    this.stopProxyBridge(agentId);
    const script = this.proxyShimPath();
    if (!script) return Promise.resolve(0);
    return new Promise<number>((resolve) => {
      let settled = false;
      const settle = (port: number): void => { if (!settled) { settled = true; resolve(port); } };
      let child: ChildProcess;
      try {
        child = spawn(process.execPath, [script], {
          env: {
            ...process.env,
            // Run the .cjs under Electron's bundled Node, not as a second app window.
            ELECTRON_RUN_AS_NODE: '1',
            HIVE_SOCK: cfg.sock,
            AGENT_ID: agentId,
            UPSTREAM_BASE_URL: cfg.upstream,
            HIVE_PROXY_SESSION: cfg.sessionId,
            HIVE_PROXY_API: cfg.api
          },
          // Read the port line from stdout; never inherit stdio (the sidecar must
          // never write into the agent's terminal or leak request bodies to a log).
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch (e) {
        console.error(`[hive] startProxyBridge spawn failed for ${agentId}:`, e);
        return settle(0);
      }
      this.proxyChildren.set(agentId, child);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (settled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          if (typeof msg.port === 'number' && msg.port > 0) settle(msg.port);
          else settle(0);
        } catch { settle(0); }
      });
      child.on('error', () => settle(0));
      child.on('exit', () => {
        if (this.proxyChildren.get(agentId) === child) this.proxyChildren.delete(agentId);
        settle(0); // never hang the spawn if the sidecar dies before reporting
      });
      // Hard ceiling: if the sidecar never reports a port, degrade rather than hang.
      setTimeout(() => settle(0), 4000).unref?.();
    });
  }

  /** Kill the proxy sidecar for an agent, if any. Idempotent; never throws. */
  stopProxyBridge(agentId: string): void {
    const child = this.proxyChildren.get(agentId);
    if (!child) return;
    this.proxyChildren.delete(agentId);
    try { child.kill(); } catch { /* already gone */ }
  }

  /** Kill every live proxy sidecar (app quit). Best-effort. */
  stopAllProxyBridges(): void {
    for (const id of [...this.proxyChildren.keys()]) this.stopProxyBridge(id);
  }

  // ZT-I1-MAIL §3 / P11: the Stop-hook drain (`drainForStop`, its cursor.json and drainLines) is
  // DELETED. It was dead since the Stop reply became non-blocking, and 1.1.75 delivers mail in hook
  // context with the harness marking it acted at Stop. Pinned gone (inbox-wake-pins, mail-prompts).

  // — agent-facing text —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (god)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- You are the **god / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.' : '',
      meta.isGod ? '- Monitor the team with `fleet.json` (live per-agent status/tokens/cost/breaker) and `registry.json`; full command reference in `COMMANDS.md`. `claude agents` does NOT list your hive siblings.' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  /**
   * The system-prompt prefix injected into every spawn via --append-system-prompt.
   *
   * 🔒 PROMPT-CACHE INVARIANT — keep this prefix VOLATILE-FREE. It interpolates
   * only values stable for an agent's whole lifetime (name, id, dir, root,
   * semanticMemory). Do NOT add dates, UUIDs, counters, board/registry state, or
   * any `Date.now()`-derived text here: a prefix that changes per spawn defeats
   * Anthropic's prompt cache (re-priming the whole system prompt every turn).
   * Volatile context belongs on the live channels — the inbox (hive messages) and
   * the PTY — never baked into this prefix. (Lane A #6.1.)
   *
   * 🪟 NO SHELL SYNTAX. Every path and command here is written the way the AGENT
   * will actually type it, on the platform it is running on. That rules out two
   * habits that were silently Windows-only breakage:
   *  - `$VAR` — POSIX-only. Under cmd.exe `$HIVE_NODE`/`$KG_CLI` expand to nothing
   *    and under PowerShell to an undefined variable, so those instructions were
   *    dead on every Windows floor. Bake the ABSOLUTE resolved path instead: it is
   *    platform-independent, needs no expansion, and stays prompt-cache-stable.
   *  - `'…' + '/inbox/'` — string-concatenating separators told a Windows agent to
   *    read `C:\Users\x\hive\agents\god/inbox/`. Use join() so the agent's own
   *    tooling gets a path it can pass straight to its shell.
   */
  /**
   * ZT-I1-MAIL §5 / §11.7: the mail mode the agent's prompt text follows, from its provider and
   * its ledger's channel override (§11.10). Read at spawn, so a degraded agent gets its legacy
   * text on its next spawn (the prompt stays stable for the life of a session). An unreadable
   * ledger means no override.
   */
  private promptMailMode(meta: AgentMeta): MailPromptMode {
    let override = null;
    try { override = this.mail.channelOverride(meta.id); } catch { override = null; }
    return mailPromptMode(mailChannelMode(normalizeAgentProvider(meta.provider), override), override);
  }

  private injectedPrompt(
    meta: AgentMeta,
    dir: string,
    root: string,
    semanticMemory: boolean,
    knowledgeGraph: boolean,
    kgCliPath?: string,
    canonical?: { mailMode: MailPromptMode }
  ): string {
    // SESSION-PROMPT-ROTATION: the mail mode is read with the REAL id (the ledger is per agent).
    // A CANONICAL render (the rotation fingerprint's input, see sessionPromptFingerprint) fixes
    // every volatile or per-agent input: memory on, KG off, no RUNNING BUILD line, and
    // placeholders for name, id, workspace, hive root and the node path.
    const mailMode = canonical ? canonical.mailMode : this.promptMailMode(meta);
    if (canonical) {
      meta = { ...meta, name: CANONICAL_PROMPT.name, id: CANONICAL_PROMPT.id };
      dir = CANONICAL_PROMPT.agentDir;
      root = CANONICAL_PROMPT.hiveRoot;
      semanticMemory = true;
      knowledgeGraph = false;
      kgCliPath = undefined;
    }
    // Native-separator path helpers — see the 🪟 note above.
    const inDir = (...parts: string[]): string => join(dir, ...parts);
    const inRoot = (...parts: string[]): string => join(root, ...parts);
    const ctxLine = 'LIVE CONTEXT: each agent row in the LIVE ROSTER carries a `ctx NN%` tag — its live context-window occupancy. Treat it as the real headroom signal when routing: prefer an agent with a LOW `ctx` for a big task; treat a HIGH `ctx` (near 100%) as busy rather than idle, even if the cumulative token count looks modest.';

    // `semanticMemory` is true only when the spawn really put the app's `memory` command first
    // on the agent's PATH (Jim M2), so this line never names a command the agent cannot run.
    const memoryLine = semanticMemory
      ? 'Semantic memory: the whole hive shares a searchable memory (the built-in memory engine). To recall relevant past knowledge across the team, run `memory search "<query>"`; run `memory wake-up` at the start of a task for a memory digest. Your notes in memory.md are indexed automatically — write durable facts there.'
      : '';
    // Enterprise Knowledge Graph (opt-in). Volatile-free: the bundled-node launcher
    // and the KG CLI are both fixed absolute paths for an install, so baking them
    // keeps the prefix prompt-cache-stable while making the command runnable in
    // cmd.exe/PowerShell as well as a POSIX shell.
    const hiveNode = canonical ? CANONICAL_PROMPT.node : this.nodeCommand();
    const kgCli = kgCliPath || (process.platform === 'win32' ? '%KG_CLI%' : '$KG_CLI');
    const knowledgeLine = knowledgeGraph
      ? `Enterprise knowledge: this organisation has a private Knowledge Graph of its own documents, policies, and business context. When a task needs that context — company-specific facts, house style, internal processes — query it instead of guessing: run \`"${hiveNode}" "${kgCli}" search "<query>"\` for ranked passages, \`"${hiveNode}" "${kgCli}" list\` to see what is available, and \`"${hiveNode}" "${kgCli}" get <id>\` for a full document. (That first path is the harness's bundled Node — use it instead of bare \`node\`, which may not be on your PATH.)`
      : '';
    // Item 13: state the build. Agents had no way to tell which version, or even
    // which KIND of build, they were running inside, so anything that varies
    // between a packaged app and a local dev run (umask being the one that bit
    // us) was invisible to every investigation.
    const rt = canonical ? null : this.runtimeInfo();
    const runtimeLine = rt
      ? `RUNNING BUILD: Munder Difflin v${rt.version}, ${rt.packaged ? 'packaged app' : 'local dev build'}${rt.appPath ? `, from ${rt.appPath}` : ''}. Say this version if asked which one is running, and do not assume behaviour from an older one. A local dev build inherits the launching shell's environment (umask included) where a packaged app does not, so file modes and inherited env can legitimately differ between the two. \`log.jsonl\` records an \`app-start\` event on every launch, which is how you spot a restart or a build switch (it rotates at 8 MB: search \`log*.jsonl\` for older rows).`
      : '';
    // Item 11: god could not find the spawn queue. The mechanism has worked since
    // v0.4.4, but nothing told him it existed — the prompt said "spawn" without
    // saying how, COMMANDS.md and PROTOCOL.md did not mention it, and the only
    // description lived in a source comment. So he fell back to writing a hire
    // manifest, which needs a human to click confirm, and it looked like nothing
    // happened. Gated on the toggle: advertising a disabled path is worse than
    // saying nothing, and COMMANDS.md documents it either way for the case where
    // the operator turns it on after god was already running.
    const spawnQueueLine = meta.isGod && this.orchestratorMaySpawn()
      ? `SPAWNING A WORKER: you can start an ephemeral worker yourself by writing ONE JSON file into ${inRoot('spawn-requests')}/<id>.json. Required: \`objective\` (what the worker must do) and \`cwd\` (the repo it runs in). Optional: \`name\`, \`command\`, \`provider\`, \`model\`, \`isolate\` (default true = its own git worktree), \`tokenCap\`, and \`slack\` ({channel, thread_ts}) to route its failures back to a thread. The harness polls that directory, spawns \`worker-<id>\`, and moves the request to \`spawn-requests/.done/\` on success or \`.failed/\` with a reason. This is the ONLY way you can spawn; a hire manifest under research/hires/ needs the human to confirm it in the UI, so it is not a route you can complete on your own. Reuse an existing agent first, as above — a worker is a fresh spend every time.`
      : '';
    const godLine = meta.isGod
      ? 'You are the GOD / ORCHESTRATOR of this hive — your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS — always know what is going on: keep an accurate picture of every agent (active vs archived/idle), the task board, and all in-flight work; handle the mail delivered to you and triage every other agent\'s requests, answering clarifications so the team runs autonomously. (2) DELEGATE — decompose work and fan it out to the hive agents via their inboxes (route messages and assign owners; do not do their jobs); do NOT take on grunt implementation yourself. Stay aware of who is already on the floor and delegate OPPORTUNISTICALLY: BEFORE you spawn anything, CHECK THE LIVE ROSTER (active agents in registry.json + their state in fleet.json) and prefer routing to an EXISTING agent that fits — above all when the request names one ("ask Pam to…", "have Jim…"), route to that agent instead of reflexively creating a new one. Reuse an idle or already-running agent whose role matches; only spawn a fresh agent when no existing one is a sensible fit, and say that you checked. One capable owner beats a duplicate. (3) OWN ONLY THE IMPORTANT, high-leverage things — task decomposition, dispatch decisions, sign-offs, conflict resolution, branch integration, and final QA — and remain the sole scribe of board.md. You are otherwise fully autonomous — there is NO separate approval queue. For the genuinely critical (destructive actions, spending real money, scope changes, unresolvable conflicts), ask the human directly in your own session and let the tool-permission prompt gate the action; the human approves natively, including remotely from their phone via /remote-control. Keep the team unblocked. When you DISPATCH a task, write it as a 4-part contract so the agent can run autonomously: (1) OBJECTIVE — the concrete goal; (2) OUTPUT — the expected deliverable/format; (3) TOOLS — what to use or avoid, and any references to read instead of re-deriving; (4) BOUNDARIES — scope limits + the definition of done. Pass references (file paths, message ids, board sections), not pasted content — keep dispatches short.'
        + ` The harness keeps ${inRoot('board-status.md')} and ${inRoot('floor-digest.md')} current (in-flight work and its age, blocked and ask-me cards, stale and archived-assignee flags, the roster) and wakes you with a "Floor: N decision(s)" message only when it needs a decision: act on those, and do not poll for stalled agents. For detail read ${inRoot('fleet.json')} (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) and ${inRoot('registry.json')} — note that running 'claude agents' will NOT list your hive's sibling agents. A full Claude Code command reference is at ${inRoot('COMMANDS.md')} (slash commands act ONLY on your own session; CLI commands run in your shell and can target the fleet). The harness stamps each card's status age itself (state/task-meta.json), moves a doing card back to todo when its assignee is explicitly archived (assignee kept, a line in its notes), reminds you once of a blocked card whose human answer is waiting (set "parked": true on a card you are deliberately holding; on a card whose fix has shipped but is not installed yet, set "waitingFor": "install" and "fixVersion": "<x.y.z>": it is never flagged stale while it waits, and the digest tells you once when that version is running, so you can verify and close it), and refuses an API write that would add a duplicate id; you keep board.md's narrative and the cards' content accurate. In tasks.json, ALWAYS set each task's "assignee" to the worker's agent id the moment you dispatch it, and NEVER clear it on status changes — a done card must still say who did the work (the human reads the board by who-did-what). HUMAN FEEDBACK is first-class in the ledger: when a task can only proceed with the human's input — a QUESTION to answer OR an ACTION only the human can perform (create an account, approve a purchase, provide credentials/screenshots, test on their device) — set its status to "blocked" and append the concrete ask to the card's "humanQA" array (push {"q":"...","askedAt":"<iso>"}; write q as a short first-line headline, then a body with blank-line paragraphs and "- " bullets (markdown: **bold**, inline code, https links); when the human should pick between concrete choices add "options":[{"label":"...","detail":"..."}] (plus optional "recommended":<index> and "multi":true) — the ASK ME card shows them as buttons and still accepts a free-text note; phrase actions as clear to-dos; keep every past entry — the history documents the card's decisions). The harness surfaces open questions on the office floor's ASK ME board; the human's answer lands in the same entry ("a") AND arrives as a hive message to you — act on it and unblock the card so work continues. Do NOT park human questions in separate files (no HumanQuestion.md) and never sit waiting on the human in your own session. Steward the token budget.`
      : meta.isAssistant
      ? 'You are Michael\'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in Michael\'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that Michael can execute autonomously, preserving the user\'s original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to Michael.'
      : 'For anything ambiguous, cross-cutting, or needing sign-off, address a message to "god".';
    const guardrailsLine = 'Guardrails: a circuit breaker watches the floor — a "Circuit breaker: steer/constrain" message means you are looping or overspending, so STOP repeating, summarize what you tried, and follow it. Be token-frugal (a floor-wide or per-agent token budget can pause you). The shared plan has two parts: board.md (freeform; god is the sole scribe) and tasks.json (structured kanban — todo/doing/blocked/done).';
    const slackLine = meta.isGod
      ? 'SLACK REPLIES: When composing a Slack reply (or writing the `result` field of a Slack-origin kanban card), you MUST: (1) directly address what the user asked — never a bare "done"; (2) include the relevant specifics, outcome, and details; (3) format for Slack mrkdwn — open with a short *bold* headline, use bullet points for multiple items, wrap code/paths in `backtick` blocks, keep it concise (no walls of text). When finishing a Slack-origin task, always write a complete, user-facing, well-formatted `result` on the kanban card — the system posts it verbatim to Slack as the done reply.'
      : `SLACK REPLIES: If god dispatches you a task that came from Slack, it will include an exact \`"${hiveNode}" "<helper>" --channel … --thread … --text "…"\` reply command — when you finish, run it VERBATIM to post your result back to that thread yourself. The reply must be SUBSTANTIVE Slack mrkdwn (a short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done".`;
    return [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating hive of Claude agents.`,
      `Your private workspace is ${dir}. The shared hive is ${root}. Full protocol: ${inRoot('PROTOCOL.md')}.`,
      '',
      'HIVE PROTOCOL — follow it every task:',
      // CODEX-BLOAT-165 fix 3: never "read memory.md" whole at every task start (it was 86K chars
      // for one agent, re-sent on every later request of the job). The digest, or its tail.
      // PINNED-MEMORY: but first the standing method lessons, which the rollover never archives.
      // ZT-I1-MAIL §5 P1 (+ §11.12(c)): the mail sentence follows the agent's mail mode (§11.7).
      protocolLineOne(mailMode, semanticMemory, inDir('memory.md'), inDir('inbox'), inDir('inbox', '.done')),
      `2. Record durable facts, decisions, and context by appending to ${inDir('memory.md')}. Put METHOD lessons (how you work: sources, verification, tools, safety rules) in its \`## How I work (standing lessons)\` section instead, as bullets or \`###\` subheadings only (a \`##\` heading ends that section and what follows it gets archived); keep that section under ~6 KB, merging and shortening lessons when it grows.`,
      `3. To ask another agent for something or share information, write ONE message JSON into ${inDir('outbox')} (schema in PROTOCOL.md). NEVER write into another agent's folder — the orchestrator delivers your outbox. To update a card, send a message and note memory in ONE call, use the \`ledger\` command (PROTOCOL.md "The ledger command"); it takes JSON from a file or stdin, never in shell arguments.`,
      '4. At the END of a task, record what you learned in memory.md so future-you remembers: METHOD lessons in its `## How I work (standing lessons)` section, facts and decisions appended at the end as before.',
      guardrailsLine,
      // CODEX-BLOAT-165 fix 7: Codex keeps every tool output in the thread and re-sends it on
      // every later request (81% of Dwight's tool-output text came from outputs over 10K chars).
      meta.provider === 'codex' ? CODEX_OUTPUT_HYGIENE_LINE : '',
      meta.provider === 'codex'
        ? (mailMode === 'inject'
          ? 'Codex mail wake: the automatic inbox-check prompt is a wake sentinel. Its hook delivers your new mail into this turn as a <hive-mail> block; handle it from there.'
          : 'Codex inbox wake: the automatic inbox-check prompt is a wake sentinel. Its hook supplies current inbox facts; read your authoritative inbox and handle its current messages.')
        : '',
      memoryLine,
      knowledgeLine,
      godLine,
      spawnQueueLine,
      runtimeLine,
      slackLine,
      ctxLine,
      `Env vars available to you: AGENT_ID, AGENT_NAME, HIVE_ROOT, AGENT_DIR.`
    ].filter(Boolean).join('\n');
  }

  // — messaging —

  /** Normalize a partial message into a full HiveMessage. */
  private normalize(partial: Partial<HiveMessage>, from: string): HiveMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      hops: typeof partial.hops === 'number' ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString(),
      ...normalizeSupersedes(partial.supersedes),
      ...normalizeWakeField(partial.wake)
    };
  }

  /**
   * MIDTURN-MAIL-BLIND L2: the message still UNREAD by the SENDER that supersedes the one `msg`
   * answers, if any. The case it catches: A asks B for X; B starts working; A sends "cancel X"
   * (supersedes: [X]); B, mid-turn, never sees it and sends its result for X. A superseding
   * message B has already seen is not a match: then the reply was sent knowingly.
   *
   * ZT-I1-MAIL §3 #5: "unread" is read from B's LEDGER, not from file position (the harness now
   * moves files itself, at Stop): the superseding message is still `delivered` there, i.e. never
   * surfaced into B's context. For a legacy-move agent (cursor, §11.7) its own move into .done
   * still means it read the message, so the file must also still be in inbox/. No file is parsed
   * on the routing path: the ledger entry carries id, from, subject and supersedes.
   */
  private unreadSupersederFor(msg: HiveMessage): HiveMessage | null {
    if (!msg.in_reply_to) return null;
    // N3 (Jim): the reply's in_reply_to AND up to 3 of its ancestors, so a cancel of the ORIGINAL
    // dispatch also flags a reply to a request derived from it. An ancestor is found hive-wide by
    // its file name (<id>.json in some agent's inbox or inbox/.done): stats only, no parsing.
    // ZT-I1-MAIL §4.1: in_reply_to resolves against the ledger id AND the sender_id alias (a
    // reassigned id), in the ledger of the agent replying.
    const targets = new Set<string>([msg.in_reply_to]);
    try { for (const a of this.mail.aliases(msg.from, msg.in_reply_to)) targets.add(a); } catch { /* not an agent */ }
    let cur: string | null = msg.in_reply_to;
    for (let hop = 0; hop < HiveManager.SUPERSEDE_ANCESTOR_HOPS && cur; hop++) {
      const parent: string | null = this.findDeliveredMessage(cur)?.in_reply_to ?? null;
      if (!parent || targets.has(parent)) break;
      targets.add(parent);
      cur = parent;
    }
    let unread: ReturnType<MailLedger['pending']>;
    try { unread = this.mail.pending(msg.from); } catch { return null; }
    const inbox = join(this.agentDir(msg.from), 'inbox');
    // N4 (Jim), kept: the newest 50 unread messages (arrival order, never id order).
    for (const e of unread.slice(-HiveManager.SUPERSEDE_SCAN_MAX_FILES).reverse()) {
      if (!e.supersedes?.some((s) => targets.has(s))) continue;
      if (e.via !== 'inbox' || !existsSync(join(inbox, `${e.id}.json`))) continue;
      return { id: e.id, from: e.from, subject: e.subject, supersedes: e.supersedes } as unknown as HiveMessage;
    }
    return null;
  }

  static readonly SUPERSEDE_ANCESTOR_HOPS = 3;
  static readonly SUPERSEDE_SCAN_MAX_FILES = 50;
  /** The bound on the ancestor lookup's parse (findDeliveredMessage). */
  static readonly SUPERSEDE_SCAN_MAX_BYTES = 64 * 1024;

  /** A delivered message by id: <id>.json in any agent's inbox or inbox/.done, or null. */
  private findDeliveredMessage(id: string): Partial<HiveMessage> | null {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) return null;
    const root = this.root();
    if (!root) return null;
    let agents: string[] = [];
    try { agents = readdirSync(join(root, 'agents')); } catch { return null; }
    for (const a of agents) {
      for (const p of [join(root, 'agents', a, 'inbox', `${id}.json`), join(root, 'agents', a, 'inbox', '.done', `${id}.json`)]) {
        try {
          if (!existsSync(p) || statSync(p).size > HiveManager.SUPERSEDE_SCAN_MAX_BYTES) continue;
          return JSON.parse(readFileSync(p, 'utf8')) as Partial<HiveMessage>;
        } catch { /* unreadable: keep looking */ }
      }
    }
    return null;
  }

  /** Atomically deliver a message into a recipient agent's inbox.
   *  Returns false when the recipient has no inbox, so the caller can bounce and
   *  log the drop rather than let the message vanish. */
  private deliver(original: HiveMessage, toId: string): boolean {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return false; // unknown recipient — the caller reports it
    // ZT-I1-MAIL §4.1: admission against the recipient's ledger, inbox/ and .done/. A duplicate
    // (same from, same body) was already delivered: dropped idempotently. An invalid or colliding
    // id gets a fresh one for THIS copy, the sender's value kept as sender_id.
    let msg = original;
    try {
      const admitted = this.mail.admit(toId, msg);
      if (admitted.duplicate) return true;
      msg = admitted.msg as HiveMessage;
    } catch (e) {
      try { this.appendLog({ kind: 'mail-ledger-error', agentId: toId, id: msg.id, op: 'admit', error: String(e) }); } catch { /* noop */ }
      if (!isValidMailId(msg.id)) msg = { ...msg, id: freshMailId(), sender_id: msg.sender_id ?? String(msg.id).slice(0, 200) };
    }
    // Nothing is ever written outside the inbox: a valid id cannot leave it, and this re-checks.
    const file = join(inbox, `${msg.id}.json`);
    if (!isValidMailId(msg.id) || dirname(file) !== inbox) throw new Error(`refusing to deliver outside ${toId}'s inbox`);
    this.atomicWriteJson(file, msg);
    try { this.mail.markDelivered(toId, msg); } catch (e) {
      try { this.appendLog({ kind: 'mail-ledger-error', agentId: toId, id: msg.id, op: 'delivered', error: String(e) }); } catch { /* noop */ }
    }
    // THE successful-delivery edge (pre-M1 event-wake bridge): only after the durable write.
    // An observer failure can never turn a written delivery into a routing failure.
    // DIAGNOSIS ONLY (diag-1.1.46-wake): a durable write with NO observer registered is the
    // one failure the message log cannot show - it looks identical to a delivered message.
    if (!this.deliveryObserver) {
      try { this.appendLog({ kind: 'wake', stage: 'observer-missing', agentId: toId, messageId: msg.id }); } catch { /* noop */ }
    }
    try { this.deliveryObserver?.({ agentId: toId, messageId: msg.id }); } catch (e) {
      try { this.appendLog({ kind: 'wake', stage: 'observer-threw', agentId: toId, error: String(e) }); } catch { /* noop */ }
    }
    return true;
  }

  private deliveryObserver: ((delivery: InboxDelivery) => void) | null = null;
  private readonly provisionedListeners = new Set<(agentId: string) => void>();
  /** ZERO-TOKEN-LIVENESS (Dwight F2): told after the registry's archived flag CHANGED (an archive by
   *  any path: teardown, IPC, a realtime action, the boot orphan sweep; a restore by setArchived or a
   *  respawn). Observation only; a listener never breaks the write. */
  private readonly archiveListeners = new Set<(agentId: string, archived: boolean) => void>();
  onArchiveChange(cb: (agentId: string, archived: boolean) => void): () => void {
    this.archiveListeners.add(cb);
    return () => { this.archiveListeners.delete(cb); };
  }
  private emitArchiveChange(agentId: string, archived: boolean): void {
    for (const cb of [...this.archiveListeners]) { try { cb(agentId, archived); } catch { /* a listener never breaks the write */ } }
  }
  /** Called with the agent id each time ensureAgent (every spawn, respawn and relaunch) has
   *  written its registry entry. Returns the unsubscribe. */
  onAgentProvisioned(cb: (agentId: string) => void): () => void {
    this.provisionedListeners.add(cb);
    return () => { this.provisionedListeners.delete(cb); };
  }
  /** Observe every durable inbox write, after it lands (direct and bounced to god alike).
   *  Never fires for a missing inbox or a terminal handoff. Separate from
   *  `setRoutedObserver`, whose targets are routing INTENT, not proof of a write. */
  setDeliveryObserver(cb: ((delivery: InboxDelivery) => void) | null): void {
    this.deliveryObserver = cb;
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). */
  send(partial: Partial<HiveMessage>, from = 'system'): HiveMessage {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    return msg;
  }

  private routeMessage(msg: HiveMessage): void {
    // The router alone sets superseded_by: a sender cannot pre-mark its own mail.
    delete msg.superseded_by;
    // ZT-I1-MAIL §4.1: ...and sender_id. An id that is not filename-safe (traversal, overlong,
    // reserved) is replaced for every recipient alike before anything is written.
    delete msg.sender_id;
    if (!isValidMailId(msg.id)) {
      const senderId = (typeof msg.id === 'string' ? msg.id : JSON.stringify(msg.id) ?? String(msg.id)).slice(0, 200);
      msg.id = freshMailId();
      msg.sender_id = senderId;
      try { this.appendLog({ kind: 'mail-id-reassigned', from: msg.from, senderId, id: msg.id, reason: 'invalid' }); } catch { /* noop */ }
    }
    // MIDTURN-MAIL-BLIND L2: a reply to a request that was cancelled or corrected while its
    // sender was mid-turn is still DELIVERED (its content may still matter), but flagged in the
    // subject and the superseded_by field, so the requester sees at once it answers a superseded
    // ask. The sender is told by the superseding message itself, already unread in its inbox.
    const sup = this.unreadSupersederFor(msg);
    if (sup) {
      msg.superseded_by = sup.id;
      // N2 (Jim): the quoted parts are sender-controlled: escape < and > (agents may read the
      // subject inside tagged context).
      const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      msg.subject = `[superseded by ${esc(sup.id)} (${esc(String(sup.from))}: ${esc(String(sup.subject ?? '').slice(0, 80))}): sent before ${msg.from} read it] ${msg.subject}`;
      try { this.appendLog({ kind: 'superseded-delivery', id: msg.id, from: msg.from, to: msg.to, inReplyTo: msg.in_reply_to, supersededBy: sup.id }); } catch { /* noop */ }
    }
    if (msg.hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    // ZT-I1-MAIL §4.3 + §11.13(B): a reply from an agent closes the reply/outcome obligation it
    // answers in that agent's ledger (id or sender_id alias). Zero-token: tracking only, no wake.
    if (msg.in_reply_to) {
      try { this.mail.markReplied(msg.from, msg.in_reply_to, msg.id, resolveTo(msg.to)); } catch (e) {
        try { this.appendLog({ kind: 'mail-ledger-error', agentId: msg.from, id: msg.id, op: 'replied', error: String(e) }); } catch { /* noop */ }
      }
    }
    const targets = msg.to === 'broadcast'
      // The roster for fan-out is the ACTIVE registry: skip the send-only prep
      // assistant and any archived agent (closed tab). Hookless providers are
      // NOT skipped — the per-target path below already serves them a terminal
      // work order, so excluding them here only made a broadcast invisible to an
      // agent that direct mail reaches fine. See selectBroadcastTargets.
      ? selectBroadcastTargets(reg.agents, msg.from)
      // Never deliver to self — guards a god → "human" message looping back to god.
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    // ZT-I1-MAIL §11.18 #6 (god's ruling): a direct `to` must be EXACTLY a registry agent id,
    // checked here, before anything turns it into a path. 'broadcast', 'god' and 'human' keep
    // their routing meaning; everything else is an agent id or nothing (no path semantics).
    const direct = msg.to !== 'broadcast' && msg.to !== 'god' && msg.to !== 'human';
    const knownAgent = (id: unknown): boolean => typeof id === 'string' && Object.prototype.hasOwnProperty.call(reg.agents, id);
    // Targets that actually took delivery. The log below reports these instead of
    // intent, so a bounced or dropped message can never read as delivered.
    const delivered: string[] = [];
    for (const t of targets) {
      if (direct && !knownAgent(t)) {
        // Unknown id: the no-inbox bounce (#24), without resolving it to any directory.
        this.appendLog({ kind: 'drop', reason: 'no-inbox', from: msg.from, to: t, id: msg.id });
        if (t !== godId) {
          this.deliver({
            ...msg,
            to: godId,
            subject: `[undeliverable — no agent "${t}" on this floor; check the id against the roster] ${msg.subject}`
          }, godId);
        }
        continue;
      }
      // Q32 (god 7048a1 + 0f1672): only an EXPLICIT archive bounces. An agent the boot sweep
      // archived ('orphan') or whose process died on its own ('pty-exit') keeps receiving mail:
      // delivered now, surfaced when it is restored (e.g. mail in the seconds before a tab restore).
      if (direct && archivedForMail(reg.agents[t])) {
        // §4.2: mail to an archived agent bounces to the SENDER, who is best placed to re-route.
        // A sender that is archived, not an agent (the router, 'system', 'human') or the send-only
        // assistant gets the existing no-inbox rule instead: the bounce goes to god.
        const notice = `[undeliverable: ${t} is archived — resend to an active agent or god]`;
        const sender = reg.agents[msg.from];
        const toSender = knownAgent(msg.from) && !archivedForMail(sender) && !sender?.isAssistant;
        const bouncedTo = toSender ? msg.from : godId;
        this.appendLog({ kind: 'drop', reason: 'archived', from: msg.from, to: t, id: msg.id, bouncedTo });
        if (toSender) {
          // A `system` notice carrying the original subject and body, so the sender can resend.
          // Not a request of its own (no reply obligation) and not a reply to anything.
          this.deliver({
            ...msg, from: 'system', to: msg.from, act: 'inform', requires_reply: false, in_reply_to: null,
            supersedes: undefined, superseded_by: undefined, subject: `${notice} ${msg.subject}`
          }, msg.from);
        } else {
          this.deliver({ ...msg, to: godId, subject: `${notice} ${msg.subject}` }, godId);
        }
        continue;
      }
      // The send-only prep assistant must never be a delivery target: it doesn't
      // drain an inbox, so direct mail to it would rot unread (observed live: a
      // task brief plus the follow-up reprimand about the unread inbox, both
      // unread for hours). Bounce such mail to god instead, so the sender's intent
      // surfaces immediately and nothing is silently lost.
      if (reg.agents[t]?.isAssistant) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`
        }, godId);
        continue;
      }
      // A provider without safe-idle lifecycle state (a hookless custom command)
      // would let direct mail rot unread. Claude and bridged Antigravity/Codex
      // receive directly into inbox/ for guarded renderer delivery. Otherwise try
      // a terminal work-order handoff to its REPL (#53);
      // if the renderer is unavailable, bounce to god to relay. God is exempt
      // (the bounce target).
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.deliver({
            ...msg,
            to: godId,
            subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a hookless CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`
          }, godId);
        } else delivered.push(t);
        continue;
      }
      // 1d — proxy-tier providers (qwen) CAN receive inbox, but only via a
      // SYNTHESIZED Stop, which just advances the cursor — the sidecar observes the
      // CLI's stream and can't inject a drain reason back into its turn. So the real
      // mail rides the terminal work-order path verbatim, exactly like a hookless
      // provider; the synthesized Stop→drain keeps the cursor in step.
      const proxyDesc = bridgeOf(reg.agents[t]?.provider);
      if (t !== godId && proxyDesc?.kind === 'proxy' && proxyDesc.inboxDelivery === 'terminal') {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.deliver({
            ...msg,
            to: godId,
            subject: `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? 'a proxy-tier CLI'} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`
          }, godId);
        } else delivered.push(t);
        continue;
      }
      if (this.deliver(msg, t)) { delivered.push(t); continue; }
      // No agents/<t>/inbox — an id that isn't on the floor. This was the one
      // delivery failure with neither bounce nor log, so the sender saw a routed
      // message and the mail simply ceased to exist. Record the drop beside the
      // hop-cap one and bounce to god, mirroring the undeliverable bounces above.
      this.appendLog({ kind: 'drop', reason: 'no-inbox', from: msg.from, to: t, id: msg.id });
      if (t !== godId) {
        this.deliver({
          ...msg,
          to: godId,
          subject: `[undeliverable — no agent "${t}" on this floor; check the id against the roster] ${msg.subject}`
        }, godId);
      }
    }
    this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id, delivered });
    this.emitMessage(msg, targets);
    // Main-process observer (e.g. the closing-time controller watching for the
    // team's ACKs and the god's COMPLETE). Best-effort, never breaks routing.
    try { this.routedObserver?.(msg, targets); } catch { /* observer error */ }
  }

  /** Observer invoked for EVERY routed message with its resolved targets.
   *  Used by main-process features that react to hive traffic (closing time). */
  private routedObserver: ((msg: HiveMessage, targets: string[]) => void) | null = null;
  setRoutedObserver(cb: ((msg: HiveMessage, targets: string[]) => void) | null): void {
    this.routedObserver = cb;
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  private emitMessage(msg: HiveMessage, targets: string[]): void {
    this.emit?.('hive:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human'
    });
  }

  /** Non-Claude providers cannot drain hive inbox; hand direct mail to the
   *  renderer so it can queue a terminal work order for the target PTY. */
  private emitTerminalHandoff(msg: HiveMessage, targetId: string): boolean {
    // N2: remembered until the renderer confirms the PTY write (bounded; the renderer's
    // confirmation carries the header fields too, so a restart in between loses only the body hash).
    this.handoffs.set(`${targetId}|${msg.id}`, msg);
    if (this.handoffs.size > HiveManager.HANDOFFS_MAX) this.handoffs.delete(this.handoffs.keys().next().value as string);
    const delivered = this.emit?.('hive:terminalHandoff', {
      id: msg.id,
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      body: msg.body,
      requiresReply: msg.requires_reply,
      createdAt: msg.created_at
    }) === true;
    this.appendLog({
      kind: 'terminal-handoff',
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered
    });
    return delivered;
  }

  /** N2: terminal work orders emitted and not yet confirmed written, by `<target>|<id>`. */
  private readonly handoffs = new Map<string, HiveMessage>();
  static readonly HANDOFFS_MAX = 500;

  /** Q34 (god 7048a1) as the backstop of god 1c7544: a leftover is RE-announced at most this often. */
  static readonly WORK_ORDER_LEFTOVER_MAX_REANNOUNCE = 3;
  /** Before re-announce n (1-based): 5, 10, 20 minutes (the F4 cadence); the renderer holds a
   *  handoff until the agent is idle, so an unconfirmed one is not re-offered sooner. */
  static workOrderLeftoverDelayMs(n: number): number {
    return Math.min(30 * 60_000, 5 * 60_000 * 2 ** Math.max(0, n - 1));
  }
  /** Leftover announcements this session, by `<agent>|<id>`: how many, when the next is due, and
   *  whether the loud stuck row was written. */
  private readonly leftoverAnnounces = new Map<string, { count: number; nextAt: number; stuck: boolean }>();

  /**
   * ZT-I1-MAIL god 1c7544 (Jim's work-order leftover finding) + Q34: a WORK-ORDER agent (no Stop,
   * no inbox reader) with message files in inbox/ (written before 1.1.75, or while it ran a hook
   * provider) gets each one through the NORMAL terminal work-order handoff, carrying its body;
   * the renderer's COMMITTED confirmation (recordWorkOrderDelivered) acts it via work-order and
   * the harness archives the file to .done. No nudge text, no agent move.
   * An unconfirmed handoff is re-announced at most WORK_ORDER_LEFTOVER_MAX_REANNOUNCE times (5,
   * 10, 20 min apart); then it stops, the file stays listed (backlog, Threads panel) and one loud
   * `mail-work-order-file-stuck` row is written. A failed emit (renderer down) is not an
   * announcement. Unparseable files and Q15/Q28 closed entries are left listed, never handed off.
   * Files the ledger does not know are first recorded delivered (reconcileInbox), so they count in
   * the backlog. The caller (the wake beat) runs it only for live agents whose mail mode is work-order.
   */
  handOffWorkOrderLeftovers(agentId: string, now: number = Date.now()): { handedOff: string[]; stuck: string[] } {
    const out = { handedOff: [] as string[], stuck: [] as string[] };
    const root = this.root();
    if (!root || !isValidMailId(agentId)) return out;
    const inbox = join(root, 'agents', agentId, 'inbox');
    let names: string[];
    try { names = readdirSync(inbox); } catch { return out; }
    const ids = names.filter((n) => n.endsWith('.json') && !n.includes('.tmp')).map((n) => n.slice(0, -'.json'.length)).filter(isValidMailId).sort();
    const prefix = `${agentId}|`;
    const onDisk = new Set(ids);
    for (const k of [...this.leftoverAnnounces.keys()]) if (k.startsWith(prefix) && !onDisk.has(k.slice(prefix.length))) this.leftoverAnnounces.delete(k);
    // A file the ledger does not know yet (another writer) is recorded delivered first, so it
    // counts in the backlog until its work order is confirmed (it is never a wake: pending is
    // empty for a work-order agent).
    try { this.mail.reconcileInbox(agentId); } catch { /* the ledger logs its own failures */ }
    let entries: Record<string, { state: string; missingAt?: number | null }> = {};
    try { entries = this.mail.ledger(agentId).entries; } catch { entries = {}; }
    const max = HiveManager.WORK_ORDER_LEFTOVER_MAX_REANNOUNCE;
    for (const id of ids) {
      const e = entries[id];
      if (e?.missingAt) continue;
      if (e?.state === 'acted') { try { this.mail.recordWorkOrderLeftover(agentId, { id, from: '?' }); } catch { /* next beat */ } continue; }
      const key = `${prefix}${id}`;
      const st = this.leftoverAnnounces.get(key) ?? { count: 0, nextAt: 0, stuck: false };
      if (st.stuck || (st.count > 0 && now < st.nextAt)) continue;
      if (st.count > max) {
        st.stuck = true;
        this.leftoverAnnounces.set(key, st);
        out.stuck.push(id);
        continue;
      }
      let msg: HiveMessage;
      try {
        const full = join(inbox, `${id}.json`);
        if (statSync(full).size > 1024 * 1024) continue;
        const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<HiveMessage>;
        if (!parsed || typeof parsed !== 'object') continue;
        msg = { ...(parsed as HiveMessage), id, to: agentId };
      } catch { continue; }
      if (!this.emitTerminalHandoff(msg, agentId)) continue;
      st.count += 1;
      st.nextAt = now + HiveManager.workOrderLeftoverDelayMs(st.count);
      this.leftoverAnnounces.set(key, st);
      out.handedOff.push(id);
    }
    if (out.stuck.length) {
      this.appendLog({ kind: 'mail-work-order-file-stuck', agentId, ids: out.stuck, announces: max + 1, why: 'work-order handoff never confirmed; no longer announced, the file stays listed' });
    }
    return out;
  }

  /**
   * ZT-I1-MAIL N2 (§11.17): the renderer confirmed (COMMITTED) the PTY write of the terminal work
   * order for `messageId`. The whole body is in the typed text, so the ledger records it
   * `acted via:"work-order"` (never in the backlog). `fallback` carries the header fields the
   * renderer holds, for a confirmation that arrives after this process forgot the handoff.
   * Idempotent; never throws.
   */
  recordWorkOrderDelivered(agentId: string, messageId: string, fallback: { from?: unknown; act?: unknown; subject?: unknown; requiresReply?: unknown } = {}): boolean {
    if (typeof agentId !== 'string' || typeof messageId !== 'string' || !agentId || !messageId) return false;
    const key = `${agentId}|${messageId}`;
    const known = this.handoffs.get(key);
    const msg = known ?? {
      id: messageId,
      from: typeof fallback.from === 'string' ? fallback.from : '?',
      act: (typeof fallback.act === 'string' ? fallback.act : 'inform') as MessageAct,
      subject: typeof fallback.subject === 'string' ? fallback.subject : '',
      requires_reply: fallback.requiresReply === true
    };
    try {
      // god 1c7544: a leftover inbox file handed off as a work order is acted via work-order and
      // its file archived to .done by the harness.
      const root = this.root();
      if (root && isValidMailId(agentId) && isValidMailId(messageId) && existsSync(join(root, 'agents', agentId, 'inbox', `${messageId}.json`))) {
        this.mail.recordWorkOrderLeftover(agentId, msg as HiveMessage);
        this.handoffs.delete(key);
        this.leftoverAnnounces.delete(key);
        return true;
      }
      // Q14: a confirmation this process has no handoff for (it arrived after a restart) is
      // recorded from the header fields only: restored, with no body hash.
      this.mail.recordWorkOrder(agentId, msg as HiveMessage, { restored: !known });
      this.handoffs.delete(key);
      return true;
    } catch (e) {
      this.appendLog({ kind: 'mail-ledger-error', agentId, id: messageId, op: 'work-order', error: String(e) });
      return false;
    }
  }

  // — router: drain outboxes → inboxes —

  /**
   * HYBRID router (pre-M1 event-wake bridge). The FILES are authoritative: an fs.watch
   * callback on any outbox only schedules one whole-tree `routeOnce()`, and the existing
   * interval stays as reconciliation (it also repairs lost or broken watchers). Starting
   * runs one immediate catch-up scan, so a restart or power-resume routes what waited.
   */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerGeneration++;
    this.routerTimer = this.routerRuntime.setInterval(() => {
      try { this.refreshOutboxWatchers(); this.routeOnce(); } catch { /* keep the loop alive */ }
    }, intervalMs);
    try { this.refreshOutboxWatchers(); this.routeOnce(); } catch { /* the interval retries */ }
  }
  stopRouter(): void {
    if (this.routerTimer) { this.routerRuntime.clearInterval(this.routerTimer); this.routerTimer = null; }
    this.routerGeneration++;
    this.routeQueued = false;
    for (const w of this.outboxWatchers.values()) { try { w.close(); } catch { /* already closed */ } }
    this.outboxWatchers.clear();
  }

  /** Watch every active agent's outbox; close watchers whose directory is gone or archived. */
  refreshOutboxWatchers(): void {
    const root = this.root();
    const want = new Set<string>();
    const agentsDir = root ? join(root, 'agents') : null;
    if (agentsDir && existsSync(agentsDir)) {
      const agents = this.registry().agents;
      for (const id of readdirSync(agentsDir)) {
        if (agents[id]?.archived) continue;
        const outbox = join(agentsDir, id, 'outbox');
        if (existsSync(outbox)) want.add(outbox);
      }
    }
    for (const [dir, w] of this.outboxWatchers) {
      if (want.has(dir)) continue;
      try { w.close(); } catch { /* already closed */ }
      this.outboxWatchers.delete(dir);
    }
    for (const dir of want) {
      if (this.outboxWatchers.has(dir)) continue;
      try {
        const w = this.routerRuntime.watch(dir, () => this.scheduleRouteOnce());
        // A broken watcher is dropped; the next reconciliation re-attaches it.
        const drop = (): void => {
          if (this.outboxWatchers.get(dir) !== w) return;
          this.outboxWatchers.delete(dir);
          try { w.close(); } catch { /* already closed */ }
        };
        w.on('error', drop);
        w.on('close', drop);
        this.outboxWatchers.set(dir, w);
      } catch { /* unwatchable now: the interval scan still routes it */ }
    }
  }

  /** The directories currently watched (diagnostics and tests). */
  watchedOutboxes(): string[] {
    return [...this.outboxWatchers.keys()].sort();
  }

  /** Coalesce every hint in this turn into ONE authoritative scan (event scheduling, not a timer). */
  private scheduleRouteOnce(): void {
    if (this.routeQueued || !this.routerTimer) return;
    this.routeQueued = true;
    const generation = this.routerGeneration;
    this.routerRuntime.setImmediate(() => {
      if (generation !== this.routerGeneration) return;
      this.routeQueued = false;
      if (!this.routerTimer) return;
      try { this.routeOnce(); } catch { /* the interval retries */ }
    });
  }

  /** Stable enough to recognise an unchanged file after a rejected-file archive fails. */
  private outboxFingerprint(full: string): string | null {
    try {
      const stat = statSync(full);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /**
   * The single terminal path for malformed or unroutable outbox files. It always
   * reports the failure to the sender and floor; an archive failure is remembered
   * by fingerprint so an unchanged locked file cannot spam the log or its sender.
   */
  private rejectOutboxFile(
    outbox: string,
    full: string,
    from: string,
    file: string,
    reason: 'parse-failed' | 'route-failed',
    detail: string,
    error: unknown
  ): boolean {
    let archived = false;
    try {
      renameSync(full, join(outbox, '.sent', `bad-${file}`));
      archived = true;
    } catch (archiveError) {
      this.appendLog({ kind: 'outbox-reject-archive-failed', from, file, reason, detail, error: String(archiveError) });
    }
    const notice = this.normalize({
      to: from,
      act: 'inform',
      subject: `[outbox rejected — ${detail}] ${file}`,
      body: `The hive router rejected this outbox file: ${detail}. It${archived ? ' was archived' : ' could not be archived yet'} as bad-${file}; rewrite and resend it if it is still needed.`
    }, 'system');
    const notified = this.deliver(notice, from);
    this.emitMessage(notice, notified ? [from] : []);
    this.appendLog({ kind: 'outbox-rejected', from, file, reason, detail, error: String(error), notified, archived });
    if (!archived) this.outboxRejectNotices.set(full, this.outboxFingerprint(full));
    return true;
  }

  /** Archive after delivery; a transient archive lock is never a route failure. */
  private archiveDeliveredOutbox(outbox: string, full: string, from: string, file: string): boolean {
    try {
      renameSync(full, join(outbox, '.sent', file));
      this.outboxDeliveredArchives.delete(full);
      return true;
    } catch (error) {
      this.outboxDeliveredArchives.set(full, this.outboxFingerprint(full));
      this.appendLog({ kind: 'outbox-archive-failed', from, file, error: String(error) });
      return false;
    }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    let rejected = 0;
    let archived = 0;
    const liveOutboxFiles = new Set<string>();
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        liveOutboxFiles.add(full);
        const deliveredFingerprint = this.outboxDeliveredArchives.get(full);
        if (deliveredFingerprint !== undefined) {
          if (deliveredFingerprint === this.outboxFingerprint(full)) {
            archived += Number(this.archiveDeliveredOutbox(outbox, full, id, f));
            continue;
          }
          // The sender replaced the stranded file, so route the new payload normally.
          this.outboxDeliveredArchives.delete(full);
        }
        const priorRejection = this.outboxRejectNotices.get(full);
        if (priorRejection !== undefined) {
          if (priorRejection === this.outboxFingerprint(full)) continue;
          this.outboxRejectNotices.delete(full);
        }
        let partial: Partial<HiveMessage>;
        try {
          partial = JSON.parse(readFileSync(full, 'utf8')) as Partial<HiveMessage>;
        } catch (error) {
          // A non-atomic writer may still be streaming this file. Leave it in
          // place for subsequent polling passes; only a bounded failure becomes
          // a visible rejection.
          const now = Date.now();
          try {
            if (now - statSync(full).mtimeMs < OUTBOX_FRESH_WRITE_GRACE_MS) continue;
          } catch {
            continue; // writer removed or replaced it; a later scan sees the new state
          }
          const prior = this.outboxParseRetries.get(full);
          // fs.watch can report several chunks of one write in the same turn.
          // They are hints, not independent retries: wait before re-reading.
          if (prior && now < prior.retryAfter) continue;
          const attempts = (prior?.attempts ?? 0) + 1;
          if (attempts < OUTBOX_PARSE_RETRY_LIMIT) {
            this.outboxParseRetries.set(full, { attempts, retryAfter: now + OUTBOX_PARSE_RETRY_DEBOUNCE_MS });
            this.appendLog({ kind: 'outbox-parse-retry', from: id, file: f, attempts });
            continue;
          }
          this.outboxParseRetries.delete(full);
          rejected += Number(this.rejectOutboxFile(
            outbox, full, id, f,
            'parse-failed',
            `malformed JSON after ${attempts} attempts`,
            error
          ));
          continue;
        }
        this.outboxParseRetries.delete(full);
        try {
          if (!partial || typeof partial !== 'object') throw new Error('unroutable: message must be an object');
          if (partial.to !== undefined && typeof partial.to !== 'string') throw new Error('unroutable: to must be a string');
          // REPLY-LINK-GAP: accept the protocol's common historical spellings, but make their
          // canonical meaning explicit before validation and routing. Unknown acts still take
          // the visible sender-notice path below.
          const wire = partial as Partial<HiveMessage> & { inReplyTo?: unknown };
          const normalised: string[] = [];
          const originalAct = (wire as { act?: unknown }).act;
          if (Object.prototype.hasOwnProperty.call(wire, 'inReplyTo')) {
            if (partial.in_reply_to === undefined) partial.in_reply_to = wire.inReplyTo as string | null;
            delete wire.inReplyTo;
            normalised.push('inReplyTo->in_reply_to');
          }
          if (originalAct === 'reply' || originalAct === 'answer') {
            partial.act = partial.in_reply_to !== undefined && partial.in_reply_to !== null ? 'done' : 'inform';
            normalised.push(`${originalAct}->${partial.act}`);
          } else if (originalAct === 'ack') {
            partial.act = 'agree';
            normalised.push('ack->agree');
          }
          if (normalised.length) this.appendLog({ kind: 'outbox-normalised', from: id, file: f, mappings: normalised });
          if (partial.act !== undefined && !isMessageAct(partial.act)) {
            throw new Error(`unroutable: act must be one of ${[...MESSAGE_ACTS].join(', ')}`);
          }
          if (Object.prototype.hasOwnProperty.call(partial, 'inReplyTo')) {
            throw new Error('unroutable: use in_reply_to, not inReplyTo');
          }
          if (partial.in_reply_to !== undefined && partial.in_reply_to !== null && typeof partial.in_reply_to !== 'string') {
            throw new Error('unroutable: in_reply_to must be a string or null');
          }
          const msg = this.normalize(partial, id);
          msg.from = id; // sender is authoritative — the owning directory
          this.routeMessage(msg);
          routed++;
        } catch (error) {
          // A parsed payload that cannot route is terminal too: keep it visible,
          // rather than retrying it forever on every watcher hint and poll.
          const reason = error instanceof Error ? error.message : String(error);
          rejected += Number(this.rejectOutboxFile(outbox, full, id, f, 'route-failed', reason, error));
          continue;
        }
        this.archiveDeliveredOutbox(outbox, full, id, f);
      }
    }
    // A file removed by its writer or routed successfully must not leave a stale
    // retry count that could punish a later file reusing the same name.
    for (const full of this.outboxParseRetries.keys()) {
      if (!liveOutboxFiles.has(full)) this.outboxParseRetries.delete(full);
    }
    for (const full of this.outboxRejectNotices.keys()) {
      if (!liveOutboxFiles.has(full)) this.outboxRejectNotices.delete(full);
    }
    for (const full of this.outboxDeliveredArchives.keys()) {
      if (!liveOutboxFiles.has(full)) this.outboxDeliveredArchives.delete(full);
    }
    if (routed > 0 || rejected > 0 || archived > 0) {
    }
    return routed;
  }

  // — read helpers (for IPC / UI) —

  registry(): Registry {
    const root = this.root();
    if (!root) return this.emptyRegistry();
    try {
      return this.readAuthoritativeJson(join(root, 'registry.json'), () => this.emptyRegistry());
    } catch (error) {
      if (error instanceof HiveAuthorityCorruptError) return this.emptyRegistry();
      throw error;
    }
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }
  tasks(): unknown {
    const root = this.root();
    if (!root) return { tasks: [] };
    try {
      return this.readAuthoritativeJson(join(root, 'tasks.json'), () => ({ tasks: [] }));
    } catch (error) {
      if (error instanceof HiveAuthorityCorruptError) return { tasks: [] };
      throw error;
    }
  }

  /** Force a fresh integrity scan for the small set of UI-readable authorities. */
  integrityIssues(): HiveIntegrityIssue[] {
    this.registry();
    this.tasks();
    // ZT-I3: a ledger error (duplicate id, unknown status) is a NOTICE: nothing is paused,
    // the file is not reverted, god fixes it by hand. Jim S1: the CACHED result; the banner
    // polls every 2 s and the guard already re-checks on watch, its poll and every API write.
    const ledgerNotice = this.ledgerGuard.integrityNotice();
    const ledger: HiveIntegrityIssue[] = ledgerNotice
      ? [{ file: 'tasks.json', quarantine: null, error: 'task ledger has errors', notice: ledgerNotice }]
      : [];
    return [...this.authorityIssues.values(), ...ledger, ...this.mail.integrityIssues()];
  }

  private emptyRegistry(): Registry {
    return { godId: null, agents: {} };
  }
  /** Mutations must never operate on the read-only fallback. */
  private registryForMutation(): Registry {
    const root = this.root();
    return root ? this.readAuthoritativeJson(join(root, 'registry.json'), () => this.emptyRegistry()) : this.emptyRegistry();
  }
  private tasksForMutation(): { tasks?: HiveTask[] } {
    const root = this.root();
    return root ? this.readAuthoritativeJson(join(root, 'tasks.json'), () => ({ tasks: [] })) : { tasks: [] };
  }

  /** Persist the task ledger to hive/tasks.json. Mirrors the board/message persist
   *  pattern: write JSON, log the change.
   *
   *  MERGES by card id instead of clobbering. Callers hold PARTIAL models of a
   *  card — the renderer's kanban parser knows nine fields, the god writes as
   *  many as the work needs (`result`, the verbatim Slack reply posted back to
   *  the user; `repo`; `scope`; `origin`; `commit`; …). A wholesale write meant
   *  one small edit through the UI deleted every unmodelled field on EVERY card
   *  on the board. Now an unmentioned field keeps its on-disk value.
   *
   *  Deleting a card still works: the incoming list IS the membership, so a card
   *  dropped from it (TasksKanban dismiss, the voice delete_task action) is
   *  gone. Merging protects fields, never card membership. */
  writeTasks(tasks: HiveTask[], source: TaskEditSource = 'ipc'): void {
    const root = this.root();
    if (!root) return;
    this.ensureHive();
    const path = join(root, 'tasks.json');
    const current = this.readAuthoritativeJson<{ tasks?: unknown }>(path, () => ({ tasks: [] }));
    const merged = mergeTaskLedger(current?.tasks, tasks);
    // ZT-I3 (Jim C1): validate the CHANGE, not the file. Refuse only an error this write
    // would introduce; an error a hand edit already put in the file never blocks an
    // unrelated UI, Slack, webhook, voice or auto-move write.
    const introduced = introducedErrors(validateLedger(current?.tasks), validateLedger(merged));
    if (introduced.length > 0) {
      this.appendLog({ kind: 'task-ledger-refused', source, errors: introduced.map((i) => i.key) });
      throw new TaskLedgerInvalidError(introduced);
    }
    const data = { tasks: merged };
    this.atomicWriteJson(path, data);
    // Jim C4: recorded only after the rename succeeded (a throw above records nothing), with
    // the exact bytes atomicWriteJson wrote, so the watcher does not re-attribute it to 'file'.
    try { this.ledgerGuard.recordApiWrite(JSON.stringify(data, null, 2), merged, source); }
    catch (e) { try { this.appendLog({ kind: 'task-meta-write-failed', error: String(e) }); } catch { /* noop */ } }
    this.appendLog({ kind: 'tasks', count: merged.length, source });
  }

  /** Append one card against the latest on-disk ledger. Renderer callers must
   *  use this instead of re-writing a collection they read before another
   *  source (webhook, Slack, god, voice) added work. Idempotent by task id. */
  addTask(task: HiveTask, source: TaskEditSource = 'ipc'): boolean {
    const ledger = this.tasksForMutation();
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    if (tasks.some((current) => current?.id === task.id)) return false;
    this.writeTasks([...tasks, task], source);
    return true;
  }

  /** Patch one card against the latest on-disk ledger, preserving unrelated
   *  cards and fields (notably webhook.tokenHash and Slack thread metadata).
   *  With duplicate ids the FIRST card is the one patched (the shared rule). */
  patchTask(id: string, patch: Partial<Omit<HiveTask, 'id'>>, source: TaskEditSource = 'ipc'): boolean {
    const ledger = this.tasksForMutation();
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const index = tasks.findIndex((task) => task?.id === id);
    if (index < 0) return false;
    const next = tasks.slice();
    next[index] = { ...tasks[index], ...patch, id };
    this.writeTasks(next, source);
    return true;
  }

  /** Delete only the named card from the latest on-disk ledger. With duplicate ids only the
   *  FIRST card (the one every reader shows) is deleted; a later twin stays for god (Jim S2). */
  deleteTask(id: string, source: TaskEditSource = 'ipc'): boolean {
    const ledger = this.tasksForMutation();
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const at = tasks.findIndex((task) => task?.id === id);
    const next = at < 0 ? tasks : [...tasks.slice(0, at), ...tasks.slice(at + 1)];
    if (next.length === tasks.length) return false;
    this.writeTasks(next, source);
    return true;
  }

  /** ZT-I3: start watching tasks.json (the guard's first check runs at once). */
  startLedgerGuard(): void {
    this.ledgerGuard.reset();
    this.ledgerGuard.start();
  }
  stopLedgerGuard(): void {
    this.ledgerGuard.reset();
  }
  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  /** Whether an agent has recorded NON-TRIVIAL memory — i.e. has appended real
   *  notes beyond the boilerplate header ensureAgent seeds. Lets the voice
   *  read-layer answer "what has the team remembered" and enumerate who has
   *  anything worth reading (every registered agent technically has a memory.md,
   *  but most of the floor's history lives in a handful of them). Cheap: reads a
   *  small markdown file; never throws. Works for ANY id, active OR archived. */
  hasMemory(id: string): boolean {
    const p = join(this.agentDir(id), 'memory.md');
    if (!existsSync(p)) return false;
    try {
      // A fresh seed is ~90 chars (one header line + the prompt). Anything
      // meaningfully longer means the agent appended durable facts.
      return readFileSync(p, 'utf8').trim().length > 200;
    } catch { return false; }
  }
  inbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** Read an agent's OUTBOX (messages it has authored/sent). Symmetric with
   *  inbox(); the router drains live outbox files into recipients' inboxes and
   *  archives the original under outbox/.sent, so a sent message survives there. */
  outbox(id: string): HiveMessage[] {
    return this.listMessages(join(this.agentDir(id), 'outbox'));
  }

  /**
   * Voice read-layer: recent message CONTENT (inbox + outbox bodies) for the
   * operator briefing, REDACTED main-side. This is the message-content half of
   * the voice query surface (the activity half is logTail()).
   *
   * Modes:
   *   - { id }                → the single message with that id, wherever it lives.
   *   - { agentId }           → recent messages in that agent's mailbox only.
   *   - {}                    → recent messages across the whole floor, newest first.
   * `limit` caps the list (default 12, max 40); `includeArchived` (default true)
   * also reads the handled subfolders (inbox/.done, outbox/.sent).
   *
   * SECURITY: every subject + body is passed through redactSecrets() here, in
   * main, so no secret and no raw body ever crosses IPC. Delivered messages exist
   * in both the sender's outbox/.sent and the recipient's inbox/.done; we dedup
   * by message id so each appears once.
   */
  voiceMessages(opts: { agentId?: string; id?: string; limit?: number; includeArchived?: boolean } = {}): VoiceMessage[] {
    const root = this.root();
    if (!root) return [];
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return [];

    const wantId = typeof opts.id === 'string' ? opts.id.trim() : '';
    const onlyAgent = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
    const includeArchived = opts.includeArchived !== false; // default true

    let owners: string[];
    try {
      owners = onlyAgent
        ? [onlyAgent]
        : readdirSync(agentsDir).filter((id) => !id.startsWith('.') && existsSync(this.agentDir(id)));
    } catch {
      return [];
    }

    const seen = new Set<string>();
    const out: VoiceMessage[] = [];
    for (const owner of owners) {
      const base = this.agentDir(owner);
      const folders: Array<{ dir: string; direction: 'inbox' | 'outbox'; archived: boolean }> = [
        { dir: join(base, 'inbox'), direction: 'inbox', archived: false },
        { dir: join(base, 'outbox'), direction: 'outbox', archived: false }
      ];
      if (includeArchived) {
        folders.push({ dir: join(base, 'inbox', '.done'), direction: 'inbox', archived: true });
        folders.push({ dir: join(base, 'outbox', '.sent'), direction: 'outbox', archived: true });
      }
      for (const f of folders) {
        for (const m of this.listMessages(f.dir)) {
          if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
          seen.add(m.id);
          if (wantId && m.id !== wantId) continue;
          out.push({
            id: m.id,
            conversation: m.conversation,
            from: m.from,
            to: m.to,
            act: m.act,
            subject: redactSecrets(m.subject),
            body: redactSecrets(m.body),
            requires_reply: !!m.requires_reply,
            direction: f.direction,
            owner,
            archived: f.archived,
            created_at: m.created_at
          });
        }
      }
    }

    // Newest first by ISO created_at (lexicographic == chronological for ISO-8601).
    out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (wantId) return out.slice(0, 1);
    const lim = typeof opts.limit === 'number' && isFinite(opts.limit)
      ? Math.max(1, Math.min(40, Math.round(opts.limit)))
      : 12;
    return out.slice(0, lim);
  }
  /**
   * ZT-I1-MAIL §7.1 / §11.12(c): the one-shot, idempotent upgrade pass (see mailMigration.ts).
   * Reads the registry for MUTATION, so a damaged registry throws and the pass waits for the next
   * boot (a read-only fallback would record every agent as absent and write the marker). The
   * caller runs it BEFORE archiveOrphanedAgents, while `archived` still means "closed".
   */
  migrateMail(): MailMigrationResult {
    const root = this.root();
    if (!root) return { ran: false };
    if (mailMigrationDone(root)) return { ran: false };
    const reg = this.registryForMutation();
    const agents = Object.keys(reg.agents ?? {})
      .filter((id) => Object.prototype.hasOwnProperty.call(reg.agents, id))
      // Q31 (god 7048a1): .undelivered/ only for EXPLICIT archives. A reason-less archive was
      // already archived in the registry before this boot's orphan sweep (which runs after this
      // pass), so it counts as explicit; an orphan or pty-exit archive is an active agent here.
      .map((id) => ({ id, archived: archivedForMail(reg.agents[id]) }));
    return runMailMigration({ root, agents, mail: this.mail, appendLog: (row) => this.appendLog(row) });
  }

  /** §7.1 step 2: the archived agents' mail moved to inbox/.undelivered, or null. */
  undeliveredReport(): UndeliveredReport | null {
    const root = this.root();
    return root ? readUndeliveredReport(root) : null;
  }

  /** The Human dismissed the undelivered report (shown once; persisted). */
  markUndeliveredSeen(): boolean {
    const root = this.root();
    if (!root) return false;
    const changed = markUndeliveredSeen(root);
    if (changed) this.appendLog({ kind: 'mail-undelivered-seen' });
    return changed;
  }

  /**
   * ZT-I1-MAIL §4.3 + §11.13 option B: the Command Center's open-request list, over the active
   * registry agents (the agent listed owes the reply). Data only: nothing here ever wakes anyone.
   */
  mailObligations(): MailObligationsAgent[] {
    const reg = this.registry();
    const agents = Object.keys(reg.agents ?? {})
      .filter((id) => Object.prototype.hasOwnProperty.call(reg.agents, id) && !reg.agents[id]?.archived)
      .map((id) => ({ id, name: reg.agents[id]?.name }));
    return mailObligationsView(this.mail, agents);
  }

  /**
   * §11.18 #1: the Human's explicit close of an open obligation (the one caller of
   * `MailLedger.closeObligation`). `agentId` must be a registry agent (exact match) and `id` a
   * valid mail id. Returns the ids closed (`[]` for nothing open under that id).
   */
  closeMailObligation(agentId: unknown, id: unknown): string[] {
    if (typeof agentId !== 'string' || typeof id !== 'string' || !isValidMailId(id)) return [];
    const reg = this.registry();
    if (!Object.prototype.hasOwnProperty.call(reg.agents ?? {}, agentId)) return [];
    return this.mail.closeObligation(agentId, id, 'closed-by-human');
  }

  /**
   * The fleet `inboxBacklog` (ZT-I1-MAIL §3 #6): the agent's mail not yet acted, from its LEDGER
   * (delivered + surfacing + surfaced; terminal work orders are acted by definition, N2). File
   * position means nothing any more: the harness moves a file into .done only when it is acted.
   * An archived agent's ledger is never loaded here (its inbox is left to the §7.1 step-2
   * migration), so it counts its files, as before; so does a ledger that cannot be read.
   */
  inboxBacklog(id: string, opts: { archived?: boolean } = {}): number {
    if (!opts.archived) {
      try { return this.mail.backlog(id).length; } catch { /* fall back to the files */ }
    }
    const dir = join(this.agentDir(id), 'inbox');
    if (!existsSync(dir)) return 0;
    try { return readdirSync(dir).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
  }

  /**
   * ZT-I1-MAIL §11.8 #15: an agent's mail for the Threads panel, from inbox/ AND inbox/.done/, so
   * the view does not empty when the harness archives at Stop. Each message carries its ledger
   * state as `mail_state` (`delivered | surfacing | surfaced | acted`; `archived` for a .done
   * file the ledger no longer holds, e.g. pruned after 7 days or handled before 1.1.75; `unknown`
   * for an inbox file with no ledger entry) and `archived` (the file is in .done). Bounded: every
   * inbox file plus the newest .done files by mtime, `limit` in all; parsed files are cached by
   * path + size + mtime, so a 3 s poll re-reads only what changed. An archived agent's ledger is
   * not loaded (see inboxBacklog).
   */
  mailHistory(agentId: string, opts: { limit?: number; archived?: boolean } = {}): Array<HiveMessage & { mail_state: string; archived: boolean }> {
    const limit = Math.max(1, Math.min(1000, Math.round(opts.limit ?? HiveManager.MAIL_HISTORY_LIMIT)));
    const inbox = join(this.agentDir(agentId), 'inbox');
    const list = (dir: string, archived: boolean): Array<{ path: string; stem: string; archived: boolean; mtimeMs: number; size: number }> => {
      let names: string[];
      try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
      const out: Array<{ path: string; stem: string; archived: boolean; mtimeMs: number; size: number }> = [];
      for (const n of names) {
        const p = join(dir, n);
        try { const st = statSync(p); if (st.isFile()) out.push({ path: p, stem: n.slice(0, -5), archived, mtimeMs: st.mtimeMs, size: st.size }); } catch { /* moved meanwhile */ }
      }
      return out;
    };
    const live = list(inbox, false);
    const liveStems = new Set(live.map((f) => f.stem));
    const done = list(join(inbox, '.done'), true).filter((f) => !liveStems.has(f.stem)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const files = [...live.sort((a, b) => b.mtimeMs - a.mtimeMs), ...done].slice(0, Math.max(limit, 0));
    let entries: Record<string, { state: string }> = {};
    if (!opts.archived) {
      try { entries = this.mail.ledger(agentId).entries; } catch { entries = {}; }
    }
    const seen = new Set<string>();
    const out: Array<HiveMessage & { mail_state: string; archived: boolean }> = [];
    for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      const key = `${f.path}|${f.size}|${f.mtimeMs}`;
      let msg = this.mailHistoryCache.get(f.path);
      if (!msg || msg.key !== key) {
        let parsed: HiveMessage | null = null;
        try {
          if (f.size <= HiveManager.INBOX_MESSAGE_MAX_BYTES) {
            const m = JSON.parse(readFileSync(f.path, 'utf8')) as unknown;
            if (m && typeof m === 'object' && !Array.isArray(m)) parsed = m as HiveMessage;
          }
        } catch { parsed = null; }
        msg = { key, msg: parsed };
        this.mailHistoryCache.set(f.path, msg);
        if (this.mailHistoryCache.size > HiveManager.MAIL_HISTORY_CACHE_MAX) {
          const first = this.mailHistoryCache.keys().next().value;
          if (first !== undefined) this.mailHistoryCache.delete(first);
        }
      }
      if (!msg.msg) continue;
      const id = typeof msg.msg.id === 'string' && msg.msg.id ? msg.msg.id : f.stem;
      if (seen.has(id)) continue;
      seen.add(id);
      const state = entries[f.stem]?.state ?? entries[id]?.state ?? (f.archived ? 'archived' : 'unknown');
      out.push({ ...msg.msg, id, mail_state: state, archived: f.archived });
    }
    return out;
  }
  static readonly MAIL_HISTORY_LIMIT = 200;
  static readonly MAIL_HISTORY_CACHE_MAX = 2000;
  private readonly mailHistoryCache = new Map<string, { key: string; msg: HiveMessage | null }>();
  /** Install the Antigravity (`agy`) lifecycle-hook bridge: write the normalizer
   *  shim and merge a `munder-hive` hook group into agy's global hooks.json so a
   *  Gemini worker reports PreToolUse/PostToolUse/Stop/PreInvocation/PostInvocation
   *  to this HookServer (live status + guarded idle delivery), reusing the Claude pipeline.
   *
   *  Two agy-isms handled: (1) antigravity-cli#49 — agy LOADS hooks from
   *  `~/.gemini/antigravity-cli/hooks.json` but TRIGGERS from `~/.gemini/config/
   *  hooks.json`, so we write BOTH; (2) commands go to cmd.exe and agy mangles
   *  embedded quotes, so the shim path must be space-free (hive roots are).
   *  Runtime-scoped by AGENT_ID (the shim no-ops for non-hive agy sessions), so
   *  this global config never disturbs the user's own `agy` usage. Best-effort,
   *  idempotent (only our own group is overwritten). */
  /** AGY-STARTUP-TURN: the per-agent agy custom agent's name (agy selects it by NAME). */
  static agyAgentName(agentId: string): string {
    // N6 (Jim): the name must identify ONE agent. A hive id is normally already [a-z0-9-]
    // (identity); any other id gets a short hash suffix, so two ids that sanitise alike
    // ("A_b", "a-b") never share one agent.md.
    const base = agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (base === agentId && base.length <= 56) return `munder-${base}`;
    return `munder-${base.slice(0, 48)}-${createHash('sha256').update(agentId).digest('hex').slice(0, 8)}`;
  }

  /** N5 (Jim): at startup, remove OUR agy agents (marked) whose hive agent is not on the floor
   *  any more (not registered, or archived): leftovers of a crash, where no PTY teardown ran.
   *  Someone else's agent under a munder- name is never touched. Gated like every global write. */
  sweepAgyAgents(): number {
    if (!this.mayWriteGlobalConfig('Antigravity agent sweep')) return 0;
    const dir = join(homedir(), '.gemini', 'config', 'agents');
    let registry: Registry;
    try { registry = this.registryForMutation(); } catch { return 0; }
    const live = new Set(Object.entries(registry.agents).filter(([, a]) => !a.archived).map(([id]) => HiveManager.agyAgentName(id)));
    let removed = 0;
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.startsWith('munder-')); } catch { return 0; }
    for (const n of names) {
      if (live.has(n)) continue;
      try {
        const f = join(dir, n, 'agent.md');
        if (!readFileSync(f, 'utf8').includes(HiveManager.AGY_AGENT_MARK)) continue;
        rmSync(join(dir, n), { recursive: true, force: true });
        removed++;
      } catch { /* not ours / unreadable: leave it */ }
    }
    return removed;
  }

  /** The line that marks an agent.md as ours: only such a file is ever rewritten or removed. */
  static readonly AGY_AGENT_MARK = 'Written by the Munder Difflin app';

  private agyAgentDir(agentId: string): string {
    return join(homedir(), '.gemini', 'config', 'agents', HiveManager.agyAgentName(agentId));
  }

  /** The agent.md for one hive agent: YAML frontmatter + ONE H1 whose body is the hive protocol
   *  (agy's system prompt for this agent). Shape confirmed on the live CLI (AGY probe,
   *  2026-09-26): discovered at ~/.gemini/config/agents/<name>/agent.md, selected with
   *  `--agent <name>`, the body applied as instructions, no turn at start, the global hooks still
   *  fire, and `--conversation` resume keeps it. Strings are JSON-quoted (valid YAML), and a
   *  prompt line that starts with `#` is escaped so it cannot open a second section. */
  /** AGY-TOOLS-166: the built-in tools a hive agent's agy custom agent mounts. A Markdown custom
   *  agent gets ONLY agy's fundamental tools (view_file, search_web, send_message, manage_task)
   *  unless it lists `tools`, so from 1.1.55 to 1.1.65 a FRESH `--agent` conversation could not run
   *  a command or write a file (no outbox, no inbox move, no deliverable). agy rejects the WHOLE
   *  agent on one unknown name (exit 3 before any model call) and has no wildcard, so every name
   *  here is verified against agy's registry (jailed probe, 2026-09-27, AGY-TOOLS-PROBE.md). This
   *  is the set a working default-agent hive conversation used, plus multi_replace_file_content. */
  static readonly AGY_AGENT_TOOLS: readonly string[] = [
    'run_command', 'view_file', 'write_to_file', 'replace_file_content',
    'multi_replace_file_content', 'search_web', 'read_url_content', 'manage_task'
  ];

  static agyAgentMarkdown(meta: { id: string; name: string }, prompt: string): string {
    const name = HiveManager.agyAgentName(meta.id);
    return [
      '---',
      `name: ${name}`, // [a-z0-9-] only: plain YAML, exactly the probe-verified form
      `description: ${JSON.stringify(`Munder Difflin hive agent ${meta.name} (${meta.id}): its standing hive instructions. ${HiveManager.AGY_AGENT_MARK}; removed when the agent leaves the floor.`)}`,
      'mainAgent: true',
      'inheritCustomizations: true',
      // V1 (Jim; verified in a jailed agy HOME): without this, the agent is offered as a
      // SUBAGENT in the user's own plain `agy` sessions. With it, only `--agent` selects it.
      'subagent: false',
      // Kept out of the user's /agents panel (harmless to --agent selection, verified).
      'hidden: true',
      // AGY-TOOLS-166: without this list the agent cannot run commands or write files.
      'tools:',
      ...HiveManager.AGY_AGENT_TOOLS.map((t) => `  - ${t}`),
      '---',
      '',
      `# ${meta.name} (${meta.id}), a Munder Difflin hive agent`,
      '',
      prompt.replace(/^#/gm, '\\#'),
      ''
    ].join('\n');
  }

  /** Write (or refresh) this agent's agy custom agent and return its name, or null when the
   *  global write is refused or fails (the caller then falls back to `-i`). Global config, so
   *  it goes through `mayWriteGlobalConfig`. Rewritten only when the content changed (a new
   *  prompt: another version, a renamed agent), via a temp file + rename. */
  private installAgyAgent(meta: { id: string; name: string }, prompt: string): string | null {
    if (!this.mayWriteGlobalConfig('Antigravity agent')) return null;
    const dir = this.agyAgentDir(meta.id);
    const file = join(dir, 'agent.md');
    const body = HiveManager.agyAgentMarkdown(meta, prompt);
    try {
      let hadTools = false;
      const existed = existsSync(file);
      if (existed) {
        const cur = readFileSync(file, 'utf8');
        hadTools = /\ntools:\n/.test(cur);
        if (cur === body) return HiveManager.agyAgentName(meta.id);
        // Someone else's agent under our name: never overwrite it.
        if (!cur.includes(HiveManager.AGY_AGENT_MARK)) {
          console.warn(`[hive] ${file} exists and is not ours: agy falls back to an initial prompt`);
          return null;
        }
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, body, 'utf8');
      renameSync(`${file}.tmp`, file);
      // AGY-TOOLS-166: the moment this agent's agy agent first carried `tools`. A conversation
      // created before it has no command or write tools, for good (agy fixes the toolset when a
      // conversation is created), so an automatic resume of one starts fresh (index.ts).
      // Stamped only on a real UPGRADE (an existing file without tools:) or when this agent was
      // never stamped. A kill/exit removes agent.md (removeAgyAgent), so the next spawn rewrites
      // it from nothing: re-stamping then would rotate a GOOD post-fix conversation (Jim, AGY-166 F1).
      if ((existed && !hadTools) || this.agyToolsSince(meta.id) === null) this.markAgyToolsSince(meta.id);
      return HiveManager.agyAgentName(meta.id);
    } catch (e) {
      console.error('[hive] installAgyAgent failed:', e);
      return null;
    }
  }

  /** AGY-TOOLS-166: when this agent's agy agent first mounted the full toolset (ms), or null. Kept
   *  in the hive agent's own folder, not in the user's ~/.gemini. */
  agyToolsSince(agentId: string): number | null {
    try {
      const n = Number(readFileSync(join(this.agentDir(agentId), HiveManager.AGY_TOOLS_SINCE_FILE), 'utf8').trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  }

  static readonly AGY_TOOLS_SINCE_FILE = 'agy-tools-since';

  private markAgyToolsSince(agentId: string): void {
    try {
      mkdirSync(this.agentDir(agentId), { recursive: true });
      writeFileSync(join(this.agentDir(agentId), HiveManager.AGY_TOOLS_SINCE_FILE), String(Date.now()), 'utf8');
    } catch (e) { console.warn('[hive] could not record agy-tools-since:', e); }
  }

  /** Remove this agent's agy custom agent when it leaves the floor (killed or archived), so
   *  they do not pile up in the user's `agy agents`. Only a file we wrote is removed. */
  removeAgyAgent(agentId: string): void {
    if (!this.mayWriteGlobalConfig('Antigravity agent removal')) return;
    const dir = this.agyAgentDir(agentId);
    const file = join(dir, 'agent.md');
    try {
      if (!existsSync(file)) return;
      if (!readFileSync(file, 'utf8').includes(HiveManager.AGY_AGENT_MARK)) return;
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error('[hive] removeAgyAgent failed:', e);
    }
  }

  private installAgyHooks(): void {
    const root = this.root();
    if (!root) return;
    if (!this.mayWriteGlobalConfig('Antigravity hook')) return;
    const shim = join(root, 'bin', 'agy-hook.cjs');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(shim, AGY_HOOK_SHIM, 'utf8');
    // Bundled node, not bare `node` — agy's hooks run with a stripped PATH too.
    const tool = (event: string) => ({
      matcher: '*',
      hooks: [{ type: 'command', command: this.nodeRunUnquoted(shim, event), timeout: 0 }]
    });
    // Y2 (Jim, live): AGY's hooks.md defines PreInvocation/PostInvocation/Stop as FLAT lists of
    // handler objects; only the tool events are grouped (`matcher` + `hooks`). A wrapped entry on
    // a flat event fails the parse ("command hook must specify 'command'") and AGY drops the WHOLE
    // group, tool events included: no hive hook ever fired for AGY agents before this.
    const plain = (event: string) => ({ type: 'command', command: this.nodeRunUnquoted(shim, event), timeout: 0 });
    // HOOK-BROKER P4: the observational events go one-way (cheap); the ones that must be able to
    // answer (a PreToolUse deny, a PreInvocation steer, a Stop block) keep the shim. A steer is
    // never taken by a one-way hook (P4 audit Y1); AGY's documented injection point is
    // PreInvocation (`injectSteps`), which fires before every model call.
    const oneway = this.writeAgyOneway();
    const cheapHandler = (event: string) => ({ type: 'command', command: `${oneway} agy ${event}`, timeout: 0 });
    const cheapTool = (event: string) => ({ matcher: '*', hooks: [cheapHandler(event)] });
    const group = {
      PreToolUse: [tool('PreToolUse')],
      PostToolUse: [oneway ? cheapTool('PostToolUse') : tool('PostToolUse')],
      PreInvocation: [plain('PreInvocation')],
      PostInvocation: [oneway ? cheapHandler('PostInvocation') : plain('PostInvocation')],
      Stop: [plain('Stop')]
    };
    const gem = join(homedir(), '.gemini');
    for (const p of [join(gem, 'config', 'hooks.json'), join(gem, 'antigravity-cli', 'hooks.json')]) {
      try {
        mkdirSync(dirname(p), { recursive: true });
        let existing: Record<string, unknown> = {};
        if (existsSync(p)) {
          try { existing = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { existing = {}; }
        }
        existing['munder-hive'] = group;
        writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      } catch { /* best-effort per file */ }
    }
  }

  // — AGY statusline ownership (1.1.48) —
  //
  // hive.ts only INVOKES the lease at startup, before an interactive AGY spawn, and on
  // shutdown. Every decision about the user's settings lives in agyStatuslineOwnership.ts.

  /** AV R1: write `<hive>/bin/claude-status.sh` and return its path with forward slashes (what the
   *  status-line shell reads), or null (not Windows, no hive, or a path needing quoting). */
  private writeClaudeStatusScript(): string | null {
    const root = this.root();
    if (process.platform !== 'win32' || !root) return null;
    const path = join(root, 'bin', 'claude-status.sh').replace(/\\/g, '/');
    if (/[\s"'`$\\]/.test(path)) return null;
    try {
      mkdirSync(join(root, 'bin'), { recursive: true });
      // Other agents' status shells SOURCE this file on every refresh, so it is never
      // rewritten in place (a torn read): unchanged content is left alone, and a change
      // lands whole via a temp file + rename.
      let current: string | null = null;
      try { current = readFileSync(path, 'utf8'); } catch { /* not yet written */ }
      if (current !== CLAUDE_STATUS_SH) {
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, CLAUDE_STATUS_SH, 'utf8');
        renameSync(tmp, path);
      }
      return path;
    } catch { return null; }
  }

  /** P4: write `agy-oneway.cmd` for this hive's pipe and return its path, or null (not Windows,
   *  no hive, or a path AGY could not run unquoted: then the shim is used, as before). */
  private writeAgyOneway(): string | null {
    const root = this.root();
    const sock = this.sockPath();
    if (process.platform !== 'win32' || !root || !sock) return null;
    const path = join(root, 'bin', 'agy-oneway.cmd');
    if (/[\s"']/.test(path) || /[\s"']/.test(sock)) return null;
    try {
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(path, agyOnewayCmd(sock), 'utf8');
      return path;
    } catch { return null; }
  }

  /** The CURRENT AGY statusline lease's owner token (HookServer checks one-way status frames
   *  against it), or null when no lease is held. */
  agyStatuslineOwnerToken(): string | null {
    try { return this.agyStatusline?.ownerToken() ?? null; } catch { return null; }
  }

  /** Path of the endpoint locator a user's own AGY statusline reads. */
  private agyLocatorPath(root: string): string {
    return join(root, 'state', 'agy-statusline-endpoint.json');
  }

  /**
   * Startup: write the shim and give back any lease a dead run left behind - but TAKE
   * nothing; the lease is taken on the first AGY spawn. Stable only.
   *
   * MUNDER_DEV=1 never touches the real Gemini home - the same reason the dev build does
   * not install the global AGY hooks: its pipe is the DEV pipe, and a dev build that
   * leased the user's statusline would point every personal AGY session at it.
   */
  startAgyStatusline(): void {
    if (this.agyStatusline) return;
    if (DEV_ISOLATION) {
      this.appendLog({ kind: 'agy-statusline', code: 'dev-isolation' });
      return;
    }
    // The lease writes the user's GLOBAL Antigravity settings, so it answers to the same
    // gate as the hook installers: never from a hive that is not the configured one.
    if (!this.mayWriteGlobalConfig('Antigravity statusline')) return;
    const root = this.root();
    if (!root) return;
    try {
      const shim = join(root, 'bin', 'agy-statusline.cjs');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(shim, AGY_STATUSLINE_SHIM, 'utf8');
      const locator = this.agyLocatorPath(root);
      const launcher = this.nodeLauncher();
      // AGY passes quote characters literally, so the command is UNQUOTED - which is only
      // possible when no path in it contains whitespace. Checked once, here, with a
      // representative token: if the answer is no, this run never leases at all.
      // HOOK-BROKER P4: on Windows the statusline is the cheap one-way command (plus AGY's own
      // default line beside it); elsewhere the node shim, as before.
      const oneway = this.writeAgyOneway();
      if (!launcher || !buildStatuslineCommand(launcher, shim, '0'.repeat(32), locator)) {
        this.appendLog({ kind: 'agy-statusline', code: 'unsafe-command-path' });
        return;
      }
      const env: StatuslineEnv = {
        geminiHome: geminiHome(),
        // The exact installed string, owner token included, is the ownership identity.
        commandFor: (token) => oneway ? `${oneway} agy-status ${token}` : buildStatuslineCommand(launcher, shim, token, locator) as string,
        stackWithDefault: !!oneway,
        pid: process.pid,
        processStartedAt: PROCESS_STARTED_AT,
        now: () => Date.now(),
        randomToken: newOwnerToken,
        liveness: osLiveness,
        sleep: sleepSync,
        report: (code) => this.appendLog({ kind: 'agy-statusline', code })
      };
      this.agyStatusline = new AgyStatuslineOwner(env);
      // STARTUP TAKES NOTHING. A Munder start with no AGY agent does not touch the user's
      // global AGY settings; the lease is taken on the first AGY spawn. What startup DOES
      // do is give back a value a crashed or killed earlier run left installed.
      recoverStatuslineLeftovers(env);
    } catch (e) {
      // Telemetry. It never blocks startup.
      console.error('[hive] AGY statusline start failed:', e);
    }
  }

  /** Just before an AGY spawn: confirm (or take) the lease, keep the locator in step with
   *  its token, and keep the lease's heartbeat running while one is held. */
  reconcileAgyStatusline(): void {
    const owner = this.agyStatusline;
    const root = this.root();
    const sock = this.sockPath();
    if (!owner || !root || !sock) return;
    try {
      const on = owner.ensure();
      const token = owner.ownerToken();
      const locator = this.agyLocatorPath(root);
      if (on && token && token !== this.agyLocatorToken) {
        writeStatuslineLocator(locator, {
          sock, pid: process.pid, processStartedAt: PROCESS_STARTED_AT, token, createdAt: Date.now()
        });
        this.agyLocatorToken = token;
      } else if (!on && this.agyLocatorToken) {
        removeStatuslineLocator(locator, this.agyLocatorToken);
        this.agyLocatorToken = null;
      }
      // A live instance proves it is alive hourly, so its lease never ages out from under
      // it - and a crashed one's lease does, whatever its recycled pid says.
      if (owner.holdsLease() && !this.agyHeartbeat) {
        this.agyHeartbeat = setInterval(() => {
          try { this.agyStatusline?.heartbeat(); } catch { /* telemetry */ }
        }, AGY_LEASE_HEARTBEAT_MS);
        this.agyHeartbeat.unref?.();
      }
    } catch (e) {
      console.error('[hive] AGY statusline reconcile failed:', e);
    }
  }

  /** Release the lease and withdraw the locator, keeping the owner so a later AGY spawn
   *  can lease again. Idempotent. */
  private releaseAgyLease(): void {
    const root = this.root();
    try {
      if (root && this.agyLocatorToken) removeStatuslineLocator(this.agyLocatorPath(root), this.agyLocatorToken);
    } catch { /* best effort */ }
    this.agyLocatorToken = null;
    if (this.agyHeartbeat) { clearInterval(this.agyHeartbeat); this.agyHeartbeat = null; }
    try { this.agyStatusline?.release(); } catch (e) { console.error('[hive] AGY statusline release failed:', e); }
  }

  /** The last AGY agent has left the floor: the user's statusline goes back to them now,
   *  not at quit. The next AGY spawn takes a fresh lease. */
  agyAgentsGone(): void {
    this.releaseAgyLease();
  }

  /** Quit / reset / change of home: release (restoring the prior value if this was the
   *  last live Munder instance) and forget the owner. Idempotent. */
  stopAgyStatusline(): void {
    this.releaseAgyLease();
    this.agyStatusline = null;
  }

  /** Official Google Gemini CLI lifecycle bridge. Gemini's hook payload is
   *  already snake_case; the shim maps event names into HookServer's common
   *  vocabulary and translates deny/steering replies back to Gemini.
   *
   *  The system settings path is per agent. Gemini merges object and array
   *  settings across layers, so auth and user settings remain in their normal
   *  GEMINI_CLI_HOME while this trusted bridge stays isolated. */
  private installGeminiHooks(dir: string): string {
    const home = join(dir, '.gemini-hive');
    const settingsPath = join(home, 'system-settings.json');
    try {
      mkdirSync(home, { recursive: true });
      const shim = join(home, 'gemini-hook.cjs');
      writeFileSync(shim, GEMINI_HOOK_SHIM, 'utf8');
      const hook = (name: string, matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        sequential: true,
        hooks: [{
          name: `munder-hive-${name}`,
          type: 'command',
          command: this.nodeRunUnquoted(shim),
          timeout: 30000
        }]
      });
      const settings = {
        hooksConfig: { enabled: true, notifications: false },
        hooks: {
          SessionStart: [hook('session-start')],
          BeforeAgent: [hook('before-agent')],
          BeforeTool: [hook('before-tool', '.*')],
          AfterTool: [hook('after-tool', '.*')],
          AfterAgent: [hook('after-agent')]
        }
      };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installGeminiHooks failed:', e); }
    return settingsPath;
  }

  /** Codex lifecycle-hook bridge → full hive parity for a `codex` worker (live
   *  status + Stop→inbox-drain), the codex counterpart of installAgyHooks().
   *
   *  Codex's hook contract is already Claude-shaped: snake_case stdin
   *  (hook_event_name/tool_name/tool_input/session_id/cwd) and a matching response
   *  contract, where `Stop` honoring {decision:'block',reason} means "continue,
   *  using reason as the next prompt" — never used: the Stop reply is non-blocking. So we
   *  reuse the Claude `cth-hook` shim VERBATIM (no translator, unlike agy) and let
   *  HookServer handle everything unchanged.
   *
   *  ISOLATION: rather than mutate the user's global ~/.codex (which also holds
   *  their login), we point this worker at a PER-AGENT CODEX_HOME (`<dir>/.codex`,
   *  alongside Claude's settings.json) holding our own config.toml with `[hooks]`
   *  tables — so the hooks fire ONLY for hive workers and a personal `codex` run is
   *  untouched. Their config.toml is copied + extended (model/provider/trust settings
   *  still apply).
   *
   *  CREDENTIAL (F1). OUTSIDE DEV the user's ~/.codex/auth.json is linked in, so the
   *  isolated home authenticates as them — unchanged v0.4.5 behaviour. UNDER
   *  MUNDER_DEV=1 it is NOT: `codexAuthSeedSource` returns null, the Dev home is left
   *  without a credential, and a `codex login` run inside Dev writes a DEV-OWNED one
   *  here instead. A link left over from before F1 is removed by
   *  `migrateCodexAuthLink`, and if that cannot be done safely this returns a REFUSAL
   *  and the spawn is blocked.
   *
   *  Returns the CODEX_HOME path for the caller to put in the worker's env, or a
   *  refusal the caller must honour. */
  /** AGY-STARTUP-TURN (Codex): put `developer_instructions` at the TOP of a Codex config (a
   *  top-level TOML key must precede the first [table]). A single-line top-level
   *  `developer_instructions` already in the user's seed is replaced (a second one would be a
   *  duplicate key, and Codex would refuse to start); a multi-line one cannot be replaced
   *  safely, so null (the caller keeps the positional prompt). The value is a TOML basic string
   *  (JSON's escapes are valid TOML). */
  static withCodexDeveloperInstructions(config: string, text: string): string | null {
    // N3 (Jim): the key may be written bare or quoted ("developer_instructions" / '...').
    const KEY = /^\s*(["']?)developer_instructions\1\s*=\s*/;
    const lines = config.split(/\r?\n/);
    // N2 (Jim): anything that can REPLACE or OVERRIDE our instructions makes the top-level key
    // unreliable, so keep the positional prompt: a model_instructions_file (or its old name),
    // or developer_instructions inside any table (a profile, possibly the default one).
    if (lines.some((l) => /^\s*(["']?)(model_instructions_file|experimental_instructions_file)\1\s*=/.test(l))) return null;
    const firstTable = lines.findIndex((l) => /^\s*\[/.test(l));
    const topEnd = firstTable < 0 ? lines.length : firstTable;
    if (lines.some((l, i) => i >= topEnd && KEY.test(l))) return null;
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i < topEnd && KEY.test(lines[i])) {
        const v = lines[i].replace(KEY, '');
        // Multi-line strings (''' or """) cannot be removed line-wise with certainty.
        if (/^('''|""")/.test(v)) return null;
        continue;
      }
      kept.push(lines[i]);
    }
    return `# --- munder-hive: this agent's standing hive instructions (auto-generated; do not edit) ---\ndeveloper_instructions = ${HiveManager.tomlString(text)}\n\n${kept.join('\n')}`;
  }

  /** A TOML basic string. JSON's escapes are valid TOML, but JSON leaves U+007F (DEL) raw, and
   *  TOML forbids it unescaped (N4, Jim). */
  static tomlString(text: string): string {
    return JSON.stringify(text).replace(/\u007f/g, '\\u007F');
  }

  /** N1 (Jim): the args of a `codex resume` whose session lives in `ownerHome`. When that is
   *  ANOTHER agent's CODEX_HOME, its config.toml carries the OWNER's developer_instructions, so
   *  THIS agent's own are appended with `-c` (a -c override beats config.toml), and a cross-agent
   *  resume never silently runs under another agent's identity. Unchanged otherwise, or when this
   *  agent has none of ours (then its positional prompt still carries its identity). */
  /**
   * CODEX-NODAEMON-HARDENING: remove the `packages` link an earlier build made in a Codex agent's
   * home, and ONLY that: `link` must be a symbolic link or junction whose target is `expected` (the
   * user's ~/.codex/packages). The link entry is unlinked; its target is never opened, walked or
   * deleted (no rmSync: a recursive remove through a junction would delete the user's install).
   * A real directory, or a link elsewhere, is kept and reported.
   */
  static removeCodexPackagesLink(link: string, expected: string, fs: {
    lstatSync: (p: string) => { isSymbolicLink(): boolean };
    readlinkSync: (p: string) => string;
    unlinkSync: (p: string) => void;
  } = { lstatSync, readlinkSync, unlinkSync }, platform: NodeJS.Platform = process.platform): 'absent' | 'removed' | 'kept-not-a-link' | 'kept-foreign-link' | 'failed' {
    let st: { isSymbolicLink(): boolean };
    try { st = fs.lstatSync(link); } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'failed'; }
    if (!st.isSymbolicLink()) return 'kept-not-a-link';
    const lib = platform === 'win32' ? win32 : posix;
    const norm = (p: string): string => {
      const r = lib.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
      return platform === 'win32' ? r.toLowerCase() : r;
    };
    let target: string;
    try { target = lib.resolve(lib.dirname(link), fs.readlinkSync(link)); } catch { return 'failed'; }
    if (norm(target) !== norm(expected)) return 'kept-foreign-link';
    try { fs.unlinkSync(link); return 'removed'; } catch { return 'failed'; }
  }

  static codexResumeArgs(args: string[], myHome: string | undefined, ownerHome: string): string[] {
    if (!myHome || ownerHome === myHome) return args;
    let own: string | null = null;
    try { own = HiveManager.ownCodexDeveloperInstructions(readFileSync(join(myHome, 'config.toml'), 'utf8')); } catch { own = null; }
    return own ? [...args, '-c', `developer_instructions=${HiveManager.tomlString(own)}`] : args;
  }

  /** N1 (Jim): this agent's OWN developer instructions, read back from the line we write at the
   *  top of its config.toml, or null. A resume that runs under ANOTHER agent's CODEX_HOME passes
   *  them with `-c`, so it never silently takes that agent's identity. */
  static ownCodexDeveloperInstructions(configText: string): string | null {
    const m = /^# --- munder-hive: this agent's standing hive instructions[^\n]*\r?\ndeveloper_instructions = ("(?:[^"\\\r\n]|\\.)*")\s*$/m.exec(configText);
    if (!m) return null;
    try { return JSON.parse(m[1].replace(/\\u007F/g, '\\u007f')) as string; } catch { return null; }
  }

  private installCodexHooks(dir: string, agentId?: string, developerInstructions: string | null = null, toolOutputTokenLimit: number | null = null, inheritPlugins = false, launchModel?: string, autoCompactTokenLimit?: number, cwd?: string, layer: { codexVersion: string | null; optIns?: string[] } = { codexVersion: null }, launchEffort?: string): { home: string; refusal?: string; codexLayerOptIn?: string; developerInstructions?: boolean } {
    let devSet = false;
    const home = join(dir, '.codex');
    // CODEX-TRUST-LAYER T1 (Jim, build round): the layer check must COMPLETE before this agent may
    // start. Until it has, any throw below (the outer best-effort catch) REFUSES a spawn with a cwd.
    let layerChecked = false;
    try {
      mkdirSync(home, { recursive: true });
      // T1: the previous spawn's config.toml carries the trust seed for this cwd. It goes FIRST, so
      // no path (a throw before the check, a failed write after it) can start codex on an old trust
      // entry; it is written again below only once the check has passed. A failed removal throws,
      // and refuses.
      rmSync(join(home, 'config.toml'), { force: true });
      const userHome = join(homedir(), '.codex');
      // Symlink the user's login so the isolated home authenticates as them.
      // (config.toml is NOT symlinked — we write our own below, seeded from theirs,
      // because it must carry our [hooks] tables.) Fall back to copy where symlinks
      // need privilege (Windows). Idempotent — skip if already linked.
      const authDest = join(home, 'auth.json');
      // F1 — the SOURCE decision is a pure policy call; null means the global
      // credential is not a legal source here (DEV). Every global credential source
      // must flow through it, so there is no second path that reaches homedir().
      const authSrc = codexAuthSeedSource({ userCodexHome: userHome });
      if (authSrc === null) {
        // DEV: no seeding, and any pre-F1 link OUT of the dev root is removed first.
        // FAIL CLOSED — a migration we cannot complete blocks the spawn rather than
        // starting Codex on a live external link. Returned, never thrown: a throw
        // would be swallowed by the caller's best-effort catch and the spawn would
        // continue, which is the exact failure this is here to prevent.
        const m = migrateCodexAuthLink({ authDest });
        if (!m.ok) {
          console.error('[dev-isolation] codex credential migration REFUSED:', m.reason);
          return { home, refusal: `refusing to start Codex: ${m.reason}` };
        }
        if (m.action === 'removed-outside-link') {
          console.warn(`[dev-isolation] removed a pre-F1 external Codex credential link at ${authDest} (the link only; the target was not touched)`);
        }
      } else if (existsSync(authSrc) && !existsSync(authDest)) {
        try { symlinkSync(authSrc, authDest); }
        catch { try { copyFileSync(authSrc, authDest); } catch { /* best-effort */ } }
      }
      // CODEX-NODAEMON-HARDENING: no `packages` link into the user's real ~/.codex. $CODEX_HOME/packages
      // is read ONLY by the managed app-server daemon and its self-updater (codex 0.157.1
      // app-server-daemon/src/managed_install.rs), which a hive agent never runs (--no-daemon). The
      // link let a daemon started from an agent home run, and update, the user's own install. A
      // link an earlier build made is removed (the LINK only, never its target).
      const unlinked = HiveManager.removeCodexPackagesLink(join(home, 'packages'), join(userHome, 'packages'));
      if (unlinked !== 'absent') this.appendLog({ kind: 'codex-packages-link', agentId: agentId ?? null, action: unlinked });
      // Wire lifecycle hooks via config.toml `[hooks]` tables — the user-layer
      // discovery surface Codex actually scans. (A bare $CODEX_HOME/hooks.json is
      // plugin-scoped — referenced FROM a plugin manifest — and is NOT discovered
      // for a plain config dir; verified empirically that it never fires.) We seed
      // this config.toml from the user's (their model/provider/trust settings carry
      // over) and append a `[[hooks.<Event>]]` group per event, each pointing at the
      // SAME cth-hook shim — reused verbatim (Codex's hook payload + response are
      // already Claude-shaped, so HookServer runs unchanged). Regenerated
      // each spawn (idempotent). A single-quoted TOML literal avoids path escaping
      // (hive roots are space/quote-free). NOTE: hooks fire in INTERACTIVE codex
      // sessions (how hive workers run), not in headless `codex exec`.
      //
      // `timeout` IS SECONDS HERE — do NOT copy Claude's `timeout: 0` sentinel into
      // this file. Codex parses the key as `timeout_sec` and normalizes it with
      // `timeout_sec.unwrap_or(600).max(1)`, so 0 does not mean "no timeout": it is
      // floored to ONE SECOND, the shortest budget there is. That shipped through
      // v0.3.7 and made every codex worker log `SessionStart hook (failed) — hook
      // timed out after 1s` (same for UserPromptSubmit), because each hook cold-starts
      // the Electron binary via hive-node and then waits on hooks.sock — measured
      // 0.08-0.16s idle but 0.6-0.7s under 8 concurrent spawns, which is exactly what
      // session start and prompt dispatch look like. 30s clears that by two orders of
      // magnitude while still capping a wedged shim well before its own 5s internal
      // cap stops mattering; bare omission (600s) would leave a hang looking like a
      // freeze. Verify any change with codex's own resolver, no model spend:
      // `codex app-server` → initialize → `hooks/list` reports the normalized
      // timeoutSec per event.
      const shim = this.shimPath();
      let config = existsSync(join(userHome, 'config.toml'))
        ? readFileSync(join(userHome, 'config.toml'), 'utf8') : '';
      // MUNDER_DEV=1: the global file carries a nested CODEX_HOME (pointing at
      // ~/.codex) and the user's global project-trust list — strip both so the
      // DEV agent's home inherits settings but not Stable/user identity.
      if (DEV_ISOLATION && config) {
        const s = sanitizeCodexConfigForDev(config, { codexHome: home, pipeSuffix: `dev-${hookPipeId(home)}` });
        config = s.text;
        console.warn(`[dev-isolation] codex config seed for ${home}: rewrote ${s.rewrittenHomes} CODEX_HOME key(s) to the DEV home, made ${s.rewrittenPipes} named pipe(s) DEV-distinct, dropped ${s.droppedTables} [projects.*] trust table(s)`);
      }
      // CODEX-BLOAT-165 fix 5: unless Settings says to inherit them, the seed's plugins
      // (browser, computer-use, documents, ...) are OFF in this agent's copy: each one adds
      // tools and instructions to every request. Only this generated file changes; the user's
      // ~/.codex/config.toml is read, never written.
      if (config && !inheritPlugins) config = disableCodexPlugins(config).text;
      // CODEX-BLOAT-165 fix 6: compact at ~120K instead of the model default (~220-243K
      // measured). Sane only because threads now rotate (fix 1); it replaces a seed's value.
      config = setCodexRootTableKeys(config, '', {
        model_auto_compact_token_limit: codexAutoCompactTokenLimitForAgent(autoCompactTokenLimit),
        // WAKE-SCREEN-GUARD R2-2: Codex 0.157.1's documented root key; false suppresses the
        // startup update prompt (an agent cannot answer it).
        check_for_update_on_startup: false,
        // CODEX-BLOAT-165 fix 2 (Settings): the tool-output cap; Off = no key of ours.
        ...(toolOutputTokenLimit !== null ? { tool_output_token_limit: toolOutputTokenLimit } : {})
      });
      // MEMSPIKE-168: bound the transcript replay on resize. Inline mode (a seed's
      // tui.alternate_screen = "never" or fullscreen_transcript = false) re-emits the entire
      // conversation on every pty resize (1.1 MB per resize on a 200-turn thread, measured;
      // ~35 KB with the reflow cap); the alternate screen answers a resize with ~3 KB.
      // CODEX_TUI_KEYS selects the set (the Human's choice). Only this generated copy changes.
      config = setCodexTuiKeys(config, CODEX_TUI_KEYS);
      // CODEX-MODEL-SWITCH-PROMPT P1 (1.1.78): once either usage window reaches 90 %, Codex 0.157.1
      // opens a modal "Approaching rate limits" picker at a turn's end (tui chatwidget/rate_limits.rs),
      // and it takes every key until answered. An agent cannot answer it (Dwight, 2026-10-01 20:27Z:
      // held 9 h). This key is Codex's own "never show again"; it is written here because this
      // file is regenerated each spawn, and it joins the seed's [notice] table.
      config = setCodexRootTableKeys(config, 'notice', { hide_rate_limit_model_nudge: true });
      // Route A: UserPromptSubmit additionalContext must not be retained as a
      // client developer message after compaction. This is our generated home only.
      config = setCodexFeatureFlags(config, { retain_client_developer_messages: false });
      // MODEL-PINBACK G1: with `--model <picked>` the seed's `model` line is inert; ours names the
      // model the agent really runs. Nothing picked: the seed's line stays and Codex uses it.
      config = setCodexModel(config, launchModel);
      // AGENT-MODEL-NOT-KEPT M2: and the effort it runs (the pin's, else the picker's). None = the
      // seed's line stays, as above for the model.
      config = setCodexReasoningEffort(config, launchEffort);
      // TRUST-SEED-175: the agent's own exact cwd is trusted in ITS copy, AFTER the DEV sanitise
      // above (which drops the user's [projects.*] list), so no codex agent meets the trust screen
      // it cannot answer. One predicate decides the scope (codexTrustSeed.ts); an equal entry the
      // seed already has is never duplicated. Trust also enables <cwd>/.codex/config.toml: its
      // confinement/command keys are logged (the spawn's --sandbox/--ask-for-approval still win).
      const configBeforeSeed = config;
      if (cwd && shouldSeedCodexTrust(cwd, { harnessHome: this.getHome() })) {
        const seeded = withAgentTrust(config, cwd);
        config = seeded.text;
        this.appendLog({ kind: 'codex-trust-seed', agentId: agentId ?? null, action: seeded.action, key: seeded.key });
        const risky = codexProjectLayerRiskKeys(cwd);
        if (risky.length) this.appendLog({ kind: 'codex-trust-project-layer', agentId: agentId ?? null, cwd, keys: risky });
      }
      // CODEX-TRUST-LAYER (the Human's ruling, 1.1.76): a `.codex` layer that loads ONLY because
      // of our seed and carries code (MCP servers start with the agent, hooks run on its first
      // turn, unreviewed: this spawn passes --dangerously-bypass-hook-trust) REFUSES the spawn,
      // visibly, until the Human allows the folder once. Where the user's own codex trust list
      // trusts it, or the folder is allowed, the agent starts with a visible warning. Decided
      // BEFORE config.toml is written; anything unexpected here refuses (fail closed).
      if (cwd) {
        let refusal: { reason: string; optInKey: string } | null = null;
        try {
          const report = codexProjectLayers({ cwd, configBeforeSeed, configAfterSeed: config, codexHome: home, codexVersion: layer.codexVersion });
          const decision = decideCodexLayers(report, layer.optIns);
          if (decision.action !== 'start') {
            this.appendLog({ kind: 'codex-trust-layer', agentId: agentId ?? null, action: decision.action, cwd, folder: report.projectFolder, optInKey: decision.optInKey, codexVersion: layer.codexVersion, layers: decision.layers, unknown: report.unknown, reason: decision.reason });
            try { this.codexLayerSink?.({ agentId: agentId ?? null, action: decision.action, reason: decision.reason, optInKey: decision.optInKey, folder: report.projectFolder, at: Date.now() }); } catch { /* the log row stands */ }
          }
          if (decision.action === 'refuse') refusal = { reason: decision.reason, optInKey: decision.optInKey };
        } catch (e) {
          const reason = `Not started: the check of this agent's codex project folder failed (${e instanceof Error ? e.message : String(e)}), so it is refused rather than started unchecked.`;
          this.appendLog({ kind: 'codex-trust-layer', agentId: agentId ?? null, action: 'refuse', cwd, error: String(e), reason });
          // T2: shown in the window too (no Allow: there is nothing a folder opt-in would fix).
          try { this.codexLayerSink?.({ agentId: agentId ?? null, action: 'refuse', reason, optInKey: '', folder: cwd, at: Date.now() }); } catch { /* the log row stands */ }
          refusal = { reason, optInKey: '' };
        }
        if (refusal) return { home, refusal: refusal.reason, ...(refusal.optInKey ? { codexLayerOptIn: refusal.optInKey } : {}) };
      }
      layerChecked = true;
      if (shim) {
        const events = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
          'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact'];
        // HOOK-BROKER P3: with the broker up, the two high-volume tool hooks become mcp_tool
        // calls into the in-app MCP endpoint (0 processes). Every other event keeps the
        // command shim, and with no endpoint everything is the command shim, as before.
        // Hook trust is not written: this spawn passes --dangerously-bypass-hook-trust.
        const mcp = agentId ? this.hookBroker?.mcpFor?.(agentId) ?? null : null;
        const mcpToml = mcp ? codexMcpHookToml(mcp.url, mcp.token) : null;
        config += '\n# --- munder-hive lifecycle hooks (auto-generated; do not edit) ---\n';
        if (mcpToml) config += mcpToml.server;
        for (const ev of events) {
          if (mcpToml && (MCP_HOOK_EVENTS as readonly string[]).includes(ev)) { config += mcpToml.hook(ev as McpHookEvent); continue; }
          config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = '${this.nodeRunUnquoted(shim)}'\ntimeout = 30\n`;
        }
      }
      if (developerInstructions) {
        const withDev = HiveManager.withCodexDeveloperInstructions(config, developerInstructions);
        if (withDev !== null) { config = withDev; devSet = true; }
        else console.warn(`[hive] ${join(home, 'config.toml')}: the seed defines developer_instructions on several lines; Codex keeps the positional prompt`);
      }
      writeFileSync(join(home, 'config.toml'), config, 'utf8');
    } catch (e) {
      console.error('[hive] installCodexHooks failed:', e); devSet = false;
      // T1: best effort only AFTER the layer check. Before it, a Codex agent with a cwd is refused
      // (with the reason, a log row and a window notice), never started unchecked.
      if (cwd && !layerChecked) {
        const reason = `Not started: preparing this Codex agent failed before its project folder could be checked (${e instanceof Error ? e.message : String(e)}), so it is refused rather than started unchecked. Start it again once the cause is gone.`;
        try { this.appendLog({ kind: 'codex-trust-layer', agentId: agentId ?? null, action: 'refuse', cwd, error: String(e), phase: 'before-check', reason }); } catch { /* the refusal stands */ }
        try { this.codexLayerSink?.({ agentId: agentId ?? null, action: 'refuse', reason, optInKey: '', folder: cwd, at: Date.now() }); } catch { /* the refusal stands */ }
        return { home, refusal: reason };
      }
    }
    return { home, ...(devSet ? { developerInstructions: true } : {}) };
  }

  /** Pi (earendil-works) bridge. Pi has a rich `pi.on(event, …)` lifecycle but no
   *  Claude-shaped hook file; instead we drop a bundled EXTENSION into a PER-AGENT
   *  PI_CODING_AGENT_DIR (so the user's global ~/.pi is never mutated) that, when Pi
   *  loads it, posts cth-hook-shaped payloads to HIVE_SOCK on tool_call/agent_end and
   *  auto-approves tool calls when the floor is in auto mode (HIVE_AUTO_APPROVE).
   *  Emitting an `agent_end`→`Stop` keeps the harness status in step (→ idle), which
   *  lets the renderer idle inbox-wake nudge deliver mail. Returns the per-agent dir
   *  for PI_CODING_AGENT_DIR.
   *
   *  LIVE-UNVERIFIED: Pi's exact extension-discovery path + event API need BYOK keys
   *  to confirm; this is written best-effort and wrapped so a wrong guess can never
   *  break the spawn. The renderer nudge is the guaranteed drain regardless. */
  private installPiHooks(dir: string): string {
    const home = join(dir, '.pi-agent');
    try {
      // Pi discovers extensions under its agent dir; we write to the documented
      // `extensions/` location (and keep it isolated per agent).
      const extDir = join(home, 'extensions');
      mkdirSync(extDir, { recursive: true });
      writeFileSync(join(extDir, 'hive-bridge.js'), PI_EXTENSION, 'utf8');
      // A manifest so Pi auto-loads the extension on start (best-effort; harmless if
      // Pi ignores it). Kept minimal and hive-authored.
      const manifest = { name: 'munder-hive-bridge', version: '0.3.1', main: 'extensions/hive-bridge.js', auto: true };
      writeFileSync(join(home, 'extensions.json'), JSON.stringify(manifest, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installPiHooks failed:', e); }
    return home;
  }

  /** OpenCode (anomalyco/opencode) bridge — god Decision 1 (native plugin, not proxy).
   *  OpenCode has no Claude-shaped Stop hook, but its plugin API exposes a real
   *  `session.idle` lifecycle event. We drop a bundled PLUGIN into a PER-AGENT config
   *  dir's `plugin/` folder (OpenCode auto-loads `*.js` plugins from there) that posts
   *  HIVE_SOCK payloads on tool.execute.before/after + session.idle — the same
   *  Stop→drain semantics as codex's hooks, provider-agnostic, no traffic interception.
   *  Returns the config dir for OPENCODE_CONFIG_DIR (isolates from ~/.config/opencode).
   *
   *  LIVE-UNVERIFIED: plugin auto-load + session.idle firing + the inject path need
   *  BYOK keys to confirm; written best-effort, wrapped so it can't break the spawn.
   *  The renderer idle inbox-wake nudge is the guaranteed drain fallback. */
  private installOpenCodePlugin(dir: string, theme?: 'light' | 'dark'): string {
    const home = join(dir, '.opencode');
    try {
      // Theme: OpenCode's `system` theme keeps the terminal's own fg/bg (xterm's,
      // which already follows the app theme) and builds its greys from the
      // detected background, so it reads right on light AND dark. Written to
      // tui.json (current builds) and opencode.json (older builds read `theme`
      // there and migrate it; the migration skips when tui.json already exists).
      // Per-agent dir only, the user's ~/.config/opencode is never touched.
      if (theme) {
        mkdirSync(home, { recursive: true });
        const choice = { theme: 'system' };
        writeFileSync(join(home, 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', ...choice }, null, 2), 'utf8');
        writeFileSync(join(home, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...choice }, null, 2), 'utf8');
      }
      // BOTH `plugin/` and `plugins/`. OpenCode's current docs specify `plugins/`
      // (plural); older builds — and the shape this bridge was originally written
      // against — auto-load from `plugin/` (singular). Since the whole bridge is
      // LIVE-UNVERIFIED (no BYOK keys to prove which the installed version reads),
      // guessing one of them is a coin flip whose losing side is silent: the plugin
      // simply never loads and the agent's only inbox drain becomes the renderer
      // nudge. Writing the same ~2KB file twice costs nothing, is idempotent, and
      // is correct whichever directory the installed OpenCode actually scans.
      for (const name of ['plugin', 'plugins']) {
        const pluginDir = join(home, name);
        mkdirSync(pluginDir, { recursive: true });
        writeFileSync(join(pluginDir, 'hive-bridge.js'), OPENCODE_PLUGIN, 'utf8');
      }
    } catch (e) { console.error('[hive] installOpenCodePlugin failed:', e); }
    return home;
  }

  /** Crush (charmbracelet/crush) proxy routing. Crush has NO base-URL env override, so
   *  the generic proxy env-rewrite is a no-op for it; instead we write a per-agent
   *  CRUSH_GLOBAL_CONFIG whose standard providers' `base_url` all point at the loopback
   *  proxy (so whatever model the worker picks, its LLM traffic routes through the
   *  sidecar → synthesized Status/Stop/cost → status goes idle → the terminal
   *  work-order + renderer nudge deliver mail). A per-agent CRUSH_GLOBAL_DATA isolates
   *  session state from the user's global ~/.config/crush. Keys ride BYOK env vars
   *  (Crush reads ANTHROPIC_API_KEY/OPENAI_API_KEY/… directly), so none are written
   *  here. `api` follows the proxy's wire shape (advisory). Returns the config + data
   *  paths for the spawn env.
   *
   *  LIVE-UNVERIFIED: the single-upstream proxy serves one provider/endpoint shape at a
   *  time — for full synthesized events pick a model whose provider matches the
   *  configured upstream (or a local OpenAI-compatible endpoint). Cross-provider mixing
   *  is humanQA; the renderer nudge still delivers mail regardless. */
  private installCrushConfig(dir: string, loopbackUrl: string, api: 'openai' | 'anthropic', theme?: 'light' | 'dark'): { config: string; data: string } {
    const config = join(dir, 'crush.json');
    const data = join(dir, '.crush-data');
    try {
      mkdirSync(data, { recursive: true });
      // Override base_url → loopback for ONLY the provider whose wire-shape matches
      // the proxy (`api`): the single-upstream sidecar forwards bytes unchanged, so
      // routing a different-wire/host provider (e.g. anthropic when api='openai', or
      // openrouter/groq which are openai-wire but different hosts) through it would
      // hit the wrong endpoint and the call would fail. Those are left to their real
      // upstreams (working calls, un-proxied — no synthesized events, but mail still
      // drains via the renderer nudge + the pty-quiescence idle fallback). For the
      // default god (openai-wire) and a local OpenAI-compatible endpoint this routes
      // through the proxy cleanly. Cross-provider Crush-via-proxy is on-device
      // live-verify (Dwight verify-crush MF1; the default god model is openai-wire to
      // match). Literal loopback (Dwight's b1 — no ${VAR} expansion edge cases);
      // Crush merges config so only base_url is rewritten.
      const wireProvider = api === 'anthropic' ? 'anthropic' : 'openai';
      const providers: Record<string, { base_url: string }> = { [wireProvider]: { base_url: loopbackUrl } };
      // Theme: Crush ships one (dark) palette and no light theme, but
      // `options.tui.transparent` stops it painting its own background, so it
      // sits on xterm's, which follows the app theme. Set whenever the app
      // passes a theme, dark included, so both modes look the same way.
      const options = theme ? { tui: { transparent: true } } : undefined;
      writeFileSync(config, JSON.stringify(options ? { providers, options } : { providers }, null, 2), 'utf8');
    } catch (e) { console.error('[hive] installCrushConfig failed:', e); }
    return { config, data };
  }

  /** Grok lifecycle-hook bridge → live hive status, session capture, guarded
   *  inbox delivery, and operator gates for `grok` workers.
   *
   *  Grok supports the same hook events and decision vocabulary as Claude Code,
   *  but its stdin payload uses camelCase keys. A small adapter normalizes those
   *  keys to HookServer's Claude-shaped contract. The hook is installed in the
   *  user's global Grok hook directory because global hooks are trusted and
   *  Grok sessions/resume stay in the user's normal GROK_HOME. The adapter is
   *  strictly scoped by AGENT_ID, so ordinary Grok sessions exit without doing
   *  anything. Best-effort and idempotent. */
  private installGrokHooks(): void {
    const root = this.root();
    if (!root) return;
    if (!this.mayWriteGlobalConfig('Grok hook')) return;
    try {
      const shim = join(root, 'bin', 'grok-hook.cjs');
      mkdirSync(join(root, 'bin'), { recursive: true });
      writeFileSync(shim, GROK_HOOK_SHIM, 'utf8');
      const tool = (matcher?: string) => ({
        ...(matcher ? { matcher } : {}),
        // Let Grok apply its event-aware defaults (5s normally, 600s for Stop).
        // Grok is a HOOK bridge (not a proxy sidecar), so it is hit by the same
        // `node: command not found` 127 — bundled node here too.
        hooks: [{ type: 'command', command: this.nodeRun(shim) }]
      });
      const hooks = {
        PreToolUse: [tool('.*')],
        PostToolUse: [tool('.*')],
        Stop: [tool()],
        SubagentStop: [tool('.*')],
        SessionStart: [tool('.*')],
        UserPromptSubmit: [tool()],
        PreCompact: [tool('.*')],
        PostCompact: [tool('.*')]
      };
      const hookDir = join(homedir(), '.grok', 'hooks');
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(
        join(hookDir, 'munder-hive.json'),
        JSON.stringify({ hooks }, null, 2),
        'utf8'
      );
    } catch (e) { console.error('[hive] installGrokHooks failed:', e); }
  }

  /** Write the live fleet snapshot Michael reads (`fleet.json`, gitignored).
   *  Best-effort — called from a timer, must never throw. ZERO-TOKEN-LIVENESS (Jim L6): atomic
   *  (temp file + rename), so a reader (god, a CLI, ZT-I3) never sees a torn file. */
  writeFleetSnapshot(snapshot: unknown): void {
    const root = this.root();
    if (!root) return;
    try { this.atomicWriteJson(join(root, 'fleet.json'), snapshot); } catch { /* noop */ }
  }

  /** Is this agent the hive's god/orchestrator? */
  isGod(agentId: string): boolean {
    try {
      const reg = this.registry();
      return reg.godId === agentId || !!reg.agents[agentId]?.isGod;
    } catch { return false; }
  }

  /** GOD-STARTUP-TOKENS R1: god's spawn chose a fresh start; its first answering hook gets the
   *  handoff. In memory: a restart before that hook makes the same decision again. */
  private godHandoff = new Map<string, { reasons: string[]; previousSession: string | null; contextTokens: number | null; at: number }>();
  armGodHandoff(agentId: string, h: { reasons: string[]; previousSession: string | null; contextTokens: number | null }): void {
    this.godHandoff.set(agentId, { ...h, reasons: [...h.reasons], at: Date.now() });
    this.appendLog({ kind: 'god-handoff-armed', agentId, reasons: h.reasons, previousSession: h.previousSession });
  }

  /** R1: the armed handoff as context (and disarmed), or null. Reads god's memory.md, the floor
   *  digest and the board status from disk now, so the handoff is current. Creed B1: `others` are
   *  the parts joined into the same additionalContext (roster, goal, steer, mail); the handoff is
   *  built to fit MAIL_JOINED_BUDGET with them. Creed N1: one armed longer ago than
   *  GOD_HANDOFF_STALE_MS (its session never started) is dropped, not delivered late. */
  takeGodHandoff(agentId: string, others: Array<string | null | undefined> = []): string | null {
    const h = this.godHandoff.get(agentId);
    if (!h) return null;
    this.godHandoff.delete(agentId);
    if (Date.now() - h.at > HiveManager.GOD_HANDOFF_STALE_MS) {
      this.appendLog({ kind: 'god-handoff-dropped', agentId, reasons: h.reasons, ageMs: Date.now() - h.at });
      return null;
    }
    const joined = others.filter((x): x is string => typeof x === 'string' && x.length > 0);
    const budget = MAIL_JOINED_BUDGET - (joined.length ? joined.join('\n\n').length + 2 : 0);
    const root = this.root();
    const read = (p: string | null): string | null => { try { return p && existsSync(p) ? readFileSync(p, 'utf8') : null; } catch { return null; } };
    const { text, cut } = godHandoffFit({
      reasons: h.reasons, previousSession: h.previousSession, contextTokens: h.contextTokens,
      memory: read(root ? join(this.agentDir(agentId), 'memory.md') : null),
      floorDigest: read(root ? join(root, FLOOR_DIGEST_FILE) : null),
      boardStatus: read(root ? join(root, BOARD_STATUS_FILE) : null)
    }, budget);
    this.appendLog({ kind: 'god-handoff-delivered', agentId, chars: text.length, budget, cut, reasons: h.reasons });
    return text || null;
  }

  /** Creed N1: an armed handoff older than this was for a session that never started. */
  static readonly GOD_HANDOFF_STALE_MS = 10 * 60 * 1000;

  /**
   * A compact, one-shot LIVE ROSTER line built from `fleet.json` — injected into
   * god's context as `additionalContext` on SessionStart and every
   * UserPromptSubmit (see HookServer).
   *
   * Why: fleet.json/registry.json are always fresh on disk (8s snapshot +
   * archiveOrphanedAgents on boot + PTY-exit archiving), but god's CONTEXT is not.
   * After an app restart god resumes a session whose transcript still describes
   * the OLD floor, and it will happily message agents that no longer exist. It is
   * told to read fleet.json, but "told to" is not "always knows" — so we push the
   * truth in on every turn instead. One line, so the cost is negligible.
   *
   * `ctxOf` (optional, supplied by HookServer) lets the caller layer the LIVE
   * context-window occupancy on top of the disk snapshot — each agent gets a
   * `ctx NN%` so god can see at a glance whose context is nearly full when it
   * routes work. fleet.json only carries cumulative `tokens`, which is a spend
   * figure, not how full the CURRENT window is; the real occupancy lives in
   * HookServer.contextById (from the statusLine shim). Omitted when the callback
   * is absent or an agent has no Status tick yet.
   *
   * Returns null when there is nothing to say (no hive, no snapshot, no agents),
   * so the hook stays a no-op rather than injecting noise.
   */
  rosterContext(
    ctxOf?: (agentId: string) => { tokens: number; limit: number } | undefined
  ): string | null {
    const root = this.root();
    if (!root) return null;
    try {
      const raw = readFileSync(join(root, 'fleet.json'), 'utf8');
      const snap = JSON.parse(raw) as {
        ts?: number;
        agents?: Array<{
          id: string; name?: string; role?: string; isGod?: boolean;
          breaker?: string; tokens?: number; usd?: number;
          lastTool?: string | null; lastActiveSecAgo?: number | null; inboxBacklog?: number;
          onHold?: boolean; runningTool?: { name: string; forSec: number } | null;
        }>;
        liveness?: LivenessV1[];
      };
      // CARD-IDLE-WHILE-WORKING: each agent's WORKING / idle comes from its liveness record (a
      // long tool call fires no hooks, so "active 9m ago" alone read as idle).
      const lvById = new Map<string, LivenessV1>();
      for (const r of Array.isArray(snap.liveness) ? snap.liveness : []) if (r && typeof r.agentId === 'string') lvById.set(r.agentId, r);
      const nowMs = Date.now();
      const agents = Array.isArray(snap.agents) ? snap.agents : [];
      if (!agents.length) return null;

      const ago = (s: number | null | undefined): string =>
        typeof s !== 'number' ? 'unknown'
          : s < 90 ? `${s}s ago`
            : s < 5400 ? `${Math.round(s / 60)}m ago`
              : `${Math.round(s / 3600)}h ago`;

      // Cap the list so a big floor can't crowd out the actual prompt. The
      // remainder is still counted, and fleet.json is one Read away.
      const MAX = 24;
      const shown = agents.slice(0, MAX);
      let anyCtx = false;
      let anyHold = false;
      const rows = shown.map((a) => {
        const state = rosterActivity(lvById.get(a.id), nowMs, a.runningTool);
        const bits = [a.role ?? 'agent', ...(state ? [state] : []),
          typeof a.lastActiveSecAgo === 'number' ? `active ${ago(a.lastActiveSecAgo)}` : 'no activity yet'];
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1000)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
        if (a.breaker && a.breaker !== 'ok' && a.breaker !== 'none') bits.push(`breaker ${a.breaker}`);
        if (a.isGod) bits.push('you');
        // First in the row after the role would be louder, but this reads in
        // the same scan as `breaker` and `inbox`, and god already treats those
        // as routing signals.
        if (a.onHold) { bits.push('ON HOLD — 1:1 with the human'); anyHold = true; }
        // Live context-window occupancy from the statusLine shim — lets god see
        // which agents are near-full when routing, instead of guessing from the
        // cumulative token count. Clamp to 0-100; a fresh meter can briefly
        // report more than 100% before a window rotation.
        const cw = ctxOf?.(a.id);
        if (cw && cw.limit > 0) {
          const pct = Math.max(0, Math.min(100, Math.round((cw.tokens / cw.limit) * 100)));
          bits.push(`ctx ${pct}%`);
          anyCtx = true;
        }
        return `${a.id}${a.name ? ` "${a.name}"` : ''} (${bits.join(', ')})`;
      });
      const more = agents.length > shown.length ? ` +${agents.length - shown.length} more` : '';
      const age = typeof snap.ts === 'number' ? ago(Math.round((Date.now() - snap.ts) / 1000)) : 'unknown';

      return `[LIVE ROSTER — auto-injected from ${join(root, 'fleet.json')}, snapshot ${age}] `
        + `${agents.length} ACTIVE agent(s): ${rows.join('; ')}.${more} `
        + 'This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — '
        + 'agents you remember that are absent here have been archived or killed, so do not message them. '
        + (anyCtx
          ? '`ctx NN%` = live window occupancy; absent = not yet reported (unknown, not empty). '
          : '')
        + (anyHold
          ? 'An agent marked `ON HOLD — 1:1 with the human` is UNAVAILABLE: the human is working '
            + 'with them directly. Do NOT message them, do NOT dispatch to them, and do NOT count '
            + 'them when picking an owner. Route to someone else, or say the work is waiting. They '
            + 'are still running and their terminal is alive, so this is not a reason to archive '
            + 'them or spawn a replacement. The human flips it off when they are done. '
          : '')
        + 'Route work to someone on this list before spawning anyone new.';
    } catch { return null; }
  }
  /**
   * The last `n` events, read from the END of the log rather than through all of it.
   *
   * THE 1.1.49 CRAWL. This used to be
   *   readFileSync(whole file).trim().split('\n')
   * to return 200 lines. It is called on the ELECTRON MAIN PROCESS - by `hive:log`, which
   * the Command Center's Activity tab polls every 3 SECONDS, and by the heartbeat digest -
   * so its cost is time the main thread is BLOCKED: no IPC, no PTY pumping, no wake path.
   * Against the 61 MB log this floor had actually grown, one call measured 328 ms and
   * allocated the file three times over (the string, the trimmed copy, a 380,900-element
   * array) to keep 60 rows. Polled every 3s that is ~11% of wall-clock with main frozen,
   * and it gets monotonically worse as the log grows, in EVERY app built on this hive -
   * which is why a second one appearing was enough to tip the first into "crawl".
   *
   * Now it reads a bounded window off the tail and grows it only if `n` lines are not in
   * it, so cost tracks what was ASKED FOR, not what the file happens to weigh. Output is
   * byte-identical to reading the whole file; the test pins that, including the case where
   * the window splits a line.
   */
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root || n <= 0) return [];
    const live = join(root, 'log.jsonl');
    // LOG-STALL-AV: the log rotates, so a tail that the live file cannot fill continues into
    // the rotated files, newest first. Each is read with the same bounded tail window.
    const files = [...rotatedFiles(live).map((r) => r.path), ...(existsSync(live) ? [live] : [])];
    const parse = (l: string): unknown => { try { return JSON.parse(l); } catch { return { raw: l }; } };
    let rows: unknown[] = [];
    for (let i = files.length - 1; i >= 0 && rows.length < n; i--) {
      rows = [...this.fileTail(files[i], n - rows.length, parse), ...rows];
    }
    return rows;
  }

  /** The last `n` rows of one log file (bounded tail read; the logic logTail always had). */
  private fileTail(file: string, n: number, parse: (l: string) => unknown): unknown[] {
    if (n <= 0 || !existsSync(file)) return [];
    try {
      const size = statSync(file).size;
      if (size === 0) return [];
      let fd: number | null = null;
      try {
        fd = openSync(file, 'r');
        // Grow the window until it holds n+1 line starts (so we know the first line in it
        // is whole) or we have read the entire file.
        for (let want = Math.min(size, LOG_TAIL_WINDOW_BYTES); ; want = Math.min(size, want * 4)) {
          const from = size - want;
          const buf = Buffer.alloc(want);
          readSync(fd, buf, 0, want, from);
          let text = buf.toString('utf8');
          // A window that starts mid-file almost certainly starts mid-LINE. Drop that
          // fragment: keeping it would hand back a corrupt row, and JSON.parse failing on
          // it would surface as a bogus {raw} event rather than an error anyone notices.
          if (from > 0) {
            const nl = text.indexOf('\n');
            if (nl === -1) { if (want >= size) return []; continue; }
            text = text.slice(nl + 1);
          }
          const lines = text.split('\n').filter(Boolean);
          if (lines.length >= n || want >= size) return lines.slice(-n).map(parse);
        }
      } finally { if (fd !== null) closeSync(fd); }
    } catch {
      // Any read problem falls back to the whole-file path: correctness over speed, and a
      // log small enough to be unreadable this way is small enough for it not to matter.
      const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-n).map(parse);
    }
  }

  private listMessages(dir: string): HiveMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as HiveMessage; } catch { return null; } })
      .filter((m): m is HiveMessage => m !== null);
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    // A kept-open descriptor, rotated at 8 MB: no open/close (so no antivirus rescan) per row.
    this.appendFileFor(join(root, 'log.jsonl'), LOG_KEEP_ROTATED).append(line);
  }

  /**
   * Append one cost sample to the durable, append-only ledger at
   * `<root>/cost-ledger.jsonl` (Lane A #6.6d). This is the SOLE durable cost
   * store; its row is exactly the shape Kevin (#4) reserves for the cost_ledger
   * SQLite table, so migration is a mechanical INSERT…SELECT.
   *
   * 🔒 PII: persist ONLY the allowlisted AgentUsageSample — NEVER a raw OTel
   * record (those carry user.email / account / org / hashed-user-id). The sample
   * is PII-free by construction upstream (the provider's normalize step), so we
   * add no redaction here; we just must not widen what we write. The file lives
   * at the hive ROOT, so the memory engine (which indexes only agents' Markdown)
   * never ingests it.
   *
   * Like appendLog: append to disk now (durable immediately). Best-effort — never throws
   * into the beat.
   */
  appendCostLedger(sample: AgentUsageSample): void {
    const root = this.root();
    if (!root) return;
    // Fully snake_case so the row maps 1:1 onto Kevin's (#4) cost_ledger SQLite
    // columns (agent_id, session_id, ts, input, output, cache_read,
    // cache_creation, model, usd) — migration is a straight INSERT…SELECT.
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd
    };
    // Kept open and rotated like the log, but every rotated ledger is KEPT: the lifetime cost
    // is folded from all of them (costLifetime.ts reads across the rotation).
    this.appendFileFor(join(root, 'cost-ledger.jsonl'), Infinity).append(JSON.stringify(row) + '\n');
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  /**
   * Read a source of truth which may later be read-modify-written. Unlike a
   * cache, invalid JSON must never become an empty in-memory ledger: that turns
   * the next write into silent data loss. Preserve the original in place, keep
   * one byte-identical quarantine copy for repair, log it, and make the caller
   * fail so its write is refused.
   */
  private readAuthoritativeJson<T>(p: string, onMissing: () => T): T {
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.quarantinedJsonFingerprints.delete(p);
        this.authorityIssues.delete(p);
        return onMissing();
      }
      throw new Error(`Hive authority ${basename(p)} could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const parsed = JSON.parse(raw) as T;
      this.quarantinedJsonFingerprints.delete(p);
      this.authorityIssues.delete(p);
      return parsed;
    } catch (error) {
      const fingerprint = createHash('sha256').update(raw).digest('hex');
      let quarantine: string | null = this.authorityIssues.get(p)?.quarantine ?? null;
      if (this.quarantinedJsonFingerprints.get(p) !== fingerprint) {
        quarantine = `${p}.corrupt-${Date.now()}-${shortRand()}`;
        try {
          copyFileSync(p, quarantine);
          this.quarantinedJsonFingerprints.set(p, fingerprint);
        } catch (copyError) {
          quarantine = null;
          console.error(`[hive] could not quarantine corrupt ${basename(p)}:`, copyError);
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      const issue: HiveIntegrityIssue = { file: basename(p), quarantine: quarantine ? basename(quarantine) : null, error: detail };
      this.authorityIssues.set(p, issue);
      try {
        this.appendLog({ kind: 'hive-authority-corrupt', file: basename(p), quarantine: quarantine ? basename(quarantine) : null, error: detail });
      } catch (logError) {
        console.error(`[hive] could not log corrupt authority ${basename(p)}:`, logError);
      }
      throw new HiveAuthorityCorruptError(issue);
    }
  }
  private writeJson(p: string, data: unknown): void {
    this.atomicWriteJson(p, data);
  }
  private atomicWriteJson(p: string, data: unknown): void {
    atomicWriteJsonFile(p, data);
  }

}

/** CODEX-BLOAT-165 fix 7: the output-hygiene rule in a Codex agent's developer_instructions.
 *  Stable text (no volatile values), so the instructions stay prompt-cache-stable. */
export const CODEX_OUTPUT_HYGIENE_LINE = 'OUTPUT HYGIENE (every tool output stays in your context and is re-sent with every later request): never print a whole file, log or CSV. Read what you need: a line range or head/tail (Get-Content -TotalCount N / -Tail N, head, tail, sed -n), or matches (rg, Select-String). Cap command output (| Select-Object -First 50, | head -50). Write large results to a file and report a short summary plus its path. Make big edits with small apply_patch hunks or by writing a file; never echo a whole file back.';

/** ZT-I1-MAIL §11.12(c): part of P1 for every agent, so a lesson recorded under an older build
 *  cannot override the current mail rules after an upgrade or a rollback. */
export const MAIL_RULES_NOT_IN_MEMORY = 'Mail handling is defined by the current protocol text, not by your memory: do not record mail-handling rules in memory.md.';

/**
 * Line 1 of the spawn prompt's HIVE PROTOCOL (ZT-I1-MAIL §5 P1, §11.7, §11.12(c)).
 *  - inject: mail arrives in context as a <hive-mail> block; the agent never reads, lists or
 *    moves inbox files (the harness archives them at the Stop that completes the turn);
 *  - legacy-read: the agent reads the files, never moves them (the harness archives at Stop);
 *  - legacy-move: no Stop signal (cursor, terminal work-order agents, an agent degraded for zero
 *    hook traffic): the 1.1.74 text, read AND move handled files into .done.
 * Native-separator paths (the 🪟 note on injectedPrompt).
 */
export function protocolLineOne(mode: MailPromptMode, semanticMemory: boolean, memoryMd: string, inboxDir: string, doneDir: string): string {
  const memory = semanticMemory
    ? `1. At the START of a task, read the \`## How I work (standing lessons)\` section at the top of ${memoryMd} (your method lessons; follow them); then run \`memory wake-up\` for a digest of your memory and \`memory search "<query>"\` for anything specific; do NOT read ${memoryMd} whole (if you must open it, read only its last ~40 lines; older notes are in memory-archive-*.md and \`memory search\` covers them).`
    : `1. At the START of a task, read the \`## How I work (standing lessons)\` section at the top of ${memoryMd} (your method lessons; follow them); then read the LAST ~40 lines of ${memoryMd} (the newest notes; do NOT print the whole file; older notes are in memory-archive-*.md, search them with grep when needed).`;
  const mail = mode === 'inject'
    ? 'Messages for you arrive inside your context as a <hive-mail> block; the harness tracks them. You do not read, list or move inbox files. If a message is marked re-delivered, check whether you already handled it.'
    : mode === 'work-order'
      // Creed Q26: the whole message is typed into this terminal; it is handled at that write.
      ? 'Messages for you are typed into this terminal as hive work orders, each one in full; the harness records them. You do not read, list or move inbox files.'
    : mode === 'legacy-read'
      ? `Then read EVERY file in ${inboxDir} (messages other agents sent you) and act on each. Leave the files where they are: the harness archives each message when your turn ends.`
      : `Then read EVERY file in ${inboxDir} (messages other agents sent you). After handling an inbox message, move its file into ${doneDir}.`;
  return `${memory} ${mail} ${MAIL_RULES_NOT_IN_MEMORY}`;
}

// ─── PROTOCOL.md (written into the hive, readable by every agent) ────────────

/** The Claude Code command reference written to <hive>/COMMANDS.md, rendered from
 *  the SAME source as the UI "commands" tab so they never drift. Leads with the
 *  orchestrator note: slash = own session only, cli = shell/fleet; monitor
 *  siblings via fleet.json (claude agents does NOT see them). */
function renderCommandsMd(): string {
  const lines: string[] = [
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    '- **slash** commands act ONLY on your own session — you CANNOT run them on another agent\'s terminal.',
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    ''
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const COMMANDS_MD = renderCommandsMd();

const PROTOCOL_MD = `# Hive protocol

You are one of several Claude agents sharing this hive. Coordination is entirely
file-based; the harness (main process) is the only thing that moves messages
between agents.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Its \`## How I work (standing lessons)\` section, at the top,
  holds your METHOD lessons (how you work): read it at the start of every task, and put new method
  lessons there as bullets or \`###\` subheadings, not dated facts (a \`##\` heading ends the section;
  keep it under ~6 KB; merge and shorten lessons when it grows). Then
  run \`memory wake-up\` (semantic memory on) or read only the last ~40 lines; never print it whole.
  Append facts and decisions at the end as you learn. Above 32 KB the app moves the older part to
  \`memory-archive-<date>.md\`, which \`memory search\` still finds; the standing lessons are never archived.
- \`inbox/\`, \`inbox/.done/\` — harness-owned storage of the messages addressed to you (\`.done/\` =
  handled). You may read them for history; how mail reaches you is below.
- \`outbox/\`      — drop messages here to send them. The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Receiving mail
Messages for you arrive inside your context as a \`<hive-mail>\` block (at the start of a turn, or
after a tool call); the harness tracks them and archives each one into \`inbox/.done/\` itself once
the turn in which you saw it ends. You do not read, list or move inbox files. If a message is marked
re-delivered, check whether you already handled it.

Exception: an agent whose CLI cannot receive the block is told how to take its mail in its own
start-up instructions (it reads the files itself). Follow those instructions.

Mail handling is defined by the current protocol text, not by your memory: do not record
mail-handling rules in memory.md.

## Sending a message
Write one JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)",
  "supersedes": ["<id of an earlier message this one cancels or corrects>"] (optional),
  "wake": "now" (optional: an inform or agree that must be read at once)
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

A message that answers a request its sender had already been sent a \`supersedes\` for, still
unread, is delivered flagged: the harness sets \`superseded_by\` and prefixes the subject.

## The ledger command
One call that updates a task card, sends one message and notes memory (each part optional),
applied by the app: every check passes before anything is written, and the reply is one line.
Never put the JSON in shell arguments (backticks and \`$(...)\` in a body would run); give it in
a file or on stdin:

\`\`\`bash
ledger <<'EOF'
{ "op": "creed-181-3",
  "card":    { "id": "READS-181", "patch": { "status": "done" }, "appendResult": "built; Jim audits" },
  "message": { "to": "god", "act": "done", "subject": "READS-181 built", "body": "...", "in_reply_to": "<id>" },
  "memory":  { "append": "- 2026-10-03 READS-181 built ...", "lesson": false } }
EOF
\`\`\`

- \`op\`: a unique name for this operation. Running the same op again finishes what is left and
  never repeats a part, so a failed or timed-out call is safe to retry.
- \`card\`: \`create\` (title required; refused if the id exists) or \`patch\` (refused if it does
  not); \`appendResult\` / \`appendNote\` add a timestamped line. A patch changes only the fields it
  names, so the assignee is kept unless you give one.
- \`message\`: the schema above; \`to\` must be a registered agent, \`god\` or \`broadcast\`.
- \`memory\`: \`append\` goes at the end of your memory.md; \`"lesson": true\` puts it at the end of
  your standing lessons instead (no \`## \` headings).
In PowerShell: \`@' {...} '@ | ledger\`. Or write the JSON with your file tool and run
\`ledger --file op.json\`.

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- An \`inform\` or \`agree\` that needs no reply does not wake an idle recipient: it reaches the
  recipient with its next turn, or within 30 minutes at most. Send a result (a verdict, "merged",
  "passed") as \`done\`, which wakes at once, and add \`"wake": "now"\` to an \`inform\` that must be
  read at once. Mail from the human, the floor digest and the harness always wakes.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\` — the
  god agent clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`god\` (a message \`"to": "human"\` is routed to
  the god/orchestrator, the human's proxy on the floor).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`god\`,
  who is its sole scribe.
- A message in \`inbox/.done/\` has been handled. Don't reprocess it.

## The work: board.md vs tasks.json
There are two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. The god agent is its sole scribe; others \`propose\` edits.
- \`tasks.json\` — the structured task ledger (a kanban: \`todo / doing / blocked / done\`, with title,
  assignee, priority, deps). Keep the task you're working reflected in its status.
- \`board-status.md\` and \`floor-digest.md\` — written by the harness from tasks.json, its flags
  (stale, archived or down assignees, duplicate ids) and fleet.json. Read them; never edit them.

## Guardrails: circuit breaker & token budgets
A circuit breaker watches every agent for runaway behavior (looping on the same tool, error storms,
overspending). It escalates gently: \`steer\` → \`constrain\` → \`stop\`. If a \`Circuit breaker: steer\`
or \`Circuit breaker: constrain\` message lands in your inbox, you ARE the problem it caught — stop
repeating, summarize what you've tried, and do exactly what the message says (constrain = go read-only
and get god's sign-off before more tool calls). Be **token-frugal**: the floor has a token budget and
each agent can have its own token limit; crossing it trips the breaker. Prefer references over pasted
content, and \`/compact\` your own session when context gets heavy.

## Fleet monitoring (orchestrator)
You (god) are responsible for situational awareness. To see the live state of every agent, read
\`fleet.json\` in the hive root — it is refreshed continuously with each agent's tokens, cost, status,
breaker level, last tool, last-active time, mail backlog (\`inboxBacklog\`: not yet handled), and the
requests still owed a reply (\`awaitingReply\`, \`openRequests\`, each with its age). Pair it with \`registry.json\` (the roster)
and \`log.jsonl\` (the event feed; it rotates at 8 MB, so older rows are in \`log.*.jsonl\`, search \`log*.jsonl\`). IMPORTANT: \`claude agents\` will NOT show your hive's sibling
sessions (they're spawned independently) — \`fleet.json\` is your source of truth for them. For a deeper
look at one agent, read its \`agents/<id>/memory.md\` and its mail (\`inbox/\`, \`inbox/.done/\`), or send it a \`query\`. A full
Claude Code command reference (slash = your own session only; CLI = your shell, can target the fleet)
is in \`COMMANDS.md\` in the hive root.

## Spawning a worker (orchestrator)
You can start an ephemeral worker yourself. Write ONE JSON file into \`spawn-requests/<id>.json\` in
the hive root:

\`\`\`json
{
  "objective": "what the worker must do (required)",
  "cwd": "/absolute/path/to/the/repo (required)",
  "name": "display name (optional)",
  "command": "engine CLI (optional; defaults to the configured one)",
  "provider": "claude | codex | cursor | antigravity | … (optional)",
  "model": "model override (optional)",
  "isolate": true,
  "tokenCap": 0,
  "slack": { "channel": "C…", "thread_ts": "…" },
  "character": "meredith",
  "accent": "coral"
}
\`\`\`

The harness polls that directory, spawns \`worker-<id>\`, and moves the request to
\`spawn-requests/.done/\` once it starts or to \`spawn-requests/.failed/\` with a reason. \`isolate\`
defaults to true, giving the worker its own git worktree. \`slack\` routes its failures back to a
thread. This is the ONLY spawn route you can complete on your own: a hire manifest under
\`research/hires/\` needs the human to confirm it in the UI.

\`character\` and \`accent\` set how the worker looks on the office floor, and both are optional.
Naming a worker after a cast member already gets you that avatar, so you only need \`character\` when
the name and the face should differ. An unrecognised value falls back rather than failing the spawn.

**It can be switched off.** The operator controls this under Settings → Autonomy & Budgets, and it is
OFF by default, because every worker you start spends tokens nobody approved. While it is off your
request is NOT failed or deleted, it waits in \`spawn-requests/\` and runs if the operator turns it on.
If a request of yours has sat there without moving, that is why, and it is a decision to raise with the
human rather than retry. Route work to an agent already on the floor first either way.

## Semantic memory (the built-in memory engine)
When semantic memory is on (Settings; the default), the hive shares a searchable
memory and you have the \`memory\` command, served by the app's memory engine:
- \`memory search "<query>"\` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`memory wake-up\` — a short digest of what matters, good at the start of a task.

Your \`memory.md\` is indexed automatically, so the durable facts you write there
become searchable by every agent. There is no \`mine\` step.
`;

// ─── cth-hook shim (written to <hive>/bin/cth-hook.cjs) ──────────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the hive's UDS, and relay the response back to `claude`. All the
// real logic lives in the main process (HookServer). Never blocks a stop on error.
/** 1.1.53 AV R1: the Claude status line as a SOURCED shell script (builtins only, no process).
 *  LF line endings are load-bearing (bash reads a CR as part of the command). */
export const CLAUDE_STATUS_SH = "# Munder Difflin: the Claude status line (1.1.53 AV R1). Generated; do not edit.\n# SOURCED by the shell Claude runs the statusLine command in (\". <this> port id token\"),\n# and it uses shell BUILTINS only, so a refresh starts no process: before, each one\n# started hive-node.cmd and the ~180 MB Electron binary as Node (~5 processes, ~630 ms).\n# It reads the status JSON from stdin, POSTs it to the app's loopback hook broker over\n# bash's /dev/tcp, and prints the reply (the context gauge). Any failure prints nothing.\n# PERF153-R1 (1.1.77): a reply that does not COMPLETE within the read timeouts (a loaded machine)\n# prints nothing, never its headers, and nothing is printed before the server's EOF.\n__munder_status() {\n  local LC_ALL=C body='' line seen='' out='' rc\n  while IFS= read -r line || [ -n \"$line\" ]; do body+=\"$line\"$'\\n'; done\n  { exec 3<>\"/dev/tcp/127.0.0.1/$1\"; } 2>/dev/null || return 0\n  printf 'POST /status/%s/%s HTTP/1.0\\r\\nHost: 127.0.0.1\\r\\nContent-Type: application/json\\r\\nContent-Length: %d\\r\\n\\r\\n%s' \"$2\" \"$3\" \"${#body}\" \"$body\" >&3\n  while IFS= read -r -t 2 line <&3; do line=${line%$'\\r'}; [ -z \"$line\" ] && { seen=1; break; }; done\n  [ -n \"$seen\" ] || { exec 3<&- 3>&-; return 0; }\n  while :; do IFS= read -r -t 2 line <&3; rc=$?; out+=\"$line\"; [ $rc -eq 0 ] && continue; [ $rc -gt 128 ] && out=''; break; done\n  exec 3<&- 3>&-\n  printf '%s' \"$out\"\n  return 0\n}\n__munder_status \"$@\"\nunset -f __munder_status\n";

/** The broker URL's parts, for the status-line command; null when the URL is not ours or an
 *  id could need shell quoting (the caller then keeps the command shim). */
export function brokerUrlParts(url: string | null): { port: number; agentId: string; token: string } | null {
  const m = url ? /^http:\/\/127\.0\.0\.1:(\d{1,5})\/hook\/([A-Za-z0-9._-]+)\/([0-9a-f]{32})$/.exec(url) : null;
  return m ? { port: Number(m[1]), agentId: m[2], token: m[3] } : null;
}

/** JOB-ENV (SessionStart): the shim arguments that carry the agent's own id. Omitted for an
 *  id that could need shell quoting (the shim then falls back to env AGENT_ID, as before). */
export function hookShimArgs(agentId: string | undefined): string[] {
  return agentId && /^[A-Za-z0-9._-]+$/.test(agentId) ? ['--agent', agentId] : [];
}

/** The statusLine command that sources the script: every part is quote-free by construction. */
export function claudeStatusCommand(scriptPath: string, parts: { port: number; agentId: string; token: string }): string {
  return `. '${scriptPath}' ${parts.port} ${parts.agentId} ${parts.token}`;
}

export const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const isStatus = process.argv.includes('--status');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  // CODEX-HOOK-AGENTID: the hive's own id always wins. A provider may put ITS agent_id in
  // the payload (a Codex or Claude subagent); that value is kept as provider_agent_id.
  // JOB-ENV (SessionStart): the id comes from the per-agent settings file (--agent <id>)
  // first. A Claude Code background job runs in a shared daemon whose env belongs to
  // whichever agent started it, so env AGENT_ID can name ANOTHER agent there. A
  // disagreeing env id is passed along as env_agent_id, for the mismatch row.
  const argAt = process.argv.indexOf('--agent');
  const argId = argAt > 0 && process.argv[argAt + 1] && !process.argv[argAt + 1].startsWith('--') ? process.argv[argAt + 1] : null;
  const envId = process.env.AGENT_ID || null;
  const hiveId = argId || envId;
  delete payload.env_agent_id; // only this shim may set it
  if (argId && envId && envId !== argId) payload.env_agent_id = envId;
  delete payload.provider_agent_id; // only this shim may set it (N3)
  if (payload.agent_id && payload.agent_id !== hiveId) payload.provider_agent_id = payload.agent_id;
  payload.agent_id = hiveId || payload.agent_id || null;
  delete payload.munder_wake_incarnation; // WAKE-SCREEN-GUARD R2-4: only this shim may set it
  if (process.env.MUNDER_WAKE_INCARNATION) payload.munder_wake_incarnation = process.env.MUNDER_WAKE_INCARNATION;
  const sock = process.env.HIVE_SOCK;
  if (isStatus) {
    // Status-line mode: Claude Code pipes the session status JSON (incl.
    // context_window.total_input_tokens / .context_window_size) after every
    // response. Print the in-terminal gauge IMMEDIATELY (the TUI is waiting),
    // then forward the payload to the harness fire-and-forget so the agent
    // card's context gauge updates push-based, with the EXACT window size.
    payload.hook_event_name = 'Status';
    const cw = payload.context_window || {};
    const used = cw.total_input_tokens, size = cw.context_window_size;
    if (typeof used === 'number' && typeof size === 'number' && size > 0) {
      const pct = Math.round((used / size) * 100);
      process.stdout.write('ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)');
    }
    if (sock) {
      try {
        const c = net.createConnection(sock, () => { c.end(JSON.stringify(payload) + '\\n'); });
        c.on('error', () => {});
        c.on('close', () => process.exit(0));
      } catch (_) { process.exit(0); }
    } else {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
    return;
  }
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  // MAIL-PIPE-SHIM-CLOCK (1): how long this shim had been running when it sent its request (its
  // 5 s give-up timer starts here), so the server's on-time measure includes the time before
  // its own read of the request (a descheduled shim, a busy server).
  const t0 = Date.now();
  const c = net.createConnection(sock, () => { payload.shim_elapsed_ms = Date.now() - t0; c.write(JSON.stringify(payload) + '\\n'); });
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  // MAIL-PIPE-SHIM-CLOCK (a): at the give-up, first take what is already in the pipe (two loop
  // turns: the poll phase delivers it) and print it when it is a complete reply; else exit empty.
  const complete = () => { try { JSON.parse(resp); return resp.length > 0; } catch (_) { return false; } };
  const giveUp = (turns) => setImmediate(() => { if (complete()) done(0); else if (turns > 0) giveUp(turns - 1); else process.exit(0); });
  setTimeout(() => giveUp(2), 5000).unref();
});
`;

// ─── agy-hook shim (written to <hive>/bin/agy-hook.cjs) ──────────────────────
// Antigravity's `agy` CLI fires lifecycle hooks (PreToolUse/PostToolUse/Stop/
// PreInvocation/PostInvocation) but with a DIFFERENT stdin shape than Claude
// (conversationId / toolCall{name,args} / workspacePaths, and no hook_event_name
// — the event arrives as argv from the hooks.json command). This shim normalizes
// that into the same HookPayload the HookServer already consumes, so status,
// inbox-drain-on-Stop, and tool gating are reused UNCHANGED, then translates the
// server's Claude-shaped response back into agy's stdout contract (decision:
// allow|deny|block + a message). Scoped by AGENT_ID: a personal agy session
// (no AGENT_ID in env) is a no-op, so the global hooks.json never disturbs the
// user's own agy usage — only hive workers (spawned with AGENT_ID set) bridge.
// NOTE (agy bug, antigravity-cli#49): the loader reads ~/.gemini/antigravity-cli/
// hooks.json but the trigger reads ~/.gemini/config/hooks.json — we write BOTH.
export const AGY_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const event = process.argv[2] || 'Unknown';
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); } // not a hive worker → ignore
  let agy = {};
  try { agy = JSON.parse(data || '{}'); } catch (_) {}
  const tc = agy.toolCall || {};
  const payload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: agy.conversationId,
    transcript_path: agy.transcriptPath,
    cwd: Array.isArray(agy.workspacePaths) ? agy.workspacePaths[0] : undefined,
    tool_name: tc.name,
    tool_input: tc.args,
    // agy's OWN terminal qualifier on Stop. The shim used to drop it, which is how a
    // mid-chain Stop looked exactly like the end of a turn. Only a real boolean is
    // forwarded - anything else stays undefined, which keeps the Claude reading.
    // Both spellings are read because only one of them has been measured.
    fully_idle: typeof agy.fullyIdle === 'boolean' ? agy.fullyIdle
      : (typeof agy.fully_idle === 'boolean' ? agy.fully_idle : undefined)
  };
  let resp = '';
  const done = () => {
    // Translate the HookServer's Claude-shaped reply into agy's contract. CRITICAL:
    // agy treats ANY object written to stdout as a decision and FAIL-CLOSES (an
    // empty/decision-less object = DENY). So emit JSON ONLY when there's a real
    // directive (deny/block/steer); otherwise write NOTHING — no output = allow.
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.decision === 'block') out = { decision: 'block', reason: r.reason, stopReason: r.reason, systemMessage: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      else if (r.continue === false) out = { decision: 'block', stopReason: r.stopReason };
      // PreInvocation's documented output (agy hooks.md): injectSteps. A userMessage persists in
      // the conversation (an ephemeralMessage lasts one model call); an operator steer must stick.
      else if (event === 'PreInvocation' && r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { injectSteps: [{ userMessage: r.hookSpecificOutput.additionalContext }] };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) out = { systemMessage: r.hookSpecificOutput.additionalContext };
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    // MAIL-PIPE-SHIM-CLOCK (1): how long this shim had been running when it sent its request (its
    // 5 s give-up timer starts here), so the server's on-time measure includes the time before
    // its own read of the request (a descheduled shim, a busy server).
    const t0 = Date.now();
    const c = net.createConnection(sock, () => { payload.shim_elapsed_ms = Date.now() - t0; c.write(JSON.stringify(payload) + '\\n'); });
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    // MAIL-PIPE-SHIM-CLOCK (a): at the give-up, first take what is already in the pipe (two loop
    // turns: the poll phase delivers it) and print it when it is a complete reply; else exit empty.
    const complete = () => { try { JSON.parse(resp); return resp.length > 0; } catch (_) { return false; } };
    const giveUp = (turns) => setImmediate(() => { if (complete()) done(); else if (turns > 0) giveUp(turns - 1); else process.exit(0); });
    setTimeout(() => giveUp(2), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── pi bridge extension (written to <agentDir>/.pi-agent/extensions/) ───────
// A bundled extension for Pi (earendil-works). Pi exposes a pi.on(event,…)
// lifecycle; this posts cth-hook-shaped payloads to HIVE_SOCK on tool_call /
// tool_result / agent_end and AUTO-APPROVES tool calls when the floor is in auto
// mode (HIVE_AUTO_APPROVE, gated by config.autoMode — Pam guardrail #5). The
// agent_end→Stop keeps the harness status in step (→ idle) so the renderer idle
// inbox-wake nudge can deliver mail. Fully wrapped so a wrong API guess can never
// break the spawn. LIVE-UNVERIFIED (Pi's exact extension surface needs BYOK keys).
const PI_EXTENSION = `'use strict';
var net = require('node:net');
var SOCK = process.env.HIVE_SOCK;
var AGENT = process.env.AGENT_ID || null;
var AUTO = process.env.HIVE_AUTO_APPROVE === '1';
function post(payload) {
  try {
    if (!SOCK) return;
    if (payload.agent_id && payload.agent_id !== AGENT) payload.provider_agent_id = payload.agent_id;
    payload.agent_id = AGENT || payload.agent_id || null;
    var c = net.createConnection(SOCK, function () { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', function () {});
  } catch (e) {}
}
function register(pi) {
  if (!pi || typeof pi.on !== 'function') return false;
  try {
    pi.on('tool_call', function (ev) {
      post({ hook_event_name: 'PreToolUse', tool_name: ev && (ev.name || (ev.tool && ev.tool.name)), tool_input: ev && (ev.args || ev.input) });
      if (AUTO) { try { if (ev && typeof ev.approve === 'function') ev.approve(); } catch (e) {} return { approve: true }; }
      return undefined;
    });
    pi.on('tool_result', function (ev) { post({ hook_event_name: 'PostToolUse', tool_name: ev && (ev.name || (ev.tool && ev.tool.name)) }); });
    pi.on('agent_end', function () { post({ hook_event_name: 'Stop' }); });
    return true;
  } catch (e) { return false; }
}
try { if (typeof globalThis !== 'undefined' && globalThis.pi) register(globalThis.pi); } catch (e) {}
module.exports = function (pi) { return register(pi); };
module.exports.activate = function (pi) { return register(pi); };
module.exports.default = module.exports;
`;

// ─── opencode bridge plugin (written to <agentDir>/.opencode/plugin/) ────────
// A bundled plugin for OpenCode (anomalyco/opencode) — god Decision 1. OpenCode
// has no Claude-shaped Stop hook but its plugin API exposes a real session.idle
// event; this posts cth-hook-shaped payloads to HIVE_SOCK on tool.execute.before/
// after + session.idle. The session.idle→Stop keeps status in step (→ idle) so the
// renderer idle inbox-wake nudge delivers mail. ESM (OpenCode runs on Bun). Fully
// wrapped. LIVE-UNVERIFIED (plugin auto-load + session.idle firing need BYOK keys).
const OPENCODE_PLUGIN = `import { createConnection } from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID || null;
function post(payload) {
  try {
    if (!SOCK) return;
    if (payload.agent_id && payload.agent_id !== AGENT) payload.provider_agent_id = payload.agent_id;
    payload.agent_id = AGENT || payload.agent_id || null;
    const c = createConnection(SOCK, () => { try { c.end(JSON.stringify(payload) + '\\n'); } catch (e) {} });
    c.on('error', () => {});
  } catch (e) {}
}
export const HiveBridge = async () => {
  return {
    event: async (input) => {
      try { if (input && input.event && input.event.type === 'session.idle') post({ hook_event_name: 'Stop' }); } catch (e) {}
    },
    'tool.execute.before': async (input) => {
      try { post({ hook_event_name: 'PreToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    },
    'tool.execute.after': async (input) => {
      try { post({ hook_event_name: 'PostToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    }
  };
};
export default HiveBridge;
`;

// ─── proxy-bridge sidecar (written to <hive>/bin/hive-proxy.cjs) ─────────────
// One per proxy-tier agent (qwen). A dependency-free, loopback-only reverse
// proxy: the agent's CLI is pointed at this (via ANTHROPIC_BASE_URL/OPENAI_BASE_URL),
// and it forwards every request to the user's real upstream UNCHANGED (headers,
// body, streaming). It TEES each response to synthesize the same HIVE_SOCK payloads
// the hook shims emit — Status (context gauge), PostToolUse (breaker), Stop (idle
// drain), and the new CostSample (cost ledger) — so a hookless CLI becomes a hive
// citizen. NEVER logs bodies or keys; the captured body is parsed in-memory and
// dropped. Idle is heuristic: a turn that ends with no tool call and no new request
// within an ~800ms debounce → Stop (a new request cancels it).
const PROXY_BRIDGE_SHIM = `#!/usr/bin/env node
'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const { URL } = require('url');

const SOCK = process.env.HIVE_SOCK;
const AGENT_ID = process.env.AGENT_ID || null;
const UPSTREAM = process.env.UPSTREAM_BASE_URL || '';
const SESSION = process.env.HIVE_PROXY_SESSION || null;
const API = process.env.HIVE_PROXY_API === 'anthropic' ? 'anthropic' : 'openai';

function trimSlash(s) { while (s.length && s.charAt(s.length - 1) === '/') s = s.slice(0, -1); return s; }

// Per-model context-window size for the Status gauge; fallback 200k.
function ctxSize(model) {
  const m = String(model || '').toLowerCase();
  if (m.indexOf('[1m]') !== -1 || m.indexOf('-1m') !== -1) return 1000000;
  if (m.indexOf('claude') !== -1) return 200000;
  if (m.indexOf('gpt-4o') !== -1 || m.indexOf('gpt-4.1') !== -1 || m.indexOf('o1') !== -1 || m.indexOf('o3') !== -1) return 128000;
  if (m.indexOf('qwen') !== -1) return 262144;
  return 200000;
}

// Fire-and-forget emit of a shim-shaped payload to the hive socket. Never throws.
function emit(payload) {
  if (!SOCK) return;
  try {
    const c = net.createConnection(SOCK, function () { c.end(JSON.stringify(payload) + '\\n'); });
    c.on('error', function () {});
  } catch (e) {}
}

let stopTimer = null;
function armStop() {
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(function () {
    stopTimer = null;
    emit({ hook_event_name: 'Stop', agent_id: AGENT_ID, session_id: SESSION });
  }, 800);
  if (stopTimer.unref) stopTimer.unref();
}
function cancelStop() { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } }

function safeArgs(s) {
  if (s == null) return {};
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return { _raw: String(s).slice(0, 500) }; }
}

// Parse a completed response (single JSON or an SSE stream) and synthesize events.
function parseAndEmit(bodyStr, isSse) {
  const objs = [];
  if (isSse) {
    const lines = bodyStr.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const idx = ln.indexOf('data:');
      if (idx === -1) continue;
      const data = ln.slice(idx + 5).trim();
      if (!data || data === '[DONE]') continue;
      try { objs.push(JSON.parse(data)); } catch (e) {}
    }
  } else {
    try { objs.push(JSON.parse(bodyStr)); } catch (e) {}
  }
  if (!objs.length) { armStop(); return; }

  let model = null, input = 0, output = 0, cacheRead = 0, cacheCreation = 0, sawUsage = false;
  const toolCalls = [];
  const oaiTools = {}; // accumulate streaming openai tool_calls by index

  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (!o || typeof o !== 'object') continue;
    if (o.model) model = o.model;
    if (API === 'anthropic') {
      if (o.type === 'message_start' && o.message) {
        if (o.message.model) model = o.message.model;
        const u = o.message.usage || {};
        input += u.input_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'message_delta' && o.usage) {
        output += o.usage.output_tokens || 0;
        sawUsage = true;
      } else if (o.type === 'content_block_start' && o.content_block && o.content_block.type === 'tool_use') {
        toolCalls.push({ name: o.content_block.name, input: o.content_block.input || {} });
      } else if (o.usage && !o.type) {
        // non-streaming full message body
        const u = o.usage;
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheCreation += u.cache_creation_input_tokens || 0;
        sawUsage = true;
      }
      if (Array.isArray(o.content)) {
        for (let j = 0; j < o.content.length; j++) {
          const blk = o.content[j];
          if (blk && blk.type === 'tool_use') toolCalls.push({ name: blk.name, input: blk.input || {} });
        }
      }
    } else {
      if (o.usage) {
        const u = o.usage;
        input += u.prompt_tokens || 0;
        output += u.completion_tokens || 0;
        if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) cacheRead += u.prompt_tokens_details.cached_tokens;
        sawUsage = true;
      }
      const choices = o.choices || [];
      for (let c = 0; c < choices.length; c++) {
        const ch = choices[c];
        if (!ch) continue;
        if (ch.message && Array.isArray(ch.message.tool_calls)) {
          for (let t = 0; t < ch.message.tool_calls.length; t++) {
            const tc = ch.message.tool_calls[t];
            if (tc && tc.function) toolCalls.push({ name: tc.function.name, input: safeArgs(tc.function.arguments) });
          }
        }
        if (ch.delta && Array.isArray(ch.delta.tool_calls)) {
          for (let t = 0; t < ch.delta.tool_calls.length; t++) {
            const tc = ch.delta.tool_calls[t];
            if (!tc) continue;
            const k = (tc.index != null ? tc.index : t);
            if (!oaiTools[k]) oaiTools[k] = { name: null, args: '' };
            if (tc.function) {
              if (tc.function.name) oaiTools[k].name = tc.function.name;
              if (tc.function.arguments) oaiTools[k].args += tc.function.arguments;
            }
          }
        }
      }
    }
  }
  const keys = Object.keys(oaiTools);
  for (let i = 0; i < keys.length; i++) {
    const t = oaiTools[keys[i]];
    if (t.name) toolCalls.push({ name: t.name, input: safeArgs(t.args) });
  }

  if (sawUsage) {
    emit({ hook_event_name: 'Status', agent_id: AGENT_ID, context_window: { total_input_tokens: input + cacheRead + cacheCreation, context_window_size: ctxSize(model) } });
    emit({ hook_event_name: 'CostSample', agent_id: AGENT_ID, session_id: SESSION, model: model, input: input, output: output, cache_read: cacheRead, cache_creation: cacheCreation });
  }
  if (toolCalls.length) {
    cancelStop(); // a tool call means the turn continues
    for (let i = 0; i < toolCalls.length; i++) {
      emit({ hook_event_name: 'PostToolUse', agent_id: AGENT_ID, session_id: SESSION, tool_name: toolCalls[i].name, tool_input: toolCalls[i].input });
    }
  } else {
    armStop();
  }
}

let upstreamUrl = null;
try { upstreamUrl = new URL(UPSTREAM); } catch (e) {}

const server = http.createServer(function (req, res) {
  cancelStop(); // a new request means the turn is still going
  if (!upstreamUrl) { res.statusCode = 502; res.end('proxy: no upstream'); return; }
  let target;
  try { target = new URL(trimSlash(UPSTREAM) + req.url); } catch (e) { res.statusCode = 502; res.end('proxy: bad url'); return; }
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const headers = Object.assign({}, req.headers);
  headers.host = target.host;
  // Ask upstream for plaintext so the tee can parse SSE/JSON reliably; the client
  // gets uncompressed bytes (loopback — negligible) and no content-encoding to undo.
  delete headers['accept-encoding'];
  const opts = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (isHttps ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers: headers
  };
  const upReq = lib.request(opts, function (upRes) {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
    const ct = String((upRes.headers['content-type'] || ''));
    const wantParse = ct.indexOf('json') !== -1 || ct.indexOf('event-stream') !== -1;
    const isSse = ct.indexOf('event-stream') !== -1;
    const chunks = [];
    let total = 0;
    upRes.on('data', function (chunk) {
      res.write(chunk); // stream straight through to the CLI
      if (wantParse && total < 4194304) { chunks.push(chunk); total += chunk.length; }
    });
    upRes.on('end', function () {
      res.end();
      if (wantParse && chunks.length) {
        try { parseAndEmit(Buffer.concat(chunks).toString('utf8'), isSse); } catch (e) {}
      }
    });
    upRes.on('error', function () { try { res.end(); } catch (e) {} });
  });
  upReq.on('error', function () { try { res.statusCode = 502; res.end('proxy: upstream error'); } catch (e) {} });
  req.pipe(upReq);
});

server.on('error', function () {
  try { process.stdout.write(JSON.stringify({ port: 0 }) + '\\n'); } catch (e) {}
  process.exit(0);
});
server.listen(0, '127.0.0.1', function () {
  const addr = server.address();
  const port = (addr && typeof addr === 'object') ? addr.port : 0;
  try { process.stdout.write(JSON.stringify({ port: port }) + '\\n'); } catch (e) {}
});
`;

// Official Gemini CLI bridge. Gemini already sends snake_case payload fields;
// normalize its event names, then translate HookServer decisions back into
// Gemini's documented hook output contract.
export const GEMINI_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let gemini = {};
  try { gemini = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    SessionStart: 'SessionStart',
    BeforeAgent: 'UserPromptSubmit',
    BeforeTool: 'PreToolUse',
    AfterTool: 'PostToolUse',
    AfterAgent: 'Stop'
  };
  const payload = {
    ...gemini,
    hook_event_name: names[gemini.hook_event_name] || gemini.hook_event_name || 'Unknown',
    agent_id: agentId
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'deny', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = { hookSpecificOutput: { additionalContext: r.hookSpecificOutput.additionalContext } };
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    // MAIL-PIPE-SHIM-CLOCK (1): how long this shim had been running when it sent its request (its
    // 5 s give-up timer starts here), so the server's on-time measure includes the time before
    // its own read of the request (a descheduled shim, a busy server).
    const t0 = Date.now();
    const c = net.createConnection(sock, () => { payload.shim_elapsed_ms = Date.now() - t0; c.write(JSON.stringify(payload) + '\\n'); });
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    // MAIL-PIPE-SHIM-CLOCK (a): at the give-up, first take what is already in the pipe (two loop
    // turns: the poll phase delivers it) and print it when it is a complete reply; else exit empty.
    const complete = () => { try { JSON.parse(resp); return resp.length > 0; } catch (_) { return false; } };
    const giveUp = (turns) => setImmediate(() => { if (complete()) done(); else if (turns > 0) giveUp(turns - 1); else process.exit(0); });
    setTimeout(() => giveUp(2), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;

// ─── grok-hook shim (written to <hive>/bin/grok-hook.cjs) ───────────────────
// Grok's lifecycle events and decisions are Claude-compatible, but the wire
// payload is camelCase and uses snake_case event values. Normalize the input for
// HookServer and translate its Claude-style permission denial into Grok's direct
// decision form. Scoped by AGENT_ID so the trusted global hook is inert outside
// Munder-spawned workers.
export const GROK_HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let grok = {};
  try { grok = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    permission_denied: 'PermissionDenied',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    notification: 'Notification',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact'
  };
  const payload = {
    hook_event_name: names[grok.hookEventName] || grok.hookEventName || 'Unknown',
    agent_id: agentId,
    session_id: grok.sessionId,
    cwd: grok.cwd || grok.workspaceRoot,
    tool_name: grok.toolName,
    tool_input: grok.toolInput,
    stop_hook_active: grok.stopHookActive,
    prompt: grok.prompt,
    source: grok.source,
    notification_type: grok.notificationType,
    message: grok.message
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'block', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = r;
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    // MAIL-PIPE-SHIM-CLOCK (1): how long this shim had been running when it sent its request (its
    // 5 s give-up timer starts here), so the server's on-time measure includes the time before
    // its own read of the request (a descheduled shim, a busy server).
    const t0 = Date.now();
    const c = net.createConnection(sock, () => { payload.shim_elapsed_ms = Date.now() - t0; c.write(JSON.stringify(payload) + '\\n'); });
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    // MAIL-PIPE-SHIM-CLOCK (a): at the give-up, first take what is already in the pipe (two loop
    // turns: the poll phase delivers it) and print it when it is a complete reply; else exit empty.
    const complete = () => { try { JSON.parse(resp); return resp.length > 0; } catch (_) { return false; } };
    const giveUp = (turns) => setImmediate(() => { if (complete()) done(); else if (turns > 0) giveUp(turns - 1); else process.exit(0); });
    setTimeout(() => giveUp(2), 5000).unref();
  } catch (_) { process.exit(0); }
});
`;
