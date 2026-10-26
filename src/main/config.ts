import { app } from 'electron';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync, type Stats } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { DEV_ISOLATION, devDataRoot, devHarnessHome } from './devIsolation';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  autoModeFlagForProvider,
  defaultCommandForProvider,
  inferAgentProvider,
  providerPreset,
  type AgentProvider
} from '../shared/agentProvider';
import { defaultMcpDefaults } from '../shared/mcpCatalog';
import { MAX_AGENT_TOKEN_CAP } from '../shared/tokenCaps';
import { isAgentUsageDisplay, type AgentUsageDisplay } from '../shared/agentUsage';
import { codexLayerOptInKey } from './codexProjectLayers';
import { parseCapacityDisplayThreshold } from '../shared/capacityThreshold';
import { parseGraphicsMode, type GraphicsMode } from '../shared/graphicsMode';
import { CODEX_TOOL_OUTPUT_LIMIT_DEFAULT, normalizeCodexToolOutputLimit } from '../shared/codexToolOutputLimit';
import { expandTilde, normalizeHiveHome } from './fs';
import { provenStatKey, statKey } from './statCacheKey';
import { isProjectThemeId, isProjectThemeSeed, isStoredProjectThemeId, projectThemeHomeKey, resolveProjectTheme, type ProjectThemeId, type ProjectThemeSeed } from '../shared/projectTheme';
import type { IntegrationRecord } from '../shared/integrations';
import {
  DEFAULT_CONTEXT_TRIGGER,
  DEFAULT_ORG_TRIGGER,
  DEFAULT_TRIGGER_MODE,
  DEFAULT_WEBHOOK_SCHEMA,
  type ContextTriggerConfig,
  type OrgTriggerConfig,
  type WebhookTrigger
} from '../shared/triggers';

/** A recurring auto-dispatched mission fired on an interval by the scheduler. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  /** Day-of-week + time-of-day schedule. When present and valid this REPLACES
   *  `intervalMs` — an interval cannot say "weekday mornings", because it drifts
   *  against the clock and a 24h one started at 15:00 fires at 15:00 forever.
   *  `intervalMs` is deliberately left on the record so switching back restores
   *  the cadence the user had. See shared/weeklySchedule.ts. */
  weekly?: { days: number[]; minute: number };
  to: string;
  body: string;
  enabled: boolean;
  /** When true, the scheduler asks the renderer to compact live terminals when
   *  this mission fires — but only agents whose context has filled past the bar
   *  in `contextTrigger.compact` (60% by default, 40% on ~1M-token windows), so
   *  small/idle sessions are left alone instead of compacting on every tick.
   *
   *  This gate used to be described here but was never actually implemented: every
   *  live agent was compacted on every tick. It is real now, and the bars live in
   *  `ContextTriggerConfig` where the operator can edit them, so do not restate
   *  the numbers anywhere else — they will drift. */
  autoCompact?: boolean;
  lastFiredAt?: number;
  /** Mission flavor. Absent ⇒ 'dispatch' (the classic interval-dispatch mission,
   *  e.g. the ops standup). 'heartbeat' (Lane A #1) is a context-aware beat: it
   *  observes live floor state, re-engages a quiet god, and ticks the circuit
   *  breaker — armed with an adaptive cadence, not a fixed setInterval. */
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  /** Heartbeat only: a floor is "quiet" when no tracked signal (log.jsonl mtime,
   *  inbox/outbox mtimes, any PTY output) has moved in this many ms. Default
   *  ~5 min. NOT derived from registry.status (which never transitions in main). */
  quietThresholdMs?: number;
  /** TE0: suppress this mission's dispatch while the floor is provably unchanged.
   *  ABSENT ⇒ OFF ⇒ the pre-TE0 unconditional dispatch, so every mission that does
   *  not opt in keeps its exact prior behaviour. See main/standupDelta.ts for what
   *  "unchanged" hashes, and for the two rules that make the answer trustworthy. */
  deltaGate?: { enabled: boolean };
  /** Scheduler-owned, like `lastFiredAt`: the floor fingerprint as of the last
   *  DISPATCHED run, and when that was. `lastFiredAt` cannot stand in for the
   *  latter — it advances on suppressed ticks too (it has to, or the timer
   *  re-arms with zero delay). `lastDispatchAt` no longer gates anything: it is
   *  read only to report how long a suppressed floor has been quiet, which under
   *  the gate's RULE 3 is an unbounded span and therefore worth reporting. */
  lastDeltaFingerprint?: string;
  lastDispatchAt?: number;
}

/** The built-in hourly ops standup: god reviews who's doing what + whether tasks
 *  are on track and agents are running, and every terminal's context is compacted.
 *  ZT-I4: shipped DISABLED (opt-in). The harness's floor digest (floorDigest.ts) keeps
 *  the same picture for zero model tokens and wakes god only for a decision; users can
 *  still turn the standup on in the Command Center (the TE0 delta gate is unchanged). */
export const OPS_STANDUP_MISSION: ScheduledMission = {
  id: 'ops-standup',
  label: 'Hourly ops standup',
  intervalMs: 3_600_000,
  to: 'god',
  body:
    'Hourly ops standup. Review every agent: who is doing what, and confirm each ' +
    'is still running (not stalled or idle-stale). Check the task board — are ' +
    'in-flight tasks on track, and is anything blocked or unowned? Flag stale ' +
    'agents and at-risk tasks, and keep the board accurate. (As part of this ' +
    "standup each working agent is asked to summarise its current task and the " +
    'next step, then compact and resume from the same point — so terminal ' +
    'contexts stay bounded without losing work. The compaction is queued and ' +
    'runs when an agent is idle, so it never interrupts work mid-step.)',
  enabled: false,
  // TE0. A standup whose only finding is "nothing changed" still costs a full
  // model turn over god's whole session prefix, because the dispatch wakes him.
  // The gate answers that question locally instead. There is NO periodic
  // fallback: a provably unchanged floor may go indefinitely without a standup,
  // which is the owner's ruling and the whole point of the gate. Stall detection
  // is the HEARTBEAT's job, not this mission's — see standupDelta.ts RULE 3.
  deltaGate: { enabled: true }
  // NO autoCompact. Compaction belongs to contextTrigger.compact and nothing else.
  // This flag used to live here as well, which meant a default install asked for
  // compaction on TWO cadences — hourly from this standup and 2-hourly from the
  // trigger — the exact "two controls that disagree" the maint-1 retirement below
  // was written to end. The standup's own prose still describes compaction, and
  // that stays true: the trigger does it, just not on this mission's clock.
};

/** The built-in heartbeat (Lane A #1). A context-aware beat that, each tick,
 *  observes live floor state and — only when the floor has gone quiet — drops a
 *  digest into god's inbox and (if god's PTY is genuinely idle) nudges it to
 *  re-engage anyone stalled. The same beat ticks the circuit breaker.
 *
 *  Shipped DISABLED by default (opt-in): unlike the standup, which only sends a
 *  hive message, the heartbeat types into god's PTY, so the user turns it on
 *  explicitly in the Command Center once they want active re-engagement.
 *  `intervalMs` is the normal-cadence base; the scheduler derives a tighter beat
 *  when an agent looks stuck and a slower one right after a re-engage. */
/** ZT-I4: RETIRED. The floor digest replaces it: the scheduler never arms a heartbeat
 *  mission, new installs do not get one, and an existing one is removed once at boot
 *  (`heartbeatRetired`). Kept as the definition that migration recognises. */
export const HEARTBEAT_MISSION: ScheduledMission = {
  id: 'heartbeat',
  label: 'Floor heartbeat',
  intervalMs: 120_000,
  to: 'god',
  body:
    'Floor heartbeat: the team has gone quiet. Review the digest delivered to you, ' +
    're-engage anyone stalled or blocked, and keep the board accurate — or rest ' +
    'if the work is genuinely done.',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 300_000
};

/** The dedicated auto-compact MAINTENANCE schedule (maint-1). DECOUPLED from the
 *  ops standup so editing/replacing a standup can never silently disable
 *  compaction again (the bug this fixes). It fires ONLY the auto-compact signal —
 *  `kind:'compact'` makes syncMissions skip the hive.send dispatch (empty to/body).
 *  Shipped DISABLED (v0.3.4 founder decision): scheduled compaction is opt-in.
 *  Turn it on in Settings → General or the Schedules tab; the Schedules warning
 *  panel explains the risk of leaving it off for long-running agents. It is the
 *  SINGLE source of truth for compaction, and it's persistent: deleting it makes
 *  it reappear DISABLED.
 *  Existing installs keep whatever enabled state the user already has
 *  (compactMaintenanceSeeded guards re-seeding). */
export const COMPACT_MAINTENANCE_MISSION: ScheduledMission = {
  id: 'compact-maintenance',
  label: 'Auto-compact (maintenance)',
  // 2h, matching DEFAULT_CONTEXT_TRIGGER.compact.everyMs. The two cadences must
  // agree: this mission is the schedule half of the same behaviour the context
  // trigger now owns, and a 1h seed here would keep interrupting agents on the
  // old rhythm no matter what the trigger says.
  intervalMs: 7_200_000,
  to: '',
  body: '',
  enabled: false,
  autoCompact: true,
  kind: 'compact'
};

/** The 1h cadence `compact-maintenance` was seeded with before Triggers doubled
 *  it. `migrateTriggersV1` bumps only missions still sitting on this EXACT value,
 *  so an interval the user tuned by hand is left exactly where they put it. */
const LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS = 3_600_000;

/** Circuit-breaker thresholds (Lane A #6.6b). The breaker runs inside the
 *  heartbeat beat, so it only ticks when the heartbeat is enabled. Trip
 *  conditions are behavioral by default; `costCapUsd` is the only $-based one and
 *  is unset by default (a hardcoded dollar default would be arbitrary). Defaults
 *  are deliberately conservative and steer-first — `hardStop` is OFF unless the
 *  user opts in, so the breaker never auto-kills a healthy long-runner. */
