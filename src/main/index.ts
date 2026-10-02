import { app, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, screen, shell, Notification, utilityProcess } from 'electron';
import { runQuitSteps, type QuitReport } from './quitTeardown';
import { NativeMemoryWiring, toUnpacked } from './nativeMemory/mainWiring';
import { CodexVersionLog, codexNoDaemonGate, readCodexVersion } from './codexCli';
import { codexLayerOptInKey, type CodexLayerNotice } from './codexProjectLayers';
import { StartupTiming } from './startupTiming';
import type { WorkerHandle } from './nativeMemory/service';
import { spawn, execFile } from 'node:child_process';
import {
  rmSync, existsSync, readFileSync, readdirSync, statSync, cpSync, writeFileSync,
  unlinkSync, mkdirSync, renameSync, createWriteStream, copyFileSync, lstatSync,
  readlinkSync, symlinkSync, appendFileSync, mkdtempSync
} from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join, resolve, sep, basename, dirname, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { runMemorySmoke, smokeTarget } from './nativeMemory/smoke';
import { benchTarget, runMemoryBenchHost } from './nativeMemory/bench';
import { request as httpsRequest } from 'node:https';
import { PtyManager, type SpawnOptions } from './pty';
import {
  DEV_ISOLATION, DEV_HIDDEN, DEV_ROOT_ENV, resolveDevDataRoot, fixedDevDataRoot, devPaths,
  stableForbiddenPaths, checkIsolation, devRootOverrideViolations, scrubInheritedEnv, devWindowTitle
} from './devIsolation';
import { isSafeCommandName } from './shellEnv';
import { resolveCommandAsync, invalidateCommandCache } from './commandResolver';
import { daemonExecutable, headlessSpawnRefusal, missingCliAction, npmRungDecision, toolRowStatus } from './cliLookupPolicy';
import { initAutoUpdater, abortPendingRestart } from './updater';
import { RealtimeFloorWatcher } from './realtimeFloorWatcher';
import { ProviderModelStore, defaultAdapters } from './providerModels';
import {
  readConfig, writeConfig, pruneRetiredConfigKeys, setAgentTokenCap, setAgentUsageDisplay, setCapacityDisplayThreshold, resetConfig, ensureHarnessHome, ensureClaudePermissionsAccepted,
  modelForHiveSpawn, takeClearedDefaultModel, configIntegrityIssue, OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, type HarnessConfig, type ScheduledMission
} from './config';
import { effectiveModel, modelFlagValue, resolveSpawnArgs } from '../shared/modelPin';
import { billedEquivalentTokens, rawTokens } from '../shared/tokenWeights';
import { createRendererErrorGate, normalizeRendererError } from '../shared/rendererError';
import {
  runStandupTick, projectTasks,
  type FloorState, type StandupDecision, type StandupSkipRecord
} from './standupDelta';
import { listDir, readFileText, readFileBinary, writeFileText, statAbs, expandTilde, samePath } from './fs';
import { normalizeWeekly, weeklyDelayMs } from '../shared/weeklySchedule';
import { isInputOrigin } from '../shared/inputOrigin';
import { automaticDeliveryEligibility, isTerminalInputState } from '../shared/inputProvenance';
import { isTerminalPromptState } from '../shared/promptState';
import { AutomaticSubmitOwner, ADMISSION_CLASSES, INTERFERENCE_RESOLUTIONS, capacityGateOf, type AdmissionClass, type CapacityGate, type InterferenceResolution } from './automaticSubmit';
import { buildOwnerDeps, ScreenReadingBroker } from './automaticSubmitWiring';
import { ScreenGuardNotices, StartupProbe, WakeIncarnationTokens, WAKE_INCARNATION_ENV } from './codexScreenGuard';
import type { ScreenGuardRecord } from './automaticSubmit';
import { ALERT_MB, installRendererRecovery, MEMORY_CAUSE_MS, performRecreate, recoverRendererForMemory, RendererProbe, saveRendererProfile, RecoveryPolicy, RendererMemorySampler, SAMPLE_MS, type RecoveryNotice } from './rendererRecovery';
import { KEEP_DUMPS, pruneDumps, startLocalCrashReporter, waitForDump } from './crashDumps';
import { createBootSubmitRowGate } from './bootSubmitLog';
import {
  getBranch, getStatus, getLog, getBranches, getAheadBehind, isRepo, getDiff, mainRepoRoot,
  addWorktree, removeWorktree, worktreeHasUnintegratedWork, worktreeIsGcSafe,
  getLogGraph, getCommitFiles, getFileAtRev, compareRefs, listWorktrees, checkoutRef
} from './git';
import { BoardMonitor } from './boardMonitor';
import { BoardStatusWriter } from './boardStatus';
import { FloorDigest, FLOOR_DIGEST_DEFAULTS, FLOOR_DIGEST_FILE } from './floorDigest';
import { HiveManager, archivedForMail, type AgentMeta, type ArchiveReason, type HiveMessage, type HiveTask } from './hive';
import { actionableBacklog, coordinatorPendingIds, fleetMailFields, ledgerInboxMessages, mailCoordinationAt } from './mailReaders';
import { HookServer } from './hooks';
import { HeavyJobLock, heavyLimit, probeProcesses } from './heavyJob';
import { CapacityProbeWatch, lastVisibleLine } from './capacityProbeWatch';
import { CapacityRuntime } from './capacityRuntime';
import { CapacityStore, capacityStorePath } from './capacityPersistence';
import type { CapacityNotifyIntent } from './capacityNotify';
import { CapacityStripPresenter } from './capacityStrip';
import { deliverCapacityToast, type CapacityToast } from './capacityToast';
import { AGENT_IMPACT_PUSH, agentImpactOf, capacityStateNote, type AgentImpact } from '../shared/deliveryHold';
import { AgentImpactPushGate, agentImpactPushOf } from './agentImpactPush';
import { capacityDetailView } from './capacityDetail';
import { CapacityDetailTicker } from './capacityDetailTick';
import { CAPACITY_DETAIL_CHANNEL, CAPACITY_DETAIL_CLOSED, CAPACITY_DETAIL_PUSH, validateCapacityDetail, type ProviderCapacityDetailView } from '../shared/capacityDetail';
import { AgentUsagePushGate, agentUsagePushOf, agentUsageView } from './capacityAgentUsage';
import { CAPACITY_AGENT_USAGE, CAPACITY_AGENT_USAGE_PUSH, validateAgentUsageView } from '../shared/agentUsage';
import { capacityDisplayThresholdOf } from '../shared/capacityThreshold';
import {
  CAPACITY_STRIP_CHANNEL, CAPACITY_STRIP_CURRENT, CAPACITY_NOTICE_DISMISS,
  type CapacityStripCollection, type NoticeDelivery
} from '../shared/capacityStrip';
import { CircuitBreaker, type BreakerInput } from './breaker';
import type { UsageProvider } from './usage';
import { KnowledgeManager } from './knowledge';
import { MemoryReflector, type ReflectSettings } from './reflect';
import { PersistStore } from './db';
import { mayReadClaudeTranscripts, readAgentUsage, readContextTokens, seedSessionTranscript, resolveSessionCwd, shouldRecordSampleSession, chooseResumeSession, sessionTranscriptPath } from './transcript';
import { godFreshStart, readClaudeVersion, type GodFreshReason } from './godStartup';
import { resumeDecision, type StaleReason } from './sessionRotation';
import { listIssues, listCIRuns } from './github';
import { SlackWebhookServer, SlackReplyServer, postSlackReply, type SlackEventFile } from './slack';
import {
  WebhookServer,
  type WebhookDispatch, type WebhookEndpointRef, type WebhookInbound, type WebhookTaskStatus
} from './webhook';
import {
  classifyInboundKind, isAutoAllowed,
  DEFAULT_CONTEXT_TRIGGER, DEFAULT_ORG_TRIGGER, DEFAULT_TRIGGER_MODE, DEFAULT_WEBHOOK_SCHEMA,
  type ContextRule, type ContextTriggerConfig, type InboundKind, type OrgTriggerConfig,
  type TriggerHistoryEntry, type TriggerMode, type WebhookTrigger
} from '../shared/triggers';
import {
  appendTriggerHistory, clearTriggerHistory, listTriggerHistory, updateTriggerHistory
} from './triggerHistory';
import { transcribeWithGroq, DEFAULT_GROQ_MODEL } from './freeflow';
import { registerRealtimeIpc } from './realtime';
import { registerRealtimeActionIpc } from './realtimeActions';
import { initCompletionWatcher } from './realtimeCompletionWatcher';
import type { TaskCard, InboxMessage } from './realtimeCompletionWatcher';
import { TelemetryCollector } from './telemetry';
import { CostLedgerTotals } from './costLifetime';
import { analytics } from './analytics';
import { IntegrationBroker } from './integrationBroker';
import * as integrations from './integrations';
import { validateBaseUrl, buildAuthHeaders, resolveUpstreamUrl, secretRefFor, INTEGRATION_TEMPLATES } from '../shared/integrations';
import { RosterStore } from './roster';
import { buildWorkerLaunch } from './workerLaunch';
import { ControlRegistry } from './control';
import { WorkerWakeWatchdog } from './workerWake';
import { HeldInterferenceWatch, HELD_TICK_MS } from './heldInterference';
import { CodexRolloutLifecycleSource } from './codexRolloutLifecycle';
import { AgentLivenessMonitor, type LivenessFacts } from './agentLiveness';
import { CODEX_ROTATE_MAX_ROLLOUT_BYTES, decideAgyRotation, decideThreadRotation, findAgyConversation, findCodexRollout, threadRotatedLogRow } from './codexThreadRotation';
import { HistoryService } from './historyService';
import { geminiHome } from './capacityScope';
import { InboxWakeBridge } from './inboxWakeBridge';
import { WakeStallWatch } from './wakeStall';
import { newBreadcrumbMemory, shouldLogBreadcrumb } from './wakeBreadcrumb';
import { forgetWakeRows, newWakeRowState, planWakeRow, takeFolded } from './wakeRowPolicy';
import { WakeTelemetry } from './wakeTelemetry';
import { inboxWakeTextForProvider } from '../shared/hiveNudge';
import { mailNudgeMode, type MailNudgeMode } from './mailSurface';
import { fetchHireManifest, readHireManifestFiles } from './hire';
import { parseHireDeepLink, type HireManifest } from '../shared/hire';
import { ClosingTimeController } from './closingTime';
import {
  argsWithAutoModeFlag,
  inferAgentProvider,
  isClaudeProvider,
  nonInteractiveEnvForProvider,
  providerPreset,
  installInfoForProvider,
  type AgentProvider
} from '../shared/agentProvider';
import { buildMissingCliScript, chooseInstallRung } from './cliInstall';
import { detectNodeVersion, nodeIsUsable, resolveNodeInstaller } from './nodeInstall';
import { toolCatalog, type ToolStatus } from '../shared/toolCatalog';
import { listLocalSkills, loadCatalog, installSkill, uninstallSkill, type LocalSkill } from './skills';
import { loadHero } from './hero';
import {
  CODEX_REMOTE_SOCKET_RELATIVE,
  codexRemoteAliasPath,
  codexRemoteEndpoint,
  codexRemoteSocketFits,
  withCodexRemoteArgs
} from '../shared/codexRemote';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// ─── MUNDER_DEV=1: development isolation bootstrap (see devIsolation.ts) ──────
// MUST run before `app.requestSingleInstanceLock()` below (Electron keys the
// lock on userData) and before anything reads `app.getPath('userData')`, so it
// sits here, immediately after the imports. Inert unless MUNDER_DEV=1.
/** Stable-owned paths the ready-time guard re-checks against LIVE values. */
let devStableForbidden: string[] = [];
if (DEV_ISOLATION) {
  // Electron's default userData is derived from the package name — i.e. it IS
  // Stable's folder. Capture it (read-only) before overriding, both to forbid it
  // and to learn Stable's harnessHome from its config.json if readable.
  const stableUserData = app.getPath('userData');
  let stableHome: string | null = null;
  try {
    const raw = JSON.parse(readFileSync(join(stableUserData, 'config.json'), 'utf8')) as { harnessHome?: unknown };
    if (typeof raw.harnessHome === 'string') stableHome = raw.harnessHome;
  } catch { /* no Stable config readable — the literal list still applies */ }
  // MUNDER_DEV_ROOT (layer-b test infrastructure): the one validated relocation of the
  // whole root. A refused value EXITS here; it never falls back to the fixed root.
  const rootRes = resolveDevDataRoot({ liveUserData: stableUserData });
  if (!rootRes.ok) {
    console.error(`[dev-isolation] REFUSING TO START — ${DEV_ROOT_ENV}="${rootRes.value}" ${rootRes.reason}`);
    process.exit(97);
  }
  const root = rootRes.root;
  const paths = devPaths(root);
  devStableForbidden = stableForbiddenPaths({ defaultUserData: stableUserData, stableHarnessHome: stableHome });
  // An overridden root must not collide with the FIXED dev root either (its data, its
  // pipe, its single-instance lock under its userData): forbid it from here on too, so
  // the ready-time live check below re-verifies against it.
  if (rootRes.override) devStableForbidden.push(fixedDevDataRoot());
  const violations = [
    ...checkIsolation(paths, devStableForbidden),
    ...(rootRes.override ? devRootOverrideViolations(paths) : [])
  ];
  if (violations.length) {
    console.error('[dev-isolation] REFUSING TO START — resolved dev paths overlap Stable:\n  ' + violations.join('\n  '));
    process.exit(97);
  }
  // Electron documents that setPath targets must exist — create every one first.
  const logsDir = join(paths.userData, 'logs');
  const crashDir = join(paths.userData, 'crashDumps');
  const tempDir = join(paths.userData, 'temp');
  for (const d of [paths.userData, logsDir, crashDir, tempDir]) mkdirSync(d, { recursive: true });
  // Distinct app identity. `app.setName` only changes Electron's INTERNAL name
  // (default path derivation) — it does not change Windows shell identity. The
  // AppUserModelID is what the taskbar and toast notifications key on, so the
  // dev build gets its own (Stable's packaged one is electron-builder's
  // `appId: in.munderdiffl.app`; a bare electron.exe run otherwise carries
  // Electron's default). Validation of taskbar/toast identity: Andy item.
  app.setName('munder-difflin-dev');
  app.setAppUserModelId('in.munderdiffl.app.dev');
  app.setPath('userData', paths.userData);
  app.setPath('sessionData', paths.userData);
  app.setPath('logs', logsDir);
  app.setPath('crashDumps', crashDir);
  // `temp` feeds the paste-drop dir (join(app.getPath('temp'), 'cth-pastes'));
  // keep even that out of the shared %TEMP% so Dev never touches a Stable file.
  app.setPath('temp', tempDir);
  const scrubbed = scrubInheritedEnv(process.env);
  console.warn(
    `[dev-isolation] MUNDER_DEV=1 — userData=${paths.userData} harnessHome=${paths.harnessHome} pipe=${paths.pipeName}` +
    (rootRes.override ? ` (root from ${DEV_ROOT_ENV})` : '') + (DEV_HIDDEN ? ' (hidden run: no window is shown)' : '') +
    (scrubbed.length ? ` (scrubbed inherited Stable env: ${scrubbed.join(', ')})` : '')
  );
}

// NATIVE-MEMORY gate-2 smoke (smoke.ts): `--native-memory-smoke=<result.json>` is a windowless
// self-test of the memory worker in a utility process. It must point userData at a fresh temp
// folder HERE, before anything reads it, so no config, hive or palace of the user's is opened;
// the ready handler then runs only the smoke and exits.
const memorySmokeOut = smokeTarget(process.argv);
// The speed-gate bench host (bench.ts): the same isolation as the smoke.
const memoryBenchDir = benchTarget(process.argv);
if (memorySmokeOut || memoryBenchDir) {
  const smokeUserData = mkdtempSync(join(tmpdir(), 'munder-smoke-userdata-'));
  app.setPath('userData', smokeUserData);
  app.setPath('sessionData', smokeUserData);
}

// RENDERER-RECOVERY-164 (the Human's final scope): LOCAL crash dumps, started as early as the
// userData/crashDumps paths are final (just above). uploadToServer:false, no submit URL: a
// renderer crash now leaves a minidump in app.getPath('crashDumps') instead of Crashpad's
// generic "not connected" exit (0xFFFF7003) and nothing. Its cost is marked in startup-timing.
const crashReporterStart = startLocalCrashReporter(crashReporter);

// Keep the main process alive on an unexpected throw/rejection. The harness is a
// multi-agent supervisor — a single stray throw (e.g. node-pty's ConPTY console
// helper choking when a fast-exiting agent CLI's console is already gone) must
// NOT take the whole app and every running agent down with it. Log and continue
// rather than letting the default handler exit the process.
// (Restored during the #71 merge — the PR's rebase dropped these handlers.)
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (kept alive):', reason);
});

const ptyManager = new PtyManager();

/**
 * MUNDER_HIDDEN (layer-b test infrastructure): the ONE place main shows, restores or focuses a
 * window. A hidden run never does any of it, so a window built show:false never appears and never
 * gets a taskbar button. Every caller says exactly what it wants; nothing is implied.
 */
function surfaceWindow(w: BrowserWindow | null | undefined, how: { show?: boolean; restore?: boolean; focus?: boolean }): void {
  if (DEV_HIDDEN) return;
  if (!w || w.isDestroyed()) return;
  if (how.restore && w.isMinimized()) w.restore();
  if (how.show) w.show();
  if (how.focus) w.focus();
}

function runCodexDaemonCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 20_000
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveResult) => {
    let settled = false;
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (e) {
      resolveResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let timer: NodeJS.Timeout;
    const finish = (result: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 8_000) stderr += String(chunk);
    });
    child.once('error', (e) => finish({ ok: false, error: e.message }));
    child.once('exit', (code) => {
      finish(code === 0
        ? { ok: true }
        : { ok: false, error: stderr.trim() || `Codex exited with code ${code ?? 'unknown'}` });
    });
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      finish({ ok: false, error: `Codex daemon command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}

/** Start/enable one managed remote-control daemon for this isolated Codex home,
 * then point the TUI at its app-server socket. Failure is non-fatal: the worker
 * still starts as a normal local Codex session. */
async function enableCodexRemoteForSpawn(
  opts: SpawnOptions & { hive?: AgentMeta },
  agentId: string
): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const realHome = opts.env?.CODEX_HOME;
  if (!realHome) return false;
  try {
    const alias = codexRemoteAliasPath(realHome, agentId);
    // Bail before touching the filesystem if even the short alias would exceed
    // sun_path — the daemon would start and then die on bind, and the warning
    // below names the real reason instead of a generic readiness timeout.
    if (!codexRemoteSocketFits(alias)) {
      console.warn('[codex-remote] socket path exceeds sun_path; starting local TUI:', alias);
      return false;
    }
    const aliasRoot = dirname(alias);
    mkdirSync(aliasRoot, { recursive: true });
    if (existsSync(alias)) {
      const st = lstatSync(alias);
      if (!st.isSymbolicLink() || resolve(dirname(alias), readlinkSync(alias)) !== resolve(realHome)) {
        console.warn('[codex-remote] short home alias is occupied; starting local TUI:', alias);
        return false;
      }
    } else {
      symlinkSync(realHome, alias, 'dir');
    }

    const socket = join(alias, CODEX_REMOTE_SOCKET_RELATIVE);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      CODEX_HOME: alias
    };
    // The shared async resolver (commandResolver.ts), the same one PtyManager spawns through;
    // the daemon just needs the best executable path.
    // RESOLVER-TIMEOUT-MISS: a lookup that gave no answer gives no executable to start a daemon with.
    const executable = daemonExecutable(await resolveCommandAsync(opts.command));
    if (executable === null) {
      console.warn('[codex-remote] the codex lookup gave no answer (machine under load); starting local TUI');
      return false;
    }
    const started = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'start'],
      env
    );
    if (!started.ok) {
      console.warn('[codex-remote] daemon start failed; starting local TUI:', started.error);
      return false;
    }
    const enabled = await runCodexDaemonCommand(
      executable,
      ['app-server', 'daemon', 'enable-remote-control'],
      env
    );
    if (!enabled.ok) {
      console.warn('[codex-remote] enable failed; starting local TUI:', enabled.error);
      return false;
    }
    if (!existsSync(socket)) {
      console.warn('[codex-remote] daemon returned without a control socket; starting local TUI');
      return false;
    }
    opts.env = { ...(opts.env ?? {}), CODEX_HOME: alias };
    opts.args = withCodexRemoteArgs(opts.args ?? [], codexRemoteEndpoint(alias));
    return true;
  } catch (e) {
    console.warn('[codex-remote] setup failed; starting local TUI:',
      e instanceof Error ? e.message : e);
    return false;
  }
}
/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
/** ptyId -> the provider resolved for it at spawn. The submit owner asks this for
 *  readiness and for abort capability; a PTY that is not in here is UNKNOWN to it. */
const ptyProvider = new Map<string, AgentProvider>();
/** PTY id → the spawn it should auto restart-and-continue into once a first-time
 *  CLI install finishes. The missing-CLI short-circuit runs the engine's installer
 *  in this PTY; when it exits cleanly the exit handler re-runs the SAME spawn (with
 *  install disabled) so the freshly-installed CLI launches in the SAME pty/window —
 *  no user click. Cleared the moment it's consumed, so it can never loop installs. */
const pendingInstallRelaunch = new Map<string, { opts: AgentSpawnOptions; owner: Electron.WebContents | null; bin: string }>();
const hive = new HiveManager(
  () => readConfig().harnessHome,
  (channel, payload) => {
    const wc = liveWebContents();
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  },
  {},
  // THE one place a hive is allowed to write the user's GLOBAL provider config
  // (~/.gemini hooks, ~/.grok hooks, the Antigravity statusLine). Read fresh from
  // config each time, so a home change takes effect without a restart; everywhere
  // else a HiveManager is constructed, the default refuses. See mayWriteGlobalConfig.
  (home) => samePath(home, readConfig().harnessHome)
);
/** ZT-I3 §3.2-3.3: the board monitor (stale flags + the one explicit-archive auto-move). It
 *  re-runs on every applied ledger change, and on its own 60 s tick. */
const boardMonitor = new BoardMonitor({
  hive,
  // The liveness join (Jim, god ab966e): the monitor reads Dwight's records in process.
  // agentLiveness is declared below; this runs only when the monitor ticks, after start.
  getLiveness: (id) => agentLiveness.getLiveness(id),
  cfg: () => readConfig().floorDigest ?? {},
  // A flag appeared or cleared: re-render board-status.md and re-run the digest (which wakes
  // god only for a NEW decision item, batched).
  onFlags: () => {
    boardStatus.request();
    try { floorDigest.run(); } catch (e) { console.error('[floor-digest]', e); }
  }
});
/** ZT-I3 §3.5: hive/board-status.md, rendered (never hand-kept). */
const boardStatus = new BoardStatusWriter({
  root: () => hive.root(),
  tasks: () => hive.tasks(),
  taskMeta: () => hive.ledgerGuard.taskMeta().cards,
  flags: () => boardMonitor.flags()
});
/** ZT-I4: the floor digest (hive/floor-digest.md) and the decision-only wake of god. */
const floorDigest = new FloorDigest({
  root: () => hive.root(),
  tasks: () => hive.tasks(),
  taskMeta: () => hive.ledgerGuard.taskMeta().cards,
  flags: () => boardMonitor.flags(),
  ledgerIssues: () => hive.ledgerGuard.issues(),
  // DWIGHT-HELD-INTERFERED fix 2: a held wake the Human was told about is a decision for god.
  heldWakes: () => (heldInterference?.noticed() ?? []).map((h) => ({ agentId: h.agentId, name: agentDisplayName(h.agentId), messages: h.messages, since: h.since })),
  send: (msg, from) => { hive.send(msg, from); },
  appendLog: (row) => hive.appendLog(row)
}, () => ({ ...FLOOR_DIGEST_DEFAULTS, ...(readConfig().floorDigest ?? {}) }));
// DWIGHT-HELD-INTERFERED-2028: built once the wake bridge exists (below).
let heldInterference: HeldInterferenceWatch | null = null;
hive.ledgerGuard.onChange(() => {
  try { boardMonitor.tick(); } catch (e) { console.error('[board-monitor]', e); }
  boardStatus.request();
});
// #7C — operator control state (pause/gate/steer/halt), read by the HookServer
// when deciding hook returns.
const control = new ControlRegistry();
// Stage 7A — the live observability tap. Receives Claude Code's first-party OTel
// over loopback OTLP/JSON and exposes the locked usage-provider seam. resolveCwd
// lets the transcript fallback find an agent's cwd from the hive registry.
const telemetry = new TelemetryCollector({
  emit: (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  resolveCwd: (agentId) => hive.registry().agents[agentId]?.cwd ?? null,
  // D11: scopes the transcript fallback to this agent's own session instead of
  // summing every transcript in a (routinely shared) cwd.
  resolveSessionId: (agentId) => hive.lastSession(agentId),
  // START-FIXES-163 (2): the fallback reads Claude transcripts for Claude agents only.
  // A registry entry with no provider is a legacy Claude agent (the spawn path's
  // own `?? 'claude'`); an unknown agent has no provider and reads nothing.
  resolveProvider: (agentId) => {
    const a = hive.registry().agents[agentId];
    return a ? (a.provider ?? 'claude') : undefined;
  },
  // SESSION-CROSSWIRE: usage, spans and the sampled resume key follow the agent whose
  // own hooks reported a session, not the OTel agent.id label. Memoised for 1 s: OTLP
  // batches arrive every few seconds per agent and each would otherwise re-read the registry.
  resolveSessionOwners: (() => {
    let at = 0; let owners: ReadonlyMap<string, string> = new Map();
    return () => {
      const now = Date.now();
      if (now - at > 1000) { owners = hive.hookSessionOwners(); at = now; }
      return owners;
    };
  })()
});
// Usage provider (Seam 1) — the INTEGRATION swap: Oscar's telemetry collector (#7)
// IS the provider, replacing Lane A's interim StubUsageProvider. Same
// getAgentUsage(agentId) pull seam, so the breaker + cost ledger consumers are
// untouched; telemetry has a transcript fallback built in, so it works before any
// live OTel arrives.
const usageProvider: UsageProvider = telemetry;
// Circuit breaker (Lane A #6.6b) — the REAL policy (replaces Lane C's interim
// glue). POLICY only; the heartbeat beat feeds it signals (via usageProvider) +
// enforces its decisions. Config read live so a settings change applies next beat.
const breaker = new CircuitBreaker(() => {
  const c = readConfig();
  return {
    ...(c.circuitBreaker ?? {}), costCapUsd: c.costCapUsd, costCapTokens: c.costCapTokens, agentTokenCaps: c.agentTokenCaps,
    agentUsageDisplay: c.agentUsageDisplay
  };
});
// Always-on beats (decoupled from the optional heartbeat): the live fleet snapshot
// Michael reads + the breaker beat, so guardrails + monitoring work even when the
// heartbeat mission is disabled (it ships off).
let fleetTimer: ReturnType<typeof setInterval> | null = null;
let breakerBeatTimer: ReturnType<typeof setInterval> | null = null;
// Feed the breaker's api_error-storm trip from Oscar's OTel api_error spans —
// Jim's one breaker input with no on-branch source (telemetry.onApiError seam).
telemetry.onApiError((agentId) => breaker.recordError(agentId));
// Shared roster on disk — created early so HookServer can re-read standing goals
// on every UserPromptSubmit (Edit Agent saves land here via persistAgents).
const roster = new RosterStore(() => readConfig().harnessHome);
function standingGoalFromRoster(agentId: string): string | null {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as { id?: unknown; goal?: unknown };
    if (a.id !== agentId) continue;
    return typeof a.goal === 'string' && a.goal.trim() ? a.goal.trim() : null;
  }
  return null;
}
// Inbox-wake coordinator (pre-M1 event-wake bridge; was the #151 worker watchdog). EVERY
// agent, god included, is woken the same way: a durable delivery, a lifecycle or control
// release edge, or the reconciliation beat asks `inboxWake.requestInboxWake`, which
// claims one batch here and submits it through the one owner (CAPACITY_GATED). HookServer
// feeds it the hook stream, so a permission/HITL prompt blocks wakes.
const workerWake = new WorkerWakeWatchdog();
// FALSEACTIVE-STALL-2 (B1): Codex's own turn boundaries, read from a bounded rollout tail.
const codexLifecycle = new CodexRolloutLifecycleSource();
// ─── DIAGNOSIS ONLY (branch diag-1.1.46-wake) ───────────────────────────────
// The 1.1.46 packaged canary produced no wakes and could not say why, because every
// breadcrumb on the wake path is console.log and a packaged Windows Electron app has
// no console attached and no file sink: the output is discarded. These write to the
// hive event log instead, which agents and the human already read, so ONE canary run
// says which stage is inert. Remove with this branch.
const wakeDiagSeen = newBreadcrumbMemory();
// LOG-STALL-AV F3: event-path wake rows are logged on EDGES only (wakeRowPolicy.ts); the folded
// ones are counted into one `wake-folded` row per minute.
const wakeRows = newWakeRowState();
let wakeFoldedMinute = Math.floor(Date.now() / 60_000);
// WAKE TELEMETRY (D8). Observability only — it counts, it never decides, and the wake path
// never reads it. See wakeTelemetry.ts.
const wakeTelemetry = new WakeTelemetry(Date.now());

// THE STALL WATCHDOG (god's ruling A2). Decision in wakeStall.ts; this is the voice.
const wakeStalls = new WakeStallWatch();

// ZERO-TOKEN-LIVENESS (1.1.77): the deterministic liveness monitor. It observes the facts below and
// publishes liveness-v1 records (log rows on edges, fleet.json, getLiveness / onLivenessChange). It
// never calls a model, types, submits, wakes, restarts or edits the board (agentLiveness.ts).
/** The registry read once for a whole sampleAll (one file read per beat, not one per agent). */
let livenessRegistry: ReturnType<typeof hive.registry> | null = null;
function livenessFactsFor(agentId: string): LivenessFacts | null {
  const reg = livenessRegistry ?? hive.registry();
  const a = reg.agents?.[agentId];
  if (!a) return null;
  const ptyId = ptyForAgent(agentId);
  const pf = ptyId ? ptyManager.livenessFacts(ptyId) : undefined;
  const snap = control.snapshot(agentId);
  const wake = workerWake.livenessFacts(agentId);
  let rollout: LivenessFacts['rollout'];
  // The rollout matters only while a turn may be open (an idle agent's Stop was recorded): the probe
  // walks the session folders synchronously, so an idle Codex agent is not probed every beat.
  if (pf && a.provider === 'codex' && wake.lifecycle !== 'idle') {
    // The same mtime-cached bounded tail the WWR reads (re-read only when the file changed).
    const home = hive.codexHomeFor(agentId);
    const probe = home ? codexLifecycle.probe(home) : undefined;
    rollout = probe && probe.ok ? probe.latest : undefined;
  }
  let mailWaiting = 0;
  if (ptyId) { try { mailWaiting = mailPendingIds(agentId).length; } catch { mailWaiting = 0; } }
  return {
    agentId,
    registry: {
      archived: a.archived === true,
      ...(a.archived === true && a.archiveReason ? { archiveReason: a.archiveReason } : {}),
      // setArchived stamps lastSeen in the same write that sets the flag.
      ...(a.archived === true && typeof a.lastSeen === 'number' ? { archivedAt: a.lastSeen } : {}),
      onHold: !!a.onHold
    },
    pty: ptyId && pf ? { ptyId, incarnation: pf.incarnation, spawnedAt: pf.spawnedAt, lastTrafficAt: pf.lastTrafficAt } : null,
    wake,
    control: { paused: snap.paused, halted: snap.halted, autoDeliveryPaused: snap.autoDeliveryPaused },
    mailWaiting,
    ...(rollout !== undefined ? { rollout } : {})
  };
}
const agentLiveness = new AgentLivenessMonitor({
  agents: () => Object.keys((livenessRegistry ?? hive.registry()).agents ?? {}),
  facts: (agentId) => livenessFactsFor(agentId),
  sink: (row) => { try { hive.appendLog(row); } catch { /* best-effort */ } },
  now: () => Date.now()
});
// Dwight F2: a registry archive/restore is an evidence edge, sampled at once (not at the next beat).
// The registry has no agent-delete path; an agent that leaves it is seen DELETED by the beat.
hive.onArchiveChange((agentId) => { sampleLiveness(agentId); });
agentLiveness.onLivenessChange((rec) => {
  try { liveWebContents()?.send('liveness:changed', rec); } catch { /* window torn down */ }
});
/** Recompute every agent's liveness (the 15-second beat), over one registry read. */
function sampleLivenessAll(): void {
  if (!hive.enabled()) return;
  try {
    livenessRegistry = hive.registry();
    agentLiveness.sampleAll();
  } catch (e) {
    console.error('[liveness] sample failed:', e);
  } finally {
    livenessRegistry = null;
  }
}
/** Hook events that are turn boundaries: each re-samples the agent at once. */
const LIVENESS_EDGE_HOOKS = new Set(['Stop', 'StopFailure', 'UserPromptSubmit', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'Notification']);
/** Recompute one agent on an evidence edge (best-effort, never throws). */
function sampleLiveness(agentId: string | undefined): void {
  if (!agentId || !hive.enabled()) return;
  try { agentLiveness.sample(agentId); } catch { /* best-effort */ }
}
/** The HookServer observer, unchanged, followed by a liveness re-sample on a turn boundary (tool
 *  events wait for the beat). Observation only. */
function withLivenessEdge(
  observe: (agentId: string | undefined, event: string | undefined, message: string | undefined, fullyIdle?: boolean, turnId?: string, source?: string) => void
): typeof observe {
  return (agentId, event, message, fullyIdle, turnId, source) => {
    observe(agentId, event, message, fullyIdle, turnId, source);
    if (event && LIVENESS_EDGE_HOOKS.has(event)) sampleLiveness(agentId);
  };
}

/** Fold one refusal into the stall watch and say so, once, if it is a deadlock. */
function noteWakeRefusal(agentId: string, why: string, inboxIds: number): void {
  const stall = wakeStalls.note(agentId, why, inboxIds, Date.now());
  // ZERO-TOKEN-LIVENESS: refusal evidence (when mail waits), and the run the stall watch is timing.
  if (inboxIds > 0 && why !== 'no-pending-ids') {
    const run = wakeStalls.watchingFor(agentId);
    agentLiveness.noteWakeRefusal(agentId, Date.now(), run?.since);
    if (!run) agentLiveness.clearWakeRefusal(agentId);
  }
  if (!stall) return;
  // Loud, durable, and it NAMES THE GUARD — the one thing the 1.1.46 post-mortem could
  // not get out of the running app.
  console.error(`[inbox-wake] STALL ${stall.agentId}: ${stall.inboxIds} message(s) undrained, refused as "${stall.why}" for ${Math.round(stall.stalledMs / 60000)}m`);
  wakeDiag('stall', { agentId: stall.agentId, why: stall.why, inboxIds: stall.inboxIds, stalledMs: stall.stalledMs });
}

function wakeDiag(stage: string, fields: Record<string, unknown>): void {
  // Counted FIRST, before the de-duplication below: the reconcile rows the log folds away
  // are exactly the ones a stall is made of, so the counters must see every one.
  try { wakeTelemetry.note(stage, fields, Date.now()); } catch { /* telemetry never decides */ }
  try {
    // The reconciliation cadences repeat every stage for every agent. Log one line per
    // CHANGE there, so a 15-minute canary stays readable while every real transition is
    // still captured. Event-path lines always log. The decision — and the reason the
    // version of it that shipped in 1.1.48 suppressed nothing at all — is in
    // wakeBreadcrumb.ts; this is only the voice.
    if (!shouldLogBreadcrumb(wakeDiagSeen, stage, fields)) return;
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== wakeFoldedMinute) {
      const counts = takeFolded(wakeRows);
      if (counts) hive.appendLog({ kind: 'wake-folded', minute: wakeFoldedMinute, counts });
      wakeFoldedMinute = minute;
    }
    const row = planWakeRow(wakeRows, stage, fields);
    if (row) hive.appendLog({ kind: 'wake', stage, ...row });
  } catch { /* the diagnosis must never break the path it is watching */ }
}

/** Built once the submit owner exists (below); null only during module start-up. */
let inboxWake: InboxWakeBridge | null = null;
// HookServer needs BOTH: Oscar's control registry (HITL pause/gate/steer/halt via
// hook returns) AND Jim's breaker (feed recordToolUse on each PostToolUse).
// L0 — provider allowance, keyed by provider-account/limit identity. Fed from
// sources that already exist (the Claude status-line tick below; Codex rollout
// events), never by polling a provider.
//
// The runtime owns the three parts together: it evaluates on a single timer armed
// at the next instant a projection can change (never a poll), decides transitions
// against the previous collection, and answers the admission question below. UI is
// still a separate card.
//
// v1.1.45 unit #1: the DISPLAY projection. The presenter is downstream of every
// decision above - it reads the collection after each publication and pushes a
// display-ready, pool-level object on its own channel (never on control:snapshot).
// v1.1.45 unit #8: the C2.8 threshold, from config. Loaded on first use (not at module
// load, which can precede the Dev-isolated userData path) and then held here, so the strip
// does not read the config file on every capacity event; the setter below updates it.
let capacityDisplayThreshold: number | null = null;
const capacityThresholdNow = (): number =>
  (capacityDisplayThreshold ??= capacityDisplayThresholdOf(readConfig()));
const capacityStrip = new CapacityStripPresenter({ weeklyThreshold: capacityThresholdNow });
// PROBE-REISSUE (B): when each agent's hooks last reported anything, and the watch that logs a
// post-reset probe which produced no turn (with the terminal's last visible line).
const hookSeenAt = new Map<string, number>();
const capacityProbeWatch = new CapacityProbeWatch({
  now: () => Date.now(),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  lastHookAt: (agentId) => hookSeenAt.get(agentId),
  tailLine: (agentId) => { const id = ptyForAgent(agentId); const raw = id ? ptyManager.tail(id) : undefined; return raw ? lastVisibleLine(raw) : null; },
  idleMs: (agentId) => { const id = ptyForAgent(agentId); return id ? ptyManager.idleFor(id) : undefined; },
  log: (row) => { try { hive.appendLog(row); } catch { /* best-effort */ } }
});
const providerCapacity = new CapacityRuntime({
  deliver: (intents) => {
    for (const intent of intents) {
      console.log(`[capacity] ${intent.kind} ${intent.poolKey} ${intent.from}->${intent.to} (${intent.stateReason})`);
      // §13 (unit #7): the presenter says whether and how this transition toasts; the
      // delivery outcome (incl. STRIP_ONLY for the ones that do not) is recorded on the notice.
      capacityStrip.noteIntent(intent, capacityToast(capacityStrip.toastFor(intent, providerCapacity.tracker.pool(intent.poolKey))));
    }
  },
  // v1.1.46 integration: ONE onChange carries both followers - the CRIT-15-PRE impact push
  // and the inbox-wake retry HINT (admission decides; the hint never submits by itself).
  onChange: () => { pushCapacityStrip(); pushAgentUsage(); pushAgentImpact(); inboxWake?.onCapacityChange(); },
  onAdmission: () => pushAgentImpact(),
  // CAPACITY-DUP-CONFIRM-163: which pool an agent was bound to, and when (or a skipped bind).
  log: (row) => { try { hive.appendLog(row); } catch { /* best-effort */ } },
  onProbeLaunched: (probe) => capacityProbeWatch.launched(probe)
});
// L0-FUSION stage 5 - THE ONE OWNER of programmatic stage -> final revalidation -> Enter.
// Main resolves the PTY, main holds it against other programmatic writers, and main's
// final check sits next to main's Enter with nothing that can yield between them. See
// automaticSubmit.ts for the transaction and automaticSubmitWiring.ts for what each of
// its effects means here.
const screenReadings = new ScreenReadingBroker((ptyId, requestId, needle, expectedTail, codex) =>
  ptyManager.sendToOwner(ptyId, 'autoSubmit:readScreen', { requestId, ptyId, needle, expectedTail, ...(codex ? { codex: true } : {}) }));
// WAKE-SCREEN-GUARD: R2-4's per-incarnation tokens, and the F5 watch (codexScreenGuard.ts).
const wakeIncarnationTokens = new WakeIncarnationTokens();
// WSG-ALERT-NOT-DISMISSABLE: the alert is raised AND lifted here (an ok reading, a latch, a respawn).
const screenGuardNotices = new ScreenGuardNotices({
  raise: (a) => {
    console.error(`[auto-submit] SCREEN GUARD ${a.agentId}: refused for ${Math.round(a.refusedMs / 60000)}m (${a.reason})`);
    hive.mail.noteScreenGuardAlert(a.agentId, a.reason, a.refusedMs, a.refusals, agentDisplayName(a.agentId), Date.now());
  },
  clear: (agentId) => hive.mail.clearScreenGuardAlert(agentId)
});
/** The name a person knows the agent by, for the alert's wording. */
function agentDisplayName(agentId: string): string {
  try {
    const name = hive.registry().agents[agentId]?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : agentId;
  } catch { return agentId; }
}
const screenGuardLastReason = new Map<string, string>();
/** One Codex screen-gate evaluation: a refusal row when the reason CHANGES for the agent (the
 *  wake beat repeats every refusal), and the alert when a run of refusals lasts. */
function noteScreenGuard(r: ScreenGuardRecord): void {
  try {
    const key = `${r.agentId}|${r.phase}`;
    if (!r.ok && screenGuardLastReason.get(key) !== r.reason) {
      hive.appendLog({
        kind: 'wake-screen-guard', agentId: r.agentId, ptyId: r.ptyId, requestId: r.requestId,
        provider: 'codex', admissionClass: r.admissionClass, phase: r.phase, reason: r.reason,
        incarnation: typeof r.incarnation === 'number' ? r.incarnation : null,
        observedGeneration: r.observedGeneration, currentGeneration: r.currentGeneration, latched: r.latched,
        // DWIGHT-HELD-INTERFERED fix 4: what a COMMIT refusal saw.
        ...(r.screen ? { screen: r.screen } : {})
      });
    }
    if (r.ok) screenGuardLastReason.delete(key); else screenGuardLastReason.set(key, r.reason);
    // Only automatic starts are waited on; a boot prompt or send-now has its own caller. Any
    // admission lifts the hold and its notice.
    screenGuardNotices.reading(r.agentId, r.ok, r.reason, r.admissionClass === 'CAPACITY_GATED', Date.now());
  } catch { /* diagnostics never decide */ }
}
const automaticSubmit = new AutomaticSubmitOwner(buildOwnerDeps({
  pty: ptyManager,
  capacity: providerCapacity,
  ptyForAgent: (agentId) => ptyForAgent(agentId),
  providerForPty: (ptyId) => ptyProvider.get(ptyId),
  requestScreenReading: (ptyId, needle, expectedTail) => screenReadings.request(ptyId, needle, expectedTail),
  // WAKE-SCREEN-GUARD: the Codex screen facts, and every gate evaluation's diagnostics.
  requestCodexScreen: (ptyId, expectedTail) => screenReadings.request(ptyId, '', expectedTail, true),
  onScreenGuard: (r) => noteScreenGuard(r),
  // DWIGHT-HELD-INTERFERED fix 4: every INTERFERED hold, with the last screen facts seen.
  onInterfered: (r) => {
    try {
      hive.appendLog({
        kind: 'wake-interfered', agentId: r.agentId, ptyId: r.ptyId, requestId: r.requestId, admissionClass: r.admissionClass,
        reason: r.reason, ...(r.detail ? { detail: r.detail.slice(0, 200) } : {}), screen: r.screen, screenAgeMs: r.screenAgeMs, needle: r.needle
      });
    } catch { /* logging only */ }
  },
  homeDir: () => homedir(),
  // START-FIXES-163 (3): every Enter the owner writes for a BOOT_SEQUENCE prompt, ok or
  // not, with the gap it waited. Logging only: it changes no submit behaviour.
  onEnterWrite: (r) => {
    if (r.admissionClass !== 'BOOT_SEQUENCE') return;
    hive.appendLog({
      kind: 'boot-submit', agentId: r.agentId, requestId: r.requestId, attempt: null,
      outcome: 'ENTER_WRITE', ok: r.ok, reason: r.error ?? null, gapMs: r.gapMs, reentry: r.reentry
    });
  },
  onOutcome: (r) => {
    // An outcome can raise an INTERFERED hold or settle one: the impact string moves.
    pushAgentImpact();
    if (r.outcome.kind === 'COMMITTED') {
      if (r.admissionClass === 'BOOT_SEQUENCE') {
        console.log(`[boot-sequence] ${r.agentId} on ${r.ptyId ?? '-'}: COMMITTED`);
      }
      return;
    }
    const why = 'reason' in r.outcome ? r.outcome.reason : '';
    console.log(`[auto-submit] ${r.admissionClass} ${r.agentId} on ${r.ptyId ?? '-'}: ${r.outcome.kind} ${why}`);
  }
}));
// WSG-CODEX-STARTUP-NO-MARKER fix 1(a): read an un-latched Codex screen after each output burst
// (the first burst draws the session header), so condition 1 latches while the header exists,
// before a resize can erase it. Readings only add the latch; they never type or refuse.
const startupProbe = new StartupProbe({
  wanted: (ptyId) => automaticSubmit.startupProbeWanted(ptyId),
  probe: (ptyId) => automaticSubmit.observeStartup(ptyId).then((latched) => {
    const agentId = ptyToAgent.get(ptyId);
    if (latched && agentId) screenGuardNotices.latched(agentId);
  }),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
});
ptyManager.setOutputObserver((id) => startupProbe.output(id));
// Durable capacity observations (L0-TAIL). Restored BEFORE any live reading can
// arrive, so ordering resolves naturally: every live observation is newer than the
// one that crossed the restart and simply replaces it. `userData` is already the
// Dev-isolated root by this point, so F1 holds with nothing special done here.
// Restored pools are UNKNOWN/restored-unconfirmed, never the verdict they had.
const capacityStore = new CapacityStore(
  capacityStorePath(app.getPath('userData')),
  providerCapacity.tracker
);
{
  const restored = capacityStore.restore();
  if (restored) console.log(`[capacity] restored ${restored} pool(s) from the durable store as UNKNOWN/unconfirmed`);
}
// The one wake path (plan section 3). Registered before the router starts, so no durable
// delivery can land unobserved.
inboxWake = new InboxWakeBridge({
  coordinator: workerWake,
  // FALSEACTIVE-STALL-2 (B1): Codex's rollout closes a turn whose Stop was lost.
  codexTurnProbe: (agentId) => {
    const home = hive.codexHomeFor(agentId);
    return home ? codexLifecycle.probe(home) : undefined;
  },
  // CODEX-FALSEACTIVE-153: the providers whose own turn start reaches main (Claude and Codex
  // UserPromptSubmit, Codex task_started, AGY PreInvocation). Only for these is a COMMITTED
  // wake provisional until confirmed; any other provider keeps "active until Stop".
  confirmsTurnStart: (agentId) => {
    const ptyId = ptyForAgent(agentId);
    const provider = ptyId ? ptyProvider.get(ptyId) : undefined;
    return provider === 'claude' || provider === 'codex' || provider === 'antigravity';
  },
  // ZT-I1-MAIL §3 #1: pending = the LEDGER's delivered ids (files on disk imply nothing), minus
  // bodies that are in neither inbox/ nor .done/ (Q13: shown loudly, never a wake loop). The
  // 1.1.74 file listing stays for the providers whose own file moves mean "handled" (cursor,
  // §11.7), and when the hive has no ledger. Work-order agents: none (god 1c7544, handoffs).
  inboxIds: (agentId) => mailPendingIds(agentId),
  mail: {
    mode: (agentId) => hookServer.mailChannel(agentId).mode,
    closeTurn: (agentId, turnId) => { hookServer.closeMailTurn(agentId, turnId); },
    abortSince: (agentId, since, reason) => { hookServer.abortMailEpochsSince(agentId, since, reason ?? 'submit-unconfirmed'); },
    closeStale: (agentId, now) => hookServer.closeStaleMailEpochs(agentId, now),
    hasOpenEpoch: (agentId) => hive.mail.openEpochs(agentId).length > 0,
    // Layer-b dry run #4: N1-due ids get one extra immediate re-offer; open (surfacing/surfaced)
    // ids keep their re-offer state across a reconcile beat.
    n1DueIds: (agentId) => hive.mail.n1Due(agentId),
    openIds: (agentId) => hive.mail.openNotDelivered(agentId),
    // §11.18 #42 (Q39): a Codex agent's running session cannot be told (its wake is the fixed
    // sentinel), so its alert says to respawn it.
    degrade: (agentId, reason, detail) => hive.mail.degradeChannel(agentId, reason, detail, { respawnToRestore: hive.registry().agents[agentId]?.provider === 'codex' }),
    // §11.18 #41 (Q38): the `mail-repend` row of a turn end whose start was never confirmed.
    log: (row) => hive.appendLog(row)
  },
  facts: (agentId) => {
    const ptyId = ptyForAgent(agentId);
    if (!ptyId) return null;
    const snap = control.snapshot(agentId);
    return {
      ptyId,
      lastOutputAt: ptyManager.lastOutputAt(ptyId) ?? 0,
      autoDeliveryPaused: snap.autoDeliveryPaused,
      paused: snap.paused,
      halted: snap.halted,
      inhibited: automaticSubmit.inhibition(ptyId) !== null
    };
  },
  // L0-FUSION stage 5: a wake starts a provider turn nobody asked for in this moment, so
  // it is CAPACITY_GATED work through the one submit owner - admission, the READY gate,
  // the prompt and human-draft guards, the final revalidation next to the Enter.
  submit: (req) => automaticSubmit.submit(req),
  // ZT-I1-MAIL §5 P4 / §11.7: the nudge follows the agent's mail mode (inject: "delivered in
  // context"; legacy-read: read, no move; no Stop signal: the 1.1.74 read-and-move text).
  text: (ids, agentId) => inboxWakeTextForProvider(agentId ? hive.registry().agents[agentId]?.provider : undefined, [...ids], agentId ? wakeMailMode(agentId) : 'inject'),
  setImmediate: (fn) => { setImmediate(fn); },
  now: () => Date.now(),
  log: (line) => console.log(line),
  diag: (stage, fields) => {
    wakeDiag(stage, fields);
    // The watchdog sees EVERY refusal, not only the ones the log keeps: the sink folds
    // repeated reconcile rows together, and a stall is made of exactly those repeats.
    if (stage === 'no-claim') {
      noteWakeRefusal(String(fields.agentId ?? ''), String(fields.why ?? ''), Number(fields.inboxIds ?? 0));
    } else if (stage === 'claim') {
      wakeStalls.clear(String(fields.agentId ?? ''));   // it moved; nothing is stuck
      agentLiveness.clearWakeRefusal(String(fields.agentId ?? ''));
    }
  },
  // ZERO-TOKEN-LIVENESS: the WWR tells the monitor BEFORE it recovers (or gives up), so the
  // STUCK_WAKE row is written first. Observation only.
  liveness: { stuckWake: (agentId, reason) => { agentLiveness.noteStuckWake(agentId, reason); } }
});
wakeDiag('bridge-built', { ok: !!inboxWake });

// DWIGHT-HELD-INTERFERED-2028 fixes 1 and 2 (heldInterference.ts): a held INTERFERED WAKE is looked
// at again about once a minute (the owner decides, on positive screen evidence only), and the
// Human is told after HELD_NOTICE_AFTER_MS. A person's queued message is never re-examined here.
heldInterference = new HeldInterferenceWatch({
  heldWakes: () => workerWake.heldClaims().flatMap(({ agentId, claim }) => {
    const ptyId = ptyForAgent(agentId);
    const inh = ptyId ? automaticSubmit.inhibition(ptyId) : null;
    return ptyId && inh && inh.requestId === claim.requestId
      ? [{ agentId, requestId: claim.requestId, ptyId, messages: claim.ids.length, since: inh.at, reason: inh.reason }]
      : [];
  }),
  recheck: (h) => automaticSubmit.recheckHeld(h.ptyId, h.requestId),
  released: (h, r, now) => {
    try {
      hive.appendLog({ kind: 'interference-self-released', agentId: h.agentId, requestId: h.requestId, how: r.kind === 'ERASED' ? 'erased-own-text' : 'empty-composer', reason: h.reason, heldMs: now - h.since, screen: r.screen });
    } catch { /* logging only */ }
    pushAgentImpact();
    // The same ruling as a person's "let it retry": the ids go back through every gate.
    inboxWake?.onInterferenceResolved(h.agentId, 'SEND_AGAIN');
  },
  notice: {
    raise: (h, now, asking) => hive.mail.noteHeldInterferedAlert(h.agentId, {
      name: agentDisplayName(h.agentId), messages: h.messages, at: h.since, reason: h.reason, requestId: h.requestId, asking,
      wakeText: inboxWakeTextForProvider(hive.registry().agents[h.agentId]?.provider, [], wakeMailMode(h.agentId))
    }, now),
    clear: (agentId) => hive.mail.clearHeldInterferedAlert(agentId)
  },
  log: (row) => hive.appendLog(row),
  now: () => Date.now()
});

/** ZT-I1-MAIL §5 / §11.7: the mail mode an agent's wake text follows (mailNudgeMode). */
function wakeMailMode(agentId: string): MailNudgeMode {
  const mode = hookServer.mailChannel(agentId).mode;
  let override = null;
  try { override = hive.mail.channelOverride(agentId); } catch { override = null; }
  // Creed Q27: a degraded agent's nudge says the channel is degraded and what to do instead.
  return mailNudgeMode(mode, override);
}

/** ZT-I1-MAIL §3 #1: the wake coordinator's pending source (see the bridge's `inboxIds`), and
 *  the renderer queue's precondition (#16). The rule itself is coordinatorPendingIds (tested). */
function mailPendingIds(agentId: string): string[] {
  return coordinatorPendingIds(agentId, {
    mode: (a) => hookServer.mailChannel(a).mode,
    pending: (a) => hive.mail.pending(a),
    skipped: (a) => hookServer.mailSkippedIds(a),
    files: (a) => hive.inbox(a).map((m) => m.id)
  });
}
hive.setDeliveryObserver(({ agentId, messageId }) => {
  // Proves the observer is registered AND that deliver() reached it, independently of
  // anything the bridge then decides.
  wakeDiag('observer', { agentId, messageId, bridge: !!inboxWake });
  inboxWake?.onDelivery(agentId, messageId);
});
// Only a RELEASE of a blocking state is a retry edge; applying pause/halt is not.
control.setTransitionObserver((agentId, transition) => {
  if (transition === 'UNPAUSED' || transition === 'RESUMED' || transition === 'AUTO_DELIVERY_RELEASED') {
    inboxWake?.onControlRelease(agentId);
  }
});
// WAKE-SCREEN-GUARD R2-4 (after the HookServer below exists): a Codex SessionStart of the LIVE
// incarnation latches it past startup - an extra proof; the screen reading is the usual one. A
// stale token does nothing.
function onWakeIncarnation(agentId: string, token: string): void {
  const proven = wakeIncarnationTokens.resolve(token, agentId, { ptyForAgent: (a) => ptyForAgent(a), incarnation: (p) => ptyManager.incarnation(p) });
  if (proven && automaticSubmit.latchPostHandoff(proven.ptyId, proven.incarnation)) screenGuardNotices.latched(agentId);
}
const hookServer = new HookServer(
  hive,
  () => liveWebContents(),
  () => readConfig(),
  control,
  breaker,
  standingGoalFromRoster,
  // Observed BEFORE the hook response; the bridge defers any retry with setImmediate, so
  // the Stop reply is never blocked and no turn is manufactured inside the hook.
  // ZERO-TOKEN-LIVENESS: after the bridge saw the hook, a turn boundary re-samples liveness.
  withLivenessEdge((agentId, event, message, fullyIdle, turnId, source) => { if (agentId) hookSeenAt.set(agentId, Date.now()); inboxWake?.onHook(agentId, event, message, fullyIdle, turnId, source); }),
  (agentId, obs) => { providerCapacity.ingest(agentId, obs); capacityStore.scheduleSave(); },
  // AGY 1.1.48 — ONE validated statusline tick, routed to its two consumers. Capacity
  // first: the allowance pair is a provider fact and is true for the account whether or
  // not any hive agent is behind the tick. Lifecycle second, and ONLY with an agent id —
  // a tick from the user's own `agy` session says nothing about a floor worker, and the
  // one thing it must never do is make somebody else's running turn look finished.
  (agentId, tick) => {
    providerCapacity.ingestAgyTick(agentId, {
      accountScope: tick.observations[0].accountScope,
      activeLimitId: tick.activeLimitId,
      observations: tick.observations
    });
    capacityStore.scheduleSave();
    if (!agentId) return;
    // tick.readAt, NOT the delivery time: arrival through one socket is monotone, so a
    // delivery time cannot show that one reading was taken before another (Jim, c4 audit).
    inboxWake?.onProviderStatus(agentId, tick.lifecycle, tick.sessionId, tick.readAt);
    // The renderer is TOLD the canonical status; it never re-derives one. Presentation
    // only — main remains the sole submission authority, so a renderer that misses this
    // push, or renders it late, cannot cause or prevent a single wake.
    liveWebContents()?.send('hive:providerStatus', { agentId, status: tick.lifecycle });
  }
);
hookServer.setWakeIncarnationObserver(onWakeIncarnation);
// HEAVY-JOB-SERIALIZE: the machine's heavy-job slots (Settings "Heavy jobs at once", read live).
// PreToolUse takes or denies a slot; a background job's slot is freed by a hidden process check
// that runs ONLY while a slot is held; PTY exit and a TTL free the rest. Holders go to fleet.json.
const heavyLock = new HeavyJobLock({
  limit: () => heavyLimit(readConfig().heavyJobsAtOnce),
  roots: () => ptyManager.list().flatMap((s) => { const a = ptyToAgent.get(s.id); return a && s.pid > 0 ? [{ agentId: a, pid: s.pid }] : []; }),
  probe: probeProcesses,
  log: (row) => { try { hive.appendLog(row); } catch { /* best effort */ } }
});
hookServer.setHeavyLock(heavyLock);
// ZT-I1-MAIL slice 3: the mail epochs and the wake coordinator, both ways.
//  - N3: a UserPromptSubmit joins the live epoch only while the lifecycle is ACTIVE on a
//    provider-confirmed turn (our own unconfirmed nudge is a new turn, not a live one);
//  - legacy-read: the ids a COMMITTED, confirmed wake named are acted at that turn's Stop;
//  - §11.3: every epoch close re-keys the announced set to the ledger (re-pend once, then F4);
//  - §11.10: every mail block feeds the degradation watch.
hookServer.setMailCoordination({
  lifecycleActive: (agentId) => { const s = workerWake.state(agentId); return s.lifecycle === 'active' && !s.provisional; },
  wakeIds: (agentId) => { const s = workerWake.state(agentId); return s.lifecycle === 'active' && s.provisional ? [] : s.announced; },
  onEpochClosed: (agentId, outcome, reason, redelivered) => inboxWake?.onMailEpochClosed(agentId, outcome, reason, redelivered),
  onMailBlock: (agentId) => inboxWake?.onMailBlock(agentId)
});
// HOOK-BROKER: Claude agents POST their hooks to the HookServer in-process (0 processes per
// hook). The hive asks for a per-spawn URL; with the broker not listening it gets null and
// writes the command hooks exactly as before.
// LOG-STALL-AV F1: the app keeps log.jsonl / cost-ledger.jsonl open (closed on quit).
hive.setHookBroker({ urlFor: (id) => hookServer.hookUrl(id), mcpFor: (id) => hookServer.mcpEndpoint(id), revoke: (id) => hookServer.revokeHookToken(id) });
// NATIVE-MEMORY: the memory engine (the only memory). It runs in a
// utility process forked on the first memory request or the post-start prewarm, never at
// start-up itself. Settings' semantic memory (`semanticMemory`) is its master switch.
/** NATIVE-WAKEUP-EMPTY-INDEX (a): the spec's lazy-fork floor after the first window is idle. */
const NATIVE_MEMORY_PREWARM_DELAY_MS = 30_000;
/** CODEX-WAKE-161 addendum (b): which Codex CLI the agents run, logged at start and per spawn,
 *  with a row when it changes (a global npm update silently changes every Codex agent). */
const codexVersionLog = new CodexVersionLog(join(app.getPath('userData'), 'codex-cli-version.json'), (row) => { try { hive.appendLog(row); } catch { /* best-effort */ } });
/** The installed Codex CLI: its resolved path and version (null when not installed / unreadable). */
async function codexCliNow(): Promise<{ path: string | null; version: string | null }> {
  const path = await ptyManager.commandPath('codex');
  return { path, version: readCodexVersion(path) };
}
/** STARTUP-TIMING-162: the first 60 s, measured (loop delay, renderer long tasks, markers), then it
 *  stops. Armed in whenReady; every `t` is ms since the process started. */
const startupTiming = new StartupTiming({
  origin: performance.timeOrigin,
  now: Date.now,
  log: (row) => hive.appendLog(row),
  histogram: () => monitorEventLoopDelay({ resolution: 10 })
});
const nativeMemory = new NativeMemoryWiring({
  hiveRoot: () => hive.root(),
  enabled: () => readConfig().semanticMemory !== false,
  userData: app.getPath('userData'),
  resourcesDir: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
  workerEntry: join(__dirname, 'memoryWorker.js'),
  fork: (entry) => {
    startupTiming.mark('memory-worker-fork');
    return utilityProcess.fork(entry, [], { serviceName: 'munder-memory', stdio: 'ignore' }) as unknown as WorkerHandle;
  },
  memoryBaseUrl: () => hookServer.memoryBaseUrl(),
  writeCommand: (script) => hive.writeMemoryCommand(script),
  log: (row) => hive.appendLog(row),
  vecLoadablePath: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    try { return toUnpacked((require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath()); } catch { return null; }
  }
});
hookServer.setMemoryHandler((token, body) => nativeMemory.handle(token, body));
/** Delete a memory-engine index file and its WAL/SHM. Call only after nativeMemory.shutdown()
 *  (Jim M1); retries ride out a handle Windows releases a moment after the worker exits. */
function deleteMemoryIndex(file: string | null): void {
  if (!file) return;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try { rmSync(f, { force: true, maxRetries: 10, retryDelay: 100 }); } catch (e) { console.error('[memory] rm index', f, e); }
  }
}
// Enterprise Knowledge Graph — file-backed store + agent CLI (default OFF).
const knowledge = new KnowledgeManager();
/** Reads the reflect tunables from config each tick (defaults baked in here so a
 *  pre-existing config.json without the keys still gets sane values). */
function reflectSettings(): ReflectSettings {
  const c = readConfig();
  return {
    enabled: c.reflectEnabled !== false,
    intervalMs: c.reflectIntervalMs ?? 1_800_000,
    byteTriggerPct: c.reflectByteTriggerPct ?? 50,
    sectionTrigger: c.reflectSectionTrigger ?? 50,
    recentKeep: c.reflectRecentKeep ?? 12,
    minBytes: c.reflectMinBytes ?? 16_384
  };
}
// Finishes the janitor's missing condense half: bounds each agent's memory.md
// (Haiku tail-summary, backup→verify→atomic-swap) so it never grows unbounded.
const reflector = new MemoryReflector(
  () => readConfig().harnessHome,
  () => readConfig().defaultCommand ?? 'claude',
  // The reflector's Haiku call needs no memory env.
  () => ({}),
  reflectSettings,
  (event) => { try { hive.appendLog(event); } catch { /* best-effort */ } }
);
// Durable harness state (SQLite, main process). Phase A: window bounds (kv) +
// net-new command history. Opened in whenReady, closed in the teardown blocks.
const persist = new PersistStore();
/** The PRIMARY window — the one running the hive/god orchestration and the sink
 *  for process-global timer events (missions, breaker, Slack ingestion). It is
 *  the most-recently-focused live window, so global events follow the user.
 *  Additional "floor" windows are tracked in `allWindows` below. */
let mainWindow: BrowserWindow | null = null;
/** Every open window (primary + floors). A registry, not a single handle, so
 *  multi-window lifecycle (focus tracking, quit fan-out) is correct. */
const allWindows = new Set<BrowserWindow>();
/** Monotonic floor counter → a stable, unique session partition per floor so
 *  each floor's renderer state (localStorage: agents, queues, selection) is
 *  isolated from every other window's. */
let floorSeq = 0;

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/** A live god-triggered ephemeral worker, tracked from spawn to teardown. */
interface WorkerRec {
  workerId: string;       // == the PTY id == hive agent id (`worker-<reqId>`)
  reqId: string;          // the spawn-request id
  name?: string;          // display name (for the worker tab)
  slack?: { channel: string; thread_ts: string };
  baseBranch: string;     // the branch its worktree was cut from (for ahead-of-base)
  spawnedAt: number;      // epoch ms
  releasing?: boolean;    // kill issued; awaiting teardownPty (skip re-processing)
  /** Per-worker TOTAL-token cap from the spawn-request (overrides the config
   *  default). 0/undefined = no per-request cap. P4 plumbing — unlimited today. */
  tokenCap?: number;
}
/** Live ephemeral workers by id. Populated by the spawn-request watcher; consulted
 *  by teardownPty so a finished/crashed/reaped worker's worktree is PRESERVED (not
 *  force-removed) when it holds unintegrated work — god is the sole integrator. */
const liveWorkers = new Map<string, WorkerRec>();

/** The loopback secret broker (Phase 2). Workers reach registered integrations through
 *  it without ever seeing a credential. getRecord/getSecret are injected so the broker
 *  stays electron-free + unit-testable. Started in bootstrapHiveServices; each worker is
 *  granted a per-worker capability token at spawn (revoked in teardownPty). */
const integrationBroker = new IntegrationBroker({
  getRecord: integrations.getRecord,
  getSecret: integrations.getSecret
});

/** BYOK backend model-providers whose API keys the non-Claude CLI engines
 *  (OpenCode/Crush/pi/qwen) read from standard env vars. Keys are stored
 *  WRITE-ONLY in the same encrypted secret broker as integrations, under
 *  `apikey:<backend>`, and materialized MAIN-ONLY at spawn (never over IPC). */
const BACKEND_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY'
};
const providerKeyRef = (backend: string): string => `apikey:${backend}`;

/** A worker worktree that teardown PRESERVED because it held unintegrated work.
 *  Tracked so the GC sweep can reclaim it (+ its scratch dir) once the work lands
 *  in base or the worktree is removed by hand — see gcPreservedWorktrees(). */
interface PreservedWorktree {
  workerId: string;
  wtPath: string;
  origCwd: string;        // the parent repo to run `git worktree remove` from
  baseBranch: string;     // re-checked against this for "integrated yet?"
  scratchDir: string | null; // HIVE_ROOT/agents/<workerId> — removed alongside the worktree
  slack?: { channel: string; thread_ts: string };
  preservedAt: number;    // epoch ms
}
/** Preserved worker worktrees awaiting integration, keyed by worktree path. The GC
 *  sweep drains this: an entry is removed (worktree + scratch GC'd) only when the
 *  work is provably integrated, or when the worktree is already gone from disk. */
const preservedWorktrees = new Map<string, PreservedWorktree>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so a double call is a harmless no-op. NOTE: an explicit
 * `ptyManager.kill()` does NOT reach here via onExit — kill() deletes the
 * session synchronously, so node-pty's later async exit callback fails the
 * session-identity guard and is swallowed. Every kill site must therefore call
 * teardownPty itself right after the kill (all of them do). Best-effort — every
 * step is wrapped so a teardown error can never crash the caller (an IPC
 * handler or node-pty's onExit).
 */
function teardownPty(id: string, archiveReason: ArchiveReason = 'explicit'): void {
  // Ephemeral-worker flag, read BEFORE the cleanup below deletes the entry. All
  // worker deaths (done-release, idle/token reap, manual stop, crash) funnel
  // through here, so this is the one place their floor card gets archived
  // (workers card via the hive:agentSpawned broadcast in processSpawnRequest).
  // pty id == worker id == agent id for workers.
  const wasWorker = liveWorkers.has(id);
  // 0) Revoke this id's broker capability (if any). Idempotent + harmless for a
  //    non-worker PTY; ensures a dead worker's token can never reach an integration.
  try { integrationBroker.revoke(id); } catch { /* best-effort */ }
  // WAKE-SCREEN-GUARD (Jim N2): a torn-down PTY's incarnation token names nothing any more.
  wakeIncarnationTokens.forgetPty(id);
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    const leftProvider = ptyProvider.get(id);
    ptyToAgent.delete(id);
    ptyProvider.delete(id);
    // Pool membership completeness can change when an agent leaves.
    pushCapacityStrip();
    pushAgentUsage();
    pushAgentImpact();
    // AGY statusline lease: held only while an AGY agent is on the floor. When the last
    // one goes, the user's global statusline goes back to them now - not at quit.
    // (After the pushes: capacity censuses pin the delete-then-push adjacency.)
    if (leftProvider === 'antigravity' && ![...ptyProvider.values()].includes('antigravity')) {
      try { hive.agyAgentsGone(); } catch (e) { console.error('[hive] agyAgentsGone failed:', e); }
    }
    // AGY-STARTUP-TURN: the agent left the floor (killed or archived): remove its agy custom
    // agent, unless another PTY of the same agent is still alive (a restart in place spawns
    // the new one first, and agy may re-read its customizations mid-session).
    if (leftProvider === 'antigravity' && ![...ptyToAgent.values()].includes(agentId)) {
      try { hive.removeAgyAgent(agentId); } catch (e) { console.error('[hive] removeAgyAgent failed:', e); }
    }
    // Drop watchdog state so a dead agent can't get nudged or leak its grace.
    try { workerWake.forget(agentId, id); } catch { /* best-effort */ }
    try { forgetWakeRows(wakeRows, agentId); } catch { /* best-effort */ }
    // ZT-I1-MAIL §1.1: the PTY exited (or crashed): its open mail epoch ends abnormally. Not when
    // another PTY of the same agent is alive (a restart in place spawns the new one first).
    if (![...ptyToAgent.values()].includes(agentId)) { try { hookServer.abortMailTurn(agentId, 'pty-exit'); } catch { /* best-effort */ } }
    try { nativeMemory.agentExited(agentId); } catch { /* best-effort */ }
    // HEAVY-JOB-SERIALIZE: its jobs went with the PTY (unless another PTY of it is still alive).
    if (![...ptyToAgent.values()].includes(agentId)) { try { heavyLock.agentGone(agentId); } catch { /* best-effort */ } }
    // Drop breaker state so a dead agent can't leak/zombie a tripped level.
    try { breaker.forget(agentId); } catch { /* best-effort */ }
    // W1 — kill this agent's proxy-bridge sidecar (qwen), if any, so a dead
    // PTY never leaves an orphan loopback listener. No-op for non-proxy agents.
    try { hive.stopProxyBridge(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
    if (hive.enabled()) {
      // Q32 (god 0f1672): a kill (tab, voice, breaker, worker release) is an explicit archive and
      // bounces mail; a process that died on its own (onExit) is 'pty-exit' and keeps its mail.
      try { hive.setArchived(agentId, true, archiveReason); } catch (e) { console.error('[hive] setArchived failed:', e); }
    }
    // ZERO-TOKEN-LIVENESS: the registry archival edge (the exit itself was recorded by the PTY's
    // end observer, before this teardown). Observation only: nothing is woken or moved here.
    sampleLiveness(agentId);
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    // Ephemeral workers get a SAFETY-GATED teardown: never auto-remove a worktree
    // that holds unintegrated work. This sits INSIDE teardownPty so it covers ALL
    // teardown routes — a worker that finished (controller kill), crashed, or was
    // idle-reaped all land here. Normal agents keep the immediate force-remove.
    const worker = liveWorkers.get(id);
    if (worker) {
      liveWorkers.delete(id);
      void finalizeWorkerWorktree(wtPath, origCwd, worker);
    } else {
      void removeWorktree(origCwd, wtPath)
        .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
        .catch(e => console.error('[worktree] removeWorktree threw:', e));
    }
  }
  // A worker whose isolation failed (non-repo cwd) has no worktree to gate above —
  // still clear its tracking entry so the controller stops watching a dead PTY.
  if (liveWorkers.has(id)) liveWorkers.delete(id);
  // Archive the dead worker's floor card (mirrors killAgent's voice-kill path;
  // the renderer's archiveAgent is a no-op if the card is already gone). NOT
  // done for regular agents: their kill flows already manage their own card.
  if (wasWorker) {
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
  }
  syncKeepAwake();
}

/** Send an inform to the god agent (the human's proxy). The ephemeral-worker
 *  controller uses this to surface every terminal failure AND to carry the Slack
 *  {channel,thread_ts} so god can post a 'couldn't complete' reply — closing the
 *  Slack loop (the success path is the worker replying in-thread itself). */
function informGod(subject: string, body: string, slack?: { channel: string; thread_ts: string }): void {
  try {
    const slackLine = slack
      // The bundled-node launcher, spelled as an ABSOLUTE PATH — NOT bare `node`
      // (absent from the PATH of any machine whose node comes from nvm) and NOT
      // `$HIVE_NODE` (POSIX-only: cmd.exe/PowerShell expand it to nothing, so the
      // whole reply command was dead on Windows).
      ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${hive.nodeCommand()}" "${slackReplyScriptPath()}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"`
      : '';
    hive.send({ to: 'god', act: 'inform', subject, body: body + slackLine }, 'ephemeral-worker');
  } catch (e) {
    console.error('[worker] informGod failed:', e);
  }
}

/** Gated worktree teardown for an ephemeral worker: remove it ONLY when it holds no
 *  unintegrated work; otherwise leave it (and its branch) in place and ping god, the
 *  sole integrator. Async + best-effort; on any uncertainty it KEEPS the worktree
 *  (fail-safe — never auto-discard possibly-valuable work). */
async function finalizeWorkerWorktree(wtPath: string, origCwd: string, worker: WorkerRec): Promise<void> {
  try {
    const work = await worktreeHasUnintegratedWork(wtPath, worker.baseBranch);
    if (work.keep) {
      console.warn(`[worker] PRESERVING worktree with unintegrated work: ${wtPath} (${work.detail})`);
      // Track it so the GC sweep can reclaim it (+ scratch dir) once integrated —
      // the worker is gone from liveWorkers by now, so its identity lives here.
      preservedWorktrees.set(wtPath, {
        workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
        scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
      });
      informGod(
        `[worker worktree preserved] ${worker.workerId}`,
        `Ephemeral worker ${worker.workerId} ended but its worktree holds unintegrated work, so it was NOT auto-removed (you are the sole integrator).\n`
        + `Worktree: ${wtPath}\nBranch: ${work.branch}\nState: ${work.detail}\n`
        + `Review/merge it — it will be auto-reclaimed once its work lands in ${worker.baseBranch}, or remove it now with: git -C "${origCwd}" worktree remove "${wtPath}"`,
        worker.slack
      );
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) { console.error('[worker] removeWorktree failed:', r.error); return; }
    // Worktree is gone (clean/integrated at teardown), but DEFER its scratch-dir
    // cleanup to the throttled GC sweep rather than deleting it synchronously here:
    // HIVE_ROOT/agents/<id> holds the worker's memory.md and the memory engine
    // indexes it asynchronously, so an immediate delete can beat the indexer and
    // lose the worker's durable notes from the shared memory. Register
    // it (its worktree path is now absent) so the sweep's path-gone branch reclaims
    // the scratch after a window — same throttled path the preserved case uses.
    preservedWorktrees.set(wtPath, {
      workerId: worker.workerId, wtPath, origCwd, baseBranch: worker.baseBranch,
      scratchDir: workerScratchDir(worker.workerId), slack: worker.slack, preservedAt: Date.now()
    });
  } catch (e) {
    console.error('[worker] finalizeWorkerWorktree threw (worktree left in place):', e);
  }
}

/** The hive scratch dir for a worker (its inbox/outbox/memory): HIVE_ROOT/agents/<id>.
 *  Null when there's no hive root. */
function workerScratchDir(workerId: string): string | null {
  const root = hive.root();
  return root ? join(root, 'agents', workerId) : null;
}

/** Best-effort removal of a worker's scratch (hive agent) dir. Guarded to ONLY ever
 *  delete a path that resolves to exactly HIVE_ROOT/agents/<workerId> and never a
 *  still-live worker — so a crafted/mismatched id can't escape the agents root. */
function removeWorkerScratch(workerId: string): void {
  if (liveWorkers.has(workerId)) return; // never wipe a live worker's mailbox
  const dir = workerScratchDir(workerId);
  const root = hive.root();
  if (!dir || !root) return;
  const agentsRoot = join(root, 'agents');
  // Path-safety: the resolved dir must sit directly under agents/ with basename == id.
  if (resolve(dir) !== join(resolve(agentsRoot), basename(dir)) || basename(dir) !== workerId) return;
  try { rmSync(dir, { recursive: true, force: true }); }
  catch (e) { console.error('[worker] removeWorkerScratch failed:', e); }
}
// A natural PTY exit must run the same teardown as an explicit kill — EXCEPT when
// the PTY was the missing-CLI installer: a clean exit there means the engine CLI was
// just installed, so auto restart-and-continue by re-running the SAME spawn into the
// SAME pty/window (no user click). Provider-agnostic. Idempotent by construction: the
// relaunch carries `noAutoInstall`, so the installer can never fire (let alone loop) a
// second time — a binary that's somehow still missing just spawns and exits normally.
// ZERO-TOKEN-LIVENESS: every incarnation's end, requested (kill, window close) or not, recorded
// BEFORE its session is removed and before the teardown archives the agent.
ptyManager.setEndObserver((e) => {
  const agentId = ptyToAgent.get(e.id);
  if (!agentId) return;
  try { agentLiveness.notePtyEnd(agentId, { ptyId: e.id, incarnation: e.incarnation, explicit: e.explicit, exitCode: e.exitCode, at: e.at }); }
  catch { /* observation never breaks a kill or an exit */ }
});
ptyManager.setExitHandler((id, exitCode) => {
  const pending = pendingInstallRelaunch.get(id);
  if (pending) {
    pendingInstallRelaunch.delete(id);
    // SYNC-CHILD-CALLS: the resolver caches misses (60 s). An installer just ran — it may have
    // put the CLI, npm or node on disk — so every cached answer is dropped before the relaunch.
    invalidateCommandCache();
    if (exitCode === 0) {
      // Re-arm the renderer's pooled terminal (clear the "process exited" line +
      // re-enable input) so the freshly-spawned CLI paints onto a clean, typeable
      // grid, then re-run the normal spawn — which now finds the installed binary.
      const wc = (pending.owner && !pending.owner.isDestroyed()) ? pending.owner : liveWebContents();
      try { wc?.send(`pty:relaunch:${id}`); } catch { /* window gone */ }
      void spawnAgentCore({ ...pending.opts, noAutoInstall: true }, pending.owner);
      return; // an install PTY has no agent/worktree to tear down
    }
    // Non-zero exit = install failed; leave its honest manual-fix message on screen.
  }
  // Q32 (god 0f1672): the process ended on its own (an explicit kill tore down first and made
  // this a no-op), so the archive is 'pty-exit': mail keeps being delivered, never bounced.
  teardownPty(id, 'pty-exit');
});

/** Keep the system from suspending the harness while agents are running.
 *  Windows Modern Standby suspends desktop apps (and their child `claude`
 *  processes!) shortly after the display sleeps/locks — the whole hive froze
 *  mid-turn until unlock. `prevent-app-suspension` blocks exactly that while
 *  still letting the display turn off and the session lock. Held only while at
 *  least one PTY is alive, so an idle harness doesn't pin a laptop awake.
 *
 *  Opt-in `config.strongKeepalive` escalates to `prevent-display-sleep`, which on
 *  macOS ALSO blocks true system sleep (lid-close/idle) so timers & PTYs keep
 *  firing on time while away — at a battery cost. The default ('prevent-app-
 *  suspension') still lets the Mac truly sleep; we survive that and catch up once
 *  on resume (see onSystemResume). Re-evaluated on every call so toggling the
 *  flag while agents run swaps the blocker mode live. */
type KeepAwakeMode = 'prevent-app-suspension' | 'prevent-display-sleep';
let keepAwakeId: number | null = null;
let keepAwakeMode: KeepAwakeMode | null = null;
function syncKeepAwake(): void {
  const live = ptyManager.list().length > 0;
  const desired: KeepAwakeMode | null = live
    ? (readConfig().strongKeepalive ? 'prevent-display-sleep' : 'prevent-app-suspension')
    : null;
  if (desired === keepAwakeMode) return; // no change — avoid stop/start churn + log spam
  // Tear down the current blocker (mode change, or going idle with no agents).
  if (keepAwakeId !== null) {
    try { if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId); } catch { /* noop */ }
    keepAwakeId = null;
  }
  keepAwakeMode = desired;
  if (desired) {
    keepAwakeId = powerSaveBlocker.start(desired);
    console.log(`[power] keep-awake ON (${desired}) — agents running`);
  } else {
    console.log('[power] keep-awake off — no agents');
  }
}

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
  /** TE0: this mission's dispatch, kept so `missions:runNow` can force a run past
   *  the delta gate. The gate can only ever SUPPRESS, so without a force path an
   *  operator who wants a standup right now has no way to ask for one. Absent for
   *  a heartbeat, which self-schedules a beat rather than arming a fire. */
  fire?: (forced?: boolean) => void;
}

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** Read the floor state the TE0 delta gate hashes.
 *
 *  Everything here is a local file read or an in-memory map — no model, no
 *  network, and nothing the standup itself writes. See standupDelta.ts for the
 *  rule: board.md and the task prose are god's OUTPUT, and coordination MTIMES are
 *  disturbed by the dispatch itself (god's inbox, then his .done/memory/outbox as
 *  he handles it, then every agent's files as the standup asks them to summarise
 *  and compact). Hashing any of them makes the gate see a delta after every
 *  standup and suppress nothing.
 *
 *  Never throws, but never silently guesses either: anything it could not read is
 *  named in `unknown`, and an unknown floor dispatches. */
function collectFloorState(): FloorState {
  const unknown: string[] = [];
  const agents: FloorState['agents'] = [];
  let reg: ReturnType<typeof hive.registry> | null = null;
  try { reg = hive.registry(); } catch { unknown.push('registry'); }
  for (const [id, a] of Object.entries(reg?.agents ?? {})) {
    if (a.archived) continue;
    let actionableInbox = 0;
    try {
      // The SAME exclusion the heartbeat already uses. Counting the scheduler's
      // own beats as floor activity would be the "hash your own exhaust" mistake
      // — it is the dispatch we are deciding about that puts them there.
      // ZT-I1-MAIL §11.8 #9: from the LEDGER (not acted), never from inbox/ file
      // position: the harness archives at Stop, so a file count means nothing.
      actionableInbox = actionableBacklog(hive.mail, id);
    } catch {
      // NOT zero. A zero here is indistinguishable from an empty inbox, so two
      // failed reads in a row would hash identically and the gate would suppress
      // on the strength of an observation that never happened.
      unknown.push(`inbox:${id}`);
    }
    agents.push({
      id,
      onHold: !!a.onHold,
      breaker: breaker.levelFor(id),
      hasLivePty: !!ptyForAgent(id),
      actionableInbox
    });
  }
  const countDir = (label: string, p: string): number => {
    try { return readdirSync(p).length; } catch (e) {
      // ENOENT is a real answer — the directory does not exist, so nothing is
      // queued. Anything else is a failure to observe.
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
      unknown.push(label);
      return 0;
    }
  };
  const root = hive.root();
  if (!root) unknown.push('hive-root');
  let tasks: FloorState['tasks'] = [];
  try { tasks = projectTasks(hive.tasks()); } catch { unknown.push('tasks'); }
  return {
    agents,
    tasks,
    spawnRequests: root ? countDir('spawn-requests', join(root, 'spawn-requests')) : 0,
    crashes: root ? countDir('crashes', join(root, 'crashes')) : 0,
    unknown
  };
}

/** Append the durable record of a SUPPRESSED standup.
 *
 *  Its own file, deliberately NOT log.jsonl: that file's mtime is an input to
 *  isFloorQuiet(), so writing a skip there would keep the floor reading "busy"
 *  forever and silently disable the heartbeat's re-engage. The heartbeat ships
 *  disabled, which is exactly how that would have gone unnoticed. (ZT-I4 retired the
 *  heartbeat and isFloorQuiet with it; the record keeps its own file regardless.) */
function appendStandupSkip(record: StandupSkipRecord): void {
  const root = hive.root();
  if (!root) return;
  try {
    appendFileSync(join(root, 'standup-skips.jsonl'), JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.error('[scheduler] skip record', record.missionId, e);
  }
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission honoring its lastFiredAt — a setTimeout for the
 *  time remaining until its next due fire, which then settles into a steady
 *  interval. Each tick dispatches the mission to its target agent and stamps
 *  lastFiredAt back into config. Called on boot (after the router starts) and
 *  after every missions:save. */
function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled) continue;
    // ZT-I4: the heartbeat is RETIRED (the floor digest replaces it); a heartbeat mission
    // left in an old config is never armed (and the boot migration removes it).
    if (m.kind === 'heartbeat') continue;
    // A weekly mission (day-of-week + time) is armed below and does NOT need an
    // interval, so the interval guard has to come after that branch — it used to
    // be folded into the line above and would have rejected every one of them.
    const weekly = normalizeWeekly(m.weekly);
    if (!weekly && !(m.intervalMs > 0)) continue;
    const fire = (forced = false): void => {
      try {
        // TE0's gate state must be read FRESH, not taken from `m`. `m` is the
        // snapshot syncMissions armed the timer with; nothing re-arms on a fire,
        // so the closure's copy of lastDeltaFingerprint/lastDispatchAt would stay
        // frozen at app-boot values for the life of the process and the gate would
        // compare every tick against a fingerprint from hours ago. lastFiredAt has
        // always been re-read for the same reason, a few lines down.
        let gate: StandupDecision | null = null;
        // A 'compact' maintenance mission (maint-1) is compaction-ONLY: it carries
        // no dispatch body/target, so skip the hive.send and just fire auto-compact.
        // Gate on `kind!=='compact'` ALONE — that already excludes the compact mission;
        // we deliberately do NOT add `&& m.body`, so other (dispatch) missions keep
        // their prior behaviour, including the historical empty-body send (Pam N1).
        if (m.kind !== 'compact' && hive.enabled()) {
          // TE0. Without a deltaGate on the mission this decides 'gate-off' and
          // dispatches, so every mission that has not opted in is untouched.
          // The decision, the send, the skip record and the stamp all live in
          // runStandupTick so a test can drive real ticks against a fake floor —
          // the only way to catch a defect that is about what a dispatch does to
          // the NEXT collection.
          gate = runStandupTick(m.id, {
            readMission: () => (readConfig().missions ?? []).find((x) => x.id === m.id) ?? m,
            collect: collectFloorState,
            now: Date.now,
            send: () => hive.send(
              { to: m.to, act: 'request', subject: m.label, body: m.body }, 'scheduler'),
            recordSkip: (rec) => appendStandupSkip(rec),
            stamp: (patch) => {
              const current = readConfig().missions ?? [];
              writeConfig({
                missions: current.map((x) => (x.id === m.id ? { ...x, ...patch } : x))
              });
            }
          }, forced);
        }
        // Auto-compact: do NOT jam /compact into busy terminals. Hand it to the
        // renderer, which queues a /compact per agent (deduped — never two at
        // once) and delivers it only when that agent goes idle (its drain loop),
        // so a working agent compacts between steps, never mid-step.
        //
        // The CADENCE now belongs to the context trigger, not to a mission — but
        // the legacy per-mission `autoCompact` flag keeps working, routed through
        // the same emit so there is exactly ONE path from main to the renderer.
        // It carries the context trigger's current rule so a mission-driven
        // compaction obeys the same pressure thresholds as a trigger-driven one.
        if (m.autoCompact || m.kind === 'compact') {
          emitContextTrigger('compact', contextRule('compact'));
        }
        // lastFiredAt is stamped on EVERY tick, suppressed ones included: it is the
        // timer's clock, not a record of dispatches. syncMissions arms from
        // `intervalMs - (now - lastFiredAt)`, so leaving it unstamped after a skip
        // computes a zero delay on the next re-arm and spins the mission.
        //
        // For a GATED dispatch mission runStandupTick above has already stamped it
        // (and, only on a real dispatch, the baseline and lastDispatchAt with it).
        // This branch covers the ticks it never saw: a compact-only mission, or a
        // dispatch mission while the hive is disabled.
        if (!gate) {
          const firedAt = Date.now();
          const current = readConfig().missions ?? [];
          writeConfig({
            missions: current.map((x) => (x.id === m.id ? { ...x, lastFiredAt: firedAt } : x))
          });
        }
        // Let the SCHEDULES panel refresh its "last fired" without a reload (#2.3).
        try { liveWebContents()?.send('missions:updated'); } catch { /* window gone */ }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    const entry: MissionTimer = {};
    // Registered before either arming branch: a weekly mission returns early
    // below, and it needs a run-now just as much as an interval one does.
    entry.fire = fire;
    if (weekly) {
      // Weekly self-reschedules: there is no steady interval to settle into,
      // because the gap between two slots varies (Fri to Mon is not Mon to Wed,
      // and the week the clocks change is not 168 hours long).
      //
      // `justFired` is a spin guard, not a nicety. weeklyDelayMs returns 0 for a
      // slot that was missed and not yet run, and it learns "already run" from
      // the persisted lastFiredAt — so if fire()'s writeConfig ever failed, the
      // next computation would return 0 again, forever. Passing `now` as the
      // last-fired floor after a fire makes the catch-up branch unreachable, so
      // the worst case is a lost stamp rather than a hot loop.
      const rearm = (justFired: boolean): void => {
        const now = Date.now();
        const persisted = (readConfig().missions ?? []).find((x) => x.id === m.id)?.lastFiredAt ?? 0;
        const delay = weeklyDelayMs(weekly, now, justFired ? Math.max(persisted, now) : persisted);
        if (delay === null) return;
        entry.timeout = setTimeout(() => { fire(); rearm(true); }, delay);
      };
      rearm(false);
      missionTimers.set(m.id, entry);
      continue;
    }
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

// ─── Context trigger (auto-compact / auto-clear own their own timers) ────────
// Compaction used to ride on a mission (`compact-maintenance`), which meant the
// operator had TWO competing controls for one behaviour — a schedule with an
// interval and a trigger with a cadence. The mission is retired (see the
// retirement migration in ensureDefaultMissions); these timers are the single
// remaining source of scheduled context maintenance.
//
// Main owns only the CADENCE. The pressure gate (`minContextPct`) needs each
// agent's live context usage, which only the renderer has, so the whole rule
// rides along in the event and the renderer decides which agents actually get
// the command. That split is why the payload carries the rule rather than a bare
// "go" signal.

/** Timers for the two halves, keyed by action. Same two-phase shape as
 *  `missionTimers` (a setTimeout for the remaining time, then a steady interval)
 *  so a partially-elapsed cadence survives a re-arm. */
const contextTimers = new Map<'compact' | 'clear', MissionTimer>();

/** `ContextRule` has no `lastFiredAt` (unlike `ScheduledMission`), so the last-run
 *  instants live in the durable kv store instead. Without them every re-arm —
 *  boot, a settings edit, a wake from sleep — would restart a 2h cadence from
 *  zero, and an operator who edits the rule twice a day would never see it fire. */
const CONTEXT_LAST_RUN_KV_KEY = 'triggers.context.lastRun';
let contextLastRun: Record<string, number> | null = null;

function contextRunMap(): Record<string, number> {
  if (!contextLastRun) {
    try { contextLastRun = persist.getKv<Record<string, number>>(CONTEXT_LAST_RUN_KV_KEY) ?? {}; }
    catch { contextLastRun = {}; }
  }
  return contextLastRun;
}

/** When the rule last ran. An UNRECORDED half is stamped NOW rather than read as
 *  the epoch: `remaining` would otherwise clamp to 0 and compact every terminal
 *  the instant the app boots. It is the same trap `ensureDefaultMissions` avoids
 *  by stamping `lastFiredAt` when it seeds a mission — a first launch should wait
 *  a full cadence, not open with an interruption. */
function contextLastRunAt(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const v = map[action];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return stampContextRun(action);
}

function stampContextRun(action: 'compact' | 'clear'): number {
  const map = contextRunMap();
  const at = Date.now();
  map[action] = at;
  try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
  return at;
}

/** The live rule for one half, deep-filled. `readConfig` already fills both
 *  halves, so the default is only a belt-and-braces fallback. */
function contextRule(action: 'compact' | 'clear'): ContextRule {
  return readConfig().contextTrigger?.[action] ?? DEFAULT_CONTEXT_TRIGGER[action];
}

/** Clear and forget both context timers (setTimeout + setInterval handles). */
function clearContextTimers(): void {
  for (const t of contextTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  contextTimers.clear();
}

/** Ask the renderer to run one half of the context trigger.
 *
 *  Both callers funnel through here — the legacy per-mission `autoCompact` flag
 *  and the context trigger's own timer — so there is exactly one path from main
 *  to the renderer for each action. */
function emitContextTrigger(action: 'compact' | 'clear', rule: ContextRule): void {
  try { liveWebContents()?.send('trigger:context', { action, rule }); } catch { /* window gone */ }
  // TRANSITIONAL ALIAS: the renderer still carries the pre-Triggers
  // `mission:autoCompact` listener as a fallback. Both fire for compact until
  // every consumer has moved to `trigger:context`; then this line goes.
  if (action === 'compact') {
    try { liveWebContents()?.send('mission:autoCompact'); } catch { /* window gone */ }
  }
}

/** (Re)arm both context timers from persisted config. Clear-then-arm, so calling
 *  it after a settings change, on boot, or on wake from sleep can never stack
 *  duplicates. Honors elapsed-time-since-last-run exactly like mission arming:
 *  an overdue rule fires ONCE and then settles into its steady cadence. */
function syncContextTriggers(): void {
  clearContextTimers();
  for (const action of ['compact', 'clear'] as const) {
    const rule = contextRule(action);
    if (!rule.enabled || !(rule.everyMs > 0)) continue;
    const fire = (): void => {
      try {
        stampContextRun(action);
        // Re-read: the operator may have edited the message/thresholds since the
        // timer was armed, and the renderer should act on what's current.
        emitContextTrigger(action, contextRule(action));
      } catch (e) {
        console.error('[triggers] context', action, e);
      }
    };
    const remaining = Math.max(0, rule.everyMs - (Date.now() - contextLastRunAt(action)));
    const entry: MissionTimer = {};
    entry.timeout = setTimeout(() => {
      fire();
      entry.interval = setInterval(fire, rule.everyMs);
    }, remaining);
    contextTimers.set(action, entry);
  }
}

/** Startup migration (#57/#58): archive every agent entry that is `archived:false`
 *  but has NO live PTY. This runs in bootstrapHiveServices, BEFORE the renderer can
 *  respawn anything, so at this point NO agent owns a PTY — every `archived:false`
 *  entry is therefore a stale carry-over from a prior session that quit/crashed
 *  WITHOUT archiving (e.g. the pre-acc13a3 'assistant' Dwight entry). Left as-is
 *  they have no live PTY, so the breaker beat steers them and the steer bounces to
 *  GOD as a requires_reply GOD can't clear → inbox flood.
 *
 *  "No live PTY" = ptyForAgent(id) === undefined (ptyToAgent is populated only at
 *  spawn and pruned on teardown). God is never archived. A user's real agents are
 *  unaffected: the "restore team" flow respawns them through ensureAgent, which
 *  re-clears `archived` — restorability does not depend on the archived flag. */
function archiveOrphanedAgents(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    for (const [id, a] of Object.entries(reg.agents)) {
      if (a.archived) continue;
      if (id === reg.godId) continue;        // god is never archived
      if (ptyForAgent(id)) continue;         // has a live PTY → genuinely active
      hive.setArchived(id, true, 'orphan');  // stale archived:false orphan → archive (Q32: no bounce)
      console.log('[migration] archived orphaned agent (no live PTY):', id);
    }
  } catch (e) {
    console.error('[migration] archiveOrphanedAgents failed:', e);
  }
}

/** One-time migration: ensure the built-in hourly ops standup exists for installs
 *  that predate it. Guarded by `opsStandupSeeded` so a user who later deletes the
 *  mission doesn't get it re-added on every boot. Stamps lastFiredAt = now so the
 *  first standup waits a full interval instead of firing (and compacting every
 *  terminal) immediately on launch. */
function ensureDefaultMissions(): void {
  const cfg = readConfig();
  if (!cfg.opsStandupSeeded) {
    const missions = cfg.missions ?? [];
    const has = missions.some((m) => m.id === OPS_STANDUP_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...OPS_STANDUP_MISSION, lastFiredAt: Date.now() }],
      opsStandupSeeded: true
    });
  }
  // ZT-I4: the heartbeat (Lane A #1) is RETIRED; the floor digest replaces it. It is no
  // longer seeded, and a heartbeat mission an older build seeded is removed once, so the
  // SCHEDULES panel does not offer a switch that does nothing.
  const cfg2 = readConfig();
  if (!cfg2.heartbeatRetired) {
    const missions = cfg2.missions ?? [];
    writeConfig({
      missions: missions.filter((m) => m.id !== HEARTBEAT_MISSION.id && m.kind !== 'heartbeat'),
      heartbeatRetired: true
    });
  }

  // TE0 MIGRATION: attach the delta gate to an ops standup that already exists.
  // The seeding branch above is guarded by `opsStandupSeeded`, which is already
  // true on every install that has ever launched — so without this, the gate
  // would ship to new installs only and the machines actually paying for
  // no-change standups would never get it. Runs at most once, and only fills a
  // gate that is absent: an operator who later turns it off stays off.
  const cfgGate = readConfig();
  if (!cfgGate.standupDeltaGateSeeded) {
    const missions = cfgGate.missions ?? [];
    writeConfig({
      missions: missions.map((m) =>
        m.id === OPS_STANDUP_MISSION.id && !m.deltaGate
          ? { ...m, deltaGate: OPS_STANDUP_MISSION.deltaGate }
          : m
      ),
      standupDeltaGateSeeded: true
    });
  }

  // maint-1 RETIREMENT: `compact-maintenance` is no longer a mission. Scheduled
  // compaction is now the CONTEXT TRIGGER's job, so the operator has exactly one
  // control (a cadence + a pressure gate + an editable message) instead of two
  // that could disagree — a mission saying "hourly" while the trigger said "2h"
  // was a real, unresolvable conflict.
  //
  // The carry-over preserves the operator's decisions: whether compaction was ON
  // and how often. It runs at most once per install, and its guard is the
  // mission's own ABSENCE — nothing seeds `compact-maintenance` any more, so once
  // this has removed it there is nothing left to carry and a later hand-edit of
  // the trigger can never be clobbered. That keeps the `*Seeded` convention's
  // promise (exactly once, ever) without a config flag that would only ever be
  // read here; `compactMaintenanceSeeded` is left set so nothing re-seeds it.
  const cfg3 = readConfig();
  const missions3 = cfg3.missions ?? [];
  const retiring = missions3.find((m) => m.id === COMPACT_MAINTENANCE_MISSION.id);
  if (retiring) {
    const current = cfg3.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    writeConfig({
      missions: missions3.filter((m) => m.id !== COMPACT_MAINTENANCE_MISSION.id),
      contextTrigger: {
        ...current,
        compact: {
          ...current.compact,
          enabled: retiring.enabled,
          // A hand-tuned interval is a decision; only a missing/absurd one falls
          // back to whatever the trigger already carries.
          everyMs: retiring.intervalMs > 0 ? retiring.intervalMs : current.compact.everyMs
        }
      },
      compactMaintenanceSeeded: true
    });
    // …and its elapsed time, so retiring the mission mid-cycle doesn't restart a
    // 2h cadence from zero (the timers honour last-run exactly as arming did).
    if (typeof retiring.lastFiredAt === 'number' && retiring.lastFiredAt > 0) {
      const map = contextRunMap();
      map.compact = retiring.lastFiredAt;
      try { persist.setKv(CONTEXT_LAST_RUN_KV_KEY, map); } catch { /* DB best-effort */ }
    }
    console.log('[triggers] retired the compact-maintenance mission into contextTrigger.compact',
      `(enabled: ${retiring.enabled}, everyMs: ${retiring.intervalMs})`);
  }

  // autoCompact RETIREMENT: the flag above was only ever half-removed. Retiring
  // `compact-maintenance` left `autoCompact: true` sitting on the ops standup, so
  // a default install still asked for compaction on TWO cadences — hourly from the
  // standup, 2-hourly from the trigger — which is precisely the disagreement that
  // retirement claims to have ended. (config.ts even documented a migration that
  // strips this; it did not exist.)
  //
  // Strip it wherever it survives. This is a pure de-duplication, not a behaviour
  // change: contextTrigger.compact still runs, still on the user's own cadence and
  // pressure gate, and it is what actually performed every one of these
  // compactions already — both paths have called emitContextTrigger since Triggers
  // landed. Idempotent, so it costs one no-op scan per boot once clean.
  const cfg4 = readConfig();
  const missions4 = cfg4.missions ?? [];
  if (missions4.some((m) => m.autoCompact)) {
    writeConfig({
      missions: missions4.map(({ autoCompact, ...rest }) => {
        void autoCompact;
        return rest;
      })
    });
    console.log('[triggers] dropped the legacy per-mission autoCompact flag —',
      'contextTrigger.compact is now the only schedule that compacts');
  }
}

// ─── Coordination helpers. The heartbeat (Lane A #1) is retired: ZT-I4's floor digest
// (floorDigest.ts) replaces its quiet/stuck heuristics and its re-engage message. ───

/** Newest coordination time for one agent: its own outbox + outbox/.sent and memory.md mtimes,
 *  plus its last ACTED mail transition from the ledger. Deliberately excludes PTY output, so
 *  "no-progress" means "not coordinating" even while the agent is busy printing tokens. Handling
 *  mail IS coordination (without it an inbox-ack turn reads as no-progress, issue #109's second
 *  trigger), but since 1.1.75 the HARNESS moves handled mail into inbox/.done, so neither the
 *  inbox nor the .done mtime is the agent's doing (ZT-I1-MAIL §11.8 #11): the ledger's `acted`
 *  transition is the signal. A delivery into the inbox is the sender's act, not this agent's. */
function lastCoordinationAt(agentId: string): number {
  const root = hive.root();
  if (!root) return 0;
  const times: number[] = [0, mailCoordinationAt(hive.mail, agentId)];
  const pushMtime = (p: string): void => { try { times.push(statSync(p).mtimeMs); } catch { /* missing */ } };
  const dir = join(root, 'agents', agentId);
  pushMtime(join(dir, 'outbox'));
  pushMtime(join(dir, 'outbox', '.sent'));
  pushMtime(join(dir, 'memory.md'));
  return Math.max(...times);
}

// MODEL-PINBACK user/auto: a live model switch counts as the user's only when HUMAN-origin
// terminal input (never an app write: those are PROGRAMMATIC/CONTROL) reached the agent's pty.
hive.setHumanInputSource((agentId) => {
  const ptyId = ptyForAgent(agentId);
  return ptyId ? ptyManager.lastHumanInputAt(ptyId) : undefined;
});

/** PTY id owning a given agent id, or undefined. */
function ptyForAgent(agentId: string): string | undefined {
  for (const [ptyId, a] of ptyToAgent) if (a === agentId) return ptyId;
  return undefined;
}

/**
 * A native toast for a capacity transition (§13, unit #7), gated on the same notifications
 * setting as every other toast. WHICH transitions toast, and their words, come from the
 * presenter's `toastFor` (null = strip-only); this only delivers. Main-side only, so a
 * closed or throttled window cannot swallow it.
 */
function capacityToast(toast: CapacityToast | null): NoticeDelivery {
  return deliverCapacityToast(toast, {
    // MUNDER_HIDDEN (dev only): a hidden run never puts a toast on the desktop.
    notificationsOn: () => !DEV_HIDDEN && readConfig().notifications === true,
    supported: () => Notification.isSupported(),
    show: (t) => { if (DEV_HIDDEN) return; new Notification({ title: t.title, body: t.body }).show(); }
  });
}

/**
 * Membership is KNOWN only while every running agent of this provider has produced a
 * reading (and so has a pool). An agent with no reading yet might draw on any pool of
 * its provider, and main does not guess which (design section 12: Membership unknown).
 */
function capacityMembershipKnown(provider: string): boolean {
  for (const [ptyId, agentId] of ptyToAgent) {
    if (ptyProvider.get(ptyId) === provider && !providerCapacity.hasPool(agentId)) return false;
  }
  return true;
}

function presentCapacityStrip(): CapacityStripCollection {
  return capacityStrip.present({
    snapshot: providerCapacity.snapshot(),
    membersOf: (poolKey) => providerCapacity.membersOf(poolKey),
    membershipKnown: capacityMembershipKnown,
    freshUntil: (poolKey) => providerCapacity.tracker.freshUntil(poolKey),
    now: Date.now()
  });
}

let lastPushedCapacityStrip = -1;
/**
 * Re-project and push the pool collection to EVERY window (each has its own title
 * bar). Pushes only when the collection revision moved. A projection that fails its
 * own schema is logged and not sent; the renderer's expiry mask degrades what it has.
 */
function pushCapacityStrip(): void {
  let collection: CapacityStripCollection;
  try { collection = presentCapacityStrip(); }
  catch (e) { console.warn('[capacity-strip]', e instanceof Error ? e.message : e); return; }
  if (collection.collectionRevision === lastPushedCapacityStrip) return;
  lastPushedCapacityStrip = collection.collectionRevision;
  for (const w of allWindows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try { w.webContents.send(CAPACITY_STRIP_CHANNEL, collection); } catch { /* window tearing down */ }
  }
}

const agentUsagePushGate = new AgentUsagePushGate();
/**
 * v1.1.45 unit #13 (crit 15): the Monitor 5H / Weekly lines are PUSHED, never polled. The
 * rows for every agent whose persisted display is 5H or Weekly go to every window on their
 * OWN channel (not control:snapshot, no pool identity), only when the rows changed. The
 * owner's onChange carries time-driven FRESH -> STALE decay, so that pushes too.
 */
function pushAgentUsage(): void {
  let push;
  try {
    push = agentUsagePushGate.next(agentUsagePushOf(readConfig().agentUsageDisplay, (agentId) => {
      const poolKey = providerCapacity.poolKeyOf(agentId);
      return poolKey ? providerCapacity.tracker.pool(poolKey) : null;
    }, Date.now()));
  } catch (e) { console.warn('[capacity-usage]', e instanceof Error ? e.message : e); return; }
  if (!push) return;
  for (const w of allWindows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try { w.webContents.send(CAPACITY_AGENT_USAGE_PUSH, push); } catch { /* window tearing down */ }
  }
}

/** Agents a renderer has asked about via control:snapshot: the rows of the impact push. */
const impactWatched = new Set<string>();
const agentImpactPushGate = new AgentImpactPushGate();
let impactPushing = false;
let impactPushAgain = false;
/**
 * v1.1.45 CRIT-15-PRE: the agent-card impact is PUSHED, never polled (see agentImpactPush.ts
 * for the events that call this). Re-entrant calls - reading an interference hold can retire
 * one and settle its grant, which is itself an admission move - fold into one more pass.
 */
function pushAgentImpact(): void {
  if (impactPushing) { impactPushAgain = true; return; }
  impactPushing = true;
  try {
    for (let pass = 0; pass < 3; pass++) {
      impactPushAgain = false;
      let push;
      try {
        push = agentImpactPushGate.next(agentImpactPushOf(impactWatched, (agentId) => controlFactsOf(agentId).impact));
      } catch (e) { console.warn('[agent-impact]', e instanceof Error ? e.message : e); return; }
      if (push) {
        for (const w of allWindows) {
          if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
          try { w.webContents.send(AGENT_IMPACT_PUSH, push); } catch { /* window tearing down */ }
        }
      }
      if (!impactPushAgain) return;
    }
  } finally { impactPushing = false; }
}

/** A native toast for breaker constrain/stop, gated on the notifications setting. */
function breakerToast(title: string, body: string): void {
  if (DEV_HIDDEN || !readConfig().notifications) return;   // MUNDER_HIDDEN: no toast
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); }
  catch { /* unsupported platform */ }
}

/** One circuit-breaker beat: pull a fresh usage sample per active agent, append
 *  it to the durable cost ledger (the SOLE durable cost store), tick the breaker,
 *  emit each BreakerState on control:breakerState (Seam 2), and enforce any
 *  escalation. God is in the LEDGER (cost visibility) but NOT the breaker inputs
 *  (the heartbeat manages god; we never auto-steer/kill the orchestrator). */
function runBreakerBeat(progressWindowMs: number): void {
  if (!hive.enabled()) return;
  const reg = hive.registry();
  const now = Date.now();
  const inputs: BreakerInput[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived) continue;
    // #57/#58: skip assistant + orphaned shells. The breaker must only evaluate
    // live, real agents. An assistant entry (e.g. the pre-acc13a3 headless
    // 'Dwight') or any orphaned entry left archived:false with NO live PTY would
    // otherwise be steered, and that steer bounces to GOD as a requires_reply GOD
    // can't clear → inbox flood. ptyForAgent(id) === undefined means no live PTY.
    // God is exempt from this orphan check (it keeps its own flow + the godId skip
    // below) so its ledger row is unaffected. Live real agents always own a PTY
    // (ptyToAgent is set at spawn), so their breaker behavior is unchanged.
    if (a.isAssistant) continue;
    if (id !== reg.godId && !ptyForAgent(id)) continue;
    const sample = usageProvider.getAgentUsage(id);
    // #56: only append a ledger row for a LIVE session sample. A dead/orphaned
    // agent with a frozen transcript still yields a sample via the transcript
    // fallback, but with an EMPTY sessionId (aggregateLive returns null → no live
    // OTel session). Appending it every ~30s rewrote the identical row forever
    // (2,417 dupes observed). A truthy sessionId is set only by a live session
    // (aggregateLive picks the most-recent live session id), so this gates on
    // "is there a live session" without changing any live-agent behavior.
    if (sample?.sessionId) hive.appendCostLedger(sample); // ledger covers everyone incl. god
    // Second source for the resume key. recordSession() is otherwise reachable
    // ONLY from the hook shim, so any window where hooks don't land leaves the
    // registry with no sessionId and "Restart & Continue" refuses to continue —
    // while this very sample proves the app knew the live session id all along
    // (it was already being written to the cost ledger one line above). Same id,
    // same liveness gate; recordSession writes only on change, so this is a
    // no-op once the hooks are flowing.
    // START-FIXES-163 (1): NOT always the same id. A resumed Claude emits its start-up
    // metric under a new process session id that has no transcript (WHY-162 chain 2),
    // and recording it replaced the real --resume key with a phantom: a quick restart
    // then came up fresh and lost its context. So a sample id may only fill an EMPTY
    // key, or replace one when its own transcript is on disk.
    // SESSION-CROSSWIRE: and the sample is marked as such, so it never replaces a key this
    // agent's own hooks wrote, nor takes an id another agent claims (hive.recordSession).
    if (sample?.sessionId && shouldRecordSampleSession(hive.lastSession(id), sample.sessionId, reg.agents[id]?.cwd)) {
      hive.recordSession(id, sample.sessionId, 'sample');
    }
    if (id === reg.godId) continue;            // breaker skips god
    // Progress = fresh coordination files OR a recent OTel tool span. The span
    // leg closes the background-work blind spot: subagent/Workflow tool calls
    // never reach the parent session's PostToolUse hook (so the breaker's own
    // distinct-tool clock stays stale) but their spans DO flow through the
    // collector under this agent's id — an idle parent supervising a hard-
    // working background fleet is progressing, not wedged. Observed live: the
    // one residual no-progress false positive after the #109 fixes.
    const spans = telemetry.getSpans(id);
    const lastSpanAt = spans.length ? spans[spans.length - 1].ts : 0;
    inputs.push({
      agentId: id,
      sample,
      progressing: now - lastCoordinationAt(id) < progressWindowMs || now - lastSpanAt < progressWindowMs
    });
  }
  for (const d of breaker.tick(inputs, now)) {
    try { liveWebContents()?.send('control:breakerState', d.state); } catch { /* window gone */ }
    if (d.action === 'none') continue;
    const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
    const reason = d.state.reason;
    if (d.action === 'steer') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
        body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask god for direction.` }, 'breaker');
    } else if (d.action === 'constrain') {
      hive.send({ to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
        body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to god for sign-off BEFORE running more tools.` }, 'breaker');
      breakerToast(`${name} constrained`, reason);
    } else if (d.action === 'stop') {
      const ptyId = ptyForAgent(d.state.agentId);
      if (ptyId) { try { ptyManager.kill(ptyId); } catch { /* already gone */ } teardownPty(ptyId); }
      breakerToast(`${name} stopped by circuit breaker`, reason);
    }
  }
}

/** Lifetime spend, folded from cost-ledger.jsonl. `telemetry`'s usd counter is
 *  cumulative-since-process-start and restarts at ~0 on every app restart, so
 *  it cannot answer "what has this agent cost us". See costLifetime.ts. */
const costTotals = new CostLedgerTotals();

/** ZT-I1-MAIL §3 #6: one agent's mail fields for fleet.json, from its ledger. A ledger that
 *  cannot be read keeps the backlog (file count) and publishes no obligation lists. */
function fleetMail(id: string): Partial<ReturnType<typeof fleetMailFields>> & { inboxBacklog: number } {
  try { return fleetMailFields(hive.mail, id); } catch { return { inboxBacklog: hive.inboxBacklog(id) }; }
}

/** Build + write the live fleet snapshot Michael reads (`<hive>/fleet.json`).
 *  Always-on (independent of the heartbeat) since `claude agents` can't see the
 *  hive's sibling sessions. PII-free; never throws (called from a timer). */
/** CARD-IDLE-WHILE-WORKING: fleet.json's view of an agent's tool call in progress. */
function runningToolFor(agentId: string, now: number): { name: string; forSec: number } | null {
  const t = hookServer.runningTool(agentId);
  return t ? { name: t.name, forSec: Math.max(0, Math.round((now - t.since) / 1000)) } : null;
}

function writeFleetSnapshot(): void {
  if (!hive.enabled()) return;
  try {
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    // Async + incremental; returns immediately and never throws into the timer.
    const hiveRoot = hive.root();
    if (hiveRoot) void costTotals.refresh(join(hiveRoot, 'cost-ledger.jsonl'));
    const agents = Object.entries(reg.agents)
      .filter(([, a]) => !a.archived)
      .map(([id, a]) => {
        const u = usageById.get(id);
        const spans = snap.spans[id] ?? [];
        // GOD-STARTUP-TOKENS R3: `tokens` is the billed-equivalent figure (cache reads x0.1, writes
        // x1.25); the raw sum stays as `tokensRaw` (the token caps count raw).
        const tokens = billedEquivalentTokens(u);
        const tokensRaw = rawTokens(u);
        // `usd` is LIFETIME (reset-corrected). Until the first fold completes we
        // fall back to the session figure rather than publishing a cold $0.
        const lifetime = costTotals.usdFor(id);
        const sessionUsd = u ? Number(u.usd.toFixed(4)) : 0;
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
          cwd: a.cwd,
          isGod: !!a.isGod,
          breaker: breaker.levelFor(id),
          tokens,
          tokensRaw,
          usd: lifetime === null ? sessionUsd : Number(lifetime.toFixed(4)),
          sessionUsd,
          lastTool: spans.length ? spans[spans.length - 1].tool : null,
          lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
          // CARD-IDLE-WHILE-WORKING: the tool call in progress (a long one fires no hooks).
          runningTool: runningToolFor(id, now),
          // ZT-I1-MAIL §3 #6: inboxBacklog (not acted), awaitingReply[] (§4.3) and
          // openRequests[] (§11.13 option B), all from the ledger. Zero-token: data only.
          ...fleetMail(id),
          onHold: !!a.onHold,
          // D8: this agent's wake history, next to the backlog it is supposed to drain.
          // Those two numbers together are the whole question — mail waiting, and whether
          // anything is waking to read it.
          wake: wakeTelemetry.forAgent(id)
        };
      });
    // HEAVY-JOB-SERIALIZE: who holds the heavy-job slots (god reads fleet.json every standup).
    // ZERO-TOKEN-LIVENESS: the current liveness-v1 records (every LIVE agent, recent non-LIVE ones).
    hive.writeFleetSnapshot({ ts: now, agents, wake: wakeTelemetry.snapshot(now), heavyLock: { limit: heavyLimit(readConfig().heavyJobsAtOnce), holders: heavyLock.snapshot() }, liveness: agentLiveness.fleetRecords(now) });
  } catch (e) {
    console.error('[fleet] snapshot failed:', e);
  }
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) return wc;
  // Primary gone (closed/destroyed): fall back to any other live window so a
  // global event still reaches a renderer instead of being silently dropped.
  for (const w of allWindows) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
  }
  return null;
}

// ─── Slack webhook server (Slack message → Michael's queue) ──────────────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;
/** The loopback-only reply endpoint (lets the bundled helper post back to Slack
 *  without ever seeing the bot token). Lifecycle is tied to `slackServer`. */
let slackReplyServer: SlackReplyServer | null = null;
/** Last public tunnel URL handed out — persisted so Settings can re-show the
 *  Request URL after a reopen (Slack reuses it until the server is stopped). */
let lastSlackUrl: string | undefined;

/** AUTONOMOUS REQUEST PROTOCOL — built PER MESSAGE (not a static const) so it can
 *  embed the request's concrete `channel`, `thread_ts`, and the resolved helper
 *  path. Prepended (server-side, authoritatively) to the working instruction god
 *  reads for any Slack-origin request: there is no interactive human at the
 *  keyboard, so god must route fast, delegate WITH the exact reply command (so the
 *  worker posts its real result back into THIS thread itself), stay autonomous,
 *  and only block on enumerated high-severity actions. Prepended to god's PROMPT
 *  only — the human-facing kanban card TITLE stays the user's raw text (the
 *  renderer keeps them split). Trailing space is intentional so the user's message
 *  reads naturally after it. */
function buildAutonomousRequestProtocol(channel: string, threadTs: string, helperPath: string): string {
  return `[AUTONOMOUS REQUEST PROTOCOL — this request arrived via Slack; no interactive human is watching] Handle it under this protocol:
1. ROUTE FAST — triage and hand this to the single most-relevant agent right away. CHECK THE LIVE ROSTER FIRST (active agents in registry.json + their state in fleet.json) and prefer an EXISTING agent that fits — especially when the request names one ("ask Pam…", "have Jim…"): route to that agent and only spawn a new one if none is a sensible fit. Decompose only if it genuinely needs several. Don't sit on it.
2. DELEGATE WITH THE REPLY HANDLE — tell that agent to do the work autonomously AND to post its result back to THIS Slack thread itself when done, using exactly: "${hive.nodeCommand()}" "${helperPath}" --channel ${channel} --thread ${threadTs} --text "<substantive result>" (that first path is the harness's bundled Node, already resolved for this machine — pass it verbatim; bare "node" is not on the hook/agent PATH on many machines.)
3. AUTONOMOUS EXECUTION — no interactive questions. PAUSE/ask ONLY for high-severity actions: pushing to main or any remote; buying or spawning infrastructure or paid services; deleting an existing repo, file, or folder it did not create. Stay READ-ONLY at critical infrastructure and git-push-type changes unless explicitly approved.
4. DIRECT, SUBSTANTIVE REPLY — the agent posts a real Slack-mrkdwn answer (short *bold* headline + the actual outcome/specifics/links), NEVER a bare "done"/":white_check_mark:".
5. REPORT TO GOD — the agent then tells you (Michael) what it did.
6. ASYNC QUESTIONS — if a decision is genuinely needed, don't block: post the question + numbered OPTIONS to the thread via that reply command, and record {q, options, askedAt (ISO + day & time), thread_ts ${threadTs}} so the threaded human reply correlates back and resumes.
The user's message starts now: `;
}

// ─── Slack done-notifier (Slack-origin task → done → one summary reply) ───────
/** Polls the shared kanban (hive/tasks.json) for Slack-origin tasks that reach
 *  'done' and posts ONE summary reply into the originating thread. Lifecycle is
 *  tied to `slackServer`. OUTBOUND-only: it never touches inbound queue/lanes. */
let slackDoneTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow post can't overlap the next tick. */
let slackDonePolling = false;
/** Task ids already notified — exactly-once across re-reads AND restarts. Lazily
 *  loaded from / persisted to `slackDoneNotifiedPath()`. */
let slackDoneNotified: Set<string> | null = null;
/** Ids already 'done' when the observer started — baselined (never notified) so a
 *  summary only ever fires on a live …→done transition, not on pre-existing dones. */
let slackDoneBaseline: Set<string> | null = null;
/** thread_ts values an agent has ALREADY answered directly via the loopback
 *  `/reply` endpoint. The done-summary poller skips these — the agent's own
 *  substantive reply already landed in-thread, so the poller is a fallback, not a
 *  duplicator (this is what stops the bare/duplicate `:white_check_mark:` posts). */
const directlyRepliedThreads = new Set<string>();

/** Absolute path to the bundled `md-slack-reply.cjs` helper. Packaged: under
 *  `process.resourcesPath` (electron-builder extraResources). Dev: the repo's
 *  `resources/` dir, resolved from the app path. */
function slackReplyScriptPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'md-slack-reply.cjs')
    : join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
}

/** W3 — the bundled read-only `skills/` source dir copied into each agent's
 *  `.claude/skills/` at spawn. Same packaged/dev resolution as the helpers above.
 *  Tolerated-missing until lp-manifest (Kevin) populates it (the hive copy is a
 *  no-op on an absent dir). */
function skillsResourceDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills');
}

/** Where the helper discovers `{ port, token }` for the loopback endpoint. Kept
 *  under userData (NOT the git repo, NOT in the hive the memory engine indexes). */
function slackReplyConfigPath(): string {
  return join(app.getPath('userData'), 'slack-reply.json');
}

/** Ledger of task ids whose done-summary has already been posted. Ids ONLY — no
 *  secret ever lands here. Under userData (out of the repo, out of the indexed hive). */
function slackDoneNotifiedPath(): string {
  return join(app.getPath('userData'), 'slack-done-notified.json');
}

/** Directory where downloaded Slack attachments are saved (out of repo, out of the indexed hive). */
function slackFilesDir(): string {
  return join(app.getPath('userData'), 'slack-files');
}

/** Per-file download size cap — reject files larger than 10 MB before writing. */
const SLACK_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** Sanitize a Slack filename: keep only the basename, replace non-safe chars,
 *  prefix with a random hex tag to prevent collisions and path-traversal attacks. */
function sanitizeSlackFilename(name: string | undefined, tag: string): string {
  const safe = (typeof name === 'string' && name)
    ? basename(name).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file'
    : 'file';
  return `${tag}-${safe}`;
}

/**
 * Download a single Slack private file into slackFilesDir() using the bot token.
 * Returns the local path on success, null on any failure (size limit, network, etc.).
 * The bot token is used only in the Authorization header and is NEVER logged.
 */
function downloadSlackFile(
  file: SlackEventFile,
  botToken: string,
  destDir: string
): Promise<{ path: string; name: string; mimetype: string } | null> {
  return new Promise((resolve) => {
    const tag = randomBytes(4).toString('hex');
    const filename = sanitizeSlackFilename(file.name, tag);
    const destPath = join(destDir, filename);
    const name = file.name ?? filename;
    const mimetype = file.mimetype ?? 'application/octet-stream';

    try {
      mkdirSync(destDir, { recursive: true });
    } catch {
      resolve(null);
      return;
    }

    let urlObj: URL;
    try {
      urlObj = new URL(file.url_private);
    } catch {
      resolve(null);
      return;
    }
    if (urlObj.protocol !== 'https:') { resolve(null); return; }

    const req = httpsRequest(
      { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET',
        headers: { authorization: `Bearer ${botToken}` } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume(); // drain response body
          resolve(null);
          return;
        }
        let written = 0;
        let aborted = false;
        const stream = createWriteStream(destPath);
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          written += chunk.length;
          if (written > SLACK_FILE_MAX_BYTES) {
            aborted = true;
            stream.destroy();
            try { unlinkSync(destPath); } catch { /* best-effort cleanup */ }
            res.destroy();
            resolve(null);
            return;
          }
          stream.write(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          stream.end(() => resolve({ path: destPath, name, mimetype }));
        });
        res.on('error', () => { stream.destroy(); resolve(null); });
        stream.on('error', () => { res.destroy(); resolve(null); });
      }
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Download all raw Slack files (up to cap) and return the local-path file list.
 * Failures are silently dropped — a partial list is still useful to the agent.
 */
async function downloadSlackFiles(
  rawFiles: SlackEventFile[],
  botToken: string | undefined
): Promise<{ path: string; name: string; mimetype: string }[]> {
  if (!rawFiles.length || !botToken) return [];
  const destDir = slackFilesDir();
  const results = await Promise.all(
    rawFiles.map((f) => downloadSlackFile(f, botToken, destDir))
  );
  return results.filter((r): r is { path: string; name: string; mimetype: string } => r !== null);
}

function loadSlackDoneNotified(): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(slackDoneNotifiedPath(), 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch { /* missing/corrupt → start empty */ }
  return new Set();
}

function persistSlackDoneNotified(set: Set<string>): void {
  try { writeFileSync(slackDoneNotifiedPath(), JSON.stringify([...set])); }
  catch (e) { console.error('[slack] could not persist done-notify ledger:', e); }
}

/** Slack `chat.postMessage` errors that are permanent for this config — retrying
 *  can never make them succeed, so a failed post with one of these is recorded
 *  (not retried) to avoid flooding the log every 5s. Anything else is treated as
 *  transient and left to retry. */
const TERMINAL_SLACK_ERRORS = new Set<string>([
  'missing_scope', 'invalid_auth', 'not_authed', 'account_inactive',
  'token_revoked', 'token_expired', 'no_permission', 'channel_not_found',
  'not_in_channel', 'is_archived', 'restricted_action', 'org_login_required',
]);

/** The single in-thread summary for a finished task. Sourced from the task's
 *  result/description (falling back to the title), trimmed Slack-friendly. */
function slackDoneSummary(task: HiveTask): string {
  const body = (task.result ?? task.description ?? '').trim();
  const head = `:white_check_mark: *${task.title}*`;
  const text = body ? `${head}\n\n${body}` : head;
  return text.length > 2800 ? `${text.slice(0, 2799)}…` : text;
}

/** One observation pass over the kanban. Posts a summary for any Slack-origin
 *  task that has newly reached 'done'. Best-effort and self-guarding — it must
 *  never throw into the timer, and the bot token never leaves this function. */
async function pollSlackDoneTasks(): Promise<void> {
  if (slackDonePolling) return;
  const botToken = readConfig().slackBotToken;
  if (!botToken) return; // can't post without the token — nothing to do
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick

  const notified = slackDoneNotified ?? (slackDoneNotified = loadSlackDoneNotified());

  // First tick seeds the baseline (ids already done) and posts nothing — so we
  // only ever fire on a transition observed live this session.
  if (slackDoneBaseline === null) {
    slackDoneBaseline = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
    return;
  }
  const baseline = slackDoneBaseline;

  slackDonePolling = true;
  try {
    for (const t of tasks) {
      if (t.status !== 'done') continue;
      if (baseline.has(t.id) || notified.has(t.id)) continue; // already handled
      const slack = t.slack;
      if (!slack || !slack.channel || !slack.thread_ts) continue; // non-Slack-origin → leave alone
      // FALLBACK-ONLY: if the agent already posted a DIRECT reply into this thread
      // (loopback /reply), the human has its substantive answer — don't double-post.
      if (directlyRepliedThreads.has(slack.thread_ts)) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      // Never post a bare `:white_check_mark: *title*` with no substance: if the card
      // carries neither a result nor a description, there is nothing meaningful to
      // deliver — skip it (still under the FALLBACK contract).
      if (!(t.result ?? t.description ?? '').trim()) { notified.add(t.id); persistSlackDoneNotified(notified); continue; }
      const res = await postSlackReply({
        botToken, channel: slack.channel, thread_ts: slack.thread_ts, text: slackDoneSummary(t)
      });
      if (res.ok) {
        notified.add(t.id);
        persistSlackDoneNotified(notified); // mark-on-success → exactly one delivered reply
      } else if (res.error && TERMINAL_SLACK_ERRORS.has(res.error)) {
        // A permanent config/auth error (e.g. the bot token lacks `chat:write`)
        // will NEVER succeed — record the id so we stop hammering every tick, and
        // log the reason once. Never log the token or message body.
        notified.add(t.id);
        persistSlackDoneNotified(notified);
        console.error('[slack] done-summary post for task', t.id,
          '— giving up (terminal error:', res.error + '). Fix the Slack bot scope/permissions; later tasks post once resolved.');
      } else {
        // Transient (network / rate-limit / unknown) → leave unmarked so a later
        // tick retries. Log the id + error only; never the token or message body.
        console.error('[slack] done-summary post failed for task', t.id, '-', res.error, '(will retry)');
      }
    }
  } finally {
    slackDonePolling = false;
  }
}

/** Begin watching the kanban for Slack-origin done-transitions (idempotent). */
function startSlackDoneObserver(): void {
  if (slackDoneTimer) return;
  slackDoneNotified = loadSlackDoneNotified();
  slackDoneBaseline = null; // re-seed on the first tick of this session
  slackDoneTimer = setInterval(() => { void pollSlackDoneTasks(); }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopSlackDoneObserver(): void {
  if (slackDoneTimer) { clearInterval(slackDoneTimer); slackDoneTimer = null; }
  slackDoneBaseline = null;
}

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    // Downloads any file attachments (bot token stays in main; local paths go to IPC).
    onMessage: async (m) => {
      const localFiles = await downloadSlackFiles(
        m._rawFiles ?? [],
        readConfig().slackBotToken
      );
      // `text` stays the user's RAW Slack text → drives the readable kanban card
      // title. `autonomyPreamble` is the authoritative policy block the renderer
      // prepends ONLY to god's working instruction (his PTY prompt), keeping the
      // card title human-facing-clean. Built PER MESSAGE so the AUTONOMOUS REQUEST
      // PROTOCOL carries THIS request's concrete channel, thread_ts, and the
      // resolved helper path — god hands the worker an exact reply command.
      // Server-side so it applies to every session.
      const ipcMsg: { text: string; channel: string; ts: string; thread_ts: string; autonomyPreamble: string; files?: typeof localFiles } = {
        text: m.text, channel: m.channel, ts: m.ts, thread_ts: m.thread_ts,
        autonomyPreamble: buildAutonomousRequestProtocol(m.channel, m.thread_ts, slackReplyScriptPath())
      };
      if (localFiles.length > 0) ipcMsg.files = localFiles;
      try { liveWebContents()?.send('slack:incomingMessage', ipcMsg); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) { slackServer = null; return res; }
  if (res.url) lastSlackUrl = res.url;
  // Bring up the loopback reply endpoint (token-gated, never tunneled) and drop
  // the discovery file for the bundled helper. Best-effort: reply path being
  // unavailable must not sink ingestion.
  await startSlackReplyServer();
  // Begin watching the kanban for Slack-origin tasks that reach 'done', to post
  // their one summary reply in-thread. OUTBOUND-only; never touches ingestion.
  startSlackDoneObserver();
  analytics.trackFeature('slack_trigger');
  return res;
}

/** Start the loopback reply endpoint and write its `{ port, token }` to userData
 *  so `md-slack-reply.cjs` can reach it. The bot token is read lazily from config
 *  at reply time and never written to this file. */
async function startSlackReplyServer(): Promise<void> {
  slackReplyServer?.stop();
  const token = randomBytes(24).toString('hex');
  slackReplyServer = new SlackReplyServer({
    token,
    getBotToken: () => readConfig().slackBotToken,
    // An agent posted a DIRECT substantive reply into this thread → record it so the
    // done-summary poller skips it (the poller is a fallback, not a duplicator).
    onReplied: (thread_ts) => { directlyRepliedThreads.add(thread_ts); }
  });
  const r = await slackReplyServer.start();
  if (!r.ok || r.port === undefined) {
    console.error('[slack] reply endpoint failed to start:', r.error);
    slackReplyServer = null;
    return;
  }
  try {
    writeFileSync(slackReplyConfigPath(), JSON.stringify({ port: r.port, token }), { mode: 0o600 });
  } catch (e) {
    console.error('[slack] could not write reply config:', e);
  }
}

/** Stop and forget the Slack server (+ reply endpoint). Best-effort; safe to call
 *  when not running. The last tunnel URL is retained so Settings keeps showing it. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
  try { slackReplyServer?.stop(); } catch (e) { console.error('[slack] reply stop failed:', e); }
  slackReplyServer = null;
  stopSlackDoneObserver();
  try { if (existsSync(slackReplyConfigPath())) unlinkSync(slackReplyConfigPath()); } catch { /* noop */ }
}

// ─── Generic inbound webhook + status API (multi-endpoint) ───────────────────
/** The running generic-webhook server, or null when disabled/stopped. A PUBLIC
 *  (tunnel-forwarded) surface — secret-gated, unlike the loopback /reply. ONE
 *  server and ONE tunnel serve EVERY configured endpoint; the id in the request
 *  path picks which. Adding a webhook therefore costs no port and no tunnel, and
 *  never disturbs a caller already pointed at another endpoint's URL. */
let webhookServer: WebhookServer | null = null;
/** Last public tunnel URL handed out — retained so Settings can re-show the
 *  endpoint after a reopen (the tunnel rotates it per restart). */
let lastWebhookUrl: string | undefined;

/** Local port the shared server binds to. The port is a property of the SERVER,
 *  not of any one trigger — `webhookPort` stays the (legacy) override. */
const WEBHOOK_DEFAULT_PORT = 3849;

/** The endpoints the operator has switched on. A disabled webhook is not merely
 *  rejected at the door — it is never handed to the server, so its id does not
 *  exist on the wire and its secret is not in memory on the request path. */
function enabledWebhookEndpoints(): WebhookTrigger[] {
  return (readConfig().webhookTriggers ?? []).filter((t) => t.enabled && !!t.secret);
}

/** SHA-256 hex of a capability token. The raw token is returned to the caller
 *  exactly once (the POST response) and never persisted; only this digest lands
 *  on the kanban card, so a GET can match without the raw token ever resting. */
function hashWebhookToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** tokenHash → id of the `pending` history entry it belongs to.
 *
 *  A message the mode gate held has NO kanban card (the card is what approval
 *  creates), so this map is the only way its caller's GET can be answered — and
 *  answered HONESTLY, as "awaiting-approval" rather than a lie about queued work.
 *  It stores the token's DIGEST, never the token, exactly like the card stamp,
 *  and it is mirrored into the durable kv store so a restart doesn't 404 every
 *  caller that is still politely waiting on the operator. */
let heldWebhookTokens: Map<string, string> | null = null;
const HELD_TOKENS_KV_KEY = 'triggers.webhook.heldTokens';

function heldTokens(): Map<string, string> {
  if (heldWebhookTokens) return heldWebhookTokens;
  let stored: Record<string, string> | undefined;
  try { stored = persist.getKv<Record<string, string>>(HELD_TOKENS_KV_KEY); }
  catch { stored = undefined; }
  const entries = stored && typeof stored === 'object' ? Object.entries(stored) : [];
  heldWebhookTokens = new Map(entries.filter((e): e is [string, string] => typeof e[1] === 'string'));
  return heldWebhookTokens;
}

function persistHeldTokens(): void {
  try { persist.setKv(HELD_TOKENS_KV_KEY, Object.fromEntries(heldTokens())); }
  catch (e) { console.error('[webhook] could not persist held-token map:', e); }
}

/** Drop mappings whose history entry has aged out of the (capped) ledger — the
 *  operator can no longer decide them, so their tokens are dead weight. */
function pruneHeldTokens(): void {
  const map = heldTokens();
  if (map.size === 0) return;
  const live = new Set(listTriggerHistory().map((e) => e.id));
  let changed = false;
  for (const [hash, entryId] of [...map]) {
    if (!live.has(entryId)) { map.delete(hash); changed = true; }
  }
  if (changed) persistHeldTokens();
}

/** The token digest a held history entry was accepted under, if we still have it. */
function heldTokenHashFor(entryId: string): string | undefined {
  for (const [hash, id] of heldTokens()) if (id === entryId) return hash;
  return undefined;
}

/** Tell the Triggers tab its ledger moved, so history live-refreshes instead of
 *  waiting for the operator to re-open the tab. */
function notifyTriggerHistoryUpdated(): void {
  try { liveWebContents()?.send('triggerHistory:updated'); } catch { /* window gone */ }
}

/**
 * Create the stamped kanban card for an inbound message and route it to god.
 *
 * Split out of `handleWebhookMessage` because the APPROVAL path takes exactly
 * this route later — an operator saying yes must produce the same card and the
 * same god request an auto-allowed message would have, or the two paths drift
 * and "approved" quietly means something weaker than "allowed".
 *
 * Returns false only when the card — the thing the caller polls — could not be
 * written. The god routing is best-effort: the card already exists and is
 * pollable even if the send hiccups.
 */
function dispatchWebhookWork(arg: {
  taskId: string;
  title: string;
  message: string;
  /** Stamped onto the card so a GET can match the caller's token. */
  tokenHash?: string;
  /** 'webhook' | 'org' — only for the subject line and the god-facing note. */
  origin: 'webhook' | 'org';
}): boolean {
  try {
    const card: HiveTask = {
      id: arg.taskId,
      title: arg.title,
      description: arg.message,
      status: 'todo',
      dependsOn: [],
      priority: 1,
      createdAt: new Date().toISOString(),
      ...(arg.tokenHash ? { webhook: { tokenHash: arg.tokenHash } } : {})
    };
    // addTask appends against the latest on-disk ledger and is idempotent by task
    // id, so a concurrent card writer (Slack, god, voice, another webhook) can't
    // have its card lost to our stale whole-ledger overwrite. (writeTasks(...existing)
    // recreated exactly that race.) A fresh taskId never collides, so this always adds.
    hive.addTask(card, 'webhook');
  } catch (e) {
    console.error('[webhook] could not create task card:', e instanceof Error ? e.message : e);
    return false;
  }
  // Body carries ONLY the sender's message + the card id (so whoever finishes it
  // updates that card's status/result for the caller's GET) — never the secret,
  // never the raw token.
  try {
    hive.send({
      to: 'god',
      act: 'request',
      subject: `[${arg.origin}] ${arg.title}`,
      body: `${arg.message}\n\n(Inbound via the generic ${arg.origin} API, tracked as kanban card ${arg.taskId}. When this work is finished, set that card's status to 'done' and fill its 'result' so the caller's status check reflects the outcome.)`,
      requires_reply: false
    }, 'webhook');
  } catch (e) {
    console.error('[webhook] could not route to god:', e instanceof Error ? e.message : e);
  }
  return true;
}

/**
 * A verified POST, run through the endpoint's TriggerMode.
 *
 * `isAutoAllowed(mode, kind)` is the whole gate. When it says yes this behaves
 * exactly as the single-endpoint server always did — card, god request, capability
 * token. When it says no NOTHING reaches the hive: the message is written to the
 * ledger as `pending` and sits there until the operator decides, and the caller
 * is handed its token plus a 202 so it can watch the hold rather than believe
 * work started.
 *
 * Either way an `inbound` history row is recorded. The secret never reaches here
 * (the server hands over `{id,name}` only) and no credential is ever written to
 * the ledger.
 */
function handleWebhookMessage(msg: WebhookInbound, endpoint: WebhookEndpointRef): WebhookDispatch | null {
  // 192-bit unguessable token, returned once; only its hash is stored.
  const token = randomBytes(24).toString('hex');
  const tokenHash = hashWebhookToken(token);
  const full = msg.title ?? msg.message;
  const title = full.length > 80 ? `${full.slice(0, 79)}…` : full;

  const trigger = (readConfig().webhookTriggers ?? []).find((t) => t.id === endpoint.id);
  // An endpoint that vanished between the request and this lookup falls back to
  // the STRICTEST mode, never the most permissive one.
  const mode: TriggerMode = trigger?.mode ?? DEFAULT_TRIGGER_MODE;
  // The caller's own declaration wins; `classifyInboundKind` is the conservative
  // guess for callers that don't declare (it leans 'directive' on purpose).
  const kind: InboundKind = msg.kind ?? classifyInboundKind(msg.message);
  const peer = msg.from?.trim() || endpoint.name || endpoint.id;
  // Minted here, not derived from the task id, because a HELD message has no task
  // id yet and must still be pairable with the reply it eventually earns.
  const correlationId = randomBytes(8).toString('hex');

  const base = {
    source: 'webhook' as const,
    sourceId: endpoint.id,
    sourceName: endpoint.name,
    direction: 'inbound' as const,
    peer,
    title,
    body: msg.message,
    kind,
    correlationId
  };

  if (!isAutoAllowed(mode, kind)) {
    const entry = appendTriggerHistory({ ...base, decision: 'pending' });
    heldTokens().set(tokenHash, entry.id);
    persistHeldTokens();
    notifyTriggerHistoryUpdated();
    return { token, pending: true };
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  if (!dispatchWebhookWork({ taskId, title, message: msg.message, tokenHash, origin: 'webhook' })) return null;
  appendTriggerHistory({ ...base, decision: 'auto-allowed', taskId });
  notifyTriggerHistoryUpdated();
  return { token, taskId, pending: false };
}

/** Resolve a capability token to its task's public status — scoped to the ONE
 *  card (or the ONE held message) whose stored hash matches; never lists or leaks
 *  any other task. Returns null for any non-match (the server answers 404 either
 *  way, so a probe can't tell "unknown" from "malformed"). */
function lookupWebhookStatus(token: string): WebhookTaskStatus | null {
  const hash = hashWebhookToken(token);

  // Held messages first — they have no card, and the O(1) hit keeps the common
  // "still waiting" poll off the task scan entirely.
  const heldEntryId = heldTokens().get(hash);
  if (heldEntryId) {
    const entry = listTriggerHistory().find((e) => e.id === heldEntryId);
    if (!entry) { heldTokens().delete(hash); persistHeldTokens(); return null; }
    if (entry.decision === 'pending') {
      return { status: 'awaiting-approval', title: entry.title ?? '' };
    }
    if (entry.decision === 'rejected') {
      return { status: 'rejected', title: entry.title ?? '' };
    }
    // Approved: the release stamped this hash onto a real card, so fall through.
  }

  const wanted = Buffer.from(hash);
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return null; }
  for (const t of tasks) {
    const h = t.webhook?.tokenHash;
    if (!h) continue;
    const have = Buffer.from(h);
    // Both are fixed-length sha-256 hex; compare in constant time defensively.
    if (have.length === wanted.length && timingSafeEqual(have, wanted)) {
      return { status: t.status, title: t.title, result: t.result };
    }
  }
  return null;
}

// ─── Webhook done-observer (the OUTBOUND half of the trigger ledger) ─────────
// Mirrors `pollSlackDoneTasks`: watch the kanban for webhook-origin cards that
// reach 'done' and write the reply side of the conversation, tagged with the
// inbound row's correlationId so the UI can pair request ↔ response.
//
// Unlike the Slack poller there is no "baseline" of already-done ids: the LEDGER
// is the record of what we've already paired, so a card that finished while the
// app was closed still gets its outbound row on the next boot, and re-seeding
// from the ledger makes a duplicate impossible.
let webhookDoneTimer: ReturnType<typeof setInterval> | null = null;
let webhookOutboundRecorded: Set<string> | null = null;

function seedWebhookOutbound(): Set<string> {
  const seen = new Set<string>();
  try {
    for (const e of listTriggerHistory()) {
      if (e.direction === 'outbound' && e.taskId) seen.add(e.taskId);
    }
  } catch { /* unreadable ledger → treat as empty; appends are still deduped by taskId */ }
  return seen;
}

function pollWebhookDoneTasks(): void {
  let tasks: HiveTask[];
  try {
    const ledger = hive.tasks() as { tasks?: HiveTask[] };
    tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  } catch { return; } // unreadable/missing tasks.json → skip this tick
  const done = tasks.filter((t) =>
    t.status === 'done' && (t.webhook != null || t.id.startsWith('webhook-')));
  if (done.length === 0) return;
  const recorded = webhookOutboundRecorded ?? (webhookOutboundRecorded = seedWebhookOutbound());
  const fresh = done.filter((t) => !recorded.has(t.id));
  if (fresh.length === 0) return;

  const history = listTriggerHistory();
  let wrote = false;
  for (const t of fresh) {
    const inbound = history.find((e) => e.direction === 'inbound' && e.taskId === t.id);
    // No inbound row = a card from before the ledger existed. Nothing to pair it
    // with, so mark it handled rather than writing a half of a conversation.
    if (!inbound) { recorded.add(t.id); continue; }
    appendTriggerHistory({
      source: inbound.source,
      sourceId: inbound.sourceId,
      sourceName: inbound.sourceName,
      direction: 'outbound',
      peer: inbound.peer,
      title: t.title,
      body: (t.result ?? '').trim() || '(finished with no result recorded)',
      kind: inbound.kind,
      correlationId: inbound.correlationId,
      taskId: t.id
    });
    recorded.add(t.id);
    wrote = true;
  }
  if (wrote) notifyTriggerHistoryUpdated();
}

/** Begin watching the kanban for webhook-origin done-transitions (idempotent). */
function startWebhookDoneObserver(): void {
  if (webhookDoneTimer) return;
  webhookOutboundRecorded = seedWebhookOutbound();
  webhookDoneTimer = setInterval(() => {
    try { pollWebhookDoneTasks(); } catch (e) { console.error('[webhook] done-observer:', e); }
  }, 5000);
}

/** Stop watching the kanban. Safe to call when not running. */
function stopWebhookDoneObserver(): void {
  if (webhookDoneTimer) { clearInterval(webhookDoneTimer); webhookDoneTimer = null; }
  webhookOutboundRecorded = null;
}

/** Build the shared WebhookServer from the enabled endpoints and start it. A
 *  server that is already up is RE-POINTED rather than restarted (see
 *  `reconcileWebhookServer`): restarting would mint a fresh tunnel URL and break
 *  every other endpoint's caller. The public tunnel is opened only here — never
 *  on a default; a webhook reaches the wire only once the operator enables it. */
async function startWebhookServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) return { ok: false, error: 'no enabled webhook endpoints' };
  if (webhookServer) {
    webhookServer.setEndpoints(endpoints);
    return { ok: true, url: webhookServer.publicUrl() ?? lastWebhookUrl };
  }
  pruneHeldTokens();
  const cfg = readConfig();
  const server = new WebhookServer({
    port: cfg.webhookPort && cfg.webhookPort > 0 ? cfg.webhookPort : WEBHOOK_DEFAULT_PORT,
    endpoints,
    onMessage: handleWebhookMessage,
    lookupStatus: lookupWebhookStatus
  });
  webhookServer = server;
  const res = await server.start();
  // ok:false covers BOTH "never bound the port" (fatal → drop the instance) and
  // "bound fine, tunnel unavailable" (the security boundary is live and must stay
  // reachable/stoppable — dropping it there would leak an unstoppable listener).
  if (!res.ok && !server.listening()) { webhookServer = null; return res; }
  analytics.trackFeature('webhook_trigger');
  if (res.url) lastWebhookUrl = res.url;
  startWebhookDoneObserver();
  return res;
}

/** Bring the running server in line with config after any webhook mutation.
 *  Live endpoint swap when it's up, start when the enabled set becomes non-empty,
 *  stop when it empties. Never restarts a healthy server. */
function reconcileWebhookServer(): void {
  const endpoints = enabledWebhookEndpoints();
  if (endpoints.length === 0) { stopWebhookServer(); return; }
  if (webhookServer) { webhookServer.setEndpoints(endpoints); return; }
  void startWebhookServer().then((r) => {
    if (!r.ok) console.error('[webhook] start failed:', r.error);
    else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
  });
}

/** Per-endpoint public URLs for the settings surface's copy button. Empty string
 *  when no tunnel has ever come up — the UI shows the endpoint, just not a URL
 *  it could hand out yet. */
function webhookEndpointUrls(): { id: string; url: string }[] {
  const base = (webhookServer?.publicUrl() ?? lastWebhookUrl ?? '').replace(/\/+$/, '');
  return (readConfig().webhookTriggers ?? []).map((t) => ({
    id: t.id,
    url: base ? `${base}/${encodeURIComponent(t.id)}` : ''
  }));
}

/** Stop and forget the webhook server. Best-effort; safe when not running. The
 *  last tunnel URL is retained so Settings keeps showing it. */
function stopWebhookServer(): void {
  try { webhookServer?.stop(); } catch (e) { console.error('[webhook] stop failed:', e); }
  webhookServer = null;
  // The done-observer deliberately OUTLIVES the server (it is a ledger concern,
  // not a transport one) — it is torn down with the process/hive, not here.
}

/** The persisted main-window geometry (kv key `window.bounds`). */
interface WindowBounds { x?: number; y?: number; width: number; height: number }

const DEFAULT_WIN = { width: 1440, height: 900 };
const MIN_WIN = { width: 1280, height: 800 };

/** Validate + clamp restored bounds: enforce the minimum size, and drop a
 *  position that no longer lands on any connected display (monitor unplugged) so
 *  the window can't open off-screen. Returns null for unusable input. */
function clampBounds(b: unknown): WindowBounds | null {
  if (!b || typeof b !== 'object') return null;
  const r = b as Partial<WindowBounds>;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  // Keep the position only if the window rect overlaps some display's work area.
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

/** Minimal trailing-edge debounce for the move/resize flood. */
function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | null = null;
  return () => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
}

/** Cascade a new floor off the focused window so it doesn't stack exactly on
 *  top, clamped on-screen (clampBounds drops an off-display position). */
function floorCascade(): WindowBounds | null {
  const base = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow
    : [...allWindows].find((w) => !w.isDestroyed());
  if (!base) return null;
  const b = base.getBounds();
  const OFFSET = 36;
  return clampBounds({ x: b.x + OFFSET, y: b.y + OFFSET, width: b.width, height: b.height });
}

// ─── Shareable hires: munderdifflin:// deep link + file import ──────────────
// A hire manifest NEVER auto-spawns: it is validated, then handed to the
// renderer, which pre-fills the Add-Agent modal for human review. See
// src/shared/hire.ts for the spec + security model.

/** Manifests that arrived before the renderer was ready to receive them.
 *  The renderer PULLS these via hire:drainPending once its subscription is
 *  mounted — main never pushes blind, so a fast-loading packaged renderer
 *  can't lose a deep link to a startup race. */
const pendingHires: HireManifest[] = [];
let rendererReadyForHires = false;

function deliverHire(manifest: HireManifest): void {
  // MUNDER_HIDDEN (dev only): surfaceWindow never shows or focuses the window of a hidden run.
  if (rendererReadyForHires && mainWindow && !mainWindow.isDestroyed()) {
    surfaceWindow(mainWindow, { show: true, focus: true });
    mainWindow.webContents.send('hire:import', manifest);
  } else {
    pendingHires.push(manifest);
    surfaceWindow(mainWindow, { show: true, focus: true });
  }
}

async function handleHireLink(link: string): Promise<void> {
  const src = parseHireDeepLink(link);
  if (!src) { console.warn('[hire] ignoring malformed deep link'); return; }
  const res = await fetchHireManifest(src);
  if (!res.ok) {
    console.error('[hire] deep link rejected:', res.error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('hire:error', { error: res.error });
    }
    return;
  }
  deliverHire(res.manifest);
  analytics.trackFeature('hire_install');
}

// Register the protocol. In dev (electron .) Windows needs the explicit
// exe+args form or the registration points at electron.exe with no entry.
// MUNDER_DEV=1 skips this entirely: the registration is a per-user registry
// write that would re-point Stable's `munderdifflin://` links at the dev
// electron.exe (a Stable-identity side effect the dev build must not have).
if (DEV_ISOLATION) {
  console.warn('[dev-isolation] not registering the munderdifflin:// protocol handler (would hijack Stable)');
} else if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('munderdifflin', process.execPath, [resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('munderdifflin');
}

// Deep links on Windows/Linux arrive as the argv of a SECOND process — take the
// single-instance lock and forward them to the running instance. (macOS gets
// the 'open-url' event instead.) The lock also rules out two harnesses fighting
// over the same hive, which was previously possible but never useful.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  allowQuit = true;
  // MUNDER_DEV=1: exit NOW. `app.quit()` is asynchronous and v0.4.5's
  // `whenReady` bootstrap still runs before the quit completes — observed on
  // 2026-09-10: a second DEV instance logged `app-start` into the DEV hive and
  // tried to bind the DEV hook pipe (EADDRINUSE) before exiting. Harmless in
  // DEV but noisy for validation; `app.exit` skips the bootstrap entirely.
  // (Baseline behaviour is left as-is when MUNDER_DEV is unset.)
  if (DEV_ISOLATION) {
    console.error('[dev-isolation] another DEV instance already holds the single-instance lock — exiting (96)');
    app.exit(96);
  }
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    surfaceWindow(mainWindow, { restore: true, focus: true });   // MUNDER_HIDDEN: never restore or focus
    const link = argv.find((a) => a.startsWith('munderdifflin://'));
    if (link) void handleHireLink(link);
  });
}

app.on('open-url', (evt, url) => {
  evt.preventDefault();
  void handleHireLink(url);
});

// IPC: the renderer signals readiness and PULLS anything queued (deep links
// that arrived before the window/subscription existed, incl. cold starts).
ipcMain.handle('hire:drainPending', () => {
  rendererReadyForHires = true;
  const out = pendingHires.splice(0, pendingHires.length);
  return out;
});

// IPC: "import hires…" file picker in the Add-Agent modal. Every selected file
// is validated independently; valid neighbours survive an invalid manifest.
ipcMain.handle('hire:openFile', async () => {
  if (DEV_HIDDEN) return { ok: false, manifests: [], errors: [], error: 'cancelled' };   // MUNDER_HIDDEN: no dialog
  const res = await dialog.showOpenDialog({
    title: 'Import hire manifests',
    filters: [{ name: 'Hire manifest', extensions: ['json'] }],
    properties: ['openFile', 'multiSelections']
  });
  if (res.canceled || res.filePaths.length === 0) {
    return { ok: false, manifests: [], errors: [], error: 'cancelled' };
  }
  const batch = readHireManifestFiles(res.filePaths);
  return {
    ok: batch.manifests.length > 0,
    ...batch,
    error: batch.manifests.length === 0 ? 'no valid hire manifests selected' : undefined
  };
});

/**
 * Create a window. The PRIMARY window (no opts) restores saved geometry, uses
 * the default session, runs the hive, and keeps the existing app-quit warning.
 * A FLOOR window (`{ floor: true }`) gets its own persistent session partition
 * — isolating its renderer state (agents/queues/selection) from every other
 * window — cascades its position, and on close stops only its OWN terminals
 * while the app keeps running.
 */
function createWindow(opts: { floor?: boolean; partition?: string; recovery?: RecoveryPolicy } = {}): BrowserWindow {
  const isFloor = opts.floor === true;
  // RENDERER-RECOVERY-164: a recreated floor keeps its OWN session partition (its office
  // state), and the replacement inherits the crash streak so the loop guard still counts.
  const partition = isFloor ? (opts.partition ?? `persist:floor-${++floorSeq}`) : undefined;

  // Primary restores saved geometry; floors cascade off the focused window.
  let saved: WindowBounds | null = null;
  if (!isFloor) { try { saved = clampBounds(persist.getKv('window.bounds')); } catch { saved = null; } }
  const cascade = isFloor ? floorCascade() : null;
  const geom = cascade ?? saved;

  const win = new BrowserWindow({
    width: geom?.width ?? DEFAULT_WIN.width,
    height: geom?.height ?? DEFAULT_WIN.height,
    ...(geom && geom.x !== undefined && geom.y !== undefined ? { x: geom.x, y: geom.y } : {}),
    minWidth: MIN_WIN.width,
    minHeight: MIN_WIN.height,
    title: devWindowTitle(isFloor ? 'Munder Difflin — Floor' : 'Munder Difflin'),
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Keep Chromium's OS renderer sandbox active; privileged work stays behind
      // the narrow contextBridge/IPC surface owned by the main process.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The renderer runs the hive's heartbeat loops (inbox nudge, message
      // flush, telemetry polls). Chromium throttles timers in occluded windows
      // — incl. behind the LOCK SCREEN — which silently stalls the hive while
      // the user is away. Don't.
      backgroundThrottling: false,
      // Each floor gets its OWN persistent session partition → isolated
      // localStorage so floors never share or stomp each other's office state.
      // The primary keeps the DEFAULT session so existing persisted state loads.
      ...(partition ? { partition } : {})
    }
  });

  // Capture the webContents once: after 'closed' the window is gone, but this
  // reference stays valid as the per-PTY ownership key.
  const wc = win.webContents;

  allWindows.add(win);
  watchWindowHealth(win, isFloor, { partition, policy: opts.recovery ?? new RecoveryPolicy() });
  // Global timer events follow the user — the most-recently-focused window is
  // primary. The primary is also seeded synchronously so boot events route now.
  win.on('focus', () => { mainWindow = win; });
  if (!isFloor) mainWindow = win;

  // Permission gate for the renderer (our own trusted, local content). The only
  // permission we constrain is microphone capture: it's allowed ONLY while a mic
  // feature is actually live — Free Flow dictation (`freeflowEnabled`) OR a
  // Realtime Michael voice session (`realtimeVoiceEnabled`, flipped on by the
  // session at start() before getUserMedia, off at stop()). With both flags off,
  // there's zero mic access even at the Electron layer. We deliberately do NOT
  // gate on OpenAI-key presence: that key (`apikey:openai`) is shared with the CLI
  // engines, so a CLI-only user must not have the mic gate opened. Every other
  // permission keeps the app's prior permissive behavior (e.g. clipboard for
  // xterm/editor copy must keep working).
  const micFeatureLive = (): boolean => {
    const cfg = readConfig();
    return cfg.freeflowEnabled === true || cfg.realtimeVoiceEnabled === true;
  };
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media') {
      const mediaTypes = details && 'mediaTypes' in details ? details.mediaTypes : undefined;
      const wantsAudio = !mediaTypes || mediaTypes.includes('audio');
      callback(micFeatureLive() && wantsAudio);
      return;
    }
    callback(true);
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    if (permission === 'media') return micFeatureLive();
    return true;
  });

  // Only the primary persists geometry (kv `window.bounds`); floors cascade
  // fresh each launch. Skip while maximized/minimized so a restore doesn't save
  // the fullscreen rect.
  if (!isFloor) {
    const saveBounds = debounce(() => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    }, 400);
    win.on('resized', saveBounds);
    win.on('moved', saveBounds);
    win.on('close', () => {
      if (win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
      try { persist.setKv('window.bounds', win.getBounds()); } catch { /* DB best-effort */ }
    });
  }


  // MUNDER_HIDDEN=1 under MUNDER_DEV=1 (layer-b test infrastructure): the window is
  // built with show:false and is NEVER shown, so it has no taskbar button either. CDP
  // drives it; backgroundThrottling:false (above) keeps its timers running unthrottled.
  win.once('ready-to-show', () => surfaceWindow(win, { show: true }));
  // MUNDER_DEV=1: the renderer's <title> (index.html) replaces the BrowserWindow
  // `title` option as soon as the page loads, so the DEV marker must be applied
  // to every title the page sets — that is the whole point of the marker
  // (mission item 4: the operator must be able to tell the instances apart).
  if (DEV_ISOLATION) {
    win.on('page-title-updated', (e, pageTitle) => {
      e.preventDefault();
      win.setTitle(devWindowTitle(pageTitle));
    });
  }

  // Never opens a window; hands the URL to the OS browser instead.
  //
  // Scheme-checked, because this is now reachable from AUTHOR-CONTROLLED markup:
  // a release drop's iframe has `allow-popups`, so a target="_blank" link in a
  // release body arrives here. http(s) only — an unguarded openExternal will
  // happily launch file://, or a registered custom scheme, on the user's machine.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!DEV_HIDDEN && /^https?:\/\//i.test(url)) shell.openExternal(url);   // MUNDER_HIDDEN: no browser
    return { action: 'deny' };
  });

  // Close interception when live PTYs exist. The red-X destroys the window;
  // intercept it the same way before-quit does so PTY users aren't surprised.
  win.on('close', (e) => {
    if (allowQuit) return;
    if (isFloor) {
      // A floor's close is NOT an app quit — confirm only its OWN terminals,
      // via a self-contained native dialog (no renderer modal). Confirming lets
      // the window close; its PTYs are stopped in the 'closed' handler.
      const owned = ptyManager.countByOwner(wc);
      // MUNDER_HIDDEN: no dialog; whoever closes a hidden run's floor owns that decision.
      if (owned > 0 && !DEV_HIDDEN) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning',
          buttons: ['Close floor', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          message: `Close this floor? ${owned} running terminal${owned === 1 ? '' : 's'} on it will be stopped.`,
          detail: 'Other floors keep running.'
        });
        if (choice === 1) e.preventDefault();
      }
      return;
    }
    // Primary window: existing app-wide quit warning (renderer modal).
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    // Jim RR-164 (2): the quit warning is a modal in the renderer; if that renderer is gone
    // (crashed, recovery given up), ask natively instead of waiting on nothing.
    if (rendererGone(wc)) { quitOrCancelNatively(count, win); return; }
    surfaceWindow(win, { focus: true });   // MUNDER_HIDDEN: never focus
    wc.send('app:closeRequested', { ptyCount: count });
  });

  // The primary is the default PTY sink; floors route purely by per-PTY owner.
  if (!isFloor) ptyManager.attachWebContents(wc);

  // A main-frame reload unmounts the renderer's hire subscription — queue again
  // until the fresh renderer drains. Guard on isMainFrame: a stray sub-frame
  // navigation must NOT flip readiness off (the renderer only drains on mount,
  // so a later deep link would otherwise queue and sit until a full reload).
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame) return;
    rendererReadyForHires = false;
    // RENDERER-RECOVERY-164: the fresh renderer re-subscribes on mount.
    try { capacityDetailTicker.closed(wc.id); } catch { /* not started */ }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  win.on('closed', () => {
    allWindows.delete(win);
    // A closed floor must not leave its terminals running headless. (Natural
    // onExit teardown — archive + worktree cleanup — still runs per PTY.)
    if (isFloor) { try { ptyManager.killByOwner(wc); } catch { /* best-effort */ } }
    if (mainWindow === win) {
      mainWindow = null;
      for (const w of allWindows) { if (!w.isDestroyed()) { mainWindow = w; break; } }
    }
    syncKeepAwake();
  });

  return win;
}

/** Open a new floor window — gated by the multiWindow flag. Returns the window,
 *  or null when the feature is off (the entry points are hidden in that case,
 *  but the IPC stays defensive). */
function openFloor(): BrowserWindow | null {
  if (!readConfig().multiWindow) return null;
  return createWindow({ floor: true });
}

/** Build + install the application menu. Only called when multiWindow is on, so
 *  flag-off keeps Electron's default menu (zero behavior change). Uses standard
 *  role-based items so copy/paste/quit/etc. work per-platform, and adds the
 *  "New Floor" item (Cmd/Ctrl+Shift+N). */
function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const newFloorItem = {
    label: 'New Floor',
    accelerator: 'CmdOrCtrl+Shift+N',
    click: () => { openFloor(); }
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: isMac
        ? [newFloorItem, { type: 'separator' as const }, { role: 'close' as const }]
        : [newFloorItem, { type: 'separator' as const }, { role: 'quit' as const }]
    },
    // The Edit menu is spelled out rather than `{ role: 'editMenu' }` for one
    // reason: `registerAccelerator: false` on the clipboard items.
    //
    // A registered accelerator is claimed by the MENU, which then replays the
    // action through `webContents.paste()` — an async hop that runs a beat after
    // the keystroke. Dictation tools (Muesli, Wispr Flow, …) insert text by
    // stashing the clipboard, writing the transcript, sending the paste key, and
    // restoring the old clipboard immediately; the menu's late paste therefore
    // read the RESTORED clipboard and typed the user's previous copy instead of
    // what they had just said. It hit the terminal and the composer alike,
    // because both were downstream of the same replay.
    //
    // With registerAccelerator false the item still shows its shortcut, but the
    // key is left for the focused element to handle inline — xterm's own paste
    // handler and the textarea's native paste event both read the clipboard
    // synchronously, inside the keystroke, before any restore can land.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const, registerAccelerator: false },
        { role: 'redo' as const, registerAccelerator: false },
        { type: 'separator' as const },
        { role: 'cut' as const, registerAccelerator: false },
        { role: 'copy' as const, registerAccelerator: false },
        { role: 'paste' as const, registerAccelerator: false },
        { role: 'selectAll' as const, registerAccelerator: false }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
/** CODEX-BLOAT-165 fix 1: should this automatic Codex resume start a fresh thread instead?
 *  Logs a `codex-thread-rotated` row when it does. Any read failure keeps the old behaviour. */
function rotateCodexThread(agentId: string, sid: string, ownerHome: string): boolean {
  try {
    const info = findCodexRollout(ownerHome, sid);
    if (!info) return false;
    const d = decideThreadRotation(info, Date.now(), CODEX_ROTATE_MAX_ROLLOUT_BYTES);
    if (!d.rotate) return false;
    hive.appendLog(threadRotatedLogRow(agentId, 'codex', sid, d));
    console.log(`[resume] ${agentId}: codex thread ${sid} rotated (${d.reason}, ${d.bytes} bytes); starting fresh`);
    return true;
  } catch (e) {
    console.warn('[resume] codex rotation check failed; resuming:', e);
    return false;
  }
}

/** Codex stores its rollout transcripts under a PER-AGENT CODEX_HOME
 *  (<hive>/agents/<id>/.codex/sessions/<Y>/<M>/<D>/rollout-*-<sessionId>.jsonl).
 *  A NEWLY added agent gets an empty CODEX_HOME, so `codex resume <sid>` finds
 *  nothing and silently opens a BLANK session — which is exactly what the Add
 *  Agent "resume session" field looked like it was doing. Find the agent whose
 *  CODEX_HOME owns this rollout and RETURN that home so the resumed agent can be
 *  pointed at it (the rollout AND its state_5.sqlite index live there together). */
function findCodexHomeForSession(sessionId: string, siblingsRoot: string): string | null {
  try {
    if (!sessionId || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(sessionId)) return null;
    let fallbackHome: string | null = null;
    // Walk each sibling agent's CODEX_HOME (<agent>/.codex) looking for the
    // rollout that owns this session. We RETURN that home rather than copy the
    // rollout out of it: Codex indexes sessions in its state_5.sqlite, so a lone
    // rollout file in a fresh home is invisible to `codex resume`. Pointing the
    // resumed agent at the OWNING home gives it the rollout AND the index.
    let agents: Array<{ name: string; isDirectory(): boolean }>;
    try {
      agents = readdirSync(siblingsRoot, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
    } catch { return null; }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const home = join(siblingsRoot, a.name, '.codex');
      const sessions = join(home, 'sessions');
      if (!existsSync(sessions)) continue;
      const stack = [sessions];
      let hasRollout = false;
      while (stack.length && !hasRollout) {
        const d = stack.pop() as string;
        let ents: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          ents = readdirSync(d, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        } catch { continue; }
        for (const e of ents) {
          const pth = join(d, e.name);
          if (e.isDirectory()) stack.push(pth);
          else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) { hasRollout = true; break; }
        }
      }
      if (!hasRollout) continue;
      // Prefer the home whose Codex state DB actually INDEXES this session — a
      // fresh/seeded home may carry only a stray rollout copy (no index), which
      // `codex resume` can't open. Match the id as raw bytes in state_5.sqlite
      // (+ its WAL). Homes with the rollout but no index are a last-resort fallback.
      const idBuf = Buffer.from(sessionId);
      let indexed = false;
      for (const db of ['state_5.sqlite', 'state_5.sqlite-wal']) {
        try { if (readFileSync(join(home, db)).includes(idBuf)) { indexed = true; break; } } catch { /* no db */ }
      }
      if (indexed) return home;
      if (!fallbackHome) fallbackHome = home;
    }
    return fallbackHome;
  } catch (e) {
    console.error('[resume] findCodexHomeForSession failed:', e);
    return null;
  }
}

/** Spawn options shared by the `pty:spawn` IPC handler and the god-triggered
 *  ephemeral-worker watcher. */
type AgentSpawnOptions = SpawnOptions & { hive?: AgentMeta; isolate?: boolean; resume?: boolean; requireResume?: boolean; resumeSessionId?: string; provider?: AgentProvider; noAutoInstall?: boolean; startFresh?: boolean };

ipcMain.handle('pty:spawn', async (evt, opts: AgentSpawnOptions) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Record the spawning window as the PTY's owner so its output routes ONLY back
  // to that floor, then run the shared spawn core.
  const owner = BrowserWindow.fromWebContents(evt.sender)?.webContents ?? null;
  // Refused up front during a reset/changeHome (no worktree or hive provisioning either);
  // PtyManager.spawn refuses too, for every other door.
  if (ptyManager.shutdownReason !== null) return { ok: false, error: ptyManager.shutdownReason };
  return spawnAgentCore(opts, owner);
});

/** Core agent-spawn logic — provider inference, the missing-CLI installer
 *  short-circuit, git-worktree isolation, hive provisioning, model/resume flags,
 *  and the final PTY spawn. Extracted VERBATIM from the `pty:spawn` IPC handler so
 *  it can ALSO be invoked by the god-triggered ephemeral-worker watcher (which has
 *  no renderer `evt`). `owner` is the window that should receive this PTY's output
 *  (null → the primary window). Behavior-identical to the prior inline handler. */
async function spawnAgentCore(opts: AgentSpawnOptions, owner: Electron.WebContents | null): Promise<{ ok: boolean; error?: string; codexLayerOptIn?: string; cwd?: string; worktreePath?: string; resumeNotFound?: boolean; resumed?: boolean; seedPrompt?: string }> {
  // ── cwd INGESTION — expand `~` exactly once, here ───────────────────────────
  // This is the single door every agent spawn comes through (`pty:spawn` IPC and
  // the god-triggered ephemeral-worker watcher), so it is where a user-typed
  // `~/dev/foo` becomes an absolute path. Only a shell expands `~`; Node treats it
  // as a literal dir, so without this every downstream existsSync/statSync fails
  // with `cwd does not exist`. Expanding BEFORE hive provisioning is what makes the
  // registry store an ABSOLUTE cwd (and `cwdValid: true`). The resolved value is
  // returned to the caller so the renderer records the same absolute path.
  opts.cwd = expandTilde(opts.cwd);
  if (opts.hive) opts.hive = { ...opts.hive, cwd: expandTilde(opts.hive.cwd) };
  // Which CLI is this? Explicit wins; else inferred from the binary
  // (claude/codex/grok/agy). Non-Claude providers skip every Claude-only spawn step
  // below. Persist the resolved provider onto opts (+ hive meta) so the registry
  // record and downstream provider-aware steps agree on one value.
  const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
  const claudeProvider = isClaudeProvider(provider);
  opts.provider = provider;
  if (opts.hive) opts.hive = { ...opts.hive, provider };
  // ── Missing engine CLI → run its installer visibly (pre-spawn) ───────────────
  // If the agent's engine binary (claude/codex/…) isn't installed, spawning it
  // just dies with "— process exited (code 1) —" and the user has no idea why.
  // Detect the absent binary BEFORE spawning and, in this SAME terminal, print a
  // banner + RUN the provider's install command so the user can watch it (and
  // complete any interactive sign-in). On a CLEAN install exit the PTY-exit handler
  // auto restart-and-continues — it re-runs THIS spawn (with noAutoInstall) so the
  // freshly-installed CLI launches in the SAME pty/window, no user click. STRICTLY
  // pre-spawn: a non-zero exit from a CLI that DID start never reaches here, so there
  // is no install loop; and the relaunch's noAutoInstall guarantees the installer
  // can't fire twice. Providers with no known installer get a manual hint only (and
  // are NOT armed for relaunch) — nothing arbitrary is ever auto-run. We short-circuit
  // BEFORE worktree/hive/Claude-flag setup: ptyToAgent + worktreePaths stay unset for
  // this id, so when the install PTY exits teardownPty is a harmless no-op (the agent
  // isn't archived and no worktree is torn down) before the relaunch takes over.
  {
    const bin = opts.command.trim().split(/\s+/)[0] || opts.command;
    // USER-initiated check (Jim's audit CHANGE 2): never trust a cached miss here - a CLI the user
    // just installed by hand must be seen now, not after the 60 s miss TTL. Background checks keep it.
    if (bin && !opts.noAutoInstall) invalidateCommandCache(bin);
    // RESOLVER-TIMEOUT-MISS: only a KNOWN miss runs the installer. A lookup killed by its time box
    // (a loaded machine; retried once by the resolver) is 'unknown': the spawn goes ahead, and a CLI
    // that really is absent then fails visibly. It never runs `npm install -g` over an install.
    const binAction = missingCliAction(bin && !opts.noAutoInstall ? await ptyManager.commandStatus(bin) : 'found');
    if (binAction === 'log-and-proceed') { try { hive.appendLog({ kind: 'cli-lookup-unknown', command: bin, at: 'spawn', id: opts.id }); } catch { /* best-effort */ } }
    if (binAction === 'install') {
      // The installer commands are `npm install -g …`. Probe for npm the same way
      // we probe for the engine CLI, so a no-Node machine gets the node-free rung
      // (or an honest manual hint) instead of watching `npm: not found` scroll by.
      // An npm whose Node is BELOW the floor counts as unavailable: founder rule
      // (2026-08-07) is "their Node newer than ours → leave it alone; absent or
      // older → install the latest stable for them".
      invalidateCommandCache('npm');
      invalidateCommandCache('node');
      // RESOLVER-TIMEOUT-MISS: an npm or node lookup that timed out is unknown, not absent: keep the
      // plain npm rung rather than fetch and install Node over what may be a working one.
      const npmRung = npmRungDecision(await ptyManager.commandStatus('npm'), await ptyManager.commandStatus('node'));
      const npmAvailable = npmRung === 'available'
        || (npmRung === 'check-node-version' && nodeIsUsable(await detectNodeVersion(await ptyManager.commandPath('node'))));
      // Only reach the network when we actually need to (npm missing/too old);
      // resolveNodeInstaller is timeout-bounded and returns null offline, which
      // simply drops the ladder to the native/manual rung.
      const nodeInstaller = npmAvailable ? null : await resolveNodeInstaller();
      const rung = chooseInstallRung(installInfoForProvider(provider), npmAvailable, nodeInstaller);
      const res = await ptyManager.spawn(
        {
          id: opts.id,
          cwd: opts.cwd,
          command: bin,
          cols: opts.cols,
          rows: opts.rows,
          shellScript: buildMissingCliScript(bin, provider, npmAvailable, process.platform, nodeInstaller)
        },
        owner
      );
      // Arm auto restart-and-continue: when this installer PTY exits cleanly, the
      // exit handler re-runs the spawn so the just-installed CLI launches in place
      // (no user click). Only when an installer actually RAN (a provider with no
      // bundled installer just prints a manual hint and exits 0 — relaunching there
      // would spawn the still-missing binary and die) and the PTY actually started.
      // …keyed on the RUNG, not on `installCommand`: the manual rung prints a hint
      // and exits 0, and relaunching there would just respawn the still-missing
      // binary and die with the bare "process exited (code 1)" this whole path exists
      // to replace.
      if (res.ok && rung.command) {
        pendingInstallRelaunch.set(opts.id, { opts, owner, bin });
      }
      syncKeepAwake();
      return res;
    }
  }
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  // NOTE (tracked, not yet hardened): the restore flow passes isolate:false and
  // re-enters the existing worktree by cwd, so it never reaches here. But a stale
  // `isolate:true` recipe spawned against an already-existing worktree path would
  // make addWorktree below conflict (path/branch exists) and fall back to the base
  // cwd — reuse-existing-worktree handling here is the follow-up.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(readConfig().harnessHome ?? origCwd, 'worktrees');
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // Proxy-tier CLIs (qwen/crush) route their LLM traffic through a loopback sidecar
  // whose UPSTREAM is read from the preset's bridge.baseUrlEnv inside hive.ensureAgent.
  // For the local-LLM path, feed the user's configured base URL as that upstream so the
  // proxy forwards to their endpoint (Ollama/LM Studio/vLLM). Set on process.env BEFORE
  // ensureAgent reads it. (Crush's baseUrlEnv is an inert sentinel used ONLY as this
  // upstream source; its real routing is the per-agent CRUSH_GLOBAL_CONFIG base_url.)
  if (opts.hive && (provider === 'crush' || provider === 'qwen')) {
    const bridge = providerPreset(provider).bridge;
    const baseUrl = readConfig().providerBaseUrls?.[provider];
    if (bridge && bridge.kind === 'proxy' && baseUrl) process.env[bridge.baseUrlEnv] = baseUrl;
  }
  // If the agent carries hive metadata, provision its workspace and add
  // provider-specific spawn injection. Non-Claude providers get shared AGENT_*
  // env only; Claude Code also gets prompt/settings hook args.
  // Protocol seed that must be TYPED into a bare TUI after boot (Crush —
  // seedDelivery:'type-into-tui') rather than passed on argv. Surfaced in the spawn
  // result so the renderer types it through the per-pty write-chain. (ondev-b)
  let seedPrompt: string | undefined;
  // `pathPrepend` is main's alone (the memory command's dir); never taken from the renderer.
  opts.pathPrepend = undefined;
  // MODEL-PINBACK: the model this spawn really runs. The renderer's `--model` is the request (the
  // picker); a pinned in-TUI switch replaces it while that request is unchanged (see
  // src/shared/modelPin.ts). Resolved BEFORE ensureAgent, so the registry records it and a Codex
  // agent's config.toml names it (G1). Claude with no request falls back to its app default, as
  // the Claude block below always did.
  // AGENT-MODEL-NOT-KEPT M2 (Codex): the effort travels the same way, as `-c
  // model_reasoning_effort=<e>`; the seed's effort is the no-switch default.
  let spawnModel: { requested?: string; launch?: string; requestedEffort?: string; launchEffort?: string; defaultEffort?: string } | undefined;
  if (opts.hive && hive.enabled() && (provider === 'claude' || provider === 'codex' || provider === 'antigravity')) {
    try {
      const r = resolveSpawnArgs(hive.registry().agents[opts.hive.id], opts.args ?? [], {
        flag: providerPreset(provider).modelFlag ?? '--model',
        fallback: provider === 'claude' ? modelForHiveSpawn(opts.hive, readConfig()) : undefined,
        ...(provider === 'codex' ? { effort: 'codex' as const } : {})
      });
      opts.args = r.args;
      spawnModel = {
        requested: r.requested, launch: r.launch,
        ...(provider === 'codex' ? { requestedEffort: r.requestedEffort, launchEffort: r.launchEffort, defaultEffort: hive.codexSeedEffort() } : {})
      };
    } catch (e) { console.warn('[model-pin] spawn model resolution failed:', e); }
  }
  if (opts.hive && hive.enabled()) {
    try {
      // NATIVE-MEMORY (Jim M2, fail closed): the agent's memory env is decided FIRST, and the
      // prompt's memory line is written only when the `memory` command really goes first on
      // its PATH.
      const mem = nativeMemory.spawnEnv(opts.hive.id);
      // CODEX-WAKE-161 addendum (a)+(b): log the CLI this Codex agent gets, and pin it to its
      // in-process app-server with --no-daemon. CODEX-NODAEMON-HARDENING: always, unless the CLI is
      // KNOWN to predate the flag; an unreadable version (or a failed lookup) still gets it.
      let codexNoDaemon = false;
      let codexVersion: string | null = null;
      if (provider === 'codex') {
        let cli: { path: string | null; version: string | null } = { path: null, version: null };
        try { cli = await codexCliNow(); } catch { /* unreadable: the gate fails closed (flag on) */ }
        codexVersionLog.note(cli.version, cli.path, 'spawn', opts.hive.id);
        const gate = codexNoDaemonGate(cli.version);
        codexNoDaemon = gate.noDaemon;
        if (gate.reason !== 'supported') hive.appendLog({ kind: 'codex-no-daemon', agentId: opts.hive.id, noDaemon: gate.noDaemon, reason: gate.reason, version: cli.version });
        codexVersion = cli.version ?? null;
      }
      const inj = await hive.ensureAgent(
        { ...opts.hive, cwd: opts.cwd, provider },
        {
          semanticMemory: mem !== null,
          knowledgeGraph: knowledge.active(),
          // Bake the ABSOLUTE KG CLI path into the agent's prompt. The prompt used
          // to spell it `$KG_CLI`, which is POSIX-only: under cmd.exe/PowerShell it
          // expands to nothing, so every knowledge-graph instruction was dead on a
          // Windows floor. Empty when the KG is off (the line isn't emitted then).
          kgCliPath: knowledge.env().KG_CLI,
          theme: readConfig().terminalTheme ?? 'light',
          // W3 — default-MCP consent state + the bundled skills source dir.
          mcpDefaults: readConfig().mcpDefaults,
          skillsDir: skillsResourceDir(),
          codexNoDaemon,
          // CODEX-BLOAT-165 fix 2: Settings' Codex tool output cap, into this agent's config.toml.
          codexToolOutputTokenLimit: readConfig().codexToolOutputTokenLimit,
          // CODEX-BLOAT-165 fix 5: Settings' "inherit my Codex plugins" (default off).
          codexInheritPlugins: readConfig().codexInheritPlugins === true,
          // MODEL-PINBACK: recorded on the registry entry; a Codex config.toml carries `launch`.
          spawnModel,
          // CODEX-TRUST-LAYER: the layer model is checked against this version; the folders the
          // Human allowed start (with a warning) instead of being refused.
          codexVersion,
          codexLayerOptIns: (() => { const o: unknown = readConfig().codexLayerOptIns; return Array.isArray(o) ? o.filter((k): k is string => typeof k === 'string') : []; })()
        }
      );
      // F1 FAIL-CLOSED GATE. Checked here, before ANY injection state is merged and
      // long before ptyManager.spawn: provisioning can now REFUSE to make an agent
      // safe to start, and a refusal must block the PTY rather than downgrade the
      // spawn. Returning early (rather than throwing) is what makes it survive the
      // best-effort catch below — a throw would be logged there and the spawn would
      // continue on exactly the unsafe state the refusal exists to prevent.
      if (inj.refusal) return { ok: false, error: inj.refusal, ...(inj.codexLayerOptIn ? { codexLayerOptIn: inj.codexLayerOptIn } : {}) };
      opts.args = [...(opts.args ?? []), ...inj.args];
      seedPrompt = inj.seedPrompt;
      // The `kg` CLI at the enterprise knowledge store (empty when the KG is off).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...knowledge.env() };
      // NATIVE-MEMORY: the agent's MEMORY_TOKEN, and the `memory` command's dir FIRST on its
      // one final PATH (buildPtyEnv merges it; there is never a second PATH-like key).
      if (mem) {
        opts.env = { ...opts.env, ...mem.env };
        opts.pathPrepend = [mem.commandDir];
      }
    } catch (e) {
      // POLICY: hive provisioning is best-effort IN GENERAL — an unexpected failure is
      // logged here and never blocks a spawn — EXCEPT the F1 fail-closed Codex
      // credential-migration refusal, which BLOCKS THE SPAWN BY DESIGN. That refusal is
      // deliberately RETURNED as a typed result and checked at the gate above, so it
      // never reaches this handler; converting it into a throw would land it here, get
      // logged, and let the spawn continue on the unsafe state it exists to prevent.
      // The exception is documented here, at the place someone would otherwise undo it.
      console.error('[hive] ensureAgent failed:', e);
    }
  }
  // SESSION-PROMPT-ROTATION "Start fresh": the human asked for a new conversation. Drop the
  // resume key (any provider) BEFORE the resume blocks below read it, and never resume.
  if (opts.startFresh === true && opts.hive) {
    if (opts.requireResume === true) return { ok: false, error: 'Start fresh cannot also require a resume.' };
    if (hive.enabled()) {
      const cleared = hive.clearSession(opts.hive.id, 'start-fresh');
      if (!cleared.ok) return { ok: false, error: cleared.error ?? 'Could not clear the session.' };
    }
    opts.resume = false;
    opts.resumeSessionId = undefined;
  }
  // Long-run guardrails + tiering (Lane A #6.4/#6.6). All additive to the args
  // already assembled (incl. the hive injection); an explicit choice always wins.
  // Set when an explicit Add Agent "resume session" id couldn't be located and we
  // silently fell back to a fresh session — returned so the dialog can surface it.
  let resumeNotFound = false;
  // Set when `--resume` was actually attached (explicit id or restore-on-restart),
  // so the renderer can skip re-orienting a god/assistant that resumed its thread.
  let didResume = false;
  // Claude-only — these are Claude Code flags; other CLIs carry their own flags
  // in the command string the renderer already built.
  if (opts.hive && claudeProvider) {
    const cfg = readConfig();
    // Permission posture (D9): only a GUI hire (Add Agent) builds its command
    // through buildSpawnCommand, which bakes autoMode's bypass flag into the
    // command STRING before this function ever sees it. A main-only spawn (the
    // ephemeral-worker watcher, a voice hire) skips that step entirely, so it
    // previously reached here with neither the flag nor any equivalent — every
    // other Claude spawn path got the user's autoMode posture and this one
    // didn't. argsWithAutoModeFlag is idempotent (a GUI spawn's args already has
    // the flag, so this is a no-op for it) and is the SAME check spawnAgentCore
    // already applies for opencode/crush et al a few lines below via
    // HIVE_AUTO_APPROVE — one global toggle, one posture, every spawn path.
    // Confirmed live: a worker spawned without this flag deadlocked — a
    // cross-session message to it came back "held for the recipient user's
    // approval" with no surface for anyone to ever grant that approval.
    const args = argsWithAutoModeFlag(opts.args ?? [], cfg.autoMode, provider);
    // (MODEL-PINBACK resolves the model above whenever the hive is enabled, so this is the
    // hive-disabled fallback.) Model precedence: an explicit renderer --model wins; otherwise the model
    // recorded from this agent's Claude status line wins over app-wide defaults.
    // This keeps separate agents' `/model` choices out of Claude's shared global
    // settings file while retaining the existing god/worker fallback behavior.
    if (!args.includes('--model')) {
      const m = modelForHiveSpawn(opts.hive, cfg, hive.lastModel(opts.hive.id));
      if (m) args.push('--model', m);
    }
    // Name the Remote Control session after the agent (Michael, Jim, Dev1…) so it
    // is identifiable in claude.ai / the mobile app. Otherwise Claude defaults the
    // prefix to the machine hostname (e.g. "vyapaks-macbook-pro-…"), which is
    // opaque when several agents run at once — especially with remoteControlAtStartup
    // on, where RC auto-enables for every session. Slugify the friendly name into a
    // single safe token; Claude still appends its own random suffix for uniqueness.
    const remoteControlLabel = (opts.hive.name || opts.hive.id || '')
      .trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!args.includes('--remote-control-session-name-prefix')) {
      if (remoteControlLabel) args.push('--remote-control-session-name-prefix', remoteControlLabel);
    }
    // Never type `/remote-control Michael` into a resumed God TUI: Claude's
    // already-connected session opens a Disconnect/QR/Continue dialog that can
    // consume the Human's first line. This flag is effective before the TUI owns
    // input and applies identically to a fresh or resumed God session.
    if (opts.hive.isGod && remoteControlLabel && !args.includes('--remote-control')) {
      args.push('--remote-control', remoteControlLabel);
    }
    // Coarse runaway cap.
    if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
      args.push('--max-turns', String(cfg.maxTurns));
    }
    // Resume: an explicit session id (Add Agent "resume session" field, #2) wins,
    // else this agent's last recorded session (#1 restore-on-restart / #6.6a).
    // Seed the transcript into the target cwd's Claude project dir first — Claude
    // keys sessions by cwd, so a session started elsewhere is invisible until its
    // `.jsonl` is copied across. Only attach `--resume` if the transcript is
    // actually present (already or after the copy); otherwise fall back to a fresh
    // session rather than launching a `--resume` against a missing id.
    const explicitSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    let sid = explicitSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    // SESSION-PROMPT-ROTATION: an AUTOMATIC resume never continues a session started with a
    // different system prompt (or one from before the stamps): the old prompt would stay in
    // force (B4). It starts fresh instead. A typed id or Restart & Continue is honoured.
    // The fingerprint is of the NORMALISED prompt (sessionRotation.ts CANONICAL_PROMPT): memory,
    // KG and build/path lines never count. An unstamped (1.1.75-era) session is first stamped
    // with the build-time 1.1.75 fingerprint of its variant, then compared as usual.
    const promptInfo = hive.enabled() ? hive.sessionPromptFingerprint({ ...opts.hive, cwd: opts.cwd, provider }) : null;
    const promptFp = promptInfo?.fp ?? null;
    const staleFor = (s: string): StaleReason | null => {
      const recorded = hive.sessionPromptStamp(opts.hive!.id, s);
      const legacyBlock = !recorded ? promptInfo?.legacyBlock ?? null : null;
      if (legacyBlock) hive.appendLog({ kind: 'session-legacy-skip', agentId: opts.hive!.id, sessionId: s, reason: legacyBlock });
      const d = resumeDecision(recorded, legacyBlock ? null : promptInfo?.variant ?? null, promptFp);
      if (d.stampLegacy && hive.stampSession(opts.hive!.id, s, d.stampLegacy)) {
        hive.appendLog({ kind: 'session-stamp-legacy', agentId: opts.hive!.id, sessionId: s, fp: d.stampLegacy, variant: promptInfo?.variant ?? null, stale: d.stale });
      }
      return d.stale;
    };
    const rotated: string[] = [];
    if (sid && !explicitSid) {
      const why = staleFor(sid);
      if (why) {
        rotated.push(sid);
        hive.retireSession(opts.hive.id, sid);
        hive.appendLog({ kind: 'session-rotate', agentId: opts.hive.id, sessionId: sid, reason: why, promptFp });
        // GOD-STARTUP-TOKENS R1: a god that starts fresh for any automatic reason gets the handoff.
        if (opts.hive.isGod) hive.armGodHandoff(opts.hive.id, { reasons: [`prompt-${why}`], previousSession: sid, contextTokens: null });
        console.log(`[resume] ${opts.hive.id}: session ${sid} was started with another system prompt (${why}); starting fresh`);
        sid = undefined;
      }
    } else if (sid && explicitSid && staleFor(sid)) {
      hive.appendLog({ kind: 'session-resume-stale', agentId: opts.hive.id, sessionId: sid, reason: staleFor(sid), promptFp });
    }
    // GOD-STARTUP-TOKENS R1 (godStartup.ts): an AUTOMATIC god resume whose last request was too
    // big, is past the cache lifetime, or was made by another Claude Code version or model would
    // re-send (and, past the cache, re-write) the whole old conversation. God starts FRESH with a
    // handoff instead (hive.armGodHandoff; the hooks put it in context). Logged either way. A typed
    // id (and Restart & Continue, which passes one) is honoured as before.
    const godCurrent = opts.hive.isGod && !explicitSid && sid
      ? { cliVersion: readClaudeVersion(await ptyManager.commandPath(opts.command.trim().split(/\s+/)[0] || opts.command)), model: modelFlagValue(args) ?? null }
      : null;
    const godAgentId = opts.hive.id;
    const godCwd = opts.cwd;
    const godFresh = (s: string): GodFreshReason[] | null => !godCurrent ? null : godFreshStart(s, {
      agentId: godAgentId,
      current: godCurrent,
      transcriptPath: (id) => sessionTranscriptPath(godCwd, id),
      now: Date.now,
      log: (row) => hive.appendLog(row),
      retire: (id) => hive.retireSession(godAgentId, id),
      arm: (h) => hive.armGodHandoff(godAgentId, h)
    });
    if (sid && !explicitSid && godFresh(sid)) {
      console.log(`[resume] ${opts.hive.id}: session ${sid} would re-send its whole context; starting fresh with a handoff`);
      sid = undefined;
    }
    let resumedSid: string | null = null;
    // SESSION-CROSSWIRE: an automatic resume never picks up a session another agent
    // claims, whether it is the last key or the previous-key fallback. A typed id is the
    // human asking for that thread, so it is not checked.
    const agentId = opts.hive.id;
    const foreign = (s: string): boolean => hive.sessionClaimedByOther(agentId, s);
    if (sid && !args.includes('--resume')) {
      if ((explicitSid || !foreign(sid)) && seedSessionTranscript(opts.cwd, sid)) {
        args.push('--resume', sid);
        didResume = true;
        resumedSid = sid;
      } else if (!explicitSid) {
        // START-FIXES-163 (1): the recorded key has no transcript (a phantom OTel id
        // from before the gate, or a session that never wrote a turn). Resume the id it
        // replaced when THAT one is on disk, instead of silently starting fresh. Logged
        // either way, so a lost context is never invisible again.
        const previous = hive.previousSession(opts.hive.id);
        const cwd = opts.cwd;
        // SESSION-PROMPT-ROTATION: the previous-key fallback obeys the same prompt check.
        const seedFresh = (s: string): boolean => {
          if (staleFor(s)) { rotated.push(s); return false; }
          if (godFresh(s)) return false;                          // GOD-STARTUP-TOKENS R1: same rule
          return seedSessionTranscript(cwd, s);
        };
        const pick = chooseResumeSession(sid, previous, seedFresh, foreign);
        if (pick.sessionId) {
          args.push('--resume', pick.sessionId);
          didResume = true;
          resumedSid = pick.sessionId;
        }
        hive.appendLog({ kind: 'resume-miss', agentId: opts.hive.id, missing: sid, previous: previous ?? null, outcome: pick.outcome, ...(pick.refused ? { refusedForeign: pick.refused } : {}), ...(rotated.length ? { rotated } : {}) });
        console.warn(`[resume] ${opts.hive.id}: session ${sid} ${pick.refused?.includes(sid) ? 'belongs to another agent' : 'has no transcript'}; ${pick.sessionId ? `resuming previous ${pick.sessionId}` : 'starting fresh'}`);
      } else if (explicitSid) {
        // The user typed a session id in the Add Agent dialog but it isn't in any
        // Claude project dir — we fall back to a FRESH session rather than a broken
        // `--resume`. Make that non-silent: warn on the floor and flag it back to
        // the renderer so the dialog can tell the user 'started fresh'.
        console.warn(`[resume] session "${explicitSid}" not found in any Claude project dir — starting a fresh session`);
        resumeNotFound = true;
      }
    }
    // The sessions this process opens, other than the one it resumed, carry this prompt.
    hive.noteSpawnPrompt(opts.hive.id, promptFp, resumedSid);
    opts.args = args;
  }
  // Idempotent session resume on respawn (#6.6a) — provider-aware: Claude
  // `--resume <sid>`, Grok `--resume <sid>`, Antigravity `--conversation <id>`.
  // The recorded session id comes from hook payloads, so
  // a restored worker continues its prior CLI session. Only when requested AND a
  // prior id exists for this agent.
  // Claude resume — incl. transcript seeding + only-attach-when-present — is
  // handled in the Claude-only block above; this generic flag path covers the
  // other CLIs (it must not blindly attach `--resume` when the seed failed).
  if (opts.hive && !claudeProvider) {
    const preset = providerPreset(provider);
    const rf = preset.resumeFlag;
    const rsub = preset.resumeSubcommand;
    // An id typed into Add Agent's "resume session" field wins; otherwise fall
    // back to this agent's own recorded session (restart-in-place). Previously
    // resumeSessionId was read ONLY in the Claude branch, so a Codex agent
    // silently ignored it and started a brand-new empty session.
    const typedSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
    let sid = typedSid || (opts.resume === true ? hive.lastSession(opts.hive.id) : undefined);
    // CODEX-BLOAT-165 fix 1: an AUTOMATIC resume (restore, revive) of a thread from before
    // today, or one grown past the size cap, starts fresh instead. A typed id and "Restart &
    // Continue" (requireResume) are the human asking for THAT thread, so they still resume.
    const mayRotate = !typedSid && opts.requireResume !== true;
    if (sid && rf && mayRotate && provider === 'antigravity') {
      const info = findAgyConversation(join(homedir(), '.gemini'), sid);
      // AGY-TOOLS-166: a conversation from before the agent's tools: list is tool-less for good.
      const d = info ? decideAgyRotation(info, Date.now(), hive.agyToolsSince(opts.hive.id)) : null;
      if (d?.rotate) {
        hive.appendLog(threadRotatedLogRow(opts.hive.id, provider, sid, d));
        console.log(`[resume] ${opts.hive.id}: antigravity conversation ${sid} rotated (${d.reason}); starting fresh`);
        sid = undefined;
      }
    }
    if (sid && rf) {
      const args = opts.args ?? [];
      if (!args.includes(rf)) { args.push(rf, sid); opts.args = args; didResume = true; }
    } else if (sid && rsub) {
      // Subcommand form (Codex): `codex resume [OPTIONS] [SESSION_ID]` — the
      // subcommand MUST be argv[0], the id trails the flags. Codex indexes
      // sessions in state_5.sqlite, so a fresh agent's empty CODEX_HOME can't
      // resume by id. If this agent's own home already has the session, resume in
      // place; otherwise point CODEX_HOME at the agent home that OWNS it (that
      // home has both the rollout and the sqlite index).
      const myHome = (opts.env ?? {}).CODEX_HOME;
      const agentsRoot = myHome ? dirname(dirname(myHome)) : '';
      const ownerHome = agentsRoot ? findCodexHomeForSession(sid, agentsRoot) : null;
      if (!ownerHome) {
        console.warn(`[resume] codex session "${sid}" not found in any agent CODEX_HOME - starting fresh`);
        if (typedSid) resumeNotFound = true;
      } else if (mayRotate && rotateCodexThread(opts.hive.id, sid, ownerHome)) {
        // A fresh thread: no `resume`, in the agent's own CODEX_HOME with its own instructions.
      } else {
        if (ownerHome !== myHome) opts.env = { ...(opts.env ?? {}), CODEX_HOME: ownerHome };
        // N1 (AGY-STARTUP-TURN, Codex): a resume under ANOTHER agent's CODEX_HOME carries THIS
        // agent's own developer_instructions with -c (the owner's config.toml holds the owner's).
        opts.args = HiveManager.codexResumeArgs(opts.args ?? [], myHome, ownerHome);
        const args = opts.args ?? [];
        // Positional order matters: `codex resume [OPTIONS] [SESSION_ID] [PROMPT]`.
        // The hive identity prompt rides in `args` as a POSITIONAL (codex has no
        // prompt flag), so the id must come BEFORE it — appending the id last made
        // codex read the prompt as SESSION_ID ("No saved session found with ID
        // You are \"Dev2\"…") and the id as the prompt.
        if (args[0] !== rsub) { opts.args = [rsub, sid, ...args]; didResume = true; }
        console.log('[resume] codex resume', sid, 'in', ownerHome);
      }
    }
  }
  if (opts.requireResume === true && !didResume) {
    return {
      ok: false,
      error: 'Existing session could not be resumed; no replacement process was started.',
      ...(resumeNotFound ? { resumeNotFound: true } : {})
    };
  }
  // Remember which agent owns this PTY so closing the tab can archive it. A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) {
    ptyToAgent.set(opts.id, opts.hive.id);
    ptyProvider.set(opts.id, provider);
    // A new agent with no reading yet makes its provider's membership unknown.
    pushCapacityStrip();
    pushAgentUsage();
    pushAgentImpact();
    // Inbox wake: boot grace starts at spawn so the initial orientation prompt is never
    // mistaken for an idle agent; a new incarnation also releases a stale INTERFERED hold.
    workerWake.noteSpawn(opts.id, Date.now(), opts.hive.id);
    // ZT-I1-MAIL §1.1: a (re)spawn ends whatever mail epoch the previous incarnation had open:
    // abnormal, its ids re-delivered with the marker (after noteSpawn, so the coordinator's
    // announced ids from the dead incarnation are re-pended too).
    try { hookServer.abortMailTurn(opts.hive.id, 'respawn'); } catch { /* best-effort */ }
  }
  // Pre-accept Claude Code's bypass-mode warning + folder-trust dialog so the
  // agent (spawned with --permission-mode bypassPermissions) doesn't stall on an
  // interactive prompt it can't answer and exit code 1. Best-effort, never blocks.
  // Claude-only — other CLIs handle their own permission UX.
  if (claudeProvider) {
    // MUNDER_DEV=1: this writes the user's SHARED ~/.claude/settings.json and
    // ~/.claude.json (bypass + folder-trust acceptance). Stable already keeps
    // them accepted; a dev build must not write outside DevData, so skip.
    if (!DEV_ISOLATION) { try { ensureClaudePermissionsAccepted(opts.cwd); } catch { /* never block spawn */ } }
  }
  // Suppress first-run interactive prompts for providers that need it. (Codex 0.157.1's
  // directory-trust screen is NOT suppressed by CODEX_NON_INTERACTIVE; the agent's own cwd is
  // trusted in its config instead, codexTrustSeed.ts.) Merges into any env already set on opts.
  const nonInteractiveEnv = nonInteractiveEnvForProvider(provider);
  if (Object.keys(nonInteractiveEnv).length > 0) {
    opts.env = { ...(opts.env ?? {}), ...nonInteractiveEnv };
  }
  // ── BYOK keys + per-provider config for the non-Claude CLI engines (v0.3.1) ──
  // OpenCode / Crush / pi / qwen read BYOK API keys from standard env vars and, for
  // the local-LLM path, a per-provider base URL. Keys are write-only in the broker
  // (read MAIN-ONLY here, never logged); base URLs ride HarnessConfig. Claude/codex
  // use their own login, so they skip this. Pam guardrails #3/#4/#5.
  if (opts.hive && (provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen')) {
    const cfg = readConfig();
    const extra: Record<string, string> = {};
    // 1) BYOK keys — LEAST-PRIVILEGE (Pam/Jim NIT-2): inject ONLY the key for the
    //    spawned model's provider prefix when we can identify it; fall back to all
    //    stored keys when the model/prefix is unknown (default model, qwen slugs,
    //    custom). Reduces the blast radius vs handing every CLI all keys.
    const modelIdx = (opts.args ?? []).indexOf('--model');
    const modelSlug = modelIdx >= 0 ? (opts.args?.[modelIdx + 1] ?? '') : '';
    const prefix = modelSlug.includes('/') ? modelSlug.split('/')[0].toLowerCase() : '';
    const PREFIX_BACKEND: Record<string, string> = {
      anthropic: 'anthropic', openai: 'openai', google: 'google', gemini: 'google', groq: 'groq', openrouter: 'openrouter'
    };
    const scoped = PREFIX_BACKEND[prefix];
    const backends = scoped ? [scoped] : Object.keys(BACKEND_KEY_ENV);
    for (const backend of backends) {
      const key = integrations.getSecret(providerKeyRef(backend));
      if (!key) continue;
      extra[BACKEND_KEY_ENV[backend]] = key;
      // OpenCode/AI-SDK's Google provider reads GOOGLE_GENERATIVE_AI_API_KEY, not
      // GEMINI_API_KEY — inject both so google/* authenticates (Jim NIT #1).
      if (backend === 'google') extra.GOOGLE_GENERATIVE_AI_API_KEY = key;
    }
    // 2) Floor auto-state for pi's bundled extension auto-allow (guardrail #5): it
    //    only auto-approves tool calls when this is '1' (i.e. floor auto mode on).
    extra.HIVE_AUTO_APPROVE = cfg.autoMode ? '1' : '0';
    // 3) OpenCode's auto-approve + local provider live in its single config-injection
    //    env var, built dynamically so permission:allow is GATED on autoMode (#2).
    if (provider === 'opencode') {
      const oc: Record<string, unknown> = { autoupdate: false };
      if (cfg.autoMode) oc.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow' };
      const baseUrl = cfg.providerBaseUrls?.opencode;
      if (baseUrl) {
        // Register the model id the user actually selects (the part after 'local/')
        // so `--model local/<id>` resolves; default to 'local'. Without this the
        // dropdown's `local/llama3` failed against a config that only declared model
        // 'local' (Jim verify-opencode MUST-FIX #2).
        const localModel = (prefix === 'local' && modelSlug.slice(6)) || 'local';
        oc.provider = {
          local: { npm: '@ai-sdk/openai-compatible', name: 'Local (self-hosted)', options: { baseURL: baseUrl }, models: { [localModel]: { name: localModel } } }
        };
      }
      extra.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
    }
    opts.env = { ...(opts.env ?? {}), ...extra };
  }
  // Codex Remote is daemon-based (there is no `/remote-control` slash command).
  // Start/enable the daemon under this agent's isolated CODEX_HOME and connect
  // the TUI to it so the thread is visible in ChatGPT mobile. Best-effort: an
  // unavailable/older Codex install still gets a normal local terminal.
  if (provider === 'codex' && opts.hive?.id) {
    await enableCodexRemoteForSpawn(opts, opts.hive.id);
  }
  // WAKE-SCREEN-GUARD R2-4: this Codex incarnation's own token, in its spawn env (the hook
  // shim copies it into each hook payload). Registered below once the PTY exists.
  const wakeToken = provider === 'codex' && opts.hive?.id ? WakeIncarnationTokens.mint() : null;
  if (wakeToken) opts.env = { ...(opts.env ?? {}), [WAKE_INCARNATION_ENV]: wakeToken };
  const res = await ptyManager.spawn(opts, owner);
  if (wakeToken && res.ok && opts.hive?.id) {
    wakeIncarnationTokens.register(wakeToken, opts.hive.id, opts.id, ptyManager.incarnation(opts.id));
    // Jim N3: a new process gets a new run, and a new banner if it, too, is refused for minutes.
    screenGuardNotices.respawned(opts.hive.id);
  }
  if (res.ok) analytics.track('agent_spawned', { provider });
  syncKeepAwake(); // arm the power-save blocker while ≥1 agent PTY is alive (#18)
  // Hand the resolved worktree path back to the renderer so it can persist it on
  // the agent (only set when isolation actually provisioned a worktree above).
  // The restore flow re-enters this exact worktree (cwd = worktreePath) so a
  // restored isolated agent resumes in the CORRECT checkout, not the base repo.
  const worktreePath = worktreePaths.get(opts.id);
  // `cwd` echoes back the TILDE-EXPANDED absolute path so the renderer's agent
  // record matches what the registry and the PTY actually used.
  return { ...res, cwd: opts.cwd, ...(worktreePath ? { worktreePath } : {}), ...(resumeNotFound ? { resumeNotFound: true } : {}), ...(didResume ? { resumed: true } : {}), ...(seedPrompt ? { seedPrompt } : {}) };
}
ipcMain.handle('pty:write', (_evt, id: string, data: string, origin: unknown) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  // An unrecognised or missing origin is REFUSED, not defaulted. A write that
  // cannot say who is behind it is a missing fact, and the fail-closed rule says a
  // missing fact is UNKNOWN — never CONTROL, and never quietly HUMAN.
  if (!isInputOrigin(origin)) return { ok: false, error: 'invalid origin' };
  // L0-FUSION stage 5.3. PROGRAMMATIC belongs to the ONE submit owner, and the owner lives
  // in THIS process: it writes through ptyManager directly and never crosses this channel.
  // So a renderer that declares it is asking for a capability it no longer has. Refused
  // HERE, structurally - not by the renderer promising not to: after this no automatic
  // module holds a raw text+Enter capability at all (design section 10). HUMAN and
  // CONTROL are what this channel is for.
  if (origin === 'PROGRAMMATIC') return { ok: false, error: 'origin not permitted on this channel' };
  return ptyManager.write(id, data, origin);
});
// L0-FUSION stage 3. The mirror is validated at the boundary and stored on the live
// session; a malformed report is refused rather than stored as something it is not.
ipcMain.handle('pty:inputState', (_evt, id: string, state: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid args' };
  if (!isTerminalInputState(state)) return { ok: false, error: 'invalid input state' };
  return ptyManager.setInputState(id, state);
});
// Evaluated FRESH from the stored mirror on every ask - re-entrant by construction.
// No caller may cache the answer across a guard; a TUI can change its mind in between.
ipcMain.handle('pty:automaticDeliveryEligibility', (_evt, id: string) => {
  if (typeof id !== 'string') return { eligible: false, reason: 'NO_STATE', detail: 'invalid args' };
  return automaticDeliveryEligibility(ptyManager.inputState(id));
});
// L0-FUSION stage 5. Whose the prompt is (picker latch / human draft / settle), mirrored
// for the same reason the provenance mirror is: main must READ it, before STAGE and inside
// the critical section, and cannot if it lives only in the renderer. Validated at the
// boundary; a malformed report is refused rather than stored as something it is not.
ipcMain.handle('pty:promptState', (_evt, id: string, state: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid args' };
  if (!isTerminalPromptState(state)) return { ok: false, error: 'invalid prompt state' };
  return ptyManager.setPromptState(id, state);
});
// The renderer's answer to `autoSubmit:readScreen`. A malformed answer, or one for an id
// that is not pending, is no answer - the owner then holds the item rather than guess.
ipcMain.on('autoSubmit:screenReading', (_evt, requestId: unknown, reading: unknown) => {
  screenReadings.answer(requestId, reading);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:redraw', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  return ptyManager.redraw(id);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// Resolve a pasted Claude session id to the cwd it originally ran in, so the Add
// Agent dialog can auto-fill the folder for a resume (#2 zero-step resume). Reads
// the cwd from a transcript record; null when the id is invalid/unknown.
ipcMain.handle('session:resolveCwd', (_evt, sessionId: unknown) =>
  (typeof sessionId === 'string' ? resolveSessionCwd(sessionId) : null));

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
// STARTUP-TIMING-162: the renderer's long tasks and first-redraw marks (validated in startupTiming).
ipcMain.on('startup:timing', (_evt, batch: unknown) => startupTiming.fromRenderer(batch));
ipcMain.handle('app:readClipboard', () => {
  try { return clipboard.readText(); } catch { return ''; }
});
// Same read, SYNCHRONOUS, for the terminal's paste shortcut.
//
// Dictation tools (muesli.works, Wispr Flow, …) type by stashing the user's
// clipboard, writing the transcript, sending the paste key, then restoring the
// old clipboard immediately. An `invoke` read returns a tick or two later — by
// which point the restore has already landed and we paste the PREVIOUS text.
// A `sendSync` read completes inside the keydown handler, before the tool gets
// a chance to put the old contents back.
ipcMain.on('app:readClipboardSync', (evt) => {
  try { evt.returnValue = clipboard.readText(); } catch { evt.returnValue = ''; }
});
// NOTE: the terminal theme is mirrored into each agent's per-session Claude
// settings at spawn (hive.ensureAgent theme option) — deliberately NOT via
// `claude config set -g theme`, which would also restyle the user's own
// Claude sessions outside the app.

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  if (DEV_HIDDEN) return { ok: false as const, error: 'cancelled' };   // MUNDER_HIDDEN: no dialog
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: Terminal.app at a folder ──────────────────────────────────────────
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('open', ['-a', 'Terminal', cwd]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
    });
  });
});

// ─── IPC: integrations (Phase 2 registry — backend for Ryan's Settings UI) ────
// Records are metadata only (config-backed); secrets are encrypted at rest and NEVER
// returned over IPC. `list` redacts secretRef to a `hasSecret` boolean.
ipcMain.handle('integrations:list', () => integrations.listRecordsRedacted());
ipcMain.handle('integrations:templates', () => INTEGRATION_TEMPLATES);
ipcMain.handle('integrations:upsert', (_evt, record: unknown) => integrations.upsertRecord(record));
ipcMain.handle('integrations:setSecret', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; secret?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  if (typeof p.secret !== 'string' || !p.secret) return { ok: false, error: 'secret required' };
  return integrations.setSecret(secretRefFor(p.id), p.secret);
});
ipcMain.handle('integrations:remove', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  return integrations.removeRecord(p.id);
});
// ─── IPC: per-CLI-provider BYOK keys (write-only) ────────────────────────────
// API keys for the backend model-providers the non-Claude CLIs use are stored
// WRITE-ONLY under `apikey:<backend>` in the same encrypted broker. The renderer
// can SET a key and ASK whether one is set (boolean) — it can never read the
// plaintext back. Keys are materialized MAIN-ONLY at spawn (spawnAgentCore). Base
// URLs are non-secret and ride HarnessConfig.providerBaseUrls (normal config save).
ipcMain.handle('providerKey:set', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { backend?: unknown; key?: unknown };
  if (typeof p.backend !== 'string' || !(p.backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
  return integrations.setSecret(providerKeyRef(p.backend), p.key);
});
ipcMain.handle('providerKey:has', (_evt, backend: unknown) =>
  typeof backend === 'string' ? integrations.hasSecret(providerKeyRef(backend)) : false);
ipcMain.handle('providerKey:clear', (_evt, backend: unknown) => {
  if (typeof backend !== 'string' || !(backend in BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
  try { integrations.deleteSecret(providerKeyRef(backend)); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
// Probe an integration's reachability through the broker's own auth path (admin-only;
// runs in main, so the secret is used but never returned — only the upstream status).
ipcMain.handle('integrations:test', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown; path?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
  const rec = integrations.getRecord(p.id);
  if (!rec) return { ok: false, error: 'unknown integration' };
  const probe = validateBaseUrl(rec.baseUrl);
  if (!probe.ok) return { ok: false, error: probe.error };
  // Confine the probe path through the SAME gate as the worker forward() path, so an
  // absolute URL / backslash-host / traversal in p.path can't override the origin and
  // exfiltrate the secret to an attacker host. Resolve (and reject) BEFORE the secret
  // is ever materialized, so a bad path never even decrypts it.
  const target = resolveUpstreamUrl(rec.baseUrl, typeof p.path === 'string' ? p.path : '');
  if (!target) return { ok: false, error: 'path escapes the integration baseUrl', code: 'bad_request' };
  const secret = integrations.getSecret(rec.secretRef);
  const headers = buildAuthHeaders(rec.authType, rec.authHeader, secret);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    const r = await fetch(target, { method: 'GET', headers, redirect: 'manual', signal: ac.signal });
    clearTimeout(timer);
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: config ────────────────────────────────────────────────────────────
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => {
  // FIRST RUN: every hive-bound service is started by bootstrapHiveServices(),
  // which runs once at app-ready and early-returns on `!hive.enabled()` — i.e.
  // whenever harnessHome is still null, which is exactly the state a fresh
  // install boots in. Onboarding then sets harnessHome through THIS handler and
  // nothing re-bootstrapped, so the hook server, message router, telemetry
  // collector and mission scheduler all stayed dead for the rest of the session.
  //
  // Symptom: agents spawn and run (the PTY is not hive-bound), but no hook ever
  // reaches the app — no `hooks.sock` on disk, so no SessionStart, which means
  // recordSession() is never called and "Restart & Continue" fails with "No
  // recorded session ID"; the cards also sit on "ctx no status tick yet" and 0
  // tool calls. Everything healed on the next app launch, which is what hid it.
  //
  // changeHome() has always handled this by relaunching; onboarding does not
  // relaunch, so bootstrap here on the null → set transition. Gated on the
  // transition so ordinary config writes never re-enter it.
  const hiveWasEnabled = hive.enabled();
  const next = writeConfig(patch);
  // Live opt-in/out from Settings → Privacy (TELEMETRY.md).
  if (typeof patch?.telemetryEnabled === 'boolean') analytics.setEnabled(patch.telemetryEnabled);
  // Keep the hive's mirror of the spawn gate current. The queue itself reads
  // config per tick so it gates immediately; this is for the PROMPT, which is
  // built per spawn, so flipping the toggle reaches god the next time he starts.
  if (typeof patch?.orchestratorMaySpawn === 'boolean') hive.setOrchestratorMaySpawn(patch.orchestratorMaySpawn);
  if (!hiveWasEnabled && hive.enabled()) {
    console.log('[hive] harnessHome configured — bootstrapping hive services');
    try { bootstrapHiveServices(); } catch (e) { console.error('[hive] bootstrap after onboarding:', e); }
  }
  return next;
});
ipcMain.handle('config:setAgentTokenCap', (_evt, agentId: unknown, tokenCap: unknown) =>
  setAgentTokenCap(agentId, tokenCap)
);
// v1.1.45 unit #8: set the capacity-display threshold. Invalid input throws and changes
// nothing. A valid one takes effect LIVE: the strip is re-projected and pushed at once
// (a presentation-only change: no domain revision moves).
ipcMain.handle('config:setCapacityDisplayThreshold', (_evt, value: unknown) => {
  const next = setCapacityDisplayThreshold(value);
  capacityDisplayThreshold = capacityDisplayThresholdOf(next);
  pushCapacityStrip();
  return next;
});
// v1.1.45 CAPUI-MONITOR: persist an agent's Monitor line. The breaker reads config live,
// so a 5H / Weekly choice exempts the agent from the budget on the very next beat.
ipcMain.handle('config:setAgentUsageDisplay', (_evt, agentId: unknown, display: unknown) => {
  const next = setAgentUsageDisplay(agentId, display);
  pushAgentUsage();
  return next;
});
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// Change the harnessHome folder. Because every derived path (hive root, palace,
// sock, agent dirs) resolves lazily through getHome(), the only real work is
// optionally MOVING the existing hive + palace and relaunching so every service
// re-binds against the new root. mode: 'move' copies the data (old kept as a
// safety net), 'fresh' just re-points and bootstraps an empty home.
ipcMain.handle('config:changeHome', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { newHome?: unknown; mode?: unknown };
  if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
  // MUNDER_DEV=1: the harness home is fixed at the DEV root. This handler copies
  // hive/palace/roster to an arbitrary destination and persists it — refused
  // outright so a dev build can never move data outside MunderDevData.
  if (DEV_ISOLATION) return { ok: false, error: 'dev build — the harness home is fixed under MUNDER_DEV=1; changeHome is disabled' };
  const mode: 'move' | 'fresh' = p.mode === 'fresh' ? 'fresh' : 'move';
  // expandTilde BEFORE resolve: both UI callers feed a folder-dialog result
  // (always absolute), but the hive picker's recents list can serve a literal
  // "~/…" persisted by a pre-#140 build — resolve() would anchor that at cwd
  // and the app would relaunch against a real directory named "~". Same
  // defence-in-depth-at-the-consumer rule as expandTilde's own doc.
  const newHome = resolve(expandTilde(p.newHome));
  const oldRaw = readConfig().harnessHome;
  const oldHome = oldRaw ? resolve(oldRaw) : null;

  // Guard against same-folder / nested-folder (a move would self-copy forever).
  if (oldHome) {
    if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
    const a = newHome + sep, b = oldHome + sep;
    if (a.startsWith(b) || b.startsWith(a)) {
      return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
  }

  const ensured = ensureHarnessHome(newHome);
  if (!ensured.ok) return ensured;

  // Tear down everything bound to the OLD root before copying, so nothing writes
  // mid-copy — a live git commit into hive/.git would otherwise be copied as a
  // half-written object and corrupt the moved repo.
  try { clearMissionTimers(); } catch (e) { console.error('[changeHome] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[changeHome] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[changeHome] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[changeHome] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[changeHome] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[changeHome] stopRouter:', e); }
  try { hive.stopLedgerGuard(); } catch (e) { console.error('[changeHome] stopLedgerGuard:', e); }
  try { boardMonitor.stop(); } catch (e) { console.error('[changeHome] boardMonitor.stop:', e); }
  try { floorDigest.stop(); boardStatus.stop(); } catch (e) { console.error('[changeHome] floorDigest.stop:', e); }
  try { hive.stopAgyStatusline(); } catch (e) { console.error('[changeHome] stopAgyStatusline:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[changeHome] hookServer.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[changeHome] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[changeHome] webhook.stop:', e); }
  // The memory engine's index is keyed by the hive root, so the new home builds its own; the
  // old one is deleted after a successful move (Jim M1: shut the worker down FIRST).
  const oldIndex = nativeMemory.dbFile();
  const memoryStopped = nativeMemory.shutdown().catch(() => undefined);
  try { reflector.stop(); } catch (e) { console.error('[changeHome] reflector.stop:', e); }
  // Close the hive's kept-open log and ledger before the copy (and the relaunch).
  try { hive.dispose(); } catch (e) { console.error('[changeHome] hive.dispose:', e); }

  await memoryStopped;

  if (mode === 'move' && oldHome) {
    try {
      // roster.json + its backups ride along with the hive: the roster is the
      // renderer's half of the same state, and leaving it behind would move the
      // agents' sessions and memory to the new home while their names, notes and
      // worktree paths stayed at the old one.
      for (const sub of ['hive', 'roster.json', 'roster-backups']) {
        const src = join(oldHome, sub);
        if (!existsSync(src)) continue;
        // cpSync copies the whole tree incl. .git and is cross-device safe (unlike
        // renameSync, which throws EXDEV across volumes). We COPY, never delete —
        // the old folder stays as a safety net the user removes manually.
        cpSync(src, join(newHome, sub), { recursive: true, force: true, dereference: false });
      }
    } catch (e) {
      // Copy failed: recover IN PLACE against the unchanged old home (config never
      // repointed) so the user loses nothing, and surface the error — no relaunch.
      bootstrapHiveServices();
      const cfg = readConfig();
      if (cfg.slackEnabled && cfg.slackSigningSecret) void startSlackServer();
      reconcileWebhookServer();
      return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
    }
    // Moved: the old hive's index is an orphan now (the new home indexes its own copy).
    deleteMemoryIndex(oldIndex);
  }

  // Repoint config and relaunch so every service re-bootstraps against newHome.
  // (Identical recovery path to resetAll — relaunch is the clean re-bind.)
  allowQuit = true;
  writeConfig({ harnessHome: newHome });
  // SYNC-CHILD-CALLS: the async bulk kill (one batched taskkill, then the ConPTY exits awaited),
  // and only THEN relaunch/exit — never a per-terminal synchronous taskkill on the main thread.
  ptyManager.refuseNewSpawns('The harness home is changing and the app is restarting; agents cannot start now.');
  try { await ptyManager.killAllAsync(); } catch (e) { console.error('[changeHome] killAllAsync:', e); }
  app.relaunch();
  app.exit(0);
  return { ok: true as const }; // unreachable (process exits) — typed for the renderer
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
// Raw bytes for files the text reader refuses (images). The renderer cannot
// load them off disk itself — the CSP has no `file:` source and no file
// protocol is registered — so the bytes come through here and become a `blob:`
// URL on the other side. Same root confinement as every other fs handler.
ipcMain.handle('fs:readBinary', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileBinary(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});
// v0.3.4: existence check for the terminal ⌘-click markdown flow (metadata only).
ipcMain.handle('fs:statAbs', (_evt, p: unknown) => {
  if (typeof p !== 'string' || p.length > 4096 || p.includes('\0')) {
    return { exists: false, isFile: false, path: '' };
  }
  return statAbs(p);
});

/** Reveal a path in the OS file browser — Finder, Explorer, or whatever the
 *  Linux desktop registers. Backs ⌘-click on a terminal path we cannot open
 *  ourselves (an image, an archive, an unknown extension).
 *
 *  `showItemInFolder`, NEVER `shell.openPath`, for a file. The path arrives
 *  from agent output, and openPath hands an arbitrary file to its default
 *  application: a printed `installer.dmg` or `.desktop` would be one click from
 *  executing. Revealing only ever opens a file browser, so the worst an agent
 *  can achieve by printing a path is a window at a folder the user could
 *  already open themselves.
 *
 *  openPath IS used for a directory, and only after statAbs has confirmed it is
 *  one — a directory has no default application to launch, so the execution
 *  argument above does not apply, and revealing a folder inside its parent is
 *  not what "open this folder" means to anyone. */
ipcMain.handle('fs:revealPath', async (_evt, p: unknown) => {
  if (typeof p !== 'string' || !p.length || p.length > 4096 || p.includes('\0')) {
    return { ok: false, error: 'bad request' };
  }
  if (DEV_HIDDEN) return { ok: false, error: 'hidden run' };   // MUNDER_HIDDEN: no Explorer window
  const st = await statAbs(p);
  if (!st.exists) return { ok: false, error: 'not found' };
  if (st.isFile) { shell.showItemInFolder(st.path); return { ok: true }; }
  const err = await shell.openPath(st.path);
  return err ? { ok: false, error: err } : { ok: true };
});

// ─── IPC: git ───────────────────────────────────────────────────────────────
ipcMain.handle('git:isRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return false;
  return isRepo(cwd);
});

// The repo a cwd belongs to, following a linked worktree back to its main
// checkout — the renderer groups the agent roster by this.
ipcMain.handle('git:mainRepo', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || !cwd) return null;
  return mainRepoRoot(cwd);
});
ipcMain.handle('git:branch', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranch(cwd);
});
ipcMain.handle('git:status', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getStatus(cwd);
});
ipcMain.handle('git:log', (_evt, cwd: unknown, n: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  const count = typeof n === 'number' ? Math.min(500, Math.max(1, n)) : 50;
  return getLog(cwd, count);
});
ipcMain.handle('git:branches', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getBranches(cwd);
});
ipcMain.handle('git:aheadBehind', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid cwd' };
  return getAheadBehind(cwd);
});
ipcMain.handle('git:diff', (_evt, cwd: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getDiff(cwd, relPath);
});
// ─── v0.3.4: history / compare / checkout (git visualization) ───────────────
ipcMain.handle('git:logGraph', (_evt, cwd: unknown, n: unknown, skip: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  const count = Math.min(500, Math.max(1, typeof n === 'number' ? n : 200));
  const off = Math.max(0, typeof skip === 'number' ? skip : 0);
  return getLogGraph(cwd, count, off);
});
ipcMain.handle('git:commitFiles', (_evt, cwd: unknown, sha: unknown) => {
  if (typeof cwd !== 'string' || typeof sha !== 'string') return { error: 'invalid args' };
  return getCommitFiles(cwd, sha);
});
ipcMain.handle('git:showFile', (_evt, cwd: unknown, rev: unknown, relPath: unknown) => {
  if (typeof cwd !== 'string' || typeof rev !== 'string' || typeof relPath !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return getFileAtRev(cwd, rev, relPath);
});
ipcMain.handle('git:compareRefs', (_evt, cwd: unknown, base: unknown, head: unknown, mode: unknown) => {
  if (typeof cwd !== 'string' || typeof base !== 'string' || typeof head !== 'string') {
    return { error: 'invalid args' };
  }
  return compareRefs(cwd, base, head, mode === 'two' ? 'two' : 'three');
});
ipcMain.handle('git:worktrees', (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string') return { error: 'invalid args' };
  return listWorktrees(cwd);
});
ipcMain.handle('git:checkout', async (_evt, cwd: unknown, ref: unknown, detach: unknown) => {
  if (typeof cwd !== 'string' || typeof ref !== 'string') return { ok: false, error: 'invalid args' };
  // Guard: never swap files under an actively-working agent. Objective signal
  // owned by main — any live pty whose cwd sits in this tree and emitted output
  // in the last 10s is treated as mid-run. (Idle-but-open terminals are fine:
  // checkoutRef additionally requires a clean tree, and TUIs redraw on fs
  // changes gracefully.)
  const busy = ptyManager.list().find((p) =>
    (p.cwd === cwd || p.cwd.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)) &&
    Date.now() - p.lastOutputAt < 10_000
  );
  if (busy) {
    return { ok: false, error: `an agent is actively working in this repo (${busy.id}) — try again when it goes quiet` };
  }
  return checkoutRef(cwd, ref, detach === true);
});

// ─── IPC: roster mirror (shared between dev and a packaged build) ───────────
// The renderer's store is built synchronously at module load, before any async
// IPC could resolve, so the read is `ipcMain.on` + `returnValue` — one blocking
// round trip at boot, in exchange for the roster being correct on first paint
// instead of flashing an empty floor and then filling in.
// (`roster` itself is constructed earlier so HookServer can read standing goals.)
ipcMain.on('roster:readSync', (evt) => { evt.returnValue = roster.read(); });
ipcMain.handle('roster:read', () => roster.read());
ipcMain.handle('roster:write', (_evt, snap: unknown) => roster.write(snap));

// ─── IPC: hive (multi-agent coordination) ───────────────────────────────────
ipcMain.handle('hive:registry', () => hive.registry());
// AGENT-MODEL-NOT-KEPT M3: a person's click on "keep this model" for an agent's AUTO pin: it becomes
// theirs ('user') and is kept after a restart. Main refuses anything that is not an auto pin.
ipcMain.handle('hive:keepModelPin', (_evt, agentId: unknown) =>
  typeof agentId === 'string' && agentId ? hive.keepModelPin(agentId) : false);
// ZERO-TOKEN-LIVENESS: the current records (read-only), and the ONE operator action that can lead to
// a turn: a person's click on "re-offer mail" for an agent the WWR gave up on. It ends the stuck epoch;
// the normal reconcile beat then re-offers through every guard and the submit owner.
ipcMain.handle('liveness:snapshot', () => agentLiveness.all());
ipcMain.handle('liveness:reoffer', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string' || !agentId) return false;
  const rec = agentLiveness.getLiveness(agentId);
  if (!rec || rec.classification !== 'STUCK_WAKE' || rec.reason !== 'wwr-max-recoveries') return false;
  const ok = inboxWake?.onOperatorReoffer(agentId) ?? false;
  try { hive.appendLog({ kind: 'liveness-operator', action: 'reoffer', agentId, ok }); } catch { /* best-effort */ }
  return ok;
});
ipcMain.handle('hive:integrity', () => hive.integrityIssues());
ipcMain.handle('config:integrity', () => configIntegrityIssue());
ipcMain.handle('hive:renameAgent', (_evt, id: unknown, name: unknown) => {
  if (typeof id !== 'string' || typeof name !== 'string') {
    return { ok: false, error: 'Invalid rename request' };
  }
  return hive.renameAgent(id, name);
});
ipcMain.handle('hive:setAgentHold', (_evt, id: unknown, hold: unknown) => {
  if (typeof id !== 'string' || typeof hold !== 'boolean') {
    return { ok: false, error: 'Invalid hold request' };
  }
  return hive.setAgentHold(id, hold);
});
ipcMain.handle('hive:board', () => hive.board());
ipcMain.handle('hive:tasks', () => hive.tasks());
// ZT-I3: the board monitor's current flags (stale, archived, down, stuck, ask-answered).
ipcMain.handle('hive:boardFlags', () => boardMonitor.flags());
// CARD-BADGE-AMBIGUOUS: what the player cards need: the flags, and each active agent's
// messages waiting (fleet's inboxBacklog: mail not yet acted on, from the ledger).
// ZT-I3/I4: the sidecar (status ages for the Kanban) and the floor digest text (Floor panel).
ipcMain.handle('hive:taskMeta', () => hive.ledgerGuard.taskMeta().cards);
ipcMain.handle('hive:floorDigest', () => {
  const root = hive.root();
  if (!root) return '';
  try { return readFileSync(join(root, FLOOR_DIGEST_FILE), 'utf8'); } catch { return ''; }
});
ipcMain.handle('hive:cardBadges', () => {
  const inboxBacklog: Record<string, number> = {};
  try {
    for (const [id, a] of Object.entries(hive.registry().agents)) if (!a.archived) inboxBacklog[id] = fleetMail(id).inboxBacklog;
  } catch { /* hive unavailable: no mail badges */ }
  return { flags: boardMonitor.flags(), inboxBacklog };
});
ipcMain.handle('hive:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('hive:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
// ZT-I1-MAIL §11.8 #15: the Threads panel reads inbox/ AND inbox/.done/ with the ledger state as a
// column, so the view does not empty when the harness archives at Stop.
ipcMain.handle('hive:inbox', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !id) return [];
  let archived = false;
  // Q32: an orphan or pty-exit archive keeps its ledger (mail is still delivered to it).
  try { archived = archivedForMail(hive.registry().agents[id]); } catch { /* unknown: not archived */ }
  return hive.mailHistory(id, { archived });
});
// ZT-I1-MAIL §11.8 #16: the queue's "inbox-nonempty" precondition asks the LEDGER (the wake
// coordinator's pending source: delivered, not yet surfaced), not the inbox listing.
ipcMain.handle('hive:mailPending', (_evt, id: unknown) => (typeof id === 'string' && id ? mailPendingIds(id) : []));
// ZT-I1-MAIL §4.3 / §11.13 option B: the Command Center's open-request list (badge + list) and
// the §7.1 step-2 undelivered report (shown once). Data only: nothing here wakes an agent.
ipcMain.handle('hive:mailObligations', () => {
  if (!hive.enabled()) return { agents: [], undelivered: null };
  let agents: ReturnType<typeof hive.mailObligations> = [];
  try { agents = hive.mailObligations(); } catch { /* ledger trouble: the banner says so */ }
  let undelivered: ReturnType<typeof hive.undeliveredReport> = null;
  try { undelivered = hive.undeliveredReport(); } catch { /* no report */ }
  return { agents, undelivered };
});
// §11.18 #1: the Human's explicit close. The ONLY caller of closeObligation.
ipcMain.handle('hive:closeObligation', (_evt, agentId: unknown, id: unknown) => {
  if (!hive.enabled()) return { ok: false, closed: [] };
  try { const closed = hive.closeMailObligation(agentId, id); return { ok: closed.length > 0, closed }; }
  catch (e) { return { ok: false, closed: [], error: e instanceof Error ? e.message : String(e) }; }
});
// §7.1 step 2: the Human dismissed the undelivered report (persisted: shown once).
ipcMain.handle('hive:undeliveredSeen', () => {
  if (!hive.enabled()) return false;
  try { return hive.markUndeliveredSeen(); } catch { return false; }
});
// ZT-I1-MAIL N2: the renderer confirmed a terminal work order's PTY write (COMMITTED): the ledger
// records it acted via:"work-order" (the whole body is in the typed text; never in the backlog).
ipcMain.handle('hive:workOrderDelivered', (_evt, e: unknown) => {
  if (!e || typeof e !== 'object') return false;
  const r = e as Record<string, unknown>;
  if (typeof r.agentId !== 'string' || typeof r.messageId !== 'string') return false;
  return hive.recordWorkOrderDelivered(r.agentId, r.messageId, { from: r.from, act: r.act, subject: r.subject, requiresReply: r.requiresReply });
});
// The renderer's 4s inbox HINT (plan A, god's ruling). It is a TRIGGER, never a producer:
// it carries no decision and no payload, and it reaches the terminal only through the one
// main-owned path, with main's one claim and its one stable request id. That is the whole
// point - the renderer poll that 1.1.45 relied on is back as a cadence, without the second
// submitter that would make two request ids for one inbox edge and so two turns.
ipcMain.handle('hive:requestInboxWake', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !id) return false;
  return !!inboxWake?.requestInboxWake(id, 'renderer', 'reconcile');
});
// Voice read-layer: recent message CONTENT (inbox/outbox bodies), REDACTED
// main-side by hive.voiceMessages(). The renderer/voice layer never sees a raw
// body — secrets are stripped here, before the result crosses IPC.
ipcMain.handle('hive:messages', (_evt, opts: unknown) =>
  hive.voiceMessages(opts && typeof opts === 'object' ? (opts as Parameters<typeof hive.voiceMessages>[0]) : {})
);
ipcMain.handle('hive:send', (_evt, partial: Partial<HiveMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  const msg = hive.send(partial ?? {}, typeof from === 'string' ? from : 'system');
  return { ok: true, message: msg };
});
ipcMain.handle('hive:addTask', (_evt, task: unknown) => {
  if (!task || typeof task !== 'object' || Array.isArray(task)
    || typeof (task as { id?: unknown }).id !== 'string') {
    return { ok: false, error: 'invalid task' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  try { return { ok: hive.addTask(task as HiveTask) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('hive:patchTask', (_evt, id: unknown, patch: unknown) => {
  if (typeof id !== 'string' || !id || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'invalid task patch' };
  }
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  try { return { ok: hive.patchTask(id, patch as Partial<Omit<HiveTask, 'id'>>) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('hive:deleteTask', (_evt, id: unknown) => {
  if (typeof id !== 'string' || !id) return { ok: false, error: 'invalid task id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  try { return { ok: hive.deleteTask(id) }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('hive:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});
ipcMain.handle('hive:patchAgentRole', (_evt, id: unknown, role: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (typeof role !== 'string') return { ok: false, error: 'invalid role' };
  if (!hive.enabled()) return { ok: false, error: 'hive disabled (no harnessHome)' };
  return hive.patchAgentRole(id, role);
});

// ─── IPC: Settings hero payload (remote data, cached) ───────────────────────
/** Plan copy and sponsor, fetched from the repo so they can change without a
 *  release. Validated in shared/heroPayload before it reaches the renderer. */
ipcMain.handle('hero:payload', async (_evt, force: unknown) =>
  loadHero(join(app.getPath('userData'), 'hero.json'), { force: force === true }));

// ─── IPC: skills (installed locally, and the browsable catalog) ─────────────
/** Skills the CLIs on this machine can already use. Scans the registered repos
 *  plus the agent's own cwd, so a project-scoped skill shows up where it applies. */
ipcMain.handle('skills:local', (_evt, cwd: unknown): LocalSkill[] => {
  const cfg = readConfig();
  const cwds = [
    ...(typeof cwd === 'string' && cwd ? [cwd] : []),
    ...(cfg.registeredRepos ?? [])
  ];
  try {
    return listLocalSkills({ cwds, bundledDir: skillsResourceDir() });
  } catch (e) {
    console.error('[skills] local scan failed:', e);
    return [];
  }
});
/** The skills catalog, parsed from its README and cached in userData.
 *  `force` is the explicit refresh button; everything else is served from a
 *  day-old cache so opening the tab never waits on the network. */
ipcMain.handle('skills:catalog', async (_evt, force: unknown) => {
  const cachePath = join(app.getPath('userData'), 'skill-catalog.json');
  return loadCatalog(cachePath, { force: force === true });
});

/** Install one catalog skill into ~/.claude/skills. Structured refusals, never a
 *  throw: the UI distinguishes "not installable" from "install failed". */
ipcMain.handle('skills:install', async (_evt, url: unknown, name: unknown) => {
  // MUNDER_DEV=1: skill installs land in the user's GLOBAL ~/.claude/skills
  // (shared with Stable's agents). A dev build must not write there.
  if (DEV_ISOLATION) return { ok: false, error: 'dev build — global skill installs are disabled under MUNDER_DEV=1' };
  if (typeof url !== 'string' || typeof name !== 'string') {
    return { ok: false as const, error: 'bad request' };
  }
  return installSkill(url, name);
});
/** Delete an installed skill. The guard rails live in uninstallSkill — it refuses
 *  any path it cannot prove is a skill folder inside a skills root. */
ipcMain.handle('skills:uninstall', (_evt, path: unknown) => {
  // MUNDER_DEV=1: uninstall deletes from the user's GLOBAL/project skill dirs
  // shared with Stable's agents. Refused, like install.
  if (DEV_ISOLATION) return { ok: false as const, error: 'dev build — skill uninstalls are disabled under MUNDER_DEV=1' };
  if (typeof path !== 'string') return { ok: false as const, error: 'bad request' };
  const cfg = readConfig();
  return uninstallSkill(path, { cwds: cfg.registeredRepos ?? [] });
});
/** Reveal a skill on disk. `openExternal` is deliberately https-only, so a
 *  file:// URL cannot (and should not) be smuggled through it. */
ipcMain.handle('skills:reveal', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: 'bad request' };
  const skillRoots = [join(homedir(), '.claude', 'skills'), join(homedir(), '.config', 'opencode')];
  const target = resolve(path);
  const inRoot = skillRoots.some((r) => target.startsWith(resolve(r) + sep))
    || (readConfig().registeredRepos ?? []).some((c) => target.startsWith(resolve(c) + sep));
  if (!inRoot) return { ok: false, error: 'outside a managed skills directory' };
  if (DEV_HIDDEN) return { ok: false, error: 'hidden run' };   // MUNDER_HIDDEN: no Explorer window
  shell.showItemInFolder(target);
  return { ok: true };
});

// ─── IPC: setup catalog (which external tools are actually here) ────────────
/**
 * Probe every catalog row against THIS machine.
 *
 * Presence is a PATH resolution, not a spawn: running each candidate to read a
 * --version would be a dozen process launches on every panel open, and several of
 * these CLIs boot a TUI when invoked bare. `resolveCommand` returns its input
 * unchanged when it finds nothing, so "resolved to a real, existing path that is
 * not just the bare name" is the found test. (Memory is built in: it has no row.)
 */
// REFRESH-MODELS: ONE models file (userData/models.json) that every picker reads. It is filled ONLY
// by Settings -> Agents & Models -> "Refresh models" (models:refresh). models:catalog is a file
// read: nothing is looked up at startup or when a picker opens. Every lookup is async (no sync
// child process on main); Claude uses the Models API only with a stored Anthropic BYOK key.
const providerModels = new ProviderModelStore({
  path: join(app.getPath('userData'), 'models.json'),
  now: () => Date.now(),
  log: (row) => { try { hive.appendLog(row); } catch { /* best-effort */ } }
});
ipcMain.handle('models:catalog', () => providerModels.read());
ipcMain.handle('models:refresh', async () => {
  const cli = {
    platform: process.platform, env: process.env, exists: existsSync,
    exec: (file: string, args: string[], opts: Parameters<typeof execFile>[2], cb: (err: (Error & { code?: unknown; killed?: boolean }) | null, stdout: string) => void) =>
      execFile(file, args, opts, (err, stdout) => cb(err, String(stdout ?? '')))
  };
  const fetchJson = async (url: string, headers: Record<string, string>, timeoutMs: number) => {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  };
  const { file, rows } = await providerModels.refresh(defaultAdapters(cli, () => integrations.getSecret(providerKeyRef('anthropic')), fetchJson));
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.webContents.send('models:catalogChanged', file); } catch { /* gone */ } }
  return { file, rows };
});

ipcMain.handle('tools:status', async (): Promise<ToolStatus[]> => {
  const win = process.platform === 'win32';
  // SYNC-CHILD-CALLS: every row resolves through the shared ASYNC resolver, in parallel (this was
  // one synchronous `where` per row, on every panel open). Opening the panel is how a user checks
  // a CLI they just installed, so each row's cached answer is dropped first: fresh, but async.
  return Promise.all(toolCatalog().map(async (spec): Promise<ToolStatus> => {
    const installCommand = win ? spec.install.win32 : spec.install.posix;
    if (!spec.bin) return { ...spec, installCommand, found: false, path: null };
    let row: { found: boolean; path: string | null; unknown: boolean } = { found: false, path: null, unknown: false };
    try {
      invalidateCommandCache(spec.bin);
      row = toolRowStatus(await resolveCommandAsync(spec.bin), spec.bin, existsSync);
    } catch { /* a probe must never take the panel down */ }
    return { ...spec, installCommand, found: row.found, path: row.path, ...(row.unknown ? { unknown: true } : {}) };
  }));
});

// ─── IPC: semantic memory (the memory engine) ───────────────────────────────
// The Memory panel, Command Center and the voice tools ask the memory engine directly
// (main-internal, caller wing `human`); there is no CLI to find and no mine step.
const memoryReply = (r: { exit: number; text?: string; error?: string }): { ok: boolean; output: string; error?: string } =>
  r.exit === 0 ? { ok: true, output: r.text ?? '' } : { ok: false, output: r.text ?? '', error: r.error ?? `exit ${r.exit}` };
// MEMORY-STATUS-LAZY: asking never forks the worker (statusReport; the panel asks at start-up).
ipcMain.handle('hive:memoryStatus', async () => ({ enabled: readConfig().semanticMemory !== false, ...(await nativeMemory.statusReport()) }));
ipcMain.handle('hive:searchMemory', async (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memoryReply(await nativeMemory.query('search', { query, ...(typeof wing === 'string' && wing ? { wing } : {}) }));
});
ipcMain.handle('hive:memoryWakeUp', async (_evt, wing: unknown) =>
  memoryReply(await nativeMemory.query('wake-up', typeof wing === 'string' && wing ? { wing } : {})));
// Condense memory.md on demand: an explicit id condenses that one agent (skips
// the size trigger — a "condense now" button); no id runs a full threshold scan.
ipcMain.handle('memory:reflectNow', (_evt, id: unknown) =>
  reflector.reflectNow(typeof id === 'string' && id ? id : undefined));

// ─── IPC: enterprise Knowledge Graph (multimodal context for agents) ─────────
ipcMain.handle('kg:status', () => knowledge.status());
ipcMain.handle('kg:list', () => knowledge.list());
ipcMain.handle('kg:search', (_evt, query: unknown, limit: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return [];
  return knowledge.search(query, typeof limit === 'number' ? limit : undefined);
});
ipcMain.handle('kg:get', (_evt, id: unknown) =>
  (typeof id === 'string' && id ? knowledge.get(id) : null));
ipcMain.handle('kg:remove', (_evt, id: unknown) =>
  ({ ok: typeof id === 'string' && id ? knowledge.remove(id) : false }));
// Ingest one or more files from disk. Best-effort per file; returns per-file
// results so the UI can report partial success.
ipcMain.handle('kg:ingestFiles', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { paths?: unknown; tags?: unknown };
  const paths = Array.isArray(p.paths) ? p.paths.filter((x): x is string => typeof x === 'string') : [];
  const tags = Array.isArray(p.tags) ? p.tags.filter((x): x is string => typeof x === 'string') : undefined;
  // SYNC-CHILD-CALLS: ingest is async (a PDF's pdftotext runs as an async child); files still go
  // one at a time, in order, each with its own ok/error.
  const results: Array<{ ok: true; srcPath: string; docId: string; chunkCount: number } | { ok: false; srcPath: string; error: string }> = [];
  for (const srcPath of paths) {
    try {
      const r = await knowledge.ingestFile(srcPath, { tags });
      results.push({ ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount });
    } catch (e) {
      results.push({ ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { results };
});
// Open a multi-file picker and ingest the chosen artifacts in one round-trip.
ipcMain.handle('kg:addFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  if (DEV_HIDDEN) return { ok: false as const, error: 'cancelled' };   // MUNDER_HIDDEN: no dialog
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Add documents to the Knowledge Graph'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  const results: Array<{ ok: true; srcPath: string; docId: string; chunkCount: number } | { ok: false; srcPath: string; error: string }> = [];
  for (const srcPath of res.filePaths) {
    try {
      const r = await knowledge.ingestFile(srcPath);
      results.push({ ok: true as const, srcPath, docId: r.docId, chunkCount: r.chunkCount });
    } catch (e) {
      results.push({ ok: false as const, srcPath, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { ok: true as const, results };
});

// ─── IPC: composer attachments (images + arbitrary files, attached by PATH) ──
// The message queue pipes raw text into a Claude CLI PTY, so attachments travel
// as a file PATH the agent reads with its Read tool (same convention as Slack).
// Picker offers an Images group + All Files.
ipcMain.handle('dialog:attachFiles', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  if (DEV_HIDDEN) return { ok: false as const, error: 'cancelled' };   // MUNDER_HIDDEN: no dialog
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
    title: 'Attach images or files',
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'tiff', 'avif'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, files: res.filePaths.map((p) => ({ path: p, name: basename(p) })) };
});

// Persist the current native clipboard image to a temp PNG so a pasted
// screenshot can be attached by PATH. Returns an error result when the
// clipboard holds no image (e.g. a normal text paste).
ipcMain.handle('clipboard:saveImage', async () => {
  try {
    const img = clipboard.readImage();
    if (img.isEmpty()) return { ok: false as const, error: 'no image in clipboard' };
    const dir = join(app.getPath('temp'), 'cth-pastes');
    mkdirSync(dir, { recursive: true });
    const name = `paste-${Date.now()}.png`;
    const dest = join(dir, name);
    writeFileSync(dest, img.toPNG());
    return { ok: true as const, file: { path: dest, name } };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: command history (SQLite — every prompt submitted to an agent) ──────
ipcMain.handle('history:add', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { agentId?: unknown; cwd?: unknown; text?: unknown };
  if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
  try {
    persist.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('history:list', (_evt, agentId: unknown, limit: unknown) =>
  persist.listHistory(
    typeof agentId === 'string' && agentId ? agentId : undefined,
    typeof limit === 'number' ? limit : undefined
  ));
ipcMain.handle('history:search', (_evt, query: unknown, limit: unknown) =>
  persist.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : undefined));

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
/** Tear the harness down and quit. Shared by the hard "kill all & quit" path
 *  and the closing-time conclusion (after the god confirmed the floor saved). */
function teardownAndQuit(): void {
  const alreadyQuitting = allowQuit;
  allowQuit = true;
  const t0 = Date.now();
  // QUIT-HANG: hide every window FIRST. The teardown below is quick now, but a window
  // that stays on screen while the main thread is busy is what Windows ghosts and
  // files as an AppHang; a hidden one cannot read as a frozen floor.
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.hide(); } catch { /* closing */ } }
  // Each teardown step is best-effort: a throw here (e.g. a dying child or a
  // half-torn-down socket) must never abort the quit or pop a crash dialog.
  try { clearMissionTimers(); } catch (e) { console.error('[quit] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[quit] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[quit] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[quit] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[quit] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[quit] stopRouter:', e); }
  try { hive.stopLedgerGuard(); } catch (e) { console.error('[quit] stopLedgerGuard:', e); }
  try { boardMonitor.stop(); } catch (e) { console.error('[quit] boardMonitor.stop:', e); }
  try { floorDigest.stop(); boardStatus.stop(); } catch (e) { console.error('[quit] floorDigest.stop:', e); }
  try { hive.stopAgyStatusline(); } catch (e) { console.error('[quit] stopAgyStatusline:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[quit] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[quit] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[quit] slack.stop:', e); }
  try { stopWebhookServer(); } catch (e) { console.error('[quit] webhook.stop:', e); }
  try { reflector.stop(); } catch (e) { console.error('[quit] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[quit] persist.close:', e); }
  try { hive.stopAllProxyBridges(); } catch (e) { console.error('[quit] stopAllProxyBridges:', e); }
  // The slow step (every agent's process tree) runs async;
  // will-quit joins it, bounded, before app.exit. No synchronous child process on this path.
  void beginQuitWork();
  if (!alreadyQuitting) { try { hive.appendLog({ kind: 'quit-teardown', syncMs: Date.now() - t0 }); } catch { /* log is best-effort */ } }
  app.quit();
}

/** Upper bound on the async quit work (tree kills + daemon stop) that will-quit waits for. */
const QUIT_WORK_CAP_MS = 5_500;
let quitWork: Promise<QuitReport> | null = null;
/** QUIT-HANG: start the slow teardown once (idempotent) and hand back its bounded report.
 *  killAllAsync forgets its state synchronously, so a second quit
 *  path (window-all-closed, will-quit) joins this promise instead of starting over. */
function beginQuitWork(): Promise<QuitReport> {
  if (!quitWork) {
    const ptys = ptyManager.list().length;
    quitWork = runQuitSteps([
      { name: 'ptys', run: () => ptyManager.killAllAsync() }
    ], QUIT_WORK_CAP_MS).then((r) => ({ ...r, steps: { ...r.steps, ptyCount: ptys, ptyExitsPending: ptyManager.exitsPending } }));
  }
  return quitWork;
}
ipcMain.handle('app:confirmClose', () => {
  closingTime.cancel(); // a hard quit overrides a closing time in progress
  teardownAndQuit();
});
ipcMain.handle('app:cancelClose', () => {
  // The modal closes on the renderer side. The one thing main owes anybody here
  // is the truth about a restart-to-install: if this quit was one, it has just
  // been called off, and whoever is waiting on it needs to hear that rather than
  // sit disabled forever waiting for a process that is not going to die.
  abortPendingRestart();
});

// Open a new floor (independent office window). Gated by the multiWindow flag
// inside openFloor(); returns whether a window opened so a renderer button can
// reflect availability. The app-menu "New Floor" item calls openFloor() directly.
ipcMain.handle('window:newFloor', () => {
  const win = openFloor();
  return { ok: win != null };
});

// ─── IPC: closing time (graceful, data-loss-free shutdown) ──────────────────
// The third quit-dialog button. The god broadcasts closing time, every worker
// saves its memory and ACKs, the god concludes with CLOSING-TIME-COMPLETE —
// only then does the harness tear down. See closingTime.ts for the protocol.
const closingTime = new ClosingTimeController(
  hive,
  // Roster source: agents with a live PTY right now (ptyToAgent is pruned on
  // every teardown). The registry alone would include ghost workers from
  // sessions that ended with a hard quit — never archived, never able to ACK.
  () => [...new Set(ptyToAgent.values())],
  () => liveWebContents(),
  () => teardownAndQuit(),
  // #7C.2 steering — the graceful interrupt that reaches deeply busy agents
  // at their next hook boundary instead of waiting for a Stop.
  control
);
hive.setRoutedObserver((msg, targets) => closingTime.onRouted(msg, targets));
ipcMain.handle('app:startClosingTime', () => closingTime.start());
ipcMain.handle('app:cancelClosingTime', () => closingTime.cancel());

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', async () => {
  allowQuit = true;
  // Tear everything down first so nothing writes back into the dirs we wipe.
  try { clearMissionTimers(); } catch (e) { console.error('[reset] clearMissionTimers:', e); }
  try { clearContextTimers(); } catch (e) { console.error('[reset] clearContextTimers:', e); }
  try { stopWebhookDoneObserver(); } catch (e) { console.error('[reset] stopWebhookDoneObserver:', e); }
  try { stopEphemeralWorkerWatcher(); } catch (e) { console.error('[reset] stopWorkerWatcher:', e); }
  try { integrationBroker.stop(); } catch (e) { console.error('[reset] broker.stop:', e); }
  try { hive.stopRouter(); } catch (e) { console.error('[reset] stopRouter:', e); }
  try { hive.stopLedgerGuard(); } catch (e) { console.error('[reset] stopLedgerGuard:', e); }
  try { boardMonitor.stop(); } catch (e) { console.error('[reset] boardMonitor.stop:', e); }
  try { floorDigest.stop(); boardStatus.stop(); } catch (e) { console.error('[reset] floorDigest.stop:', e); }
  try { hive.stopAgyStatusline(); } catch (e) { console.error('[reset] stopAgyStatusline:', e); }
  try { hookServer.stop(); } catch (e) { console.error('[reset] hookServer.stop:', e); }
  try { telemetry.stop(); } catch (e) { console.error('[reset] telemetry.stop:', e); }
  try { stopSlackServer(); } catch (e) { console.error('[reset] slack.stop:', e); }
  // Jim M1: the memory worker holds <key>.sqlite(-wal/-shm) open, so an rm before it stops
  // fails with EBUSY on Windows (and was swallowed). Shut it down FIRST (bounded), then delete.
  const memoryIndex = nativeMemory.dbFile();
  const memoryStopped = nativeMemory.shutdown().catch(() => undefined);
  try { reflector.stop(); } catch (e) { console.error('[reset] reflector.stop:', e); }
  try { persist.close(); } catch (e) { console.error('[reset] persist.close:', e); }
  // SYNC-CHILD-CALLS: async bulk kill, still BEFORE hive.dispose and the rm below.
  ptyManager.refuseNewSpawns('The app is resetting; agents cannot start now.');
  try { await ptyManager.killAllAsync(); } catch (e) { console.error('[reset] killAllAsync:', e); }
  // The hive's kept-open log and ledger: an open file makes the rm below fail (ENOTEMPTY).
  try { hive.dispose(); } catch (e) { console.error('[reset] hive.dispose:', e); }
  // Erase the hive (Michael's + every agent's memory, inboxes, tasks, board,
  // git history) and the memory engine's index of it. Only harness-created data
  // is removed — never the user's whole harnessHome folder.
  await memoryStopped;
  deleteMemoryIndex(memoryIndex);
  const hiveDir = hive.root();
  if (hiveDir) {
    try { rmSync(hiveDir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', hiveDir, e); }
  }
  // The roster is the renderer's half of the same state, so it retires with the
  // hive — archived into roster-backups/ rather than deleted, and cleared as the
  // active file so re-selecting this folder later doesn't resurrect agents whose
  // sessions and memory are gone.
  try { roster.archive(); }
  catch (e) { console.error('[reset] roster.archive:', e); }
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
// Reconciler/fallback path: per-cwd transcript sum, now priced PER MODEL (cost
// bug #1 fixed in pricing.ts). Kept for back-compat with the existing UsageRow.
ipcMain.handle('hive:agentUsage', (_evt, cwd: unknown) =>
  // Per-CWD, not per-agent (no agent reads here), and no renderer calls it today.
  typeof cwd === 'string' ? readAgentUsage(cwd, { provider: 'claude' }) : null);
// Current context size (tokens) of an agent's LIVE session — the transcript
// path is learned from the agent's hook payloads (SessionStart fires right at
// spawn), so this works even when several agents share one cwd. Null until the
// first hook fires; a known-but-empty transcript reads as 0 so a freshly
// (re)started session zeroes the gauge instead of leaving a stale value up.
ipcMain.handle('hive:agentContext', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const tp = hookServer.transcriptPath(agentId);
  if (!tp) return null;
  // START-FIXES-163 (2): a non-Claude agent's gauge never reads a transcript.
  const a = hive.registry().agents[agentId];
  const provider = a ? (a.provider ?? 'claude') : undefined;
  if (!mayReadClaudeTranscripts(provider)) return null;
  return readContextTokens(tp, provider) ?? 0;
});

// HISTORY-VIEW-169: one bounded page of an agent's conversation, read from the provider's
// OWN transcript (Claude JSONL, Codex rollout, AGY brain transcript), not the terminal's
// scrollback. The renderer passes the agent id and a byte cursor only; the file is resolved
// here. Never throws: a missing source is a reason the tab shows.
const historyService = new HistoryService({
  agent: (id) => {
    const a = hive.enabled() ? hive.registry().agents[id] : undefined;
    return a ? { provider: a.provider, cwd: a.cwd, sessionId: a.sessionId } : null;
  },
  transcriptPath: (id) => hookServer.transcriptPath(id),
  codexHomeFor: (id) => (hive.enabled() ? hive.codexHomeFor(id) : null),
  geminiHome: () => geminiHome()
});
ipcMain.handle('hive:history', (_evt, req: unknown) => historyService.page(req));

// A consolidated, NON-SENSITIVE per-agent directory for the voice read-layer
// (Realtime Michael's get_agent_detail / list_agents). One read that joins
// everything the office-floor sidebar + telemetry know per agent: the registry
// record (name/role/provider/cwd/status/archived/isGod/isAssistant/sessionId/
// cwdValid), live token + breaker + last-tool telemetry, and the current context
// window fill. Includes ARCHIVED agents (unlike the heartbeat's fleet.json, which
// is live-only) so Michael can speak to inactive agents — their cwd and memory
// stay reachable. PII-free: no secrets, env, or API keys ever leave main; cost is
// carried as tokens (+ a usd field the voice layer deliberately never speaks).
ipcMain.handle('hive:agentDirectory', () => {
  if (!hive.enabled()) return { godId: null, agents: [] };
  const reg = hive.registry();
  const snap = telemetry.snapshot();
  const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
  const now = Date.now();
  const agents = Object.entries(reg.agents).map(([id, a]) => {
    const u = usageById.get(id);
    const spans = snap.spans[id] ?? [];
    const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
    const ctx = hookServer.contextFor(id);
    return {
      id,
      name: a.name,
      role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
      provider: a.provider ?? 'claude',
      model: u?.model ?? null,
      status: a.status ?? 'idle',
      cwd: a.cwd ?? null,
      cwdValid: a.cwdValid ?? null,
      archived: !!a.archived,
      isGod: !!a.isGod,
      isAssistant: !!a.isAssistant,
      sessionId: a.sessionId ?? null,
      hasMemory: hive.hasMemory(id),
      inboxBacklog: hive.inboxBacklog(id, { archived: archivedForMail(a) }),
      breaker: breaker.levelFor(id),
      tokens,
      usd: u ? Number(u.usd.toFixed(4)) : 0,
      lastTool: spans.length ? spans[spans.length - 1].tool : null,
      lastActiveSecAgo: u ? Math.round((now - u.ts) / 1000) : null,
      contextTokens: ctx?.tokens ?? null,
      contextLimit: ctx?.limit ?? null,
      contextPct: ctx && ctx.limit > 0 ? Math.round((ctx.tokens / ctx.limit) * 100) : null,
      // MODEL-PINBACK G3: what the agent runs (live, else launched, else pinned) - read-only.
      effectiveModel: effectiveModel(a) ?? null,
      pinnedModel: a.model ?? null
    };
  });
  return { godId: reg.godId, agents };
});

// ─── IPC: live telemetry (the OTel collector — the locked usage-provider seam) ─
// The fleet grid + span waterfall (#7B) read these; Lane A's breaker (#6)
// consumes getAgentUsage in-process via the provider, not over IPC.
ipcMain.handle('telemetry:usage', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getAgentUsage(agentId) : null);
ipcMain.handle('telemetry:spans', (_evt, agentId: unknown) =>
  typeof agentId === 'string' ? telemetry.getSpans(agentId) : []);
ipcMain.handle('telemetry:snapshot', () => telemetry.snapshot());

// ─── IPC: circuit-breaker state (Lane A #6 policy → this lane's avatars/meter) ─
// Lane A's breaker calls this with a BreakerState; we fan it out to the renderer
// on `control:breakerState`, where the avatar adapter gives it precedence over
// hook-derived status (#5C looping/zombie). Defined here so the channel exists
// before Jim's policy lands; he produces, this lane consumes.
ipcMain.handle('control:setBreakerState', (_evt, state: unknown) => {
  try { liveWebContents()?.send('control:breakerState', state); } catch { /* window tore down */ }
  return { ok: true };
});

// ─── IPC: operator control over agents (#7C.1–7C.3) ─────────────────────────
// All return the agent's fresh control snapshot so the UI can reflect state.
ipcMain.handle('control:pause', (_evt, agentId: unknown, on: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.pause(agentId, on === true);
  return control.snapshot(agentId);
});
// CODEX-TRUST-LAYER (1.1.76): a Codex spawn refused for an unreviewed project `.codex` layer, or
// started with a warning, is shown in the window (never a silent non-start); the Human allows a
// refused folder with one click, and it then starts with a warning. The notices live in memory:
// a refusal repeats at the next spawn attempt, and the log row (codex-trust-layer) is durable.
const codexLayerNotices: CodexLayerNotice[] = [];
function pushCodexLayerNotices(): void {
  for (const w of allWindows) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    try { w.webContents.send('codexLayer:noticesPush', codexLayerNotices.slice()); } catch { /* window tearing down */ }
  }
}
hive.codexLayerSink = (n) => {
  const same = codexLayerNotices.findIndex((x) => x.agentId === n.agentId && x.optInKey === n.optInKey);
  if (same >= 0) codexLayerNotices.splice(same, 1);
  codexLayerNotices.push(n);
  while (codexLayerNotices.length > 20) codexLayerNotices.shift();
  pushCodexLayerNotices();
};
ipcMain.handle('codexLayer:notices', () => codexLayerNotices.slice());
/** The one-click opt-in: only a folder a spawn was actually refused for (the key comes from
 *  main's own notice or spawn result, never a free path). */
ipcMain.handle('codexLayer:allow', (_evt, optInKey: unknown) => {
  if (typeof optInKey !== 'string' || !optInKey) return { ok: false, error: 'no folder' };
  if (!codexLayerNotices.some((n) => n.action === 'refuse' && n.optInKey === optInKey)) return { ok: false, error: 'that folder was not refused' };
  const cur = readConfig().codexLayerOptIns ?? [];
  writeConfig({ codexLayerOptIns: [...cur, optInKey] });
  for (let i = codexLayerNotices.length - 1; i >= 0; i--) if (codexLayerNotices[i].action === 'refuse' && codexLayerNotices[i].optInKey === optInKey) codexLayerNotices.splice(i, 1);
  hive.appendLog({ kind: 'codex-trust-layer-allowed', optInKey });
  pushCodexLayerNotices();
  return { ok: true };
});
ipcMain.handle('codexLayer:dismiss', (_evt, at: unknown) => {
  const i = codexLayerNotices.findIndex((n) => n.at === at);
  if (i >= 0) { codexLayerNotices.splice(i, 1); pushCodexLayerNotices(); }
  return true;
});
/** Settings: withdraw an allowed folder (the next spawn there is refused again). */
ipcMain.handle('codexLayer:revoke', (_evt, key: unknown) => {
  if (typeof key !== 'string') return { ok: false };
  const k = codexLayerOptInKey(key);
  writeConfig({ codexLayerOptIns: (readConfig().codexLayerOptIns ?? []).filter((x) => codexLayerOptInKey(x) !== k) });
  hive.appendLog({ kind: 'codex-trust-layer-revoked', optInKey: k });
  return { ok: true };
});
ipcMain.handle('control:autoDelivery', (_evt, agentId: unknown, paused: unknown) => {
  if (typeof agentId !== 'string') return null;
  const on = paused === true;
  control.pauseAutoDelivery(agentId, on);
  const current = new Set(readConfig().autoDeliveryPausedAgents ?? []);
  if (on) current.add(agentId); else current.delete(agentId);
  writeConfig({ autoDeliveryPausedAgents: Array.from(current).sort() });
  pushAgentImpact();
  return control.snapshot(agentId);
});
ipcMain.handle('control:resume', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.resume(agentId);
  return control.snapshot(agentId);
});
ipcMain.handle('control:gateTool', (_evt, agentId: unknown, tool: unknown, on: unknown) => {
  if (typeof agentId !== 'string' || typeof tool !== 'string') return null;
  control.gateTool(agentId, tool, on === true);
  return control.snapshot(agentId);
});
ipcMain.handle('control:steer', (_evt, agentId: unknown, text: unknown) => {
  if (typeof agentId !== 'string' || typeof text !== 'string') return null;
  control.steer(agentId, text);
  return control.snapshot(agentId);
});
ipcMain.handle('control:halt', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  control.halt(agentId);
  return control.snapshot(agentId);
});
// v1.1.45 unit #1 - the pool-level capacity collection, pulled by a (re)loaded window.
// Re-projected on the spot (a no-op revision-wise when nothing changed), so a window
// that loads before the first publication still gets the restored pools.
ipcMain.handle(CAPACITY_STRIP_CURRENT, () => {
  try { return presentCapacityStrip(); }
  catch (e) { console.warn('[capacity-strip]', e instanceof Error ? e.message : e); return null; }
});
// v1.1.45 CAPUI-MONITOR - one agent's 5h + weekly USAGE for its Monitor line, on its OWN
// channel (never control:snapshot, which carries no pool data). The pool is the one the
// agent's own readings landed in; no reading means text, never a guessed figure.
// v1.1.45 unit #4 - the provider DETAIL view for one pool, asked for only while the panel is
// open. Its OWN scoped channel: not control:snapshot, and not the strip object (C2.9). Built
// from the same tracker snapshot, at the same revision, as the strip it was opened from.
function capacityDetailViewOf(poolId: string): ProviderCapacityDetailView | null {
  const pool = providerCapacity.snapshot().pools.find((p) => capacityStrip.poolIdOf(p.poolKey) === poolId);
  if (!pool) return null;
  let presentation: CapacityStripCollection['pools'][number]['presentation'] | null = null;
  try { presentation = presentCapacityStrip().pools.find((p) => p.poolId === poolId)?.presentation ?? null; }
  catch { presentation = null; }
  const members = providerCapacity.membersOf(pool.poolKey);
  const view = capacityDetailView({
    pool, poolId, poolLabel: capacityStrip.labelOf(pool), presentation,
    members, membershipKnown: capacityMembershipKnown(pool.provider),
    statusNote: capacityStatusNote(members), now: Date.now()
  });
  const errors = validateCapacityDetail(view);
  if (errors.length) { console.warn('[capacity-detail] refused:', errors.slice(0, 3).join('; ')); return null; }
  return view;
}
// v1.1.46 A2 - the age note ticks while the panel stays open on a STALE pool: a main-side
// time edge re-pushes the SAME projection once a minute (capacityDetailTick.ts). Armed by the
// panel's own ask (open and every crit-17 re-ask), stopped by its close, by the window going,
// and by the pool no longer being stale. No renderer clock (crit 15).
const capacityDetailTicker = new CapacityDetailTicker({
  staleSince: (poolId) => {
    const pool = providerCapacity.snapshot().pools.find((p) => capacityStrip.poolIdOf(p.poolKey) === poolId);
    return pool && pool.freshness === 'STALE' ? pool.observedAt : null;
  },
  push: (windowId, poolId) => {
    const wc = BrowserWindow.getAllWindows().map((w) => w.webContents).find((c) => c.id === windowId);
    if (!wc || wc.isDestroyed()) { capacityDetailTicker.closed(windowId); return; }
    const view = capacityDetailViewOf(poolId);
    if (!view) { capacityDetailTicker.closed(windowId); return; }
    try { wc.send(CAPACITY_DETAIL_PUSH, view); } catch { capacityDetailTicker.closed(windowId); }
  },
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
});
ipcMain.handle(CAPACITY_DETAIL_CHANNEL, (evt, poolId: unknown) => {
  if (typeof poolId !== 'string') return null;
  const view = capacityDetailViewOf(poolId);
  if (view) capacityDetailTicker.opened(evt.sender.id, poolId);
  else capacityDetailTicker.closed(evt.sender.id, poolId);
  return view;
});
ipcMain.on(CAPACITY_DETAIL_CLOSED, (evt, poolId: unknown) => {
  if (typeof poolId === 'string') capacityDetailTicker.closed(evt.sender.id, poolId);
});

/**
 * The composer's OWN words for what admission is doing on a pool (Jim's obsolete-item #1:
 * the post-reset probe and probe-spent states must read the same in the details panel as in
 * the composer). Asked through a member agent with the same non-spending probe and the same
 * gate the per-agent snapshot uses; null when the pool has no member or nothing to say.
 */
function capacityStatusNote(members: readonly string[]): string | null {
  const agentId = members[0];
  if (!agentId) return null;
  const probed = providerCapacity.admission.probe(agentId, 'ORDINARY_TURN');
  const gate = capacityGateOf(probed,
    probed.poolKey ? providerCapacity.tracker.pool(probed.poolKey)?.freshness ?? null : null,
    undefined,
    probed.poolKey ? providerCapacity.tracker.resetOutlook(probed.poolKey) : null);
  return capacityStateNote(gate.evidence);
}

ipcMain.handle(CAPACITY_AGENT_USAGE, (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  const poolKey = providerCapacity.poolKeyOf(agentId);
  const view = agentUsageView(poolKey ? providerCapacity.tracker.pool(poolKey) : null, Date.now());
  const errors = validateAgentUsageView(view);
  if (errors.length) { console.warn('[capacity-usage] refused:', errors.slice(0, 3).join('; ')); return null; }
  return view;
});
// A person dismissed a capacity notice. Recorded in MAIN, so a reload cannot reopen it.
ipcMain.handle(CAPACITY_NOTICE_DISMISS, (_evt, noticeId: unknown) => {
  if (typeof noticeId !== 'string' || !capacityStrip.dismissNotice(noticeId)) return false;
  pushCapacityStrip();
  return true;
});
ipcMain.handle('control:snapshot', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string') return null;
  // Asked about once, pushed from then on (CRIT-15-PRE): the impact push serves this agent.
  impactWatched.add(agentId);
  const f = controlFactsOf(agentId);
  return { ...f.snap, capacityHold: f.gate.holds, capacityEvidence: f.gate.evidence, interfered: f.interfered, impact: f.impact,
    // WSG fix 3: the Codex screen check is holding this agent's automatic deliveries.
    screenHold: screenGuardNotices.hold(agentId, Date.now()) };
});

/** The snapshot's settled facts for one agent - the ONE computation behind both the
 *  control:snapshot answer and the impact push, so the two can never disagree. */
function controlFactsOf(agentId: string) {
  // L0-SEAM on the renderer's automatic queued dispatch. That path already consults
  // this snapshot and already has a no-penalty early return for a held agent, so the
  // gate costs no send attempt and drops no queued message - which the other
  // candidate seam, refusing the pty write, would do after three attempts.
  //
  // It PROBES rather than admits: this handler runs on every queue tick, and admitting
  // would spend the epoch's single recovery turn on the question.
  //
  // L0-UNKNOWN (the human's REVISED ruling, option ii - `UNKNOWN_POLICY` in
  // automaticSubmit.ts is the mapping in force; the first ruling, option B, which held
  // every UNKNOWN, is superseded). The flag used to be `verdict === 'REFUSE'`, one
  // of the four places UNKNOWN proceeded by an inequality nobody chose. It now comes
  // through the ONE resolver and the ONE ratified mapping, so this hint and the submit
  // owner cannot disagree - and the EVIDENCE rides along undissolved, because the ruling
  // requires "no pool" (outside capacity gating), "held for want of evidence" and
  // "allowed" to stay three different things for anything that shows them.
  const probed = providerCapacity.admission.probe(agentId, 'ORDINARY_TURN');
  const gate = capacityGateOf(probed,
    probed.poolKey ? providerCapacity.tracker.pool(probed.poolKey)?.freshness ?? null : null,
    undefined,
    probed.poolKey ? providerCapacity.tracker.resetOutlook(probed.poolKey) : null);
  // INTERFERED, read from the one owner (stage 5.4b). It is reported, never decided, here.
  const heldPty = ptyForAgent(agentId);
  const held = heldPty ? automaticSubmit.inhibition(heldPty) : null;
  const interfered = held ? { requestId: held.requestId, reason: held.reason, at: held.at } : null;
  const snap = control.snapshot(agentId);
  const impact = agentImpactFor(snap.autoDeliveryPaused, gate, interfered !== null, probed.poolKey);
  return { snap, gate, interfered, impact };
}

/**
 * v1.1.45 unit #5 - the agent-card impact, from the SAME settled facts the snapshot above
 * reports. The pool is named with the strip's own label and nothing else is taken from
 * the pool: a label and the tracker state word, never a figure, a window or a reset.
 */
function agentImpactFor(
  autoDeliveryPaused: boolean,
  gate: CapacityGate,
  interfered: boolean,
  poolKey: string | null
): AgentImpact | null {
  const pool = poolKey ? providerCapacity.tracker.pool(poolKey) : null;
  return agentImpactOf({
    interfered,
    autoDeliveryPaused,
    capacityHold: gate.holds,
    capacityEvidence: gate.evidence,
    poolState: pool?.state ?? null,
    poolLabel: pool ? capacityStrip.labelOf(pool) : null
  });
}

/**
 * L0-FUSION stage 5.3 - THE ONE DOOR for programmatic text+Enter from a renderer.
 *
 * The renderer chooses WHICH message and WHEN to ask, and acknowledges a queue item on a
 * reported COMMIT. That is all it does. It names an AGENT, never a PTY - main resolves the
 * terminal, so a request can no longer spend one agent's grant on another's prompt. It
 * holds no ticket, no capacity state, no ordering, no readiness polling and no settlement:
 * the renderer's write chain, its `typeAndSubmit` order and the capacity ticket IPC
 * (`capacity:beginAutoDelivery` / `markAutoDeliveryWriting` / `settleAutoDelivery`) are
 * REMOVED, not wrapped. A window that is reloaded or closed mid-delivery now costs
 * nothing: every step and the settle happen here, and the outcome is recorded against
 * the request id for a caller that comes back and asks again.
 *
 * Resolves with what HAPPENED; it never rejects for a delivery reason.
 */
ipcMain.handle('autoSubmit:submit', (_evt, req: unknown) => {
  const r = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>;
  if (typeof r.requestId !== 'string' || !r.requestId || typeof r.agentId !== 'string' || !r.agentId
    || typeof r.text !== 'string' || !r.text
    || typeof r.admissionClass !== 'string' || !(ADMISSION_CLASSES as readonly string[]).includes(r.admissionClass)) {
    return { kind: 'REJECTED', reason: 'BAD_REQUEST' };
  }
  const settleMs = typeof r.settleMs === 'number' && r.settleMs >= 0 && r.settleMs <= 10_000 ? r.settleMs : undefined;
  // START-FIXES-163 (3): one row per boot-prompt attempt, whatever it settles as
  // (COMMITTED, INTERFERED with its reason, REFUSED/ABORTED while the TUI boots, FAILED),
  // and a THREW row if the owner itself threw. Logging only: the outcome passes through.
  const boot = r.admissionClass === 'BOOT_SEQUENCE'
    ? { kind: 'boot-submit', agentId: r.agentId, requestId: r.requestId, attempt: typeof r.attempt === 'number' && Number.isInteger(r.attempt) && r.attempt > 0 ? r.attempt : null }
    : null;
  return automaticSubmit.submit({
    requestId: r.requestId, agentId: r.agentId, admissionClass: r.admissionClass as AdmissionClass,
    text: r.text, settleMs
  }).then((outcome) => {
    const o = outcome as { kind: string; reason?: string; detail?: string };
    // Logging is wrapped so it can never turn an outcome into a rejection.
    try { if (boot && bootSubmitRowDue(boot.requestId, o.kind, o.reason)) hive.appendLog({ ...boot, outcome: o.kind, reason: o.reason ?? null, ...(o.detail ? { detail: o.detail } : {}) }); } catch { /* logging only */ }
    return outcome;
  }, (e: unknown) => {
    try { if (boot) { bootSubmitRowDue(boot.requestId, 'THREW', undefined); hive.appendLog({ ...boot, outcome: 'THREW', reason: e instanceof Error ? e.message : String(e) }); } } catch { /* logging only */ }
    throw e;
  });
});

// HISTORY-SCROLL-FREEZE F3: what the renderer catches (a boundary, a window error, an unhandled
// rejection) lands in log.jsonl as one renderer-error row: validated, cut, and flood-gated.
const rendererErrorDue = createRendererErrorGate();
ipcMain.on('renderer:error', (_evt, raw: unknown) => {
  const report = normalizeRendererError(raw);
  if (!report) return;
  const gate = rendererErrorDue(report);
  if (!gate.log) return;
  try { hive.appendLog({ kind: 'renderer-error', ...report, ...(gate.dropped ? { droppedBefore: gate.dropped } : {}) }); } catch { /* best-effort */ }
});

// START-FIXES-163 (3), Jim N2: REFUSED/ABORTED retries are logged on change only.
const bootSubmitRowDue = createBootSubmitRowGate();

// START-FIXES-163 (3): the renderer's boot-prompt caller gave up (a final outcome, a
// dead PTY, an IPC failure). It used to swallow this; now it lands in log.jsonl.
ipcMain.on('autoSubmit:bootSubmitThrew', (_evt, agentId: unknown, message: unknown) => {
  if (typeof agentId !== 'string' || !agentId) return;
  hive.appendLog({
    kind: 'boot-submit', agentId, attempt: null, outcome: 'THREW', source: 'renderer',
    reason: typeof message === 'string' ? message.slice(0, 500) : String(message)
  });
});

/**
 * L0-FUSION stage 5.4b - A HUMAN RESOLVES AN INTERFERED HOLD.
 *
 * The only caller is a person's click in the composer, and the person SAYS HOW (human
 * ruling, option B): 'SEND_AGAIN' - the message was not handled, re-admit it through the
 * one owner with every gate - or 'ALREADY_HANDLED' - they dealt with it themselves, never
 * type it again. There is NO DEFAULT: a call that does not name one of the two is refused
 * and the hold stays, because the ambiguity of a bare "resolved" is exactly what produced
 * duplicate deliveries. Nothing here looks at the prompt to guess. It types nothing, clears
 * nothing and sends no Enter. There is deliberately no timer and no expiry: automation does
 * not get to decide a human's text is finished. The one main-side caller is the held-wake
 * watch (DWIGHT-HELD-INTERFERED): it releases an AUTOMATIC wake only when the owner's fresh
 * look proves the prompt clean (no human key since, our text nowhere on screen).
 */
ipcMain.handle('autoSubmit:resolveInterference', (_evt, agentId: unknown, how: unknown) => {
  if (typeof agentId !== 'string' || !agentId) return false;
  if (typeof how !== 'string' || !(INTERFERENCE_RESOLUTIONS as readonly string[]).includes(how)) return false;
  const ptyId = ptyForAgent(agentId);
  const resolved = ptyId ? automaticSubmit.resolveInterference(ptyId, how as InterferenceResolution) : false;
  pushAgentImpact();
  // The two human rulings stay distinct: SEND_AGAIN re-runs every guard, ALREADY_HANDLED
  // resolves the ids with no further submit.
  if (resolved) inboxWake?.onInterferenceResolved(agentId, how as InterferenceResolution);
  return resolved;
});

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prev = persistedById.get(m.id);
    const prevLastFired = prev?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    // TE0's two fields are scheduler-owned for exactly the same reason, and the
    // renderer never sets them at all — so they are taken from the persisted
    // record outright rather than max()'d. Without this, any save from the
    // Schedules panel would drop the delta baseline and the next tick would
    // dispatch on 'no-baseline': not dangerous (the gate fails open by design),
    // but it would quietly undo the saving every time the user edits a schedule.
    return {
      ...m,
      lastFiredAt,
      lastDeltaFingerprint: prev?.lastDeltaFingerprint,
      lastDispatchAt: prev?.lastDispatchAt
    };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});
/** TE0's force path: run a mission NOW, past the delta gate.
 *
 *  The gate only ever suppresses, so this is the other half of it — an operator
 *  who wants a standup on a floor that has not moved needs a way to say so, and
 *  before TE0 there was no run-now control at all.
 *
 *  Re-syncs afterwards because `fire()` stamps lastFiredAt, which is what the
 *  Schedules row derives "next" from; without it the panel would advertise a next
 *  run the timer was never going to honour. syncMissions re-arms every mission
 *  from its own lastFiredAt, so nothing else's partially-elapsed interval moves. */
ipcMain.handle('missions:runNow', (_evt, missionId: unknown) => {
  const id = typeof missionId === 'string' ? missionId : '';
  const entry = missionTimers.get(id);
  // No entry means disabled or unknown; no `fire` means a heartbeat, which beats
  // on its own adaptive cadence and has no dispatch to force.
  if (!entry?.fire) return { ok: false, error: 'mission is not armed for dispatch' };
  entry.fire(true);
  syncMissions();
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('hive:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: GitHub issue ingestion (gh CLI) ────────────────────────────────────
ipcMain.handle('github:issues', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listIssues(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: GitHub CI status watcher (gh CLI) ──────────────────────────────────
ipcMain.handle('github:ciRuns', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? listCIRuns(cwd) : { ok: false, error: 'no cwd' }
);

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: onboarding reliability — open Settings deep-link + login-item toggle ─
/** Open a System Settings deep-link (or https URL) in the OS default handler.
 *  Restricted to Settings panes / https so the renderer can't shell arbitrary
 *  schemes. Used by the onboarding "Permissions & reliability" step. */
ipcMain.handle('app:openExternal', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|https:\/\/)/.test(url)) {
    return { ok: false, error: 'blocked url' };
  }
  if (DEV_HIDDEN) return { ok: false, error: 'hidden run' };   // MUNDER_HIDDEN: no browser
  await shell.openExternal(url);
  return { ok: true };
});
/** Toggle macOS "Open at Login" — fully programmatic, no permission prompt.
 *  Returns the resulting state so the renderer toggle reflects reality. */
ipcMain.handle('app:setLoginItem', (_evt, enabled: unknown) => {
  app.setLoginItemSettings({ openAtLogin: enabled === true });
  return app.getLoginItemSettings().openAtLogin;
});

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
ipcMain.handle('slack:stop', () => { stopSlackServer(); return { ok: true }; });
/** Current connection state + last Request URL — lets Settings hydrate the
 *  "Connected" badge and re-show the persisted tunnel URL on reopen. */
ipcMain.handle('slack:status', () => ({ running: slackServer != null, url: lastSlackUrl }));
/** Absolute path to the bundled reply helper, for the prompt the office worker
 *  runs to post its summary back in-thread. No secret crosses this boundary. */
ipcMain.handle('slack:replyScriptPath', () => slackReplyScriptPath());
/** Renderer's immediate "queued" ack into the triggering Slack thread. The bot
 *  token stays in main — only channel/thread/text cross IPC. */
ipcMain.handle('slack:reply', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { channel?: unknown; thread_ts?: unknown; text?: unknown };
  const cfg = readConfig();
  // CLAUSE-3 (human: "stop posting into Slack by default"): this is the ONLY
  // app/voice-INITIATED proactive Slack post (the renderer's "queued" ack). It is
  // OFF unless the user opts in via Settings → Slack. The Slack-ORIGIN done-reply
  // round-trip (done-poller) and an agent's own direct /reply are NOT routed
  // through here, so they are unaffected and always stay on.
  if (!cfg.slackProactivePosting) return { ok: false, error: 'app-initiated Slack posting disabled (enable in Settings → Slack)' };
  const botToken = cfg.slackBotToken;
  if (!botToken) return { ok: false, error: 'no bot token' };
  if (typeof p.channel !== 'string' || typeof p.thread_ts !== 'string' || typeof p.text !== 'string') {
    return { ok: false, error: 'channel, thread_ts, text required' };
  }
  // CLAUSE-1 (fix-slack-integration): an app-initiated send must target an
  // EXPLICIT thread — reject a blank/whitespace channel or thread rather than
  // letting it fall through to an implicit destination (the channel root).
  if (!p.channel.trim() || !p.thread_ts.trim()) {
    return { ok: false, error: 'explicit channel + thread_ts required' };
  }
  return postSlackReply({ botToken, channel: p.channel, thread_ts: p.thread_ts, text: p.text });
});
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
    proactivePosting?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  if (typeof p.proactivePosting === 'boolean') next.slackProactivePosting = p.proactivePosting;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

// ─── IPC: Triggers — context (auto-compact / auto-clear) ────────────────────
ipcMain.handle('triggers:getContext', () => readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
ipcMain.handle('triggers:setContext', (_evt, arg: unknown) => {
  const current = readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
  const p = (arg ?? {}) as Partial<ContextTriggerConfig>;
  const next: ContextTriggerConfig = {
    compact: sanitizeContextRule(p.compact, current.compact),
    clear: sanitizeContextRule(p.clear, current.clear)
  };
  writeConfig({ contextTrigger: next });
  // The timers ARE the setting — a cadence saved but not re-armed would keep
  // firing on the old rhythm until the next boot.
  syncContextTriggers();
  return next;
});

/** Clamp one half of the context trigger. The renderer is not trusted with the
 *  arming maths: a zero/negative/NaN `everyMs` would arm a runaway timer, and an
 *  out-of-range percentage would silently disable (or permanently trip) the
 *  pressure gate. */
function sanitizeContextRule(patch: Partial<ContextRule> | undefined, current: ContextRule): ContextRule {
  const p = (patch ?? {}) as Partial<ContextRule>;
  const num = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    everyMs: num(p.everyMs, current.everyMs, 60_000, 86_400_000),
    minContextPct: num(p.minContextPct, current.minContextPct, 0, 100),
    minContextPctLargeWindow: num(p.minContextPctLargeWindow, current.minContextPctLargeWindow, 0, 100),
    message: typeof p.message === 'string' ? p.message : current.message
  };
}

// ─── IPC: Triggers — webhooks (many endpoints, one server, one tunnel) ──────
ipcMain.handle('webhooks:list', () => readConfig().webhookTriggers ?? []);
ipcMain.handle('webhooks:save', (_evt, arg: unknown) => {
  const incoming = Array.isArray(arg) ? arg : [];
  const existing = readConfig().webhookTriggers ?? [];
  const list: WebhookTrigger[] = [];
  const seen = new Set<string>();
  for (const raw of incoming) {
    const t = sanitizeWebhookTrigger(raw, existing);
    if (!t || seen.has(t.id)) continue; // an id is a URL path segment — one owner each
    seen.add(t.id);
    list.push(t);
  }
  writeConfig({ webhookTriggers: list });
  reconcileWebhookServer();
  return list;
});
ipcMain.handle('webhooks:delete', (_evt, arg: unknown) => {
  const id = typeof arg === 'string' ? arg : '';
  const list = (readConfig().webhookTriggers ?? []).filter((t) => t.id !== id);
  writeConfig({ webhookTriggers: list });
  // Revoking one endpoint must not disturb the others: the live server is
  // re-pointed, not restarted, so every remaining caller's URL keeps working.
  reconcileWebhookServer();
  return list;
});
/** Mint a strong (256-bit) secret for the operator to paste into their caller.
 *  Not persisted here — it belongs to whichever endpoint the UI saves it onto. */
ipcMain.handle('webhooks:generateSecret', () => randomBytes(32).toString('hex'));
/** Server state + the tunnel root + one public URL per configured endpoint (the
 *  UI offers a copy button per webhook, so the root alone isn't enough). */
ipcMain.handle('webhooks:status', () => ({
  running: webhookServer != null,
  url: lastWebhookUrl,
  endpoints: webhookEndpointUrls()
}));

/** Normalise one endpoint coming back from the renderer. Unknown/blank fields
 *  fall back to what is already persisted, so a UI that round-trips a partially
 *  filled row can never blank a live secret or silently widen a mode. */
function sanitizeWebhookTrigger(raw: unknown, existing: WebhookTrigger[]): WebhookTrigger | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<WebhookTrigger>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  // The id is spliced into a public URL path. Restrict it to a boring charset
  // rather than escaping later: no slashes (which would forge a nested route),
  // no encoded traversal, nothing that could make two endpoints alias.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null;
  const prior = existing.find((t) => t.id === id);
  const secret = typeof r.secret === 'string' && r.secret.trim() ? r.secret.trim() : prior?.secret ?? '';
  const mode = isTriggerMode(r.mode) ? r.mode : prior?.mode ?? DEFAULT_TRIGGER_MODE;
  return {
    id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : prior?.name ?? id,
    secret,
    // A secretless endpoint can never be enabled — it would be an open door.
    enabled: secret ? (typeof r.enabled === 'boolean' ? r.enabled : prior?.enabled ?? false) : false,
    mode,
    schema: typeof r.schema === 'string' && r.schema.trim() ? r.schema : prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: typeof r.createdAt === 'number' && r.createdAt > 0 ? r.createdAt : prior?.createdAt ?? Date.now()
  };
}

function isTriggerMode(v: unknown): v is TriggerMode {
  return v === 'strict' || v === 'allow-all' || v === 'communication-only';
}

// ─── IPC: Triggers — organisation (persistence only; no transport yet) ──────
ipcMain.handle('org:getTrigger', () => readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER);
ipcMain.handle('org:setTrigger', (_evt, arg: unknown) => {
  const current = readConfig().orgTrigger ?? DEFAULT_ORG_TRIGGER;
  const p = (arg ?? {}) as Partial<OrgTriggerConfig>;
  // PERSIST ONLY — the peer messaging service does not exist yet, so nothing
  // reads `apiKey` beyond the settings surface that shows it. Deliberately no
  // start/stop, no network, no side effect of any kind.
  const next: OrgTriggerConfig = {
    apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : current.apiKey,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current.enabled,
    mode: isTriggerMode(p.mode) ? p.mode : current.mode
  };
  writeConfig({ orgTrigger: next });
  return next;
});

// ─── IPC: Triggers — history ledger + the approval gate ─────────────────────
ipcMain.handle('triggerHistory:list', () => listTriggerHistory());
ipcMain.handle('triggerHistory:clear', (_evt, arg: unknown) => {
  const source = arg === 'webhook' || arg === 'org' ? arg : undefined;
  clearTriggerHistory(source);
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return { ok: true };
});
/**
 * The operator's verdict on a held message.
 *
 * 'approved' RELEASES it: it takes the identical path an auto-allowed message
 * would have taken (card + god request), then the entry flips. 'rejected' just
 * flips — nothing is ever dispatched.
 *
 * Idempotent by construction: only an entry still sitting at `pending` can be
 * decided, so a double-click (or two windows deciding at once) cannot dispatch
 * the same message twice.
 */
ipcMain.handle('triggerHistory:decide', (_evt, arg: unknown) => {
  const p = (arg ?? {}) as { id?: unknown; decision?: unknown };
  const id = typeof p.id === 'string' ? p.id : '';
  const decision = p.decision === 'approved' ? 'approved' : p.decision === 'rejected' ? 'rejected' : null;
  if (!id || !decision) return null;
  const entry: TriggerHistoryEntry | undefined = listTriggerHistory().find((e) => e.id === id);
  if (!entry) return null;
  if (entry.decision !== 'pending') return entry; // already decided → no-op, not a re-dispatch

  if (decision === 'rejected') {
    const next = updateTriggerHistory(id, { decision: 'rejected' });
    notifyTriggerHistoryUpdated();
    return next;
  }

  const taskId = `webhook-${randomBytes(8).toString('hex')}`;
  const tokenHash = heldTokenHashFor(id);
  const title = entry.title ?? (entry.body.length > 80 ? `${entry.body.slice(0, 79)}…` : entry.body);
  if (!dispatchWebhookWork({ taskId, title, message: entry.body, tokenHash, origin: entry.source })) {
    // The card is what the caller polls and what god works from. Leave the entry
    // pending so the operator can approve again once the hive is writable.
    return entry;
  }
  // The hash now lives on the card, so the caller's GET resolves through the
  // normal task lookup from here on.
  if (tokenHash) { heldTokens().delete(tokenHash); persistHeldTokens(); }
  const next = updateTriggerHistory(id, { decision: 'approved', taskId });
  pruneHeldTokens();
  notifyTriggerHistoryUpdated();
  return next;
});

// ─── IPC: Generic webhook (LEGACY single-endpoint channels) ─────────────────
// Kept alive for Settings → Webhook, which still speaks the one-secret shape.
// They are now THIN SHIMS over the multi-endpoint engine: the legacy secret and
// enabled flag map onto the `legacy` WebhookTrigger the config migration created,
// so the two surfaces can never disagree about whether the endpoint is live.
ipcMain.handle('webhook:start', () => startWebhookServer());
ipcMain.handle('webhook:stop', () => { stopWebhookServer(); return { ok: true }; });
/** Current state + last public endpoint URL, for the Settings badge/URL field. */
ipcMain.handle('webhook:status', () => ({ running: webhookServer != null, url: lastWebhookUrl }));
/** Mint a strong (256-bit) secret, persist it, and return it so Settings can show
 *  it for the user to copy into their client. The previous secret is replaced. */
ipcMain.handle('webhook:generateSecret', () => {
  const secret = randomBytes(32).toString('hex');
  writeConfig({ webhookSecret: secret });
  upsertLegacyWebhookTrigger({ secret });
  return { ok: true, secret };
});
ipcMain.handle('webhook:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { secret?: unknown; port?: unknown; enabled?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
  if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
  writeConfig(next);
  upsertLegacyWebhookTrigger({
    secret: typeof p.secret === 'string' ? p.secret.trim() : undefined,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined
  });
  // Disabling (or clearing the secret) stops the public surface immediately; the
  // reconcile also picks up the case where OTHER endpoints are still enabled, in
  // which case the server stays up minus the legacy one.
  reconcileWebhookServer();
  return { ok: true };
});

/** Mirror a legacy `webhook:setConfig` / `webhook:generateSecret` edit onto the
 *  `legacy` WebhookTrigger. Creates the row only once a secret exists — an
 *  enabled endpoint without a secret would be an open door, so a bare "enable"
 *  against a never-configured webhook is deliberately a no-op. */
function upsertLegacyWebhookTrigger(patch: { secret?: string; enabled?: boolean }): void {
  const list = readConfig().webhookTriggers ?? [];
  const prior = list.find((t) => t.id === 'legacy');
  const secret = patch.secret !== undefined ? patch.secret : prior?.secret ?? '';
  if (!secret) return;
  const row: WebhookTrigger = {
    id: 'legacy',
    name: prior?.name ?? 'Default webhook',
    secret,
    enabled: patch.enabled !== undefined ? patch.enabled : prior?.enabled ?? false,
    mode: prior?.mode ?? DEFAULT_TRIGGER_MODE,
    schema: prior?.schema ?? DEFAULT_WEBHOOK_SCHEMA,
    createdAt: prior?.createdAt ?? Date.now()
  };
  writeConfig({
    webhookTriggers: prior ? list.map((t) => (t.id === 'legacy' ? row : t)) : [...list, row]
  });
}

// ─── IPC: Free Flow (voice dictation → message queue) ────────────────────────
// Entry point B is hold-Option-to-talk, handled entirely in the renderer
// (capture-phase key listeners) — no globalShortcut here. macOS doesn't deliver
// the Fn key to Electron (electron#16714) and a faithful native Fn helper
// (CGEventTap) is deferred; hold-Option is the human-chosen v1 activation.

ipcMain.handle('freeflow:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as { enabled?: unknown; apiKey?: unknown; model?: unknown };
  const next: Partial<HarnessConfig> = {};
  if (typeof p.enabled === 'boolean') next.freeflowEnabled = p.enabled;
  // Trim string fields; an emptied key clears back to undefined.
  if (typeof p.apiKey === 'string') next.groqApiKey = p.apiKey.trim() || undefined;
  if (typeof p.model === 'string') next.freeflowModel = p.model.trim() || DEFAULT_GROQ_MODEL;
  writeConfig(next);
  return { ok: true };
});

/** Transcribe one captured audio clip via Groq. Gated on the flag + a key being
 *  present, so a disabled feature can NEVER reach the network. The Groq key stays
 *  in main — only the audio bytes cross IPC inbound and the transcript outbound. */
ipcMain.handle('freeflow:transcribe', async (_evt, arg: unknown) => {
  const cfg = readConfig();
  if (!cfg.freeflowEnabled) return { ok: false, error: 'Free Flow is disabled' };
  if (!cfg.groqApiKey) return { ok: false, error: 'no Groq API key set' };
  const a = (arg ?? {}) as { audio?: unknown; mimeType?: unknown; filename?: unknown; language?: unknown };
  if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) {
    return { ok: false, error: 'no audio' };
  }
  const out = await transcribeWithGroq({
    apiKey: cfg.groqApiKey,
    audio: a.audio,
    mimeType: typeof a.mimeType === 'string' ? a.mimeType : undefined,
    filename: typeof a.filename === 'string' ? a.filename : undefined,
    model: cfg.freeflowModel || DEFAULT_GROQ_MODEL,
    language: typeof a.language === 'string' && a.language ? a.language : undefined
  });
  if (out.ok) analytics.trackFeature('voice_dictation');
  return out;
});

// ─── IPC: Realtime Michael (voice orchestrator — ephemeral token mint, rt-1) ──
// MAIN owns the BYOK OpenAI key (encrypted broker, apikey:openai) and mints a
// short-lived EPHEMERAL client secret; the real key never crosses IPC. All wiring
// lives in ./realtime so this stays a single registration line.
registerRealtimeIpc();

// ─── IPC: Realtime Michael voice ACTIONS (rt-5, Phase 2) ─────────────────────
// Thin adapters over the SAME main fns the god PTY already uses. ALL of the safety
// spine — soft-vs-destructive tiering, the two-step verbal echo-back confirm, the
// distinct-token rule, the hard allowlist (kill-god / mass-ops forbidden), and the
// michael-voice attribution — lives in ./realtimeActions. This site only injects
// the existing functions; it adds NO new orchestration logic.
// ─── IPC: Realtime Michael completion watcher (rt-12, Phase 2) ───────────────
// Jim's net-new engine (realtimeCompletionWatcher.ts) detects a voice-dispatched
// task finishing (card→done OR a done-reply in michael-voice's inbox) and EMITS it;
// I own the seam — inject the hive read deps, push completions to the live session
// (so Michael speaks them unprompted), and bridge waitFor / queue-drain over IPC.
const completionWatcher = initCompletionWatcher({
  readTasks: () => { const t = hive.tasks() as { tasks?: TaskCard[] }; return Array.isArray(t?.tasks) ? t.tasks : []; },
  // Voice dispatches go out as from:michael-voice, so assignee done-replies land here.
  readInbox: () => {
    // Voice dispatches go out from:michael-voice, so done-replies normally land in its
    // inbox — but an assignee may address god out of habit. Merge both inboxes (de-dupe
    // by id) so a god-addressed completion isn't missed; the detector filters by sender.
    // ZT-I1-MAIL §11.8 #14: god's mail is read from its LEDGER (every state), so a done-reply the
    // harness archived into .done at god's Stop is still seen; the inbox files are kept as well
    // (michael-voice is no agent and has no ledger; a ledger error must not blind the watcher).
    try {
      const mv = hive.inbox('michael-voice') as unknown as InboxMessage[];
      const godId = hive.registry().godId;
      let godLedger: InboxMessage[] = [];
      if (godId) { try { godLedger = ledgerInboxMessages(hive.mail, godId); } catch { godLedger = []; } }
      const god = godId ? [...(hive.inbox(godId) as unknown as InboxMessage[]), ...godLedger] : [];
      const seen = new Set<string>();
      return [...mv, ...god].filter((m) => !!m?.id && !seen.has(m.id) && seen.add(m.id) !== undefined);
    } catch {
      return [];
    }
  },
  // MUNDER_HIDDEN (dev only): no toast from a hidden run.
  onNotify: (evt) => { try { if (!DEV_HIDDEN && Notification.isSupported()) new Notification({ title: 'Michael', body: evt.summary }).show(); } catch { /* best-effort */ } }
});

registerRealtimeActionIpc({
  hiveEnabled: () => hive.enabled(),
  hiveSend: (partial, from) => hive.send(partial, from),
  hiveTasks: () => hive.tasks(),
  hiveWriteTasks: (tasks) => hive.writeTasks(tasks, 'voice'),
  hiveRegistry: () => hive.registry(),
  hiveLog: (event) => hive.appendLog(event),
  controlPause: (id, on) => control.pause(id, on),
  controlSteer: (id, text) => control.steer(id, text),
  controlHalt: (id) => control.halt(id),
  controlSnapshot: (id) => control.snapshot(id),
  killAgent: (id) => {
    const r = ptyManager.kill(id);
    teardownPty(id);
    // A voice (MAIN-initiated) kill: the renderer never removed the card itself
    // (unlike a UI kill), so tell the floor to archive it. Mirrors hive:agentSpawned.
    try { liveWebContents()?.send('hive:agentArchived', { id }); } catch { /* window torn down */ }
    return r;
  },
  spawnAgent: async (opts) => {
    const o = opts as AgentSpawnOptions;
    const res = await spawnAgentCore(o, null);
    // The renderer roster is only mutated by renderer-initiated hires (AddAgentModal),
    // so a MAIN-initiated spawn is invisible on the floor until we broadcast it. The
    // renderer (useHive) builds the Agent card from this descriptor; addAgent is
    // idempotent so a renderer-initiated hire is never double-carded.
    if (res.ok) {
      try {
        liveWebContents()?.send('hive:agentSpawned', {
          id: o.id,
          name: o.hive?.name ?? o.id,
          provider: o.provider ?? o.hive?.provider ?? 'claude',
          cwd: res.worktreePath ?? o.cwd,
          command: o.command,
          role: o.hive?.role,
          worktreePath: res.worktreePath
        });
      } catch { /* window torn down */ }
    }
    return res;
  },
  listMissions: () => readConfig().missions ?? [],
  // The spec carries lastFiredAt through from listMissions(), so a wholesale write
  // preserves the scheduler's stamps; edit_schedule is deliberate + rare.
  saveMissions: (missions) => { writeConfig({ missions }); },
  // rt-12: register each voice dispatch so the watcher can detect its completion.
  trackDispatch: (d) => { try { completionWatcher.track({ ...d, kind: 'dispatch' }); } catch { /* watcher unavailable */ } },
  // ── v0.3.4 full-control extensions ──
  controlResume: (id) => control.resume(id),
  controlAutoDelivery: (id, paused) => { control.pauseAutoDelivery(id, paused); pushAgentImpact(); },
  controlGateTool: (id, toolName, on) => control.gateTool(id, toolName, on),
  setArchived: (id, archived) => {
    if (!hive.enabled()) return { ok: false, error: 'hive disabled' };
    hive.setArchived(id, archived);
    try { liveWebContents()?.send(archived ? 'hive:agentArchived' : 'hive:agentSpawned', { id }); } catch { /* window gone */ }
    return { ok: true };
  },
  // clear_context: hand the text to the renderer's queue so delivery rides every
  // existing gate (idle-only, boot grace, draft/picker safety).
  enqueueToAgent: (id, text) => {
    try { liveWebContents()?.send('realtime:enqueue', { agentId: id, text }); } catch { /* window gone */ }
  },
  getConfigValue: (key) => (readConfig() as unknown as Record<string, unknown>)[key],
  patchConfig: (patch) => { writeConfig(patch as Partial<HarnessConfig>); }
});

// rt-12 seam: push detected completions to the live floor; bridge live-flag, queue
// drain (closed-session warm-start), and wait_for over IPC. Then start polling.
completionWatcher.onCompletion((evt) => { try { liveWebContents()?.send('realtime:completion', evt); } catch { /* window gone */ } });
// v0.3.4: the floor delta watcher shares the session-live flag — while a voice
// session is open it pushes coalesced floor updates the renderer injects as
// silent conversation items (snapshot-at-connect + append-only deltas).
const floorWatcher = new RealtimeFloorWatcher({
  enabled: () => hive.enabled(),
  registry: () => hive.registry(),
  tasks: () => hive.tasks(),
  ptys: () => ptyManager.list().map((p) => ({ id: p.id, lastOutputAt: p.lastOutputAt })),
  push: (text) => { try { liveWebContents()?.send('realtime:floorDelta', { text }); } catch { /* window gone */ } }
});
floorWatcher.start();
ipcMain.handle('realtime:setSessionLive', (_e, live: unknown) => {
  completionWatcher.setSessionLive(live === true);
  floorWatcher.setSessionLive(live === true);
  return { ok: true };
});
// v0.3.4: app self-knowledge for the voice get_app_info tool — version + the
// newest CHANGELOG sections. Read-only; ships CHANGELOG.md with the app.
ipcMain.handle('app:info', () => {
  let changelog = '';
  for (const p of [join(app.getAppPath(), 'CHANGELOG.md'), join(process.cwd(), 'CHANGELOG.md')]) {
    try { changelog = readFileSync(p, 'utf8'); if (changelog) break; } catch { /* try next */ }
  }
  // The two newest RELEASED sections: "## [Unreleased]" is work in progress, not release notes
  // (Andy CHANGELOG audit nit). scripts/verify-packaged-changelog.cjs reads it the same way.
  const top = changelog
    ? changelog.split(/\n## /).slice(1).filter((s) => !/^\[?unreleased\]?/i.test(s)).slice(0, 2).map((s) => `## ${s}`).join('\n').slice(0, 8000)
    : '';
  return { version: app.getVersion(), changelog: top };
});
ipcMain.handle('realtime:drainCompletions', () => completionWatcher.drainQueuedCompletions());
ipcMain.handle('realtime:waitFor', (_e, taskId: unknown, timeoutMs: unknown) =>
  typeof taskId === 'string'
    ? completionWatcher.waitFor(taskId, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 120_000)
    : Promise.resolve({ timedOut: true as const, taskId: '' }));
completionWatcher.start();

// ─── god-triggered ephemeral Slack workers ──────────────────────────────────
// god drops a spawn-request JSON into HIVE_ROOT/spawn-requests/; MAIN polls that
// queue (same cadence + atomic-rename archival as the hive router — reliability
// over latency, no fs.watch/dedup needed), spins up a FRESH ISOLATED worker via
// the shared spawnAgentCore, dispatches the objective through the standard inbox
// path, then watches each worker for a terminal `act:"done"` (success → release)
// or excessive idleness (reap). All teardown flows through teardownPty's
// safety-gate, so a worker's worktree is never auto-removed while it holds
// unintegrated work. Every terminal failure informs god WITH the Slack coords so
// god closes the Slack loop; the success path is the worker replying in-thread.

/** A spawn-request god drops into HIVE_ROOT/spawn-requests/<id>.json. god authors
 *  these directly; `objective` and `cwd` are the only required fields. */
interface SpawnRequest {
  id?: string;
  objective?: string;
  command?: string;                                   // engine CLI; default = config.defaultCommand
  provider?: AgentProvider;                           // optional explicit provider
  model?: string;                                     // optional --model override (Claude)
  cwd?: string;                                        // repo the worker (and its worktree) runs in
  name?: string;                                       // display name
  slack?: { channel: string; thread_ts: string };     // reply target + where failures surface
  isolate?: boolean;                                   // default true (fresh worktree)
  tokenCap?: number;                                   // optional per-worker token cap (advisory P1)
  // Appearance on the office floor. Both optional and both validated renderer-side
  // against the real cast and accent lists, so a bad value degrades to the default
  // rather than breaking the card.
  //
  // Naming a worker after a cast member ALREADY gets you their avatar: the floor
  // card infers it from the name. These two exist for the case that inference
  // cannot express, an agent called something else that should still look like a
  // particular character, and picking the accent instead of taking the one hashed
  // from the worker id.
  character?: string;
  accent?: string;
}

/** Polling cadence — matches the hive router. */
const WORKER_TICK_MS = 1500;
let workerWatchTimer: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow tick (await spawn / git checks) never overlaps. */
let workerTickRunning = false;

/** HIVE_ROOT/spawn-requests — the queue dir god drops requests into. */
function spawnRequestsDir(): string | null {
  const root = hive.root();
  return root ? join(root, 'spawn-requests') : null;
}

/** Move a processed request out of the queue so it's never reprocessed. */
function archiveRequest(filePath: string, sub: '.done' | '.failed'): void {
  const queue = spawnRequestsDir();
  try {
    if (!queue) throw new Error('no hive root');
    const dir = join(queue, sub);
    mkdirSync(dir, { recursive: true });
    renameSync(filePath, join(dir, basename(filePath)));
  } catch (e) {
    // Last resort: delete it so a poison file can't loop forever.
    try { unlinkSync(filePath); } catch { /* noop */ }
    console.error('[worker] archiveRequest failed:', e);
  }
}

/** Did this worker post a terminal `act:"done"` yet? Scans its own outbox AND
 *  outbox/.sent (the router archives delivered mail there ~every 1.5s), so the
 *  signal is caught whether or not it's been routed out yet.
 *
 *  Stale-done guard: agent dirs persist after teardown, so REUSING a reqId would
 *  leave a PRIOR worker's `done` sitting in this same dir. Without a guard that
 *  stale signal would release the new worker on its very first tick — before it
 *  does anything or replies — causing a silent Slack hang. So we only count a
 *  `done` authored AFTER this worker spawned: by its `created_at` (the message's
 *  own timestamp), falling back to the file's mtime when `created_at` is missing
 *  or unparseable. When neither yields a usable timestamp we DON'T count it
 *  (fail toward keeping the worker alive — the idle reaper is the backstop). */
function workerSignaledDone(workerId: string, spawnedAt: number): boolean {
  const root = hive.root();
  if (!root) return false;
  const base = join(root, 'agents', workerId, 'outbox');
  for (const dir of [base, join(base, '.sent')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as { act?: string; created_at?: string };
        if (msg.act !== 'done') continue;
        let ts = Date.parse(msg.created_at ?? '');
        if (!Number.isFinite(ts)) {
          try { ts = statSync(fp).mtimeMs; } catch { ts = NaN; }
        }
        if (Number.isFinite(ts) && ts > spawnedAt) return true;
      } catch { /* skip unreadable/partial */ }
    }
  }
  return false;
}

/** Spin up one ephemeral worker from a spawn-request. Terminal failures (bad
 *  request, missing CLI, spawn error) archive to .failed and inform god WITH the
 *  Slack coords so god can post a 'couldn't start' reply. On success the worker is
 *  registered (for done-scan / reaping / safe teardown) and dispatched its
 *  objective via the standard inbox path. */
async function processSpawnRequest(filePath: string): Promise<void> {
  let raw: SpawnRequest;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8')) as SpawnRequest;
  } catch (e) {
    console.error('[worker] unparseable spawn-request:', filePath, e);
    informGod('[worker spawn rejected] unparseable request', `Could not parse spawn-request ${basename(filePath)} — ${String(e)}`);
    archiveRequest(filePath, '.failed');
    return;
  }
  const slack = raw.slack && typeof raw.slack.channel === 'string' && typeof raw.slack.thread_ts === 'string'
    ? { channel: raw.slack.channel, thread_ts: raw.slack.thread_ts } : undefined;
  const fail = (reason: string): void => {
    informGod(`[worker spawn rejected] ${reason}`, `Spawn-request ${basename(filePath)} rejected: ${reason}.`, slack);
    archiveRequest(filePath, '.failed');
  };

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
  if (!objective) { fail('missing "objective"'); return; }

  const reqId = (typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : basename(filePath).replace(/\.json$/i, ''))
    .replace(/[^A-Za-z0-9._-]/g, '-');
  const workerId = `worker-${reqId}`;
  if (liveWorkers.has(workerId)) { fail(`worker "${workerId}" already running`); return; }

  // Worker request files are hand/LLM-authored, so `~/…` shows up here too — expand
  // before the existence check (Node reads `~` literally).
  const cwd = typeof raw.cwd === 'string' && raw.cwd.trim() ? expandTilde(raw.cwd) : '';
  if (!cwd || !existsSync(cwd)) { fail(`"cwd" missing or not found (${cwd || 'unset'})`); return; }

  // Request line → executable + argv (auto-mode inheritance, tokenization,
  // model-flag dedupe). Pure and unit-tested — see workerLaunch.ts for why this
  // translation earned a test.
  const cfgSpawn = readConfig();
  const launch = buildWorkerLaunch({
    requestCommand: raw.command,
    requestProvider: raw.provider,
    requestModel: raw.model,
    defaultCommand: cfgSpawn.defaultCommand,
    autoMode: !!cfgSpawn.autoMode
  });
  const bin = launch.bin;
  // Validate the executable name on the spawn path. A spawn-request file is
  // untrusted input (authored by the orchestrator, reachable by anything that can
  // write HIVE_ROOT/spawn-requests), so the bin must be a plain command token or
  // an absolute path — never a string a downstream shell `which`/`where` could
  // reinterpret. Rejected here, before any resolution; the resolver guards behind
  // it validate the same thing in depth.
  if (!isSafeCommandName(bin) && !isAbsolute(bin)) {
    fail(`refusing spawn: engine command "${bin}" is not a plain command name or an absolute path`);
    return;
  }
  // Missing-CLI → FAIL FAST. A headless worker has no human to watch an installer,
  // so we never run the cc49e1e install banner here — we reject and tell god.
  // A requested spawn: re-resolve rather than trust a cached miss (Jim's audit CHANGE 2).
  invalidateCommandCache(bin);
  // RESOLVER-TIMEOUT-MISS: a lookup killed by its time box (twice) is not "not installed". Refuse
  // with a reason that says so, so the requester retries instead of reporting a missing CLI.
  const engineRefusal = headlessSpawnRefusal(bin, await ptyManager.commandStatus(bin));
  if (engineRefusal) { fail(engineRefusal); return; }

  const isolate = raw.isolate !== false; // default true
  // Base branch the worktree will be cut from (for the ahead-of-base safety check).
  let baseBranch = 'main';
  try { const br = await getBranch(cwd); if ('current' in br && br.current) baseBranch = br.current; } catch { /* keep default */ }

  const meta: AgentMeta = {
    id: workerId,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `Worker ${reqId.slice(0, 12)}`,
    provider: raw.provider,
    role: 'worker',
    cwd
  };
  // Phase 2: grant this worker a broker capability over the currently-enabled
  // integrations and inject the broker URL + a per-worker capability TOKEN (a handle,
  // never a secret) into its env, so it can reach registered REST integrations through
  // the loopback secret broker without ever seeing a credential. Only when the broker
  // is up; the grant is revoked in teardownPty (and below if the spawn fails).
  const brokerEnv: Record<string, string> = {};
  if (integrationBroker.running()) {
    const token = integrationBroker.grant(workerId, integrations.enabledIds());
    brokerEnv.MD_BROKER_URL = integrationBroker.url();
    brokerEnv.MD_BROKER_TOKEN = token;
  }
  const spawnOpts: AgentSpawnOptions = {
    id: workerId, cwd, command: bin, cols: 120, rows: 32,
    args: launch.args,
    hive: meta, isolate, provider: raw.provider, env: brokerEnv
  };

  let res: { ok: boolean; error?: string; worktreePath?: string };
  try {
    res = await spawnAgentCore(spawnOpts, liveWebContents());
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  if (!res.ok) { integrationBroker.revoke(workerId); fail(`spawn failed — ${res.error ?? 'unknown error'}`); return; }

  // A god-hired worker is a MAIN-initiated spawn, so the renderer would never
  // card it on its own (same reason as the voice-spawn broadcast): without this
  // the worker is invisible on the floor, never enters the roster, and after a
  // restart nothing offers to restore it. The card rides the normal agent
  // lifecycle from here — teardownPty broadcasts the matching archive. A card
  // RESTORED after an app quit revives through the renderer's normal spawn path
  // and never re-enters liveWorkers: ephemerality is a property of the hiring,
  // not of the card, so a restored worker is a regular agent (no reaping).
  try {
    liveWebContents()?.send('hive:agentSpawned', {
      id: workerId,
      name: meta.name,
      provider: raw.provider ?? 'claude',
      cwd: res.worktreePath ?? cwd,
      command: launch.command,
      role: meta.role,
      worktreePath: res.worktreePath,
      character: typeof raw.character === 'string' ? raw.character : undefined,
      accent: typeof raw.accent === 'string' ? raw.accent : undefined
    });
  } catch { /* window torn down */ }

  // Register for done-scan / idle-reap / token-cap / safe teardown (pty id == workerId).
  // tokenCap is optional plumbing (default unlimited) — only a positive finite cap is kept.
  const tokenCap = typeof raw.tokenCap === 'number' && Number.isFinite(raw.tokenCap) && raw.tokenCap > 0
    ? raw.tokenCap : undefined;
  liveWorkers.set(workerId, { workerId, reqId, name: meta.name, slack, baseBranch, spawnedAt: Date.now(), tokenCap });

  // Dispatch the objective via the standard inbox path (zero new transport),
  // reusing the autonomous-request preamble so the worker gets the exact Slack
  // reply command + autonomy policy. `from: god` so the worker treats it as a god
  // dispatch per its protocol.
  try {
    const prefix = slack
      ? buildAutonomousRequestProtocol(slack.channel, slack.thread_ts, slackReplyScriptPath())
      : '[AUTONOMOUS WORKER TASK — no interactive human is watching. Work autonomously; do not ask interactive questions.] The task starts now: ';
    const suffix = `\n\n[CAPABILITIES] Before you start, consult your capability catalog — run the \`/capabilities\` skill (or read \`$AGENT_DIR/.claude/skills/capabilities/SKILL.md\`). It lists your temporal date-range skills (\`/today\`, \`/last30Days\`, \`/lastQuarter\`, …) and the integrations available to you (reached via the loopback broker) and how to call each. For any time-scoped work, resolve the dates with those skills instead of computing them by hand.\n\n[WORKER COMPLETION] When finished, signal done by sending ONE outbox message to god with "act":"done" and a short result summary — that releases this ephemeral worker (terminal closed; your branch is handed to god). Do NOT push to any remote; god is the sole integrator.`;
    hive.send({ to: workerId, conversation: `worker-${reqId}`, act: 'request', subject: meta.name, body: `${prefix}${objective}${suffix}` }, 'god');
  } catch (e) {
    console.error('[worker] dispatch send failed:', e);
  }

  console.log(`[worker] spawned ${workerId} (cwd=${cwd}, base=${baseBranch}${slack ? ', slack' : ''})`);
  archiveRequest(filePath, '.done');
}

/** Total tokens (input+output+cache) a worker has burned so far, from the usage
 *  provider — 0 when unknown. Mirrors the breaker's `tokensOf`. Used only by the
 *  (default-off) per-worker token cap. */
function workerTokensUsed(workerId: string): number {
  const s = usageProvider.getAgentUsage(workerId);
  return s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;
}

/** Throttle for the GC sweep — git checks are cheap but pointless every 1.5s tick. */
const GC_SWEEP_MS = 60_000;
let lastGcSweepAt = 0;
let gcSweepRunning = false;

/** Reclaim preserved worker worktrees (+ their scratch dirs) whose work is now
 *  integrated, or whose worktree was already removed by hand. Fail-safe: a worktree
 *  is removed ONLY when `worktreeIsGcSafe` proves it clean AND integrated; any doubt
 *  KEEPS it (never discards un-integrated work — god is the sole integrator). Runs
 *  inside the worker tick, throttled to GC_SWEEP_MS, and is a no-op when nothing is
 *  preserved (the common case → zero cost). */
async function gcPreservedWorktrees(): Promise<void> {
  if (gcSweepRunning || preservedWorktrees.size === 0) return;
  gcSweepRunning = true;
  try {
    for (const [key, e] of [...preservedWorktrees]) {
      // A worker id that is live again (reqId reuse) → never GC its worktree or
      // scratch out from under the new run; leave the stale entry for a later sweep.
      if (liveWorkers.has(e.workerId)) continue;
      // (a) Worktree already gone (removed at clean teardown, or god removed it by
      //     hand per the preserve note) → just reclaim the scratch dir + drop tracking.
      if (!existsSync(e.wtPath)) {
        removeWorkerScratch(e.workerId);
        preservedWorktrees.delete(key);
        console.log(`[worker gc] ${e.workerId}: worktree already gone — reclaimed scratch`);
        continue;
      }
      // (b) Still on disk → reclaim ONLY when provably integrated + clean.
      let safe: { gc: boolean; detail: string };
      try { safe = await worktreeIsGcSafe(e.wtPath, e.baseBranch); }
      catch (err) { console.error('[worker gc] gc-safe check threw (keeping):', err); continue; }
      if (!safe.gc) continue; // keep — fail-safe
      const r = await removeWorktree(e.origCwd, e.wtPath);
      if (!r.ok) { console.error(`[worker gc] removeWorktree failed (keeping ${e.workerId}):`, r.error); continue; }
      removeWorkerScratch(e.workerId);
      preservedWorktrees.delete(key);
      console.log(`[worker gc] reclaimed ${e.workerId} (${safe.detail})`);
      informGod(
        `[worker worktree reclaimed] ${e.workerId}`,
        `The preserved worktree for ${e.workerId} is now integrated (${safe.detail}), so it and its scratch dir were garbage-collected.\nWorktree: ${e.wtPath}`,
        e.slack
      );
    }
  } finally {
    gcSweepRunning = false;
  }
}

/** One controller tick: (1) finish/reap live workers (frees slots), then (2) pull
 *  new requests up to the concurrency cap. Order matters so a freed slot is reused
 *  the same tick. */
async function ephemeralWorkerTick(): Promise<void> {
  if (workerTickRunning) return;
  workerTickRunning = true;
  try {
    const cfg = readConfig();
    const maxWorkers = Math.max(1, cfg.maxConcurrentWorkers ?? 4);
    const idleTimeoutMs = Math.max(1, cfg.workerIdleTimeoutMinutes ?? 20) * 60_000;
    // Per-worker token cap. 0 = UNLIMITED (the default — wired but never throttles
    // unless a positive cap is set per-request or via defaultWorkerTokenCap).
    const defaultTokenCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
      ? cfg.defaultWorkerTokenCap : 0;

    // (1) Finish or reap. Each release calls teardownPty EXPLICITLY after the
    //     kill, like every other kill site: ptyManager.kill() deletes the session
    //     synchronously, so when node-pty's async onExit later fires it fails the
    //     session-identity guard and the global exit handler (→ teardownPty)
    //     never runs. Relying on onExit here left released workers un-torn-down:
    //     no hive archive, no hive:agentArchived, frozen floor cards, and god
    //     kept mailing dead agents (seen live 2026-08-16 with worker-business/
    //     worker-qa/worker-bizreview). A double teardown is a harmless no-op.
    for (const [workerId, rec] of [...liveWorkers]) {
      if (rec.releasing) continue;
      if (workerSignaledDone(workerId, rec.spawnedAt)) {
        // Success: the worker already replied in-thread; just release it.
        rec.releasing = true;
        console.log(`[worker] ${workerId} signaled done — releasing`);
        ptyManager.kill(workerId);
        teardownPty(workerId);
        continue;
      }
      // Token-cap reap (default-off plumbing). An effective cap > 0 → reap when the
      // worker's cumulative token use exceeds it; its committed work is preserved.
      const tokenCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : defaultTokenCap;
      if (tokenCap > 0) {
        const used = workerTokensUsed(workerId);
        if (used > tokenCap) {
          rec.releasing = true;
          console.warn(`[worker] reaping ${workerId} — token cap (${used.toLocaleString()} > ${tokenCap.toLocaleString()})`);
          informGod(
            `[worker reaped — token cap] ${workerId}`,
            `Worker ${workerId} used ${used.toLocaleString()} tokens (> its cap of ${tokenCap.toLocaleString()}) and was reaped. Any committed work on its branch is preserved for you.`,
            rec.slack
          );
          ptyManager.kill(workerId);
          teardownPty(workerId);
          continue;
        }
      }
      const idleMs = ptyManager.idleFor(workerId);
      if (idleMs === undefined) continue; // PTY already gone; teardownPty cleans up
      if (idleMs > idleTimeoutMs) {
        rec.releasing = true;
        console.warn(`[worker] reaping idle ${workerId} (${Math.round(idleMs / 60000)}min idle)`);
        informGod(
          `[worker reaped — idle] ${workerId}`,
          `Worker ${workerId} produced no output for ${Math.round(idleMs / 60000)} min (> the ${Math.round(idleTimeoutMs / 60000)} min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.`,
          rec.slack
        );
        ptyManager.kill(workerId);
        teardownPty(workerId);
      }
    }

    // (2) Process new requests, honoring the concurrency cap (backpressure: leave
    //     the rest in the queue for a later tick).
    //
    //     Gated on config.orchestratorMaySpawn (default OFF): letting the
    //     orchestrator spin up agents unprompted is a SPEND decision, so the
    //     operator opts in. The gate sits HERE, on intake, and not on the watcher
    //     itself, because step (1) above owns the lifecycle of workers that are
    //     already running — reaping, teardown, the Slack failure notice — and
    //     turning the toggle off mid-flight must not strand them.
    //
    //     Declining also means declining to CONSUME. A request dropped in while
    //     this is off stays in the queue and runs when it is turned on, rather
    //     than being eaten and failed for a reason god never asked about.
    const dir = readConfig().orchestratorMaySpawn ? spawnRequestsDir() : null;
    if (dir && existsSync(dir)) {
      let files: string[] = [];
      try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { /* dir vanished */ }
      for (const f of files) {
        if (liveWorkers.size >= maxWorkers) break;
        await processSpawnRequest(join(dir, f));
      }
    }

    // (3) GC preserved worktrees whose work has since integrated. Throttled to
    //     GC_SWEEP_MS and a no-op when nothing is preserved (the common case).
    const now = Date.now();
    if (preservedWorktrees.size > 0 && now - lastGcSweepAt >= GC_SWEEP_MS) {
      lastGcSweepAt = now;
      await gcPreservedWorktrees();
    }
  } catch (e) {
    console.error('[worker] tick error:', e);
  } finally {
    workerTickRunning = false;
  }
}

function startEphemeralWorkerWatcher(): void {
  if (workerWatchTimer || !hive.enabled()) return;
  const dir = spawnRequestsDir();
  if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { /* noop */ } }
  workerWatchTimer = setInterval(() => { void ephemeralWorkerTick(); }, WORKER_TICK_MS);
}

function stopEphemeralWorkerWatcher(): void {
  if (workerWatchTimer) { clearInterval(workerWatchTimer); workerWatchTimer = null; }
}

/** Snapshot of one live ephemeral worker for the renderer Workers tab. */
interface WorkerSnapshot {
  workerId: string;
  reqId: string;
  name: string;
  baseBranch: string;
  spawnedAt: number;
  ageMs: number;
  idleMs: number | null;        // null = PTY already gone
  tokensUsed: number;
  tokenCap: number | null;      // effective cap (per-request or config default); null = unlimited
  hasSlack: boolean;
  releasing: boolean;
  status: 'releasing' | 'working';
}
/** Snapshot of a preserved-but-not-yet-GC'd worktree for the tab. */
interface PreservedSnapshot {
  workerId: string;
  wtPath: string;
  baseBranch: string;
  preservedAt: number;
}

/** List live ephemeral workers (+ preserved worktrees awaiting GC) for the tab. */
ipcMain.handle('workers:list', (): { live: WorkerSnapshot[]; preserved: PreservedSnapshot[]; maxWorkers: number } => {
  const cfg = readConfig();
  const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0
    ? cfg.defaultWorkerTokenCap : 0;
  const now = Date.now();
  const live: WorkerSnapshot[] = [...liveWorkers.values()].map((rec) => {
    const idle = ptyManager.idleFor(rec.workerId);
    const effCap = (rec.tokenCap && rec.tokenCap > 0) ? rec.tokenCap : (defaultCap > 0 ? defaultCap : 0);
    return {
      workerId: rec.workerId,
      reqId: rec.reqId,
      name: rec.name ?? rec.workerId,
      baseBranch: rec.baseBranch,
      spawnedAt: rec.spawnedAt,
      ageMs: Math.max(0, now - rec.spawnedAt),
      idleMs: idle === undefined ? null : idle,
      tokensUsed: workerTokensUsed(rec.workerId),
      tokenCap: effCap > 0 ? effCap : null,
      hasSlack: !!rec.slack,
      releasing: !!rec.releasing,
      status: rec.releasing ? 'releasing' : 'working'
    };
  });
  const preserved: PreservedSnapshot[] = [...preservedWorktrees.values()].map((e) => ({
    workerId: e.workerId, wtPath: e.wtPath, baseBranch: e.baseBranch, preservedAt: e.preservedAt
  }));
  return { live, preserved, maxWorkers: Math.max(1, cfg.maxConcurrentWorkers ?? 4) };
});

/** Manually stop a live ephemeral worker. Mirrors the done-release path: mark
 *  releasing, then kill + teardownPty runs the SAFETY-GATED worktree teardown
 *  (committed work is preserved, never force-discarded). Idempotent. teardownPty
 *  is called explicitly (D10) rather than left to the PTY's natural exit: kill()
 *  frees the manager's id slot synchronously, so by the time the process's real
 *  exit arrives the exit-handler's stale-id guard already misreads it as a
 *  reclaimed id and skips teardown — the worker would stay "live" in registry.json
 *  and fleet.json forever after this call. */
ipcMain.handle('workers:stop', (_evt, workerId: string): { ok: boolean; error?: string } => {
  if (typeof workerId !== 'string' || !workerId) return { ok: false, error: 'invalid worker id' };
  const rec = liveWorkers.get(workerId);
  if (!rec) return { ok: false, error: 'no such live worker' };
  if (rec.releasing) return { ok: true }; // already stopping
  rec.releasing = true;
  console.log(`[worker] manual stop requested for ${workerId}`);
  try { ptyManager.kill(workerId); } catch (e) { return { ok: false, error: String(e) }; }
  teardownPty(workerId);
  return { ok: true };
});

/** Start every hive-bound background service against the current harnessHome.
 *  Called on boot, and again to recover in place if a folder-change copy fails
 *  (config:changeHome tears these down before copying). No-op without a home. */
/** The board monitor's liveness subscription (ZT-I3), replaced on each bootstrap. */
let boardLivenessUnsub: (() => void) | null = null;
function bootstrapHiveServices(): void {
  if (!hive.enabled()) return;
  hive.ensureHive();
  // Tell the hive what it is running inside, BEFORE anything spawns: the prompt
  // builder reads this, so an agent spawned earlier would never learn it.
  hive.setRuntimeInfo({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() });
  hive.setOrchestratorMaySpawn(readConfig().orchestratorMaySpawn === true);
  // An app-start marker in the event log. log.jsonl had twelve event kinds and
  // none of them meant "the app restarted", so a relaunch, and more importantly a
  // switch between a packaged build and a local one, was invisible to every agent
  // reading the feed. That gap cost a multi-hour investigation whose answer was
  // exactly this: a local build inherits the launching shell's umask, a
  // Finder-launched app does not.
  hive.appendLog({
    kind: 'app-start',
    version: app.getVersion(),
    packaged: app.isPackaged,
    // WHICH bundle, not just which version. Version plus packaged is not enough
    // to tell two builds apart: a stale copy in /Applications and a fresh one in
    // dist/ can report the same version and both be packaged, and picking the
    // wrong one by habit looks exactly like the new build being broken. Cost us
    // twice before this line existed.
    appPath: app.getAppPath(),
    exePath: process.execPath,
    electron: process.versions.electron,
    platform: process.platform
  });
  // MODEL-DEFAULT-CLI: config load cleared a saved defaultModel once (config.ts,
  // migrateDefaultModelCliV1) before the hive existed; record what it was, once.
  const clearedDefaultModel = takeClearedDefaultModel();
  if (clearedDefaultModel) {
    try { hive.appendLog({ kind: 'model-default-cleared', previous: clearedDefaultModel }); } catch { /* best-effort */ }
  }
  control.replaceAutoDeliveryPauses(readConfig().autoDeliveryPausedAgents ?? []);
  // ZT-I1-MAIL §7.1 (one-shot, idempotent): every agent's ledger imported, archived agents' unread
  // mail moved to inbox/.undelivered (listed once for the Human, never woken), the §11.12(c) lesson
  // scan. BEFORE archiveOrphanedAgents: after it, every agent without a live PTY reads as archived.
  try { hive.migrateMail(); } catch (e) { try { hive.appendLog({ kind: 'mail-migration-error', error: String(e).slice(0, 300) }); } catch { /* best-effort */ } }
  archiveOrphanedAgents(); // #57/#58: archive stale archived:false entries with no live PTY
  hive.startRouter();
  // ZT-I3: the task-ledger guard (watch only; it never writes tasks.json).
  try { hive.startLedgerGuard(); } catch (e) { console.error('[hive] startLedgerGuard:', e); }
  try { boardMonitor.start(); } catch (e) { console.error('[hive] boardMonitor.start:', e); }
  // ZT-I3 §3.2: the board monitor (the CONSUMER) re-runs on every liveness edge. Wired here, with
  // the consumer, so the liveness producer's own code never touches the board (Dwight's M15 pin).
  // bootstrapHiveServices can run again (onboarding, home change): replace, never stack.
  boardLivenessUnsub?.();
  boardLivenessUnsub = agentLiveness.onLivenessChange(() => { try { boardMonitor.tick(); } catch (e) { console.error('[board-monitor]', e); } });
  try { floorDigest.start(); boardStatus.request(); } catch (e) { console.error('[hive] floorDigest.start:', e); }
  startEphemeralWorkerWatcher(); // poll HIVE_ROOT/spawn-requests → ephemeral workers
  // Phase 2: the loopback secret broker. Bind it BEFORE workers spawn so each spawn can
  // be granted a capability token + the broker URL in its env. Loopback-only, idempotent.
  void integrationBroker.start().then((r) => {
    if (r.ok) console.log('[broker] integration broker listening on', integrationBroker.url());
    else console.error('[broker] failed to start:', r.error);
  });
  ensureDefaultMissions(); // one-time: seed the built-in hourly ops standup
  syncMissions(); // arm recurring auto-dispatch missions now the router is live
  syncContextTriggers(); // …and the context trigger's own compact/clear cadences
  // Pair replies to inbound webhook messages in the ledger. Tied to the FEATURE
  // (any endpoint configured), not to the server: an approved message's card can
  // finish long after the operator switched the public surface back off, and its
  // reply still belongs in the history.
  if ((readConfig().webhookTriggers ?? []).length > 0) startWebhookDoneObserver();
  hookServer.start();
  // AGY 1.1.48 - prepare Antigravity statusline capture. This TAKES nothing: the lease
  // on the user's global statusline is taken on the first AGY spawn and released when
  // the last AGY agent leaves. Startup only gives back a lease a dead run left behind.
  // After hookServer.start(), so a locator always names a listening pipe. Stable only.
  hive.startAgyStatusline();
  // AGY-STARTUP-TURN N5: remove our agy custom agents a crashed run left behind (agents no longer
  // on the floor). Before any spawn; gated like every global write; only our marked files.
  try { hive.sweepAgyAgents(); } catch (e) { console.error('[hive] sweepAgyAgents failed:', e); }
  // Bind the telemetry collector BEFORE the renderer spawns any agent, then point
  // the hive at it so every subsequent spawn is instrumented. Best-effort — a bind
  // failure just leaves telemetry off (transcript reconciler stays). No breaker.start():
  // the breaker is POLICY-only, ticked by the heartbeat beat (#1, ships disabled).
  void telemetry.start().then((r) => {
    if (r.ok && r.endpoint) { hive.setOtelEndpoint(r.endpoint); console.log('[telemetry] collector listening', r.endpoint); }
    else console.error('[telemetry] collector failed to start:', r.error);
  });
  // Nothing to start for memory: the engine forks lazily / at prewarm.
  const retiredKeys = pruneRetiredConfigKeys();
  if (retiredKeys.length) { try { hive.appendLog({ kind: 'config-retired-keys-removed', keys: retiredKeys }); } catch { /* best-effort */ } }
  reflector.start(); // bound oversized memory.md files on a timer (no-op until threshold)

  armAlwaysOnBeats();
}

/** Cadence of the inbox-wake RECONCILIATION beat. Events wake agents; this finds what a
 *  lost callback or a restart missed. Unchanged in the pre-M1 bridge. */
const WORKER_WAKE_POLL_MS = 15_000;
let workerWakeTimer: ReturnType<typeof setInterval> | null = null;
let heldInterferenceTimer: ReturnType<typeof setInterval> | null = null;

/** Inbox-wake RECONCILIATION (pre-M1 bridge). Every live, non-archived agent - god
 *  included, with no exclusion - goes through the SAME `requestInboxWake` the events use,
 *  in reconcile mode (PTY quiescence may stand in for a missed Stop, rate-limited per
 *  agent). There is no second submit implementation here. */
function runWorkerWakeBeat(): void {
  if (!hive.enabled() || !inboxWake) return;
  const reg = hive.registry();
  if (!reg?.agents) return;
  const live = Object.entries(reg.agents)
    .filter(([agentId, a]) => !a?.archived && ptyForAgent(agentId))
    .map(([agentId]) => agentId);
  // Proves the 15s beat is ARMED and running at all, and over how many agents. This alone
  // separates "armAlwaysOnBeats never ran" from "it ran and every claim was refused".
  wakeDiag('beat', { live: live.length, agents: live.join(',') });
  // ZT-I1-MAIL (Jim audit #4): mail that reached inbox/ outside deliver() (a ledger error, another
  // writer) is recorded delivered here, one readdir per agent. §11.7: for an agent with no Stop
  // signal (cursor; an agent degraded because its hooks went silent) the agent's own move to
  // .done means handled, 1.1.74 semantics. Work-order agents get their leftover files as handoffs.
  for (const agentId of live) {
    try {
      const mode = hookServer.mailChannel(agentId).mode;
      const noStop = mode === 'legacy-move' || (mode === 'legacy-read' && hive.mail.channelOverride(agentId)?.reason === 'zero-hook-traffic');
      if (mode !== 'work-order') hive.mail.reconcileInbox(agentId, { moveIsHandled: noStop });
      // god 1c7544 + Q34: a work-order agent's leftover inbox files go out as normal terminal work
      // orders (acted + archived on the COMMITTED write), re-announced at most 3 times.
      else hive.handOffWorkOrderLeftovers(agentId);
    } catch { /* best effort: the next beat retries */ }
  }
  inboxWake.reconcileAll(live);
  // ZERO-TOKEN-LIVENESS: after the WWR ran (it records its own STUCK edges first), every agent.
  sampleLivenessAll();
}

/** (Re)arm the always-on beats (decoupled from the optional heartbeat): the live
 *  fleet snapshot Michael reads (~8s) + the breaker/cost-ledger beat (~30s).
 *  Guarded (clear-then-set) so a re-bootstrap (changeHome recovery) OR a
 *  powerMonitor resume can't stack duplicate timers — these are setInterval
 *  handles that freeze during true system sleep and must be re-armed on wake. */
function armAlwaysOnBeats(): void {
  if (fleetTimer) clearInterval(fleetTimer);
  writeFleetSnapshot();
  fleetTimer = setInterval(writeFleetSnapshot, 8_000);
  if (breakerBeatTimer) clearInterval(breakerBeatTimer);
  breakerBeatTimer = setInterval(() => { try { runBreakerBeat(300_000); } catch (e) { console.error('[breaker beat]', e); } }, 30_000);
  if (workerWakeTimer) clearInterval(workerWakeTimer);
  workerWakeTimer = setInterval(() => { try { runWorkerWakeBeat(); } catch (e) { console.error('[worker-wake beat]', e); } }, WORKER_WAKE_POLL_MS);
  if (heldInterferenceTimer) clearInterval(heldInterferenceTimer);
  heldInterferenceTimer = setInterval(() => { try { heldInterference?.tick(Date.now()); } catch (e) { console.error('[held-interference]', e); } }, HELD_TICK_MS);
  wakeDiag('beats-armed', { cadenceMs: WORKER_WAKE_POLL_MS });
  runWorkerWakeBeat(); // catch-up on arm — power-resume re-arms and drains the backlog
}

/** Wall-clock instant we last observed the machine suspend or lock, so a resume
 *  can report how long we were out. Best-effort context for the renderer follow-on
 *  (auto-revive); null until the first suspend/lock of the session. */
let lastSuspendAt: number | null = null;
/** Single pending post-resume PTY health check, so overlapping resume+unlock
 *  events collapse to ONE check (the latest) instead of stacking. */
let resumeHealthTimer: NodeJS.Timeout | null = null;

/** After the machine wakes, probe each live PTY for liveness and surface any that
 *  didn't survive. macOS can wedge a child `claude` process/socket across a long
 *  sleep while node-pty still holds the fd (its exit event never fired) — so a
 *  dead PTY can linger in our list. `process.kill(pid, 0)` is a pure existence
 *  probe (signal 0 never touches the process); ESRCH means the process is gone.
 *  We only LOG + NOTIFY here (no auto-kill/respawn — true revive is renderer-owned
 *  via pty:spawn) and emit `power:resume` as the integration point for the
 *  follow-on renderer auto-revive card. */
function healthCheckPtys(reason: string, awayMs: number | null): void {
  const ptys = ptyManager.list();
  const dead: string[] = [];
  for (const p of ptys) {
    if (typeof p.pid === 'number' && p.pid > 0) {
      try { process.kill(p.pid, 0); }   // liveness probe only — never kills
      catch { dead.push(p.id); }        // ESRCH: process gone but PTY still registered
    }
  }
  const away = awayMs != null ? ` (away ~${Math.round(awayMs / 1000)}s)` : '';
  if (dead.length) {
    console.warn(`[power] ${reason}${away}: ${dead.length}/${ptys.length} PTY(s) look wedged (process gone):`, dead.join(', '));
    breakerToast('Agents need a restart', `${dead.length} agent terminal(s) didn't survive sleep — re-open them to resume.`);
  } else {
    console.log(`[power] ${reason}${away}: ${ptys.length} PTY(s) healthy`);
  }
  // Single integration point for the (separate) renderer auto-revive card: it can
  // listen for 'power:resume' and respawn the `dead` PTYs with --resume.
  try { liveWebContents()?.send('power:resume', { reason, awayMs, dead, total: ptys.length }); } catch { /* window gone */ }
}

/** Re-arm everything that runs on a frozen libuv timer after the machine slept,
 *  and surface any PTY that didn't survive. macOS pauses setTimeout/setInterval
 *  during true system sleep (the monotonic clock halts) — on wake they resume
 *  where they paused, shifted by the whole sleep, so missions due during sleep
 *  never fired and never replay. We rebuild the scheduler (syncMissions reuses its
 *  remaining=max(0,…) semantics → each overdue mission fires exactly ONCE then
 *  re-settles, never N replays), re-arm the always-on beats, re-evaluate the
 *  power blocker, then — after a short grace for PTYs to wake their pipes —
 *  health-check the terminals. Idempotent: overlapping resume+unlock events
 *  collapse safely (clear-then-arm everywhere; at most one catch-up fire). */
function onSystemResume(reason: string): void {
  console.log(`[power] ${reason} — re-arming scheduler, beats, router, keep-awake`);
  try { syncMissions(); } catch (e) { console.error('[power] syncMissions on resume', e); }
  // Same freeze, same catch-up: the context timers honour elapsed-time-since-last-
  // run, so a compact/clear that came due while the machine slept fires ONCE here
  // rather than being lost or replayed N times.
  try { syncContextTriggers(); } catch (e) { console.error('[power] syncContextTriggers on resume', e); }
  try { armAlwaysOnBeats(); } catch (e) { console.error('[power] armAlwaysOnBeats on resume', e); }
  // The hive message router (outbox→inbox drain) is a setInterval that freezes
  // during true system sleep exactly like the beats above — but it was the one
  // always-on timer never re-armed on wake. Symptom: after a long sleep the
  // scheduler→god path recovered (it injects straight into god's inbox), while
  // every agent's outbox silently stopped draining, so god→worker and
  // worker↔worker mail piled up undelivered. Re-arm the poll loop (clear-then-set,
  // idempotent) and immediately drain the backlog that accrued while we were out
  // instead of waiting for the first post-wake tick. The renderer's idle inbox-wake
  // nudge (useHive.ts) then wakes each parked recipient once its mail lands.
  try {
    hive.stopRouter();
    hive.startRouter();
    const drained = hive.routeOnce();
    if (drained > 0) console.log(`[power] ${reason} — flushed ${drained} queued hive message(s)`);
  } catch (e) { console.error('[power] router re-arm on resume', e); }
  try { syncKeepAwake(); } catch (e) { console.error('[power] syncKeepAwake on resume', e); }
  const awayMs = lastSuspendAt != null ? Date.now() - lastSuspendAt : null;
  // Give PTYs a beat to resume their pipes before judging them wedged; reset any
  // pending check so a resume quickly followed by unlock runs the probe just once.
  if (resumeHealthTimer) clearTimeout(resumeHealthTimer);
  resumeHealthTimer = setTimeout(() => {
    resumeHealthTimer = null;
    healthCheckPtys(reason, awayMs);
  }, 15_000);
}

app.whenReady().then(() => {
  if (memoryBenchDir) {
    void runMemoryBenchHost(memoryBenchDir, (hiveRoot, baseUrl, idleUnloadMs, dbFile) => {
      const w = new NativeMemoryWiring({
        hiveRoot: () => hiveRoot,
        enabled: () => true,
        userData: app.getPath('userData'),
        resourcesDir: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources'),
        workerEntry: join(__dirname, 'memoryWorker.js'),
        fork: (entry) => utilityProcess.fork(entry, [], { serviceName: 'munder-memory-bench', stdio: 'ignore' }) as unknown as WorkerHandle,
        memoryBaseUrl: baseUrl,
        writeCommand: () => null,
        log: () => undefined,
        vecLoadablePath: () => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          try { return toUnpacked((require('sqlite-vec') as { getLoadablePath(): string }).getLoadablePath()); } catch { return null; }
        }
      });
      if (idleUnloadMs || dbFile) {
        const orig = w.workerConfig.bind(w);
        w.workerConfig = () => {
          const c = dbFile ? w.workerConfigFor(hiveRoot, dbFile) : orig();
          return c ? { ...c, ...(idleUnloadMs ? { idleUnloadMs } : {}) } : c;
        };
      }
      return w;
    }).then(() => app.exit(0), () => app.exit(1));
    return;
  }
  if (memorySmokeOut) {
    void runMemorySmoke(memorySmokeOut, {
      fork: () => utilityProcess.fork(join(__dirname, 'memoryWorker.js'), [], { serviceName: 'munder-memory-smoke', stdio: 'ignore' }) as unknown as WorkerHandle,
      configFor: (hiveRoot, dbFile) => nativeMemory.workerConfigFor(hiveRoot, dbFile),
      appVersion: app.getVersion(),
      packaged: app.isPackaged
    }).then((ok) => app.exit(ok ? 0 : 1), () => app.exit(1));
    return;
  }
  // MUNDER_DEV=1 — second, LIVE isolation check. The bootstrap above checked the
  // paths we intended to use; this checks the paths the app actually resolved
  // (config clamp, hive root, palace, pipe) now that config/hive are wired. A
  // violation here is a bug in the clamp — refuse loudly rather than run beside
  // Stable on shared data.
  if (DEV_ISOLATION) {
    const cfgHome = readConfig().harnessHome ?? '';
    const live = {
      userData: app.getPath('userData'),
      harnessHome: cfgHome,
      hiveRoot: hive.root() ?? '',
      palace: cfgHome ? join(cfgHome, 'palace') : '',
      worktrees: cfgHome ? join(cfgHome, 'worktrees') : '',
      pipeName: hive.sockPath() ?? ''
    };
    const violations = checkIsolation(live, devStableForbidden);
    if (violations.length) {
      const msg = 'Refusing to start: resolved DEV paths overlap the Stable installation.\n\n' + violations.join('\n');
      console.error('[dev-isolation] ' + msg);
      if (!DEV_HIDDEN) { try { dialog.showErrorBox('Munder Difflin DEV — isolation guard', msg); } catch { /* headless */ } }
      allowQuit = true;
      app.exit(97);
      return;
    }
    console.warn(`[dev-isolation] live check OK — hive=${live.hiveRoot} palace=${live.palace} pipe=${live.pipeName}`);
  }

  // Realtime Michael mic-gate hygiene (rt-8 / Pam rt-10 nit): the voice session
  // opens the mic permission gate by persisting realtimeVoiceEnabled=true and
  // closes it on disconnect — but a hard crash/reload mid-session skips that
  // teardown, leaving the flag stuck true so the gate would boot PRE-OPEN with no
  // live session. Force it closed at startup (a real session re-opens it via
  // setMicGate(true)); macOS TCC stays a second gate regardless.
  if (readConfig().realtimeVoiceEnabled) writeConfig({ realtimeVoiceEnabled: false });

  // STARTUP-TIMING-162: arm the first-60-s recorder (it stops by itself) and its PTY markers.
  startupTiming.start();
  // RENDERER-RECOVERY-164: what starting the local crash reporter cost, on the same clock.
  startupTiming.mark('crash-reporter-start', undefined, crashReporterStart.startedAt);
  startupTiming.mark('crash-reporter-ready', undefined, crashReporterStart.readyAt);
  if (!crashReporterStart.ok) { try { hive.appendLog({ kind: 'crash-reporter-failed', error: crashReporterStart.error ?? null }); } catch { /* best-effort */ } }
  ptyManager.setStartupHooks({
    spawned: (id) => startupTiming.mark('agent-spawn', id),
    firstOutput: (id) => startupTiming.mark('agent-first-output', id),
    output: (id, chars) => startupTiming.ptyOutput(id, chars),
    recording: () => startupTiming.recording
  });

  // Anonymous product analytics (PostHog) — the full contract lives in
  // TELEMETRY.md. No-op unless a build-time key was injected (official releases
  // only), and gated on DO_NOT_TRACK + the telemetryEnabled config (opt-out).
  analytics.init({
    stateDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    // MUNDER_DEV=1: never emit product analytics from a dev build (a dev run
    // must not register as a distinct install or masquerade as Stable).
    enabled: readConfig().telemetryEnabled !== false && !DEV_ISOLATION
  });

  // A cold-start deep link (Windows/Linux) rides in on OUR argv.
  const startupHireLink = process.argv.find((a) => a.startsWith('munderdifflin://'));
  if (startupHireLink) void handleHireLink(startupHireLink);

  // Hand every spawned agent the path to the Slack reply discovery file via the
  // inherited env (pty merges process.env). The path is stable whether or not the
  // server is running; the FILE only exists while it is, so the helper degrades
  // to "endpoint not running" cleanly. NO secret is in the env — only the path.
  process.env.MD_SLACK_REPLY_CONFIG = slackReplyConfigPath();
  // Open the durable store first — createWindow() reads the saved window bounds.
  // Guarded: a DB failure (e.g. a bad native build) must degrade to defaults,
  // never block app startup.
  try { persist.open(); } catch (e) { console.error('[db] open failed:', e); }
  // Auto-update from GitHub releases (packaged builds only; gated on the
  // `autoUpdate` config flag). Download-in-background + restart-to-apply toast;
  // never restarts on its own. Falls back to a notify-only releases/latest
  // check where native updating isn't possible (win-portable, dev-ish builds).
  initAutoUpdater(() => liveWebContents());
  // Bootstrap the hive (if harnessHome is configured) and start the message router.
  bootstrapHiveServices();
  // Survive sleep/lock. macOS freezes libuv timers during true system sleep, so a
  // locked/idle/slept Mac stops firing schedules and can wedge PTYs. On wake we
  // re-arm the scheduler (catching up missed missions ONCE) + beats + keep-awake,
  // then health-check terminals. App-lifetime listeners — powerMonitor outlives
  // every window, so there is nothing to tear down on quit.
  powerMonitor.on('resume', () => onSystemResume('resume'));
  powerMonitor.on('unlock-screen', () => onSystemResume('unlock-screen'));
  powerMonitor.on('suspend', () => { lastSuspendAt = Date.now(); console.log('[power] suspend — system sleeping'); });
  powerMonitor.on('lock-screen', () => { lastSuspendAt = Date.now(); console.log('[power] lock-screen'); });
  // Multi-window floors (opt-in): install the menu carrying "New Floor". When
  // off, the app keeps Electron's default menu — zero behavior change.
  if (readConfig().multiWindow) installAppMenu();
  // RENDERER-RECOVERY-164: the in-memory renderer ring (first sample in SAMPLE_MS; no disk writes
  // unless a threshold is crossed), and local crash dumps pruned to the newest KEEP_DUMPS, async.
  startRendererMemorySampler();
  void pruneDumps(app.getPath('crashDumps'), KEEP_DUMPS).then((gone) => {
    if (gone.length) { try { hive.appendLog({ kind: 'crash-dumps-pruned', count: gone.length, kept: KEEP_DUMPS }); } catch { /* best-effort */ } }
  }).catch(() => { /* best-effort */ });
  createWindow();
  // NATIVE-WAKEUP-EMPTY-INDEX (a): in NATIVE mode, fork the memory worker (its below-normal
  // startup backfill fills the index) 30 s after the first window finished loading, the spec's
  // lazy rule ("no earlier than 30 seconds after the first window becomes idle"), so an agent's
  // first task-start wake-up does not meet an empty index. The mode is read at fire time; any
  // other mode does nothing. A first memory request before then forks it as always.
  mainWindow?.webContents.once('did-finish-load', () => {
    startupTiming.mark('window-ready');
    const t = setTimeout(() => { try { nativeMemory.prewarm(); } catch (e) { console.error('[native-memory] prewarm failed:', e); } }, NATIVE_MEMORY_PREWARM_DELAY_MS);
    t.unref?.();
    // CODEX-WAKE-161 (b): the app-start row, off the start-up path (resolving a command can
    // start a login shell on macOS). Only when Codex is installed at all.
    const c = setTimeout(() => {
      void codexCliNow().then((cli) => { if (cli.path) codexVersionLog.note(cli.version, cli.path, 'app-start'); }).catch(() => { /* best-effort */ });
    }, NATIVE_MEMORY_PREWARM_DELAY_MS);
    c.unref?.();
  });
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  // Auto-start the generic webhook only for endpoints the user has explicitly
  // enabled (each with its own secret) — never a default-on public surface.
  // Opt-in, like Slack; an install with no enabled endpoint opens no tunnel.
  if (enabledWebhookEndpoints().length > 0) {
    void startWebhookServer().then((r) => {
      if (!r.ok) console.error('[webhook] auto-start failed:', r.error);
      else console.log('[webhook] listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** QUIT-HANG F3: the rows that make a slow start or a freeze measurable instead of
 *  inferred (Jim's SLOW-START-FLOOR-CRASH had to reconstruct both from WER and gaps
 *  in log.jsonl). F2: a Windows logoff/shutdown (`session-end`) skips the
 *  running-terminals confirm, which would otherwise hold the shutdown on our modal
 *  or leave every agent tree orphaned, and runs the ordinary teardown. */
function watchWindowHealth(win: BrowserWindow, isFloor: boolean, recovery: { partition?: string; policy: RecoveryPolicy }): void {
  const created = Date.now();
  const wc = win.webContents;
  const wcId = wc.id; // read now: a destroyed webContents throws on .id
  recoveryPolicies.set(wcId, recovery.policy);
  win.once('closed', () => { recoveryPolicies.delete(wcId); });
  // RENDERER-PROFILE: arm the probe while the page is healthy (every load, incl. a recovery
  // reload); a busy renderer can only be looked into through a session armed before it got stuck.
  const probe = new RendererProbe(wc.debugger, { devToolsOpen: () => { try { return wc.isDevToolsOpened(); } catch { return false; } } });
  rendererProbes.set(wcId, probe);
  win.once('closed', () => { rendererProbes.delete(wcId); });
  wc.on('did-finish-load', () => { void probe.arm(); });
  const row = (kind: string, extra: Record<string, unknown> = {}): void => {
    try { hive.appendLog({ kind, floor: isFloor, ...extra }); } catch { /* best-effort */ }
  };
  wc.once('did-finish-load', () => row('window-ready', { ms: Date.now() - created, sinceProcessStartMs: Math.round(process.uptime() * 1000) }));
  let hungAt = 0;
  win.on('unresponsive', () => { hungAt = Date.now(); row('window-unresponsive'); });
  win.on('responsive', () => { row('window-responsive', hungAt ? { hungMs: Date.now() - hungAt } : {}); hungAt = 0; });
  // RENDERER-RECOVERY-164 (WHITE-SCREEN-162): the row now carries pid/uptime and the
  // recovery taken; 1.1.62 only logged it and left the window white.
  installRendererRecovery(win, {
    policy: recovery.policy,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    // The only row the recovery writes is this window's render-process-gone (with pid/uptime/recovery).
    log: (r) => { const { kind: _kind, ...rest } = r; row('render-process-gone', { ...rest, ...(memoryCaused() ? { cause: 'memory' } : {}), processUptimeMs: Math.round(process.uptime() * 1000) }); },
    quitting: () => allowQuit,
    recentMemory: () => rendererMemory.recent(),
    findDump: async (since) => {
      const dump = await waitForDump(app.getPath('crashDumps'), since, { exclude: attributedDumps });
      if (dump) attributedDumps.add(dump.path);
      return dump;
    },
    install: () => { /* createWindow already wires the replacement via watchWindowHealth */ },
    setNotice: (w, notice) => {
      if (w.webContents.isDestroyed()) return;
      recoveryPolicies.set(w.webContents.id, recovery.policy);
      recoveryNotices.set(w.webContents.id, memoryCaused() ? { ...notice, reason: 'memory: the view used over 1.5 GB' } : notice);
    },
    recreate: (old) => recreateWindowAfterCrash(old, isFloor, recovery),
    giveUp: (w, decision) => {
      row('render-recovery-stopped', { streak: decision.streak });
      // Jim RR-164 (2): the dialog can actually quit. The window's own quit warning lives in its
      // (dead) renderer, so X / Ctrl+Q would wait on nothing; "Quit now" runs the teardown here.
      // MUNDER_HIDDEN: no dialog; the row above is the record, and the agents keep running.
      if (!DEV_HIDDEN) void dialog.showMessageBox({
        type: 'error',
        title: 'Munder Difflin',
        message: 'The app window keeps crashing, so it will not be restored again.',
        detail: `Its view crashed ${decision.streak} times within a few minutes. Your agents are still running in the background. Quit now and reopen Munder Difflin to get the window back.`,
        buttons: ['Quit now', 'Keep agents running'],
        defaultId: 0,
        cancelId: 1
      }).then((r) => { if (r.response === 0) teardownAndQuit(); }).catch(() => { /* no display */ });
      void w;
    }
  });
  win.on('session-end', () => {
    row('session-end');
    try { closingTime.cancel(); } catch { /* not started */ }
    teardownAndQuit();
  });
}

/** RENDERER-RECOVERY-164 (the Human's final scope): renderer + GPU memory sampled every SAMPLE_MS
 *  from main's own process metrics (no renderer ping, no IPC) into an IN-MEMORY ring of the last
 *  10. Normally NOTHING is written: the ring is flushed into the next render-process-gone row.
 *  The only row is one renderer-memory-alert per renderer when it passes 1.5 GB or doubles from
 *  its first sample, and it goes through hive.appendLog (the kept-open fast appender). */
const rendererMemory = new RendererMemorySampler({
  metrics: () => app.getAppMetrics(),
  now: () => Date.now(),
  alert: (row) => { try { hive.appendLog(row); } catch { /* best-effort */ } },
  // MEMSPIKE-167: over 1.5 GB on two consecutive samples -> main kills the renderer and the
  // ordinary recovery brings the view back (a frozen renderer cannot be asked to reload).
  onOverLimit: (pid, mbNow) => {
    const outcome = recoverRendererForMemory(pid, {
      windows: () => BrowserWindow.getAllWindows(),
      givenUp: (w) => recoveryPolicies.get(w.webContents.id)?.givenUp ?? false,
      beforeKill: () => { memoryRecoveryAt = Date.now(); }
    });
    try {
      hive.appendLog({ kind: 'render-recovery-memory', pid, mb: mbNow, limitMb: ALERT_MB, outcome,
        mainRssMb: Math.round(process.memoryUsage().rss / 104857.6) / 10, recent: rendererMemory.recent() });
    } catch { /* best-effort */ }
  },
  // MEMSPIKE-167: a time-boxed look inside a renderer that just doubled; never on one already
  // over the limit (it is about to be recovered), never awaited by anything.
  onDoubled: (pid, mbNow) => {
    if (mbNow >= ALERT_MB) { try { hive.appendLog({ kind: 'renderer-memory-profile', pid, mb: mbNow, profile: 'skipped-over-limit' }); } catch { /* best-effort */ } return; }
    const w = BrowserWindow.getAllWindows().find((x) => { try { return !x.isDestroyed() && x.webContents.getOSProcessId() === pid; } catch { return false; } });
    if (!w) return;
    // RENDERER-PROFILE (option A): the window's probe session was armed (Debugger + Performance
    // enabled) while its page was healthy, because a renderer busy in JS answers nothing on a
    // session attached now; that is why the 1.1.67 heap probe timed out on all 3 overnight
    // spikes. One row: Performance.getMetrics, the paused JS stack, heap and DOM counters, and a
    // ~3 s CPU profile (userData/renderer-profiles, newest 10). Time-boxed, never awaited, one
    // look at a time.
    const probe = rendererProbes.get(w.webContents.id);
    if (!probe) return;
    if (rendererLookBusy) { try { hive.appendLog({ kind: 'renderer-memory-profile', pid, mb: mbNow, profile: 'skipped-busy' }); } catch { /* best-effort */ } return; }
    rendererLookBusy = true;
    void probe.capture({ write: (json) => saveRendererProfile(join(app.getPath('userData'), 'renderer-profiles'), pid, json) })
      .then((r) => { try { hive.appendLog({ kind: 'renderer-memory-profile', pid, mb: mbNow, foreignResumes: probe.foreignResumes, ...r }); } catch { /* best-effort */ } })
      .catch(() => { /* capture never throws */ })
      .finally(() => { rendererLookBusy = false; });
  }
});
/** MEMSPIKE-167: each window's recovery policy (so a memory recovery never kills a renderer whose
 *  window already gave up), and when the last memory recovery started (the notice says why). */
const recoveryPolicies = new Map<number, RecoveryPolicy>();
/** RENDERER-PROFILE: a spike look is in progress; a second doubled renderer is skipped. */
let rendererLookBusy = false;
/** RENDERER-PROFILE: each window's long-lived probe session (armed on every page load). */
const rendererProbes = new Map<number, RendererProbe>();
let memoryRecoveryAt = 0;
const memoryCaused = (): boolean => Date.now() - memoryRecoveryAt <= MEMORY_CAUSE_MS;
let rendererMemoryTimer: ReturnType<typeof setInterval> | null = null;
let ptyTrafficTimer: ReturnType<typeof setInterval> | null = null;
function startRendererMemorySampler(): void {
  if (rendererMemoryTimer) return;
  rendererMemoryTimer = setInterval(() => { rendererMemory.sample(); }, SAMPLE_MS);
  rendererMemoryTimer.unref?.();
  // MEMSPIKE-167: one folded row a minute with each PTY's output and resizes, and main's own
  // memory, so a flooded terminal, a resize loop or a backlog held in main shows at once.
  ptyTrafficTimer = setInterval(() => {
    const counts = ptyManager.takeTraffic();
    if (!Object.keys(counts).length) return;
    try { hive.appendLog({ kind: 'pty-traffic', counts, mainRssMb: Math.round(process.memoryUsage().rss / 104857.6) / 10 }); } catch { /* best-effort */ }
  }, 60_000);
  ptyTrafficTimer.unref?.();
}

/** RENDERER-RECOVERY-164: one-shot "the view crashed and was restored" notices, keyed by the
 *  webContents that should show it; the renderer takes its own on mount. */
const recoveryNotices = new Map<number, RecoveryNotice>();
/** Dumps already attributed to a crash row, so a fast crash loop never reuses one. */
const attributedDumps = new Set<string>();
/** Jim RR-164 (1): the recovered page's preload asks this once, synchronously, so the renderer
 *  starts on the terminals (not the launch-time HivePicker, whose switch path would tear down
 *  the live agents). True while a recovery notice is pending for this window. */
ipcMain.on('window:recoveringSync', (evt) => { evt.returnValue = recoveryNotices.has(evt.sender.id); });

/** The renderer of this window is gone (crashed, or the window is being torn down). */
function rendererGone(wc: Electron.WebContents): boolean {
  try { return wc.isDestroyed() || wc.isCrashed(); } catch { return true; }
}

/** Jim RR-164 (LOW): the native confirm does exactly what the renderer's modal does:
 *  Quit = app:confirmClose (a hard quit cancels a closing time in progress, then tears
 *  down); Cancel = app:cancelClose (a restart-to-install that was waiting is called off). */
function quitOrCancelNatively(ptyCount: number, parent: BrowserWindow | null): void {
  if (confirmQuitNatively(ptyCount, parent)) {
    try { closingTime.cancel(); } catch { /* not started */ }
    teardownAndQuit();
  } else {
    abortPendingRestart();
  }
}

/** Jim RR-164 (2): the native stand-in for the renderer's quit warning. True = quit. */
function confirmQuitNatively(ptyCount: number, parent: BrowserWindow | null): boolean {
  // MUNDER_HIDDEN (dev only): nobody can answer a dialog in a hidden run, and whoever asked
  // it to quit owns it, so the answer is quit (no dialog is shown).
  if (DEV_HIDDEN) return true;
  const opts: Electron.MessageBoxSyncOptions = {
    type: 'warning',
    buttons: ['Quit and stop agents', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Munder Difflin',
    message: `Quit Munder Difflin? ${ptyCount} running terminal${ptyCount === 1 ? '' : 's'} will be stopped.`,
    detail: 'The app window is not showing (its view crashed), so this is asked here instead.'
  };
  const choice = parent && !parent.isDestroyed() ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts);
  return choice === 0;
}
ipcMain.handle('window:takeRecoveryNotice', (evt) => {
  const n = recoveryNotices.get(evt.sender.id) ?? null;
  recoveryNotices.delete(evt.sender.id);
  return n;
});

/**
 * RENDERER-RECOVERY-164: replace a window whose renderer crashed twice in a row.
 *
 * Order matters. The replacement is created FIRST, then every PTY the old window owned is
 * handed to it (and the default sink with it), and only then is the old window DESTROYED:
 * destroy() skips 'close', so neither the primary's quit warning nor a floor's close
 * confirmation runs, and a floor's 'closed' handler (killByOwner) finds nothing left to kill.
 * The agents never notice.
 */
function recreateWindowAfterCrash(old: BrowserWindow, isFloor: boolean, recovery: { partition?: string; policy: RecoveryPolicy }): BrowserWindow | null {
  if (old.isDestroyed()) return null;
  const bounds = (() => { try { return old.getBounds(); } catch { return null; } })();
  return performRecreate<BrowserWindow>(old, {
    create: () => {
      const next = createWindow({ floor: isFloor, partition: recovery.partition, recovery: recovery.policy });
      if (bounds) { try { next.setBounds(bounds); } catch { /* best-effort */ } }
      return next;
    },
    reassign: (from, to) => ptyManager.reassignOwner(from.webContents, to.webContents),
    getMain: () => mainWindow,
    setMain: (w) => { mainWindow = w; },
    destroy: (w) => { try { w.destroy(); } catch { /* already gone */ } },
    log: (row) => { try { hive.appendLog({ ...row, floor: isFloor }); } catch { /* best-effort */ } }
  });
}

app.on('child-process-gone', (_e, d) => {
  if (d.reason === 'clean-exit') return;   // a utility worker finishing normally is not news
  try { hive.appendLog({ kind: 'child-process-gone', type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name ?? d.serviceName }); } catch { /* best-effort */ }
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    if (rendererGone(mainWindow.webContents)) { quitOrCancelNatively(count, mainWindow); return; }
    surfaceWindow(mainWindow, { focus: true });   // MUNDER_HIDDEN: never focus
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  } else quitOrCancelNatively(count, null);
});

// The last chance to flush a coalesced capacity write. `before-quit` can be
// preventDefault-ed by the running-terminals warning above, so the flush hangs off
// `will-quit`, which only fires once the quit is actually going ahead.
app.on('will-quit', () => {
  capacityStore.saveNow();
  capacityDetailTicker.stopAll();
  // AGY statusline lease. `before-quit` only routes through teardownAndQuit when
  // terminals are open, so an ordinary quit with none would otherwise leave the user's
  // statusline pointing at Munder while Munder is closed. Idempotent: a no-op when the
  // teardown path already released it.
  try { hive.stopAgyStatusline(); } catch (e) { console.error('[will-quit] stopAgyStatusline:', e); }
  // QUIT-HANG: every quit path starts the agent-tree sweep here (idempotent); async and
  // bounded; the flush handler below joins it.
  void beginQuitWork();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Full teardown, not a bare killAll: this path must also stop the proxy
    // sidecars and helper servers — on Windows a child is NOT killed when its
    // parent exits, so anything skipped here outlives the app.
    teardownAndQuit();
  }
});

// Final analytics flush (session_ended + drain the send queue), bounded so a
// hung network can never wedge quit: preventDefault ONCE, race the flush
// against a short timeout, then exit hard.
//
// finish MUST be app.exit(), not a re-entrant app.quit(): when the quit was
// initiated while a window was still open (the "kill all & quit" confirm path
// calls teardownAndQuit → app.quit() and the window closes DURING that quit),
// Electron is left with its internal is-quitting state set after this
// preventDefault, and the later app.quit() is silently a no-op — no before-quit,
// no will-quit, no quit; the main process idles forever with zero windows. On
// Windows that stranded the whole Electron process group (main + GPU + network
// service) after every agents-running quit. By this point teardown has already
// run and the flush has finished or timed out, so an unconditional exit is
// exactly what's left to do.
let analyticsFlushed = false;
app.on('will-quit', (e) => {
  if (analyticsFlushed) return;
  analyticsFlushed = true;
  e.preventDefault();
  const t0 = Date.now();
  let report: QuitReport | null = null;
  const finish = (): void => {
    try { hive.appendLog({ kind: 'quit-done', waitMs: Date.now() - t0, work: report }); } catch { /* best-effort */ }
    try { hive.dispose(); } catch { /* rows are on disk */ }
    app.exit(0);
  };
  Promise.all([
    // QUIT-HANG: the agent trees, already being swept async (bounded inside).
    beginQuitWork().then((r) => { report = r; }),
    Promise.race([
      analytics.endSession(),
      new Promise<void>((r) => setTimeout(r, 1200))
    ]),
    // NATIVE-MEMORY: drain in-flight memory requests, then stop the worker (bounded).
    nativeMemory.shutdown().catch(() => undefined)
  ]).then(finish, finish);
});
