'use strict';

/**
 * ZT-I1-MAIL 1.1.75 — LAYER (b): the short, bounded REAL-agent run (INBOX-DESIGN §8.4, §11.18 #40,
 * the Human's option A). Cloned from packaged-wake-canary.cjs; NOT part of `node --test`
 * (test/tools/run-tests.cjs only picks up test/*.test.cjs).
 *
 * WHAT IT PROVES. The facts only the real CLIs can prove (B1-B7), the renderer-only readers the
 * layer-(a) rig cannot reach (B8 Threads rows survive Stop, read from the DOM over CDP; B9 the
 * renderer queue's precondition never reads "empty" while the ledger says delivered), N4 against
 * the BUILT CHANGELOG, and the rollback check (§11.18 #40: the built 1.1.74 on a 1.1.75-written
 * sandbox hive, nothing lost).
 *
 * HOW IT STAYS SAFE (every point is enforced in code below, not only described):
 *  - The PACKAGED app runs under MUNDER_DEV=1 + MUNDER_HIDDEN=1 + MUNDER_DEV_ROOT=<fresh temp
 *    sandbox>, built with MUNDER_LAYERB_SEAMS=1 (a normal build compiles the seams out). Never
 *    C:\Dunder\hive, never C:\Dunder\MunderDevData, never the live userData. The root and its pipe
 *    are validated with the product's own devIsolation.ts BEFORE launch and read back from the
 *    running app AFTER launch (userData, packaged, the pipe= bootstrap line: a missing line FAILS).
 *  - THE AGENTS ARE CONFINED (Jim R1, god c0a73f):
 *    - Codex: --sandbox workspace-write --ask-for-approval never, writable roots = its own work dir
 *      and its own hive agent dir (the jail) only, no network for commands, the unelevated Windows
 *      sandbox (seeded through the jailed ~/.codex/config.toml the product copies per agent). This
 *      REPLACES the product's auto-mode flag (--dangerously-bypass-approvals-and-sandbox): a Codex
 *      agent without auto mode is a supported product configuration, and nothing B5-B7 test (the
 *      Route A hook context, retention, compaction) depends on the command sandbox.
 *    - Claude: the product's arguments are UNCHANGED (--permission-mode bypassPermissions). The
 *      jailed ~/.claude/settings.json adds permissions.deny rules for the live paths AND a
 *      PreToolUse hook (test/tools/layer-b-jail-hook.cjs) that denies any write outside the jail,
 *      any read outside the sandbox and risky shell forms. Claude's docs: deny rules and a hook deny
 *      apply in every permission mode, bypassPermissions included; user and --settings hooks both run.
 *    - Zero-token proofs before any agent starts (dry and real run): the installed hook command is
 *      fed payloads targeting C:\Dunder\hive and the real ~/.claude and must deny; the real codex
 *      binary's own sandbox runner (codex sandbox windows) runs a probe that tries to write markers
 *      into C:\Dunder\hive, the real ~/.codex and ~/.claude: refused, markers never appear, and a
 *      write inside the jail succeeds (positive control).
 *    - After the run (dry and real): the live hive, MunderDevData, the real ~/.claude, ~/.codex and
 *      the live userData are compared with a snapshot taken before (top-level mtime/size, key-file
 *      SHA-256): a change carrying a run marker FAILS; the real credential files must be
 *      byte-identical (SHA-256 + mtime + size).
 *  - No window ever: MUNDER_HIDDEN skips every show/focus. From the moment the app process exists, a
 *    hidden PowerShell watcher enumerates the top-level windows of the app's whole process tree
 *    every 1.5 s, and flags any browser the tree starts, any WerFault or consent.exe (UAC) that
 *    appears: any hit ABORTS. On top, BrowserWindow.isVisible() over the main-process inspector.
 *  - The app's ENTIRE env comes from test/mail-rig/isolation.cjs rigEnv (an allowlist): HOME,
 *    USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, CODEX_HOME, GEMINI_CLI_HOME are jailed; PATH holds
 *    only the real claude + codex binary dir(s), the Git cmd dir (Claude Code on Windows needs Git
 *    Bash; omit with --no-git-path), the node-only dir and the system dirs. Fail-fast on any
 *    secret-shaped variable, any foreign PATH dir, any other provider CLI resolvable, any env value
 *    naming a live path. CDP and the main inspector listen on random loopback ports (UNAUTHENTICATED
 *    while the app holds the jailed logins: the report says so).
 *  - Credentials: each CLI gets ONLY its login credential, COPIED (never moved) from the real file
 *    opened READ-ONLY, into the jail ($CODEX_HOME honoured for the Codex source). Nothing else is
 *    copied; the few first-run keys Claude needs are SYNTHESISED. The copies are securely deleted
 *    (overwritten, then removed) in finally, on every signal and on exit, AFTER every process is
 *    killed. The report states whether a token refresh happened (the jailed copy's SHA-256 before
 *    and after). A startup sweep securely removes credentials left by an earlier killed run.
 *  - Every write/remove the runner does goes through W (below), which refuses any path outside the
 *    run's own roots and any live location. WRITES OUTSIDE W, accounted for:
 *      - npm run build: out/ in this worktree (rebuilt WITHOUT the seams when the run ends);
 *      - electron-builder: dist/ in this worktree; its caches point INTO the sandbox
 *        (ELECTRON_BUILDER_CACHE, ELECTRON_CACHE, npm_config_cache; seeded by copying the user's
 *        winCodeSign cache read-only) and Electron comes from node_modules/electron/dist;
 *      - git: the shared .git (worktree metadata + the seam cherry-picks as dangling commits);
 *      - the 1.1.74 worktree %TEMP%\md-layerb-v1174 (source + a node_modules COPY): removed at the
 *        end, node_modules first, then git worktree remove WITHOUT --force (--keep-v1174 keeps it);
 *      - isolation.rigEnv: the jail dirs and the shared node-only dir %TEMP%\md-rig-node-<ver>;
 *      - the app and the CLIs themselves: the sandbox (jail, devroot) only.
 *    The build env is scrubbed of every secret-shaped variable (GH_TOKEN, CSC_*, NPM tokens ...).
 *  - Load: --go requires LAYERB_SOAK=1 on the invoking command line, which the floor's HEAVY-JOB
 *    lock classifies as a heavy "bench" job (heavyJob.ts BENCH_ENV): one heavy job at a time, held
 *    for the whole run. Global wall-clock cap 55 min (build included, under the lock's 60 min TTL);
 *    build steps 20 min in total.
 *  - Caps: 400k tokens per agent (cache reads included), 1M total, 30 min wall-clock for the agent
 *    phase — polled every few seconds from the sandbox cost ledger AND the CLIs' own
 *    transcripts/rollouts (the larger count wins); any hit ABORTS and the report says what was
 *    proven. The sandbox config also turns the breaker ON with hard stop and the token caps.
 *  - Every process started is killed by exact PID (pid + creation time, deepest first). A failed
 *    process scan is a FAILURE, and falls back to taskkill /T on the roots whose handle is still
 *    open (so the pid cannot have been reused). Emergency order: kill, then credentials, then sandbox.
 *  - Evidence copies are redacted (token-shaped strings, auth headers).
 *
 * USAGE (never without god's OK: it builds and LAUNCHES the app):
 *   LAYERB_SOAK=1 node C:/Dunder/_work/andy-scratch/flaky170/run-clean-realhome.cjs C:/Dunder/_work/andy-zt175 \
 *     node test/tools/layer-b-run.cjs --dry-run-stubs --go        # plumbing, zero tokens
 *   LAYERB_SOAK=1 ... node test/tools/layer-b-run.cjs --go         # the real run
 * Without --go it only runs the static preflight (no build, no launch, nothing written).
 * Options: --skip-build (reuse dist/), --no-rollback, --keep-sandbox, --keep-v1174, --no-git-path,
 *   --claude-model <id>, --codex-model <id>, --v1174-dir <dir>, --report-dir <dir>.
 * Exit 0 = every asserted fact PASS (dry run: every plumbing check PASS).
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const isolation = require(path.join(REPO, 'test', 'mail-rig', 'isolation.cjs'));

// ─────────────────────────────────────────────────────────────────────────── constants

const V1174_SHA = 'b5e22e0b';
const CAPS = { perAgentTokens: 400_000, totalTokens: 1_000_000, wallMs: 30 * 60_000 };
/** R5: the whole run (build included) fits under the floor heavy-job lock's 60 min TTL. */
const GLOBAL_WALL_MS = 55 * 60_000;
const BUILD_WALL_MS = 20 * 60_000;
/** The floor heavy-job lock's opt-in bench gate (src/main/heavyJob.ts BENCH_ENV). */
const HEAVY_GATE = 'LAYERB_SOAK';
const STALE_PREFIX = /^md-layerb-\d{4}-\d{2}-\d{2}T/;
const CREDENTIAL_NAMES = ['.credentials.json', 'auth.json'];
/** Rough per-fact token estimates; a fact is skipped (NOT-PROVEN, "budget") when it cannot fit. */
const FACT_EST = { B1: 40_000, B2: 70_000, B4: 45_000, B3: 190_000, B5: 45_000, B6: 150_000, B7: 160_000 };
const DEFAULT_MODELS = { claude: 'claude-haiku-4-5-20251001', codex: 'gpt-5.6-luna' };
const IDS = { claude: 'lb-claude', codex: 'lb-codex', god: 'god' };
const NUDGE_HEADS = ['You have new hive mail', 'You have new hive inbox message(s)'];
const LIVE = {
  hive: 'C:\\Dunder\\hive',
  devData: 'C:\\Dunder\\MunderDevData',
  dunder: 'C:\\Dunder'
};

const log = (...a) => console.log('[layer-b]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (n) => crypto.randomBytes(n).toString('hex');
const nonce = () => `LBN-${hex(4)}`;
const norm = (p) => path.resolve(p).toLowerCase();
const inside = (child, parent) => { const r = path.relative(norm(parent), norm(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// ─────────────────────────────────────────────────────────────────────────── args

function parseArgs(argv) {
  const a = { dryRun: false, go: false, skipBuild: false, rollback: true, keepSandbox: false, keepV1174: false, gitPath: true,
    models: { ...DEFAULT_MODELS }, v1174Dir: null, reportDir: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run-stubs') a.dryRun = true;
    else if (k === '--go') a.go = true;
    else if (k === '--skip-build') a.skipBuild = true;
    else if (k === '--no-rollback') a.rollback = false;
    else if (k === '--keep-sandbox') a.keepSandbox = true;
    else if (k === '--keep-v1174') a.keepV1174 = true;
    else if (k === '--no-git-path') a.gitPath = false;
    else if (k === '--claude-model') a.models.claude = argv[++i];
    else if (k === '--codex-model') a.models.codex = argv[++i];
    else if (k === '--v1174-dir') a.v1174Dir = path.resolve(argv[++i]);
    else if (k === '--report-dir') a.reportDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument ${k}`);
  }
  for (const m of Object.values(a.models)) if (!/^[A-Za-z0-9._:[\]-]{1,80}$/.test(String(m))) throw new Error(`bad model id ${m}`);
  return a;
}

// ─────────────────────────────────────────────────────────────────────────── the write guard

/** Live locations no write/remove may ever reach, computed from the REAL profile (the runner runs
 *  under run-clean-realhome, so os.homedir() and APPDATA are the real ones). */
function liveForbidden(env = process.env) {
  const home = os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return [
    LIVE.hive, LIVE.devData, path.join(LIVE.dunder, 'palace'), path.join(LIVE.dunder, 'worktrees'),
    path.join(LIVE.dunder, 'roster.json'), path.join(appData, 'munder-difflin'), path.join(appData, 'Munder Difflin'),
    path.join(home, '.claude'), path.join(home, '.claude.json'), path.join(home, '.codex'), path.join(home, '.gemini'),
    REPO + path.sep + 'src'
  ];
}

/**
 * The ONLY way this file writes, copies, renames or removes anything. A target must lie inside one
 * of the roots registered for this run (the sandbox, the report dir, the 1.1.74 build worktree, this
 * repo's dist/) and outside every live location, or the call THROWS before touching the disk.
 */
const W = {
  roots: [],
  forbidden: liveForbidden(),
  allowRoot(p) { const r = path.resolve(p); W.check(r, true); W.roots.push(r); return r; },
  check(p, registering = false) {
    const r = path.resolve(p);
    for (const f of W.forbidden) {
      if (inside(r, f) || inside(f, r)) throw new Error(`[layer-b] REFUSED: ${r} touches the live location ${f}`);
    }
    if (!registering && !W.roots.some((root) => inside(r, root))) throw new Error(`[layer-b] REFUSED: ${r} is outside this run's own roots`);
    return r;
  },
  mkdir(p) { fs.mkdirSync(W.check(p), { recursive: true }); },
  write(p, data, opts) { W.mkdir(path.dirname(p)); fs.writeFileSync(W.check(p), data, opts); },
  writeJson(p, v) { W.write(p, JSON.stringify(v, null, 2)); },
  /** Write beside, then rename into place: a watcher never sees a half-written file. */
  writeJsonAtomic(p, v) { const tmp = `${p}.${process.pid}.tmp`; W.write(tmp, JSON.stringify(v, null, 2)); fs.renameSync(W.check(tmp), W.check(p)); },
  rm(p) { fs.rmSync(W.check(p), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); },
  copy(from, to) { W.mkdir(path.dirname(to)); fs.copyFileSync(from, W.check(to)); },
  /** Overwrite a file's bytes (random, then zeros), flush, then remove it: a credential copy leaves
   *  no plaintext in the file we can reach. */
  shred(p) {
    const r = W.check(p);
    let st = null;
    try { st = fs.lstatSync(r); } catch { return false; }
    if (!st.isFile()) { W.rm(r); return !fs.existsSync(r); }
    if (st.size > 0) {
      const fd = fs.openSync(r, 'r+');
      try {
        fs.writeSync(fd, crypto.randomBytes(st.size), 0, st.size, 0);
        fs.writeSync(fd, Buffer.alloc(st.size), 0, st.size, 0);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    fs.rmSync(r, { force: true });
    return !fs.existsSync(r);
  },
  /** THE ONE EXCEPTION to "never touch a live location": remove a codex-sandbox probe marker the
   *  sandbox FAILED to refuse. Only an exact small file whose name is this run's unique marker. */
  removeProbeMarker(p, marker) {
    const r = path.resolve(p);
    if (path.basename(r) !== marker || !/^md-layerb-probe-[0-9a-f]{16}\.txt$/.test(marker)) throw new Error(`[layer-b] REFUSED marker removal: ${r}`);
    const st = fs.lstatSync(r);
    if (!st.isFile() || st.size > 4096) throw new Error(`[layer-b] REFUSED marker removal (not a small file): ${r}`);
    fs.rmSync(r);
  },
  /** A COPY of a tree (never a junction or link): node_modules for the 1.1.74 build. */
  copyTree(from, to) { W.check(to); fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: false, force: true }); }
};

// ─────────────────────────────────────────────────────────────────────────── small helpers

function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function readLines(p) { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean); } catch { return []; } }
function jsonLines(p) { return readLines(p).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
function walk(dir, pred, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out); else if (pred(p)) out.push(p);
  }
  return out;
}
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}
/** Resolve a command on a PATH string (read-only lookup; nothing is executed). */
function whichOn(pathStr, name) {
  const exts = ['.exe', '.cmd', '.bat', '.ps1', ''];
  for (const d of String(pathStr || '').split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}
const parentPath = () => { const k = Object.keys(process.env).find((x) => x.toLowerCase() === 'path'); return k ? process.env[k] : ''; };

/** Build-tool env (npm / electron-builder): hive/agent/Claude identity removed as in
 *  run-clean-realhome, EVERY secret-shaped variable removed (GH_TOKEN, CSC_*, NPM tokens, ...: R6),
 *  the caches pointed into the run's own cache dir, and MUNDER_LAYERB_SEAMS=1 so the bundle carries
 *  the hidden/root seams (only this build; a normal build compiles them out). */
function buildEnv(cacheDir, { seams = true, parent = process.env } = {}) {
  const BAD = /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CTH_|KG_|MD_SLACK_|CLAUDE|CSC_|WIN_CSC_|APPLE_|GH_|GITHUB_|NPM_|NODE_AUTH|ELECTRON_BUILDER_|ELECTRON_CACHE|npm_config_)/i;
  const env = {};
  for (const [k, v] of Object.entries(parent)) if (!BAD.test(k) && !isolation.SECRET_NAME.test(k)) env[k] = v;
  const pk = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const parts = String(env[pk] || '').split(';').filter((p) => p && !/dunder\\hive|munderdevdata/i.test(p));
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.Path = parts.join(';');
  if (cacheDir) {
    env.ELECTRON_BUILDER_CACHE = path.join(cacheDir, 'electron-builder');
    env.ELECTRON_CACHE = path.join(cacheDir, 'electron');
    env.npm_config_cache = path.join(cacheDir, 'npm');
  }
  if (seams) env.MUNDER_LAYERB_SEAMS = '1';
  return env;
}