export interface CircuitBreakerConfig {
  /** Master switch for breaker evaluation within the beat. Default true. */
  enabled?: boolean;
  /** Allow the top of the ladder (kill PTY + archive). Default false = the
   *  breaker may steer/constrain but never hard-stops until the user opts in. */
  hardStop?: boolean;
  /** Consecutive identical tool calls (same name+input) before tripping. */
  repeatedToolLimit?: number;
  /** Consecutive api_error / retry events before tripping. */
  errorStormLimit?: number;
  /** Output-token velocity (tokens/min, diffed across beats) before tripping. */
  tokenVelocityPerMin?: number;
}

/** Enterprise Knowledge Graph (multimodal context store + agent access tool).
 *  The user ingests their own documents/images/PDFs; agents query them on demand
 *  via the `kg` CLI. Opt-in like the heartbeat/Slack features — `enabled` gates
 *  everything (no env injected, no prompt line, no store touched when off). See
 *  docs/design/knowledge-graph.md. */
export interface KnowledgeGraphConfig {
  /** Master switch. Default false = zero behaviour change (the feature is dark). */
  enabled?: boolean;
  /** Override the store location. Unset = <userData>/knowledge. */
  rootPath?: string;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Self-identified audience picked on the first onboarding screen. Drives the
   *  copy register everywhere onboarding explains itself: 'technical' shows CLI /
   *  flag lingo, 'non-technical' explains each concept in plain language. Unset =
   *  not yet chosen (treated as technical for any incidental copy). */
  audience?: 'technical' | 'non-technical';
  /** Folder where the harness keeps its own state (agent metadata, logs). */
  harnessHome: string | null;
  /** Recently-opened hive home folders (most-recent first), surfaced by the
   *  launch-time hive picker. Maintained by writeConfig whenever harnessHome is
   *  set (onboarding finish, changeHome). Capped to a handful. */
  recentHives?: string[];
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, new agents are spawned with --permission-mode bypassPermissions. */
  autoMode: boolean;
  /** May the orchestrator ("Michael") spin up agents on its own?
   *
   *  Default FALSE. Spawning an agent is a SPEND decision, so it should not
   *  happen unprompted. The ability itself shipped in v0.4.4 with no gate at all,
   *  so this closes an existing default-on behaviour rather than gating a new
   *  feature: an operator who wants it must now say so.
   *
   *  Off does not FAIL a queued spawn request, it declines to consume one. The
   *  request sits in HIVE_ROOT/spawn-requests until the toggle is turned on. */
  orchestratorMaySpawn: boolean;
  /** HEAVY-JOB-SERIALIZE (Settings → Autonomy & Budgets, "Heavy jobs at once"): how many heavy
   *  jobs (installs, builds, full test suites, benches) the floor's agents may run at once; a
   *  further one is denied at PreToolUse, naming the holders. 'off' = no limit (the guard does
   *  nothing). Default 1. Read live on every hook: a change applies without restarting agents. */
  heavyJobsAtOnce?: number | 'off';
  /** HEAVY-CPU-OPTIONS-191 (Settings → Autonomy & Budgets, beside "Heavy jobs at once"), Windows:
   *  run every heavy job at background CPU priority (BELOW_NORMAL), every process of it. Independent
   *  of the limit above (Off included). Default off. Applied live, to running jobs too. */
  heavyJobsBackgroundPriority?: boolean;
  /** HALFCORES-OVERSUBSCRIBE, Windows: hard-cap every heavy job at 50% of the whole
   *  machine's CPU rate (all processors remain visible). Default on. Applied live. */
  heavyJobsCpuCap?: boolean;
  /** CODEX-BLOAT-165 fix 2 (Settings → Agents & Models, "Codex tool output cap"): the
   *  `tool_output_token_limit` written into each hive Codex agent's OWN config.toml, in Codex's
   *  estimated tokens (1000-10000), or 'off' (no key written). Default 4000. Never written to the
   *  user's ~/.codex/config.toml. Codex reads it at start: a change reaches an agent at its next start. */
  codexToolOutputTokenLimit?: number | 'off';
  /** CODEX-BLOAT-165 fix 5 (Settings → Agents & Models, "Hive Codex agents inherit my Codex
   *  plugins"): true = each hive Codex agent's own config.toml keeps the plugins copied from the
   *  user's ~/.codex/config.toml as they are; false (the default) = they are turned off there.
   *  The user's file is never written. Codex reads it at start: a change reaches an agent at its next start. */
  codexInheritPlugins?: boolean;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Which provider powers the GOD orchestrator ("Michael"). The persona is
   *  constant; only its engine is selectable. Default 'claude'. Eligible providers
   *  are those that can receive inbox (claude/codex/antigravity/qwen). */
  godProvider?: AgentProvider;
  /** The model GOD runs on. Unset falls back to the provider preset's
   *  `recommendedOrchestratorModel`, then MODEL_GOD. Default 'claude-opus-4-8'. */
  godModel?: string;
  /** Per-server consent state for the default MCP bundle, keyed by catalog id.
   *  Seeded from MCP_CATALOG (safe-readonly ON, write/secret OFF); the user flips
   *  these in Settings. A server is wired into an agent only when enabled here. */
  mcpDefaults?: { [id: string]: { enabled: boolean } };
  /** Semantic memory (the built-in memory engine): its master switch. Default on. */
  semanticMemory: boolean;
  /** CLAIM-LEDGER: the ledger level (off | shadow | reader | writer); absent = off. A build clamps a
   *  level it does not implement down to the highest it does (shared/claims.ts effectiveLevel). */
  claimLedger?: string;
  /** CLAIMS-90 M5: the derived claim writer (claims/derivedLive.ts); absent = on, false = off. */
  derivedClaims?: boolean;
  /** CLAIMS-90 M5: the git repo the derived writer reads commits and tags from; absent = none. */
  derivedClaimsRepo?: string;
  /** Recurring auto-dispatch missions handled by the scheduler. */
  missions?: ScheduledMission[];
  /** One-time guard: has the built-in hourly ops standup been seeded into an
   *  existing install's missions? Prevents re-adding it after a user deletes it. */
  opsStandupSeeded?: boolean;
  /** One-time guard for the built-in heartbeat mission (mirrors opsStandupSeeded
   *  so a user who deletes the heartbeat doesn't get it re-added every boot). */
  heartbeatSeeded?: boolean;
  /** ZT-I4 one-time guard: the retired heartbeat mission was removed from `missions`. */
  heartbeatRetired?: boolean;
  /** ZT-I3/I4 tuning (all optional; defaults in floorDigest.ts and boardStale.ts):
   *  the digest cadence and wake batch window, and the stale-detector thresholds. */
  floorDigest?: {
    enabled?: boolean;
    digestEveryMs?: number;
    wakeBatchMs?: number;
    staleAfterMs?: number;
    downAfterMs?: number;
    downDecisionMs?: number;
    answeredIdleMs?: number;
    maxDoing?: number;
  };
  /** TE0 one-time guard: has the delta gate been attached to an ALREADY-SEEDED
   *  ops standup? Without this migration the gate would reach new installs only —
   *  `opsStandupSeeded` is already true on every existing install, so the seeding
   *  branch never runs again and the mission would keep its pre-TE0 shape forever.
   *  Set once; a user who then turns the gate off keeps it off. */
  standupDeltaGateSeeded?: boolean;
  /** maint-1 guard for the dedicated auto-compact maintenance mission. UNLIKE the
   *  two above, this does NOT suppress re-add forever: once seeded (flag set), a
   *  later delete makes the mission reappear DISABLED on next boot (compaction is
   *  required, so it's never silently lost — only user-disabled). */
  compactMaintenanceSeeded?: boolean;
  /** DEPRECATED (v0.3.4): config-file only, no UI anywhere. Hard dollar ceiling
   *  across all active agents. Still enforced if present so legacy configs keep
   *  their guard, but the token cap (costCapTokens) is the real budget —
   *  scheduled for removal next release. */
  costCapUsd?: number;
  /** Hard TOKEN ceiling (total tokens across all active agents) before the
   *  breaker trips. The user-facing budget — set in Settings. Opt-in like the
   *  $-cap; total = input + output + cacheRead + cacheCreation, summed across the
   *  floor (the biggest token spender is blamed). */
  costCapTokens?: number;
  /** Per-agent total-token ceiling, keyed by agent id. When an agent's own total
   *  tokens exceed its cap the breaker trips that agent alone (independent of the
   *  floor budget). Set from each agent's card in the Command Center. */
  agentTokenCaps?: Record<string, number>;
  /** v1.1.45 CAPUI-MONITOR: what each agent's first Monitor line shows. Absent = 'budget'.
   *  'fiveHour' / 'weekly' (Claude/Codex) and the four AGY family windows (Antigravity,
   *  AGY-MONITOR-1.4) show that provider window's usage AND exempt the agent from the
   *  budget limits (see src/shared/agentUsage.ts). */
  agentUsageDisplay?: Record<string, AgentUsageDisplay>;
  /** v1.1.45 unit #8 (C2.8): the capacity-display threshold, an integer 1-99 (default 15).
   *  Display only: it gates the strip's Weekly reveal and the 5h/Weekly reset hints. */
  capacityWeeklyDisplayThreshold?: number;
  /** GPU-SETTING-188: Settings → Graphics, 'auto' (default) | 'gpu' | 'cpu'. Read once at startup, before
   *  app ready (src/main/graphics.ts); a change takes effect after a restart. */
  graphicsMode?: GraphicsMode;
  /** GOD-TERMINAL-CONTROL M1: false turns off main's headless screen mirror per PTY (and with it
   *  `term read`). Unset = on; the cost sampler turns it off by itself past its bar. Read at startup. */
  terminalMirror?: boolean;
  /** STALL-WATCH-198: the main-stall / input-delay / renderer-longtask rows. Unset = on; false = off;
   *  `{ profile: true }` adds the sampling profiler (default OFF; on only with god's OK). Read at startup. */
  stallWatch?: boolean | { profile?: boolean };
  /** GTC M2: which host answers the screen gate's readings. Unset or 'renderer' = the renderer's
   *  xterm (the shadow diff compares the mirror); 'mirror' = main's headless mirror, falling back
   *  to the renderer whenever the mirror has no reading. Read at every request (screenGate.ts). */
  screenGateSource?: 'renderer' | 'mirror';
  /** GTC M3 (1.1.97): how the Human's own queued messages are delivered. Unset or 'term' = main's
   *  message box (hook idle, TermControl, origin HUMAN; messageBox.ts); 'owner' = the submit owner,
   *  as up to 1.1.96. Read at every request. 'owner' is kept for one release. */
  messageBoxPath?: 'term' | 'owner';
  /** GTC M4 (1.1.97): how an automatic inbox wake and a boot prompt are delivered. Unset or 'owner' =
   *  the submit owner, as up to 1.1.96; 'term' = main's wake sender (hook readiness, a typed send
   *  with origin PROGRAMMATIC, the provider's own confirm; wakeSender.ts). Read at every request. */
  wakePath?: 'owner' | 'term';
  /** GTC M4: per provider, whether a Stop that finds mail waiting is blocked with the mail as its
   *  reason (the turn continues) instead of ending and getting a typed wake. Unset = off. Honoured
   *  only with wakePath 'term'. Read at every Stop. */
  stopContinue?: { claude?: boolean; codex?: boolean; antigravity?: boolean };
  /** Agent ids whose automatic inbox/queue delivery is paused. Pending messages
   *  stay durable until the operator explicitly resumes delivery. */
  autoDeliveryPausedAgents?: string[];
  /** HIVE-DWIGHT-BG-REINVOKE: the floor hold god sets with `term hold on|off` (floorHold.ts).
   *  null or unset = no hold. Kept here so a restart keeps it. */
  floorHold?: { by: string; reason: string; since: number } | null;
  /** CODEX-TRUST-LAYER (1.1.76): project folders the Human allowed with one click. A Codex agent
   *  there starts even though the folder's own `.codex` hooks / MCP servers / rules would run
   *  unreviewed (with a visible warning); anywhere else such a folder refuses the spawn. Keys are
   *  resolved paths, ASCII-lowercased on Windows. */
  codexLayerOptIns?: string[];
  /** READS-QUIET-NOREPLY (1.1.81): minutes an idle agent's quiet mail (an inform/agree that needs no
   *  reply, not from the Human, the breaker, the digest or the harness) may wait for its next real
   *  turn before one wake carries it (shared/mailWakeClass.ts). Unset = 30; 0 = off (every
   *  delivery wakes, as before 1.1.81). */
  quietMailHoldMin?: number;
  /** Passed to every spawned agent as `--max-turns <n>` when set; unset = no cap
   *  (Claude Code's default). A coarse runaway guard independent of the breaker. */
  maxTurns?: number;
  /** READS-ROTATE-AT-SIZE pilot (1.1.81): god's Claude Code auto-compact window, passed as
   *  CLAUDE_CODE_AUTO_COMPACT_WINDOW at spawn. Unset = 150000; "off" = Claude's own "auto"
   *  (the pilot's off switch). An agent's own registry `autoCompactWindow` wins (shared/autoCompactWindow.ts). */
  godAutoCompactWindow?: number | 'off';
  /** READS-AUTOCOMPACT-ROLLOUT (1.1.84): every Claude agent's auto-compact window (tokens,
   *  100k-1M), passed as CLAUDE_CODE_AUTO_COMPACT_WINDOW at spawn. Unset = 150000; "off" =
   *  Claude's own "auto" for every agent without its own value. An agent's registry
   *  `autoCompactWindow` wins, and god keeps `godAutoCompactWindow` when that is set. Codex
   *  agents are not affected (their registry codexAutoCompactTokenLimit). */
  claudeAutoCompactWindow?: number | 'off';
  /** READS-MAIL-CAP (1.1.83): the most body characters of one message god gets in context; a
   *  longer one shows its first ~this many characters plus the file paths (the rest stays readable
   *  there). Unset = 1500; 0 = off. Mail from the Human and the harness is never shortened. An
   *  agent's own registry `mailCapChars` wins (src/main/mailSurface.ts effectiveMailCap). */
  godMailCapChars?: number;
  /** READS-PROMPT-TRIM (1.1.83): unset or true = each hive Claude agent spawns without the tools,
   *  skills and claude.ai connectors its role never uses (shared/claudePromptTrim.ts); false =
   *  spawn with everything, as before. Reaches an agent at its next spawn. */
  claudePromptTrim?: boolean;
  /** Max concurrent god-triggered ephemeral Slack workers; extra spawn-requests
   *  wait in the queue (natural backpressure, a resource backstop). Default 4. */
  maxConcurrentWorkers?: number;
  /** Minutes an ephemeral worker may produce NO output before the reaper kills it
   *  — idle-based, never wall-clock, so an actively-working worker is never reaped.
   *  Default 20. */
  workerIdleTimeoutMinutes?: number;
  /** Registered integrations (Phase 2) — labeled REST endpoints workers reach through
   *  the loopback secret broker. METADATA ONLY: each record carries a `secretRef`
   *  handle, never the secret value (secrets live encrypted in a separate file via
   *  Electron safeStorage — see src/main/integrations.ts). Default []. */
  integrations?: IntegrationRecord[];
  /** Default per-worker TOTAL-token cap (input+output+cache) applied to every
   *  god-triggered ephemeral worker; a worker's own spawn-request `tokenCap`
   *  overrides it. When the effective cap is exceeded the worker is reaped (its
   *  committed work preserved) and god is informed. This is PLUMBING for a later
   *  budget feature: per the human directive there is NO per-worker cap today, so
   *  the default is 0 = UNLIMITED — the mechanism is wired but never throttles
   *  unless someone explicitly sets a positive cap (per request or here). */
  defaultWorkerTokenCap?: number;
  /** Circuit-breaker thresholds (Lane A #6.6b). Unset = conservative defaults. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Enterprise Knowledge Graph (multimodal context for agents). Default OFF. */
  knowledgeGraph?: KnowledgeGraphConfig;
  /** READS-181 B: the most characters of a successful Bash/PowerShell result an agent gets in
   *  context; over it the result is condensed (outcome, error lines, head, tail, the full output's
   *  path). 0 = off. A per-agent `toolOutputCap` in the registry overrides it. */
  toolOutputCap?: number;
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
  /** Opt-in "strong keep-alive": while ≥1 agent PTY is live, escalate the power
   *  blocker from 'prevent-app-suspension' to 'prevent-display-sleep', which on
   *  macOS also blocks TRUE system sleep (lid-close/idle) so scheduled missions
   *  and terminals keep firing ON TIME while away — at a battery cost (best on
   *  AC). Default OFF: the honest default is "survive sleep + catch up once on
   *  resume" (see the powerMonitor 'resume' handler), not "stay awake". */
  strongKeepalive?: boolean;
  /** Auto-update from GitHub releases (v0.3.4). Default ON. Packaged builds
   *  check on boot + every ~6h, download in the background, and show a
   *  "restart to update" toast — installation is always user-initiated. OFF
   *  disables checking entirely. (Mirrored in preload + renderer config.) */
  autoUpdate?: boolean;
  /** Multi-window "floors": expose a New Floor action that opens additional
   *  windows, each an independent office with isolated renderer state (its own
   *  session partition) and per-window PTY routing. ON by default (v0.3.4: code
   *  and comment disagreed; the shipped behavior — enabled — wins) —
   *  the window/PTY-ownership plumbing is always active and single-window-safe,
   *  but the New Floor entry points (app menu item + IPC) only appear when on.
   *  The on-disk hive (god orchestration under harnessHome) stays process-global;
   *  floors share it. */
  multiWindow?: boolean;
  /** Terminal theme — mirrored into each agent's per-session Claude settings
   *  ("theme" key) at spawn so the TUI's truecolor palette matches. Scoped to
   *  harness agents only; the user's global Claude theme is never touched. */
  terminalTheme?: 'light' | 'dark';
  /** Anonymous product analytics (PostHog) — the exact events/properties are
   *  documented in TELEMETRY.md. Default ON (opt-out, like autoUpdate); builds
   *  without an injected key and environments with DO_NOT_TRACK set never send
   *  regardless of this flag. (Mirrored in preload + renderer config.) */
  telemetryEnabled?: boolean;
  /** Master flag for the TV-show office themes. Default false = the built-in
   *  show maps are not offered and the office renders as today. */
  tvShowOffices?: boolean;
  /** Legacy global office theme: the fallback for a project with no explicit
   *  choice in `officeThemeByHive`. The built-in show maps are only honored when
   *  `tvShowOffices` is on; unbuilt show themes fall back to 'office' in the loader. */
  officeTheme?: ProjectThemeId;
  /** Explicit project choice keyed by normalized harness home. */
  officeThemeByHive?: Record<string, ProjectThemeId>;
  /** Immutable creation record: unlike a theme selection, this may name the
   *  first orchestrator and declare its appearance. */
  projectThemeSeedByHive?: Record<string, ProjectThemeSeed>;
  /** Per-CLI-provider local/self-hosted base URL (Ollama/LM Studio/vLLM, …) for the
   *  OpenCode/Crush/pi/qwen engines; applied at spawn (config-injection or proxy
   *  upstream). API KEYS are NOT stored here — they live write-only in the secret
   *  broker (integrations.ts), read MAIN-ONLY at spawn. */
  providerBaseUrls?: Partial<Record<AgentProvider, string>>;
  /** Per-CLI-provider default model slug, used to pre-fill the model picker. */
  providerDefaultModels?: Partial<Record<AgentProvider, string>>;
  /** Master toggle for the Slack → Michael's-queue integration. */
  slackEnabled?: boolean;
  /** Expose inbound webhook/Slack listeners beyond loopback (default false). */
  inboundBindAllInterfaces?: boolean;
  /** Slack app signing secret (Basic Information → Signing Secret). Never logged. */
  slackSigningSecret?: string;
  /** Bot token (xoxb-…) — only needed if the bot ever replies; optional for now. */
  slackBotToken?: string;
  /** Restrict ingestion to one channel id; empty/undefined = any channel. */
  slackChannelId?: string;
  /** Local HTTP port the webhook server binds to (default 3847). */
  slackPort?: number;
  /** Opt-in: allow APP/VOICE-INITIATED proactive posting into Slack (e.g. the
   *  renderer's "queued" acknowledgement). DEFAULT OFF per the human directive
   *  "stop posting into Slack by default". This does NOT gate the Slack-ORIGIN
   *  done-reply round-trip (a user @-mention → task → result posted back to that
   *  thread) or an agent's own direct in-thread reply — those always stay on. */
  slackProactivePosting?: boolean;

