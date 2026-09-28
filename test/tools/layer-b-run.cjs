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
 *    sandbox>: never C:\Dunder\hive, never C:\Dunder\MunderDevData, never the live userData. The
 *    root and its pipe are validated with the product's own devIsolation.ts BEFORE launch, and read
 *    back from the running app (main-process inspector) AFTER launch.
 *  - No window ever: the window is built show:false and MUNDER_HIDDEN skips every show/focus; the
 *    runner asserts BrowserWindow.isVisible() === false over the main-process inspector AND scans
 *    the OS for any visible top-level window owned by a process it started, at launch and every
 *    few seconds after. Any visible window ABORTS the run.
 *  - The app's ENTIRE env comes from test/mail-rig/isolation.cjs rigEnv (an allowlist): HOME,
 *    USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, CODEX_HOME, GEMINI_CLI_HOME are jailed; PATH holds
 *    only the real claude + codex binary dir(s), the Git cmd dir (Claude Code on Windows needs Git
 *    Bash; omit with --no-git-path), the node-only dir and the system dirs. Fail-fast on any
 *    secret-shaped variable, any foreign PATH dir, any other provider CLI resolvable, any env value
 *    naming a live path.
 *  - Credentials: each CLI gets ONLY its login credential, COPIED (never moved) from the real file
 *    opened READ-ONLY, into the jail. Nothing else (settings, history, projects) is copied; the few
 *    first-run keys Claude needs are SYNTHESISED. The copies are deleted in `finally`, on every
 *    signal and on process exit; the real files' mtime and size are asserted unchanged.
 *  - Every write/remove the runner does goes through `W` (below), which refuses any path outside
 *    the run's own sandbox / report dir / 1.1.74 build worktree, and any path in a live location.
 *  - Caps: 400k tokens per agent (cache reads included), 1M total, 30 min wall-clock — polled
 *    every few seconds from the sandbox cost ledger AND the CLIs' own transcripts/rollouts (the
 *    larger count wins); any hit ABORTS and the report says what was proven. The sandbox config
 *    also turns the breaker ON with hard stop, the floor token cap and per-agent token caps.
 *  - Every process started is killed by exact PID (the recorded tree), deepest first.
 *
 * USAGE (never without god's OK: it builds and LAUNCHES the app):
 *   node C:/Dunder/_work/andy-scratch/flaky170/run-clean-realhome.cjs C:/Dunder/_work/andy-zt175 \
 *     node test/tools/layer-b-run.cjs --dry-run-stubs --go        # plumbing, zero tokens
 *   ... node test/tools/layer-b-run.cjs --go                       # the real run
 * Without --go it only prints the plan and runs the static preflight (no build, no launch).
 * Options: --skip-build (reuse dist/), --no-rollback, --keep-sandbox, --no-git-path,
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
  const a = { dryRun: false, go: false, skipBuild: false, rollback: true, keepSandbox: false, gitPath: true,
    models: { ...DEFAULT_MODELS }, v1174Dir: null, reportDir: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run-stubs') a.dryRun = true;
    else if (k === '--go') a.go = true;
    else if (k === '--skip-build') a.skipBuild = true;
    else if (k === '--no-rollback') a.rollback = false;
    else if (k === '--keep-sandbox') a.keepSandbox = true;
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

/** Scrubbed env for the build tools (npm / electron-builder): like run-clean-realhome. */
function buildEnv() {
  const BAD = /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CTH_|KG_|MD_SLACK_|CLAUDE)/i;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!BAD.test(k)) env[k] = v;
  const pk = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const parts = String(env[pk] || '').split(';').filter((p) => p && !/dunder\\hive|munderdevdata/i.test(p));
  for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
  env.Path = parts.join(';');
  return env;
}

