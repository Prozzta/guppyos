/**
 * NATIVE-MEMORY: the Electron glue in main. Everything here is short and synchronous or a
 * message post; the engine itself is in the utility process (worker.ts).
 *
 * The memory engine is the ONLY memory. There is no mode file:
 * the one switch is Settings' semantic memory (config `semanticMemory`, default on).
 *
 *   spawnEnv(id)  what a spawning agent gets: MEMORY_TOKEN, the endpoint, the hive root, and the
 *                 `memory` command dir to put FIRST on PATH, or null when memory is off or unavailable (then
 *                 the prompt carries no memory line: fail closed, Jim M2)
 *   handle(...)   the HookServer `/memory/<token>` handler (agents)
 *   query(...)    the same ops for main-internal callers (the Memory panel, Command Center,
 *                 voice tools) as the caller wing `human`; never reachable over HTTP
 *   agentExited   revoke the agent's token
 *   shutdown()    drain and stop the worker (quit, reset, home change)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT, MemoryTokens, NativeMemoryClient, validateRequest, WAKE_UP_DEADLINE_MS, type Reply, type WorkerHandle } from './service';
import type { WorkerConfig } from './worker';
import { CLAIM_VERBS, handleClaimVerb, type ClaimsEndpointDeps } from '../claims/endpoint';

export interface RuntimeManifest {
  model: { dir: string; onnxSha256: string; tokenizerSha256: string };
  vec0: Record<string, { package: string; file: string; sha256: string }>;
}

export interface WiringDeps {
  hiveRoot: () => string | null;
  /** Settings' semantic memory (config `semanticMemory !== false`): the master switch. */
  enabled: () => boolean;
  userData: string;
  /** resources dir: packaged `process.resourcesPath`, dev the repo's `resources/`. */
  resourcesDir: string;
  /** The built worker entry (out/main/memoryWorker.js). */
  workerEntry: string;
  fork: (entry: string) => WorkerHandle;
  memoryBaseUrl: () => string | null;
  writeCommand: (script: string) => string | null;
  log: (row: Record<string, unknown>) => void;
  /** The sqlite-vec loadable library's path on the REAL filesystem (asar-unpacked), resolved by
   *  sqlite-vec's own `getLoadablePath()` - a path lookup only; main never loads it. The
   *  packager nests the platform package under sqlite-vec, so a top-level lookup would miss it. */
  vecLoadablePath: () => string | null;
  /** CLAIM-LEDGER W1: the claim verbs (note, retract, ...), or null when this build or hive has no
   *  ledger; then they answer "unsupported" as before. They do not need the index worker. */
  claims?: () => ClaimsEndpointDeps | null;
  /** CLAIM-LEDGER W3: the Settings level (config claimLedger), passed to the worker's discovery. */
  claimLedger?: () => unknown;
  /** CLAIMS-HEAD-ANCHOR (A-2): the agents anchored for this hive, sent with the level. */
  anchoredAgents?: () => string[];
  /** CLAIM-LEDGER W3: a (re)started worker is ready; main re-sends every flagged agent's claims (G3.3). */
  onWorkerReady?: () => void;
}

/** The DB is per hive root (Jim R7): two hives, or dev and stable, never share wings.
 *  CLAIM-LEDGER (F6, A4): `<key>-v2.sqlite`, SCHEMA_VERSION 2. Builds without the ledger open only
 *  `<key>.sqlite` and never this file; this build never opens theirs (G3.6). */
export function dbFileFor(userData: string, hiveRoot: string): string {
  const key = createHash('sha256').update(hiveRoot.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);
  return join(userData, 'memory', `${key}-v2.sqlite`);
}

/** Why memory is not available (one log row per reason per run, not one per spawn). */
export type MemoryUnavailable = 'disabled' | 'no-hive' | 'no-runtime' | 'command-failed';

export class NativeMemoryWiring {
  readonly tokens = new MemoryTokens();
  readonly client: NativeMemoryClient;
  private manifest: RuntimeManifest | null = null;
  private loggedUnavailable = new Set<MemoryUnavailable>();

  constructor(private readonly d: WiringDeps) {
    this.client = new NativeMemoryClient({
      fork: () => d.fork(d.workerEntry),
      // The config is read at fork only: the level it carries is what a new worker knows (W3-1).
      config: () => { const c = this.workerConfig(); if (c) this.sentLedger = { v: c.claimLedger, anchored: (c.anchored ?? []).join(',') }; return c; },
      log: d.log, onReady: () => d.onWorkerReady?.()
    });
  }

  private runtimeManifest(): RuntimeManifest | null {
    if (this.manifest) return this.manifest;
    try {
      this.manifest = JSON.parse(readFileSync(join(this.d.resourcesDir, 'models', 'native-memory-manifest.json'), 'utf8')) as RuntimeManifest;
    } catch {
      this.manifest = null;
    }
    return this.manifest;
  }