  // ─── Free Flow (voice dictation → message queue) ───────────────────────────
  /** Master toggle for Free Flow push-to-talk dictation. Default OFF: with it off
   *  the composer shows no mic button, no getUserMedia runs, and no Groq call is
   *  ever made (zero behavior change). */
  freeflowEnabled?: boolean;
  /** User-pasted Groq API key (the user supplies their own free key). Used ONLY in
   *  the main process for the Groq STT call; NEVER logged, and never crosses IPC
   *  for the request. Treated like `slackBotToken`. */
  groqApiKey?: string;
  /** Groq Whisper model id. Default 'whisper-large-v3-turbo' (fast, multilingual). */
  freeflowModel?: string;

  // ─── Realtime Michael (premium speech-to-speech voice orchestrator) ─────────
  /** True ONLY while a Realtime Michael voice session is live: the renderer
   *  session flips this on at start() (before getUserMedia) and off at stop().
   *  The main-process mic permission gate reads it so the Electron media
   *  permission is open EXACTLY while the voice loop holds the mic — never just
   *  because an OpenAI key exists (that key is shared with the CLI engines).
   *  Default off; absence ⇒ mic denied, mirroring `freeflowEnabled`. */
  realtimeVoiceEnabled?: boolean;
  /** How long (ms) a realtime voice session may sit with no voice activity before
   *  it auto-disconnects (the rt-9 idle guard). Default 180000 (3 min). 0 = never
   *  auto-disconnect on idle — the spend cap remains the runaway guard. The user
   *  tunes this in Settings → Realtime Michael. */
  realtimeIdleDisconnectMs?: number;

