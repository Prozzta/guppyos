/**
 * HookServer — the bridge between `claude` lifecycle hooks and the harness.
 *
 * Each spawned agent is launched with `--settings` pointing its hooks at a tiny
 * shim (see HOOK_SHIM in hive.ts) that forwards the hook payload to the Unix
 * domain socket this server listens on. We then:
 *   - drive avatar state from PreToolUse/PostToolUse/Notification/etc., and
 *   - report lifecycle boundaries while renderer-side guarded queues deliver
 *     inbox work only after the session reaches a safe idle prompt.
 *
 * Runs in the Electron main process.
 */
import { toolEnded, toolStarted, type RunningTool } from '../shared/activityView';
import { createServer, type Server } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Notification, type WebContents } from 'electron';
import type { HiveManager } from './hive';
import { classifyCommand, classifyHeavy, commandFromToolInput, isBackground, scriptReaderFor, type ClassifyCtx, type HeavyJobLock } from './heavyJob';
import { compactCarryText, readPathOf, type CarryCard, type CarryObligation, type CompactHealthWatch } from './compactHealth';
import { modelForHiveSpawn, type HarnessConfig } from './config';
import { TOOL_OUTPUT_CAP_READ, capForCommand, commandOf, condenseOutput, effectiveCap, isReadCommand, outputText, shouldCondense, type BashLikeResponse } from './toolOutputCondense';
import type { ControlRegistry } from './control';
import { DEV_HIDDEN } from './devIsolation';
import type { CircuitBreaker } from './breaker';
import { estimateCostUsd } from './pricing';
import { classifyAgyStatusLine, normalizeClaudeStatusLine, type AgyStatusTick } from './capacityNormalize';
import { agyAccountScope, claudeAccountScope } from './capacityScope';
import { CodexRolloutCapacitySource } from './codexRolloutCapacity';
import { CodexThreadRollouts, HIVE_HOOK_TOOL, MCP_SERVER_NAME, pendingExecCommands, rebuildToolHook } from './codexHookMcp';
import type { CapacityObservation } from '../shared/providerCapacity';
import { CODEX_INBOX_WAKE_SENTINEL } from '../shared/hiveNudge';
import { normalizeAgentProvider, type AgentProvider } from '../shared/agentProvider';
import { MAIL_STALE_EPOCH_MS, MAIL_UNCONFIRMED_FALLBACK_AFTER, type MailEntry, type MailLateDetail, type MailObligation } from './mailLedger';
import {
  MAIL_EVIDENCE_SCAN_BACK_BYTES, MAIL_EVIDENCE_SCAN_MAX_BYTES, MAIL_JOINED_BUDGET,
  buildMailBlock, buildMailHeaders, effectiveMailCap, escapeMailText, isSlashPrompt, mailBudgetFor, mailCapCut, mailCapExempt, mailChannelMode,
  mailEvidenceIn, mailEvidenceKind, mailLatencyLimitMs, mailSurfaceEvents, readFileWindow, shimElapsedMs,
  type MailBlock, type MailBlockItem, type MailChannelMode, type MailEvidenceKind
} from './mailSurface';
import { ALWAYS_WAKE_SENDERS } from '../shared/mailWakeClass';

/**
 * ZT-I1-MAIL slice 3: what the mail epochs need from the wake coordinator (main wires it; tests
 * may omit it: no lifecycle is then "active" and no wake ids are known).
 */
export interface MailCoordination {
  /** N3 (§11.17): the agent's wake lifecycle is ACTIVE on a provider-confirmed turn. A
   *  UserPromptSubmit then joins the live epoch instead of closing it as abnormal. */
  lifecycleActive(agentId: string): boolean;
  /** Legacy-read (§2.2): the ids COMMITTED wakes named to the agent (announced), for the Stop
   *  that ends the wake's turn; empty while our own nudge is still unconfirmed. */
  wakeIds(agentId: string): readonly string[];
  /** Called after every epoch close (normal or abnormal) with the ids that went back to
   *  delivered: §11.3 keys the coordinator's announced set to the ledger. */
  onEpochClosed?(agentId: string, outcome: 'normal' | 'abnormal', reason: string, redelivered: readonly string[]): void;
  /** §11.10: a mail block was returned to this agent (degradation input). */
  onMailBlock?(agentId: string): void;
}

/**
 * ZT-I1-MAIL slice 2: one hook response that carried mail bodies. The ids are `surfacing`
 * (tentative) from the moment the response is built; the transport settles the claim when the
 * response is flushed (§11.1 latency, measured from request receipt to response flush).
 */
export interface MailClaim {
  agentId: string;
  ids: string[];
  epoch: string;
  hookKind: string;
  transport: HookTransport | undefined;
  evidence: MailEvidenceKind;
  /** N1: ids whose evidence already failed MAIL_UNCONFIRMED_FALLBACK_AFTER times in a row: they
   *  are confirmed on the latency rule alone (`latency-fallback`, `mail-evidence-missing`). */
  fallbackIds: string[];
  /** Set when the response is settled: flush − receipt, or null when it never flushed. */
  latencyMs?: number | null;
}

interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  /** CODEX-HOOK-AGENTID: the provider's OWN agent id, when it sent one that is not the hive's
   *  (a Codex or Claude subagent). The shim stamps agent_id with the hive id regardless. */
  provider_agent_id?: string | null;
  /** JOB-ENV (SessionStart): the shim's env AGENT_ID when it disagrees with the --agent id from
   *  the agent's own settings file (a Claude Code background job in another agent's daemon). */
  env_agent_id?: string | null;
  /** WAKE-SCREEN-GUARD R2-4: the spawn's MUNDER_WAKE_INCARNATION, copied by the hook shim. */
  munder_wake_incarnation?: string | null;
  /** CL-M4-BRIEFING-BUDGET C: 'briefing' = Claude's SECOND SessionStart entry (the shim's --part
   *  briefing), which carries the claims working set alone; 'bundle' = the main entry of a settings
   *  file that HAS that second entry (S1). Only the shim sets it. */
  munder_part?: string | null;
  /** MAIL-PIPE-SHIM-CLOCK: a pipe shim's own running time when it sent the request (ms). */
  shim_elapsed_ms?: unknown;
  session_id?: string;
  transcript_path?: string;
  /** Status-line payloads only: the session's live context accounting. */
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  /** Status-line payloads only: Claude Code's current reasoning effort. */
  effort?: { level?: unknown };
  /** Status-line payloads only: the subscription's rolling allowance windows
   *  (`five_hour`, `seven_day`, possibly model-family windows). The shim already
   *  forwards the WHOLE status JSON, so this field has always arrived here — it was
   *  simply not declared, and therefore dropped. Typed as unknown because the
   *  schema is the provider's and may grow; shape checking lives in the
   *  normaliser, which is pure and tested. */
  rate_limits?: unknown;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  /** Notification hook text, e.g. "Claude is waiting for your input" (idle) vs a
   *  permission request. Used to tell "needs you" from "just done / lingering". */
  message?: string;
  /** Status payloads carry Claude's model object; CostSample uses a string. */
  model?: string | { id?: unknown };
  input?: number;
  output?: number;
  cache_read?: number;
  cache_creation?: number;
  /** AgyStatusLine envelopes only: Antigravity's statusline payload, forwarded whole by
   *  the statusline shim. NEVER logged, retained or re-sent - it carries the account's
   *  email. The normaliser reads the fields it needs and everything else is dropped. */
  agy_status?: unknown;
  /** AgyStatusLine envelopes only: when the SHIM read the status, on this machine's
   *  clock. Untrusted input - the normaliser clamps it to the receipt time. */
  read_at?: unknown;
  /** Antigravity `Stop` only: the provider's own terminal qualifier, preserved by the
   *  agy hook shim. Claude never sends it, so absent must keep meaning "terminal" -
   *  only an explicit `false` refuses the Stop. Never a capacity or account fact. */
  fully_idle?: boolean;
  /** Codex hook payloads only: the turn this event belongs to (Codex stamps turn_id on
   *  UserPromptSubmit, PreToolUse, PostToolUse and Stop). Lets the wake coordinator
   *  recognise a tool event that arrives AFTER its own turn's Stop (FALSEACTIVE-STALL-2). */
  turn_id?: string;
  /** HOOK-BROKER: stamped on ARRIVAL, before handle(): a per-agent monotonic counter and
   *  the transport it came over. Never trusted from the sender (overwritten). */
  seq?: number;
  transport?: HookTransport;
  /** Codex PostToolUse over MCP: the tool's output, rebuilt from the rollout. */
  tool_response?: unknown;
  /** HOOK-BROKER P3: the rollout did not (yet) hold this tool hook's item, so tool_name /
   *  tool_input are missing. The tool gate fails closed if a gate is active; the breaker skips it. */
  payload_degraded?: boolean;
  /** HEAVY-JOB-LOCK-FAILOPEN (c): a DEGRADED Codex PreToolUse's pending shell commands, read from the
   *  rollout for the heavy-job classifier ONLY (never a tool name for a gate). */
  codex_commands?: string[];
}

export type HookTransport = 'http' | 'pipe' | 'mcp' | 'pipe-oneway';

/** MIDTURN-MAIL-BLIND L1 + ZT-I1-MAIL: one agent's turn as the hook stream shows it. */
interface TurnState {
  open: boolean;
  /** Legacy notice (<inbox-update>): the inbox files present when the turn began. */
  known: Set<string>;
  noticed: Set<string>;
  /** The surfacing epoch (provider turn id, else the harness counter). */
  epoch: string;
  /** N3: ids already put into a hook response in this epoch; never surfaced twice in it. */
  injected: Set<string>;
  /** How many mail-carrying hooks ran in this turn (AGY's first PreInvocation is its turn start). */
  mailHooks: number;
  /** Legacy-read: ids the mid-turn <inbox-update> notice named in this turn (acted at its Stop). */
  legacyNamed: Set<string>;
}

/** An evidence scan still waiting for tentative ids of one epoch (§11.1). */
interface EvidenceWait {
  epoch: string;
  ids: Set<string>;
  kind: MailEvidenceKind;
  /** The transcript/rollout the claim was made against, and its size then (the record is
   *  written after the claim, so the scan starts there). Null: unknown at claim time. */
  file: string | null;
  offset: number;
  /** The size at the last scan (an unchanged file is not re-read). */
  scannedFile: string | null;
  scannedSize: number;
}

/**
 * HOOK-BROKER P4 (AGY): the one-way pipe framing. AGY has no zero-process hook or statusline
 * transport, so its observational events run `agy-oneway.cmd` (cmd built-ins + findstr, ~34 ms)
 * instead of the Electron shim (~450 ms): the first line is a header, the rest is AGY's raw JSON,
 * and the client closes without reading a reply. Headers:
 *   `agy <Event> <agentId>`            PostToolUse / PostInvocation
 *   `agy-status <ownerToken> <agentId>` the statusline
 * An empty agent id is a user's own (non-hive) AGY session.
 */
export interface OnewayFrame { kind: 'hook' | 'status'; event: string; token: string; agentId: string | null; body: unknown; bodyOk: boolean }
export const ONEWAY_EVENTS = new Set(['PostToolUse', 'PostInvocation']);
export function parseOnewayFrame(text: string): OnewayFrame | null {
  const nl = text.indexOf('\n');
  const header = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, '').trim();
  const parts = header.split(/\s+/);
  let frame: Omit<OnewayFrame, 'body' | 'bodyOk'>;
  if (parts[0] === 'agy' && ONEWAY_EVENTS.has(parts[1] ?? '')) {
    frame = { kind: 'hook', event: parts[1], token: '', agentId: parts[2] || null };
  } else if (parts[0] === 'agy-status' && /^[0-9a-f]{16,}$/i.test(parts[1] ?? '')) {
    frame = { kind: 'status', event: 'AgyStatusLine', token: parts[1], agentId: parts[2] || null };
  } else return null;
  // A literal %AGENT_ID% (the variable was not set) is the same as none.
  if (frame.agentId && /^%.*%$/.test(frame.agentId)) frame.agentId = null;
  let body: unknown = null;
  let bodyOk = false;
  // findstr corrupts lines over ~8 KB (measured), so a long PostToolUse body can arrive
  // truncated: the header still says which event it was.
  try { body = JSON.parse(nl < 0 ? '' : text.slice(nl + 1)); bodyOk = !!body && typeof body === 'object' && !Array.isArray(body); } catch { /* degraded */ }
  return { ...frame, body: bodyOk ? body : null, bodyOk };
}

/** AGY's hook JSON -> the Claude-shaped payload (the same mapping as AGY_HOOK_SHIM). */
export function agyHookPayload(event: string, agentId: string, agy: Record<string, unknown> | null): HookPayload {
  const a = agy ?? {};
  const tc = (a.toolCall && typeof a.toolCall === 'object' ? a.toolCall : {}) as Record<string, unknown>;
  const p: HookPayload = {
    hook_event_name: event,
    agent_id: agentId,
    session_id: typeof a.conversationId === 'string' ? a.conversationId : undefined,
    transcript_path: typeof a.transcriptPath === 'string' ? a.transcriptPath : undefined,
    cwd: Array.isArray(a.workspacePaths) && typeof a.workspacePaths[0] === 'string' ? a.workspacePaths[0] : undefined,
    tool_name: typeof tc.name === 'string' ? tc.name : undefined,
    tool_input: tc.args
  };
  if (!agy) p.payload_degraded = true;
  return p;
}

/** HOOK-BROKER: the largest HTTP hook body accepted (a PostToolUse tool_response can be big). */
export const HOOK_HTTP_BODY_MAX = 8 * 1024 * 1024;
/** READS-181 B: a saved output up to this size is read whole to condense it; a larger one is read
 *  as its first and last CONDENSE_PART_BYTES (error lines in the middle are then not shown).
 *  Jim N2: small, so the synchronous read never holds the main thread (hooks, UI, PTYs) long. */
export const CONDENSE_READ_MAX = 256 * 1024;
export const CONDENSE_PART_BYTES = 128 * 1024;
/** N1 (god): a Read/grep of a condensed output's saved file within this many of the agent's tool
 *  calls counts as a RE-FETCH (logged, so the caps can be tuned). */
export const REFETCH_WINDOW_CALLS = 10;
const REFETCH_TRACKED = 20;
/** READS-181 B: full outputs kept under agents/<id>/tool-output are deleted after this long. */
export const TOOL_OUTPUT_KEEP_MS = 7 * 24 * 3600_000;
const TOOL_OUTPUT_PRUNE_EVERY_MS = 3600_000;

/** HOOK-BROKER: after a listener error, re-listen on the SAME port (live agents' settings name
 *  it) with these delays; when they are exhausted (~30 s) the broker is down and new spawns get
 *  the command hooks. */
export const HOOK_HTTP_RELISTEN_DELAYS_MS = [250, 1_000, 2_000, 5_000, 10_000, 12_000];
/** The broker's URLs: /hook/<agentId>/<32-hex token> (Claude HTTP hooks),
 *  /mcp/<agentId>/<token> (Codex mcp_tool hooks, P3) and /ledger/<agentId>/<token> (the
 *  `ledger` command, READS-181 A: the same per-spawn token, so the caller cannot be forged). */