function run(cmd, args, cwd, label, { env = buildEnv(), timeoutMs = 20 * 60_000 } = {}) {
  log(`${label}: ${cmd} ${args.join(' ')}  (in ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit', windowsHide: true, shell: /\.(cmd|bat)$/i.test(cmd), timeout: timeoutMs });
  if (r.error || r.status !== 0) throw new Error(`${label} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
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
  constructor() { this.known = new Map(); this.visibleHits = []; this.scans = 0; }
  addRoot(pid) { this.known.set(pid, { pid, created: null, name: 'root', depth: 0 }); }
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
  /** Kill every known process that is still the same process, deepest first. */
  async killAll() {
    let snap;
    try { snap = await this.scan(); } catch { snap = { procs: [] }; }
    const alive = new Map(snap.procs.map((p) => [p.pid, p]));
    const same = (k) => alive.has(k.pid) && (k.created === null ? /munder difflin/i.test(alive.get(k.pid).name) : alive.get(k.pid).created === k.created);
    const ours = [...this.known.values()].filter(same)
      .sort((a, b) => b.depth - a.depth);
    for (const k of ours) spawnSync('taskkill', ['/F', '/PID', String(k.pid)], { windowsHide: true, stdio: 'ignore' });
    await sleep(1500);
    let after;
    try { after = await this.scan(); } catch { after = { procs: [] }; }
    const still = after.procs.filter((p) => { const k = this.known.get(p.pid); return k && (k.created === null ? /munder difflin/i.test(p.name) : k.created === p.created); });
    return { killed: ours.map((k) => `${k.pid}:${k.name}`), survivors: still.map((p) => `${p.pid}:${p.name}`) };
  }
  /** Synchronous last resort (signals, crashes): the same identity-checked kill, no event loop. */
  killSyncBestEffort() {
    let snap;
    try { snap = this.scanSync(); } catch { return; }   // no identity proof: kill nothing rather than a stranger
    const alive = new Map(snap.procs.map((p) => [p.pid, p]));
    for (const k of [...this.known.values()].sort((a, b) => b.depth - a.depth)) {
      const a = alive.get(k.pid);
      if (!a || (k.created === null ? !/munder difflin/i.test(a.name) : a.created !== k.created)) continue;
      try { spawnSync('taskkill', ['/F', '/PID', String(k.pid)], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* gone */ }
    }
  }
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
 *  Windows/Linux (Keychain on macOS); Codex in $CODEX_HOME/auth.json, default ~/.codex/auth.json. */
function realCredentialPaths() {
  const home = os.homedir();
  return { claude: path.join(home, '.claude', '.credentials.json'), codex: path.join(home, '.codex', 'auth.json') };
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
    this.copies.push({ label, real, dest, mtimeMs: before.mtimeMs, size: before.size, sha: crypto.createHash('sha256').update(buf).digest('hex') });
    buf.fill(0);
  }
  /** Synchronous, idempotent: safe from finally, signal handlers and process 'exit'. */
  deleteAll() {
    const out = [];
    for (const c of this.copies) {
      let changedInJail = null;
      try { if (fs.existsSync(c.dest)) changedInJail = crypto.createHash('sha256').update(fs.readFileSync(c.dest)).digest('hex') !== c.sha; } catch { /* unreadable */ }
      try { fs.rmSync(W.check(c.dest), { force: true }); } catch (e) { out.push({ label: c.label, deleted: false, error: e.message }); continue; }
      out.push({ label: c.label, deleted: !fs.existsSync(c.dest), changedInJail });
    }
    return out;
  }
  /** The real files must be exactly as they were (mtime + size). */
  verifyRealUnchanged() {
    return this.copies.map((c) => {
      let st = null;
      try { st = fs.statSync(c.real); } catch { /* vanished */ }
      return { label: c.label, real: c.real, unchanged: !!st && st.mtimeMs === c.mtimeMs && st.size === c.size };
    });
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
    out.tier2 = `persisted response_items with <hive-mail>: ${persisted.length}; carrying a turn 1-3 nonce: ${carry.length} (${carry.filter((e) => ts(e) < t4).length} before turn 4)`;
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
    // The sandbox root, validated by the PRODUCT's own guard, with the live userData forbidden.
    const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
    const iso = loadTs(path.join(REPO, 'src', 'main', 'devIsolation.ts'));
    const liveUserData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'munder-difflin');
    const r = iso.resolveDevDataRoot({ env: { MUNDER_DEV_ROOT: s.devRoot }, dev: true, platform: 'win32', liveUserData });
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
    this.check(true, 'preflight: the sandbox root passes the product isolation guard; its pipe is neither the live nor the MunderDevData pipe', `${r.root} / ${paths.pipeName}`);
    return { iso, liveUserData, livePipe, fixedPipe };
  }

  // ── build ─────────────────────────────────────────────────────────────────
  seamCommit() {
    const r = spawnSync('git', ['log', '--diff-filter=A', '--format=%H', '--', 'test/dev-hidden-root.test.cjs'], { cwd: REPO, encoding: 'utf8', windowsHide: true });
    const sha = (r.stdout || '').trim().split('\n').pop();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('cannot find the layer-b seam commit (the one that added test/dev-hidden-root.test.cjs)');
    return sha;
  }

  build() {
    const npm = 'npm.cmd';
    const eb = path.join(REPO, 'node_modules', '.bin', 'electron-builder.cmd');
    W.allowRoot(path.join(REPO, 'dist'));
    if (!this.args.skipBuild) {
      run(npm, ['run', 'build'], REPO, 'build 1.1.75 (this tree)');
      run(eb, ['--win', '--dir', '--publish', 'never', '-c.npmRebuild=false'], REPO, 'package 1.1.75 (--dir)');
    }
    this.exe175 = path.join(REPO, 'dist', 'win-unpacked', 'Munder Difflin.exe');
    if (!fs.existsSync(this.exe175)) throw new Error(`${this.exe175} not found`);
    this.assertSeamsInAsar(path.join(REPO, 'dist', 'win-unpacked', 'resources', 'app.asar'), '1.1.75');

    if (!this.args.rollback) return;
    // 1.1.74 = b5e22e0b PLUS the seam commit cherry-picked (without the seams it would use the
    // FIXED MunderDevData root and SHOW a window, so it could never run hidden in the sandbox).
    const dir = this.args.v1174Dir || path.join(os.tmpdir(), 'md-layerb-v1174');
    W.allowRoot(dir);
    this.v1174Dir = dir;
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      const seam = this.seamCommit();
      run('git', ['worktree', 'add', '--detach', dir, V1174_SHA], REPO, 'detached 1.1.74 worktree');
      run('git', ['cherry-pick', '--no-commit', seam], dir, `apply the seam commit ${seam.slice(0, 8)} onto 1.1.74`);
    }
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8', windowsHide: true }).stdout.trim();
    if (!head.startsWith(V1174_SHA)) throw new Error(`${dir} is at ${head}, not ${V1174_SHA}`);
    if (!fs.existsSync(path.join(dir, 'node_modules', 'electron'))) {
      log('copying node_modules into the 1.1.74 worktree (a COPY, not a junction) …');
      W.copyTree(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
    }
    const nm = fs.lstatSync(path.join(dir, 'node_modules'));
    if (nm.isSymbolicLink()) throw new Error('the 1.1.74 node_modules is a link; it must be a copy');
    if (!this.args.skipBuild || !fs.existsSync(path.join(dir, 'dist', 'win-unpacked', 'Munder Difflin.exe'))) {
      run(npm, ['run', 'build'], dir, 'build 1.1.74 + seams');
      run(path.join(dir, 'node_modules', '.bin', 'electron-builder.cmd'), ['--win', '--dir', '--publish', 'never', '-c.npmRebuild=false'], dir, 'package 1.1.74 + seams (--dir)');
    }
    this.exe174 = path.join(dir, 'dist', 'win-unpacked', 'Munder Difflin.exe');
    if (!fs.existsSync(this.exe174)) throw new Error(`${this.exe174} not found`);
    this.assertSeamsInAsar(path.join(dir, 'dist', 'win-unpacked', 'resources', 'app.asar'), '1.1.74+seams');
  }

  /** Static: the packaged main bundle carries both seams behind MUNDER_DEV (else refuse to launch it). */
  assertSeamsInAsar(asarPath, label) {
    const asar = require(path.join(REPO, 'node_modules', '@electron', 'asar'));
    let b = '';
    try { b = asar.extractFile(asarPath, path.join('out', 'main', 'index.js')).toString('utf8'); } finally { try { asar.uncache(asarPath); } catch { /* ok */ } }
    const ok = b.includes('process.env.MUNDER_DEV === "1"') && /function hiddenRun\([^)]*\)\s*\{\s*if \(!dev\) return false;/.test(b)
      && /ready-to-show", \(\) => \{\s*if \(!DEV_HIDDEN\) win\.show\(\);/.test(b) && b.includes('function resolveDevDataRoot(');
    if (!this.check(ok, `static: the ${label} packaged bundle carries MUNDER_HIDDEN + MUNDER_DEV_ROOT behind MUNDER_DEV`, asarPath)) {
      throw new Error(`${label}: the packaged bundle lacks the hidden/root seams — refusing to launch it (it would show a window or use MunderDevData)`);
    }
  }

  // ── sandbox + env ─────────────────────────────────────────────────────────
  appEnv(liveUserData) {
    const s = this.s;
    const env = isolation.rigEnv(s.jail, process.env);
    const nodeDir = env.RIG_NODE_DIR;
    const extra = [];
    if (!this.args.dryRun) {
      const pp = parentPath();
      for (const name of ['claude', 'codex']) {
        const p = whichOn(pp, name);
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
    return env;
  }

  seed() {
    const s = this.s;
    const dry = this.args.dryRun;
    for (const d of [s.hive, s.userData, s.work, s.stubs, s.home, s.report]) W.mkdir(d);
    this.markerV1 = `Marker-V1-${hex(3)}`;
    this.markerV2 = `Marker-V2-${hex(3)}`;
    const agents = {};
    const restorable = [];
    const node = this.env.RIG_NODE_DIR ? path.join(this.env.RIG_NODE_DIR, path.basename(process.execPath)) : process.execPath;
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
        command = `claude --model ${this.args.models.claude} --permission-mode bypassPermissions`;
      } else {
        command = `codex --model ${this.args.models.codex} --dangerously-bypass-approvals-and-sandbox`;
      }
      a.cwd = cwd; a.command = command;
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
    // Claude's first-run gates, SYNTHESISED (nothing of the real profile is copied but the login).
    const claudeCwd = spec.find((a) => a.id === IDS.claude).cwd;
    W.writeJson(path.join(s.home, '.claude', 'settings.json'), { skipDangerousModePermissionPrompt: true, skipAutoPermissionPrompt: true });
    W.writeJson(path.join(s.home, '.claude.json'), {
      hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true,
      projects: { [claudeCwd]: { hasTrustDialogAccepted: true }, [claudeCwd.replace(/\\/g, '/')]: { hasTrustDialogAccepted: true } }
    });
    // Bulk files for the compaction facts (B3 Claude, B7 Codex).
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango'.split(' ');
    const bulk = (n, tag) => { const out = []; for (let i = 1; i <= n; i++) out.push(`line ${String(i).padStart(4, '0')} ${Array.from({ length: 18 }, () => words[crypto.randomInt(words.length)]).join(' ')}`); out.push(`END-${tag}`); return out.join('\n'); };
    this.bulkEnd = { claude: `END-${hex(4)}`, codex: `END-${hex(4)}` };
    W.write(path.join(claudeCwd, 'b3-bulk.txt'), bulk(1500, this.bulkEnd.claude.slice(4)));
    W.write(path.join(spec.find((a) => a.id === IDS.codex).cwd, 'b7-bulk.txt'), bulk(1600, this.bulkEnd.codex.slice(4)));
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
    let real = realCredentialPaths();
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

  // ── launch / hidden ───────────────────────────────────────────────────────
  async launch(exe, label) {
    const cdpPort = await freePort();
    let inspPort = await freePort();
    while (inspPort === cdpPort) inspPort = await freePort();
    const proc = spawn(exe, [`--remote-debugging-port=${cdpPort}`, `--inspect=127.0.0.1:${inspPort}`], {
      cwd: this.s.base, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    this.procs.addRoot(proc.pid);
    proc.stdout.on('data', (d) => { this.appOut += d; });
    proc.stderr.on('data', (d) => { this.appOut += d; });
    proc.on('exit', (code) => log(`${label} exited (${code})`));
    this.app = { proc, cdpPort, inspPort, label, exe };
    log(`${label}: launched pid ${proc.pid} (CDP ${cdpPort}, main inspector ${inspPort})`);
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
    const pipeLine = /pipe=(\S+)/.exec(this.appOut);
    if (pipeLine) this.check(pipeLine[1].toLowerCase() === this.s.pipe.toLowerCase(), `${label}: the hook pipe is the sandbox's`, pipeLine[1]);
    return this.app;
  }

  /** BrowserWindow.isVisible() over the MAIN inspector, plus an OS scan of every process we started. */
  async assertHidden(label) {
    const wins = JSON.parse(await this.mainCdp.eval(`JSON.stringify(process.mainModule.require('electron').BrowserWindow.getAllWindows().map((w) => ({ id: w.id, visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused() })))`));
    const os1 = await this.procs.scan();
    this.samples.hidden.push({ at: new Date().toISOString(), label, windows: wins, osVisible: os1.visible });
    const shown = wins.filter((w) => w.visible || w.focused);
    if (shown.length || os1.visible.length) {
      this.check(false, `NO WINDOW (${label})`, JSON.stringify({ shown, os: os1.visible }));
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
    every(8_000, async () => { if (this.mainCdp) await this.assertHidden('monitor'); });
    every(5_000, async () => this.pollTokens());
    every(1_000, async () => this.pollLedgers());
    every(15_000, async () => {
      if (Date.now() - this.startedAt > CAPS.wallMs) this.stop('wall-clock cap (30 min)');
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
    W.writeJson(path.join(s.home, '.claude', 'settings.json'), { skipDangerousModePermissionPrompt: true, skipAutoPermissionPrompt: true, env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct) } });
    log(`phase B: marker ${this.markerV1} -> ${this.markerV2}; Claude autocompact at ${pct}% (context was ${ctxClaude}); Codex compact limit 40000`);
    await this.launch(this.exe175, '1.1.75 (phase B)');
    await this.openTheConfig();
    await this.waitAgentsUp('phase B');
  }

  /** B4 (Claude): the resumed session sees the NEW --append-system-prompt. */
  async factB4() {
    const C = IDS.claude;
    const N4 = nonce();
    const id = this.send(C, 'B4', `${N4}\n\nWhat is your agent name exactly as your system prompt states it (the sentence that starts "You are")? Reply to god with one hive message (act "inform") whose body is: ${N4} followed by that name. Do not read any file.`);
    let reply = null;
    try { reply = await this.waitReply(C, N4, 6 * 60_000); } catch (e) { log(`B4: ${e.message}`); }
    try { await this.waitState(C, id, ['acted'], 2 * 60_000); } catch { /* reported below */ }
    const after = (readJson(path.join(this.s.hive, 'registry.json'), { agents: {} }).agents[C] || {});
    const resumedSame = !!this.sessionBefore.sessionId && JSON.stringify(after).includes(String(this.sessionBefore.sessionId));
    const body = reply ? String(reply.m.body) : '';
    if (this.args.dryRun) return this.fact('B4', 'NOT-PROVEN', this.dryNote(`relaunch+rename ok, reply=${!!reply}`));
    const v2 = body.includes(this.markerV2); const v1 = body.includes(this.markerV1);
    this.fact('B4', !reply ? 'NOT-PROVEN' : (v2 && !v1 ? 'PASS' : 'FAIL'),
      `reply: ${JSON.stringify(body.slice(0, 160))}; expected the NEW marker ${this.markerV2} (old ${this.markerV1}); resumed the same session: ${resumedSame}`
      + (v1 && !v2 ? ' — the resumed session kept the OLD prompt: §7.1 step 3 then needs a rotation at upgrade' : ''), reply ? [reply.p] : []);
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

  /** B7 (Codex), §11.18 items 50-53 (Creed on Q45): FORCE a compaction mid-epoch by typing
   *  /compact into the running turn (on top of the lowered 40k auto-compact limit); if none happens,
   *  retry ONCE. Then RECORD whether a compact-source SessionStart fired and whether the re-surface
   *  path was used. PASS = a compaction really happened inside the epoch and was recorded. If none can
   *  be forced: GATE-BLOCKED (god decides). NOT-PROVEN never passes the gate, and B7 is never PASS
   *  without a mid-epoch compaction. */
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
      const compactAt = ev.filter((e) => e.type === 'compacted' || /context_compacted|"type":"compacted"/.test(JSON.stringify(e))).map((e) => Date.parse(e.timestamp));
      const midEpoch = compactAt.some((t) => t <= end);
      const compactHook = this.rows().filter((r) => r.ts >= since && r.agentId === X && /"source":"compact"/.test(JSON.stringify(r)));
      const kinds = this.seenHookKinds(X, id);
      tries.push({ attempt, typed, compactions: compactAt.length, midEpoch, compactHook: compactHook.length, resurfaced: kinds.includes('SessionStart'), kinds, reply: !!reply });
      if (midEpoch) break;
    }
    const hit = tries.find((t) => t.midEpoch);
    const detail = tries.map((t) => t.skipped ? `attempt ${t.attempt}: skipped (${t.skipped})`
      : `attempt ${t.attempt}: /compact typed ${t.typed}; compactions ${t.compactions}, mid-epoch ${t.midEpoch}; compact-source SessionStart ${t.compactHook > 0}; re-surface path used ${t.resurfaced} (hookKinds ${t.kinds.join(',') || 'none'}); reply ${t.reply}`).join(' | ');
    this.fact('B7', hit ? 'PASS' : 'GATE-BLOCKED', `RECORD: ${detail}`
      + (hit ? '' : '. No mid-epoch compaction could be forced after one retry: GATE-BLOCKED, god decides.'), this.codexRollouts());
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
    this.check(r.survivors.length === 0, `${label}: every process started is gone (exact PID tree)`, `killed ${r.killed.length}${r.survivors.length ? `; SURVIVORS ${r.survivors.join(',')}` : ''}`);
    this.killReport = (this.killReport || []).concat([{ label, ...r }]);
    await sleep(1500);
  }

  // ── evidence + report ─────────────────────────────────────────────────────
  collectEvidence() {
    const s = this.s;
    const dst = path.join(s.report, 'evidence');
    const never = /(^|[\\/])(auth\.json|\.credentials\.json)$/i;
    const take = (from, rel) => { if (!fs.existsSync(from) || never.test(from)) return; W.copy(from, path.join(dst, rel)); };
    for (const f of walk(s.hive, (p) => /log[^\\/]*\.jsonl$|cost-ledger[^\\/]*\.jsonl$/.test(p) && path.dirname(p) === s.hive)) take(f, path.basename(f));
    for (const f of walk(path.join(s.hive, 'state', 'mail'), () => true)) take(f, path.join('state-mail', path.relative(path.join(s.hive, 'state', 'mail'), f)));
    for (const f of walk(path.join(s.hive, 'agents', IDS.god, 'inbox'), (p) => p.endsWith('.json'))) take(f, path.join('god-inbox', path.relative(path.join(s.hive, 'agents', IDS.god, 'inbox'), f)));
    for (const f of this.claudeTranscripts()) take(f, path.join('claude-transcripts', path.basename(f)));
    for (const f of this.codexRollouts()) take(f, path.join('codex-rollouts', path.basename(f)));
    for (const f of walk(s.stubs, (p) => p.endsWith('.log'))) take(f, path.join('stubs', path.basename(f)));
    W.write(path.join(dst, 'app-output.log'), this.appOut);
    W.writeJson(path.join(dst, 'ledger-history.json'), this.ledgerHistory);
    W.writeJson(path.join(dst, 'samples.json'), this.samples);
    return dst;
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
      models: this.args.models, caps: CAPS, tokens: this.tokens, breakerStop: this.breakerStop || null,
      facts, checks: this.checks, windows: { samples: this.samples.hidden.length, visibleHits: this.procs.visibleHits },
      processes: this.killReport || [], ...extra,
      sandbox: s.base, evidence: extra.evidence
    };
    W.writeJson(path.join(s.report, 'layer-b-report.json'), json);
    const md = [
      `# Layer (b) run — ${json.mode} — ${ok ? 'PASS' : 'NOT PASSED'}`, '',
      `Started ${json.startedAt}, ${Math.round(json.durationMs / 1000)} s.${json.abort ? ` **Aborted: ${json.abort}.**` : ''}`,
      `Models: claude ${this.args.models.claude}, codex ${this.args.models.codex}. Caps: ${CAPS.perAgentTokens} per agent, ${CAPS.totalTokens} total, ${CAPS.wallMs / 60000} min.`, '',
      '| Fact | Status | Detail |', '|---|---|---|',
      ...facts.map((f) => `| ${f.id} | ${f.status} | ${String(f.detail).replace(/\|/g, '/').replace(/\n/g, ' ')} |`), '',
      '## Tokens and cost', '', '| Agent | Used (max of sources) | Ledger | Transcript / rollout | USD (ledger) |', '|---|---|---|---|---|',
      ...[IDS.claude, IDS.codex, IDS.god].map((a) => { const t = this.tokens[a] || {}; return `| ${a} | ${t.used ?? 0} | ${t.ledger ?? 0} | ${t.transcript ?? t.rollout ?? '-'} | ${(t.usd ?? 0).toFixed ? (t.usd ?? 0).toFixed(4) : t.usd} |`; }),
      `| total | ${(this.tokens && this.tokens.total) || 0} | | | |`, '',
      '## Checks', '', ...this.checks.map((c) => `- ${c.ok ? 'PASS' : 'FAIL'} ${c.label}${c.detail ? ` — ${String(c.detail).slice(0, 300)}` : ''}`), '',
      '## Credentials', '', ...(extra.credentials || []).map((c) => `- ${c.label}: copy deleted ${c.deleted}; real file unchanged ${c.unchanged}; the jailed copy changed during the run (token refresh) ${c.changedInJail}`), '',
      `Windows: ${this.samples.hidden.length} hidden-checks, visible hits ${this.procs.visibleHits.length}.`,
      `Evidence: ${extra.evidence}`, `Sandbox: ${s.base}${this.args.keepSandbox ? ' (kept)' : ' (removed)'}`
    ].join('\n');
    W.write(path.join(s.report, 'layer-b-report.md'), md);
    return { ok, json };
  }

  // ── main ──────────────────────────────────────────────────────────────────
  async main() {
    const s = this.layout();
    log(`mode: ${this.args.dryRun ? 'DRY RUN (stub TUIs, zero tokens)' : 'REAL (claude + codex)'}; sandbox ${s.base}`);
    W.allowRoot(s.base);
    W.allowRoot(s.report);
    const { liveUserData } = this.preflight();
    if (!this.args.go) {
      log('preflight OK. Nothing was built or launched (pass --go, with god\'s OK, to run).');
      return 0;
    }
    let result = { ok: false };
    const credResults = [];
    try {
      this.build();
      this.appEnv(liveUserData);
      this.seed();
      this.installCredentials();
      this.factN4();
      this.startedAt = Date.now();
      this.startMonitors();
      await this.launch(this.exe175, '1.1.75 (phase A)');
      await this.openTheConfig();
      await this.assertHidden('after the config opened');
      await this.waitAgentsUp('phase A');
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
      await this.stopApp('final').catch((e) => log(`final kill: ${e.message}`));
      const del = this.creds.deleteAll();
      const real = this.creds.verifyRealUnchanged();
      for (const d of del) credResults.push({ ...d, ...(real.find((r) => r.label === d.label) || {}) });
      for (const c of credResults) {
        this.check(c.deleted, `credentials: the ${c.label} copy is deleted`);
        this.check(c.unchanged, `credentials: the REAL ${c.label} file is unchanged (mtime + size)`, c.real);
      }
      let evidence = null;
      try { evidence = this.collectEvidence(); } catch (e) { log(`evidence: ${e.message}`); }
      result = this.report({ credentials: credResults, evidence });
      if (!this.args.keepSandbox) { try { W.rm(s.base); } catch (e) { log(`sandbox removal: ${e.message}`); } }
    }
    log(`report: ${path.join(s.report, 'layer-b-report.md')}`);
    log(result.ok ? 'LAYER (b): PASS' : 'LAYER (b): NOT PASSED');
    return result.ok ? 0 : 1;
  }
}

module.exports = { b6Tiers, withoutMail, W, liveForbidden, inside, parseArgs, CAPS, Credentials, ProcTracker, stubSource, LayerB, IDS, DEFAULT_MODELS };

if (require.main === module) {
  let lb = null;
  const emergency = (code) => {
    // Synchronous: credentials first, then every pid we know.
    try { if (lb) lb.creds.deleteAll(); } catch { /* best effort */ }
    try { if (lb) lb.procs.killSyncBestEffort(); } catch { /* best effort */ }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { log(`${sig}: cleaning up`); emergency(130); });
  process.on('uncaughtException', (e) => { console.error('[layer-b] uncaught:', e); emergency(1); });
  process.on('unhandledRejection', (e) => { console.error('[layer-b] unhandled:', e); emergency(1); });
  process.on('exit', () => { try { if (lb) lb.creds.deleteAll(); } catch { /* best effort */ } });
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  lb = new LayerB(args);
  lb.main().then((code) => process.exit(code), (e) => { console.error('[layer-b] crashed:', e); emergency(1); });
}