  // ─── Generic inbound webhook + status API (LEGACY, single-endpoint) ─────────
  // Superseded by `webhookTriggers`, which allows many endpoints over one server
  // and one tunnel. These three are kept because they are the MIGRATION SOURCE
  // (`migrateTriggersV1` folds them into a `WebhookTrigger`) and because the main
  // process still reads them until the server is rewired onto the new list.
  // Nothing new should be written here.
  /** @deprecated Use `webhookTriggers[].enabled`. */
  webhookEnabled?: boolean;
  /** App-generated shared secret callers echo in `x-md-webhook-secret`. Never
   *  logged, and never forwarded into the routed message/card/response.
   *  @deprecated Use `webhookTriggers[].secret` (one secret per endpoint, so
   *  revoking one caller never disturbs the others). */
  webhookSecret?: string;
  /** Local HTTP port the generic webhook server binds to (default 3849).
   *  @deprecated The port is a property of the shared server, not of any one
   *  trigger; `webhookTriggers` are multiplexed over it by id. */
  webhookPort?: number;

  // ─── Triggers (src/shared/triggers.ts owns every type here) ────────────────
  /** Auto-compaction / auto-clearing of agent terminal context. Both halves ship
   *  in DEFAULT_CONTEXT_TRIGGER; `readConfig` deep-fills them, because the
   *  top-level merge below is one level deep and a half-written sub-object would
   *  otherwise reach consumers with `undefined` thresholds. */
  contextTrigger?: ContextTriggerConfig;
  /** Inbound HTTP endpoints, one entry per caller. Replaces the legacy single
   *  webhook above; several coexist on one port, told apart by `id` in the path. */
  webhookTriggers?: WebhookTrigger[];
  /** Peer messaging between teammates' clone nodes. Persistence + UI only today —
   *  no transport service reads `apiKey` yet. */
  orgTrigger?: OrgTriggerConfig;
  /** One-time guard for `migrateTriggersV1` (legacy webhook → webhookTriggers,
   *  1h → 2h compact cadence). Set once the migration has run to completion. */
  triggersMigratedV1?: boolean;
  /** One-time guard for `migrateDefaultModelCliV1` (MODEL-DEFAULT-CLI: the old
   *  factory `defaultModel` seed is cleared once, so new agents start on their
   *  CLI's own default). Set once it has run; a later explicit choice is kept. */
  defaultModelCliMigratedV1?: boolean;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  recentHives: [],
  registeredRepos: [],
  autoMode: true,
  orchestratorMaySpawn: false,
  heavyJobsAtOnce: 1,
  heavyJobsBackgroundPriority: false,
  heavyJobsCpuCap: true,
  codexToolOutputTokenLimit: CODEX_TOOL_OUTPUT_LIMIT_DEFAULT,
  codexInheritPlugins: false,
  defaultCommand: 'claude',
  godProvider: 'claude',
  godModel: 'claude-opus-4-8',
  // MODEL-DEFAULT-CLI: NO factory `defaultModel`. A new agent (any provider)
  // starts on its CLI's own default (no --model) unless the user picks a model
  // per agent or sets a default in Settings. godModel above is separate.
  // Seeded from the MCP catalog so the consent defaults never drift from it
  // (safe-readonly ON, write/secret OFF).
  mcpDefaults: defaultMcpDefaults(),
  maxConcurrentWorkers: 4,
  workerIdleTimeoutMinutes: 20,
  integrations: [],
  defaultWorkerTokenCap: 0, // 0 = unlimited (human directive: NO per-worker cap)
  semanticMemory: true,
  missions: [OPS_STANDUP_MISSION],
  toolOutputCap: 1500,
  notifications: false,
  strongKeepalive: false,
  autoUpdate: true,
  telemetryEnabled: true,
  multiWindow: true,
  tvShowOffices: false,
  officeTheme: 'office',
  slackEnabled: false,
  inboundBindAllInterfaces: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  slackProactivePosting: false,
  freeflowEnabled: true,
  groqApiKey: undefined,
  freeflowModel: 'whisper-large-v3-turbo',
  realtimeVoiceEnabled: false,
  realtimeIdleDisconnectMs: 180_000,
  webhookEnabled: false,
  webhookSecret: undefined,
  webhookPort: undefined,
  // Triggers. These three are the ONLY object/array defaults that get handed
  // straight back out of `readConfig` for a config that never persisted them, so
  // `withTriggerDefaults` re-copies them on every read — see the note there.
  contextTrigger: DEFAULT_CONTEXT_TRIGGER,
  webhookTriggers: [],
  orgTrigger: DEFAULT_ORG_TRIGGER,
  triggersMigratedV1: false,
  // Enterprise Knowledge Graph — opt-in; dark until the user enables it.
  // v0.3.4 fix: default OFF, matching the field's own documentation ("Default
  // OFF / dark until enabled") — the true default contradicted it. Existing
  // installs keep their persisted value.
  knowledgeGraph: { enabled: false }
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export interface ConfigIntegrityIssue {
  file: string;
  quarantine: string | null;
  error: string;
}

let configIntegrity: ConfigIntegrityIssue | null = null;
let configCorruptFingerprint: string | null = null;

/** What only a FRESH install (no config file, or a reset) starts with, never a read default for an
 *  existing file: the default-model flag is done, and CLAIMS-DEFAULT C3 (god bb3f5b) the claim ledger
 *  level is writer. An existing config without `claimLedger` stays off. */
const FRESH_INSTALL: Partial<HarnessConfig> = { defaultModelCliMigratedV1: true, claimLedger: 'writer' };

function configDefaults(): HarnessConfig {
  return clampDevHome(withTriggerDefaults({ ...DEFAULTS, ...FRESH_INSTALL }));
}

/** A tiny bounded backoff for Windows handles held by an editor or AV scanner. */
function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function renameWithRetry(tmp: string, target: string): void {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { renameSync(tmp, target); return; } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 4) break;
      sleepSync(20 * (attempt + 1));
    }
  }
  throw new Error(`Could not atomically publish config.json after Windows rename retries: ${last instanceof Error ? last.message : String(last)}`);
}