const HOOK_ROUTE = /^\/(hook|mcp|status|ledger)\/([^/?#]+)\/([0-9a-f]{32})$/;
/** READS-181 A: one ledger operation (a card, a message, a memory note) is small. */
export const LEDGER_HTTP_BODY_MAX = 256 * 1024;
export type LedgerHttpHandler = (agentId: string, body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
/** NATIVE-MEMORY: the `memory` command's endpoint. The caller is identified by its MEMORY_TOKEN
 *  alone (the handler resolves it); no agent id in the URL to trust. */
const MEMORY_ROUTE = /^\/memory\/([0-9a-f]{32})$/;
/** A memory request is a query, not a document. */
export const MEMORY_HTTP_BODY_MAX = 64 * 1024;

export type MemoryHttpHandler = (token: string, body: unknown) => Promise<{ status: number; body: unknown }>;

/** The in-terminal context gauge the status line prints (the same text the command shim
 *  printed): "ctx 45k/200k (22%)", or "" without a usable context_window. */
export function statusGauge(p: Record<string, unknown>): string {
  const cw = (p.context_window && typeof p.context_window === 'object' ? p.context_window : {}) as Record<string, unknown>;
  const used = cw.total_input_tokens, size = cw.context_window_size;
  if (typeof used !== 'number' || typeof size !== 'number' || !(size > 0)) return '';
  const pct = Math.round((used / size) * 100);
  return 'ctx ' + Math.round(used / 1000) + 'k/' + Math.round(size / 1000) + 'k (' + pct + '%)';
}
/** How long a Codex tool hook waits for its rollout item before it is delivered degraded. */
export const MCP_ROLLOUT_RETRY_MS = 20;

/** Rewrite an HTTP hook body's identity from the AUTHENTICATED URL (9082b05c rules, now
 *  server-side): an incoming provider_agent_id is never trusted; a differing body agent_id is
 *  the provider's own (a subagent) and becomes provider_agent_id; agent_id is the URL's. */
export function applyUrlIdentity(p: Record<string, unknown>, urlAgentId: string): void {
  delete p.provider_agent_id;
  delete p.env_agent_id; // only the command shim may set it
  delete p.munder_part; // likewise (CL-M4-BRIEFING-BUDGET C: SessionStart is never an HTTP hook)
  const own = typeof p.agent_id === 'string' && p.agent_id !== '' ? p.agent_id : null;
  if (own && own !== urlAgentId) p.provider_agent_id = own;
  p.agent_id = urlAgentId;
}

/** How many distinct {version, driftCode} pairs are counted before they share one bucket. */
const AGY_DRIFT_KEYS_MAX = 32;
/** A working Codex session normally writes a rate-limit reading quickly. Keep a
 * silent failure visible without turning every unchanged-file hook into a log row. */
const CODEX_NO_READING_AFTER_MS = 5 * 60_000;

interface CodexNoReading {
  sessionId: string;
  firstHookAt: number;
  reported: boolean;
  /** A null observation after this is the ordinary unchanged-rollout path, not
   * evidence that the session failed to produce a reading. */
  gotReading: boolean;
}

export class HookServer {
  private server: Server | null = null;
  /** agentId → the live session's transcript file, learned from hook payloads.
   *  Lets the harness read per-agent telemetry (e.g. current context size)
   *  even when several agents share one cwd. */
  private transcriptPaths = new Map<string, string>();
  /** agentId → the latest context-window accounting from the statusLine shim
   *  (current tokens + the REAL window size — 200k vs 1M, which nothing else
   *  exposes). The renderer already gets this pushed live on `hive:contextUpdate`;
   *  we also retain the last value here so a main-side read (the voice read-layer's
   *  get_agent_detail / list_agents) can report "how full is each agent's context"
   *  without depending on a renderer round-trip. */
  private contextById = new Map<string, { tokens: number; limit: number; ts: number }>();
  /** L0 — Codex allowance, read from the rollout a Codex worker is already writing.
   *  Holds only a per-home cache (rollout path + last size/mtime seen). */
  private codexCapacity = new CodexRolloutCapacitySource();
  /** One delayed diagnostic per agent/session if hook traffic never produces a reading. */
  private codexNoReading = new Map<string, CodexNoReading>();
  /** WAKE-SCREEN-GUARD R2-4: told of an agent's SessionStart that carries its incarnation token. */
  private onWakeIncarnation?: (agentId: string, token: string) => void;
  /** Main-owned, volatile claim working-set renderer; receipts and persistence stay in main. */
  private claimWorkingSet?: (agentId: string, source?: string, part?: 'briefing') => string | null | Promise<string | null>;
  private preparedClaimWorkingSets = new Map<string, string | null>();
  /** CLAIM-LEDGER W5 (god): told at each completed turn (Stop), for the reconcile lease. */
  private claimTurnCompleted?: (agentId: string) => void;
  /** CARD-IDLE-WHILE-WORKING (1.1.78): each agent's tool call in progress, from its own
   *  PreToolUse until the PostToolUse, the next prompt or the turn's end. */
  private readonly runningTools = new Map<string, RunningTool[]>();

  /** The oldest tool the agent is running now, with when it started; undefined when none. */
  runningTool(agentId: string): RunningTool | undefined {
    return this.runningTools.get(agentId)?.[0];
  }

  private noteRunningTool(agentId: string, event: string, p: HookPayload): void {
    const name = typeof p.tool_name === 'string' && p.tool_name ? p.tool_name.slice(0, 60) : undefined;
    if (event === 'PreToolUse' && name) {
      this.runningTools.set(agentId, toolStarted(this.runningTools.get(agentId), name, Date.now()));
    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
      // Jim N1: one tool ends; a parallel one may still run.
      const left = toolEnded(this.runningTools.get(agentId), name);
      if (left.length) this.runningTools.set(agentId, left); else this.runningTools.delete(agentId);
    } else if (event === 'UserPromptSubmit' || event === 'SessionStart' || event === 'Stop' || event === 'StopFailure' || event === 'PreCompact') {
      this.runningTools.delete(agentId);
    }
  }

  /** WAKE-SCREEN-GUARD R2-4: set by main once (the constructor's observer stays as it was). */
  setWakeIncarnationObserver(fn: ((agentId: string, token: string) => void) | undefined): void {
    this.onWakeIncarnation = fn;
  }

  setClaimWorkingSetProvider(fn: ((agentId: string, source?: string, part?: 'briefing') => string | null | Promise<string | null>) | undefined): void {
    this.claimWorkingSet = fn;
  }

  setClaimTurnCompletedListener(fn: ((agentId: string) => void) | undefined): void {
    this.claimTurnCompleted = fn;
  }

  /** CLAIM-LEDGER G4.4 (Jim M-3): the working set rides only on SessionStart (startup, resume,
   *  clear, compact), never on UserPromptSubmit (and `memory wake-up` carries it on demand).
   *  Never on a one-way hook (S-5). Not for Codex: its view is in its instruction file, once per
   *  spawn (G4.5, god's M-4 ruling), which a compaction keeps. */
  private claimWorkingSetEvent(p: HookPayload): boolean {
    if (p.hook_event_name !== 'SessionStart' || !p.agent_id || p.transport === 'pipe-oneway') return false;
    // CL-M4-BRIEFING-BUDGET C: a Claude agent whose settings carry the briefing entry (its main
    // entry is marked 'bundle') gets the working set from that entry (claimBriefing below), never
    // the joined bundle. S1 (Jim): settings that predate it (no mark) keep it in the bundle, so
    // there is always exactly one copy, decided by the settings in force, not by this build.
    try { const provider = this.mailChannel(p.agent_id).provider; return provider !== 'codex' && !(provider === 'claude' && p.munder_part === 'bundle'); } catch { return true; }
  }

  /**
   * CL-M4-BRIEFING-BUDGET C (the Human's choice): Claude's second SessionStart hook entry. Claude
   * Code spills each hook OUTPUT past 10,000 chars (to a 2,000-char preview), not each event; a
   * separate entry on the same event is delivered whole beside the bundle (C1, Claude Code
   * 2.1.289: up to 9,500 chars in each of the two entries, at startup, compact and
   * UserPromptSubmit). So the working set comes here alone, capped at WORKING_SET_MAX_CHARS
   * (9,000; the 9,500 bundle cap is the other entry's), and does no other hook work: no
   * session record, turn boundary, mail or roster (the main entry does all of that).
   */
  private async claimBriefing(p: HookPayload): Promise<unknown> {
    const fromSubagent = typeof p.provider_agent_id === 'string' && p.provider_agent_id !== '' && p.provider_agent_id !== p.agent_id;
    if (fromSubagent || p.hook_event_name !== 'SessionStart' || !p.agent_id || p.transport === 'pipe-oneway') return {};
    let provider: AgentProvider | undefined;
    try { provider = this.mailChannel(p.agent_id).provider; } catch { provider = undefined; }
    if (provider !== 'claude') return {};
    let text: string | null = null;
    try { text = await this.claimWorkingSet?.(p.agent_id, p.source, 'briefing') ?? null; } catch { text = null; }
    try { this.hive.appendLog({ kind: 'claims-briefing', agentId: p.agent_id, source: p.source ?? null, chars: text?.length ?? 0 }); } catch { /* observation only */ }
    return text ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } } : {};
  }

  constructor(
    private hive: HiveManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    /** #7C — operator control state. Optional so tests can omit it. */
    private control?: ControlRegistry,
    /** Circuit breaker (Lane A #6.6b) — fed the hook-derived signals (session id,
     *  repeated identical tool calls). Optional so the server still runs without it. */
    private breaker?: CircuitBreaker,
    /** Standing goal text for an agent (from the durable roster). Optional so
     *  tests can omit it; when set, injected on SessionStart / UserPromptSubmit. */
    private getStandingGoal?: (agentId: string) => string | null,
    /** Optional OBSERVER of every hook boundary (agentId, event, message), called
     *  synchronously BEFORE this server returns its hook response. It must not submit
     *  or block: the inbox-wake bridge only records lifecycle/HITL state here and defers
     *  any retry with setImmediate, so the response (Stop included) is unchanged. */
    private onEvent?: (agentId: string | undefined, event: string, message: string | undefined, fullyIdle?: boolean, turnId?: string, source?: string) => void,
    /** L0 — provider allowance observed on the status line. Optional so the server
     *  runs unchanged where no tracker is wired (tests, and any build without L0).
     *  HookServer deliberately does not hold the tracker: it hands over a
     *  normalised observation and knows nothing about states, thresholds or pools. */
    private onCapacity?: (agentId: string | null, obs: CapacityObservation) => void,
    /** AGY 1.1.48 - one COHERENT Antigravity statusline tick: both family observations
     *  plus the canonical lifecycle. `agentId` is null for a user's own session. Optional
     *  and unwired in a build with no capacity runtime, in which case a tick is
     *  normalised, counted if it drifts, and otherwise dropped.
     *
     *  ONE CALLBACK CARRIES BOTH the allowance pair and the lifecycle, because they are
     *  one indivisible reading: the tick that says which family is active is the same
     *  tick that says whether the turn is running. Splitting it into a capacity callback
     *  and a lifecycle callback would let a build accept half of a reading, and "the half
     *  that parsed is exactly as suspect as the half that did not" is the rule this
     *  normaliser is already built on. HookServer still knows nothing about pools, wake
     *  or admission; it hands over the canonical record and the caller routes it. */
    private onAgyTick?: (agentId: string | null, tick: AgyStatusTick) => void
  ) {
    // Jim LOW residual: a (re)spawn rewrites the agent's registry entry, possibly with a DIFFERENT
    // provider; the cached provider must not outlive it (the very next hook reads the new one).
    this.subscribeProvisioned();
  }

  /** The unsubscribe HiveManager.onAgentProvisioned returned; null while not subscribed. stop()
   *  calls it (Jim's nit: servers built on one hive must not pile up listeners) and start()
   *  subscribes again, so a restarted server still drops a respawned agent's cached provider. */
  private unsubscribeProvisioned: (() => void) | null = null;

  private subscribeProvisioned(): void {
    if (this.unsubscribeProvisioned) return;
    try {
      const off = this.hive.onAgentProvisioned?.((agentId) => { this.providerCache.delete(agentId); });
      this.unsubscribeProvisioned = typeof off === 'function' ? off : null;
    } catch { /* a test double */ }
  }

  /** Bounded drift tally, keyed `version|driftCode`. Fixed-string keys only: the payload
   *  that drifted is never stored, so this can be read out or logged safely. */
  private agyDrift = new Map<string, number>();

  /** A snapshot of the drift tally (diagnostics, tests). */
  agyDriftCounts(): Record<string, number> {
    return Object.fromEntries(this.agyDrift);
  }

  start(): void {
    this.subscribeProvisioned();
    const sock = this.hive.sockPath();
    if (!sock || this.server) return;
    // Clear a stale socket file left by a previous run.
    try { if (existsSync(sock)) rmSync(sock); } catch { /* noop */ }

    this.server = createServer((conn) => {
      let buf = '';
      let oneway = false;
      let receivedAt = 0;
      conn.on('end', () => { if (oneway) this.onOneway(buf); });
      conn.on('data', (d) => {
        if (!receivedAt) receivedAt = Date.now();
        buf += d.toString();
        // P4: a one-way AGY frame (a text header, not JSON): read to the end, never reply.
        if (oneway || /^agy(-status)? /.test(buf)) { oneway = true; if (buf.length > HOOK_HTTP_BODY_MAX) { oneway = false; conn.destroy(); } return; }
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // wait for the full line
        let payload: HookPayload = {};
        try { payload = JSON.parse(buf.slice(0, nl)); } catch { /* ignore */ }
        // MAIL-PIPE-SHIM-CLOCK (1): the shim's 5 s give-up started before this read. A shim that
        // was descheduled before sending, or a server that read the request late, used up time
        // this side never saw; on a Windows pipe the flush also "finishes" when the shim CLOSES at
        // its give-up, so a server-only measure confirmed a reply nobody printed (GATE-179). The
        // on-time measure is the shim's elapsed time at send plus this side's arrival-to-flush.
        const shimMs = shimElapsedMs(payload.shim_elapsed_ms);
        delete payload.shim_elapsed_ms;
        let res: unknown = {};
        let claims: MailClaim[] = [];
        void (async () => {
          try { res = await this.handleWithClaimContext(this.stampArrival(payload, 'pipe')); claims = this.takeMailClaims(); } catch { res = {}; }
          this.watchMailFlush(conn, claims, receivedAt - shimMs);
          if (payload.munder_part === 'briefing') this.watchBriefingFlush(conn, payload, res, receivedAt - shimMs);
          conn.end(JSON.stringify(res ?? {}));
        })();
      });
      conn.on('error', () => { /* shim hung up — ignore */ });
    });
    this.server.on('error', (e) => console.error('[hive] hook server error:', e));
    this.server.listen(sock);
    this.startHttp();
  }

  stop(): void {
    const off = this.unsubscribeProvisioned;
    this.unsubscribeProvisioned = null;
    try { off?.(); } catch { /* noop */ }
    // Unsubscribed, a respawn is no longer seen: nothing cached may outlive that.
    this.providerCache.clear();
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    const sock = this.hive.sockPath();
    try { if (sock && existsSync(sock)) rmSync(sock); } catch { /* noop */ }
    this.stopHttp();
  }

  // — HOOK-BROKER: Claude's native HTTP hooks, handled in-process (0 processes per hook) —
  //
  // Every command hook cost two process creations (cmd.exe + Electron-as-node running the
  // shim): ~450 ms each, an antivirus scan target, and the jitter that let a hook overtake a
  // later one. Claude Code can POST a hook to a URL instead. The broker is this server with a
  // second listener, on loopback, calling the SAME handle(): every gate behaves identically,
  // and it spawns nothing, so there is nothing to orphan. Providers that can only run a
  // command keep the pipe and the shim exactly as before.

  private http: HttpServer | null = null;
  private httpPort: number | null = null;
  private httpDown = false;
  private httpStopped = true;
  private relistenAttempt = 0;
  private relistenTimer: ReturnType<typeof setTimeout> | null = null;
  /** agentId -> the token minted for its CURRENT spawn (revoked on archive, replaced on respawn). */
  private hookTokens = new Map<string, Buffer>();
  private seqByAgent = new Map<string, number>();
  /** Hooks per agent per transport in the current minute; flushed to log.jsonl on rollover. */
  private transportCounts = new Map<string, Record<HookTransport, number>>();
  private countsMinute = 0;
  private oversizeLogged = new Set<string>();
  /** NATIVE-MEMORY: set by main when the engine is past `legacy`; null = the route is 404. */
  private memoryHandler: MemoryHttpHandler | null = null;

  setMemoryHandler(h: MemoryHttpHandler | null): void {
    this.memoryHandler = h;
  }

  /** READS-181 A: set by main; null = the ledger route answers 404. */
  private ledgerHandler: LedgerHttpHandler | null = null;
  setLedgerHandler(h: LedgerHttpHandler | null): void {
    this.ledgerHandler = h;
  }

  /** READS-181 A: a ledger body is UTF-8 JSON (invalid UTF-8 is refused, never repaired). */
  private onLedger(agentId: string, raw: Buffer, reply: (status: number, body: unknown) => void): void {
    const handler = this.ledgerHandler;
    if (!handler) { reply(404, { ok: false, line: 'refused: the ledger is not available in this build' }); return; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {
      reply(400, { ok: false, line: 'refused: the input is not valid UTF-8' }); return;
    }
    let body: unknown;
    try { body = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (e) {
      reply(400, { ok: false, line: `refused: the input is not valid JSON (${String(e).slice(0, 120)})` }); return;
    }
    // CLAIM-LEDGER W6 (G6.6): at level 'writer' the memory part is an async claim append.
    const failed = (e: unknown): void => reply(500, { ok: false, line: `refused: the ledger failed (${String(e).slice(0, 160)})` });
    try { Promise.resolve(handler(agentId, body)).then((r) => reply(r.status, r.body), failed); } catch (e) { failed(e); }
  }

  /** The base URL the shim posts to (`<base>/<token>`), or null when the broker is down. */
  memoryBaseUrl(): string | null {
    return this.httpDown || !this.httpPort ? null : `http://127.0.0.1:${this.httpPort}/memory`;
  }

  private onMemory(token: string, req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, body: unknown): void => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    };
    const handler = this.memoryHandler;
    if (!handler || req.method !== 'POST') { req.resume(); reply(handler ? 405 : 404, {}); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (d: Buffer) => {
      if (tooBig) return;
      size += d.length;
      if (size > MEMORY_HTTP_BODY_MAX) { tooBig = true; reply(413, {}); req.resume(); return; }
      chunks.push(d);
    });
    req.on('end', async () => {
      if (tooBig) return;
      let body: unknown = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = null; }
      handler(token, body).then((r) => reply(r.status, r.body), () => reply(500, { exit: 4, error: 'memory handler failed' }));
    });
    req.on('error', () => { /* client went away */ });
  }
  private brokerDownLogged = false;
  private portStolenLogged = false;
  /** Agents whose hook URLs named a port another process took: they need a respawn. */
  private respawnNeeded = new Set<string>();

  private startHttp(port = 0): void {
    this.httpStopped = false;
    const server = createHttpServer((req, res) => this.onHttp(req, res));
    server.headersTimeout = 5_000;
    server.requestTimeout = 30_000;
    server.keepAliveTimeout = 5_000;
    server.on('error', (e) => this.onHttpError(server, e));
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        this.httpPort = addr.port;
        if (this.httpDown) {
          console.warn('[hive] hook broker listening again on its port');
          try { this.hive.appendLog({ kind: 'hook-broker-up', port: addr.port }); } catch { /* best effort */ }
        }
        this.httpDown = false;
        this.brokerDownLogged = false;
        this.portStolenLogged = false;
        this.relistenAttempt = 0;
      }
    });
    this.http = server;
  }

  private onHttpError(server: HttpServer, e: unknown): void {
    if (this.http !== server || this.httpStopped) return;
    try { server.close(); } catch { /* noop */ }
    this.http = null;
    // PORT STOLEN: another process now holds OUR port, so every running agent whose hooks name
    // it is posting to that process instead (or getting refused). They cannot be switched while
    // running; they need a respawn, which gives them command hooks while the broker is down.
    // Logged once per outage, with the agents to respawn; the renderer is told the same.
    if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE' && this.httpPort !== null && !this.portStolenLogged) {
      this.portStolenLogged = true;
      const agents = [...this.hookTokens.keys()];
      this.respawnNeeded = new Set(agents);
      console.error(`[hive] hook broker port ${this.httpPort} was taken by another process; agents needing a respawn: ${agents.join(', ') || '(none)'}`);
      try { this.hive.appendLog({ kind: 'hook-broker-port-stolen', port: this.httpPort, agents }); } catch { /* best effort */ }
      try { this.getWebContents()?.send('hive:hookBrokerPortStolen', { port: this.httpPort, agents }); } catch { /* best effort */ }
    }
    const delays = HOOK_HTTP_RELISTEN_DELAYS_MS;
    const delay = delays[Math.min(this.relistenAttempt, delays.length - 1)] ?? 10_000;
    if (this.relistenAttempt >= delays.length) {
      // Persistent: new spawns get the command hooks from now on. Live agents' hooks fail
      // OPEN while it is down (a Codex tool call measured +~4 s: two ~2 s MCP failures; a
      // Claude HTTP hook is a non-blocking error), and the reconcile beat still covers wake.
      // It KEEPS trying on the same port: the URLs of every running agent name it, a running
      // Codex cannot be switched to command hooks (it reads its config once), and Codex's MCP
      // client reconnects to a listener that comes back (verified on the TUI).
      this.httpDown = true;
      if (!this.brokerDownLogged) {
        this.brokerDownLogged = true;
        console.error('[hive] hook broker down; new agents use command hooks; retrying:', e);
        try { this.hive.appendLog({ kind: 'hook-broker-down', error: String(e).slice(0, 200) }); } catch { /* best effort */ }
      }
    }
    this.relistenAttempt += 1;
    // The SAME port: the URLs in running agents' settings name it. With no port yet (the
    // first bind failed), any port will do, and nobody has a URL to lose.
    const port = this.httpPort ?? 0;
    this.relistenTimer = setTimeout(() => { this.relistenTimer = null; if (!this.httpStopped) this.startHttp(port); }, delay);
    this.relistenTimer.unref?.();
  }

  private stopHttp(): void {
    this.httpStopped = true;
    if (this.relistenTimer) { clearTimeout(this.relistenTimer); this.relistenTimer = null; }
    try { this.http?.close(); } catch { /* noop */ }
    this.http = null;
    this.httpPort = null;
    this.hookTokens.clear();
    this.flushTransportCounts();
  }

  /** The URL this agent's Claude hooks POST to, minting a fresh token (the previous spawn's is
   *  revoked). Null when the broker is not listening: the caller then writes command hooks. */
  hookUrl(agentId: string): string | null {
    if (!this.http || this.httpPort === null || this.httpDown || this.httpStopped || !agentId) {
      // A spawn while the broker is down gets command hooks: its previous URL is dead weight.
      if (agentId) this.revokeHookToken(agentId);
      return null;
    }
    const token = randomBytes(16);
    this.hookTokens.set(agentId, token);
    return `http://127.0.0.1:${this.httpPort}/hook/${encodeURIComponent(agentId)}/${token.toString('hex')}`;
  }

  revokeHookToken(agentId: string): void {
    this.hookTokens.delete(agentId);
    this.respawnNeeded.delete(agentId);
  }

  /** Agents that must be respawned after the broker port was taken (diagnostics, UI). */
  agentsNeedingRespawn(): string[] { return [...this.respawnNeeded]; }

  /** The bound broker port (diagnostics, tests), or null. */
  hookBrokerPort(): number | null { return this.httpDown ? null : this.httpPort; }

  private onHttp(req: IncomingMessage, res: ServerResponse): void {
    // §11.1: hook latency is measured from request receipt to response flush.
    const receivedAt = Date.now();
    const reply = (status: number, body: unknown): void => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    };
    const mem = req.url ? MEMORY_ROUTE.exec(req.url) : null;
    if (mem) { this.onMemory(mem[1], req, res); return; }
    const m = req.url ? HOOK_ROUTE.exec(req.url) : null;
    if (!m) { req.resume(); reply(404, {}); return; }
    const route = m[1];
    // MCP clients may end a session with DELETE, or probe with GET (no SSE here).
    if (req.method !== 'POST') { req.resume(); res.writeHead(route === 'mcp' && req.method === 'DELETE' ? 200 : 405); res.end(); return; }
    let agentId: string;
    try { agentId = decodeURIComponent(m[2]); } catch { req.resume(); reply(404, {}); return; }
    const expected = this.hookTokens.get(agentId);
    const given = Buffer.from(m[3], 'hex');
    // Constant-time, and never handled unless it matches: another local process cannot
    // forge a hook for an agent.
    if (!expected || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      req.resume(); reply(403, {}); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    const bodyMax = route === 'ledger' ? LEDGER_HTTP_BODY_MAX : HOOK_HTTP_BODY_MAX;
    req.on('data', (d: Buffer) => {
      if (tooBig) return;
      size += d.length;
      if (size > bodyMax) {
        tooBig = true;
        if (!this.oversizeLogged.has(agentId)) {
          this.oversizeLogged.add(agentId);
          console.error(`[hive] ${route} body over ${bodyMax} bytes from ${agentId}; refused`);
        }
        reply(413, {});
        req.resume();
        return;
      }
      chunks.push(d);
    });
    req.on('end', async () => {
      if (tooBig) return;
      if (route === 'mcp') {
        void this.onMcp(agentId, expected, Buffer.concat(chunks).toString('utf8'), res, receivedAt);
        return;
      }
      if (route === 'ledger') { this.onLedger(agentId, Buffer.concat(chunks), reply); return; }
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch { /* an unreadable body is an empty hook */ }
      applyUrlIdentity(payload, agentId);
      if (route === 'status') {
        // AV R1: the Claude status line (claude-status.sh). Handled as the Status event the
        // command shim sent; the reply is the gauge TEXT the script prints into the TUI.
        payload.hook_event_name = 'Status';
        try { await this.handleWithClaimContext(this.stampArrival(payload as HookPayload, 'http')); } catch { /* never break a status tick */ }
        if (!res.headersSent) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(statusGauge(payload)); }
        return;
      }
      let out: unknown = {};
      let claims: MailClaim[] = [];
      try { out = await this.handleWithClaimContext(this.stampArrival(payload as HookPayload, 'http')); claims = this.takeMailClaims(); } catch { out = {}; }
      this.watchMailFlush(res, claims, receivedAt);
      reply(200, out);
    });
    req.on('error', () => { /* client went away */ });
  }

  // — HOOK-BROKER P3: Codex tool hooks over MCP (a streamable-HTTP JSON-RPC endpoint) —

  private threadRollouts = new CodexThreadRollouts();

  /** This Codex agent's MCP endpoint + the static token its hook `input.k` carries (minted per
   *  spawn, the same token map as hookUrl). Null when the broker is not listening: the caller
   *  then writes command hooks for every event. */
  mcpEndpoint(agentId: string): { url: string; token: string } | null {
    const url = this.hookUrl(agentId);
    if (!url) return null;
    const token = url.slice(url.lastIndexOf('/') + 1);
    return { url: url.replace('/hook/', '/mcp/'), token };
  }

  private async onMcp(agentId: string, token: Buffer, body: string, res: ServerResponse, receivedAt = Date.now()): Promise<void> {
    const claims: MailClaim[] = [];
    const send = (status: number, obj: unknown): void => {
      this.watchMailFlush(res, claims, receivedAt);
      if (res.headersSent) return;
      if (obj === null) { res.writeHead(status); res.end(); return; }
      res.writeHead(status, { 'content-type': 'application/json', 'mcp-session-id': 'munder' });
      res.end(JSON.stringify(obj));
    };
    let msg: unknown;
    try { msg = JSON.parse(body); } catch { send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
    const batch = Array.isArray(msg);
    const out: unknown[] = [];
    for (const m of (batch ? msg : [msg]) as Array<{ id?: unknown; method?: string; params?: Record<string, unknown> }>) {
      if (!m || typeof m !== 'object') continue;
      if (m.id === undefined) continue; // a notification (notifications/initialized)
      const ok = (result: unknown) => out.push({ jsonrpc: '2.0', id: m.id, result });
      const err = (code: number, message: string) => out.push({ jsonrpc: '2.0', id: m.id, error: { code, message } });
      if (m.method === 'initialize') {
        const pv = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18';
        ok({ protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: { name: MCP_SERVER_NAME, version: '1' } });
      } else if (m.method === 'tools/list') {
        ok({ tools: [{ name: HIVE_HOOK_TOOL, description: 'Internal Munder hook sink. Not for model use: calls are rejected.', inputSchema: { type: 'object', additionalProperties: true } }] });
      } else if (m.method === 'ping') {
        ok({});
      } else if (m.method === 'tools/call') {
        const r = await this.onMcpToolCall(agentId, token, m.params ?? {});
        if ('claims' in r && r.claims) claims.push(...r.claims);
        if ('error' in r) err(r.error.code, r.error.message);
        else ok({ content: [{ type: 'text', text: JSON.stringify(r.result) }], structuredContent: r.result, isError: false });
      } else {
        err(-32601, `method not found: ${String(m.method)}`);
      }
    }
    if (!out.length) { send(202, null); return; }
    send(200, batch ? out : out[0]);
  }

  /** One Codex tool hook. The static input must carry this agent's token (`k`), so a call the
   *  MODEL makes to the visible tool cannot inject hook events; then the payload is rebuilt
   *  from the rollout and handled exactly like a command hook's. */
  private async onMcpToolCall(agentId: string, token: Buffer, params: Record<string, unknown>): Promise<{ result: unknown; claims?: MailClaim[] } | { error: { code: number; message: string } }> {
    const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    const k = typeof args.k === 'string' && /^[0-9a-f]{32}$/.test(args.k) ? Buffer.from(args.k, 'hex') : null;
    if (params.name !== HIVE_HOOK_TOOL || !k || k.length !== token.length || !timingSafeEqual(k, token)) {
      return { error: { code: -32001, message: 'not a hook call' } };
    }
    const event = args.event;
    if (event !== 'PreToolUse' && event !== 'PostToolUse') return { error: { code: -32602, message: 'unsupported hook event' } };
    const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Record<string, unknown>;
    const threadId = typeof meta.threadId === 'string' ? meta.threadId : '';
    const home = this.hive.codexHomeFor(agentId);
    const file = home && threadId ? this.threadRollouts.find(home, threadId) : null;
    let tail = file ? this.threadRollouts.tail(file) : '';
    let rebuilt = file ? rebuildToolHook(tail, event) : { degraded: true } as ReturnType<typeof rebuildToolHook>;
    if (rebuilt.degraded && file) {
      // The spike saw the pending call land ~25 ms before PreToolUse; allow for a slower write.
      await new Promise((r) => setTimeout(r, MCP_ROLLOUT_RETRY_MS));
      tail = this.threadRollouts.tail(file);
      rebuilt = rebuildToolHook(tail, event);
    }
    const p: HookPayload = { hook_event_name: event, agent_id: agentId };
    if (threadId) p.session_id = threadId;
    if (file) p.transcript_path = file;
    if (rebuilt.turnId) p.turn_id = rebuilt.turnId;
    if (rebuilt.toolName) p.tool_name = rebuilt.toolName;
    if (rebuilt.toolInput !== undefined) p.tool_input = rebuilt.toolInput;
    if (rebuilt.toolResponse !== undefined) p.tool_response = rebuilt.toolResponse;
    if (rebuilt.degraded) p.payload_degraded = true;
    // HEAVY-JOB-LOCK-FAILOPEN (c): a still-degraded PreToolUse carries the pending shell commands,
    // so the heavy-job lock can classify what is about to run (gates still see it as degraded).
    if (rebuilt.degraded && event === 'PreToolUse' && tail) {
      const hint = pendingExecCommands(tail);
      if (hint.commands.length) p.codex_commands = hint.commands;
    }
    // A Codex SUBAGENT runs on its own thread: a thread other than the agent's recorded main
    // session is attributed to the agent but kept out of its session/transcript/lifecycle
    // (the 9082b05c split). With no recorded session yet, it is the agent's own.
    const own = this.hive.registry().agents[agentId]?.sessionId;
    if (threadId && own && threadId !== own) p.provider_agent_id = threadId;
    let out: unknown = {};
    let claims: MailClaim[] = [];
    try { out = await this.handleWithClaimContext(this.stampArrival(p, 'mcp')); claims = this.takeMailClaims(); } catch { out = {}; }
    return { result: out ?? {}, claims };
  }

  /** P4: one AGY one-way frame. A hook from a hive agent is handled like the shim's (the reply
   *  is dropped: only observational events come this way). A statusline frame must carry the
   *  CURRENT lease's owner token; a user's own session (no agent id) still feeds capacity,
   *  with agent_id null, exactly as the shim did. Anything else is ignored. */
  private onOneway(text: string): void {
    const f = parseOnewayFrame(text);
    if (!f) return;
    try {
      if (f.kind === 'hook') {
        if (!f.agentId) return;   // a user's own AGY session: not ours (the shim no-ops too)
        void this.handle(this.stampArrival(agyHookPayload(f.event, f.agentId, f.body as Record<string, unknown> | null), 'pipe-oneway'));
        return;
      }
      const owner = this.hive.agyStatuslineOwnerToken() ?? null;
      if (!owner || f.token !== owner || !f.bodyOk) return;
      void this.handle(this.stampArrival({ hook_event_name: 'AgyStatusLine', agent_id: f.agentId, read_at: Date.now(), agy_status: f.body }, 'pipe-oneway'));
    } catch { /* telemetry must never break the pipe */ }
  }

  /** Stamp the arrival order and transport before handle() (never trusted from the body),
   *  and count it for the per-minute transport log. */
  private stampArrival(p: HookPayload, transport: HookTransport): HookPayload {
    p.transport = transport;
    const agentId = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
    if (!agentId) { delete p.seq; return p; }
    const seq = (this.seqByAgent.get(agentId) ?? 0) + 1;
    this.seqByAgent.set(agentId, seq);
    p.seq = seq;
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.countsMinute) { this.flushTransportCounts(); this.countsMinute = minute; }
    const c = this.transportCounts.get(agentId) ?? { http: 0, pipe: 0, mcp: 0, 'pipe-oneway': 0 };
    c[transport] += 1;
    this.transportCounts.set(agentId, c);
    return p;
  }

  /** One log row per minute with hooks by transport per agent (http = 0 processes per hook,
   *  pipe = 2): the measure of what the broker removed. */
  private flushTransportCounts(): void {
    if (!this.transportCounts.size) return;
    const counts = Object.fromEntries(this.transportCounts);
    this.transportCounts = new Map();
    try { this.hive.appendLog({ kind: 'hook-transport', minute: this.countsMinute, counts }); } catch { /* best effort */ }
  }

  /** Hooks by transport per agent in the current minute (diagnostics, tests). */
  transportCountsNow(): Record<string, Record<HookTransport, number>> {
    return Object.fromEntries(this.transportCounts);
  }

  /** Read this agent's Codex allowance, if it is a Codex worker and anything moved. */
  private observeCodexCapacity(agentId: string, event: string, sessionId?: string, fromSubagent = false): void {
    try {
      const home = this.hive.codexHomeFor(agentId);
      if (!home) return;
      const read = this.codexCapacity.observeRollout(home, { rescan: event === 'SessionStart', sessionId });
      // MODEL-PINBACK G2: the live model, from the tail read above (no second walk or read).
      // Only the agent's OWN session: the rollout is bound to this hook's session id, and a
      // subagent's rollout runs the subagent's model. A line older than this process's launch
      // is a previous process's turn and is ignored inside observeLiveModel.
      if (read.turnModel && sessionId && !fromSubagent) {
        this.hive.observeLiveModel(agentId, 'codex', read.turnModel.model, { observedAt: read.turnModel.observedAt ?? undefined, effort: read.turnModel.effort });
      }
      if (!this.onCapacity) return;
      const obs = read.capacity;
      // The agent is carried with the reading: a pool key is a provider fact, and
      // which agents draw on it can only be learned from readings that arrived.
      if (obs) {
        let pending = this.codexNoReading.get(agentId);
        if (!pending || pending.sessionId !== sessionId) {
          pending = { sessionId: sessionId ?? '', firstHookAt: Date.now(), reported: false, gotReading: true };
          this.codexNoReading.set(agentId, pending);
        } else {
          pending.gotReading = true;
        }
        this.onCapacity?.(agentId, obs);
        return;
      }
      if (!sessionId) return;
      const now = Date.now();
      let pending = this.codexNoReading.get(agentId);
      if (!pending || pending.sessionId !== sessionId) {
        pending = { sessionId, firstHookAt: now, reported: false, gotReading: false };
        this.codexNoReading.set(agentId, pending);
      }
      if (!pending.gotReading && !pending.reported && now - pending.firstHookAt >= CODEX_NO_READING_AFTER_MS) {
        pending.reported = true;
        // Diagnostics are appendLog-only: never console-log a session identifier.
        this.hive.appendLog({ kind: 'capacity-codex-no-reading', agentId, sessionId, waitingMs: now - pending.firstHookAt });
      }
    } catch { /* telemetry must never break a hook boundary */ }
  }

  /**
   * One Antigravity statusline envelope. Always answers `{}`.
   *
   * A refused tick changes NOTHING - not the last good pool, not the lifecycle - and
   * is counted under its fixed drift code. The raw payload goes no further than the
   * normaliser: it is not logged, not stored, and not passed on.
   */
  private handleAgyStatus(p: HookPayload): unknown {
    this.observeAgyModel(p);
    try {
      const c = classifyAgyStatusLine({
        payload: p.agy_status,
        accountScope: agyAccountScope(),
        receivedAt: Date.now(),
        readAt: p.read_at
      });
      if (!c.ok) {
        // The boot tick is refused by design (N-1 b); it is not drift worth counting.
        if (c.driftCode === 'authenticating') return {};
        const key = `${c.version ?? '-'}|${c.driftCode}`;
        const bucket = this.agyDrift.has(key) || this.agyDrift.size < AGY_DRIFT_KEYS_MAX ? key : 'overflow';
        const n = (this.agyDrift.get(bucket) ?? 0) + 1;
        this.agyDrift.set(bucket, n);
        // First sighting of each kind only: a drifting build ticks after every render. To
        // the event log as well as the console, because log.jsonl is where a drift after an
        // AGY upgrade gets noticed - and the row is the fixed code and version, nothing else.
        if (n === 1) {
          console.warn('[agy-statusline] drift', { version: c.version, driftCode: c.driftCode });
          try { this.hive.appendLog({ kind: 'agy-statusline-drift', version: c.version, driftCode: c.driftCode }); } catch { /* best effort */ }
        }
        return {};
      }
      const agentId = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
      this.onAgyTick?.(agentId, c.tick);
    } catch { /* telemetry must never break the pipe */ }
    return {};
  }

  /**
   * MODEL-PINBACK G2: the MEASURED model of a hive agent's AGY session. Independent of the
   * capacity classification on purpose: a tick without a usable quota map still names the model.
   * `model.id` is the picker id format `--model` takes (live capture: "Gemini 3.7 Flash (Low)",
   * "Claude Sonnet 4.6 (Thinking)"), so no normalisation. A boot tick carries `model: null` and is
   * ignored: never a baseline, never a pin. A session nobody spawned (agent_id null) moves
   * nothing. AGY silently substitutes a retired id (launched "Gemini 3.5 Flash (Medium)", every
   * tick says "Gemini 3.8 Flash (High)"): with no human input that is an AUTO pin, not carried.
   */
  private observeAgyModel(p: HookPayload): void {
    try {
      const agentId = typeof p.agent_id === 'string' && p.agent_id ? p.agent_id : null;
      if (!agentId) return;
      const status = p.agy_status as { model?: unknown; agent_state?: unknown } | undefined;
      if (!status || typeof status !== 'object' || status.agent_state === 'authenticating') return;
      const model = status.model as { id?: unknown } | null | undefined;
      const id = model && typeof model === 'object' && typeof model.id === 'string' ? model.id.trim() : '';
      if (!id) return;
      const now = Date.now();
      const readAt = typeof p.read_at === 'number' && Number.isFinite(p.read_at) && p.read_at <= now ? p.read_at : now;
      this.hive.observeLiveModel(agentId, 'antigravity', id, { observedAt: readAt });
    } catch { /* telemetry must never break the pipe */ }
  }

  /** The transcript file of an agent's CURRENT session, if any hook has fired. */
  transcriptPath(agentId: string): string | undefined {
    return this.transcriptPaths.get(agentId);
  }

  /** The latest context-window accounting for an agent (current tokens + the real
   *  window size), or undefined if no statusLine tick has fired for it yet. */
  contextFor(agentId: string): { tokens: number; limit: number; ts: number } | undefined {
    return this.contextById.get(agentId);
  }

  /** MIDTURN-MAIL-BLIND L1: per agent, whether a turn is open, the inbox files present when it
   *  began (the turn's own mail, never announced), and the ones already announced. */
  private readonly turns = new Map<string, TurnState>();
  static readonly MIDTURN_MAIL_MAX_LISTED = 5;
  /** ZT-I1-MAIL: the harness turn counter behind a surfacing epoch when the provider supplies no
   *  turn id (§1.1). Boot-tagged, so an epoch never repeats across restarts. */
  private turnCounter = 0;
  private readonly bootTag = Date.now().toString(36);

  /** Turn boundaries, for every provider:
   *  - a turn BEGINS at UserPromptSubmit / SessionStart (Claude, Codex), or at the first
   *    PreInvocation / PostToolUse while no turn is open (AGY has no UserPromptSubmit; and a
   *    state lost across an app restart re-opens quietly). The inbox is snapshotted then.
   *  - a turn ENDS at Stop.
   *  - C5 (§11.5): a SessionStart with source `compact` inside an open turn is NOT a boundary: the
   *    epoch, the known set and the ids already surfaced in it all survive compaction.
   *  Each turn carries its surfacing EPOCH: the provider's turn id when it sends one (Codex), else
   *  the harness turn counter. A later hook with a different provider turn id moves the epoch. */
  private trackTurn(agentId: string, event: string, p?: HookPayload): void {
    const t = this.turns.get(agentId);
    const turnId = typeof p?.turn_id === 'string' && p.turn_id ? p.turn_id : null;
    const snapshot = (): void => {
      this.turns.set(agentId, {
        open: true, known: new Set(this.hive.inboxFileNames?.(agentId) ?? []), noticed: new Set(),
        epoch: turnId ?? `h-${this.bootTag}-${++this.turnCounter}`, injected: new Set(), mailHooks: 0, legacyNamed: new Set()
      });
    };
    if (event === 'SessionStart' && p?.source === 'compact' && t?.open) return;
    if (event === 'Stop') {
      // ZT-I1-MAIL §1.1: the Stop that closes the surfacing epoch makes its surfaced ids acted.
      // AGY's non-terminal Stop (fully_idle false) is mid-chain: the turn goes on.
      if (p?.fully_idle === false) return;
      // #45: a Codex Stop naming ANOTHER turn (a straggler) closes that turn only.
      if (turnId && t && t.epoch !== turnId) { this.closeMailEpoch(agentId, turnId, 'normal', 'stop'); return; }
      if (t) t.open = false;
      this.closeMailEpoch(agentId, t?.epoch ?? null, 'normal', 'stop');
      return;
    }
    if (event === 'StopFailure') {
      // §11.4: an API error ended the turn: surfaced ids go back to delivered with the marker.
      if (t) t.open = false;
      this.closeMailEpoch(agentId, t?.epoch ?? null, 'abnormal', 'stop-failure');
      return;
    }
    if (event === 'UserPromptSubmit') {
      // N3 (§11.17): the human typing into a LIVE turn joins its epoch (a Codex turn id still names it).
      if (t?.open && this.mailLifecycleActive(agentId)) {
        if (turnId && t.epoch !== turnId) { t.epoch = turnId; t.injected = new Set(); t.mailHooks = 0; }
        return;
      }
      // §11.4: otherwise any epoch still open ended without a Stop (an interrupt): abnormal, and
      // its ids are surfaced again, with the marker, in THIS turn (the block below).
      this.abortMailEpochs(agentId, t?.open ? 'interrupted' : 'next-turn');
      snapshot();
      return;
    }
    if (event === 'SessionStart') {
      // A new or resumed session: nothing surfaced in the old one is in this context.
      this.abortMailEpochs(agentId, `session-${typeof p?.source === 'string' && p.source ? p.source.slice(0, 20) : 'start'}`);
      snapshot();
      return;
    }
    if ((event === 'PreInvocation' || event === 'PostToolUse') && !t?.open) { snapshot(); return; }
    if (t?.open && turnId && t.epoch !== turnId) { t.epoch = turnId; t.injected = new Set(); t.mailHooks = 0; }
  }

  /** The surfacing epoch of the agent's current (or last) turn, or null before any hook. */
  mailEpoch(agentId: string): string | null {
    return this.turns.get(agentId)?.epoch ?? null;
  }

  // — ZT-I1-MAIL slice 3: epoch closes (§1.1, §11.1, §11.3, §11.4, §11.5, §11.7, N3) —

  private coordination: MailCoordination | null = null;
  /** Main wires the wake coordinator in (N3's lifecycle, legacy-read wake ids, §11.3 re-keying). */
  setMailCoordination(c: MailCoordination | null): void { this.coordination = c; }

  private mailLifecycleActive(agentId: string): boolean {
    try { return this.coordination?.lifecycleActive(agentId) ?? false; } catch { return false; }
  }

  /**
   * Close one surfacing epoch in the ledger.
   *  - normal (its Stop, a Codex task_complete for the same turn): the evidence is scanned first
   *    (§11.1), then surfaced ids become acted (and archived), tentative ones go back to delivered
   *    (`mail-surface-unconfirmed`, or `mail-surface-late` with the transport and elapsed time);
   *    for a legacy-read agent, the ids the harness named to it are acted too (§2.2);
   *  - abnormal (StopFailure, an interrupt, a new session, PTY exit/respawn, submit-unconfirmed,
   *    the 30-minute backstop): everything open goes back to delivered with the marker.
   * The coordinator is told either way (§11.3), even when nothing was open (`epoch` null).
   */
  closeMailEpoch(agentId: string, epoch: string | null, outcome: 'normal' | 'abnormal', reason: string): { acted: string[]; redelivered: string[] } {
    const out = { acted: [] as string[], redelivered: [] as string[] };
    const mail = this.hive.mail;
    if (!mail || !mail.hasAgent(agentId)) return out;
    try {
      if (epoch) {
        if (outcome === 'normal') this.confirmMailSurfacing(agentId);
        const r = mail.closeEpoch(agentId, epoch, outcome, {
          reason, late: this.mailLateIds(agentId, epoch), lateDetail: this.mailLateDetail(agentId, epoch)
        });
        out.acted.push(...r.acted);
        out.redelivered.push(...r.redelivered);
        this.mailLate.get(agentId)?.delete(epoch);
        const waits = this.mailAwaiting.get(agentId)?.filter((w) => w.epoch !== epoch);
        if (waits?.length) this.mailAwaiting.set(agentId, waits); else this.mailAwaiting.delete(agentId);
      }
      if (outcome === 'normal' && this.mailChannel(agentId).mode === 'legacy-read') {
        const t = this.turns.get(agentId);
        const named = new Set<string>([...(t && t.epoch === epoch ? t.legacyNamed : []), ...(this.coordination?.wakeIds(agentId) ?? [])]);
        if (named.size) out.acted.push(...mail.legacyActed(agentId, named, 'legacy-read', { epoch }));
      }
    } catch (e) {
      try { this.hive.appendLog({ kind: 'mail-ledger-error', agentId, op: 'close', epoch, error: String(e) }); } catch { /* noop */ }
    }
    try { this.coordination?.onEpochClosed?.(agentId, outcome, reason, out.redelivered); } catch { /* the coordinator never breaks a hook */ }
    return out;
  }

  /** Close every epoch still open for this agent as abnormal (optionally only those opened at or
   *  after `since`). The current turn is closed with them. Returns the epochs closed. */
  private abortMailEpochs(agentId: string, reason: string, since?: number, notifyEmpty = false): string[] {
    const mail = this.hive.mail;
    if (!mail || !mail.hasAgent(agentId)) return [];
    let open: Array<{ epoch: string; since: number }> = [];
    try { open = mail.openEpochs(agentId); } catch { open = []; }
    const closed: string[] = [];
    for (const e of open) {
      if (since !== undefined && e.since < since) continue;
      this.closeMailEpoch(agentId, e.epoch, 'abnormal', reason);
      closed.push(e.epoch);
    }
    const t = this.turns.get(agentId);
    if (t && (since === undefined || closed.includes(t.epoch))) t.open = false;
    // A dead PTY also ends a wake whose turn never surfaced anything: the coordinator still hears it.
    if (!closed.length && notifyEmpty) this.closeMailEpoch(agentId, null, 'abnormal', reason);
    return closed;
  }

  /** §1.1 abnormal end outside any hook: PTY exit, crash or respawn (noteSpawn). */
  abortMailTurn(agentId: string, reason: string): string[] {
    return this.abortMailEpochs(agentId, reason, undefined, true);
  }

  /** §1.1 `submit-unconfirmed` for the carrying wake: the epochs opened since that wake's claim. */
  abortMailEpochsSince(agentId: string, since: number, reason = 'submit-unconfirmed'): string[] {
    return this.abortMailEpochs(agentId, reason, since);
  }

  /** §1.1 / §11.4 last backstop: an epoch open for MAIL_STALE_EPOCH_MS with no Stop, closed as
   *  abnormal. The CALLER applies the idle gate (the lifecycle is idle by the existing signals). */
  closeStaleMailEpochs(agentId: string, now: number, maxAgeMs = MAIL_STALE_EPOCH_MS): string[] {
    const mail = this.hive.mail;
    if (!mail || !mail.hasAgent(agentId)) return [];
    let open: Array<{ epoch: string; since: number }> = [];
    try { open = mail.openEpochs(agentId); } catch { return []; }
    const closed: string[] = [];
    for (const e of open) {
      if (now - e.since < maxAgeMs) continue;
      this.closeMailEpoch(agentId, e.epoch, 'abnormal', 'stale-epoch');
      closed.push(e.epoch);
    }
    const t = this.turns.get(agentId);
    if (t && closed.includes(t.epoch)) t.open = false;
    return closed;
  }

  /** Codex: rollout `task_complete` for the SAME turn id closes that turn's epoch normally. A
   *  completion of any other turn (#52, a stale one) touches nothing else. */
  closeMailTurn(agentId: string, turnId: string): { acted: string[]; redelivered: string[] } {
    const mail = this.hive.mail;
    if (!turnId || !mail || !mail.hasAgent(agentId)) return { acted: [], redelivered: [] };
    let open = false;
    try { open = mail.openEpochs(agentId).some((e) => e.epoch === turnId); } catch { open = false; }
    const t = this.turns.get(agentId);
    if (t && t.epoch === turnId) t.open = false;
    if (!open) return { acted: [], redelivered: [] };
    return this.closeMailEpoch(agentId, turnId, 'normal', 'task-complete');
  }

  /** The notice for inbox files that appeared since this turn began and were not announced yet,
   *  or null. Each file is announced ONCE (a `peek` shows it without consuming it: the
   *  PreToolUse notice, so the PostToolUse after it still delivers it if a CLI ignores
   *  PreToolUse context). A superseding message says what it supersedes. Sender-controlled
   *  text is escaped so it cannot close the <inbox-update> tag (N2). */
  private midTurnMail(agentId: string, peek = false): string | null {
    const t = this.turns.get(agentId);
    if (!t?.open) return null;
    const fresh = (this.hive.inboxFileNames?.(agentId) ?? []).filter((f) => !t.known.has(f) && !t.noticed.has(f)).sort();
    if (!fresh.length) return null;
    // Legacy-read (§2.2): what the notice NAMES is what the agent was told to read; its Stop acts it.
    if (!peek) for (const f of fresh) { t.noticed.add(f); t.legacyNamed.add(f.replace(/\.json$/, '')); }
    const esc = (s: string): string => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = fresh.slice(0, HookServer.MIDTURN_MAIL_MAX_LISTED).map((f) => {
      const h = this.hive.inboxHeader?.(agentId, f) ?? null;
      if (!h) return `- ${esc(f)}`;
      const sup = h.supersedes?.length ? ` (SUPERSEDES ${esc(h.supersedes.join(', '))})` : '';
      return `- from ${esc(h.from)}: "${esc(h.subject.slice(0, 160))}" [${esc(h.id)}]${sup}`;
    });
    if (fresh.length > lines.length) lines.push(`- and ${fresh.length - lines.length} more`);
    if (!peek) { try { this.hive.appendLog({ kind: 'midturn-mail-notice', agentId, count: fresh.length }); } catch { /* noop */ } }
    return `<inbox-update>\n${fresh.length} new message(s) arrived in your inbox during this turn:\n${lines.join('\n')}\nRead them before you send or finish: one may change or cancel what you are doing.\n</inbox-update>`;
  }

  // — ZT-I1-MAIL slice 2: bodies in hook context (§2, §11.1, §11.2, §11.6, §11.9) —

  /** Claims made by the handle() call in progress; the transport takes them after handle(). */
  private mailClaims: MailClaim[] = [];
  /** §11.1: tentative ids per agent waiting for transcript / rollout evidence. */
  private readonly mailAwaiting = new Map<string, EvidenceWait[]>();
  /** §11.1: ids whose hook response left too late (or never flushed), per agent and epoch, with how
   *  (Q8: transport + elapsed). The epoch close passes them as `late` (`mail-surface-late`). */
  private readonly mailLate = new Map<string, Map<string, Map<string, MailLateDetail>>>();
  /** Q13: bodies in neither inbox/ nor .done/ (or unparseable), with the files' signature then:
   *  skipped until either file changes. A transient read error is never recorded here (retried). */
  private readonly mailUnreadable = new Map<string, Map<string, { sig: string; at: number }>>();
  /** Q28: an unparseable body (unchanged file) is re-tried after this long, so its failures are
   *  counted (3 spanning >= 60 s close it terminally). */
  static readonly MAIL_UNREADABLE_RETRY_MS = 30_000;
  /** Q13: `mail-agent-moved` is logged once per id per process. */
  private readonly mailMovedLogged = new Set<string>();
  /** Q11: ids that held a block back at an earlier hook (passed over if they still do not fit). */
  private readonly mailBlocked = new Map<string, Set<string>>();
  /** ONLY the provider is cached (it changes only with a respawn, and it costs a registry.json
   *  read). The mail MODE is never cached: it follows the ledger's channel override, which a
   *  degradation switches at any moment (god cce9ab: a Stop 5 s after the switch was closed in the
   *  old mode, so its legacy-read acted never happened). */
  private readonly providerCache = new Map<string, { provider: AgentProvider | undefined; at: number }>();
  static readonly PROVIDER_CACHE_MS = 5_000;

  /** The claims of the last handle() call (the transport settles them after the flush). */
  takeMailClaims(): MailClaim[] {
    const c = this.mailClaims;
    this.mailClaims = [];
    return c;
  }

  /** Settle `claims` when `stream` has flushed its response (`finish`), or as never flushed
   *  (`close` first: the provider hung up, e.g. at its own timeout). */
  private watchMailFlush(stream: { once(event: 'finish' | 'close', fn: () => void): unknown }, claims: MailClaim[], receivedAt: number): void {
    if (!claims.length) return;
    let settled = false;
    stream.once('finish', () => { if (settled) return; settled = true; this.settleMailClaims(claims, receivedAt, Date.now()); });
    stream.once('close', () => { if (settled) return; settled = true; this.settleMailClaims(claims, receivedAt, null); });
  }

  /**
   * CL-M4-BRIEFING-BUDGET S2 (Jim): a late or failed briefing is never silent. The same flush watch
   * and on-time measure as mail (shim elapsed + arrival to flush, against the pipe limit): a reply
   * flushed in time is printed by the shim (printedChars = its working-set chars); one at or past
   * the limit met the shim's 5 s give-up, or never flushed, and the agent started WITHOUT it.
   */
  private watchBriefingFlush(stream: { once(event: 'finish' | 'close', fn: () => void): unknown }, p: HookPayload, res: unknown, startedAt: number): void {
    const ctx = (res as { hookSpecificOutput?: { additionalContext?: unknown } } | null)?.hookSpecificOutput?.additionalContext;
    const chars = typeof ctx === 'string' ? ctx.length : 0;
    if (!chars || !p.agent_id) return;
    const limitMs = mailLatencyLimitMs('pipe');
    let settled = false;
    const settle = (flushedAt: number | null) => {
      if (settled) return;
      settled = true;
      const latencyMs = flushedAt === null ? null : Math.max(0, flushedAt - startedAt);
      const late = latencyMs === null || latencyMs >= limitMs;
      try {
        this.hive.appendLog({ kind: late ? 'claims-briefing-late' : 'claims-briefing-flush', agentId: p.agent_id, source: p.source ?? null, chars, printedChars: late ? 0 : chars, latencyMs, limitMs, ...(late ? { outcome: latencyMs === null ? 'not-flushed' : 'shim-gave-up' } : {}) });
      } catch { /* best effort */ }
    };
    stream.once('finish', () => settle(Date.now()));
    stream.once('close', () => settle(null));
  }

  /**
   * §11.1 latency rule, at the response flush. A response that left at or after the transport's
   * limit (or never flushed) is LATE: its ids stay tentative and are recorded for slice 3's close
   * (`mail-surface-late`). Otherwise:
   *  - latency-evidence providers (AGY and any channel without a readable record): confirmed;
   *  - evidence providers: only the N1 fallback ids are confirmed here (`latency-fallback`, with
   *    `mail-evidence-missing` and the UI notice); the rest wait for the transcript / rollout.
   */
  settleMailClaims(claims: MailClaim[], receivedAt: number, flushedAt: number | null): void {
    const mail = this.hive.mail;
    for (const c of claims) {
      const latency = flushedAt === null ? null : Math.max(0, flushedAt - receivedAt);
      c.latencyMs = latency;
      const limit = mailLatencyLimitMs(c.transport);
      if (latency === null || latency >= limit) {
        let byEpoch = this.mailLate.get(c.agentId);
        if (!byEpoch) { byEpoch = new Map(); this.mailLate.set(c.agentId, byEpoch); }
        const set = byEpoch.get(c.epoch) ?? new Map<string, MailLateDetail>();
        for (const id of c.ids) set.set(id, { transport: c.transport ?? null, latencyMs: latency });
        byEpoch.set(c.epoch, set);
        while (byEpoch.size > 8) byEpoch.delete(byEpoch.keys().next().value as string);
        try { this.hive.appendLog({ kind: 'mail-hook-late', agentId: c.agentId, ids: c.ids, epoch: c.epoch, hookKind: c.hookKind, transport: c.transport ?? null, latencyMs: latency, limitMs: limit }); } catch { /* best effort */ }
        continue;
      }
      if (!mail) continue;
      try {
        if (c.evidence === 'latency') {
          mail.confirmSurfaced(c.agentId, c.ids, c.epoch, 'latency');
        } else if (c.fallbackIds.length) {
          const done = mail.confirmSurfaced(c.agentId, c.fallbackIds, c.epoch, 'latency-fallback');
          if (done.length) mail.noteEvidenceMissing(c.agentId, done, c.epoch, c.evidence);
        }
      } catch { /* the ledger logs its own failures; a hook never breaks on it */ }
    }
  }

  /** Ids surfaced in `epoch` whose response was late (for closeEpoch's `late`). */
  mailLateIds(agentId: string, epoch: string): string[] {
    return [...(this.mailLate.get(agentId)?.get(epoch)?.keys() ?? [])];
  }

  /** Q8: per late id, the transport and elapsed ms of its response (for the `mail-surface-late` row). */
  mailLateDetail(agentId: string, epoch: string): Record<string, MailLateDetail> {
    return Object.fromEntries(this.mailLate.get(agentId)?.get(epoch) ?? []);
  }

  /** Q13: ids whose body is in neither inbox/ nor .done/ (they are kept out of wakes). */
  mailSkippedIds(agentId: string): string[] {
    return [...(this.mailUnreadable.get(agentId)?.keys() ?? [])];
  }

  /** The agent's provider (cached briefly: registry.json is read from disk) and its mail channel
   *  mode (§11.9), computed FRESH on every call from the ledger's channel override (an in-memory
   *  read), so a degradation applies to the very next hook. With no ledger on the hive (a test
   *  double) there is no injection. */
  mailChannel(agentId: string): { provider: AgentProvider | undefined; mode: MailChannelMode } {
    const now = Date.now();
    let provider: AgentProvider | undefined;
    const c = this.providerCache.get(agentId);
    if (c && now - c.at < HookServer.PROVIDER_CACHE_MS) {
      provider = c.provider;
    } else {
      try { provider = normalizeAgentProvider(this.hive.registry?.().agents[agentId]?.provider); } catch { provider = undefined; }
      if (!provider) { try { if (this.hive.codexHomeFor?.(agentId)) provider = 'codex'; } catch { /* none */ } }
      this.providerCache.set(agentId, { provider, at: now });
    }
    let override = null;
    try { override = this.hive.mail?.channelOverride(agentId) ?? null; } catch { override = null; }
    return { provider, mode: this.hive.mail ? mailChannelMode(provider, override) : 'legacy-move' as MailChannelMode };
  }

  /** The transcript (Claude) or rollout (Codex) that records what reached the model. */
  private evidenceFile(agentId: string, kind: MailEvidenceKind): string | null {
    if (kind === 'latency') return null;
    const known = this.transcriptPaths.get(agentId);
    if (known) return known;
    if (kind === 'codex-rollout') {
      try {
        const home = this.hive.codexHomeFor(agentId);
        const session = this.hive.registry().agents[agentId]?.sessionId;
        if (home && session) return this.threadRollouts.find(home, session);
      } catch { /* none */ }
    }
    return null;
  }

  /** Pending mail for this agent that this epoch has not surfaced, with its bodies. Bounded work
   *  per hook: bodies are read only while they could still fit one block (twice the joined budget,
   *  at most 50 files); the rest are returned as `more` (header only, always deferred). */
  private mailItems(agentId: string, t: TurnState | undefined): { items: MailBlockItem[]; more: MailEntry[] } {
    const mail = this.hive.mail;
    const none = { items: [] as MailBlockItem[], more: [] as MailEntry[] };
    if (!mail) return none;
    let pending: MailEntry[];
    try { pending = mail.pending(agentId); } catch { return none; }
    const items: MailBlockItem[] = [];
    const more: MailEntry[] = [];
    let chars = 0;
    const cap = this.mailCap(agentId);
    for (const e of pending) {
      if (t?.injected.has(e.id) || this.mailBodySkipped(agentId, e.id)) continue;
      if (items.length >= 50 || chars > 2 * MAIL_JOINED_BUDGET) { more.push(e); continue; }
      const got = this.readMailBody(agentId, e.id);
      if (!got) continue;
      items.push(this.mailItem(e, got, cap));
      chars += cap && !mailCapExempt(e.from, ALWAYS_WAKE_SENDERS) ? Math.min(got.body.length, cap) : got.body.length;
    }
    return { items, more };
  }

  /** READS-MAIL-CAP (1.1.83): this agent's per-message body cap (0 = whole bodies). */
  private mailCap(agentId: string): number {
    let own: unknown;
    try { own = this.hive.registry?.().agents[agentId]?.mailCapChars; } catch { own = undefined; }
    let isGod = false;
    try { isGod = this.hive.isGod(agentId); } catch { isGod = false; }
    let configured: unknown;
    try { configured = this.getConfig().godMailCapChars; } catch { configured = undefined; }
    return effectiveMailCap(own, configured, isGod);
  }

  /** One block item; the Human's and the harness's mail is never capped. */
  private mailItem(e: MailEntry, got: { body: string; path: string }, cap: number): MailBlockItem {
    const item: MailBlockItem = { entry: e, body: got.body, path: got.path };
    if (cap > 0 && !mailCapExempt(e.from, ALWAYS_WAKE_SENDERS)) item.cap = cap;
    return item;
  }

  /** READS-MAIL-CAP: one `mail-capped` row per message shown shortened (the measure, and what
   *  Creed's report counts against the re-reads of the same paths). */
  private logCapped(agentId: string, block: MailBlock, claimed: string[], epoch: string, hookKind: string, items: MailBlockItem[]): void {
    for (const id of block.capped) {
      if (!claimed.includes(id)) continue;
      const it = items.find((i) => i.entry.id === id);
      try { this.hive.appendLog({ kind: 'mail-capped', agentId, id, epoch, hookKind, bodyChars: it?.body.length ?? null, cap: it?.cap ?? null, shownChars: it ? mailCapCut(escapeMailText(it.body), it.cap) : null }); } catch { /* noop */ }
    }
  }

  /** Q13: is this body recorded as missing/unreadable, with its files unchanged since? A change
   *  (the file reappears, is rewritten, is moved) clears the record and it is read again. */
  private mailBodySkipped(agentId: string, id: string): boolean {
    const skip = this.mailUnreadable.get(agentId);
    const rec = skip?.get(id);
    if (rec === undefined) return false;
    let now: string | null = null;
    try { now = this.hive.mailBodySig?.(agentId, id) ?? null; } catch { now = null; }
    if (now !== null && now !== rec.sig) { skip!.delete(id); return false; }
    // Q28: the same unparseable file is tried again after a while (it still stays out of wakes).
    if (Date.now() - rec.at >= HookServer.MAIL_UNREADABLE_RETRY_MS) return false;
    return true;
  }

  /**
   * One message body for the block (Q13, god's ruling). From inbox/; when the agent already moved
   * it (the 1.1.74 habit), from inbox/.done/, logged `mail-agent-moved` once per id: a move is
   * never "handled" (§7.1 step 4). In neither place, or unparseable: `mail-body-missing` plus the
   * integrity banner, skipped until the files change. A transient read error (an antivirus lock)
   * is simply retried at the next hook.
   */
  private readMailBody(agentId: string, id: string): { body: string; path: string } | null {
    const read = this.hive.mailBody;
    if (!read) {
      // A test double without the Q13 reader: the plain inbox read.
      const got = this.hive.inboxMessage?.(agentId, id) ?? null;
      if (!got) return null;
      return { body: typeof got.msg.body === 'string' ? got.msg.body : JSON.stringify(got.msg.body ?? '') ?? '', path: got.path };
    }
    let got: ReturnType<HiveManager['mailBody']>;
    try { got = read.call(this.hive, agentId, id); } catch { return null; }
    if (!got.ok) {
      // God db52b8: set aside by an explicit archive: never missing, never counted, not remembered.
      if (got.reason === 'transient' || got.reason === 'set-aside') return null;
      try { this.hive.mail?.noteBodyMissing(agentId, id, got.reason); } catch { /* best effort */ }
      if (got.reason === 'missing') {
        // Q15 (god's ruling): in NEITHER place is terminal and persisted (acted, reason
        // body-missing): never pending, never a wake, across restarts. The beat's reconcile
        // redelivers it if the file comes back into inbox/.
        let closed = false;
        try { closed = this.hive.mail?.bodyMissing(agentId, id, 'missing') ?? false; } catch { closed = false; }
        if (closed) return null;
      }
      if (got.reason === 'unreadable') {
        // Q28 (Creed): the failure is counted in the ledger (persisted); the third one spanning at
        // least 60 s closes it terminally (acted, body-unparseable, row + banner): no wake, ever,
        // across restarts. The beat redelivers it once the file changes and parses.
        let r: 'closed' | 'counted' | 'none' = 'none';
        try { r = this.hive.mail?.parseFailed(agentId, id) ?? 'none'; } catch { r = 'none'; }
        if (r === 'closed') { this.mailUnreadable.get(agentId)?.delete(id); return null; }
      }
      // Unparseable (or the ledger refused the close): skipped until either file changes, and
      // re-tried after MAIL_UNREADABLE_RETRY_MS so the Q28 count can reach its close.
      const skip = this.mailUnreadable.get(agentId) ?? new Map<string, { sig: string; at: number }>();
      skip.set(id, { sig: got.sig, at: Date.now() });
      this.mailUnreadable.set(agentId, skip);
      return null;
    }
    if (got.moved && !this.mailMovedLogged.has(`${agentId}|${id}`)) {
      this.mailMovedLogged.add(`${agentId}|${id}`);
      try { this.hive.appendLog({ kind: 'mail-agent-moved', agentId, id }); } catch { /* best effort */ }
    }
    const body = typeof got.msg.body === 'string' ? got.msg.body : JSON.stringify(got.msg.body ?? '') ?? '';
    return { body, path: got.path };
  }

  private mailReminders(agentId: string): MailObligation[] {
    const mail = this.hive.mail;
    if (!mail) return [];
    try { return [...mail.awaitingReply(agentId), ...mail.openRequests(agentId)]; } catch { return []; }
  }

  /**
   * The `<hive-mail>` block for this hook, inside the joined budget (§11.2), and the claim of its
   * ids as `surfacing` in the current epoch. Null when nothing is pending or nothing fits.
   */
  private surfaceMail(agentId: string, event: string, p: HookPayload, provider: AgentProvider | undefined, others: Array<string | null>): string | null {
    const mail = this.hive.mail;
    if (!mail) return null;
    const t = this.turns.get(agentId);
    const epoch = t?.epoch ?? `h-${this.bootTag}-${++this.turnCounter}`;
    const phase = event === 'UserPromptSubmit' || (event === 'PreInvocation' && (t?.mailHooks ?? 0) === 0) ? 'turn-start' : 'mid-turn';
    if (t) t.mailHooks++;
    const { items, more } = this.mailItems(agentId, t);
    if (!items.length && !more.length) return null;
    const blockedBefore = this.mailBlocked.get(agentId);
    const block = buildMailBlock({ items, more, budget: mailBudgetFor(others), phase, reminders: this.mailReminders(agentId), skippable: blockedBefore });
    // Q11: what held the block back at THIS hook may be passed over at the next one.
    const nextBlocked = new Set([...(blockedBefore ?? [])].filter((id) => !block.surfacing.includes(id)));
    for (const id of block.blocked) nextBlocked.add(id);
    if (nextBlocked.size) this.mailBlocked.set(agentId, nextBlocked); else this.mailBlocked.delete(agentId);
    if (!block.text) return null;
    if (!block.surfacing.length) return block.text;     // headers only: nothing is claimed
    let claimed: string[] = [];
    try { claimed = mail.claimSurfacing(agentId, block.surfacing, epoch, event); } catch (e) {
      try { this.hive.appendLog({ kind: 'mail-ledger-error', agentId, op: 'surfacing', error: String(e) }); } catch { /* noop */ }
      return null;   // never show a body the ledger did not record
    }
    for (const id of claimed) t?.injected.add(id);
    this.logPathOnly(agentId, block, claimed, epoch, event, items);
    this.logCapped(agentId, block, claimed, epoch, event, items);
    this.registerMailClaim(agentId, claimed, epoch, event, p, provider, items.map((i) => i.entry));
    return block.text;
  }

  /** Q22 (Creed): one `mail-truncated` row per message surfaced as header + path only. */
  private logPathOnly(agentId: string, block: { pathOnly: string[] }, claimed: string[], epoch: string, hookKind: string, items: MailBlockItem[]): void {
    for (const id of block.pathOnly) {
      if (!claimed.includes(id)) continue;
      const it = items.find((i) => i.entry.id === id);
      try { this.hive.appendLog({ kind: 'mail-truncated', agentId, id, epoch, hookKind, bodyChars: it?.body.length ?? null, shown: 'header+path', shownChars: 0 }); } catch { /* noop */ }
    }
  }

  /** A hook response carries `claimed` (now `surfacing`): settle it at the flush (latency, N1)
   *  and wait for the transcript / rollout record (§11.1). */
  private registerMailClaim(agentId: string, claimed: string[], epoch: string, event: string, p: HookPayload, provider: AgentProvider | undefined, entries: MailEntry[]): void {
    if (!claimed.length) return;
    const kind = mailEvidenceKind(provider);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const fallbackIds = kind === 'latency' ? [] : claimed.filter((id) => (byId.get(id)?.unconfirmedSurfacings ?? 0) >= MAIL_UNCONFIRMED_FALLBACK_AFTER);
    this.mailClaims.push({ agentId, ids: claimed, epoch, hookKind: event, transport: p.transport, evidence: kind, fallbackIds });
    if (kind !== 'latency') {
      const file = this.evidenceFile(agentId, kind);
      let offset = 0;
      if (file) { try { offset = statSync(file).size; } catch { offset = 0; } }
      const list = this.mailAwaiting.get(agentId) ?? [];
      const same = list.find((w) => w.epoch === epoch && w.file === file);
      if (same) for (const id of claimed) same.ids.add(id);
      else list.push({ epoch, ids: new Set(claimed), kind, file, offset, scannedFile: null, scannedSize: -1 });
      this.mailAwaiting.set(agentId, list);
    }
  }

  /**
   * §11.5: SessionStart(compact) inside a turn is not an epoch boundary; it re-injects the ids
   * this epoch already surfaced (not yet acted), from the ledger, through the SessionStart
   * additionalContext. That re-injection is itself a surfacing step (surfaced → surfacing, same
   * epoch), confirmed as in §11.1. Ids that do not fit the joined budget go back to delivered
   * with the marker and drip in at the next hooks of the same turn.
   */
  /** READS-COMPACT-HEALTH: what the last reinjectMail found open and claimed (read at once by the caller). */
  private lastReinject = new Map<string, { open: string[]; claimed: string[] }>();

  /** READS-COMPACT-HEALTH: the carry note for a SessionStart(compact): this agent's cards in
   *  progress (tasks.json, status doing) and the mail it still owes an answer to that this turn's
   *  re-injection does not already carry. */
  private compactCarry(agentId: string): { text: string | null; cards: string[]; obligations: string[]; cardsDoing: string[]; obligationsOpen: number } {
    let cards: CarryCard[] = [];
    try {
      const doc = this.hive.tasks?.() as { tasks?: Array<{ id?: unknown; title?: unknown; status?: unknown; assignee?: unknown }> } | undefined;
      cards = (doc?.tasks ?? [])
        .filter((t) => t && t.status === 'doing' && t.assignee === agentId && typeof t.id === 'string')
        .map((t) => ({ id: String(t.id), title: typeof t.title === 'string' ? t.title : '' }));
    } catch { cards = []; }
    const epoch = this.turns.get(agentId)?.epoch;
    const seen = new Set<string>();
    const obligations: CarryObligation[] = [];
    for (const r of this.mailReminders(agentId)) {
      const e = r.entry;
      // Unseen mail comes as the block itself; this turn's open mail is re-injected whole.
      if (seen.has(e.id) || e.state === 'delivered') continue;
      if (epoch && e.epoch === epoch && (e.state === 'surfacing' || e.state === 'surfaced')) continue;
      seen.add(e.id);
      obligations.push({ id: e.id, from: e.from, subject: e.subject, what: e.act === 'request' ? 'request' : 'reply expected' });
    }
    const c = compactCarryText(cards, obligations);
    return { ...c, cardsDoing: cards.map((x) => x.id), obligationsOpen: obligations.length };
  }

  private reinjectMail(agentId: string, p: HookPayload, provider: AgentProvider | undefined, others: Array<string | null>): string | null {
    const mail = this.hive.mail;
    const t = this.turns.get(agentId);
    if (!mail || !t?.open) return null;
    let open: MailEntry[];
    try {
      open = Object.values(mail.ledger(agentId).entries)
        .filter((e) => e.epoch === t.epoch && (e.state === 'surfaced' || e.state === 'surfacing'))
        .sort((a, b) => a.seq - b.seq);
    } catch { return null; }
    if (!open.length) return null;
    this.lastReinject.set(agentId, { open: open.map((e) => e.id), claimed: [] });
    const items: MailBlockItem[] = [];
    const cap = this.mailCap(agentId);
    for (const e of open) {
      const got = this.readMailBody(agentId, e.id);
      if (got) items.push(this.mailItem(e, got, cap));
    }
    const block = buildMailBlock({ items, budget: mailBudgetFor(others), phase: 'compact' });
    const fit = block.text ? block.surfacing : [];
    const out = open.map((e) => e.id).filter((id) => !fit.includes(id) && items.some((i) => i.entry.id === id));
    let claimed: string[] = [];
    try {
      claimed = mail.reinject(agentId, fit, t.epoch, 'SessionStart');
      if (out.length) {
        mail.redeliver(agentId, out, 'compact-overflow');
        for (const id of out) t.injected.delete(id);   // they may surface again in this epoch
      }
    } catch (e) {
      try { this.hive.appendLog({ kind: 'mail-ledger-error', agentId, op: 'reinject', error: String(e) }); } catch { /* noop */ }
      return null;
    }
    if (!claimed.length) return null;
    this.lastReinject.set(agentId, { open: open.map((e) => e.id), claimed });
    this.logPathOnly(agentId, block, claimed, t.epoch, 'SessionStart', items);
    this.logCapped(agentId, block, claimed, t.epoch, 'SessionStart', items);
    this.registerMailClaim(agentId, claimed, t.epoch, 'SessionStart', p, provider, open);
    return block.text;
  }

  /** Claude PreToolUse (the SEND moment, N1 of 1.1.55): the headers of mail waiting for its body,
   *  as a PEEK. No body, no marker, no claim: the PostToolUse after it carries the bodies. */
  private mailPeek(agentId: string): string | null {
    const t = this.turns.get(agentId);
    if (!t?.open || !this.hive.mail) return null;
    let pending: MailEntry[];
    try { pending = this.hive.mail.pending(agentId); } catch { return null; }
    const skip = this.mailUnreadable.get(agentId);
    const waiting = pending.filter((e) => !t.injected.has(e.id) && !skip?.has(e.id));
    if (!waiting.length) return null;
    return buildMailHeaders(waiting, MAIL_JOINED_BUDGET, `${waiting.length} new message(s) arrived during this turn; their full text follows after this tool call:`).text;
  }

  /**
   * §11.1 deterministic confirmation for Claude (session transcript) and Codex (rollout): the
   * record written for a hook response carrying `hive-mail:<id>` confirms that id (`evidence`).
   * Run at every hook of the agent while ids wait (the record lands after the response), and
   * exported for slice 3's Stop before it closes the epoch. Reads a bounded window from the
   * claim-time size (the file tail); an unchanged file is not re-read. Returns the ids confirmed.
   */
  confirmMailSurfacing(agentId: string): string[] {
    const list = this.mailAwaiting.get(agentId);
    const mail = this.hive.mail;
    if (!list?.length || !mail) return [];
    const confirmed: string[] = [];
    try {
      const doc = mail.ledger(agentId);
      for (const w of list) {
        for (const id of [...w.ids]) {
          const e = doc.entries[id];
          if (!e || e.state !== 'surfacing' || e.epoch !== w.epoch) w.ids.delete(id);
        }
        if (!w.ids.size) continue;
        const file = this.evidenceFile(agentId, w.kind);
        if (!file) continue;
        let size: number;
        try { size = statSync(file).size; } catch { continue; }
        if (file === w.scannedFile && size === w.scannedSize) continue;
        const from = file === w.file ? Math.max(0, w.offset - MAIL_EVIDENCE_SCAN_BACK_BYTES) : Math.max(0, size - MAIL_EVIDENCE_SCAN_MAX_BYTES);
        const win = readFileWindow(file, from, MAIL_EVIDENCE_SCAN_MAX_BYTES);
        if (!win) continue;
        w.scannedFile = file;
        w.scannedSize = size;
        const found = mailEvidenceIn(win.text, w.ids, w.kind);
        if (!found.size) continue;
        const done = mail.confirmSurfaced(agentId, found, w.epoch, 'evidence');
        for (const id of found) w.ids.delete(id);
        confirmed.push(...done);
      }
    } catch { /* evidence is best effort: an unconfirmed id is re-surfaced, never lost */ }
    const left = list.filter((w) => w.ids.size);
    if (left.length) this.mailAwaiting.set(agentId, left); else this.mailAwaiting.delete(agentId);
    return confirmed;
  }

  /** READS-ROTATE-AT-SIZE pilot: logs each compaction's health (main wires it; null = not logged). */
  private compactHealth: CompactHealthWatch | null = null;
  setCompactHealth(w: CompactHealthWatch | null): void { this.compactHealth = w; }

  /** HEAVY-JOB-SERIALIZE: the app-held heavy-job lock (main wires it; null in tests = no lock). */
  private heavyLock: HeavyJobLock | null = null;
  setHeavyLock(lock: HeavyJobLock | null): void { this.heavyLock = lock; }

  /** The id that pairs a heavy call's PreToolUse with its PostToolUse: the provider's tool-use
   *  id when it sends one, else the command itself (identical in both hooks). */
  private static heavyCallId(p: HookPayload): string {
    const id = (p as { tool_use_id?: unknown }).tool_use_id;
    if (typeof id === 'string' && id) return `id:${id}`;
    return `cmd:${(commandFromToolInput(p.tool_input) ?? '').slice(0, 500)}`;
  }

  /** HEAVY-LOCK-SCRIPT-WRAPPER: the classifier may read a script the call runs (`bash suite.sh`),
   *  resolved against the hook's cwd, Git Bash `/c/...` paths included, size-capped by heavyJob. */
  static heavyScriptCtx(cwd: unknown): ClassifyCtx {
    return scriptReaderFor(typeof cwd === 'string' ? cwd : null, (abs) => {
      const path = abs.replace(/^\/([A-Za-z])\//, (_m, d: string) => `${d.toUpperCase()}:/`);
      try {
        const st = statSync(path);
        return st.isFile() ? { size: st.size, text: () => readFileSync(path, 'utf8') } : null;
      } catch { return null; }
    });
  }

  /** JOB-ENV (SessionStart): the hook's own id (from the agent's settings file) and its process
   *  env disagree: the session runs in a Claude Code daemon started by another agent, so
   *  anything env-based in it (OTel agent.id, the hive CLIs) speaks as that agent. The hook is
   *  still attributed by the settings id. One row per (agent, env agent, session). */
  private readonly identityMismatches = new Set<string>();
  private noteIdentityMismatch(agentId: string, envAgentId: string, event: string, sessionId: string | undefined): void {
    const key = `${agentId}|${envAgentId}|${sessionId ?? ''}`;
    if (this.identityMismatches.has(key)) return;
    if (this.identityMismatches.size >= 256) this.identityMismatches.clear();
    this.identityMismatches.add(key);
    try { this.hive.appendLog({ kind: 'hook-identity-mismatch', agentId, envAgentId, event, sessionId: sessionId ?? null }); } catch { /* best effort */ }
  }

  private toolOutputPrunedAt = new Map<string, number>();

  /**
   * READS-181 B: the replacement for a large SUCCESSFUL Bash/PowerShell result of a Claude agent,
   * or null to leave it as it is. The full output is on disk before anything is condensed:
   * Claude Code's own file when it saved one (over its 30k inline limit), else ours under
   * agents/<id>/tool-output. Any failure here leaves the result untouched.
   */
  private condensedToolOutput(agentId: string, p: HookPayload): Record<string, unknown> | null {
    if (p.hook_event_name !== 'PostToolUse' || (p.transport !== 'http' && p.transport !== 'pipe')) return null;
    const provider = this.mailChannel(agentId).provider;
    if (provider && provider !== 'claude') return null;
    let own: unknown;
    try { own = this.hive.registry?.().agents[agentId]?.toolOutputCap; } catch { own = undefined; }
    // N1 (god): a read-type command (grep, sed, cat, git diff …) gets the larger read cap.
    // god's ruling (d8e742): the orchestrator's DEFAULT is the read cap for every command (Andy's
    // sensitivity check: at 1500 the condenser turns negative for god if follow-ups triple). A
    // per-agent registry value still wins; 0 stays off.
    let isGod = false;
    try { isGod = typeof own !== 'number' && this.hive.isGod(agentId); } catch { isGod = false; }
    const configured = effectiveCap(typeof own === 'number' ? own : this.getConfig().toolOutputCap);
    const cap = capForCommand(commandOf(p.tool_input), isGod && configured ? Math.max(configured, TOOL_OUTPUT_CAP_READ) : configured);
    const r = (p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : null) as BashLikeResponse | null;
    if (!shouldCondense(p.tool_name, p.tool_input, r, cap) || !r) return null;
    let text = outputText(r);
    let totalChars: number | undefined;
    let partial = false;
    let path: string;
    const saved = typeof r.persistedOutputPath === 'string' && r.persistedOutputPath ? r.persistedOutputPath : null;
    if (saved) {
      path = saved;
      try {
        const size = statSync(saved).size;
        if (size <= CONDENSE_READ_MAX) {
          text = readFileSync(saved, 'utf8');
        } else {
          const fd = openSync(saved, 'r');
          try {
            const head = Buffer.alloc(CONDENSE_PART_BYTES);
            const tail = Buffer.alloc(CONDENSE_PART_BYTES);
            readSync(fd, head, 0, CONDENSE_PART_BYTES, 0);
            readSync(fd, tail, 0, CONDENSE_PART_BYTES, size - CONDENSE_PART_BYTES);
            text = `${head.toString('utf8')}\n${tail.toString('utf8')}`;
          } finally { closeSync(fd); }
          partial = true;
        }
        totalChars = typeof r.persistedOutputSize === 'number' ? r.persistedOutputSize : size;
      } catch { /* condense what the hook carried; the path still names the full output */ }
    } else {
      const dir = this.hive.toolOutputDir?.(agentId);
      if (!dir) return null;
      const raw = (p as { tool_use_id?: unknown }).tool_use_id;
      const id = typeof raw === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(raw) ? raw : `${Date.now()}-${randomBytes(4).toString('hex')}`;
      path = join(dir, `${id}.txt`);
      // Never condense what is not safely on disk.
      try { mkdirSync(dir, { recursive: true }); writeFileSync(path, text, 'utf8'); } catch { return null; }
      this.pruneToolOutput(dir);
    }
    const stdout = condenseOutput({
      text, cap, path, totalChars, partial,
      interrupted: r.interrupted === true,
      interpretation: typeof r.returnCodeInterpretation === 'string' && r.returnCodeInterpretation ? r.returnCodeInterpretation : undefined
    });
    const chars = totalChars ?? text.length;
    try {
      this.hive.appendLog({ kind: 'tool-output-condensed', agentId, tool: p.tool_name, chars, kept: stdout.length, cap, read: isReadCommand(commandOf(p.tool_input)) });
    } catch { /* best effort */ }
    const list = this.condensedRecent.get(agentId) ?? [];
    list.push({ base: path.split(/[\\/]/).pop() ?? path, path, at: this.toolCalls.get(agentId) ?? 0, chars });
    if (list.length > REFETCH_TRACKED) list.shift();
    this.condensedRecent.set(agentId, list);
    return { ...r, stdout, stderr: '' };
  }

  /** N1: each agent's tool calls so far, and its recently condensed outputs (for the re-fetch rate). */
  private toolCalls = new Map<string, number>();
  private condensedRecent = new Map<string, Array<{ base: string; path: string; at: number; chars: number }>>();

  /** N1: a tool call that names a recently condensed output's saved file is a re-fetch: logged once. */
  private noteRefetch(agentId: string, p: HookPayload): void {
    const list = this.condensedRecent.get(agentId);
    if (!list?.length) return;
    const now = this.toolCalls.get(agentId) ?? 0;
    const live = list.filter((e) => now - e.at <= REFETCH_WINDOW_CALLS);
    let input = '';
    try { input = JSON.stringify(p.tool_input ?? ''); } catch { input = ''; }
    const kept = live.filter((e) => {
      if (!input.includes(e.base)) return true;
      try { this.hive.appendLog({ kind: 'tool-output-refetch', agentId, tool: p.tool_name, after: now - e.at, chars: e.chars, path: e.path }); } catch { /* best effort */ }
      return false;
    });
    if (kept.length) this.condensedRecent.set(agentId, kept); else this.condensedRecent.delete(agentId);
  }

  /** Delete kept full outputs older than TOOL_OUTPUT_KEEP_MS, at most once an hour per folder. */
  private pruneToolOutput(dir: string, now = Date.now()): void {
    if (now - (this.toolOutputPrunedAt.get(dir) ?? 0) < TOOL_OUTPUT_PRUNE_EVERY_MS) return;
    this.toolOutputPrunedAt.set(dir, now);
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.txt')) continue;
        const fp = join(dir, f);
        try { if (now - statSync(fp).mtimeMs > TOOL_OUTPUT_KEEP_MS) rmSync(fp, { force: true }); } catch { /* next time */ }
      }
    } catch { /* best effort */ }
  }

  private async handleWithClaimContext(p: HookPayload): Promise<unknown> {
    if (p.munder_part === 'briefing') return this.claimBriefing(p);
    const fromSubagent = typeof p.provider_agent_id === 'string' && p.provider_agent_id !== '' && p.provider_agent_id !== p.agent_id;
    if (!fromSubagent && this.claimWorkingSetEvent(p) && p.agent_id) {
      let claimWorkingSet: string | null = null;
      try { claimWorkingSet = await this.claimWorkingSet?.(p.agent_id, p.source) ?? null; } catch { claimWorkingSet = null; }
      this.preparedClaimWorkingSets.set(p.agent_id, claimWorkingSet);
    }
    return this.handle(p);
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? 'Unknown';
    // AGY statusline telemetry is not a hook boundary, and it is handled BEFORE
    // everything else here: before the lifecycle observer (a tick is not a hook event
    // and must not be mistaken for one), before transcript capture, and before the
    // halt gate, the breaker and session recording. It can arrive with agent_id null
    // from a session nobody spawned, and none of that machinery is for it.
    if (event === 'AgyStatusLine') return this.handleAgyStatus(p);
    // CODEX-HOOK-AGENTID: a SUBAGENT's hook belongs to this agent (the halt gate, the breaker,
    // the activity feed all apply), but it does not describe the agent's OWN session: its
    // session id, transcript and turn are the subagent's. So it never records the session or
    // transcript, never drives the wake lifecycle (a subagent's late tool hook would re-open
    // a finished turn), and a subagent's Stop is not this agent's Stop.
    const fromSubagent = typeof p.provider_agent_id === 'string' && p.provider_agent_id !== '' && p.provider_agent_id !== agentId;
    if (agentId && typeof p.env_agent_id === 'string' && p.env_agent_id) this.noteIdentityMismatch(agentId, p.env_agent_id, event, p.session_id);
    // MIDTURN-MAIL-BLIND L1: turn boundaries, before any early return below.
    if (agentId && !fromSubagent) this.trackTurn(agentId, event, p);
    if (agentId && !fromSubagent) this.noteRunningTool(agentId, event, p);
    // A new response starts with no claims (a direct handle() call that nobody settled leaves none).
    this.mailClaims = [];
    if (!fromSubagent) {
      // §11.9: `source` (SessionStart startup|resume|clear|compact) reaches the hook diag row.
      this.onEvent?.(agentId, event, p.message, typeof p.fully_idle === 'boolean' ? p.fully_idle : undefined,
        typeof p.turn_id === 'string' && p.turn_id ? p.turn_id : undefined,
        typeof p.source === 'string' && p.source ? p.source.slice(0, 40) : undefined);
    }
    // WAKE-SCREEN-GUARD R2-4: the agent's OWN SessionStart hands on its spawn's incarnation token
    // (copied by the hook shim). Diagnostics-grade: it can only add a latch main verifies.
    // WSG-CODEX-STARTUP-NO-MARKER fix 1(b): so does its own Stop. A turn that ended is proof the
    // incarnation is past trust, login and update, and Codex sends SessionStart only lazily, at
    // a session's first turn; a resumed agent whose header was erased latches on its turn end.
    if (!fromSubagent && agentId && (event === 'SessionStart' || event === 'Stop') && typeof p.munder_wake_incarnation === 'string' && p.munder_wake_incarnation) {
      try { this.onWakeIncarnation?.(agentId, p.munder_wake_incarnation.slice(0, 80)); } catch { /* never breaks a hook */ }
    }
    if (agentId && !fromSubagent && typeof p.transcript_path === 'string' && p.transcript_path) {
      this.transcriptPaths.set(agentId, p.transcript_path);
    }
    // CLAIM-LEDGER W5 hook (god): the completed-turn boundary for the claims reconcile lease.
    if (agentId && !fromSubagent && event === 'Stop') {
      try { this.claimTurnCompleted?.(agentId); } catch { /* never breaks a hook */ }
    }
    // READS-ROTATE-AT-SIZE pilot: one `compact-health` row per compaction (before any early return:
    // a SessionStart(compact) that re-injects mail returns with it below).
    if (agentId && !fromSubagent && this.compactHealth) {
      try {
        if (event === 'SessionStart' && p.source === 'compact') this.compactHealth.noteCompact(agentId, p.transcript_path ?? this.transcriptPaths.get(agentId));
        else if (event === 'Stop') this.compactHealth.onStop(agentId);
        else if (event === 'PostToolUse') {
          // READS-COMPACT-HEALTH: what the agent reads again after a compaction.
          const r = readPathOf(p.tool_name, p.tool_input);
          if (r) this.compactHealth.noteRead(agentId, r.path, r.inbox);
        }
      } catch { /* observation only: never breaks a hook */ }
    }
    // §11.1: the record of an earlier response lands after it, so every later hook of the agent
    // (Stop included) looks for the evidence while tentative ids wait.
    if (agentId && !fromSubagent && this.mailAwaiting.has(agentId)) this.confirmMailSurfacing(agentId);

    // L0 — Codex has no status line. It stamps its rate-limit snapshot onto the
    // token_count event of every turn in the rollout it is already writing, so the
    // hook boundary we are standing on IS the event-driven refresh: by the time a
    // hook fires, the turn that produced a fresh snapshot has been written. Reading
    // it costs a stat on an unchanged file and a short tail read on a changed one,
    // and it makes no provider request of any kind. Non-Codex agents cost one
    // existence check. Session boundaries force a rescan, because a new session
    // means a new rollout file rather than an append to the old one.
    // MODEL-PINBACK G2: the same tail read also yields the thread's live model (turn_context).
    if (agentId) this.observeCodexCapacity(agentId, event, p.session_id, fromSubagent);

    // Status-line payloads carry the session's EXACT context accounting —
    // current tokens AND the real window size (200k vs 1M, which nothing else
    // exposes). Forward to the renderer for the agent-card context gauge.
    // Handled FIRST and returned early: this is pure telemetry from the
    // statusLine shim, not a real hook boundary — it must never trip the
    // HALT gate or feed the breaker's loop detector below. The early return
    // also (deliberately) skips recordSession for status ticks: a statusLine
    // payload's session_id adds nothing the real hooks don't already record.
    // The model is the exception: it is the authoritative per-agent `/model`
    // observation and must survive a restart. transcript_path IS still captured
    // above, where every payload shape benefits from it.
    if (event === 'Status') {
      const statusModel = typeof p.model === 'object' && p.model !== null && typeof p.model.id === 'string'
        ? p.model.id.trim()
        : '';
      if (agentId && statusModel) {
        const agent = this.hive.registry().agents[agentId];
        // Do not let a bridged provider's display model become a future Claude
        // argv. `recordModel` repeats this gate at the persistence boundary.
        if (agent?.provider === 'claude') {
          const statusEffort = p.effort && typeof p.effort.level === 'string' ? p.effort.level : undefined;
          this.hive.recordModel(agentId, statusModel, modelForHiveSpawn(agent, this.getConfig()), statusEffort);
        }
      }
      const cw = p.context_window;
      if (agentId && cw && typeof cw.total_input_tokens === 'number'
        && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
        // Retain for main-side reads (voice get_agent_detail / list_agents) …
        this.contextById.set(agentId, {
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size,
          ts: Date.now()
        });
        // … and forward live to the renderer's agent-card context gauge.
        this.getWebContents()?.send('hive:contextUpdate', {
          agentId,
          tokens: cw.total_input_tokens,
          limit: cw.context_window_size
        });
      }
      // L0 — the same payload carries the SUBSCRIPTION's rolling allowance
      // windows, which is a different quantity from the context accounting above:
      // context is per session and per agent, allowance is shared at account scope
      // across every session drawing on it. This is the supported machine-readable
      // pre-limit signal for a Claude subscription, and it arrives here for free on
      // a status tick that is already happening — no poll, no extra request, and no
      // credential is touched. Guarded so a payload without the field, or with a
      // shape we do not recognise, changes nothing.
      if (p.rate_limits !== undefined && this.onCapacity) {
        try {
          const now = Date.now();
          const obs = normalizeClaudeStatusLine({
            rateLimits: p.rate_limits,
            accountScope: claudeAccountScope(),
            receivedAt: now
          });
          if (obs) this.onCapacity(agentId ?? null, obs);
        } catch { /* telemetry must never break a status tick */ }
      }
      return {};
    }

    // 7C.3 — a graceful operator HALT overrides everything (incl. the inbox
    // drain below): stop the agent CLEANLY at this hook boundary rather than
    // killing the PTY. session_id is in the payload for a later --resume.
    if (agentId && this.control?.shouldHalt(agentId)) {
      // A subagent's Stop is not this agent's Stop, halted or not (the renderer reads any
      // emitted Stop as this agent going idle). The halt still applies to the subagent.
      if (!(fromSubagent && (event === 'Stop' || event === 'SubagentStop'))) this.emit(agentId, event, p);
      return { continue: false, stopReason: 'Halted by the operator from the floor.' };
    }

    // Capture the Claude Code session id for idempotent --resume + cost dedup
    // (Lane A #6.6a). Cheap: recordSession writes only when it changes.
    if (agentId && p.session_id && !fromSubagent) this.hive.recordSession(agentId, p.session_id);

    // CostSample — synthesized by the proxy-bridge sidecar (qwen) on every
    // response with usage. Persist it to the SAME cost ledger as Claude's OTel
    // path, keyed by the synthesized session_id, then return early so cost stays
    // OUT of the Claude-only OTel/breaker/drain paths below. `usd` is the fallback
    // per-model estimate (a local model normally costs ~$0, but the row keeps the
    // accounting schema uniform). Pure telemetry — never feeds the loop detector.
    if (event === 'CostSample') {
      if (agentId && p.session_id) {
        const model = typeof p.model === 'string' ? p.model : '';
        const input = p.input ?? 0;
        const output = p.output ?? 0;
        const cacheRead = p.cache_read ?? 0;
        const cacheCreation = p.cache_creation ?? 0;
        this.hive.appendCostLedger({
          agentId,
          sessionId: p.session_id,
          ts: Date.now(),
          input,
          output,
          cacheRead,
          cacheCreation,
          model,
          usd: estimateCostUsd(model, {
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheCreation
          })
        });
      }
      return {};
    }

    // READS-181 N1: count the agent's tool calls, and note a re-fetch of a condensed output.
    if (agentId && event === 'PreToolUse') { try { this.noteRefetch(agentId, p); } catch { /* never breaks a hook */ } }
    if (agentId && (event === 'PostToolUse' || event === 'PostToolUseFailure')) this.toolCalls.set(agentId, (this.toolCalls.get(agentId) ?? 0) + 1);

    // Feed the breaker its hook-derived loop signal: a tool that actually ran.
    // A repeated identical (name+input) PostToolUse is the runaway-loop tell.
    if (event === 'PostToolUse' && agentId && !p.payload_degraded) {
      this.breaker?.recordToolUse(agentId, p.tool_name, p.tool_input);
    }

    // Compaction exemption (issue #109): PreCompact opens it so the compaction
    // token burst can't trip the Δoutput arms; PostCompact — or any SessionStart,
    // since a fresh session makes in-flight compaction state moot — closes it
    // down to the trailing grace (a no-op when nothing was compacting).
    if (event === 'PreCompact' && agentId) this.breaker?.recordCompactStart(agentId);
    if ((event === 'PostCompact' || event === 'SessionStart') && agentId) {
      this.breaker?.recordCompactEnd(agentId);
    }

    if ((event === 'Stop' || event === 'SubagentStop') && agentId && fromSubagent) {
      // Not emitted: the renderer reads any Stop/SubagentStop as THIS agent going idle (and
      // clears its breaker), and the agent itself is still working.
      return {};
    }
    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // Respect any upstream Stop hook that already re-entered this boundary.
      if (p.stop_hook_active) { this.emit(agentId, event, p); return {}; }
      // Never turn unread hive mail into a forced continuation at Stop. That old
      // path bypassed terminal-draft/HITL safety and could spend credits while a
      // user was answering a question. Inbox files remain durable; main's inbox-wake
      // bridge treats this Stop as a retry EDGE and wakes the agent after this response,
      // through the one guarded submit owner. This return stays non-blocking.
      this.notify(agentId ?? 'Agent', 'finished — idle');
      this.emit(agentId, event, p);
      return {};
    }

    // 7C.1 — HITL gate: deny a tool call at the PreToolUse boundary when the
    // agent is paused or this tool is gated. Race-free (immediate return, no
    // renderer round-trip → can't hit the shim timeout). Slow human APPROVAL is
    // deliberately left to Claude's native permission prompt.
    if (event === 'PreToolUse' && agentId && this.control) {
      // A degraded Codex hook does not know which tool is about to run: with any tool gate
      // active for this agent it fails CLOSED; with none, there is nothing to gate.
      const unknownTool = p.payload_degraded === true && !p.tool_name;
      const gated = unknownTool && (this.control.snapshot?.(agentId)?.gatedTools?.length ?? 0) > 0;
      const d = gated
        ? { deny: true, reason: 'The tool could not be identified while tool gates are active; denied to be safe.' }
        : this.control.toolDecision(agentId, p.tool_name ?? '');
      if (d.deny) {
        this.emitControl(agentId, p.tool_name, d.reason);
        this.emit(agentId, event, p);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: d.reason ?? 'Denied by operator.'
          }
        };
      }
    }

    // HEAVY-JOB-SERIALIZE (AFTER every other PreToolUse deny above: a call the HITL gate refuses
    // never runs, so it must never take a slot; Jim MF1a): a heavy command (install / build / full
    // suite / bench) takes one of the
    // machine's heavy-job slots, or is DENIED naming the holders. Every provider reaches this deny
    // (Claude http, Codex mcp, the AGY shim's deny translation). A subagent's call counts as its
    // agent's. Settings "Heavy jobs at once" = Off makes this do nothing.
    if (event === 'PreToolUse' && agentId && this.heavyLock) {
      // Jim N1: a DEGRADED Codex hook (rebuilt from the rollout tail) may carry no tool input:
      // it cannot be classified, so it is allowed and logged.
      const scripts = HookServer.heavyScriptCtx(p.cwd);
      let cls = classifyHeavy(p.tool_name, p.tool_input, scripts);
      let command = commandFromToolInput(p.tool_input) ?? '';
      let callId = HookServer.heavyCallId(p);
      if (p.payload_degraded === true && commandFromToolInput(p.tool_input) === null) {
        // HEAVY-JOB-LOCK-FAILOPEN (c): classify the pending commands the rollout shows (any heavy
        // one takes the slot); only a call with nothing readable is still let through unclassified.
        const hints = Array.isArray(p.codex_commands) ? p.codex_commands.filter((c): c is string => typeof c === 'string') : [];
        for (const c of hints) {
          const k = classifyCommand(c, 0, scripts);
          if (k.heavy) { cls = k; command = c; callId = `cmd:${c.slice(0, 500)}`; break; }
        }
        try { this.hive.appendLog({ kind: 'heavy-lock', action: 'degraded', agentId, tool: p.tool_name ?? null, hinted: hints.length, heavy: cls.heavy }); } catch { /* best effort */ }
      }
      if (cls.heavy) {
        // A call whose PostToolUse may not pair back (Codex's mcp hooks can arrive degraded) is
        // freed like a background one: by the process check, PTY exit or the TTL (Jim N1).
        const unpaired = p.transport === 'mcp' || p.payload_degraded === true;
        const d = this.heavyLock.acquire(agentId, cls, command, callId, isBackground(p.tool_input) || unpaired);
        if (!d.allow) {
          this.emitControl(agentId, p.tool_name, d.reason);
          this.emit(agentId, event, p);
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } };
        }
      }
    }
    // A heavy FOREGROUND call returned, succeeded or FAILED (a suite exiting 1 fires PostToolUseFailure):
    // its job is done (a backgrounded one, or a missed Post, is left to the watcher). Andy N1 (1.1.81):
    // freed by the call id the PreToolUse took, NOT by classifying again (a script that changed or
    // was deleted during the run must not leave the slot held); callDone ignores an unheld call.
    if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && agentId && this.heavyLock) {
      this.heavyLock.callDone(agentId, HookServer.heavyCallId(p));
    }

    // 7C.2 — mid-run steering: inject queued operator guidance as context on the
    // next eligible hook (no fragile typing into the TUI). Delivered once.
    // Merged with the roster line below so the two injections never displace each
    // other (only ONE additionalContext can be returned per hook).
    let steer: string | null = null;
    // Not for a subagent's hook: the one-shot steer is meant for the agent itself, and a
    // subagent consuming it would lose it (HOOK-BROKER audit N1).
    // Nor for a one-way hook: its reply is never read, so a steer taken there is lost (P4 audit Y1);
    // it stays queued for the next answering hook. PreInvocation is AGY's (it has no
    // UserPromptSubmit): its documented injection point, before every model call.
    if ((event === 'UserPromptSubmit' || event === 'PostToolUse' || event === 'PreInvocation') && agentId && this.control && !fromSubagent && p.transport !== 'pipe-oneway') {
      steer = this.control.takeSteer(agentId) ?? null;
    }
    // ZT-I1-MAIL §11.9: injection providers (Claude, Codex, AGY) get message BODIES in hook
    // context (the <hive-mail> block, built below against the joined budget); every other
    // provider keeps the 1.1.74 header notice (legacy-read / legacy-move).
    const channel = agentId && !fromSubagent ? this.mailChannel(agentId) : null;
    const injecting = channel?.mode === 'inject';
    // MIDTURN-MAIL-BLIND L1: mail that arrived DURING this turn, named once, on the same
    // answering hooks the steer uses (Claude/Codex PostToolUse, AGY PreInvocation). Never on a
    // one-way hook (its reply is not read) or a subagent's.
    const mail = !agentId || fromSubagent ? null
      : injecting
        // N1 (Jim, 1.1.55): the SEND moment is a tool call, so Claude's PreToolUse carries the
        // HEADERS of waiting mail as a peek (no body, no marker, no claim); PostToolUse brings the
        // bodies. CLAUDE ONLY (the http transport): AGY's shim turns any PreToolUse reply object
        // into a decision and fails CLOSED, and Codex's PreToolUse context handling is unverified.
        ? (event === 'PreToolUse' && p.transport === 'http' ? this.mailPeek(agentId) : null)
        : (event === 'PostToolUse' || event === 'PreInvocation') && p.transport !== 'pipe-oneway'
          ? this.midTurnMail(agentId)
          : event === 'PreToolUse' && p.transport === 'http'
            ? this.midTurnMail(agentId, true)
            : null;

    // Keep god's roster CURRENT. fleet.json is always fresh on disk, but god's
    // context is not: after a restart it resumes a transcript describing the old
    // floor and messages agents that are long gone. Push the live roster in as
    // additionalContext at the start of each session and on every prompt, so god
    // knows the floor all the time instead of only when it remembers to Read.
    // God-only and one line — every other agent is unaffected.
    const wantsRoster = (event === 'SessionStart' || event === 'UserPromptSubmit')
      && !!agentId && !fromSubagent && this.hive.isGod(agentId);
    // Hand the roster the LIVE context-window occupancy (contextById) so each
    // agent line can carry a `ctx NN%` — god then sees whose context is nearly
    // full when it routes work, instead of guessing from cumulative token spend.
    const roster = wantsRoster
      ? this.hive.rosterContext((id) => this.contextFor(id))
      : null;
    // GOD-STARTUP-TOKENS R1: a god that started FRESH (instead of resuming a costly session) gets its
    // handoff once, at that session's SessionStart (source "startup"). Claude surfaces no mail at
    // SessionStart (mailSurfaceEvents), so the handoff never takes budget from pending mail. Never on
    // a one-way hook, whose reply is not read (the handoff would be lost).

    // Standing goal (hire Briefing) — durable roster field, re-read every cycle so
    // an Edit Agent save is picked up on the next SessionStart / UserPromptSubmit
    // without restarting the worker. Kept out of --append-system-prompt (volatile-
    // free cache invariant); lives on the live hook channel instead.
    const wantsGoal = (event === 'SessionStart' || event === 'UserPromptSubmit') && !!agentId && !fromSubagent;
    const goalRaw = wantsGoal ? (this.getStandingGoal?.(agentId) ?? null) : null;
    const goal = goalRaw
      ? `<goal>\n${goalRaw}\n</goal>`
      : null;
    // CLAIM-LEDGER G4.4: rebuild the view from the verified ledger at each SessionStart (M-3: not on
    // UserPromptSubmit). A compact SessionStart is included, so it survives compaction without
    // persistence. It counts in every joint budget below (mail, carry, handoff).
    const hasPreparedClaimWorkingSet = !!agentId && this.preparedClaimWorkingSets.has(agentId);
    let claimWorkingSet = !fromSubagent && hasPreparedClaimWorkingSet && agentId ? this.preparedClaimWorkingSets.get(agentId) ?? null : null;
    if (agentId && hasPreparedClaimWorkingSet) this.preparedClaimWorkingSets.delete(agentId);
    // Keep the synchronous test/internal surface compatible with synchronous providers; live
    // async providers are always awaited by handleWithClaimContext before reaching this method.
    // S-5: never for a one-way hook (its reply is not read), as handleWithClaimContext.
    if (!fromSubagent && !hasPreparedClaimWorkingSet && this.claimWorkingSetEvent(p) && agentId) {
      try {
        const value = this.claimWorkingSet?.(agentId, p.source);
        if (typeof value === 'string') claimWorkingSet = value;
        else if (value && typeof (value as Promise<unknown>).catch === 'function') void (value as Promise<unknown>).catch(() => {});
      } catch { /* optional working set */ }
    }
    // GOD-STARTUP-TOKENS R1: a god that started FRESH (instead of resuming a costly session) gets its
    // handoff once, at that session's SessionStart (source "startup"). Claude surfaces no mail at
    // SessionStart (mailSurfaceEvents), so the handoff never takes budget from pending mail. Never on
    // a one-way hook, whose reply is not read (the handoff would be lost). Creed B1: built to fit
    // the one additionalContext with the roster, goal, steer and mid-turn mail it is joined with.
    const handoff = wantsRoster && event === 'SessionStart' && p.source === 'startup' && p.transport !== 'pipe-oneway'
      ? this.hive.takeGodHandoff?.(agentId, [roster, goal, claimWorkingSet, steer, mail]) ?? null
      : null;

    // ZT-I1-MAIL §2.2: the message BODIES, from the ledger's delivered ids, on every turn start
    // (UserPromptSubmit; AGY's PreInvocation) and mid-turn (PostToolUse / later PreInvocations,
    // the P6 wording), so a human-typed turn or a running turn surfaces mail with no wake.
    // Budgeted JOINTLY with everything else in this one additionalContext (§11.2). Never into a
    // slash-command prompt (§11.6: `/compact` and every built-in); that mail waits for the next
    // turn start or PostToolUse. Never on a one-way hook or a subagent's.
    // Route A (Codex): the short user sentinel is retained; the block replaces the old
    // <hive-inbox-wake> id list as the hook-only developer context.
    const surfaces = injecting && !!agentId && !fromSubagent && p.transport !== 'pipe-oneway'
      && mailSurfaceEvents(channel?.provider).has(event)
      && !(event === 'UserPromptSubmit' && isSlashPrompt(p.prompt));
    let mailBlock: string | null = null;
    if (surfaces && agentId) {
      try { mailBlock = this.surfaceMail(agentId, event, p, channel?.provider, [handoff, roster, goal, claimWorkingSet, steer, mail]); } catch { mailBlock = null; }
      const none = '<hive-mail>\nNo new hive mail to show for this wake.\n</hive-mail>';
      if (!mailBlock && event === 'UserPromptSubmit' && channel?.provider === 'codex' && p.prompt?.trim() === CODEX_INBOX_WAKE_SENTINEL
        && mailBudgetFor([handoff, roster, goal, claimWorkingSet, steer, mail]) >= none.length) {
        mailBlock = none;
        // Q12 (god's ruling): a wake with nothing to show means the coordinator woke for mail that
        // was not pending: a coordinator bug signal.
        try { this.hive.appendLog({ kind: 'mail-empty-wake', agentId, epoch: this.mailEpoch(agentId), provider: 'codex' }); } catch { /* best effort */ }
      }
    }
    // §11.5: SessionStart(compact) inside a turn re-injects what this epoch already surfaced.
    // READS-COMPACT-HEALTH: with the cards in progress and the mail still owed an answer (headers
    // only) ahead of it, so they come back whatever the summary kept; the Stop checks it.
    let carry: string | null = null;
    if (injecting && agentId && !fromSubagent && event === 'SessionStart' && p.source === 'compact' && p.transport !== 'pipe-oneway') {
      let c: ReturnType<HookServer['compactCarry']> | null = null;
      try { c = this.compactCarry(agentId); } catch { c = null; }
      carry = c?.text ?? null;
      this.lastReinject.delete(agentId);
      try { mailBlock = this.reinjectMail(agentId, p, channel?.provider, [handoff, roster, goal, claimWorkingSet, steer, mail, carry]); } catch { mailBlock = null; }
      const re = this.lastReinject.get(agentId);
      this.lastReinject.delete(agentId);
      try {
        this.compactHealth?.noteCarry(agentId, {
          cardsDoing: c?.cardsDoing ?? [], cardsCarried: c?.cards ?? [],
          obligationsOpen: c?.obligationsOpen ?? 0, obligationsCarried: c?.obligations.length ?? 0,
          mailOpen: re?.open ?? [], mailReinjected: mailBlock ? re?.claimed ?? [] : []
        });
      } catch { /* observation only */ }
    }
    // §11.10: a mail block reached this agent (the degradation watch counts wakes without one).
    if (mailBlock && agentId) { try { this.coordination?.onMailBlock?.(agentId); } catch { /* never breaks a hook */ } }

    // READS-181 B: a large successful Bash/PowerShell result is replaced by its condensed form,
    // in the SAME hookSpecificOutput as any context below (one object per hook reply).
    let updatedToolOutput: Record<string, unknown> | null = null;
    if (event === 'PostToolUse' && agentId) {
      try { updatedToolOutput = this.condensedToolOutput(agentId, p); } catch { updatedToolOutput = null; }
    }
    if (handoff || steer || roster || goal || claimWorkingSet || mail || carry || mailBlock) {
      this.emit(agentId, event, p);
      return {
        hookSpecificOutput: {
          hookEventName: event,
          additionalContext: [handoff, roster, goal, claimWorkingSet, steer, mail, carry, mailBlock].filter(Boolean).join('\n\n'),
          ...(updatedToolOutput ? { updatedToolOutput } : {})
        }
      };
    }

    // A Notification hook that means "the agent is blocked waiting for the user"
    // (idle prompt) deserves a desktop toast too — distinct from a permission
    // request, which surfaces natively in the agent's own Claude Code session
    // (approvable remotely via /remote-control).
    if (
      event === 'Notification' &&
      (p.notification_type === 'idle' ||
        (p.message ?? '').toLowerCase().includes('waiting for your input'))
    ) {
      this.notify(agentId ?? 'Agent', p.message ?? 'needs your attention');
    }

    // Forward everything else to the renderer so avatars reflect real activity.
    this.emit(agentId, event, p);
    return updatedToolOutput ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } } : {};
  }

  /** Fire a native desktop notification — gated on the user's `notifications`
   *  setting. Only the OS toast is gated; the hive:hookEvent emit is always sent
   *  so avatars/UI stay live regardless. Best-effort: never throw into the hook. */
  private notify(title: string, body: string): void {
    // MUNDER_HIDDEN (dev only, layer-b test infrastructure): a hidden run shows no toast.
    if (DEV_HIDDEN || !this.getConfig().notifications) return;
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch { /* notifications unsupported on this platform — ignore */ }
  }

  /** Tell the renderer a tool call was gated/denied (#7C.1) so it can surface it
   *  (toast / control strip) — distinct from the avatar hook stream. */
  private emitControl(agentId: string, tool: string | undefined, reason: string | undefined): void {
    this.getWebContents()?.send('control:approvalRequest', { agentId, tool, reason });
  }

  private emit(agentId: string | undefined, event: string, p: HookPayload, blocked = false): void {
    this.getWebContents()?.send('hive:hookEvent', {
      agentId,
      event,
      tool: p.tool_name,
      notificationType: p.notification_type,
      source: p.source,
      message: p.message,
      blocked
    });
  }
}