  /** The worker's config, or null when the runtime pieces are missing (then requests answer
   *  exit 3 and nothing is forked). Path computation only: nothing is loaded here. */
  workerConfig(): WorkerConfig | null {
    const root = this.d.hiveRoot();
    return root ? this.workerConfigFor(root, dbFileFor(this.d.userData, root)) : null;
  }

  /** The same, for an explicit hive root and index file (the gate-2 smoke's scratch hive). */
  workerConfigFor(root: string, dbFile: string): WorkerConfig | null {
    const m = this.runtimeManifest();
    if (!m) return null;
    const plat = `${process.platform}-${process.arch}`;
    const v = m.vec0[plat];
    if (!v) return null;
    const vecPath = this.d.vecLoadablePath();
    if (!vecPath) return null;
    const modelDir = join(this.d.resourcesDir, 'models', m.model.dir);
    if (!existsSync(vecPath) || !existsSync(join(modelDir, 'onnx', 'model.onnx'))) return null;
    return { hiveRoot: root, dbFile, modelDir, modelSha256: m.model.onnxSha256, vecPath, vecSha256: v.sha256, claimLedger: this.d.claimLedger?.(), anchored: this.anchored() };
  }

  /** The current hive's index file (reset / home change delete it, after shutdown()). */
  dbFile(): string | null {
    const root = this.d.hiveRoot();
    return root ? dbFileFor(this.d.userData, root) : null;
  }

  /** Why memory is unusable right now, or null when it is usable (switch on, hive, runtime). */
  unavailable(): MemoryUnavailable | null {
    if (!this.d.enabled()) return 'disabled';
    if (!this.d.hiveRoot()) return 'no-hive';
    if (!this.workerConfig()) return 'no-runtime';
    return null;
  }

  private noteUnavailable(reason: MemoryUnavailable, agentId?: string): null {
    if (!this.loggedUnavailable.has(reason)) {
      this.loggedUnavailable.add(reason);
      this.d.log({ kind: 'native-memory-unavailable', reason, ...(agentId ? { agentId } : {}) });
    }
    return null;
  }

  /**
   * What a spawning agent gets, or null: then the agent has NO memory and its prompt carries no
   * memory line (Jim M2, fail closed). The command dir is returned on its own: the pty layer
   * puts it FIRST on the agent's one final PATH (buildPtyEnv's `pathPrepend`).
   */
  spawnEnv(agentId: string): { env: Record<string, string>; commandDir: string } | null {
    const why = this.unavailable();
    if (why) return why === 'disabled' ? null : this.noteUnavailable(why, agentId);
    const root = this.d.hiveRoot() as string;
    const commandDir = this.d.writeCommand(join(this.d.resourcesDir, 'memory-cli.cjs'));
    if (!commandDir) return this.noteUnavailable('command-failed', agentId);
    const env: Record<string, string> = { MEMORY_TOKEN: this.tokens.mint(agentId), MUNDER_HIVE_ROOT: root };
    const url = this.d.memoryBaseUrl();
    if (url) env.MUNDER_MEMORY_URL = url;
    return { env, commandDir };
  }

  /** NATIVE-WAKEUP-EMPTY-INDEX (a), god: fork the worker (its below-normal startup backfill runs;
   *  the model loads at the first embed) instead of waiting for the first request, so the first
   *  task-start wake-up does not meet an empty index. main calls it no earlier than 30 s after the
   *  first window finished loading (the spec's lazy rule). Nothing when memory is unavailable. */
  prewarm(): boolean {
    const why = this.unavailable();
    if (why) { if (why !== 'disabled') this.noteUnavailable(why); return false; }
    const ok = this.client.prewarm();
    this.d.log({ kind: 'native-memory-prewarm', forked: ok });
    return ok;
  }

  /** Is the worker forked right now? (MEMORY-STATUS-LAZY: status never forks it) */
  running(): boolean {
    return this.client.forked;
  }

  /** MEMORY-STATUS-LAZY (STARTUP-STALL-159): the Memory panel's status. The panel asks on mount,
   *  at start-up, so this NEVER forks the worker (that bypassed the 30 s lazy prewarm and put the
   *  fork, DB open and backfill inside the boot). A worker not running yet reports
   *  `running: false` and no index ("starts on first use", as on 1.1.58); a running one is asked. */
  async statusReport(): Promise<{ available: boolean; running: boolean; reason: MemoryUnavailable | null; index: Record<string, unknown> | null }> {
    const reason = this.unavailable();
    const running = this.running();
    let index: Record<string, unknown> | null = null;
    if (!reason && running) {
      const r = await this.query('status');
      if (r.exit === 0 && r.json && typeof r.json === 'object') index = r.json as Record<string, unknown>;
    }
    return { available: reason === null, running, reason, index };
  }

  agentExited(agentId: string): void {
    this.tokens.revoke(agentId);
  }