/** One build step, bounded by what is left of the build budget. */
function run(cmd, args, cwd, label, { env, deadline = Date.now() + BUILD_WALL_MS } = {}) {
  if (!env) throw new Error('run() needs an explicit env');
  const left = deadline - Date.now();
  if (left <= 0) throw new Error(`${label}: the build budget (${BUILD_WALL_MS / 60000} min) is spent`);
  log(`${label}: ${cmd} ${args.join(' ')}  (in ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', windowsHide: true, shell: /\.(cmd|bat)$/i.test(cmd), timeout: left });
  if (r.error || r.status !== 0) throw new Error(`${label} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
}

/** Replace token-shaped strings before anything is copied into the report (R9). */
function redact(text) {
  return String(text)
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED-JWT]')
    .replace(/("?(?:access|refresh|id)_?[tT]oken"?\s*[:=]\s*)"[^"]*"/g, '$1"[REDACTED]"')
    .replace(/("?(?:accessToken|refreshToken|idToken|api_?key|apiKey|OPENAI_API_KEY|ANTHROPIC_API_KEY)"?\s*[:=]\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/(authorization\s*[:=]\s*"?(?:bearer|basic)\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/(x-api-key\s*[:=]\s*"?)[A-Za-z0-9._-]+/gi, '$1[REDACTED]');
}

// ─────────────────────────────────────────────────────────────────────────── processes & windows

const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const PS_SCAN = (pids) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LbWin {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string[] Visible(uint[] pids) {
    var set = new HashSet<uint>(pids); var o = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p) && IsWindowVisible(h)) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); o.Add(p + ":" + sb.ToString()); }
      return true; }, IntPtr.Zero);
    return o.ToArray();
  }
}
"@
$procs = Get-CimInstance Win32_Process | ForEach-Object { @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; created = [string]($(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 })) } }
$vis = [LbWin]::Visible([uint32[]]@(${pids.length ? pids.join(',') : '0'}))
@{ procs = @($procs); visible = @($vis) } | ConvertTo-Json -Depth 4 -Compress
`;

/** Every process this run started, and every descendant ever seen, keyed by pid + creation time
 *  (so a reused pid is never mistaken for ours). Kill is by EXACT pid, deepest first. */
class ProcTracker {
  constructor() { this.known = new Map(); this.visibleHits = []; this.scans = 0; this.handles = new Map(); }
  /** A process this run spawned. Its ChildProcess handle is kept: while it has not exited, Windows
   *  cannot reuse its pid, so it is a safe kill target even when a scan fails. */
  addRoot(pid, child = null) { this.known.set(pid, { pid, created: null, name: 'root', depth: 0 }); if (child) this.handles.set(pid, child); }
  livePids() { return [...this.known.keys()]; }
  async scan() {
    const out = await new Promise((res) => {
      const c = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let so = ''; let se = '';
      c.stdout.on('data', (d) => { so += d; });
      c.stderr.on('data', (d) => { se += d; });
      c.on('close', () => res({ so, se }));
      c.on('error', (e) => res({ so: '', se: String(e) }));
      c.stdin.end(PS_SCAN(this.livePids()));
    });
    return this.ingest(out);
  }
  /** The same scan, synchronously (signal / exit paths). */
  scanSync() {
    const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, input: PS_SCAN(this.livePids()), encoding: 'utf8', timeout: 60_000 });
    return this.ingest({ so: r.stdout || '', se: r.stderr || String(r.error || '') });
  }
  ingest(out) {
    let parsed = null;
    try { parsed = JSON.parse(out.so.trim()); } catch { throw new Error(`process/window scan failed: ${out.se.slice(0, 400)}`); }
    this.scans++;
    const procs = (parsed.procs || []).map((p) => ({ ...p, created: String(p.created) }));
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    // Fill in the roots' creation time, then grow the set to a fixed point.
    for (const k of this.known.values()) if (k.created === null && byPid.has(k.pid)) { k.created = byPid.get(k.pid).created; k.name = byPid.get(k.pid).name; }
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of procs) {
        if (this.known.has(p.pid)) continue;
        const parent = this.known.get(p.ppid);
        if (!parent || parent.created === null) continue;
        // PID REUSE GUARD. The parent pid must be OUR process: either alive with the recorded
        // creation time, or gone entirely (an orphan of ours). A live process holding that pid
        // with another creation time means the number was reused: never adopt its children.
        const holder = byPid.get(p.ppid);
        if (holder && holder.created !== parent.created) continue;
        if (BigInt(p.created || '0') < BigInt(parent.created || '0')) continue;   // older than its "parent"
        this.known.set(p.pid, { pid: p.pid, created: p.created, name: p.name, depth: parent.depth + 1 });
        grew = true;
      }
    }
    const visible = (parsed.visible || []).filter(Boolean);
    if (visible.length) this.visibleHits.push({ at: new Date().toISOString(), visible });
    return { visible, procs };
  }
  /** Kill every known process that is still the same process, deepest first. A failed scan is a
   *  FAILURE (R3): nothing can be identity-checked, so only the roots whose handle is still open are
   *  killed, with their whole tree (taskkill /T), and the result says ok:false. */
  async killAll() {
    let snap = null;
    let scanError = null;
    try { snap = await this.scan(); } catch (e) { scanError = e.message; }
    if (!snap) return this.killRootsByHandle(scanError);
    if (this.known.size && !snap.procs.length) return this.killRootsByHandle('the process scan returned no processes');
    const alive = new Map(snap.procs.map((p) => [p.pid, p]));
    const same = (k) => alive.has(k.pid) && (k.created === null ? /munder difflin/i.test(alive.get(k.pid).name) : alive.get(k.pid).created === k.created);
    const ours = [...this.known.values()].filter(same).sort((a, b) => b.depth - a.depth);
    for (const k of ours) spawnSync('taskkill', ['/F', '/PID', String(k.pid)], { windowsHide: true, stdio: 'ignore' });
    await sleep(1500);
    let after = null;
    try { after = await this.scan(); } catch (e) { scanError = e.message; }
    if (!after || !after.procs.length) return { ...this.killRootsByHandle(`the post-kill scan failed: ${scanError || 'no processes'}`), killed: ours.map((k) => `${k.pid}:${k.name}`) };
    const still = after.procs.filter((p) => { const k = this.known.get(p.pid); return k && (k.created === null ? /munder difflin/i.test(p.name) : k.created === p.created); });
    return { ok: still.length === 0, scanFailed: false, killed: ours.map((k) => `${k.pid}:${k.name}`), survivors: still.map((p) => `${p.pid}:${p.name}`) };
  }
  /** The fallback when no scan can prove identity: taskkill /T /F on every root whose ChildProcess
   *  handle has not seen an exit (so its pid cannot have been reused). Always ok:false. */
  killRootsByHandle(why) {
    const fallback = [];
    for (const [pid, child] of this.handles) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
      fallback.push(pid);
    }
    return { ok: false, scanFailed: true, why, killed: [], fallback, survivors: [`UNKNOWN (${why})`] };
  }
  /** Synchronous last resort (signals, crashes): the same identity-checked kill, no event loop. */
  killSyncBestEffort() {
    let snap;
    try { snap = this.scanSync(); } catch { this.killRootsByHandle('emergency scan failed'); return; }   // no identity proof: only the open-handle roots
    const alive = new Map(snap.procs.map((p) => [p.pid, p]));
    for (const k of [...this.known.values()].sort((a, b) => b.depth - a.depth)) {
      const a = alive.get(k.pid);
      if (!a || (k.created === null ? !/munder difflin/i.test(a.name) : a.created !== k.created)) continue;
      try { spawnSync('taskkill', ['/F', '/PID', String(k.pid)], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* gone */ }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────── the window watcher

/**
 * R8 (Jim) + god c0a73f: the visibility watch starts WITH the process, not once CDP is up. One
 * hidden PowerShell runs for the life of each launch: every 1.5 s it walks the process tree under
 * the root pid (Win32_Process), enumerates the visible top-level windows of that tree (EnumWindows /
 * IsWindowVisible), and reports any browser the tree started and any WerFault / consent.exe (UAC)
 * that appeared after it began (those are started by a service, outside the tree). Each line is JSON.
 */
const PS_WATCH = (rootPid) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class LbWatch {
  public delegate bool P(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(P f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string[] Visible(uint[] pids) {
    var set = new HashSet<uint>(pids); var o = new List<string>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p) && IsWindowVisible(h)) { var sb = new StringBuilder(256); GetWindowText(h, sb, 256); o.Add(p + ":" + sb.ToString()); }
      return true; }, IntPtr.Zero);
    return o.ToArray();
  }
}
"@
$root = ${Number(rootPid)}
$since = (Get-Date).ToUniversalTime()
$browsers = '^(chrome|msedge|firefox|brave|opera|iexplore|msedgewebview2)\\.exe$'
$alerts = '^(WerFault|WerFaultSecure|consent)\\.exe$'
while ($true) {
  try {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)
    $kids = @{}; foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($k)) { $kids[$k] = @() }; $kids[$k] += $p }
    $tree = New-Object System.Collections.Generic.List[uint32]; $queue = New-Object System.Collections.Queue; $queue.Enqueue([int]$root)
    $names = @{}
    while ($queue.Count) { $x = $queue.Dequeue(); if ($tree.Contains([uint32]$x)) { continue }; $tree.Add([uint32]$x); if ($kids.ContainsKey($x)) { foreach ($c in $kids[$x]) { $names[[int]$c.ProcessId] = $c.Name; $queue.Enqueue([int]$c.ProcessId) } } }
    $vis = [LbWatch]::Visible($tree.ToArray())
    $br = @($names.GetEnumerator() | Where-Object { $_.Value -match $browsers } | ForEach-Object { "$($_.Key):$($_.Value)" })
    $al = @($all | Where-Object { $_.Name -match $alerts -and $_.CreationDate -and $_.CreationDate.ToUniversalTime() -gt $since } | ForEach-Object { "$($_.ProcessId):$($_.Name)" })
    @{ ok = $true; tree = $tree.Count; visible = @($vis); browsers = $br; alerts = $al } | ConvertTo-Json -Compress
  } catch {
    @{ ok = $false; error = "$_" } | ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds 1500
}
`;

class WindowWatch {
  /** `onHit(reason)` is called for any visible window, browser or alert; `onBlind(reason)` when
   *  the watcher cannot see (it stops reporting or reports errors): both abort the run. */
  constructor(rootPid, { onHit, onBlind }) {
    this.rootPid = rootPid; this.onHit = onHit; this.onBlind = onBlind;
    this.lines = 0; this.lastAt = 0; this.errors = 0; this.hits = []; this.buf = '';
  }
  start() {
    this.child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.end(PS_WATCH(this.rootPid));
    this.child.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (line) this.ingest(line); }
    });
    this.child.on('exit', () => { if (!this.stopped) this.onBlind('the window watcher exited'); });
    this.startedAt = Date.now();
    return this;
  }
  /** One JSON line from the watcher (exported logic: the static test feeds it). */
  ingest(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    this.lines++; this.lastAt = Date.now();
    if (!m.ok) { if (++this.errors >= 3) this.onBlind(`the window watcher keeps failing: ${m.error}`); return; }
    this.errors = 0;
    const hit = [...(m.visible || []).map((v) => `visible window ${v}`), ...(m.browsers || []).map((b) => `browser started by the tree ${b}`), ...(m.alerts || []).map((a) => `crash/UAC dialog process ${a}`)];
    if (hit.length) { this.hits.push({ at: new Date().toISOString(), hit }); this.onHit(hit.join('; ')); }
  }
  /** Seen at least one good line, and not silent for too long. */
  healthy(now = Date.now()) { return this.lines > 0 && now - this.lastAt < 15_000; }
  stop() {
    this.stopped = true;
    if (this.child && this.child.exitCode === null) spawnSync('taskkill', ['/T', '/F', '/PID', String(this.child.pid)], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  }
}

// ─────────────────────────────────────────────────────────────────────────── agent confinement

const JAIL_HOOK = path.join(__dirname, 'layer-b-jail-hook.cjs');
const JAIL_PROTECT = ['.claude', '.codex', '.claude.json', '.credentials.json', 'auth.json', 'settings.json', 'settings.local.json', 'layer-b-jail-policy.json'];
/** Windows path -> Claude's POSIX rule form: C:\Dunder\hive -> //c/Dunder/hive (docs: permissions). */
const claudeRulePath = (p) => '//' + path.resolve(p).replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/\\/g, '/');