function writeConfigAtomically(p: string, data: unknown): void {
  const tmp = `${p}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const text = JSON.stringify(data, null, 2);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameWithRetry(tmp, p);
  } catch (error) {
    // The file may or may not have changed: the next read goes to disk.
    configCache = null;
    try { rmSync(tmp, { force: true }); } catch { /* preserve the publish error */ }
    throw error;
  }
  // Our own write drops the cache: the next read stats and reads the disk once (one read per write).
  // Never a write-through entry: our text cannot be paired with a stat key, because a stat after
  // the rename could carry an outside write's key and serve our text forever (Jim P1).
  configWriteGen++;
  configCache = null;
}

/**
 * MAIN-SYNC-LOG-LEDGER (config, the #1 main-sync cost): readConfig was a disk read, a parse and
 * the migrations on every call, ~2,900 calls/min on main under a heavy run (112 call sites in
 * index.ts, many of them getters called per tick). It now serves one parsed, DEEP-FROZEN config
 * from memory:
 *   - writeConfigAtomically (every in-process write) drops the cache, so the next read stats and
 *     reads the disk once; this module's read-modify-writes read fresh (no window);
 *   - an external edit is picked up by fs.watch on the folder (it marks the cache dirty), and the
 *     authority is a stat revalidate (mtime, ctime, size, ino) at most CONFIG_REVALIDATE_MS after
 *     the last check, because fs.watch on Windows misses events; a value read within
 *     STAT_RACY_MS of the file's last change is cached unproven (key null), so that revalidate
 *     reads the disk once (statCacheKey.ts: same-size writes inside one tick share a key);
 *   - the missing, corrupt and unreadable paths are not cached: they behave exactly as before.
 * The value is frozen, never cloned per call (that would bring the cost back): a caller that
 * needs a changed config spreads it into a new object (writeConfig's `{ ...current, ...patch }`).
 */
export const CONFIG_REVALIDATE_MS = 1_000;
type ConfigCache = { path: string; key: string | null; value: HarnessConfig; checkedAt: number };
let configCache: ConfigCache | null = null;
/** Bumped by every write, so a read whose migration wrote mid-build does not cache a stale value. */
let configWriteGen = 0;
let configNow = (): number => Date.now();
/** The wall clock the racy rule compares with file times (configNow is only the window's clock). */
let configWall = (): number => Date.now();
let configWatcher: { path: string; close: () => void } | null = null;

function statOrNull(p: string): Stats | null {
  // As existsSync: any error (ENOENT, EACCES, ...) is "no file".
  try { return statSync(p); } catch { return null; }
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** fs.watch on the config folder marks the cache dirty (the next read stats). Best-effort: the
 *  stat revalidate is the authority, so a watcher that fails to start or dies changes nothing. */
function watchConfig(p: string): void {
  if (configWatcher?.path === p) return;
  configWatcher?.close();
  configWatcher = null;
  try {
    const w = watch(dirname(p), { persistent: false }, (_event, name) => {
      if (!name || String(name) === basename(p)) { if (configCache?.path === p) configCache.checkedAt = -Infinity; }
    });
    w.on('error', () => { w.close(); if (configWatcher?.path === p) configWatcher = null; });
    configWatcher = { path: p, close: () => w.close() };
  } catch { /* no watcher: the stat revalidate still bounds the staleness */ }
}

/** Tests: drop the cache (the next read goes to disk), and/or drive the revalidate clock and the
 *  racy rule's wall clock. */
export function __resetConfigCacheForTests(now?: () => number, wall?: () => number): void {
  configCache = null;
  if (now) configNow = now;
  if (wall) configWall = wall;
}

function noteCorruptConfig(p: string, raw: string, error: unknown): void {
  configCache = null;
  const fingerprint = createHash('sha256').update(raw).digest('hex');
  let quarantine: string | null = configIntegrity?.quarantine ?? null;
  if (configCorruptFingerprint !== fingerprint) {
    const candidate = `${p}.corrupt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      copyFileSync(p, candidate);
      quarantine = candidate.split(/[\\/]/).pop() ?? candidate;
      configCorruptFingerprint = fingerprint;
    } catch (copyError) {
      quarantine = null;
      console.error('[config] could not quarantine corrupt config.json:', copyError);
    }
  }
  configIntegrity = {
    file: 'config.json',
    quarantine,
    error: error instanceof Error ? error.message : String(error)
  };
  console.error(`[config] config.json is invalid JSON; writes are paused until repaired.${quarantine ? ` Copy: ${quarantine}` : ''}`);
}

/** Reads enough to surface a persisted config problem to the renderer banner. */
export function configIntegrityIssue(): ConfigIntegrityIssue | null {
  readConfigCached(true);
  return configIntegrity;
}

function assertConfigWritable(): void {
  if (!configIntegrity) return;
  const copy = configIntegrity.quarantine ? ` A copy was saved as ${configIntegrity.quarantine}.` : '';
  throw new Error(`config.json is invalid JSON; refusing to overwrite it.${copy} Repair it, then retry.`);
}

/**
 * Deep-fill the trigger sub-objects, and hand back copies of them.
 *
 * TWO problems, one fix. First, the merge in `readConfig` is one level deep, so a
 * `contextTrigger` persisted by an older build (or by a `writeConfig` that
 * patched only `compact`) arrives missing sub-keys that DEFAULTS would have
 * supplied — the consumer then reads `undefined` where it expects a number and
 * the rule never fires. Second, that same shallow merge hands the literal
 * DEFAULT_CONTEXT_TRIGGER / DEFAULT_ORG_TRIGGER instances to every config that
 * didn't persist them, so one caller mutating what it read would rewrite the
 * defaults for the whole process — and for every config read afterwards.
 *
 * Every branch below therefore constructs a fresh object, including the
 * "nothing persisted" branch.
 */
function withTriggerDefaults(cfg: HarnessConfig): HarnessConfig {
  return {
    ...cfg,
    contextTrigger: {
      compact: { ...DEFAULT_CONTEXT_TRIGGER.compact, ...cfg.contextTrigger?.compact },
      clear: { ...DEFAULT_CONTEXT_TRIGGER.clear, ...cfg.contextTrigger?.clear }
    },
    orgTrigger: { ...DEFAULT_ORG_TRIGGER, ...cfg.orgTrigger },
    webhookTriggers: Array.isArray(cfg.webhookTriggers)
      ? cfg.webhookTriggers.map((t) => ({ ...t }))
      : []
  };
}

/** Set once `migrateTriggersV1` has run in THIS process. `writeConfig` reads
 *  before it writes, so without an in-memory latch the migration's own persist
 *  would re-enter `readConfig` and run the migration a second time before
 *  `triggersMigratedV1: true` ever reached disk. */
let triggersMigrationRan = false;

/**
 * Fold the pre-Triggers config shape forward, exactly once per install.
 *
 * Runs from `readConfig`, so it is complete before any consumer can observe the
 * config — there is no boot ordering to get wrong and no window in which half
 * the app sees the old shape. Two things move:
 *
 *   1. The single legacy webhook (`webhookEnabled`/`webhookSecret`) becomes one
 *      `WebhookTrigger` with the stable id `legacy`, so the caller that already
 *      holds that secret keeps working across the upgrade. Skipped when
 *      `webhookTriggers` is already populated — the user has moved on, and
 *      re-adding a synthesised entry would resurrect a revoked endpoint.
 *   2. The seeded `compact-maintenance` mission moves from the old 1h cadence to
 *      2h, but ONLY if it still reads exactly 1h. A user-chosen interval is a
 *      decision, not a stale default, and is left alone.
 *
 * Wrapped end-to-end in a try/catch: a config that is corrupt in some unrelated
 * way must still boot the app, and a migration is never worth a failed launch.
 */
function migrateTriggersV1(cfg: HarnessConfig): HarnessConfig {
  if (cfg.triggersMigratedV1 || triggersMigrationRan) return cfg;
  triggersMigrationRan = true;
  try {
    const next: HarnessConfig = { ...cfg, triggersMigratedV1: true };

    const legacySecret = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret.trim() : '';
    if (legacySecret && (cfg.webhookTriggers?.length ?? 0) === 0) {
      next.webhookTriggers = [
        {
          id: 'legacy',
          name: 'Default webhook',
          secret: legacySecret,
          enabled: cfg.webhookEnabled ?? false,
          mode: DEFAULT_TRIGGER_MODE,
          schema: DEFAULT_WEBHOOK_SCHEMA,
          createdAt: Date.now()
        }
      ];
    }

    const missions = Array.isArray(cfg.missions) ? cfg.missions : [];
    const stale = (m: ScheduledMission): boolean =>
      m?.id === COMPACT_MAINTENANCE_MISSION.id
      && m.intervalMs === LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS;
    if (missions.some(stale)) {
      next.missions = missions.map((m) =>
        stale(m) ? { ...m, intervalMs: COMPACT_MAINTENANCE_MISSION.intervalMs } : m
      );
    }

    persistConfig(next);
    return next;
  } catch {
    // Leave the config exactly as read. The latch above stays set, so a failing
    // migration retries on the next launch rather than on every single read.
    return cfg;
  }
}

/** MODEL-DEFAULT-CLI (the Human's decision, 1.1.70): the single switch for the
 *  one-time clear below. true = a saved `defaultModel` (almost always the old
 *  factory seed, which every earlier build persisted into config.json) is
 *  cleared once, so new agents start on the CLI default. false = the migration
 *  does nothing at all (no clear, no flag), so flipping it back later is safe. */
export const CLEAR_SAVED_DEFAULT_MODEL = true;

/** Same latch role as `triggersMigrationRan`: the migration's own persist must
 *  not re-enter it before the flag reaches disk. */
let defaultModelMigrationRan = false;
/** The value the migration cleared in THIS process, until main takes it to log
 *  it (the hive logger is not reachable from config load). */
let clearedDefaultModel: string | null = null;

/**
 * Clear a saved `defaultModel` exactly once per install, and record
 * `defaultModelCliMigratedV1` so it never runs again: a default the user picks
 * in Settings afterwards is an explicit choice and is kept. `godModel` and every
 * agent's own stored model are untouched. Never worth a failed launch.
 */
function migrateDefaultModelCliV1(cfg: HarnessConfig): HarnessConfig {
  if (!CLEAR_SAVED_DEFAULT_MODEL) return cfg;
  if (cfg.defaultModelCliMigratedV1 || defaultModelMigrationRan) return cfg;
  defaultModelMigrationRan = true;
  try {
    const next: HarnessConfig = { ...cfg, defaultModelCliMigratedV1: true };
    const previous = typeof cfg.defaultModel === 'string' ? cfg.defaultModel.trim() : '';
    delete next.defaultModel;
    persistConfig(next);
    if (previous) clearedDefaultModel = previous;
    return next;
  } catch {
    return cfg;
  }
}

/** The `defaultModel` the one-time migration cleared in this process, handed
 *  out ONCE (then null) so main writes exactly one hive log row for it. */
export function takeClearedDefaultModel(): string | null {
  const v = clearedDefaultModel;
  clearedDefaultModel = null;
  return v;
}

/** Keys older builds persisted that nothing reads any more (1.1.60: the retired indexer's model
 *  choice; 1.1.92 ZT-I2-CONDENSE: the retired Haiku condense's tunables). readConfig drops them,
 *  and pruneRetiredConfigKeys rewrites the file once. */
export const RETIRED_CONFIG_KEYS = [
  'embeddingModel',
  'reflectEnabled', 'reflectIntervalMs', 'reflectByteTriggerPct', 'reflectSectionTrigger', 'reflectRecentKeep', 'reflectMinBytes'
] as const;