  /** The `/memory/<token>` handler. */
  async handle(token: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const agentId = this.tokens.resolve(token);
    if (!agentId) return { status: 403, body: { exit: EXIT.unauthorized, error: 'unauthorized' } };
    const cmd = body && typeof body === 'object' ? (body as Record<string, unknown>).cmd : undefined;
    const claims = typeof cmd === 'string' && CLAIM_VERBS.has(cmd) ? this.d.claims?.() ?? null : null;
    if (claims) {
      // The wing is the token's agent (G1.3); handleClaimVerb refuses a body naming one.
      const c = await handleClaimVerb(claims, agentId, body, 'endpoint');
      return { status: 200, body: { exit: c.exit, text: c.text, json: c.json, error: c.error } };
    }
    const r = await this.run((body ?? {}) as Record<string, unknown>, agentId);
    return { status: 200, body: { exit: r.exit, text: r.text, json: r.json, error: r.error } };
  }

  /** Main-internal callers (the renderer IPC): the same validation and ops as an agent, as the
   *  caller wing `human`. There is deliberately no HTTP route to this (Jim's note). */
  query(cmd: 'search' | 'wake-up' | 'status', args: Record<string, unknown> = {}): Promise<Reply> {
    return this.run({ cmd, args }, 'human');
  }

  private async run(body: Record<string, unknown>, callerWing: string): Promise<Reply> {
    const why = this.unavailable();
    if (why) return { ok: false, exit: EXIT.unavailable, error: why === 'disabled' ? 'memory is turned off in Settings' : `memory is unavailable (${why})` };
    const v = validateRequest(body, callerWing);
    if ('exit' in v) return { ok: false, exit: v.exit, error: v.error };
    const push = this.pushClaimLedger();
    if (push) await push;
    // NATIVE-WAKEUP N1: a wake-up may wait up to WAKE_WAIT_MS for its wing on a filling index,
    // so its deadline covers that wait plus the cold budget. status keeps 2 s; search its own.
    return this.client.request(v.op, v.args, v.op === 'search' ? undefined : v.op === 'wake-up' ? WAKE_UP_DEADLINE_MS : 2_000);
  }

  /** The Settings level a running worker was last told (null: not forked, or not told yet). */
  private sentLedger: { v: unknown; anchored: string } | null = null;
  private anchored(): string[] { try { return [...(this.d.anchoredAgents?.() ?? [])].sort(); } catch { return []; } }

  /**
   * W3-1 (Jim): a running worker follows the CURRENT Settings level. Before any request, a changed
   * level is pushed first, and the worker reconciles before answering (a drop to shadow brings
   * memory.md back and hides the claims, with no restart). A worker not running yet gets the level
   * in its config at fork.
   */
  claimLedgerChanged(): Promise<void> | null {
    // The Settings action that changes claimLedger calls this, so a running worker follows at once
    // (the per-request push below is the backstop).
    return this.pushClaimLedger();
  }

  /** null when there is nothing to push (synchronous: a request then posts at once, MAIN BUDGET). */
  private pushClaimLedger(): Promise<void> | null {
    if (!this.d.claimLedger || !this.client.forked) return null;
    const v = this.d.claimLedger();
    // A-2: the anchored agents travel with the level (a new anchor keeps that agent flagged).
    const anchored = this.anchored();
    const key = anchored.join(',');
    if (this.sentLedger && this.sentLedger.v === v && this.sentLedger.anchored === key) return null;
    return this.client.request('claim-ledger', { value: v as never, anchored: anchored as never }, 300_000).then((r) => { if (r.ok) this.sentLedger = { v, anchored: key }; });
  }

  /** CLAIM-LEDGER W3: index one agent's verified claim chunks (main only; no HTTP route). */
  async syncClaims(args: { wing: string; path: string; head: string; chunks: unknown[] }): Promise<Reply> {
    const why = this.unavailable();
    if (why) return { ok: false, exit: EXIT.unavailable, error: `memory is unavailable (${why})` };
    const push = this.pushClaimLedger();
    if (push) await push;
    return this.client.request('claims-sync', { ...args, claimLedger: this.d.claimLedger?.() } as unknown as Record<string, unknown>, 120_000);
  }

  /** CLAIM-LEDGER W3: R5 candidates for a just-appended claim (the W3 side of R5CandidatesFn). */
  r5Candidates(wing: string, claimId: string, tau2: number): Promise<Reply> {
    const why = this.unavailable();
    if (why) return Promise.resolve({ ok: false, exit: EXIT.unavailable, error: `memory is unavailable (${why})` });
    return this.client.request('r5-candidates', { wing, claimId, tau2 }, 5_000);
  }

  shutdown(): Promise<void> {
    return this.client.shutdown();
  }
}

/** A path inside app.asar, mapped to its asar-unpacked copy (a DLL cannot load from the archive). */
export function toUnpacked(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}