/** The jailed ~/.claude/settings.json: the first-run keys, the deny rules and the jail hook. */
function claudeJailSettings({ node, policyFile, liveDenied, env }) {
  const deny = [];
  for (const p of liveDenied) for (const tool of ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) deny.push(`${tool}(${claudeRulePath(p)}/**)`, `${tool}(${claudeRulePath(p)})`);
  deny.push('WebFetch', 'WebSearch');
  const q = (s) => `"${String(s).replace(/\\/g, '/')}"`;
  return {
    skipDangerousModePermissionPrompt: true,
    skipAutoPermissionPrompt: true,
    permissions: { deny },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${q(node)} ${q(JAIL_HOOK)} ${q(policyFile)}`, timeout: 30 }] }] },
    ...(env ? { env } : {})
  };
}

/** The jailed ~/.codex/config.toml the product seeds each Codex agent's home from: workspace-write,
 *  writable roots = the jail only, no command network, the UNELEVATED Windows sandbox (no setup,
 *  no UAC). TOML literal strings: Windows paths need no escaping. */
function codexSandboxToml(writableRoots) {
  return [
    'sandbox_mode = "workspace-write"',
    'approval_policy = "never"',
    '',
    '[sandbox_workspace_write]',
    `writable_roots = [${writableRoots.map((r) => `'${path.resolve(r)}'`).join(', ')}]`,
    'network_access = false',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    ''
  ].join('\n');
}

/** The vendor codex.exe next to the npm shim (so the probe needs no cmd.exe quoting). */
function codexExe(shimPath) {
  const base = path.dirname(shimPath);
  const cands = [
    path.join(base, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    path.join(base, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe')
  ];
  return cands.find((c) => fs.existsSync(c)) || null;
}

// ─────────────────────────────────────────────────────────────────────────── CDP

class Cdp {
  static async target(port, pred, budgetMs, abort) {
    const until = Date.now() + budgetMs;
    for (;;) {
      abort.throwIfAborted();
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        const t = (await res.json()).find(pred);
        if (t && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
      } catch { /* not listening yet */ }
      if (Date.now() > until) throw new Error(`no DevTools target on port ${port}`);
      await sleep(1000);
    }
  }
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    const WebSocket = require('ws');
    this.ws = new WebSocket(this.url);
    await new Promise((r, rej) => { this.ws.once('open', r); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m); }
    });
    await this.send('Runtime.enable', {});
    return this;
  }
  send(method, params = {}, timeoutMs = 20_000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); m.error ? rej(new Error(`CDP ${method}: ${m.error.message}`)) : res(m.result); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
    return r.result ? r.result.value : undefined;
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

// ─────────────────────────────────────────────────────────────────────────── stub TUIs (dry run)

/** The canary's stand-in CLI (cloned from packaged-wake-canary.cjs), plus one plumbing-only reply:
 *  on each typed turn it answers god with any LBN- token found in its own inbox files. That is a
 *  FILE READ, so a dry run never counts as proof of B1-B7: it only validates the plumbing. */
function stubSource(agentId, pipe, typedLog, agentDir, stopDelayMs) {
  return `'use strict';
const net = require('net'); const fs = require('fs'); const path = require('path');
const AGENT_ID = ${JSON.stringify(agentId)}; const PIPE = ${JSON.stringify(pipe)};
const TYPED = ${JSON.stringify(typedLog)}; const DIR = ${JSON.stringify(agentDir)};
const SESSION = 'layerb-stub-' + AGENT_ID; const STOP_DELAY_MS = ${Number(stopDelayMs) || 600};
const answered = new Set();
function emit(payload) {
  try { const c = net.createConnection(PIPE, function () { c.end(JSON.stringify(Object.assign({ agent_id: AGENT_ID, session_id: SESSION }, payload)) + '\\n'); }); c.on('error', function () {}); } catch (e) {}
}
function replyFromInbox() {
  if (AGENT_ID === 'god') return;
  const found = [];
  for (const d of [path.join(DIR, 'inbox'), path.join(DIR, 'inbox', '.done')]) {
    let names = []; try { names = fs.readdirSync(d).filter((n) => n.endsWith('.json')); } catch (e) {}
    for (const n of names) { try { const m = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); const t = String(m.body || '').match(/LBN-[0-9a-f]{8}/g) || []; for (const x of t) if (!answered.has(x)) { answered.add(x); found.push(x); } } catch (e) {} }
  }
  if (!found.length) return;
  const id = 'stub-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try { fs.writeFileSync(path.join(DIR, 'outbox', id + '.json'), JSON.stringify({ id, conversation: 'layer-b', to: 'god', act: 'inform', subject: 'stub reply', body: found.join(' '), requires_reply: false, needs_human: false, created_at: new Date().toISOString() })); } catch (e) {}
}
emit({ hook_event_name: 'SessionStart', source: 'startup' });
process.stdout.write('layer-b stub ready (' + AGENT_ID + ')\\r\\n> ');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (chunk) {
  buf += chunk; let i;
  while ((i = buf.search(/[\\r\\n]/)) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { fs.appendFileSync(TYPED, line + '\\n'); } catch (e) {}
    process.stdout.write('\\r\\n[received ' + line.length + ' chars]\\r\\n> ');
    emit({ hook_event_name: 'UserPromptSubmit', prompt: line });
    setTimeout(function () { replyFromInbox(); emit({ hook_event_name: 'Stop' }); }, STOP_DELAY_MS);
  }
});
process.stdin.resume();
setInterval(function () {}, 1 << 30);
`;
}

// ─────────────────────────────────────────────────────────────────────────── credentials

/** Real credential files, READ ONLY. Claude Code keeps its login in ~/.claude/.credentials.json on
 *  Windows/Linux (Keychain on macOS); Codex in $CODEX_HOME/auth.json, default ~/.codex/auth.json
 *  (R10: $CODEX_HOME honoured; one that points into a live hive or MunderDevData is refused: start
 *  the runner from a clean shell). */
function realCredentialPaths(env = process.env) {
  const home = os.homedir();
  const codexHome = env.CODEX_HOME && env.CODEX_HOME.trim() ? path.resolve(env.CODEX_HOME.trim()) : path.join(home, '.codex');
  if (inside(codexHome, LIVE.hive) || inside(codexHome, LIVE.devData)) throw new Error(`CODEX_HOME points into a live hive (${codexHome}): run from a clean shell`);
  return { claude: path.join(home, '.claude', '.credentials.json'), codex: path.join(codexHome, 'auth.json') };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** SHA-256 of a file opened READ-ONLY (never through W: this reads a real/live file). */
function shaReadOnly(p) {
  const fd = fs.openSync(p, 'r');
  try { const b = fs.readFileSync(fd); const h = sha256(b); b.fill(0); return h; } finally { fs.closeSync(fd); }
}

class Credentials {
  constructor() { this.copies = []; }
  /** Open the real file read-only, copy its bytes into the jail (exclusive create, 0600). */
  copy(label, real, dest) {
    const before = fs.statSync(real);
    if (!before.isFile()) throw new Error(`${label}: ${real} is not a file`);
    const fd = fs.openSync(real, 'r');
    let buf;
    try { buf = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    W.mkdir(path.dirname(dest));
    W.write(dest, buf, { mode: 0o600, flag: 'wx' });
    const sha = sha256(buf);
    this.copies.push({ label, real, dest, mtimeMs: before.mtimeMs, size: before.size, realSha: sha, jailSha: sha });
    buf.fill(0);
  }
  /** Synchronous, idempotent: safe from finally, signal handlers and process 'exit'. Records whether
   *  the CLI refreshed its token in the jail (R2: the copy's SHA-256 at copy time vs now), then
   *  SHREDS the copy. */
  deleteAll() {
    const out = [];
    for (const c of this.copies) {
      if (c.done) { out.push(c.done); continue; }
      let refreshed = null;
      try { if (fs.existsSync(c.dest)) refreshed = sha256(fs.readFileSync(c.dest)) !== c.jailSha; } catch { /* unreadable */ }
      let deleted = false;
      try { deleted = W.shred(c.dest); } catch (e) { out.push({ label: c.label, deleted: false, error: e.message, tokenRefreshed: refreshed }); continue; }
      c.done = { label: c.label, deleted: deleted && !fs.existsSync(c.dest), tokenRefreshed: refreshed };
      out.push(c.done);
    }
    return out;
  }
  /** The real files must be exactly as they were: SHA-256 (read-only) AND mtime AND size (Dwight). */
  verifyRealUnchanged() {
    return this.copies.map((c) => {
      let st = null; let sha = null;
      try { st = fs.statSync(c.real); sha = shaReadOnly(c.real); } catch { /* vanished */ }
      const mtimeSame = !!st && st.mtimeMs === c.mtimeMs;
      const sizeSame = !!st && st.size === c.size;
      const shaSame = sha === c.realSha;
      return { label: c.label, real: c.real, unchanged: mtimeSame && sizeSame && shaSame, shaSame, mtimeSame, sizeSame };
    });
  }
}

/**
 * R4 startup sweep: an earlier run killed hard (kill -9, power loss) can leave its sandbox, with
 * PLAINTEXT credential copies, in %TEMP%. Every stale md-layerb-<stamp> dir (not this run's) has its
 * credential files SHREDDED first, then the dir is removed. Returns what it did.
 */
function sweepStale(tmp, currentBase) {
  const done = [];
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return done; }
  for (const n of names.filter((x) => STALE_PREFIX.test(x))) {
    const dir = path.join(tmp, n);
    if (currentBase && norm(dir) === norm(currentBase)) continue;
    let st = null;
    try { st = fs.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    W.allowRoot(dir);
    const creds = walk(dir, (f) => CREDENTIAL_NAMES.includes(path.basename(f).toLowerCase()));
    let shredded = 0;
    for (const f of creds) { try { if (W.shred(f)) shredded++; } catch (e) { log(`sweep: could not shred ${f}: ${e.message}`); } }
    try { W.rm(dir); } catch (e) { log(`sweep: could not remove ${dir}: ${e.message}`); }
    done.push({ dir, credentials: creds.length, shredded, removed: !fs.existsSync(dir) });
  }
  return done;
}

// ─────────────────────────────────────────────────────────────────────────── live-location watch

/**
 * R1 (god c0a73f (c)): what the live floor's files looked like before the run, compared after it.
 * Top-level entries of each live root (size + mtime) and SHA-256 of key files, all READ-ONLY. The
 * live floor keeps writing its own files during the run, so a CHANGE alone is reported, and it
 * FAILS only when the name or the NEW bytes carry one of this run's markers (sandbox path, stamp,
 * agent ids, nonces).
 */
class LiveWatch {
  constructor(roots, keyFiles) { this.roots = roots; this.keyFiles = keyFiles; this.before = null; }
  static defaults(env = process.env) {
    const home = os.homedir();
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return new LiveWatch(
      [LIVE.hive, LIVE.devData, path.join(home, '.claude'), path.join(home, '.codex'), path.join(appData, 'munder-difflin')],
      [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude.json'), path.join(home, '.codex', 'config.toml'),
        path.join(appData, 'munder-difflin', 'config.json'), path.join(LIVE.hive, 'registry.json')]
    );
  }
  snapshot() {
    const snap = { entries: {}, keys: {} };
    for (const r of this.roots) {
      let names = [];
      try { names = fs.readdirSync(r); } catch { continue; }
      for (const n of names) {
        const f = path.join(r, n);
        try { const st = fs.lstatSync(f); snap.entries[f] = { size: st.size, mtimeMs: st.mtimeMs, dir: st.isDirectory() }; } catch { /* raced */ }
      }
    }
    for (const k of this.keyFiles) { try { snap.keys[k] = shaReadOnly(k); } catch { snap.keys[k] = null; } }
    return snap;
  }
  start() { this.before = this.snapshot(); return this; }
  /** Compare with the snapshot. `markers` = strings only this run produces. */
  compare(markers) {
    const after = this.snapshot();
    const changed = []; const failures = [];
    const hasMarker = (text) => markers.find((m) => m && String(text).toLowerCase().includes(String(m).toLowerCase()));
    const newBytes = (f, before) => {
      try {
        const st = fs.statSync(f);
        if (st.isDirectory()) return '';
        const from = before && !before.dir && st.size >= before.size ? before.size : 0;
        const len = Math.min(st.size - from, 4 * 1024 * 1024);
        if (len <= 0) return '';
        const fd = fs.openSync(f, 'r');
        try { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, from); return b.toString('utf8'); } finally { fs.closeSync(fd); }
      } catch { return ''; }
    };
    for (const [f, a] of Object.entries(after.entries)) {
      const b = this.before.entries[f];
      if (b && b.size === a.size && b.mtimeMs === a.mtimeMs) continue;
      changed.push({ file: f, kind: b ? 'changed' : 'new' });
      const m = hasMarker(path.basename(f)) || hasMarker(newBytes(f, b));
      if (m) failures.push(`${f} ${b ? 'changed' : 'appeared'} and carries this run's marker "${m}"`);
    }
    for (const f of Object.keys(this.before.entries)) if (!after.entries[f]) changed.push({ file: f, kind: 'removed' });
    const keys = Object.keys(after.keys).map((k) => ({ file: k, same: after.keys[k] === this.before.keys[k] }));
    return { ok: failures.length === 0, failures, changed, keys };
  }
}

// ─────────────────────────────────────────────────────────────────────────── B6 tiers (pure)

/** Strip every <hive-mail>...</hive-mail> block (those are what B6 measures, not growth). */
const withoutMail = (text) => String(text).replace(/<hive-mail[\s\S]*?<\/hive-mail>/g, '');

/**
 * B6 tiers 1 and 2 from a Codex rollout (pure: events in, verdict out). turnStart[k] is when turn
 * k+1's mail was sent; nonces[k] its nonce; blocks[k] its mail block in tokens (~4 chars/token).
 * Turns are the rollout's task_started segments at/after turnStart[0].
 */
