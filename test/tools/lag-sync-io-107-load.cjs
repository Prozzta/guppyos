'use strict';
/**
 * LAG-SYNC-IO-107 load proof (not a test: it prints numbers; `node test/tools/lag-sync-io-107-load.cjs`).
 *
 * Runs the three paths Jim's 1.1.106 stall rows named, on a throwaway hive in the temp folder,
 * while disk-heavy child processes run alongside, and reports how long each held the thread:
 *   1. the `config:integrity` poll
 *   2. tasks.json: an outside process rewrites the ledger; the guard's watch, its listeners
 *      (hive.tasks(), as index.ts hangs on it), a `hive:tasks` poll and the derived writer's
 *      readCards read it
 *   3. the `hive:mailObligations` poll
 * The measurement is the product's own: a real StallWatch (src/main/stallWatch.ts) wrapping a
 * stand-in ipcMain and node:fs, as index.ts starts it. Every slice it records is kept here (its
 * log rows are rate-capped: one per 5 s), plus an independent 25 ms heartbeat for the longest
 * event-loop hold of any cause.
 *
 *   --tree <dir>   the source tree to load (default: this one). A tree with no node_modules of
 *                  its own runs with NODE_PATH pointing at a built tree's node_modules.
 *   --secs <n>     measured seconds (default 60)      --burners <n>  disk-heavy children (default 4)
 *   --label <s>    printed with the result            --json <file>  also write the result there
 * Internal: --burn <dir> (a disk-heavy child), --churn <tasks.json> (the outside ledger writer).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── children ────────────────────────────────────────────────────────────────────────────────
if (arg('burn')) {
  // Disk-heavy: a 96 MB file written in 1 MB chunks and fsync'ed, read back, then 400 small
  // files created, stat'ed and deleted. Forever (the parent kills it).
  const dir = arg('burn');
  fs.mkdirSync(dir, { recursive: true });
  const chunk = Buffer.alloc(1 << 20, 0x5a);
  for (let round = 0; ; round++) {
    const big = path.join(dir, `big-${round % 2}.bin`);
    const fd = fs.openSync(big, 'w');
    for (let i = 0; i < 96; i++) fs.writeSync(fd, chunk);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.readFileSync(big);
    for (let i = 0; i < 400; i++) {
      const f = path.join(dir, `small-${i}.json`);
      fs.writeFileSync(f, '{"n":' + i + '}');
      fs.statSync(f);
      fs.unlinkSync(f);
    }
  }
}
if (arg('churn')) {
  // The outside writer: every 3 s the ledger is replaced (temp file + rename, as an editor or
  // another process does) with one card's title changed and, every other time, a card added.
  const file = arg('churn');
  (async () => {
    for (let n = 1; ; n++) {
      await sleep(3000);
      const ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
      ledger.tasks[n % ledger.tasks.length].title = `retitled ${n}`;
      if (n % 2 === 0) ledger.tasks.push({ id: `CHURN-${n}`, title: `added ${n}`, status: 'todo', tags: ['churn'] });
      const tmp = `${file}.churn-${n}`;
      fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1));
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, file); break; } catch (e) { if (i > 50) throw e; await sleep(20); }
      }
    }
  })();
  return;
}

// ── the measured process ────────────────────────────────────────────────────────────────────
const TREE = path.resolve(arg('tree', path.join(__dirname, '..', '..')));
const SECS = Number(arg('secs', '60'));
const BURNERS = Number(arg('burners', '4'));
const LABEL = arg('label', path.basename(TREE));

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lag107-load-'));
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
if (os.homedir() !== JAIL) throw new Error('HOME is not jailed');
const userData = path.join(JAIL, 'userData');
fs.mkdirSync(userData);
// The stub goes where the TREE's own modules resolve electron (it may differ from this file's).
const treeRequire = require('node:module').createRequire(path.join(TREE, 'src', 'main', 'config.ts'));
const electron = treeRequire.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const loadTs = require(path.join(TREE, 'test', 'load-ts.cjs'));
const cfg = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { StallWatch } = loadTs('src/main/stallWatch.ts');
const derived = loadTs('src/main/claims/derivedWriter.ts');

const children = [];
const child = (...args) => { const c = spawn(process.execPath, [__filename, ...args], { stdio: 'ignore', windowsHide: true }); children.push(c); return c; };
const cleanup = () => {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
};
process.on('exit', cleanup);

const stats = (list) => {
  const s = list.slice().sort((a, b) => a - b);
  const at = (q) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 10) / 10 : 0);
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: s.length ? Math.round(s[s.length - 1] * 10) / 10 : 0 };
};

(async () => {
  // The floor: a config, 12 agents with open requests between them, a ~700 KB ledger.
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ triggersMigratedV1: true, defaultModelCliMigratedV1: true, onboardingComplete: true }));
  const home = path.join(JAIL, 'home');
  fs.mkdirSync(home);
  const hive = new HiveManager(() => home, () => true);
  const agentIds = [];
  for (let i = 0; i < 12; i++) {
    const id = i === 0 ? 'god-1' : `agent-${i}`;
    agentIds.push(id);
    await hive.ensureAgent({ id, name: `Agent ${i}`, provider: 'claude', cwd: home, ...(i === 0 ? { isGod: true } : {}) });
  }
  for (let i = 1; i < agentIds.length; i++) {
    for (let k = 0; k < 3; k++) hive.send({ to: agentIds[i], act: 'request', subject: `Request ${k} for ${agentIds[i]}`, body: 'please' }, 'god-1');
  }
  hive.mail.flushAll();
  const tasksFile = path.join(hive.root(), 'tasks.json');
  const tasks = [];
  for (let i = 0; i < 1500; i++) tasks.push({ id: `LOAD-${i}`, title: `Load card ${i}`, status: i % 3 === 0 ? 'doing' : 'todo', tags: ['load'], description: 'x'.repeat(380) });
  fs.writeFileSync(tasksFile, JSON.stringify({ tasks }, null, 1));
  const ledgerBytes = fs.statSync(tasksFile).size;

  // The product's instrumentation, started as index.ts starts it, before the handlers register.
  const rows = [];
  const watch = new StallWatch({ now: () => performance.now(), origin: performance.timeOrigin, log: (row) => rows.push(row) });
  const slices = [];
  const recordSlice = watch.slice.bind(watch);
  watch.slice = (k, name, start, end) => {
    if (end - start >= 16) { let n = '#'; try { n = name(); } catch { /* keep */ } slices.push({ name: n, ms: end - start }); }
    recordSlice(k, name, start, end);
  };
  const handlers = new Map();
  const ipcMain = { handle(ch, fn) { handlers.set(ch, fn); }, on() {}, removeListener() {}, off() {} };
  watch.start({ ipcMain, fs });

  // The handlers, in the shape index.ts gives them in this tree.
  const asyncPaths = {
    config: typeof cfg.configIntegrityIssueAsync === 'function',
    mail: typeof hive.mailObligationsAsync === 'function',
    cards: typeof derived.readCardsAsync === 'function'
  };
  ipcMain.handle('config:integrity', asyncPaths.config ? () => cfg.configIntegrityIssueAsync() : () => cfg.configIntegrityIssue());
  ipcMain.handle('hive:mailObligations', async () => {
    let agents = [];
    try { agents = asyncPaths.mail ? await hive.mailObligationsAsync() : hive.mailObligations(); } catch { /* as index.ts */ }
    return agents;
  });
  ipcMain.handle('hive:tasks', () => hive.tasks());
  ipcMain.handle('derived:cards', asyncPaths.cards ? () => derived.readCardsAsync(hive.root()) : () => derived.readCards(hive.root()));
  hive.startLedgerGuard();
  let ledgerChanges = 0; let listenerReads = 0;
  hive.ledgerGuard.onChange(() => { ledgerChanges++; });
  // index.ts hangs several board listeners on the guard; each reads the ledger.
  for (let i = 0; i < 3; i++) hive.ledgerGuard.onChange(() => { listenerReads += hive.tasks().tasks.length > 0 ? 1 : 0; });

  // An independent heartbeat: the longest the loop was held, whatever held it.
  const lag = [];
  let lastBeat = performance.now();
  const beat = setInterval(() => { const t = performance.now(); lag.push(Math.max(0, t - lastBeat - 25)); lastBeat = t; }, 25);

  // Load.
  for (let i = 0; i < BURNERS; i++) child('--burn', path.join(JAIL, `burn-${i}`));
  child('--churn', tasksFile);
  await sleep(2000);
  slices.length = 0; rows.length = 0; lag.length = 0;

  const calls = { 'config:integrity': [], 'hive:mailObligations': [], 'hive:tasks': [], 'derived:cards': [] };
  const failures = [];
  const invoke = async (ch) => {
    const t0 = performance.now();
    try { await handlers.get(ch)({}); } catch (e) { failures.push(`${ch}: ${String(e && e.message || e).slice(0, 120)}`); }
    calls[ch].push(performance.now() - t0);
  };
  const end = performance.now() + SECS * 1000;
  let tick = 0;
  while (performance.now() < end) {
    tick++;
    await invoke('config:integrity');
    await invoke('hive:mailObligations');
    await invoke('hive:tasks');
    if (tick % 4 === 0) await invoke('derived:cards');
    await sleep(500);
  }
  clearInterval(beat);
  cleanup();
  watch.stop();

  const byName = {};
  for (const s of slices) (byName[s.name] ||= []).push(s.ms);
  const named = (re) => Object.entries(byName).filter(([n]) => re.test(n)).flatMap(([, v]) => v);
  const result = {
    label: LABEL,
    tree: TREE,
    asyncPaths,
    secs: SECS,
    burners: BURNERS,
    ledgerBytes,
    ledgerChangesSeen: ledgerChanges,
    listenerReads,
    failures: failures.slice(0, 5),
    // Wall time of each call, start to resolved (for an async path this includes waiting on the disk; it holds nothing).
    callWallMs: Object.fromEntries(Object.entries(calls).map(([k, v]) => [k, stats(v)])),
    // Slices the StallWatch recorded (>= 16 ms): time the main thread was HELD.
    sliceMaxMs: {
      'ipc:config:integrity': stats(named(/^ipc:config:integrity$/)).max,
      'statSync:config.json': stats(named(/^statSync:config\.json$/)).max,
      'readFileSync:config.json': stats(named(/^readFileSync:config\.json$/)).max,
      'readFileSync:tasks.json': stats(named(/^readFileSync:tasks\.json$/)).max,
      'statSync:tasks.json': stats(named(/^statSync:tasks\.json$/)).max,
      'ipc:hive:tasks': stats(named(/^ipc:hive:tasks$/)).max,
      'ipc:derived:cards': stats(named(/^ipc:derived:cards$/)).max,
      'ipc:hive:mailObligations': stats(named(/^ipc:hive:mailObligations$/)).max
    },
    slicesByName: Object.fromEntries(Object.entries(byName).map(([k, v]) => [k, stats(v)]).sort((a, b) => b[1].max - a[1].max).slice(0, 16)),
    slicesOver200: slices.filter((s) => s.ms >= 200).length,
    slicesOver100: slices.filter((s) => s.ms >= 100).length,
    mainStallRows: rows.filter((r) => r.kind === 'main-stall').length,
    heartbeatLateMs: stats(lag)
  };
  const out = JSON.stringify(result, null, 1);
  console.log(out);
  if (arg('json')) fs.writeFileSync(arg('json'), out);
  try { hive.dispose(); } catch { /* best effort */ }
  try { loadTs.closeConfigWatchers(); } catch { /* an older tree */ }
  await sleep(500);
  try { fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a burner still held a file: the temp folder is the OS's to clear */ }
  process.exit(0);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