/** Remove RETIRED_CONFIG_KEYS from config.json on disk, touching nothing else (no defaults are
 *  merged in). Best-effort; returns the keys removed. */
export function pruneRetiredConfigKeys(): string[] {
  const p = configPath();
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const gone = RETIRED_CONFIG_KEYS.filter((k) => k in parsed);
    if (!gone.length) return [];
    for (const k of gone) delete parsed[k];
    assertConfigWritable();
    writeConfigAtomically(p, parsed);
    return gone;
  } catch (error) {
    if (error instanceof SyntaxError) noteCorruptConfig(p, readFileSync(p, 'utf8'), error);
    return [];
  }
}

export function readConfig(): HarnessConfig {
  return readConfigCached(false);
}

/** The base for a read-modify-write outside this module (a list edited and written back with
 *  writeConfig): it skips the window and the stat decides, so the patch never builds on a value
 *  up to CONFIG_REVALIDATE_MS old and never drops a change another process made meanwhile.
 *  Plain reads keep the cached read. */
export function readConfigForWrite(): HarnessConfig {
  return readConfigCached(true);
}

/** `fresh` (this module's read-modify-writes and integrity checks): skip the window, so a merge
 *  never builds on a value another process has replaced; the stat decides. */
function readConfigCached(fresh: boolean): HarnessConfig {
  const p = configPath();
  const now = configNow();
  const c = configCache;
  if (c && !fresh && c.path === p && now - c.checkedAt >= 0 && now - c.checkedAt < CONFIG_REVALIDATE_MS) return c.value;
  const st = statOrNull(p);
  // No file yet = a first run with nothing to migrate; the defaults ARE the
  // post-migration shape. Deliberately does not persist — a bare read must not
  // conjure a config.json before onboarding has written one. A fresh install has
  // nothing to clear, so its first write records the default-model flag as done
  // (otherwise a default the user picks before that write would be cleared).
  if (!st) {
    configCache = null;
    configIntegrity = null;
    configCorruptFingerprint = null;
    return configDefaults();
  }
  // The key is taken BEFORE the read: a change between the two re-reads at the next revalidate.
  const key = statKey(st);
  if (c && c.path === p && c.key === key) {
    c.checkedAt = now;
    return c.value;
  }
  const gen = configWriteGen;
  let raw: string | undefined;
  let built: HarnessConfig;
  try {
    raw = readFileSync(p, 'utf8');
    const parsed = migrateHeavyJobsCpuCap(JSON.parse(raw));
    for (const k of RETIRED_CONFIG_KEYS) delete parsed[k];
    configIntegrity = null;
    configCorruptFingerprint = null;
    built = normalizeStoredHomes(migrateDefaultModelCliV1(migrateTriggersV1(withTriggerDefaults({ ...DEFAULTS, ...parsed }))));
  } catch (error) {
    configCache = null;
    if (typeof raw === 'string') {
      noteCorruptConfig(p, raw, error);
      return configDefaults();
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return configDefaults();
    throw new Error(`config.json could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  // A clone, so freezing never reaches the DEFAULTS objects a shallow merge shares.
  const value = deepFreeze(structuredClone(built));
  // A migration that persisted mid-build changed the file after the stat: leave it uncached.
  // Racy-git rule: a change within STAT_RACY_MS of now may share this key with a later write.
  if (gen === configWriteGen) configCache = { path: p, key: provenStatKey(st, configWall()), value, checkedAt: now };
  watchConfig(p);
  return value;
}

/** 1.1.98: processor affinity under-sized neither Node nor other tool runtimes on Windows.
 * Only an old ON is meaningful: the former default was false and writeConfig persisted defaults,
 * so false cannot distinguish an explicit choice from every upgraded install. Retire the old key;
 * missing or false therefore gets the Human's new default-on 50% cap. */
function migrateHeavyJobsCpuCap(parsed: unknown): Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed as Record<string, unknown>;
  const next = { ...(parsed as Record<string, unknown>) };
  if (!('heavyJobsCpuCap' in next) && next.heavyJobsHalfCores === true) next.heavyJobsCpuCap = true;
  delete next.heavyJobsHalfCores;
  return next;
}

/** (#140, the upgrade path) A config.json persisted BEFORE `writeConfig`
 *  learned to expand `~` still holds literal `~/…` strings in `harnessHome` /
 *  `recentHives`, and nothing rewrites the file until the next write — so the
 *  hive picker renders the raw `~` string and feeds it straight back into
 *  `config:changeHome`, which lands on `resolve()` → `<cwd>/~/…`, a real
 *  directory named "~". `normalizeHiveHome` only cleans values on the way IN;
 *  this cleans them on the way OUT, so no consumer can see a `~` path
 *  regardless of the file's vintage. Expanded duplicates collapse (a stale
 *  "~/X" next to its absolute twin becomes one entry). */
/** MUNDER_DEV=1: the harness home is CLAMPED to the dev data root, whatever the
 *  wizard, a stale config.json or a picker says. Every derived path (hive,
 *  palace, worktrees, roster.json) follows from harnessHome, so this one clamp
 *  is what keeps a dev build off Stable's data; index.ts re-verifies at startup.
 *  No-op when isolation is off. */
function clampDevHome(cfg: HarnessConfig): HarnessConfig {
  if (DEV_ISOLATION) {
    const home = devHarnessHome(devDataRoot());
    cfg.harnessHome = home;
    // The hive picker's history must not advertise a Stable/out-of-tree path
    // either (Andy 72f6180a spot-check): under DEV it is exactly the DEV root.
    cfg.recentHives = [home];
  }
  return cfg;
}

function normalizeStoredHomes(cfg: HarnessConfig): HarnessConfig {
  clampDevHome(cfg);
  if (typeof cfg.harnessHome === 'string' && cfg.harnessHome.trim()) {
    cfg.harnessHome = expandTilde(cfg.harnessHome);
  }
  if (Array.isArray(cfg.recentHives)) {
    const seen = new Set<string>();
    cfg.recentHives = cfg.recentHives
      .filter((h): h is string => typeof h === 'string' && !!h.trim())
      .map((h) => expandTilde(h))
      .filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
  }
  if (cfg.officeThemeByHive) {
    const normalized: Record<string, ProjectThemeId> = {};
    // An unregistered pack id is kept (the pack may be renamed or dropped in this build); only garbage is dropped.
    for (const [home, theme] of Object.entries(cfg.officeThemeByHive)) {
      if (home.trim() && isStoredProjectThemeId(theme)) normalized[projectThemeHomeKey(expandTilde(home))] = theme;
    }
    cfg.officeThemeByHive = normalized;
  }
  if (cfg.projectThemeSeedByHive) {
    const normalized: Record<string, ProjectThemeSeed> = {};
    for (const [home, seed] of Object.entries(cfg.projectThemeSeedByHive)) {
      if (home.trim() && isProjectThemeSeed(seed)) normalized[projectThemeHomeKey(expandTilde(home))] = seed;
    }
    cfg.projectThemeSeedByHive = normalized;
  }
  return cfg;
}

/** Resolve a hive's explicit selection, retaining the legacy global fallback. */
export function resolveProjectThemeForHome(config: HarnessConfig, harnessHome?: string): ProjectThemeId {
  return resolveProjectTheme(config, harnessHome ? expandTilde(harnessHome) : harnessHome);
}

/** Update only one project's explicit choice, against the latest config on disk
 *  (the renderer's config is a snapshot; see setAgentTokenCap). */
export function setProjectThemeForHome(harnessHome: string, theme: unknown): HarnessConfig {
  if (!isProjectThemeId(theme)) throw new Error('invalid project theme');
  const home = projectThemeHomeKey(expandTilde(harnessHome));
  const current = readConfigCached(true);
  return writeConfig({ officeThemeByHive: { ...(current.officeThemeByHive ?? {}), [home]: theme } });
}

function persistConfig(next: HarnessConfig): HarnessConfig {
  // MUNDER_DEV=1: enforce the harnessHome clamp at the persistence boundary
  // too, so no caller (writeConfig patch, migration, reset) can persist or
  // return a non-DEV home even if it merged one in.
  clampDevHome(next);
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  assertConfigWritable();
  writeConfigAtomically(p, next);
  return next;
}

/** RENDERER-CONFIG-RMW: the map keys a renderer edits one entry at a time. writeConfig merges
 *  them one level deep on the fresh read, so a caller holding a stale snapshot sends only the
 *  entry it changed and never writes the other entries back (the second MCP toggle of a Settings
 *  visit used to revert the first; a knowledge-graph toggle used to drop rootPath). An entry sent
 *  as undefined is removed. A list key is still replaced whole: see registerRepo/patchMission. */
export const CONFIG_MERGE_KEYS = ['mcpDefaults', 'providerBaseUrls', 'providerDefaultModels', 'knowledgeGraph', 'circuitBreaker'] as const;

function mergeMapKeys(current: HarnessConfig, patch: Partial<HarnessConfig>, next: HarnessConfig): void {
  for (const k of CONFIG_MERGE_KEYS) {
    const p = patch[k] as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const merged: Record<string, unknown> = { ...((current[k] as Record<string, unknown> | undefined) ?? {}) };
    for (const [e, v] of Object.entries(p)) {
      if (v === undefined) delete merged[e];
      else merged[e] = v;
    }
    (next as unknown as Record<string, unknown>)[k] = merged;
  }
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfigCached(true);
  const next: HarnessConfig = { ...current, ...patch };
  mergeMapKeys(current, patch, next);
  // CODEX-BLOAT-165 fix 2: 'off' or a number, clamped to 1000-10000. Anything else is refused
  // and changes nothing (the renderer reverts its control on the rejection).
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'codexToolOutputTokenLimit')) {
    const n = normalizeCodexToolOutputLimit(patch.codexToolOutputTokenLimit);
    if (n === null) throw new Error('invalid codexToolOutputTokenLimit');
    next.codexToolOutputTokenLimit = n;
  }
  // CODEX-BLOAT-165 fix 5: a boolean only; anything else is refused and changes nothing.
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'codexInheritPlugins')
    && typeof patch.codexInheritPlugins !== 'boolean') {
    throw new Error('invalid codexInheritPlugins');
  }
  // Project INGESTION — a registered repo is typed by hand ("~/dev/foo") as often
  // as it is picked from the folder dialog. Expand `~` here so the persisted list
  // (and therefore every agent's default cwd) is ABSOLUTE; Node's fs/spawn treat
  // `~` as a literal directory name and the spawn dies with `cwd does not exist`.
  // CODEX-TRUST-LAYER: the allowed folders, normalised to the key the spawn matches.
  if (patch.codexLayerOptIns !== undefined) {
    if (!Array.isArray(patch.codexLayerOptIns) || patch.codexLayerOptIns.some((k) => typeof k !== 'string' || !k.trim())) throw new Error('invalid codexLayerOptIns');
    const seen = new Set<string>();
    next.codexLayerOptIns = patch.codexLayerOptIns
      .map((k) => codexLayerOptInKey(expandTilde(k)))
      .filter((k) => !seen.has(k) && (seen.add(k), true))
      .sort();
  }
  if (Array.isArray(patch.registeredRepos)) {
    const seen = new Set<string>();
    next.registeredRepos = patch.registeredRepos
      .map((r) => expandTilde(r))
      .filter((r) => r && !seen.has(r) && (seen.add(r), true));
  }
  // The HIVE HOME needs the exact same treatment as registeredRepos above, and for
  // years it did not get it (#140). Onboarding SUGGESTS `~/Guppy` (1.1.82; before, `~/HarnessAgents`) and the
  // field is free text, so the common path — accept the default, press Finish —
  // persisted a literal `~`. The first thing the finish step does is create the
  // directory, and Node's mkdir has no idea what `~` means: it tried to make a
  // folder actually named "~", which fails as
  //   ENOENT: no such file or directory, mkdir '~/HarnessAgents'
  // and left the wizard wedged on its last step with no way forward. Expand BEFORE
  // the value is persisted or copied into recentHives, so every downstream reader
  // (mkdir, the hive root, the launch picker) sees one absolute path.
  if (typeof patch.harnessHome === 'string' && patch.harnessHome) {
    const { home, recentHives } = normalizeHiveHome(patch.harnessHome, current.recentHives ?? []);
    next.harnessHome = home;
    next.recentHives = recentHives;
  }
  return persistConfig(next);
}

/** Set or clear one agent's token ceiling against the latest config on disk.
 *
 * Renderer config objects are snapshots. Replacing `agentTokenCaps` from one of
 * those snapshots loses caps written since the snapshot was read (most visibly
 * while reviewing a batch of imported hires). Keep the read-modify-write in the
 * synchronous main process so each call merges with the result of the previous
 * one before returning the updated config to the renderer. */
export function setAgentTokenCap(agentId: unknown, tokenCap: unknown): HarnessConfig {
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw new Error('invalid agent token cap');
  }
  if (
    tokenCap !== undefined
    && (
      typeof tokenCap !== 'number'
      || !Number.isInteger(tokenCap)
      || tokenCap <= 0
      || tokenCap > MAX_AGENT_TOKEN_CAP
    )
  ) throw new Error('invalid agent token cap');

  const current = readConfigCached(true);
  const agentTokenCaps = { ...(current.agentTokenCaps ?? {}) };
  if (tokenCap === undefined) delete agentTokenCaps[agentId];
  else agentTokenCaps[agentId] = tokenCap;
  return persistConfig({
    ...current,
    agentTokenCaps
  });
}

function repoKey(repo: unknown): string {
  if (typeof repo !== 'string' || !repo.trim()) throw new Error('invalid repo path');
  return expandTilde(repo.trim());
}

/** RENDERER-CONFIG-RMW: one project quick-pick in (deduped to the front, or the back) against
 *  the latest list on disk. The Add Agent modal used to send its whole mount-time list back,
 *  which erased any repo registered elsewhere meanwhile. writeConfig's expandTilde + dedupe
 *  still applies to the list it is handed. */
export function registerRepo(repo: unknown, front: boolean = true): HarnessConfig {
  const p = repoKey(repo);
  const rest = (readConfigForWrite().registeredRepos ?? []).filter((r) => expandTilde(r) !== p);
  return writeConfig({ registeredRepos: front ? [p, ...rest] : [...rest, p] });
}

/** One project quick-pick out, against the latest list on disk; the folder itself is untouched.
 *  Entries are compared normalised, so a hand-written `C:/x` or `~/x` entry matches its picked form. */
export function unregisterRepo(repo: unknown): HarnessConfig {
  const p = repoKey(repo);
  return writeConfig({ registeredRepos: (readConfigForWrite().registeredRepos ?? []).filter((r) => expandTilde(r) !== p) });
}

/** The scheduler's own mission fields (and the key): a renderer patch never sets them, exactly as
 *  missions:save keeps them from the persisted record. */
const MISSION_SCHEDULER_FIELDS = ['id', 'lastFiredAt', 'lastDeltaFingerprint', 'lastDispatchAt'] as const;

/** RENDERER-CONFIG-RMW: one mission's fields against the latest list on disk. The Settings
 *  auto-compact toggle and the Schedules panel used to each send a whole list built from their
 *  own copy, so one surface's `enabled` flip was undone by the other's next save, and a scheduler
 *  stamp landing between the renderer's read and its write was lost. Throws for an unknown id,
 *  so the caller's control reverts instead of a silent no-op. */
export function patchMission(id: unknown, fields: unknown): HarnessConfig {
  if (typeof id !== 'string' || !id || !fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('invalid mission patch');
  const own = { ...(fields as Record<string, unknown>) };
  for (const k of MISSION_SCHEDULER_FIELDS) delete own[k];
  const current = readConfigForWrite().missions ?? [];
  if (!current.some((m) => m.id === id)) throw new Error(`unknown mission ${id}`);
  return writeConfig({ missions: current.map((m) => (m.id === id ? { ...m, ...own } as ScheduledMission : m)) });
}

/** Set one agent's Monitor line (Budget / 5H / Weekly) against the latest config on disk.
 *
 * The same read-modify-write in main as `setAgentTokenCap`, for the same reason: the
 * renderer holds snapshots. 'budget' is the default, so it is stored as ABSENT; only an
 * explicit 5H or Weekly choice is written, and only that exempts the agent from the
 * budget. An unknown value is refused rather than stored, so it can never be read later
 * as an exemption. */
export function setAgentUsageDisplay(agentId: unknown, display: unknown): HarnessConfig {
  if (typeof agentId !== 'string' || agentId.trim().length === 0 || !isAgentUsageDisplay(display)) {
    throw new Error('invalid agent usage display');
  }
  const current = readConfigCached(true);
  const agentUsageDisplay = { ...(current.agentUsageDisplay ?? {}) };
  if (display === 'budget') delete agentUsageDisplay[agentId];
  else agentUsageDisplay[agentId] = display;
  return persistConfig({ ...current, agentUsageDisplay });
}

/** Set the capacity-display threshold (C2.8). An integer 1-99 or it is REFUSED: the stored
 * value is left exactly as it was, and nothing is clamped into range. */
export function setCapacityDisplayThreshold(value: unknown): HarnessConfig {
  const t = parseCapacityDisplayThreshold(value);
  if (t === null) throw new Error('invalid capacity display threshold');
  return persistConfig({ ...readConfigCached(true), capacityWeeklyDisplayThreshold: t });
}

/** GPU-SETTING-188: save the Graphics mode. Anything but 'auto' | 'gpu' | 'cpu' is REFUSED and the
 *  stored value stays. It takes effect at the next start (main applies it before app ready). */
export function setGraphicsMode(value: unknown): HarnessConfig {
  const mode = parseGraphicsMode(value);
  if (mode === null) throw new Error('invalid graphics mode');
  return persistConfig({ ...readConfigCached(true), graphicsMode: mode });
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  const p = configPath();
  readConfigCached(true);
  assertConfigWritable();
  mkdirSync(dirname(p), { recursive: true });
  // A reset is a fresh install: nothing to clear, so the default-model flag is done.
  writeConfigAtomically(p, { ...DEFAULTS, ...FRESH_INSTALL });
  // Drop the migration latch too: the file on disk is back to `triggersMigratedV1:
  // false`, and a latch left set would keep the flag from ever being written again
  // in this process. The migration itself is a no-op on defaults either way.
  triggersMigrationRan = false;
  return withTriggerDefaults({ ...DEFAULTS, ...FRESH_INSTALL });
}

/** Model ids by tier (Lane A #6.4). Kept in sync with AGENT_MODELS in
 *  src/renderer/src/store/config.ts. */
const MODEL_GOD = 'claude-opus-4-8';                  // orchestration — highest capability
const MODEL_WORKER = 'claude-sonnet-4-6';             // general execution
const MODEL_HELPER = 'claude-haiku-4-5-20251001';     // narrow, cheap helpers

/** Minimal structural shape for tiering — a subset of AgentMeta so config.ts
 *  stays free of a hive.ts import. */
export interface RoleHint {
  isGod?: boolean;
  role?: string;
  capabilities?: string[];
}

/** Default model for an agent given its role (Lane A #6.4): Opus for the god,
 *  Haiku for narrow helpers (triage / routing / verification / formatting),
 *  Sonnet for general workers. Returns a model id (matching AGENT_MODELS) or
 *  undefined to fall back to the CLI default. This is only a DEFAULT — an
 *  explicit per-agent model selection always wins. */
export function modelForRole(
  meta: RoleHint,
  config?: Pick<HarnessConfig, 'godProvider' | 'godModel'>
): string | undefined {
  if (meta.isGod) {
    // GOD engine is selectable: an explicit godModel wins, else the chosen
    // provider's recommended orchestrator model, else the legacy Opus default.
    const preset = providerPreset(config?.godProvider ?? 'claude');
    return config?.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD;
  }
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}

/** Resolve a hive Claude spawn model. A saved per-agent `/model` choice is
 * authoritative over app-wide defaults; an explicit argv `--model` is handled
 * by the caller before it calls this helper. God: godModel (modelForRole).
 * Anyone else: the Settings default if one is set, else undefined = NO --model,
 * the CLI's own default (MODEL-DEFAULT-CLI; the role tiers are not applied to
 * workers, or a "CLI default" pick would silently become Sonnet). */
export function modelForHiveSpawn(
  meta: RoleHint,
  config: Pick<HarnessConfig, 'defaultModel' | 'godProvider' | 'godModel'>,
  persistedModel?: string
): string | undefined {
  const saved = persistedModel?.trim();
  if (saved) return saved;
  return meta.isGod
    ? modelForRole(meta, config)
    : config.defaultModel?.trim() || undefined;
}

/** Ensure harnessHome exists on disk. Expands `~` first — the onboarding wizard
 *  lets the user type the path, and mkdir treats a literal `~` as a plain
 *  directory name (issue #140's `ENOENT: mkdir '~/HarnessAgents'`). */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string; blank?: boolean; home?: string } {
  try {
    // MUNDER_DEV=1: the wizard's free-text folder is ignored; only the clamped
    // dev root is ever created (so a typed `C:\Dunder` never mkdirs anything).
    const home = DEV_ISOLATION ? devHarnessHome(devDataRoot()) : expandTilde(path);
    // Blank = absent or empty before the mkdir: the only home a creation seed may land in.
    let blank = false;
    try { blank = !existsSync(home) || readdirSync(home).length === 0; } catch { blank = false; }
    // Expand HERE too, not only at the config write (#140). This runs FIRST —
    // onboarding calls it before updateConfig — so normalizing only at the write
    // boundary left the actual mkdir still receiving a literal `~`. Depending on
    // the process cwd that either fails outright or, worse, quietly succeeds by
    // creating a directory genuinely named "~" somewhere nobody will look, and
    // the hive then lives at a path the user cannot find. This is the
    // "defense-in-depth at the consumers" the expandTilde doc calls for: the
    // ingestion point normalizes, and the consumer refuses to trust that it did.
    mkdirSync(home, { recursive: true });
    return { ok: true, blank, home };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** A home onboarding saw blank is still unclaimed when it holds no project yet.
 *  Guppy's bootstrap writes a wide and growing scaffold before the first theme choice
 *  (hive/ with its protocol files, bin/ shims, state/, ledgers, the memory engine's
 *  files, engine configs), so this checks the PROJECT markers rather than an exact
 *  file list: no roster at the home, and a hive (if any) with no agent folder, no
 *  registered agent, no task and no pending spawn request. Fails closed: an
 *  unreadable or malformed marker means "a project". */
export function homeHasNoProject(path: string): boolean {
  try {
    const home = DEV_ISOLATION ? devHarnessHome(devDataRoot()) : expandTilde(path);
    if (!existsSync(home)) return true;
    if (existsSync(join(home, 'roster.json')) || existsSync(join(home, 'roster-backups'))) return false;
    const hive = join(home, 'hive');
    if (!existsSync(hive)) return true;
    if (!statSync(hive).isDirectory()) return false;
    const agents = join(hive, 'agents');
    if (existsSync(agents) && readdirSync(agents).length > 0) return false;
    const registry = join(hive, 'registry.json');
    if (existsSync(registry)) {
      const r = JSON.parse(readFileSync(registry, 'utf8')) as { agents?: unknown };
      if (!r || typeof r !== 'object' || !r.agents || typeof r.agents !== 'object' || Object.keys(r.agents).length > 0) return false;
    }
    const tasks = join(hive, 'tasks.json');
    if (existsSync(tasks)) {
      const t = JSON.parse(readFileSync(tasks, 'utf8')) as { tasks?: unknown };
      if (!Array.isArray(t?.tasks) || t.tasks.length > 0) return false;
    }
    const requests = join(hive, 'spawn-requests');
    if (existsSync(requests) && !treeHasNoFiles(requests)) return false;
    return true;
  } catch {
    return false;
  }
}

function treeHasNoFiles(dir: string): boolean {
  if (!statSync(dir).isDirectory()) return false;
  return readdirSync(dir).every((name) => treeHasNoFiles(join(dir, name)));
}

/** Idempotently pre-accept Claude Code's first-run prompts so agents spawned with
 *  `--permission-mode bypassPermissions` start cleanly. Without this, a fresh
 *  install shows an interactive "WARNING: Bypass Permissions mode … 1. No, exit /
 *  2. Yes, I accept" prompt that the PTY can't answer in time, so the agent exits
 *  code 1 on its own (reported by multiple users).
 *
 *  Two separate gates, written only when they aren't already satisfied (so we
 *  rarely touch files a running `claude` also writes):
 *   1. `~/.claude/settings.json` → `skipDangerousModePermissionPrompt` +
 *      `skipAutoPermissionPrompt` — these gate the bypass-mode warning (global).
 *   2. `~/.claude.json` → `projects[cwd].hasTrustDialogAccepted` — the per-folder
 *      "do you trust the files in this folder?" dialog.
 *
 *  CLAUDE-JSON-WIPE (1.1.91): these are the USER's files (oauthAccount, every project's
 *  allowedTools, their own settings). Through 1.1.90 a file that did not parse became `{}` and
 *  was written back, wiping it. Now a file that does not parse, or parses to the wrong shape, is
 *  never written (the gate reports `refused` and the caller logs it); a write is atomic beside
 *  the real target, keeps its mode, gives up if the file changed since it was read, and leaves
 *  `<file>.guppy-backup`. Never throws. */
export function ensureClaudePermissionsAccepted(cwd?: string): ClaudePermissionsReport {
  const home = homedir();
  if (!home) return { settings: { status: 'skipped', reason: 'no home' }, trust: { status: 'skipped', reason: 'no home' } };
  // 1) Global bypass-mode warning gate.
  const settings = patchClaudeUserFile(join(home, '.claude', 'settings.json'), (s) => {
    if (s.skipDangerousModePermissionPrompt === true && s.skipAutoPermissionPrompt === true) return null;
    return { ...s, skipDangerousModePermissionPrompt: true, skipAutoPermissionPrompt: true };
  });
  // 2) Per-folder trust dialog gate (only when this cwd isn't already trusted). On Windows the
  // CLI looks the folder up with forward slashes (claude 2.1.302 j2(): replaceAll("\\","/")),
  // so a path.join-style key is never read (Andy F10).
  if (!cwd) return { settings, trust: { status: 'skipped', reason: 'no cwd' } };
  const key = process.platform === 'win32' ? cwd.replaceAll('\\', '/') : cwd;
  const trust = patchClaudeUserFile(join(home, '.claude.json'), (c) => {
    const projects = Object.hasOwn(c, 'projects') ? c.projects : {};
    if (!isPlainObject(projects)) return 'projects is not an object';
    const entry = Object.hasOwn(projects, key) ? projects[key] : {};
    if (!isPlainObject(entry)) return `projects[${key}] is not an object`;
    if (entry.hasTrustDialogAccepted === true) return null;
    return { ...c, projects: { ...projects, [key]: { ...entry, hasTrustDialogAccepted: true } } };
  });
  return { settings, trust };
}

export interface ClaudeGateOutcome { status: 'satisfied' | 'written' | 'refused' | 'failed' | 'skipped'; reason?: string }
export interface ClaudePermissionsReport { settings: ClaudeGateOutcome; trust: ClaudeGateOutcome }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read a user JSON object file, let `patch` decide, and publish the result safely.
 *  `patch` returns the new object, null (already satisfied) or a refusal reason. */
function patchClaudeUserFile(p: string, patch: (obj: Record<string, unknown>) => Record<string, unknown> | string | null): ClaudeGateOutcome {
  try {
    // F1: a symlinked file is read and published at its REAL path, so the link survives.
    let target = p;
    let before: Buffer | null = null;
    if (existsSync(p)) {
      target = realpathSync(p);
      before = readFileSync(target);
    } else {
      try { lstatSync(p); return { status: 'refused', reason: 'dangling symlink' }; } catch { /* truly missing */ }
    }
    let obj: unknown = {};
    let blank = true;
    if (before) {
      // F4: an empty or whitespace-only file is `{}`; a leading BOM is not part of the JSON.
      const text = before.toString('utf8').replace(/^\uFEFF/, '');
      blank = text.trim() === '';
      if (!blank) {
        try { obj = JSON.parse(text); } catch (error) {
          return { status: 'refused', reason: `does not parse: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }
    if (!isPlainObject(obj)) return { status: 'refused', reason: 'root is not an object' };
    const next = patch(obj);
    if (next === null) return { status: 'satisfied' };
    if (typeof next === 'string') return { status: 'refused', reason: next };
    const dir = dirname(target);
    mkdirSync(dir, { recursive: true });
    // F2: keep the file's mode (~/.claude.json holds oauthAccount; it may be 0600).
    const mode = before ? statSync(target).mode & 0o777 : undefined;
    // Andy S1: a blank file (claude truncated it mid-write) holds nothing to keep, and
    // copying it would overwrite the last good backup.
    if (before && !blank) copyFileSync(target, `${target}.guppy-backup`);
    const tmp = join(dir, `${basename(target)}.guppy-tmp-${randomBytes(4).toString('hex')}`);
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2), mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
      if (mode !== undefined && process.platform !== 'win32') chmodSync(tmp, mode);
      // F3: re-read right before EACH rename: a running `claude` that wrote the file since we read
      // it wins, and our change waits for the next spawn.
      for (let attempt = 0; ; attempt++) {
        const now = existsSync(target) ? readFileSync(target) : null;
        if (!(now === null ? before === null : before !== null && now.equals(before))) {
          rmSync(tmp, { force: true });
          return { status: 'refused', reason: 'changed while being patched' };
        }
        try { renameSync(tmp, target); return { status: 'written' }; } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if ((code !== 'EPERM' && code !== 'EBUSY') || attempt === 2) throw error;
          sleepSync(20 * (attempt + 1));
        }
      }
    } catch (error) {
      try { rmSync(tmp, { force: true }); } catch { /* keep the publish error */ }
      throw error;
    }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }
}