function b6Tiers(events, { turnStart, nonces, blocks }) {
  const ts = (e) => (e && e.timestamp ? Date.parse(e.timestamp) : NaN);
  const evs = events.filter((e) => ts(e) >= turnStart[0]).sort((a, b) => ts(a) - ts(b));
  const isStart = (e) => e.payload && /^(task_started|turn_started)$/.test(String(e.payload.type));
  const segs = [];
  for (const e of evs) { if (isStart(e)) segs.push([]); if (segs.length) segs[segs.length - 1].push(e); }
  const usage = (seg) => seg.filter((e) => e.payload && e.payload.type === 'token_count' && e.payload.info && e.payload.info.last_token_usage).map((e) => e.payload.info.last_token_usage);
  const out = { tier1: '', tier2: '', verdict: null, retained: null, ratio: null };
  if (segs.length < 4 || usage(segs[0]).length === 0 || usage(segs[3]).length === 0) {
    out.tier1 = `not measurable (${segs.length} turn segments; need 4 with token counts)`;
  } else {
    const in1 = usage(segs[0])[0].input_tokens || 0;
    const in4 = usage(segs[3])[0].input_tokens || 0;
    let outputs = 0;
    for (const seg of segs.slice(0, 3)) for (const u of usage(seg)) outputs += u.output_tokens || 0;
    const textOf = (e) => { const p = e.payload || {}; return withoutMail(JSON.stringify(p.content || p.arguments || p.output || p.input || p.action || '')); };
    let chars = 0;
    // Model OUTPUT (assistant text, reasoning, tool-call arguments) is already in `outputs`; count
    // only what enters the history from outside the model: turn texts and tool outputs.
    const external = (e) => e.type === 'response_item' && e.payload
      && ((e.payload.type === 'message' && /^(user|developer)$/.test(String(e.payload.role))) || /_output$/.test(String(e.payload.type)));
    for (const seg of segs.slice(0, 3)) for (const e of seg) if (external(e)) chars += textOf(e).length;
    for (const e of segs[3]) { if (e.type === 'response_item' && e.payload && e.payload.role === 'user') { chars += textOf(e).length; break; } }
    const growth = outputs + Math.round(chars / 4);
    const earlier = blocks.slice(0, 3).reduce((a, b) => a + b, 0);
    const retained = in4 - in1 - growth - (blocks[3] || 0) + (blocks[0] || 0);
    const ratio = earlier > 0 ? retained / earlier : null;
    out.retained = Math.round(retained); out.ratio = ratio;
    out.verdict = ratio === null ? null : (ratio >= 0.5 ? 'FAIL' : (ratio < 0.1 ? 'PASS' : null));
    out.tier1 = `in1 ${in1}, in4 ${in4}, growth ${growth} (outputs ${outputs} + ~${Math.round(chars / 4)} text), blocks ${blocks.map((b) => Math.round(b)).join('/')}: retained ~${Math.round(retained)} = ${ratio === null ? '?' : Math.round(ratio * 100)}% of the ${Math.round(earlier)} earlier-block tokens -> ${out.verdict || 'NOT-PROVEN'} (FAIL >= 50%, PASS < 10%)`;
  }
  const compacted = evs.filter((e) => e.type === 'compacted' || (e.payload && e.payload.type === 'compacted'));
  const early = nonces.slice(0, 3);
  if (compacted.length) {
    const hist = JSON.stringify(compacted.map((e) => (e.payload && e.payload.replacement_history) || []));
    const kept = early.filter((n) => hist.includes(n));
    out.tier2 = `a compaction happened: replacement_history carries ${kept.length} of the turn 1-3 nonces${kept.length ? ` (${kept.join(',')})` : ''}`;
  } else {
    const t4 = segs[3] ? ts(segs[3][0]) : Infinity;
    const persisted = evs.filter((e) => e.type === 'response_item' && /<hive-mail/.test(JSON.stringify(e.payload || {})));
    const carry = persisted.filter((e) => early.some((n) => JSON.stringify(e.payload).includes(n)));
    const after4 = carry.filter((e) => ts(e) >= t4);
    out.tier2 = `persisted response_items with <hive-mail>: ${persisted.length}; carrying a turn 1-3 nonce AT/AFTER turn 4 started (retained into turn 4): ${after4.length}; before turn 4 (their own turn): ${carry.length - after4.length}`;
    out.tier2Retained = after4.length;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────── the run

class LayerB {
  constructor(args) {
    this.args = args;
    this.stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.facts = {};
    this.checks = [];
    this.abort = new AbortController();
    this.procs = new ProcTracker();
    this.creds = new Credentials();
    this.ledgerHistory = {};   // agentId -> id -> [{t,state,hookKind,surfaceCount,epoch}]
    this.samples = { b9: [], hidden: [] };
    this.tokens = {};
    this.appOut = '';
    this.startedAt = null;
    this.bg = [];
    this.nonces = [];
    this.proofs = {};
    this.watchHits = [];
  }

  fact(id, status, detail, evidence = []) {
    this.facts[id] = { id, status, detail, evidence };
    log(`${id}: ${status} — ${detail}`);
  }
  check(ok, label, detail) { this.checks.push({ ok: !!ok, label, detail: detail ?? '' }); if (!ok) log(`CHECK FAILED: ${label} ${detail ?? ''}`); return !!ok; }
  stop(reason) { if (!this.abort.signal.aborted) { log(`ABORT: ${reason}`); this.abort.abort(new Error(reason)); } }
  aborted() { return this.abort.signal.aborted; }

  async waitFor(label, budgetMs, fn, pollMs = 1500) {
    const until = Date.now() + budgetMs;
    for (;;) {
      this.abort.signal.throwIfAborted();
      const v = await fn();
      if (v) return v;
      if (Date.now() > until) throw new Error(`TIMEOUT after ${budgetMs} ms waiting for: ${label}`);
      await sleep(pollMs);
    }
  }

  // ── layout ────────────────────────────────────────────────────────────────
  layout() {
    const base = path.join(os.tmpdir(), `md-layerb-${this.stamp}`);
    const s = {
      base,
      devRoot: path.join(base, 'devroot'),
      jail: path.join(base, 'jail'),
      work: path.join(base, 'work'),
      stubs: path.join(base, 'stubs'),
      report: this.args.reportDir || path.join(REPO, 'dist', 'layer-b-reports', this.stamp)
    };
    s.hive = path.join(s.devRoot, 'hive');
    s.userData = path.join(s.devRoot, 'userData');
    s.roster = path.join(s.devRoot, 'roster.json');
    s.home = path.join(s.jail, 'home');
    s.pipe = null;
    this.s = s;
    return s;
  }

  // ── preflight: every refusal happens BEFORE anything is built or launched ──
  preflight() {
    const s = this.s;
    if (process.platform !== 'win32') throw new Error('layer (b) runs on Windows only');
    for (const k of Object.keys(process.env)) {
      if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_|CTH_|KG_)/i.test(k)) throw new Error(`the runner itself carries ${k}: run it through run-clean-realhome.cjs`);
    }
    // R5: the floor's heavy-job lock is taken by the INVOKING command line (heavyJob.ts BENCH_ENV).
    if (this.args.go && process.env[HEAVY_GATE] !== '1') {
      throw new Error(`--go needs ${HEAVY_GATE}=1 on the invoking command line, so the floor's heavy-job lock holds the slot for the whole run (see the header)`);
    }
    // The sandbox root, validated by the PRODUCT's own guard, with the live userData forbidden.
    const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
    const iso = loadTs(path.join(REPO, 'src', 'main', 'devIsolation.ts'));
    const liveUserData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'munder-difflin');
    const r = iso.resolveDevDataRoot({ env: { MUNDER_DEV_ROOT: s.devRoot }, dev: true, seams: true, platform: 'win32', liveUserData });
    if (!r.ok || !r.override) throw new Error(`the sandbox root is refused by devIsolation: ${r.reason || 'not an override'}`);
    const paths = iso.devPaths(r.root, 'win32');
    const livePipe = iso.hookPipeName(LIVE.hive, false, 'win32');
    const fixedPipe = iso.devPaths(LIVE.devData, 'win32').pipeName;
    s.pipe = paths.pipeName;
    const forbidden = [...iso.stableForbiddenPaths({ defaultUserData: liveUserData, stableHarnessHome: LIVE.dunder, platform: 'win32' }), LIVE.devData];
    const v = [...iso.checkIsolation(paths, forbidden, 'win32'), ...iso.devRootOverrideViolations(paths, 'win32')];
    if (v.length) throw new Error(`sandbox overlaps a live path:\n  ${v.join('\n  ')}`);
    for (const [name, bad] of [['live pipe', livePipe], ['MunderDevData pipe', fixedPipe]]) {
      if (paths.pipeName.toLowerCase() === bad.toLowerCase()) throw new Error(`the sandbox pipe equals the ${name}`);
    }
    for (const [name, p] of [['userData', paths.userData], ['hive', paths.hiveRoot]]) {
      if (norm(p) === norm(liveUserData) || norm(p) === norm(LIVE.hive) || inside(p, LIVE.devData)) throw new Error(`sandbox ${name} is a live path`);
    }
    // R10: the Codex login source honours $CODEX_HOME and refuses one inside a live hive.
    if (!this.args.dryRun) realCredentialPaths();
    this.check(true, 'preflight: the sandbox root passes the product isolation guard; its pipe is neither the live nor the MunderDevData pipe', `${r.root} / ${paths.pipeName}`);
    this.liveUserData = liveUserData;
    return { iso, liveUserData, livePipe, fixedPipe };
  }

  /** Global wall clock (R5): build included, under the heavy-job lock's TTL. */
  globalLeft() { return this.runStart + GLOBAL_WALL_MS - Date.now(); }

  // ── build ─────────────────────────────────────────────────────────────────
  /** Every layer-b SEAM commit on this branch, oldest first (they are cherry-picked onto 1.1.74). */
  seamCommits() {
    const r = spawnSync('git', ['log', '--reverse', '--format=%H', '-E', '--grep=^ZT-I1-MAIL layer \\(b\\) (test infrastructure|seams)', `${V1174_SHA}..HEAD`], { cwd: REPO, encoding: 'utf8', windowsHide: true });
    const shas = (r.stdout || '').trim().split('\n').filter((x) => /^[0-9a-f]{40}$/.test(x));
    if (!shas.length) throw new Error('cannot find the layer-b seam commits (subjects "ZT-I1-MAIL layer (b) test infrastructure" / "... seams")');
    return shas;
  }

  /** The run's own build caches (R6): winCodeSign copied READ-ONLY from the user's cache so no
   *  download is needed; electron-builder, electron and npm then write only here. */
  seedBuildCache() {
    const cache = path.join(this.s.base, 'build-cache');
    W.mkdir(path.join(cache, 'electron-builder'));
    const userCache = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache', 'winCodeSign');
    if (fs.existsSync(userCache)) W.copyTree(userCache, path.join(cache, 'electron-builder', 'winCodeSign'));
    return cache;
  }

  build() {
    const npm = 'npm.cmd';
    const deadline = Math.min(Date.now() + BUILD_WALL_MS, this.runStart + GLOBAL_WALL_MS);
    const cache = this.seedBuildCache();
    const env = buildEnv(cache);
    const electronDist = (dir) => `-c.electronDist=${path.join(dir, 'node_modules', 'electron', 'dist')}`;
    W.allowRoot(path.join(REPO, 'dist'));
    if (!this.args.skipBuild) {
      this.builtOut = true;
      run(npm, ['run', 'build'], REPO, 'build 1.1.75 (this tree, with the layer-b seams)', { env, deadline });
      run(path.join(REPO, 'node_modules', '.bin', 'electron-builder.cmd'), ['--win', '--dir', '--publish', 'never', '-c.npmRebuild=false', electronDist(REPO)], REPO, 'package 1.1.75 (--dir)', { env, deadline });
    }
    this.exe175 = path.join(REPO, 'dist', 'win-unpacked', 'Munder Difflin.exe');
    if (!fs.existsSync(this.exe175)) throw new Error(`${this.exe175} not found`);
    this.assertSeamsInAsar(path.join(REPO, 'dist', 'win-unpacked', 'resources', 'app.asar'), '1.1.75');

    if (!this.args.rollback) return;
    // 1.1.74 = b5e22e0b PLUS the seam commits cherry-picked as commits on the detached HEAD (without
    // the seams it would use the FIXED MunderDevData root and SHOW a window).
    const dir = this.args.v1174Dir || path.join(os.tmpdir(), 'md-layerb-v1174');
    W.allowRoot(dir);
    this.v1174Dir = dir;
    const git = (args, label) => run('git', args, dir, label, { env, deadline });
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      const seams = this.seamCommits();
      run('git', ['worktree', 'add', '--detach', dir, V1174_SHA], REPO, 'detached 1.1.74 worktree', { env, deadline });
      this.v1174Created = true;
      try {
        git(['-c', 'user.name=layer-b', '-c', 'user.email=layer-b@localhost', 'cherry-pick', ...seams], `cherry-pick the ${seams.length} seam commit(s) onto 1.1.74`);
      } catch (e) {
        spawnSync('git', ['cherry-pick', '--abort'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
        throw e;
      }
    }
    const log174 = spawnSync('git', ['log', '--format=%H', `${V1174_SHA}..HEAD`], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim().split('\n').filter(Boolean);
    const base = spawnSync('git', ['merge-base', '--is-ancestor', V1174_SHA, 'HEAD'], { cwd: dir, windowsHide: true }).status === 0;
    if (!base) throw new Error(`${dir} is not built on ${V1174_SHA}`);
    this.check(log174.length === this.seamCommits().length, '1.1.74 build = b5e22e0b + exactly the seam commits', `${log174.length} commit(s) on top`);
    if (!fs.existsSync(path.join(dir, 'node_modules', 'electron'))) {
      log('copying node_modules into the 1.1.74 worktree (a COPY, not a junction) …');
      W.copyTree(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    }
    const nm = fs.lstatSync(path.join(dir, 'node_modules'));
    if (nm.isSymbolicLink()) throw new Error('the 1.1.74 node_modules is a link; it must be a copy');
    if (!this.args.skipBuild || !fs.existsSync(path.join(dir, 'dist', 'win-unpacked', 'Munder Difflin.exe'))) {
      run(npm, ['run', 'build'], dir, 'build 1.1.74 + seams', { env, deadline });
      run(path.join(dir, 'node_modules', '.bin', 'electron-builder.cmd'), ['--win', '--dir', '--publish', 'never', '-c.npmRebuild=false', electronDist(dir)], dir, 'package 1.1.74 + seams (--dir)', { env, deadline });
    }
    this.exe174 = path.join(dir, 'dist', 'win-unpacked', 'Munder Difflin.exe');
    if (!fs.existsSync(this.exe174)) throw new Error(`${this.exe174} not found`);
    this.assertSeamsInAsar(path.join(dir, 'dist', 'win-unpacked', 'resources', 'app.asar'), '1.1.74+seams');
  }

  /** The end of the run (R6): out/ rebuilt WITHOUT the seams (so a test bundle can never be
   *  packaged by accident), then the 1.1.74 worktree removed: its node_modules COPY first, then
   *  out/ and dist/, then `git worktree remove` WITHOUT --force (a refusal is reported, not forced). */
  cleanupBuild() {
    const out = [];
    if (this.builtOut) {
      try {
        run('npm.cmd', ['run', 'build'], REPO, 'rebuild out/ WITHOUT the layer-b seams', { env: buildEnv(path.join(this.s.base, 'build-cache'), { seams: false }), deadline: Date.now() + 10 * 60_000 });
        out.push('out/ rebuilt without the seams');
      } catch (e) { out.push(`out/ rebuild FAILED: ${e.message}`); this.check(false, 'out/ rebuilt without the layer-b seams', e.message); }
    }
    if (this.v1174Dir && !this.args.keepV1174 && !this.args.v1174Dir && fs.existsSync(this.v1174Dir)) {
      const dir = this.v1174Dir;
      const nm = path.join(dir, 'node_modules');
      try {
        if (fs.existsSync(nm)) {
          if (fs.lstatSync(nm).isSymbolicLink()) throw new Error('node_modules is a link: refusing to remove through it');
          W.rm(nm);
        }
        for (const d of ['out', 'dist']) W.rm(path.join(dir, d));
        if (fs.existsSync(nm)) throw new Error('the node_modules copy is still there');
        const r = spawnSync('git', ['worktree', 'remove', dir], { cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
        out.push(r.status === 0 ? `removed the 1.1.74 worktree ${dir}` : `git worktree remove REFUSED (${(r.stderr || '').trim()}); left in place`);
        this.check(r.status === 0, 'the 1.1.74 worktree removed (node_modules copy first, no --force)', (r.stderr || '').trim());
      } catch (e) { out.push(`1.1.74 cleanup: ${e.message}`); this.check(false, 'the 1.1.74 worktree removed', e.message); }
    }
    return out;
  }

  /** Static: the packaged main bundle carries both seams, the build define is TRUE in it (else it
   *  would ignore MUNDER_HIDDEN and SHOW a window), and every gate is in place. */
  assertSeamsInAsar(asarPath, label) {
    const asar = require(path.join(REPO, 'node_modules', '@electron', 'asar'));
    let b = '';
    try { b = asar.extractFile(asarPath, path.join('out', 'main', 'index.js')).toString('utf8'); } finally { try { asar.uncache(asarPath); } catch { /* ok */ } }
    const m = /const LAYERB_SEAMS_BUILT = ([^;\n]+);/.exec(b);
    let built = null;
    try { built = m && /^[\w\s"'=!?:()]+$/.test(m[1]) ? Function(`"use strict"; return (${m[1]});`)() : null; } catch { built = null; }
    const ok = built === true && b.includes('process.env.MUNDER_DEV === "1"') && /function hiddenRun\([^)]*\)\s*\{\s*if \(!dev \|\| !seams\) return false;/.test(b)
      && /function surfaceWindow\([^)]*\) \{\s*if \(DEV_HIDDEN\) return;/.test(b) && /ready-to-show", \(\) => surfaceWindow\(win, \{ show: true \}\)\)/.test(b)
      && b.includes('function resolveDevDataRoot(');
    if (!this.check(ok, `static: the ${label} packaged bundle was built WITH the seams (LAYERB_SEAMS_BUILT=${built}) and gates them`, asarPath)) {
      throw new Error(`${label}: the packaged bundle lacks the hidden/root seams — refusing to launch it (it would show a window or use MunderDevData)`);
    }
  }

  // ── sandbox + env ─────────────────────────────────────────────────────────
  appEnv(liveUserData) {
    const s = this.s;
    const env = isolation.rigEnv(s.jail, process.env);
    const nodeDir = env.RIG_NODE_DIR;
    const extra = [];
    const pp = parentPath();
    this.cliPaths = { claude: whichOn(pp, 'claude'), codex: whichOn(pp, 'codex') };
    if (!this.args.dryRun) {
      for (const name of ['claude', 'codex']) {
        const p = this.cliPaths[name];
        if (!p) throw new Error(`the real ${name} CLI is not on PATH`);
        const d = path.dirname(p);
        if (!extra.some((x) => norm(x) === norm(d))) extra.push(d);
      }
      if (this.args.gitPath) {
        const git = whichOn(pp, 'git');
        if (git) extra.push(path.dirname(git));
      }
    }
    env.PATH = [...extra, nodeDir, ...isolation.systemDirs(process.env)].join(path.delimiter);
    Object.assign(env, { MUNDER_DEV: '1', MUNDER_HIDDEN: '1', MUNDER_DEV_ROOT: s.devRoot, ELECTRON_ENABLE_LOGGING: '1' });

    // (1) The rig's own guard on everything but the allowed CLI dirs.
    const probe = { ...env, PATH: [nodeDir, ...isolation.systemDirs(process.env)].join(path.delimiter) };
    isolation.checkIsolation(probe, s.base, { who: 'layer-b app env' });
    // (2) The CLI dirs may resolve claude/codex and NO other provider CLI.
    const exts = ['', '.exe', '.cmd', '.bat', '.ps1'];
    for (const d of extra) {
      for (const name of isolation.PROVIDER_COMMANDS.filter((n) => n !== 'claude' && n !== 'codex')) {
        for (const e of exts) if (fs.existsSync(path.join(d, name + e))) throw new Error(`PATH dir ${d} also holds the ${name} CLI`);
      }
    }
    // (3) No value names a live location or the real profile's provider homes.
    const bad = [...liveForbidden(), liveUserData].map((p) => p.toLowerCase());
    for (const [k, v] of Object.entries(env)) {
      const lv = String(v).toLowerCase();
      for (const b of bad) if (lv.includes(b)) throw new Error(`env ${k} names a live path (${b})`);
    }
    this.check(true, 'the app env is the rig allowlist: jailed homes, no secret-shaped variable, PATH = CLI dir(s) + node + system', env.PATH);
    this.env = env;
    this.node = path.join(nodeDir, path.basename(process.execPath));
    return env;
  }

  /** The jailed Claude settings: first-run keys + deny rules + the PreToolUse jail hook (R1). */
  writeClaudeSettings(extraEnv) {
    const s = this.s;
    const home = os.homedir();
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const liveDenied = [LIVE.dunder, path.join(home, '.claude'), path.join(home, '.codex'), path.join(home, '.claude.json'), path.join(home, '.gemini'), path.join(appData, 'munder-difflin'), REPO];
    W.writeJson(path.join(s.home, '.claude', 'settings.json'), claudeJailSettings({ node: this.node, policyFile: this.jailPolicy, liveDenied, env: extraEnv }));
  }

  seed() {
    const s = this.s;
    const dry = this.args.dryRun;
    for (const d of [s.hive, s.userData, s.work, s.stubs, s.home, s.report]) W.mkdir(d);
    this.markerV1 = `Marker-V1-${hex(3)}`;
    this.markerV2 = `Marker-V2-${hex(3)}`;
    const agents = {};
    const restorable = [];
    const node = this.node;
    this.typed = {};
    const spec = [
      { id: IDS.god, name: 'Michael', provider: 'claude', isGod: true, role: 'orchestrator', stub: true },
      { id: IDS.claude, name: this.markerV1, provider: 'claude', isGod: false, role: 'worker', stub: dry },
      { id: IDS.codex, name: 'Codex-LB', provider: 'codex', isGod: false, role: 'worker', stub: dry }
    ];
    for (const a of spec) {
      const dir = path.join(s.hive, 'agents', a.id);
      for (const sub of ['inbox', path.join('inbox', '.done'), 'outbox', path.join('outbox', '.sent')]) W.mkdir(path.join(dir, sub));
      W.write(path.join(dir, 'memory.md'), `# ${a.id}\n`);
      W.write(path.join(dir, 'identity.md'), `# ${a.id}\n`);
      const cwd = a.stub && a.isGod ? dir : path.join(s.work, a.id);
      W.mkdir(cwd);
      let command;
      if (a.stub) {
        this.typed[a.id] = path.join(s.stubs, `typed-${a.id}.log`);
        W.write(this.typed[a.id], '');
        const stub = path.join(s.stubs, `${a.id}.cjs`);
        W.write(stub, stubSource(a.id, s.pipe, this.typed[a.id], dir, 600));
        command = `${JSON.stringify(node)} ${JSON.stringify(stub)}`;
      } else if (a.provider === 'claude') {
        // UNCHANGED from the product's own auto mode; the jail is the hook + deny rules (R1).
        command = `claude --model ${this.args.models.claude} --permission-mode bypassPermissions`;
      } else {
        // R1: the product's auto flag (--dangerously-bypass-approvals-and-sandbox) is REPLACED by
        // the OS sandbox; the writable roots come from the seeded config.toml below.
        command = `codex --model ${this.args.models.codex} --sandbox workspace-write --ask-for-approval never`;
      }
      a.cwd = cwd; a.command = command; a.dir = dir;
      agents[a.id] = { id: a.id, name: a.name, provider: a.provider, cwd, isGod: a.isGod, role: a.role, capabilities: [],
        status: 'idle', cwdValid: true, archived: false, lastSeen: Date.now(), command };
      restorable.push({ id: a.id, name: a.name, character: 'jim', accent: 'sky', description: 'layer-b', project: 'layer-b',
        tmuxTarget: '', cwd, status: 'idle', action: 'reconnecting…', progress: 0, ptyId: `pty-${a.id}`, command,
        provider: a.provider, role: a.role, isGod: a.isGod, currentStation: 'desk', archived: false });
    }
    this.spec = spec;
    W.writeJson(path.join(s.hive, 'registry.json'), { godId: IDS.god, agents });
    this.restorableSeed = restorable;
    this.writeRoster((r) => r);
    // The sandbox's own guardrails ON: breaker with hard stop, floor + per-agent token caps.
    W.writeJson(path.join(s.userData, 'config.json'), {
      harnessHome: s.devRoot,
      onboardingComplete: true,
      orchestratorMaySpawn: false,
      autoDeliveryPausedAgents: [],
      heartbeatSeeded: true,
      compactMaintenanceSeeded: true,
      notifications: false,
      telemetryEnabled: false,
      costCapTokens: CAPS.totalTokens,
      agentTokenCaps: { [IDS.claude]: CAPS.perAgentTokens, [IDS.codex]: CAPS.perAgentTokens },
      circuitBreaker: { enabled: true, hardStop: true },
      missions: [{ id: 'heartbeat', kind: 'heartbeat', enabled: true, intervalMs: 120000, quietThresholdMs: 300000, lastFiredAt: 0 }]
    });
    // R1 Claude jail: the policy lives at the sandbox root (readable, never writable by the agent).
    const claude = spec.find((a) => a.id === IDS.claude);
    const codex = spec.find((a) => a.id === IDS.codex);
    this.jailPolicy = path.join(s.base, 'layer-b-jail-policy.json');
    this.jailLog = path.join(s.base, 'jail-decisions.jsonl');
    W.writeJson(this.jailPolicy, { writeRoots: [claude.cwd, claude.dir], readRoots: [s.base], protect: JAIL_PROTECT, home: s.home, log: this.jailLog });
    this.writeClaudeSettings(null);
    W.writeJson(path.join(s.home, '.claude.json'), {
      hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true,
      projects: { [claude.cwd]: { hasTrustDialogAccepted: true }, [claude.cwd.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } }
    });
    // R1 Codex jail: the seed config the product copies into the agent's own CODEX_HOME.
    this.codexRoots = [codex.cwd, codex.dir];
    W.write(path.join(s.home, '.codex', 'config.toml'), codexSandboxToml(this.codexRoots));
    // Bulk files for the compaction facts (B3 Claude, B7 Codex).
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ');
    const bulk = (n, tag) => { const out = []; for (let i = 1; i <= n; i++) out.push(`line ${String(i).padStart(4, '0')} ${Array.from({ length: 18 }, () => words[crypto.randomInt(words.length)]).join(' ')}`); out.push(`END-${tag}`); return out.join('\n'); };
    this.bulkEnd = { claude: `END-${hex(4)}`, codex: `END-${hex(4)}` };
    W.write(path.join(claude.cwd, 'b3-bulk.txt'), bulk(1500, this.bulkEnd.claude.slice(4)));
    W.write(path.join(codex.cwd, 'b7-bulk.txt'), bulk(1600, this.bulkEnd.codex.slice(4)));
  }

  /** The spawn recipe the renderer restores from. REBUILT from the seed every time (the file roster
   *  wins over localStorage when it is non-empty, and a run may have moved agents out of
   *  `restorable`), so each launch restores exactly these three agents, Claude's panel selected. */
  writeRoster(map) {
    const restorable = this.restorableSeed.map((r) => map({ ...r }));
    W.writeJson(this.s.roster, { version: 1, savedAt: Date.now(), agents: [], archived: [], restorable, queues: {}, selectedId: IDS.claude });
    W.rm(path.join(this.s.userData, 'Local Storage'));
  }

  /** Real mode: copy the two logins. Dry run: the SAME code path against decoy "real" files. */
  installCredentials() {
    const s = this.s;
    let real = this.args.dryRun ? null : realCredentialPaths();
    if (this.args.dryRun) {
      const decoy = path.join(s.base, 'decoy-real');
      W.write(path.join(decoy, '.claude', '.credentials.json'), JSON.stringify({ decoy: hex(8) }));
      W.write(path.join(decoy, '.codex', 'auth.json'), JSON.stringify({ decoy: hex(8) }));
      real = { claude: path.join(decoy, '.claude', '.credentials.json'), codex: path.join(decoy, '.codex', 'auth.json') };
    }
    this.creds.copy('claude', real.claude, path.join(s.home, '.claude', '.credentials.json'));
    // Under MUNDER_DEV the product never seeds a Codex agent from ~/.codex (F1), so the login goes
    // where the agent's CODEX_HOME points: <hive>/agents/<id>/.codex/auth.json (a regular file,
    // which migrateCodexAuthLink preserves).
    this.creds.copy('codex', real.codex, path.join(s.hive, 'agents', IDS.codex, '.codex', 'auth.json'));
    this.check(true, `credentials: ${this.args.dryRun ? 'DECOY ' : ''}logins copied read-only into the jail (claude, codex); nothing else copied`);
  }

  // ── zero-token confinement proofs (R1, god c0a73f (a)(b)) ─────────────────
  /** (a) The INSTALLED Claude hook, run exactly as settings.json names it, denies payloads that
   *  target the live hive and the real ~/.claude, and allows the agent's own outbox. */
  proveClaudeJail() {
    const st = readJson(path.join(this.s.home, '.claude', 'settings.json'), {});
    const hook = st.hooks && st.hooks.PreToolUse && st.hooks.PreToolUse[0] && st.hooks.PreToolUse[0].hooks[0];
    const m = hook && /^"([^"]+)" "([^"]+)" "([^"]+)"$/.exec(hook.command);
    if (!m) return this.check(false, 'R1 Claude jail: the installed hook command is readable', hook ? hook.command : 'no hook');
    const claude = this.spec.find((a) => a.id === IDS.claude);
    const home = os.homedir();
    const cases = [
      ['deny', { tool_name: 'Write', tool_input: { file_path: 'C:\\Dunder\\hive\\agents\\god\\inbox\\md-layerb-jail-proof.json', content: 'x' } }],
      ['deny', { tool_name: 'Edit', tool_input: { file_path: path.join(home, '.claude', 'settings.json'), old_string: 'a', new_string: 'b' } }],
      ['deny', { tool_name: 'Read', tool_input: { file_path: path.join(home, '.claude', '.credentials.json') } }],
      ['deny', { tool_name: 'Bash', tool_input: { command: 'echo x > C:\\Dunder\\hive\\md-layerb-jail-proof.txt' } }],
      ['deny', { tool_name: 'Bash', tool_input: { command: `echo x > "${path.join(home, '.codex', 'md-layerb-jail-proof.txt')}"` } }],
      ['allow', { tool_name: 'Write', tool_input: { file_path: path.join(claude.dir, 'outbox', 'proof.json'), content: '{}' } }]
    ];
    const results = cases.map(([want, p]) => {
      const r = spawnSync(m[1], [m[2], m[3]], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: claude.cwd, ...p }), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      const got = r.status === 2 ? 'deny' : (r.status === 0 ? 'allow' : `exit ${r.status}`);
      return { want, got, tool: p.tool_name, target: p.tool_input.file_path || p.tool_input.command };
    });
    const ok = results.every((x) => x.want === x.got) && (st.permissions && st.permissions.deny || []).some((d) => /^Write\(\/\/c\/Dunder\/\*\*\)$/i.test(d));
    this.proofs = { ...(this.proofs || {}), claudeJail: results };
    return this.check(ok, 'R1 Claude jail (zero tokens): the installed PreToolUse hook denies the live hive and the real ~/.claude/.codex, allows the own outbox; deny rules present', JSON.stringify(results));
  }

  /** (b) The real codex binary's own sandbox runner (`codex sandbox windows`, zero tokens) runs a
   *  probe under the jail's config: writes into C:\Dunder\hive, the real ~/.codex and ~/.claude must
   *  be REFUSED and the markers must never appear; a write inside the jail must succeed. */
  proveCodexSandbox() {
    const shim = this.cliPaths && this.cliPaths.codex;
    const exe = shim ? codexExe(shim) : null;
    if (!exe) return this.check(false, 'R1 Codex sandbox probe: the codex.exe sandbox runner was found', shim || 'codex not on PATH');
    const s = this.s;
    const home = os.homedir();
    const marker = `md-layerb-probe-${hex(8)}.txt`;
    const targets = { hive: path.join(LIVE.hive, marker), codex: path.join(home, '.codex', marker), claude: path.join(home, '.claude', marker) };
    const codex = this.spec.find((a) => a.id === IDS.codex);
    const insideMarker = path.join(codex.cwd, marker);
    const probeHome = path.join(s.jail, 'probe-codex-home');
    W.write(path.join(probeHome, 'config.toml'), codexSandboxToml(this.codexRoots));
    const script = path.join(s.base, 'codex-sandbox-probe.cjs');
    W.write(script, `const fs = require('fs'); const out = {};
for (const [k, p] of Object.entries(${JSON.stringify({ inside: insideMarker, ...targets })})) { try { fs.writeFileSync(p, 'layer-b probe'); out[k] = 'WROTE'; } catch (e) { out[k] = 'refused: ' + e.code; } }
process.stdout.write('LBPROBE' + JSON.stringify(out));`);
    const env = { ...this.env, CODEX_HOME: probeHome };
    const before = Object.fromEntries(Object.entries(targets).map(([k, p]) => [k, fs.existsSync(p)]));
    const r = spawnSync(exe, ['sandbox', 'windows', '--', this.node, script], { cwd: codex.cwd, env, encoding: 'utf8', windowsHide: true, timeout: 90_000 });
    const res = (() => { const i = (r.stdout || '').indexOf('LBPROBE'); try { return i >= 0 ? JSON.parse(r.stdout.slice(i + 7)) : null; } catch { return null; } })();
    const leaked = [];
    for (const [k, p] of Object.entries(targets)) {
      if (!before[k] && fs.existsSync(p)) { leaked.push(k); try { W.removeProbeMarker(p, marker); } catch (e) { log(`probe marker removal: ${e.message}`); } }
    }
    const positive = !!res && res.inside === 'WROTE';
    this.proofs = { ...(this.proofs || {}), codexSandbox: { exe, status: r.status, res, leaked, stderr: String(r.stderr || '').slice(0, 600) } };
    if (leaked.length) return this.check(false, 'R1 Codex sandbox probe: NO marker reached a live location', `LEAKED into ${leaked.join(', ')} (removed); ${JSON.stringify(res)}`);
    return this.check(positive && Object.keys(targets).every((k) => res && res[k] && res[k] !== 'WROTE'),
      'R1 Codex sandbox (zero tokens, codex sandbox windows): writes to C:\\Dunder\\hive, the real ~/.codex and ~/.claude refused; the jail write succeeded; no marker appeared',
      JSON.stringify({ res, status: r.status, stderr: String(r.stderr || '').slice(0, 300) }));
  }

  // ── launch / hidden ───────────────────────────────────────────────────────
  async launch(exe, label) {
    const cdpPort = await freePort();
    let inspPort = await freePort();
    while (inspPort === cdpPort) inspPort = await freePort();
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', `--inspect=127.0.0.1:${inspPort}`], {
      cwd: this.s.base, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    this.procs.addRoot(proc.pid, proc);
    // R8: the window watch starts NOW, before CDP exists.
    this.watch = new WindowWatch(proc.pid, {
      onHit: (why) => { this.check(false, `NO WINDOW (${label})`, why); this.stop(`a window/browser/crash dialog appeared (${label}): ${why}`); },
      onBlind: (why) => { if (!this.aborted()) { this.check(false, `the window watch sees (${label})`, why); this.stop(`the window watch went blind (${label}): ${why}`); } }
    }).start();
    proc.stdout.on('data', (d) => { this.appOut += d; });
    proc.stderr.on('data', (d) => { this.appOut += d; });
    proc.on('exit', (code) => log(`${label} exited (${code})`));
    this.app = { proc, cdpPort, inspPort, label, exe };
    log(`${label}: launched pid ${proc.pid} (CDP 127.0.0.1:${cdpPort}, main inspector 127.0.0.1:${inspPort}; both UNAUTHENTICATED while the app runs)`);
    await this.waitFor(`the window watch reports (${label})`, 30_000, () => this.watch.lines > 0, 500);
    // Refused at bootstrap? The app exits 97 at once.
    await sleep(3000);
    if (proc.exitCode !== null) throw new Error(`${label} exited at boot (${proc.exitCode}): ${this.appOut.slice(-1500)}`);
    this.mainCdp = await new Cdp(await Cdp.target(inspPort, (t) => t.type === 'node', 60_000, this.abort.signal)).open();
    this.page = await new Cdp(await Cdp.target(cdpPort, (t) => t.type === 'page', 90_000, this.abort.signal)).open();
    await this.assertHidden(`${label} at launch`);
    // The app's own view of where it runs.
    const where = await this.mainCdp.eval(`(() => { const e = process.mainModule.require('electron'); return JSON.stringify({ userData: e.app.getPath('userData'), packaged: e.app.isPackaged, appPath: e.app.getAppPath() }); })()`);
    const w = JSON.parse(where);
    this.check(norm(w.userData) === norm(this.s.userData), `${label}: userData is the sandbox's`, w.userData);
    this.check(w.packaged === true && /app\.asar$/i.test(w.appPath), `${label}: runs PACKAGED from app.asar`, w.appPath);
    if (norm(w.userData) !== norm(this.s.userData)) throw new Error(`${label}: userData ${w.userData} is not the sandbox's`);
    // R10: the pipe line MUST be there and must be the sandbox's.
    const pipeLine = /pipe=(\S+)/.exec(this.appOut);
    if (!this.check(!!pipeLine && pipeLine[1].toLowerCase() === this.s.pipe.toLowerCase(), `${label}: the hook pipe is the sandbox's`, pipeLine ? pipeLine[1] : 'NO pipe= line printed')) {
      throw new Error(`${label}: cannot prove the hook pipe`);
    }
    return this.app;
  }

  /** BrowserWindow.isVisible() over the MAIN inspector, plus the OS watcher's health. */
  async assertHidden(label) {
    if (this.watch && !this.watch.healthy()) { this.stop(`the window watch is silent (${label})`); throw new Error('window watch silent'); }
    if (!this.mainCdp) return 0;
    const wins = JSON.parse(await this.mainCdp.eval(`JSON.stringify(process.mainModule.require('electron').BrowserWindow.getAllWindows().map((w) => ({ id: w.id, visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() })))`));
    this.samples.hidden.push({ at: new Date().toISOString(), label, windows: wins, watchLines: this.watch ? this.watch.lines : 0 });
    const shown = wins.filter((w) => w.visible || w.focused);
    if (shown.length) {
      this.check(false, `NO WINDOW (${label})`, JSON.stringify({ shown }));
      this.stop(`a window became visible (${label})`);
      throw new Error('window visible');
    }
    return wins.length;
  }

  startMonitors() {
    const every = (ms, fn) => {
      let running = false;
      const t = setInterval(async () => {
        if (running || this.aborted()) return;
        running = true;
        try { await fn(); } catch (e) { if (!this.aborted()) log(`monitor: ${e.message}`); } finally { running = false; }
      }, ms);
      this.bg.push(t);
    };
    every(8_000, async () => this.assertHidden('monitor'));
    every(5_000, async () => this.pollTokens());
    every(1_000, async () => this.pollLedgers());
    every(15_000, async () => {
      if (Date.now() - this.startedAt > CAPS.wallMs) this.stop('wall-clock cap (30 min)');
      if (this.globalLeft() <= 0) this.stop(`global wall-clock cap (${GLOBAL_WALL_MS / 60000} min, build included)`);
      const stops = this.rows().filter((r) => /breaker/i.test(String(r.kind)) && /stop/i.test(JSON.stringify(r)));
      if (stops.length && !this.breakerStop) { this.breakerStop = stops[0]; log(`breaker stop seen: ${JSON.stringify(stops[0]).slice(0, 200)}`); }
    });
  }

  // ── sandbox reads ─────────────────────────────────────────────────────────
  rows() { return walk(this.s.hive, (p) => /[\\/]log[^\\/]*\.jsonl$/.test(p) && path.dirname(p) === this.s.hive).flatMap(jsonLines); }
  ledger(agentId) { return readJson(path.join(this.s.hive, 'state', 'mail', `${agentId}.json`), { entries: {} }); }
  entry(agentId, id) { return (this.ledger(agentId).entries || {})[id] || null; }
  pollLedgers() {
    for (const a of [IDS.claude, IDS.codex]) {
      const h = (this.ledgerHistory[a] = this.ledgerHistory[a] || {});
      for (const e of Object.values(this.ledger(a).entries || {})) {
        const arr = (h[e.id] = h[e.id] || []);
        const last = arr[arr.length - 1];
        const cur = { state: e.state, hookKind: e.hookKind ?? null, surfaceCount: e.surfaceCount ?? 0, epoch: e.epoch ?? null };
        if (!last || JSON.stringify({ ...last, t: undefined }) !== JSON.stringify({ ...cur, t: undefined })) arr.push({ t: Date.now(), ...cur });
      }
    }
  }
  seenHookKinds(agentId, id) { return [...new Set(((this.ledgerHistory[agentId] || {})[id] || []).map((x) => x.hookKind).filter(Boolean))]; }

  /** Send as god: through god's OUTBOX, so the real router and deliver() edge run. */
  send(to, tag, body) {
    const id = `lb-${tag.toLowerCase()}-${hex(3)}`;
    for (const n of String(body).match(/LB[NT]-[0-9a-f]{8}/g) || []) if (!this.nonces.includes(n)) this.nonces.push(n);
    W.writeJsonAtomic(path.join(this.s.hive, 'agents', IDS.god, 'outbox', `${id}.json`), {
      id, conversation: `layer-b-${tag.toLowerCase()}`, to, act: 'request', subject: `layer-b ${tag}`, body,
      requires_reply: false, needs_human: false, created_at: new Date().toISOString()
    });
    return id;
  }
  /** Every message god received (inbox + .done) from `from`. */
  godMail(from) {
    const dir = path.join(this.s.hive, 'agents', IDS.god, 'inbox');
    return [...walk(dir, (p) => p.endsWith('.json'))].map((p) => ({ p, m: readJson(p) })).filter((x) => x.m && x.m.from === from);
  }
  async waitReply(from, token, budgetMs) {
    return this.waitFor(`a reply from ${from} carrying ${token}`, budgetMs,
      () => this.godMail(from).find((x) => `${x.m.subject || ''}\n${x.m.body || ''}`.includes(token)) || null, 2000);
  }
  async waitState(agentId, id, states, budgetMs) {
    return this.waitFor(`${id} to reach ${states.join('/')}`, budgetMs, () => { const e = this.entry(agentId, id); return e && states.includes(e.state) ? e : null; }, 1000);
  }

  // ── transcripts / tokens ──────────────────────────────────────────────────
  claudeTranscripts() { return walk(path.join(this.s.home, '.claude', 'projects'), (p) => p.endsWith('.jsonl')); }
  codexRollouts() { return walk(path.join(this.s.hive, 'agents', IDS.codex, '.codex', 'sessions'), (p) => /rollout-.*\.jsonl$/.test(p)); }
  claudeEvents() { return this.claudeTranscripts().flatMap(jsonLines); }
  codexEvents() { return this.codexRollouts().flatMap(jsonLines); }

  pollTokens() {
    // (a) The sandbox cost ledger: per (agent, session) the largest cumulative sample.
    const ledgerRows = walk(this.s.hive, (p) => /cost-ledger[^\\/]*\.jsonl$/.test(p)).flatMap(jsonLines);
    const perSession = {};
    for (const r of ledgerRows) {
      const k = `${r.agent_id}\u0000${r.session_id}`;
      const t = (r.input || 0) + (r.output || 0) + (r.cache_read || 0) + (r.cache_creation || 0);
      if (!perSession[k] || t > perSession[k].t) perSession[k] = { agent: r.agent_id, t, usd: r.usd || 0 };
    }
    const ledger = {};
    for (const v of Object.values(perSession)) { ledger[v.agent] = ledger[v.agent] || { tokens: 0, usd: 0 }; ledger[v.agent].tokens += v.t; ledger[v.agent].usd += v.usd; }
    // (b) Claude's own transcripts: every assistant message's usage, once per message id.
    const seen = new Set();
    let claudeT = 0;
    for (const e of this.claudeEvents()) {
      const u = e && e.message && e.message.usage;
      if (!u) continue;
      const k = e.message.id || e.uuid;
      if (seen.has(k)) continue;
      seen.add(k);
      claudeT += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    // (c) Codex rollouts: the last total_token_usage per rollout (input includes cached input).
    let codexT = 0;
    for (const f of this.codexRollouts()) {
      let last = 0;
      for (const e of jsonLines(f)) {
        const info = e && e.payload && e.payload.type === 'token_count' && e.payload.info;
        const tot = info && info.total_token_usage;
        if (tot) last = Math.max(last, tot.total_tokens || ((tot.input_tokens || 0) + (tot.output_tokens || 0)));
      }
      codexT += last;
    }
    const used = (a, own) => Math.max(own, (ledger[a] || {}).tokens || 0);
    this.tokens = {
      [IDS.claude]: { ledger: (ledger[IDS.claude] || {}).tokens || 0, transcript: claudeT, used: used(IDS.claude, claudeT), usd: (ledger[IDS.claude] || {}).usd || 0 },
      [IDS.codex]: { ledger: (ledger[IDS.codex] || {}).tokens || 0, rollout: codexT, used: used(IDS.codex, codexT), usd: (ledger[IDS.codex] || {}).usd || 0 },
      [IDS.god]: { ledger: (ledger[IDS.god] || {}).tokens || 0, used: (ledger[IDS.god] || {}).tokens || 0, usd: (ledger[IDS.god] || {}).usd || 0 }
    };
    const total = Object.values(this.tokens).reduce((n, t) => n + t.used, 0);
    this.tokens.total = total;
    for (const a of [IDS.claude, IDS.codex]) if (this.tokens[a].used > CAPS.perAgentTokens) this.stop(`per-agent token cap: ${a} at ${this.tokens[a].used}`);
    if (total > CAPS.totalTokens) this.stop(`total token cap at ${total}`);
  }
  fits(agentId, fact) {
    this.pollTokens();
    const est = FACT_EST[fact] || 50_000;
    return this.tokens[agentId].used + est <= CAPS.perAgentTokens && this.tokens.total + est <= CAPS.totalTokens
      && Date.now() - this.startedAt < CAPS.wallMs - 60_000;
  }

  /** Tool calls that name an inbox path, from `sinceMs`, in the agent's transcript/rollout. */
  inboxToolCalls(agentId, sinceMs) {
    const hits = [];
    const touches = (s) => /[\\/]inbox([\\/]|\b)/i.test(s) || /\binbox\b/i.test(s.replace(/outbox/gi, ''));
    if (agentId === IDS.claude) {
      for (const e of this.claudeEvents()) {
        if (!e.timestamp || Date.parse(e.timestamp) < sinceMs) continue;
        for (const c of (e.message && Array.isArray(e.message.content) ? e.message.content : [])) {
          if (c.type === 'tool_use' && touches(JSON.stringify(c.input || {})) && !/outbox/i.test(JSON.stringify(c.input || {}))) hits.push(`${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
        }
      }
    } else {
      for (const e of this.codexEvents()) {
        if (!e.timestamp || Date.parse(e.timestamp) < sinceMs) continue;
        const p = e.payload || {};
        if (/function_call|local_shell_call|custom_tool_call/.test(String(p.type)) && touches(JSON.stringify(p.arguments || p.action || p.input || '')) && !/outbox/i.test(JSON.stringify(p))) {
          hits.push(`${p.name || p.type} ${JSON.stringify(p.arguments || p.action || p.input).slice(0, 160)}`);
        }
      }
    }
    return hits;
  }

  // ── renderer (CDP) ────────────────────────────────────────────────────────
  async openTheConfig() {
    await this.waitFor('the config chooser to accept an open', 90_000, async () => {
      const v = await this.page.eval(`(() => { const b = [...document.querySelectorAll('button,[role=button]')].find(x => (x.textContent||'').trim().toLowerCase() === 'open'); if (!b) return 'no-button'; b.click(); return 'clicked'; })()`);
      return v === 'clicked';
    });
  }
  async ptys() { return this.page.eval('window.cth.listPtys()'); }
  async waitAgentsUp(label) {
    const want = this.spec.map((a) => `pty-${a.id}`);
    await this.waitFor(`${label}: every agent PTY up with output`, 180_000, async () => {
      const l = await this.ptys();
      return want.every((id) => (l || []).some((p) => p.id === id && p.hasOutput));
    }, 2000);
    for (const p of await this.ptys()) this.procs.known.has(p.pid) || log(`pty ${p.id} pid ${p.pid}`);
    await this.procs.scan();
  }
  async threadRows() {
    return this.page.eval(`(() => {
      const tab = document.querySelector('button[aria-label="messages"]');
      if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
      return [...document.querySelectorAll('span[title^="mail state:"]')].map((s) => {
        const row = s.parentElement && s.parentElement.parentElement;
        return { state: s.title.slice('mail state: '.length), label: s.textContent, text: (row && row.textContent || '').slice(0, 300) };
      });
    })()`);
  }
  async selectAgentPanel(agentId, name) {
    // The roster seeds selectedId; if the panel shows someone else, click the agent's name.
    await this.page.eval(`(() => { const want = ${JSON.stringify(name)}; const el = [...document.querySelectorAll('button,[role=button],div,span')].find(x => (x.textContent||'').trim() === want && x.offsetParent !== null); if (el) el.click(); return !!el; })()`);
    await sleep(800);
    await this.threadRows();
  }

  // ── the facts ─────────────────────────────────────────────────────────────
  /** Run one fact; an error that is not the run's abort marks its facts NOT-PROVEN (with the
   *  reason) instead of skipping the rest of the sequence. */
  async guard(ids, fn) {
    try { await fn(); } catch (e) {
      if (this.aborted()) throw e;
      for (const id of ids) if (!this.facts[id]) this.fact(id, this.unproven(id), `error: ${e && e.message}`);
    }
  }

  /** What an unproven fact is reported as: B7 is GATE-BLOCKED in a real run (§11.18 items 50-53). */
  unproven(id) { return id === 'B7' && !this.args.dryRun ? 'GATE-BLOCKED' : 'NOT-PROVEN'; }

  dryNote(plumbing) { return `dry-run stubs: not a proof of the real CLI; plumbing ${plumbing}`; }

  /** B9 + B1 + B8 (Claude): held delivered while delivery is paused (B9 samples), then woken:
   *  the <hive-mail> body reaches the model at UserPromptSubmit (B1); the Threads DOM keeps the row
   *  across Stop (B8). */
  async factB1B8B9() {
    const C = IDS.claude;
    const N1 = nonce();
    await this.page.eval(`window.cth.controlAutoDelivery(${JSON.stringify(C)}, true)`);
    const since = Date.now();
    const id = this.send(C, 'B1', `${N1}\n\nReply to god now with one hive message (act "inform") whose body is exactly this token: ${N1}\nDo not read, list or open any file for this. Do nothing else.`);
    await this.waitState(C, id, ['delivered'], 120_000);
    // B9: while the LEDGER says delivered, the renderer queue's precondition reader must say non-empty.
    await this.selectAgentPanel(C, this.markerV1);
    let violations = 0;
    for (let i = 0; i < 10; i++) {
      const before = this.entry(C, id);
      const pending = await this.page.eval(`window.cth.hiveMailPending(${JSON.stringify(C)})`);
      const after = this.entry(C, id);
      const held = before && after && before.state === 'delivered' && after.state === 'delivered';
      const ok = !held || (Array.isArray(pending) && pending.includes(id));
      if (!ok) violations++;
      this.samples.b9.push({ at: Date.now(), held, pending, ok });
      await sleep(2000);
    }
    const domBefore = (await this.threadRows()).filter((r) => r.text.includes(N1));
    await this.page.eval(`window.cth.controlAutoDelivery(${JSON.stringify(C)}, false)`);
    const heldSamples = this.samples.b9.filter((x) => x.held).length;
    let reply = null;
    try { reply = await this.waitReply(C, N1, 6 * 60_000); } catch (e) { log(`B1: ${e.message}`); }
    let acted = null;
    try { acted = await this.waitState(C, id, ['acted'], 3 * 60_000); } catch (e) { log(`B1: ${e.message}`); }
    await sleep(4000);   // the Threads panel polls every 3 s
    const domAfter = (await this.threadRows()).filter((r) => r.text.includes(N1));
    const b9ok = heldSamples >= 5 && violations === 0 && !!acted;
    this.fact('B9', b9ok ? 'PASS' : (heldSamples < 5 ? 'NOT-PROVEN' : 'FAIL'),
      `${heldSamples} samples with the ledger at delivered; ${violations} where hive:mailPending (the queue precondition's reader) lacked it; later acted: ${!!acted}`);
    const b8ok = domBefore.length >= 1 && domAfter.length >= domBefore.length && !!acted && domAfter.some((r) => /handled/.test(r.label));
    this.fact('B8', b8ok ? 'PASS' : (domBefore.length ? 'FAIL' : 'NOT-PROVEN'),
      `Threads DOM rows for the message: before Stop ${JSON.stringify(domBefore.map((r) => r.label))}, after Stop/acted ${JSON.stringify(domAfter.map((r) => r.label))}`);
    const kinds = this.seenHookKinds(C, id);
    const inboxCalls = this.inboxToolCalls(C, since);
    if (this.args.dryRun) return this.fact('B1', 'NOT-PROVEN', this.dryNote(`reply=${!!reply} acted=${!!acted} hookKinds=${kinds.join(',')}`));
    const b1ok = !!reply && kinds.includes('UserPromptSubmit') && inboxCalls.length === 0;
    this.fact('B1', b1ok ? 'PASS' : (reply ? 'FAIL' : 'NOT-PROVEN'),
      `reply quoting the nonce: ${!!reply}; surfaced via ${kinds.join(',') || 'none'}; inbox tool calls: ${inboxCalls.length ? inboxCalls.join(' | ') : 'none'}`,
      reply ? [reply.p] : []);
  }

  /** B2 (Claude): a nonce delivered MID-TURN reaches the model through PostToolUse. */
  async factB2() {
    const C = IDS.claude;
    const T = `LBT-${hex(4)}`;
    const N2 = nonce();
    const since = Date.now();
    const task = this.send(C, 'B2', `${T}\n\nRun these shell commands one per tool call, in order, waiting for each: \`sleep 8\`, \`sleep 8\`, \`sleep 8\`. After the third, reply to god with one hive message (act "inform") whose body is: ${T} followed by every token of the form LBN-xxxxxxxx that reached you in hive mail DURING this task, or NONE. Do not read, list or open any inbox file.`);
    await this.waitState(C, task, ['surfacing', 'surfaced', 'acted'], 5 * 60_000);
    // Mid-turn = after the first tool call of that turn (a stub has no transcript: plumbing only).
    if (this.args.dryRun) await sleep(2000);
    else await this.waitFor('the B2 turn\'s first tool call', 3 * 60_000, () => this.claudeEvents().some((e) => e.timestamp && Date.parse(e.timestamp) >= since
      && e.message && Array.isArray(e.message.content) && e.message.content.some((c) => c.type === 'tool_use')));
    const mid = this.send(C, 'B2MID', `${N2}\n\nMid-task mail for the running task ${T}: include this token in that task's reply. No separate reply.`);
    let reply = null;
    try { reply = await this.waitReply(C, T, 6 * 60_000); } catch (e) { log(`B2: ${e.message}`); }
    const kinds = this.seenHookKinds(C, mid);
    const inboxCalls = this.inboxToolCalls(C, since);
    const quoted = !!reply && `${reply.m.body}`.includes(N2);
    if (this.args.dryRun) return this.fact('B2', 'NOT-PROVEN', this.dryNote(`reply=${!!reply} hookKinds=${kinds.join(',')}`));
    const ok = quoted && kinds.includes('PostToolUse') && inboxCalls.length === 0;
    this.fact('B2', ok ? 'PASS' : (reply ? 'FAIL' : 'NOT-PROVEN'),
      `task reply: ${!!reply}; mid-turn nonce quoted: ${quoted}; the mid-turn mail surfaced via ${kinds.join(',') || 'none'}; inbox tool calls: ${inboxCalls.length ? inboxCalls.join(' | ') : 'none'}`,
      reply ? [reply.p] : []);
  }

  /** B5 + B6 (Codex). B5: Route A context reaches the model. B6 (§11.18 items 50-53, Creed on
   *  Q44): is the mail block RETAINED across turns? Three tiers, all reported; tier 1 decides.
   *   1. PRIMARY, token delta: turns 1-3 carry a ~2k-token padded block around a unique nonce.
   *      retained = in4 - in1 - growth - block4 + block1, where in_k is the input_tokens of turn k's
   *      FIRST request (rollout token_count), growth = the conversation's own growth between them
   *      (output tokens of every turn 1-3 request, exact; plus turn texts, tool calls and tool
   *      outputs persisted in turns 1-3 and turn 4's own prompt, ~4 chars/token, <hive-mail> text
   *      excluded), and block_k = turn k's mail block (~4 chars/token). Full retention gives the sum
   *      of blocks 1-3, none gives 0. >= 50% of that sum: FAIL; < 10%: PASS; between: NOT-PROVEN.
   *   2. SUPPORTING: persisted response_items carrying an earlier turn's nonce; after a compaction,
   *      the compacted item's replacement_history instead.
   *   3. TERTIARY: turn 4 asks for turn 1's nonce; the answer is recorded.
   *  A B6 FAIL is a DESIGN finding (the CODEX-BLOAT retention), not a runner bug. */
  async factB5B6() {
    const X = IDS.codex;
    const since = Date.now();
    const pad = (n) => { const w = 'the quick brown fox jumps over the lazy dog'.split(' '); const out = []; for (let i = 0; i < n; i++) out.push(w[i % w.length]); return out.join(' '); };
    // ~2k tokens: ~1,600 filler words (about 1.2 tokens per word here) split around the nonce.
    const padded = (N) => '\n Background (no action needed): ' + pad(800) + '\n\n' + N + '\n\n' + pad(800);
    const nonces = [];
    const replies = [];
    const blocks = [];
    const turnStart = [];
    for (let turn = 1; turn <= 4; turn++) {
      if (turn > 1 && !this.fits(X, 'B6')) { this.fact('B6', 'NOT-PROVEN', `budget/wall-clock: stopped before turn ${turn}`); break; }
      const N = nonce();
      nonces.push(N);
      const body = turn < 4
        ? `${N}\n\nReply to god now with one hive message (act "inform") whose body is exactly this token: ${N}\nDo not read, list or open any file for this.\n${padded(N)}`
        : `${N}\n\nWithout reading any file: what was the LBN- token in the FIRST hive mail you received in this conversation? Reply to god with one hive message (act "inform") whose body is: ${N} followed by that token, or ${N} UNKNOWN if you do not have it.`;
      blocks.push(body.length / 4);
      turnStart.push(Date.now());
      const id = this.send(X, turn === 1 ? 'B5' : `B6T${turn}`, body);
      let r = null;
      try { r = await this.waitReply(X, N, 6 * 60_000); } catch (e) { log(`B5/B6 turn ${turn}: ${e.message}`); }
      replies.push(r);
      try { await this.waitState(X, id, ['acted'], 3 * 60_000); } catch (e) { log(`B5/B6 turn ${turn}: ${e.message}`); }
      if (turn === 1) {
        const kinds = this.seenHookKinds(X, id);
        const inboxCalls = this.inboxToolCalls(X, since);
        if (this.args.dryRun) this.fact('B5', 'NOT-PROVEN', this.dryNote(`reply=${!!r} hookKinds=${kinds.join(',')}`));
        else this.fact('B5', r && kinds.includes('UserPromptSubmit') && !inboxCalls.length ? 'PASS' : (r ? 'FAIL' : 'NOT-PROVEN'),
          `reply quoting the nonce: ${!!r}; surfaced via ${kinds.join(',') || 'none'}; inbox tool calls: ${inboxCalls.length ? inboxCalls.join(' | ') : 'none'}`, r ? [r.p] : []);
      }
    }
    if (this.facts.B6) return;
    if (this.args.dryRun) return this.fact('B6', 'NOT-PROVEN', this.dryNote(`${replies.filter(Boolean).length}/4 replies`));
    const all4 = replies.length === 4 && replies.every(Boolean);
    const t = b6Tiers(this.codexEvents(), { turnStart, nonces, blocks });
    // Tier 3: the turn-4 answer.
    const r4 = replies[3] ? String(replies[3].m.body) : '';
    const recalled = !!r4 && r4.includes(nonces[0]);
    const tier3 = !replies[3] ? 'no turn-4 reply' : (recalled ? `recalled turn 1's nonce ${nonces[0]}` : `did not recall it (${JSON.stringify(r4.slice(0, 80))})`);
    const status = !all4 || t.verdict === null ? 'NOT-PROVEN' : t.verdict;
    this.fact('B6', status,
      `TIER 1 (decides): ${t.tier1}. TIER 2: ${t.tier2}. TIER 3: ${tier3}. 4 wakes replied: ${all4}.`
      + (status === 'FAIL' ? ' A FAIL is a DESIGN finding (mail blocks retained across Codex turns), not a runner bug.' : ''), this.codexRollouts());
  }

  /** Phase B: stop the app, change the Claude prompt marker (its agent name), relaunch with resume;
   *  lower the compaction thresholds for B3/B7. */
  async relaunchForPhaseB() {
    const s = this.s;
    const ctxClaude = (() => {
      let last = 0;
      for (const e of this.claudeEvents()) { const u = e.message && e.message.usage; if (u) last = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); }
      return last;
    })();
    this.sessionBefore = (readJson(path.join(s.hive, 'registry.json'), { agents: {} }).agents[IDS.claude] || {});
    await this.stopApp('phase A');
    const reg = readJson(path.join(s.hive, 'registry.json'));
    if (reg && reg.agents && reg.agents[IDS.claude]) reg.agents[IDS.claude].name = this.markerV2;
    if (reg && reg.agents && reg.agents[IDS.codex]) reg.agents[IDS.codex].codexAutoCompactTokenLimit = 40_000;   // B7 (the product's minimum)
    W.writeJson(path.join(s.hive, 'registry.json'), reg);
    this.writeRoster((r) => (r.id === IDS.claude ? { ...r, name: this.markerV2 } : r));
    // B3: auto-compaction ~25k tokens above the current context (percent of a 200k window).
    const pct = Math.min(95, Math.max(5, Math.ceil(((ctxClaude || 30_000) + 25_000) / 2000)));
    this.b3Pct = pct;
    this.writeClaudeSettings({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct) });   // the jail (deny rules + hook) stays
    log(`phase B: marker ${this.markerV1} -> ${this.markerV2}; Claude autocompact at ${pct}% (context was ${ctxClaude}); Codex compact limit 40000`);
    this.relaunchAt = Date.now();
    await this.launch(this.exe175, '1.1.75 (phase B)');
    await this.openTheConfig();
    await this.waitAgentsUp('phase B');
  }

  /** B4 (Claude): the RESUMED session sees the NEW --append-system-prompt. R7: only a genuine resume
   *  of the SAME session counts; a fresh session trivially sees the new marker, so without a proven
   *  resume B4 is NOT-PROVEN, never PASS. */
  async factB4() {
    const C = IDS.claude;
    const N4 = nonce();
    const id = this.send(C, 'B4', `${N4}\n\nWhat is your agent name exactly as your system prompt states it (the sentence that starts "You are")? Reply to god with one hive message (act "inform") whose body is: ${N4} followed by that name. Do not read any file.`);
    let reply = null;
    try { reply = await this.waitReply(C, N4, 6 * 60_000); } catch (e) { log(`B4: ${e.message}`); }
    try { await this.waitState(C, id, ['acted'], 2 * 60_000); } catch { /* reported below */ }
    const resume = this.resumeEvidence(C);
    const body = reply ? String(reply.m.body) : '';
    if (this.args.dryRun) return this.fact('B4', 'NOT-PROVEN', this.dryNote(`relaunch+rename ok, reply=${!!reply}, resume evidence ${resume.same}`));
    const v2 = body.includes(this.markerV2); const v1 = body.includes(this.markerV1);
    const status = !reply || !resume.same ? 'NOT-PROVEN' : (v2 && !v1 ? 'PASS' : 'FAIL');
    this.fact('B4', status,
      `resumed the SAME session: ${resume.same} (${resume.why}); reply: ${JSON.stringify(body.slice(0, 160))}; expected the NEW marker ${this.markerV2} (old ${this.markerV1})`
      + (resume.same && v1 && !v2 ? ' — the resumed session kept the OLD prompt: §7.1 step 3 then needs a rotation at upgrade (a design finding)' : '')
      + (!resume.same ? ' — no genuine resume proven, so the marker proves nothing' : ''), reply ? [reply.p] : []);
  }

  /** A genuine resume: the session id before the relaunch is the one Claude continued, i.e. the
   *  registry still holds it AND the transcript of that session id gained entries after the relaunch. */
  resumeEvidence(agentId) {
    const sid = this.sessionBefore && this.sessionBefore.sessionId;
    if (!sid) return { same: false, why: 'no session id was recorded before the relaunch' };
    const after = (readJson(path.join(this.s.hive, 'registry.json'), { agents: {} }).agents[agentId] || {});
    const sameId = after.sessionId === sid;
    const t = this.claudeTranscripts().filter((f) => path.basename(f, '.jsonl') === sid);
    const grew = t.some((f) => jsonLines(f).some((e) => e.timestamp && Date.parse(e.timestamp) > this.relaunchAt && (e.sessionId === sid || !e.sessionId)));
    return { same: sameId && grew, why: `registry session ${sameId ? 'unchanged' : `changed to ${after.sessionId}`}; transcript ${sid} ${grew ? 'continued after the relaunch' : 'did NOT continue'}` };
  }

  /** B3 (Claude): compaction inside the epoch re-injects the surfaced mail via SessionStart(compact). */
  async factB3() {
    const C = IDS.claude;
    const N3 = nonce();
    const bulkPath = path.join(this.spec.find((a) => a.id === C).cwd, 'b3-bulk.txt');
    const since = Date.now();
    const id = this.send(C, 'B3', `${N3}\n\nTask: read the file ${bulkPath} completely with your Read tool, 300 lines per call (offset 1, 301, 601, ... until the end). Then reply to god with one hive message (act "inform") whose body is: ${N3} followed by the last line of that file. Do not read any inbox file.`);
    let reply = null;
    try { reply = await this.waitReply(C, N3, 8 * 60_000); } catch (e) { log(`B3: ${e.message}`); }
    const compacted = this.claudeEvents().some((e) => e.timestamp && Date.parse(e.timestamp) >= since && (e.subtype === 'compact_boundary' || /compact_boundary|"isCompactSummary":true/.test(JSON.stringify(e))));
    const kinds = this.seenHookKinds(C, id);
    const hist = (this.ledgerHistory[C] || {})[id] || [];
    const reinjected = kinds.includes('SessionStart') || hist.some((h, i) => i > 0 && h.surfaceCount > hist[i - 1].surfaceCount && h.state === 'surfacing');
    const compactRows = this.rows().filter((r) => r.ts >= since && r.agentId === C && /"source":"compact"/.test(JSON.stringify(r)));
    if (this.args.dryRun) return this.fact('B3', 'NOT-PROVEN', this.dryNote(`reply=${!!reply}`));
    this.fact('B3', !compacted ? 'NOT-PROVEN' : (reply && reinjected ? 'PASS' : 'FAIL'),
      `compaction inside the epoch: ${compacted} (autocompact at ${this.b3Pct}%); re-injected: ${reinjected} (hookKinds ${kinds.join(',') || 'none'}; surfaceCount ${hist.map((h) => h.surfaceCount).join('>')}); compact-source rows: ${compactRows.length}; reply quoting the nonce: ${!!reply}`,
      reply ? [reply.p] : []);
  }

  /** B7 (Codex), §11.18 items 50-53 (Creed on Q45) + god c0a73f: FORCE a compaction mid-epoch by
   *  typing /compact into the running turn (on top of the lowered 40k auto-compact limit); if none
   *  happens, retry ONCE. What B7 proves is that THE MAIL SURVIVES the compaction: after the
   *  compaction event the nonce is either re-surfaced (the ledger shows a new surfacing: SessionStart
   *  hookKind or a surfaceCount step) or recallable (the reply quoting it was written after the
   *  compaction). The compact-source SessionStart is recorded either way.
   *   - compaction mid-epoch AND the mail survived: PASS;
   *   - compaction mid-epoch, the mail did NOT survive: FAIL (a design finding);
   *   - no compaction could be forced (or budget, error, not reached): GATE-BLOCKED, god decides.
   *  Never NOT-PROVEN in a real run, never PASS without the compaction event. */
  async factB7() {
    const X = IDS.codex;
    if (this.args.dryRun) return this.fact('B7', 'NOT-PROVEN', this.dryNote('no compaction is possible on a stub'));
    const bulkPath = path.join(this.spec.find((a) => a.id === X).cwd, 'b7-bulk.txt');
    const tries = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1 && !this.fits(X, 'B7')) { tries.push({ attempt, skipped: 'budget/wall-clock' }); break; }
      const N7 = nonce();
      const since = Date.now();
      const id = this.send(X, `B7A${attempt}`, `${N7}\n\nTask: print the file ${bulkPath} to your terminal in four parts (lines 1-400, 401-800, 801-1200, 1201-1601) with four separate shell commands, one at a time. Then reply to god with one hive message (act "inform") whose body is: ${N7} followed by the last line of that file.`);
      let typed = false;
      try {
        // Mid-epoch = the turn has started (the mail is surfacing/surfaced) and made a tool call.
        await this.waitState(X, id, ['surfacing', 'surfaced'], 5 * 60_000);
        await this.waitFor('the B7 turn\'s first tool call', 3 * 60_000, () => this.codexEvents().some((e) => e.timestamp && Date.parse(e.timestamp) >= since
          && e.payload && /function_call|local_shell_call|custom_tool_call/.test(String(e.payload.type))));
        await this.page.eval(`window.cth.writePty(${JSON.stringify(`pty-${X}`)}, '/compact', 'HUMAN')`);
        await sleep(700);
        await this.page.eval(`window.cth.writePty(${JSON.stringify(`pty-${X}`)}, '\\r', 'HUMAN')`);
        typed = true;
      } catch (e) { log(`B7 attempt ${attempt}: ${e.message}`); }
      let reply = null;
      try { reply = await this.waitReply(X, N7, 8 * 60_000); } catch (e) { log(`B7 attempt ${attempt}: ${e.message}`); }
      let acted = null;
      try { acted = await this.waitState(X, id, ['acted'], 3 * 60_000); } catch { /* recorded below */ }
      const end = acted && acted.actedAt ? acted.actedAt : Date.now();
      const ev = this.codexEvents().filter((e) => e.timestamp && Date.parse(e.timestamp) >= since);
      const compactAt = ev.filter((e) => e.type === 'compacted' || /context_compacted|"type":"compacted"/.test(JSON.stringify(e))).map((e) => Date.parse(e.timestamp)).filter((t) => t <= end);
      const midEpoch = compactAt.length > 0;
      const firstCompact = midEpoch ? Math.min(...compactAt) : null;
      const compactHook = this.rows().filter((r) => r.ts >= since && r.agentId === X && /"source":"compact"/.test(JSON.stringify(r)));
      const hist = (this.ledgerHistory[X] || {})[id] || [];
      const resurfaced = midEpoch && hist.some((h, i) => h.t >= firstCompact && (h.hookKind === 'SessionStart' || (i > 0 && h.surfaceCount > hist[i - 1].surfaceCount)));
      let replyAt = null;
      try { replyAt = reply ? fs.statSync(reply.p).mtimeMs : null; } catch { replyAt = null; }
      const recallable = midEpoch && !!reply && replyAt !== null && replyAt > firstCompact;
      tries.push({ attempt, typed, compactions: compactAt.length, midEpoch, compactHook: compactHook.length, resurfaced, recallable, kinds: this.seenHookKinds(X, id), reply: !!reply });
      if (midEpoch) break;
    }
    const hit = tries.find((t) => t.midEpoch);
    const detail = tries.map((t) => t.skipped ? `attempt ${t.attempt}: skipped (${t.skipped})`
      : `attempt ${t.attempt}: /compact typed ${t.typed}; mid-epoch compactions ${t.compactions}; compact-source SessionStart ${t.compactHook > 0}; mail re-surfaced after it ${t.resurfaced}; nonce recalled after it ${t.recallable} (hookKinds ${t.kinds.join(',') || 'none'}; reply ${t.reply})`).join(' | ');
    const status = !hit ? 'GATE-BLOCKED' : (hit.resurfaced || hit.recallable ? 'PASS' : 'FAIL');
    this.fact('B7', status, `RECORD: ${detail}`
      + (!hit ? '. No mid-epoch compaction could be forced after one retry: GATE-BLOCKED, god decides.' : '')
      + (status === 'FAIL' ? '. The mail did NOT survive the compaction: a design finding (§11.18 #21).' : ''), this.codexRollouts());
  }

  /** N4 against the BUILT artefact: the packaged CHANGELOG (app:info's reader) + the rollback text. */
  factN4() {
    const asarPath = path.join(REPO, 'dist', 'win-unpacked', 'resources', 'app.asar');
    const { verify, releaseNotesOf } = require(path.join(REPO, 'scripts', 'verify-packaged-changelog.cjs'));
    const v = verify(asarPath);
    const asar = require(path.join(REPO, 'node_modules', '@electron', 'asar'));
    let text = '';
    try { text = asar.extractFile(asarPath, 'CHANGELOG.md').toString('utf8'); } catch { /* reported */ } finally { try { asar.uncache(asarPath); } catch { /* ok */ } }
    const at = text.search(/^#+\s*\[?v?1\.1\.75\b/m);
    const body = at >= 0 ? text.indexOf('\n', at) + 1 : -1;
    const next = body > 0 ? text.slice(body).search(/^#+\s*\[?v?1\.1\.\d+\b/m) : -1;
    const section = at < 0 ? '' : (next >= 0 ? text.slice(at, body + next) : text.slice(at));
    const notes = releaseNotesOf(text);
    const ok = v.ok && section.includes('1.1.74 restored: move handled mail to inbox/.done again') && /archived/i.test(section) && /acted/i.test(section) && notes.includes('1.1.75');
    this.fact('N4', ok ? 'PASS' : 'FAIL', `packaged CHANGELOG: ${v.ok ? 'ok' : v.problems.join('; ')}; 1.1.75 section ${section ? 'present' : 'MISSING'} with the rollback reminder, archived and acted; app:info notes carry 1.1.75: ${notes.includes('1.1.75')}`, [asarPath]);
  }

  /** §11.18 #40: stop 1.1.75 with mail still delivered, run the built 1.1.74 (+ seams, stub TUIs,
   *  zero tokens) on the SAME sandbox hive, and check nothing is lost. */
  async factRollback() {
    const s = this.s;
    const C = IDS.claude;
    // Leave one message delivered-not-acted at the moment of the downgrade.
    await this.page.eval(`window.cth.controlAutoDelivery(${JSON.stringify(C)}, true)`);
    const R = nonce();
    const rid = this.send(C, 'RB', `${R}\n\n(rollback check: this message is delivered, not yet shown, when 1.1.75 stops)`);
    try { await this.waitState(C, rid, ['delivered'], 120_000); } catch (e) { log(`rollback: ${e.message}`); }
    await this.stopApp('1.1.75 before the rollback');
    const cfg = readJson(path.join(s.userData, 'config.json'), {});
    cfg.autoDeliveryPausedAgents = [];
    W.writeJson(path.join(s.userData, 'config.json'), cfg);
    // Snapshot what 1.1.74 must find.
    const snap = (id) => {
      const inbox = path.join(s.hive, 'agents', id, 'inbox');
      const ls = (d) => { try { return fs.readdirSync(d).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { return []; } };
      return { inbox: ls(inbox), done: ls(path.join(inbox, '.done')), undelivered: ls(path.join(inbox, '.undelivered')) };
    };
    const hashDir = (d) => { const h = crypto.createHash('sha256'); for (const f of walk(d, () => true).sort()) h.update(f).update(fs.readFileSync(f)); return h.digest('hex'); };
    const before = {};
    const problems = [];
    for (const a of this.spec) {
      before[a.id] = snap(a.id);
      const led = this.ledger(a.id).entries || {};
      for (const e of Object.values(led)) {
        const inInbox = before[a.id].inbox.includes(e.id); const inDone = before[a.id].done.includes(e.id); const inUnd = before[a.id].undelivered.includes(e.id);
        if (e.state === 'acted' && !(inDone || e.missingAt || e.reason)) problems.push(`${a.id}/${e.id} acted but not in .done`);
        if (['delivered', 'surfacing', 'surfaced'].includes(e.state) && !e.setAsideAt && !inInbox) problems.push(`${a.id}/${e.id} ${e.state} but not in inbox/ (1.1.74 would never see it)`);
        if (e.setAsideAt && !inUnd) problems.push(`${a.id}/${e.id} set aside but not in .undelivered/`);
      }
    }
    const mailStateHash = hashDir(path.join(s.hive, 'state', 'mail'));
    // 1.1.74 runs the STUB TUIs: its only job here is to read the hive (zero tokens).
    const node = path.join(this.env.RIG_NODE_DIR, path.basename(process.execPath));
    const reg = readJson(path.join(s.hive, 'registry.json'));
    const stubCommands = {};
    for (const a of this.spec) {
      const dir = path.join(s.hive, 'agents', a.id);
      this.typed[a.id] = this.typed[a.id] || path.join(s.stubs, `typed-${a.id}.log`);
      if (!fs.existsSync(this.typed[a.id])) W.write(this.typed[a.id], '');
      const stub = path.join(s.stubs, `rb-${a.id}.cjs`);
      W.write(stub, stubSource(a.id, s.pipe, this.typed[a.id], dir, 600));
      const command = `${JSON.stringify(node)} ${JSON.stringify(stub)}`;
      stubCommands[a.id] = command;
      if (reg.agents[a.id]) { reg.agents[a.id].command = command; reg.agents[a.id].provider = 'claude'; }
    }
    this.writeRoster((r) => ({ ...r, name: r.id === IDS.claude ? this.markerV2 : r.name, command: stubCommands[r.id], provider: 'claude' }));
    W.writeJson(path.join(s.hive, 'registry.json'), reg);
    const typedBefore = fs.readFileSync(this.typed[C], 'utf8').length;
    const rowsBefore = this.rows().length;
    await this.launch(this.exe174, '1.1.74+seams (rollback)');
    await this.openTheConfig();
    await this.waitAgentsUp('rollback');
    let woke = false;
    try {
      await this.waitFor('1.1.74 re-wakes the delivered-not-acted mail', 150_000, () => {
        const t = fs.readFileSync(this.typed[C], 'utf8').slice(typedBefore);
        return NUDGE_HEADS.some((h) => t.includes(h)) || t.includes(rid);
      }, 3000);
      woke = true;
    } catch (e) { log(`rollback: ${e.message}`); }
    await sleep(10_000);
    const start = this.rows().slice(rowsBefore).find((r) => r.kind === 'app-start');
    await this.stopApp('1.1.74');
    for (const a of this.spec) {
      const after = snap(a.id);
      const had = new Set([...before[a.id].inbox, ...before[a.id].done, ...before[a.id].undelivered]);
      const has = new Set([...after.inbox, ...after.done, ...after.undelivered]);
      for (const id of had) if (!has.has(id)) problems.push(`${a.id}/${id} LOST under 1.1.74`);
    }
    const stateUntouched = hashDir(path.join(s.hive, 'state', 'mail')) === mailStateHash;
    const ran174 = !!start && String(start.appPath || '').toLowerCase().includes(norm(this.v1174Dir));
    if (!stateUntouched) problems.push('1.1.74 changed hive/state/mail (it must ignore it)');
    if (!ran174) problems.push(`the app-start row is not from the 1.1.74 build (${start ? start.appPath : 'none'})`);
    this.fact('ROLLBACK', problems.length ? 'FAIL' : (woke ? 'PASS' : 'FAIL'),
      problems.length ? problems.join('; ') : `every message present before is present after; 1.1.74 re-woke the delivered mail: ${woke}; state/mail untouched`,
      [path.join(s.hive, 'state', 'mail')]);
  }

  async stopApp(label) {
    try { this.page && this.page.close(); } catch { /* gone */ }
    try { this.mainCdp && this.mainCdp.close(); } catch { /* gone */ }
    this.page = null; this.mainCdp = null;
    const r = await this.procs.killAll();
    if (this.watch) { this.watchHits = this.watchHits.concat(this.watch.hits); this.watch.stop(); this.watch = null; }
    // R3: a scan failure is a FAILURE, never a vacuous "all gone".
    this.check(r.ok === true && !r.scanFailed && r.survivors.length === 0, `${label}: every process started is gone (exact PID tree)`,
      r.scanFailed ? `SCAN FAILED (${r.why}); fell back to taskkill /T on open-handle roots ${JSON.stringify(r.fallback)}` : `killed ${r.killed.length}${r.survivors.length ? `; SURVIVORS ${r.survivors.join(',')}` : ''}`);
    this.killReport = (this.killReport || []).concat([{ label, ...r }]);
    await sleep(1500);
  }

  // ── evidence + report ─────────────────────────────────────────────────────
  /** Evidence is REDACTED (R9) and never includes a credential file. */
  collectEvidence() {
    const s = this.s;
    const dst = path.join(s.report, 'evidence');
    const never = /(^|[\\/])(auth\.json|\.credentials\.json)$/i;
    const take = (from, rel) => {
      if (!fs.existsSync(from) || never.test(from)) return;
      let text;
      try { text = fs.readFileSync(from, 'utf8'); } catch { return; }
      W.write(path.join(dst, rel), redact(text));
    };
    for (const f of walk(s.hive, (p) => /log[^\\/]*\.jsonl$|cost-ledger[^\\/]*\.jsonl$/.test(p) && path.dirname(p) === s.hive)) take(f, path.basename(f));
    for (const f of walk(path.join(s.hive, 'state', 'mail'), () => true)) take(f, path.join('state-mail', path.relative(path.join(s.hive, 'state', 'mail'), f)));
    for (const f of walk(path.join(s.hive, 'agents', IDS.god, 'inbox'), (p) => p.endsWith('.json'))) take(f, path.join('god-inbox', path.relative(path.join(s.hive, 'agents', IDS.god, 'inbox'), f)));
    for (const f of this.claudeTranscripts()) take(f, path.join('claude-transcripts', path.basename(f)));
    for (const f of this.codexRollouts()) take(f, path.join('codex-rollouts', path.basename(f)));
    for (const f of walk(s.stubs, (p) => p.endsWith('.log'))) take(f, path.join('stubs', path.basename(f)));
    if (this.jailLog) take(this.jailLog, 'jail-decisions.jsonl');
    W.write(path.join(dst, 'app-output.log'), redact(this.appOut));
    W.write(path.join(dst, 'ledger-history.json'), redact(JSON.stringify(this.ledgerHistory, null, 2)));
    W.write(path.join(dst, 'samples.json'), redact(JSON.stringify({ ...this.samples, windowWatch: this.watchHits || [] }, null, 2)));
    W.write(path.join(dst, 'proofs.json'), redact(JSON.stringify(this.proofs || {}, null, 2)));
    return dst;
  }

  /** Strings only this run produces (the live-location check looks for them). */
  markers() {
    return [this.s.base, this.stamp, 'md-layerb', IDS.claude, IDS.codex, this.markerV1, this.markerV2, ...this.nonces].filter(Boolean);
  }

  report(extra) {
    const s = this.s;
    const order = ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'N4', 'ROLLBACK'];
    for (const f of order) if (!this.facts[f]) this.fact(f, this.unproven(f), this.aborted() ? `not reached: ${this.abort.signal.reason && this.abort.signal.reason.message}` : 'not reached');
    const facts = order.map((f) => this.facts[f]);
    const asserted = this.args.dryRun ? facts.filter((f) => ['B8', 'B9', 'N4', 'ROLLBACK'].includes(f.id)) : facts;
    const ok = asserted.every((f) => f.status === 'PASS') && this.checks.every((c) => c.ok);
    const json = {
      mode: this.args.dryRun ? 'dry-run-stubs' : 'real', ok, startedAt: new Date(this.startedAt || Date.now()).toISOString(),
      durationMs: this.startedAt ? Date.now() - this.startedAt : 0, abort: this.aborted() ? String(this.abort.signal.reason && this.abort.signal.reason.message) : null,
      models: this.args.models, caps: CAPS, globalWallMs: GLOBAL_WALL_MS, tokens: this.tokens, breakerStop: this.breakerStop || null,
      facts, checks: this.checks, windows: { samples: this.samples.hidden.length, watchHits: this.watchHits || [] },
      processes: this.killReport || [], proofs: this.proofs || {}, ...extra,
      warnings: ['CDP and the main-process inspector listened UNAUTHENTICATED on random 127.0.0.1 ports while the app held the jailed logins; any local process could have attached for the run\'s duration.'],
      sandbox: s.base, evidence: extra.evidence
    };
    W.write(path.join(s.report, 'layer-b-report.json'), redact(JSON.stringify(json, null, 2)));
    const cred = (c) => `- ${c.label}: copy shredded ${c.deleted}; REAL file byte-identical (SHA-256 ${c.shaSame}, mtime ${c.mtimeSame}, size ${c.sizeSame}); **token refresh during the run: ${c.tokenRefreshed === null ? 'unknown' : (c.tokenRefreshed ? 'YES (the jailed copy changed: the real login may need a re-login)' : 'no')}**`;
    const lw = extra.liveWatch || {};
    const md = [
      `# Layer (b) run — ${json.mode} — ${ok ? 'PASS' : 'NOT PASSED'}`, '',
      `Started ${json.startedAt}, ${Math.round(json.durationMs / 1000)} s.${json.abort ? ` **Aborted: ${json.abort}.**` : ''}`,
      `Models: claude ${this.args.models.claude}, codex ${this.args.models.codex}. Caps: ${CAPS.perAgentTokens} per agent, ${CAPS.totalTokens} total, ${CAPS.wallMs / 60000} min (agents), ${GLOBAL_WALL_MS / 60000} min (whole run).`, '',
      '| Fact | Status | Detail |', '|---|---|---|',
      ...facts.map((f) => `| ${f.id} | ${f.status} | ${String(f.detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`), '',
      '## Tokens and cost', '', '| Agent | Used (max of sources) | Ledger | Transcript / rollout | USD (ledger) |', '|---|---|---|---|---|',
      ...[IDS.claude, IDS.codex, IDS.god].map((a) => { const t = this.tokens[a] || {}; return `| ${a} | ${t.used ?? 0} | ${t.ledger ?? 0} | ${t.transcript ?? t.rollout ?? '-'} | ${(t.usd ?? 0).toFixed ? (t.usd ?? 0).toFixed(4) : t.usd} |`; }),
      `| total | ${(this.tokens && this.tokens.total) || 0} | | | |`, '',
      '## Checks', '', ...this.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.label}${c.detail ? ` — ${String(c.detail).slice(0, 300)}` : ''}`), '',
      '## Credentials', '', ...(extra.credentials || []).map(cred), '',
      '## Live locations (before/after)', '', `- ${lw.ok ? 'PASS' : 'FAIL'}: ${lw.failures && lw.failures.length ? lw.failures.join('; ') : 'no change carries a run marker'}`,
      `- changed during the run (the live floor writes these itself): ${(lw.changed || []).length}; key files unchanged: ${(lw.keys || []).filter((k) => k.same).length}/${(lw.keys || []).length}`, '',
      '## Warnings', '', ...json.warnings.map((w) => `- ${w}`), '',
      `Windows: ${this.samples.hidden.length} isVisible checks; window-watch hits ${(this.watchHits || []).length}.`,
      `Evidence (redacted): ${extra.evidence}`, `Sandbox: ${s.base}${this.args.keepSandbox ? ' (kept)' : ' (removed)'}`,
      `Build cleanup: ${(extra.buildCleanup || []).join('; ') || 'nothing'}`, `Startup sweep: ${JSON.stringify(extra.sweep || [])}`
    ].join('\n');
    W.write(path.join(s.report, 'layer-b-report.md'), redact(md));
    return { ok, json };
  }

  // ── main ──────────────────────────────────────────────────────────────────
  async main() {
    this.runStart = Date.now();
    const s = this.layout();
    log(`mode: ${this.args.dryRun ? 'DRY RUN (stub TUIs, zero tokens)' : 'REAL (claude + codex)'}; sandbox ${s.base}`);
    const { liveUserData } = this.preflight();
    if (!this.args.go) {
      log('preflight OK. Nothing was built, launched or written (pass --go with LAYERB_SOAK=1, and god\'s OK, to run).');
      return 0;
    }
    W.allowRoot(s.base);
    W.allowRoot(s.report);
    // R4: shred credentials an earlier killed run left behind, then remove its sandbox.
    const sweep = sweepStale(os.tmpdir(), s.base);
    if (sweep.length) log(`startup sweep: ${JSON.stringify(sweep)}`);
    this.check(sweep.every((x) => x.removed && x.shredded === x.credentials), 'startup sweep: stale md-layerb-* sandboxes shredded and removed', JSON.stringify(sweep));
    // god c0a73f (c): the live locations, before anything runs.
    this.liveWatch = LiveWatch.defaults().start();
    let result = { ok: false };
    const credResults = [];
    let buildCleanup = [];
    let liveResult = null;
    try {
      this.build();
      this.appEnv(liveUserData);
      this.seed();
      this.installCredentials();
      this.factN4();
      // R1 zero-token proofs, dry and real: a failure stops the run before any agent starts.
      if (!this.proveClaudeJail()) throw new Error('the Claude jail proof failed');
      if (!this.proveCodexSandbox()) throw new Error('the Codex sandbox proof failed');
      this.startedAt = Date.now();
      this.startMonitors();
      await this.launch(this.exe175, '1.1.75 (phase A)');
      await this.openTheConfig();
      await this.assertHidden('after the config opened');
      await this.waitAgentsUp('phase A');
      this.checkCodexSeed();
      // Claude and Codex facts run side by side (separate agents, separate budgets).
      const claudeA = (async () => {
        if (this.fits(IDS.claude, 'B1')) await this.guard(['B1', 'B8', 'B9'], () => this.factB1B8B9()); else this.fact('B1', 'NOT-PROVEN', 'budget');
        if (this.fits(IDS.claude, 'B2')) await this.guard(['B2'], () => this.factB2()); else this.fact('B2', 'NOT-PROVEN', 'budget');
      })();
      const codexA = (async () => {
        if (this.fits(IDS.codex, 'B5')) await this.guard(['B5', 'B6'], () => this.factB5B6()); else this.fact('B5', 'NOT-PROVEN', 'budget');
      })();
      const settled = await Promise.allSettled([claudeA, codexA]);
      for (const r of settled) if (r.status === 'rejected') log(`phase A: ${r.reason && r.reason.message}`);
      this.abort.signal.throwIfAborted();
      await this.relaunchForPhaseB();
      const claudeB = (async () => {
        if (this.fits(IDS.claude, 'B4')) await this.guard(['B4'], () => this.factB4()); else this.fact('B4', 'NOT-PROVEN', 'budget');
        if (this.fits(IDS.claude, 'B3')) await this.guard(['B3'], () => this.factB3()); else this.fact('B3', 'NOT-PROVEN', 'budget');
      })();
      const codexB = (async () => {
        if (this.fits(IDS.codex, 'B7')) await this.guard(['B7'], () => this.factB7()); else this.fact('B7', this.unproven('B7'), 'budget');
      })();
      const settledB = await Promise.allSettled([claudeB, codexB]);
      for (const r of settledB) if (r.status === 'rejected') log(`phase B: ${r.reason && r.reason.message}`);
      this.abort.signal.throwIfAborted();
      if (this.args.rollback) await this.guard(['ROLLBACK'], () => this.factRollback());
      else this.fact('ROLLBACK', 'NOT-PROVEN', 'skipped (--no-rollback)');
    } catch (e) {
      log(`run stopped: ${e && e.message}`);
      if (!this.aborted()) this.stop(String(e && e.message));
    } finally {
      for (const t of this.bg) clearInterval(t);
      try { this.pollTokens(); } catch { /* best effort */ }
      // R4 order: every process FIRST (so no CLI can rewrite a token), then the credentials.
      await this.stopApp('final').catch((e) => { this.check(false, 'final kill', e.message); });
      const del = this.creds.deleteAll();
      const real = this.creds.verifyRealUnchanged();
      for (const d of del) credResults.push({ ...d, ...(real.find((r) => r.label === d.label) || {}) });
      for (const c of credResults) {
        this.check(c.deleted, `credentials: the ${c.label} copy is shredded`);
        this.check(c.unchanged, `credentials: the REAL ${c.label} file is byte-identical (SHA-256 + mtime + size)`, `${c.real} sha ${c.shaSame} mtime ${c.mtimeSame} size ${c.sizeSame}`);
        this.check(c.tokenRefreshed !== null, `credentials: whether ${c.label} refreshed its token is known`, `refreshed=${c.tokenRefreshed}`);
      }
      try { buildCleanup = this.cleanupBuild(); } catch (e) { buildCleanup = [`cleanup: ${e.message}`]; }
      try {
        liveResult = this.liveWatch.compare(this.markers());
        this.check(liveResult.ok, 'the live hive, MunderDevData, the real ~/.claude and ~/.codex and the live userData carry no trace of this run', liveResult.failures.join('; '));
      } catch (e) { this.check(false, 'live-location check', e.message); }
      let evidence = null;
      try { evidence = this.collectEvidence(); } catch (e) { log(`evidence: ${e.message}`); }
      result = this.report({ credentials: credResults, evidence, liveWatch: liveResult, buildCleanup, sweep });
      if (!this.args.keepSandbox) { try { W.rm(s.base); } catch (e) { log(`sandbox removal: ${e.message}`); } }
    }
    log(`report: ${path.join(s.report, 'layer-b-report.md')}`);
    log(result.ok ? 'LAYER (b): PASS' : 'LAYER (b): NOT PASSED');
    return result.ok ? 0 : 1;
  }

  /** R1: the Codex agent really runs with the jail's sandbox config (the product copied the seed). */
  checkCodexSeed() {
    if (this.args.dryRun) return;
    const cfg = path.join(this.s.hive, 'agents', IDS.codex, '.codex', 'config.toml');
    let text = '';
    try { text = fs.readFileSync(cfg, 'utf8'); } catch { /* reported */ }
    const ok = /sandbox_mode\s*=\s*"workspace-write"/.test(text) && /writable_roots\s*=\s*\[/.test(text) && /network_access\s*=\s*false/.test(text)
      && !/danger-full-access/.test(text) && this.codexRoots.every((r) => text.toLowerCase().includes(path.resolve(r).toLowerCase()));
    if (!this.check(ok, 'R1: the Codex agent home carries the jail sandbox config (workspace-write, jail-only writable roots, no network)', cfg)) {
      this.stop('the Codex agent is not confined');
      throw new Error('the Codex agent is not confined');
    }
  }
}

module.exports = { b6Tiers, withoutMail, W, liveForbidden, inside, parseArgs, CAPS, GLOBAL_WALL_MS, Credentials, ProcTracker, WindowWatch, LiveWatch, sweepStale, buildEnv, redact, realCredentialPaths, claudeJailSettings, codexSandboxToml, stubSource, LayerB, IDS, DEFAULT_MODELS, HEAVY_GATE };

if (require.main === module) {
  let lb = null;
  let exiting = false;
  /** R4 order, synchronous (no event loop may be left): 1. kill every process we started, so no
   *  CLI can rewrite a refreshed token; 2. shred the credential copies; 3. remove the sandbox. */
  const emergency = (code) => {
    if (exiting) return;
    exiting = true;
    try { if (lb) lb.procs.killSyncBestEffort(); } catch { /* best effort */ }
    try { if (lb && lb.watch) lb.watch.stop(); } catch { /* best effort */ }
    try { if (lb) lb.creds.deleteAll(); } catch { /* best effort */ }
    try { if (lb && lb.s && !lb.args.keepSandbox && fs.existsSync(lb.s.base)) W.rm(lb.s.base); } catch { /* best effort */ }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { log(`${sig}: cleaning up`); emergency(130); });
  process.on('uncaughtException', (e) => { console.error('[layer-b] uncaught:', e); emergency(1); });
  process.on('unhandledRejection', (e) => { console.error('[layer-b] unhandled:', e); emergency(1); });
  process.on('exit', () => { try { if (lb && !exiting) { lb.procs.killRootsByHandle('process exit'); lb.creds.deleteAll(); } } catch { /* best effort */ } });
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  lb = new LayerB(args);
  lb.main().then((code) => process.exit(code), (e) => { console.error('[layer-b] crashed:', e); emergency(1); });
}
