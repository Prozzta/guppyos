'use strict';
/**
 * god GO only (--go): the zero-token Codex exit repro with the PRODUCT's exact argv.
 *
 *   node test/tools/codex-exit-repro.cjs --go --out <report.md>     (under run-clean.cjs)
 *
 * - The argv and env come from the product's own builder (codex-product-argv.cjs): tokenizeCommand,
 *   resolveSpawnArgs, codexSupportsNoDaemon(readCodexVersion), HiveManager.ensureAgent; the guard
 *   refuses anything else, and anything without --no-daemon. The launch is the product's shim decode.
 * - A NEW short home C:\Dunder\lbj\<8 hex>\{h,d,w}; HOME/USERPROFILE redirected to it BEFORE any
 *   product object is built; its ~/.codex holds the runner's jail config and NO auth.json.
 * - Hidden ConPTY (node-pty), scrubbed env (HIVE_*, AGENT_*, MEMORY_*, CODEX_*, keys, tokens).
 * - The window watch is ARMED (first good line) BEFORE the spawn. The FIRST visible window, browser
 *   or crash dialog: kill the tree at once, clean up, report. No retry.
 * - The PTY text is recorded until the exit or 60 s, then the exact tree is killed. Nothing is typed,
 *   except the product's Codex wake (payloadFor(CODEX_INBOX_WAKE_SENTINEL) then Enter), ONCE, after
 *   the screen settled on the composer; never on a sign-in screen (Enter there can open a browser).
 * - Afterwards: the home is deleted and verified gone; no process of the recorded tree, and none
 *   with the home in its command line, is left (the query is -EncodedCommand and excludes itself).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
if (!argv.includes('--go')) { console.error('codex-exit-repro: refused without --go (god GO only)'); process.exit(2); }
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null;
if (!OUT) { console.error('codex-exit-repro: --out <report.md> is required'); process.exit(2); }

const lb = require('./layer-b-run.cjs');
const pa = require('./codex-product-argv.cjs');
const loadTs = require('../load-ts.cjs');
const pty = require(path.join(REPO, 'node_modules', 'node-pty'));

const LBJ = 'C:\\Dunder\\lbj';
const RUN_MS = 60_000;
const id = crypto.randomBytes(4).toString('hex');
const base = path.join(LBJ, id);
if (!lb.RUN_DIR.test(path.basename(base)) || path.dirname(base) !== LBJ) throw new Error(`bad base ${base}`);
const home = path.join(base, 'h');
const harnessHome = path.join(base, 'd');
const cwd = path.join(base, 'w');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => String(s).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Za-z0-9]/g, '').replace(/\x1b[=>78DEHMNOZc]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const ps = (script) => spawnSync(PS, lb.psArgs(script), { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });

const rec = { id, base, events: [], output: '', exit: null, aborted: null, typed: null, tree: {}, killed: [], survivors: [], leftovers: null, gone: null };
const t0 = Date.now();
const ev = (what) => { rec.events.push(`+${Date.now() - t0} ms ${what}`); };

/** The live tree under `pid` (pid -> name), merged into rec.tree (the EXACT set we may kill). */
function snapshotTree(pid) {
  const r = ps(`$ErrorActionPreference='Stop'
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name)
$ids = @(${Number(pid)}); $changed = $true
while ($changed) { $changed = $false; foreach ($p in $all) { if (($ids -contains $p.ParentProcessId) -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $changed = $true } } }
ConvertTo-Json -Compress -InputObject @($all | Where-Object { $ids -contains $_.ProcessId } | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name } })`);
  if (r.status !== 0) return [];
  let list = [];
  try { list = JSON.parse(String(r.stdout || '[]').trim() || '[]'); } catch { return []; }
  for (const x of list) rec.tree[x.pid] = x.name;
  return list;
}
/** Processes still alive from the recorded tree (same pid AND name: a reused pid is not ours), plus
 *  any with the home's path in its command line. -EncodedCommand: the path is not in OUR command line,
 *  and our own PowerShell ($PID) is excluded anyway. */
function leftovers() {
  const pids = Object.keys(rec.tree).map(Number);
  const r = ps(`$ErrorActionPreference='Stop'
$base = '${base.replace(/'/g, "''")}'
$tree = @{ ${pids.map((p) => `${p} = '${String(rec.tree[p]).replace(/'/g, "''")}'`).join('; ')} }
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine)
$hit = @($all | Where-Object { $_.ProcessId -ne $PID -and (($tree.ContainsKey([int]$_.ProcessId) -and $tree[[int]$_.ProcessId] -eq $_.Name) -or ($_.CommandLine -and $_.CommandLine.IndexOf($base, [StringComparison]::OrdinalIgnoreCase) -ge 0)) } | ForEach-Object { @{ pid = $_.ProcessId; name = $_.Name } })
ConvertTo-Json -Compress -InputObject $hit`);
  if (r.status !== 0) return { error: String(r.stderr || '').slice(0, 300) };
  try { return JSON.parse(String(r.stdout || '[]').trim() || '[]'); } catch (e) { return { error: e.message }; }
}
function killTree(p, why) {
  if (rec.killedAt) return;
  rec.killedAt = Date.now() - t0;
  const list = snapshotTree(p.pid);
  spawnSync('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
  for (const x of list) spawnSync('taskkill.exe', ['/PID', String(x.pid), '/F'], { windowsHide: true, timeout: 15_000, stdio: 'ignore' });
  try { p.kill(); } catch { /* gone */ }
  rec.killed = list;
  ev(`killed the tree (${why}): ${JSON.stringify(list)}`);
}

function scrubbedEnv(specEnv) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(HIVE_|AGENT_|MEMORY_|CODEX_|OPENAI|ANTHROPIC|CLAUDE|MUNDER_|KG_)|_API_KEY$|TOKEN|SECRET/i.test(k)) continue;
    env[k] = v;
  }
  const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (pk) env[pk] = env[pk].split(';').filter((d) => d && !/\\Dunder\\(hive|MunderDevData|palace)|\\\.munder|\\harness\\/i.test(d)).join(';');
  return { ...env, ...specEnv, HOME: home, USERPROFILE: home };
}
function whichCodexCmd() {
  for (const d of String(process.env.PATH || '').split(';').filter(Boolean)) {
    const f = path.join(d, 'codex.cmd');
    if (fs.existsSync(f)) return f;
  }
  throw new Error('codex.cmd is not on PATH');
}

async function main() {
  for (const d of [path.join(home, '.codex'), harnessHome, cwd]) fs.mkdirSync(d, { recursive: true });
  // Probe-home rule: redirect + assert BEFORE any product object exists.
  process.env.HOME = home; process.env.USERPROFILE = home;
  if (path.resolve(os.homedir()).toLowerCase() !== path.resolve(home).toLowerCase()) throw new Error('HOME redirect failed');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), lb.codexSandboxToml([cwd]));
  const commandPath = whichCodexCmd();
  const command = lb.lbCodexCommand(lb.DEFAULT_MODELS.codex);   // the runner's lb-codex registry command
  const spec = pa.assertProductCodexArgv(await pa.productCodexSpawn({ home, harnessHome, agentId: 'lb-codex', name: 'Codex-LB', cwd, command, commandPath }));
  const launch = pa.productLaunch(spec, commandPath);
  const codexHome = spec.env.CODEX_HOME;
  for (const f of [path.join(home, '.codex', 'auth.json'), path.join(codexHome, 'auth.json')]) if (fs.existsSync(f)) throw new Error(`a credential exists (${f}): refusing`);
  const env = scrubbedEnv(spec.env);
  const hn = loadTs('src/shared/hiveNudge.ts');
  const as = loadTs('src/main/automaticSubmit.ts');
  const wake = as.payloadFor(hn.CODEX_INBOX_WAKE_SENTINEL);
  Object.assign(rec, { commandPath, command, version: spec.version, file: launch.file, args: launch.args, cwd, codexHome, envKeys: Object.keys(spec.env).sort(), sockets: lb.codexSocketPaths(codexHome).map((x) => `${x.length} ${x}`) });

  // The window watch: armed (a first good line) BEFORE the spawn.
  let p = null;
  const watch = new lb.WindowWatch(process.pid, {
    onHit: (why) => { if (!rec.aborted) { rec.aborted = `visible window: ${why}`; ev(`ABORT ${rec.aborted}`); if (p) killTree(p, 'window'); } },
    onBlind: (why) => { if (!rec.aborted) { rec.aborted = `window watch blind: ${why}`; ev(`ABORT ${rec.aborted}`); if (p) killTree(p, 'blind'); } }
  }).start();
  const armEnd = Date.now() + 30_000;
  while (!watch.healthy() && Date.now() < armEnd && !rec.aborted) await sleep(200);
  if (!watch.healthy()) { watch.stop(); throw new Error('the window watch never armed: nothing spawned'); }
  ev('window watch armed');

  let exited = null;
  let lastData = Date.now();
  try {
    p = pty.spawn(launch.file, launch.args, { name: 'xterm-256color', cols: 120, rows: 30, cwd, env });
    ev(`spawned pid ${p.pid}: ${launch.file} [${launch.args.length} args]`);
    p.onData((d) => { rec.output += d; lastData = Date.now(); });
    p.onExit(({ exitCode, signal }) => { exited = { exitCode, signal, atMs: Date.now() - t0 }; ev(`EXIT code ${exitCode} signal ${signal}`); });
    const end = t0 + RUN_MS;
    let nextSnap = 0;
    while (!exited && !rec.aborted && Date.now() < end) {
      if (Date.now() >= nextSnap) { snapshotTree(p.pid); nextSnap = Date.now() + 2000; }
      const text = strip(rec.output);
      const composer = /Ask Codex|›/.test(text);
      const signIn = /Sign in|API key|Welcome to Codex|Log ?in/i.test(text);
      if (!rec.typed && composer && Date.now() - lastData > 3000 && Date.now() - t0 > 8000) {
        if (signIn) { rec.typed = { skipped: 'a sign-in screen is up: Enter could open a browser' }; ev('wake NOT typed: sign-in screen'); }
        else {
          rec.typed = { text: hn.CODEX_INBOX_WAKE_SENTINEL, payload: JSON.stringify(wake), atMs: Date.now() - t0, screenBefore: text.slice(-1500) };
          p.write(wake); ev(`typed the product wake ${JSON.stringify(wake)}`);
          await sleep(150);
          p.write('\r'); ev('typed Enter');
        }
      }
      await sleep(200);
    }
    if (!exited && !rec.aborted) ev(`no exit in ${RUN_MS / 1000} s`);
  } finally {
    if (p && !exited) killTree(p, exited ? 'exited' : 'end of run');
    else if (p) snapshotTree(p.pid);
    await sleep(1500);
    rec.survivors = Object.keys(rec.tree).map(Number).filter((pid) => {
      const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
      return String(r.stdout || '').split(/\r?\n/).some((line) => {
        const f = line.split('","').map((x) => x.replace(/^"|"$/g, ''));
        return f.length > 1 && f[0].toLowerCase() === String(rec.tree[pid]).toLowerCase() && Number(f[1]) === pid;
      });
    });
    watch.stop();
    rec.exit = exited;
    rec.windowHits = watch.hits;
  }
}

(async () => {
  let err = null;
  try { await main(); } catch (e) { err = e; rec.error = e.stack || e.message; }
  for (let i = 0; i < 8 && fs.existsSync(base); i++) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { await sleep(1000); } }
  rec.gone = !fs.existsSync(base);
  rec.leftovers = leftovers();
  const text = lb.redact(strip(rec.output));
  const md = [
    '# Codex exit repro with the PRODUCT argv (zero tokens)', '',
    `- Run dir ${base} (deleted: ${rec.gone}). codex ${rec.version || '?'} via ${rec.commandPath || '?'}.`,
    `- Product command: \`${rec.command || '?'}\``,
    `- Product launch: \`${rec.file || '?'}\` ${JSON.stringify(rec.args || [])}`,
    `- cwd ${rec.cwd || '?'}; CODEX_HOME ${rec.codexHome || '?'}; product env keys: ${(rec.envKeys || []).join(', ')}`,
    `- Aborted: ${rec.aborted || 'no'}. Error: ${rec.error ? rec.error.split('\n')[0] : 'none'}`,
    `- Exit: ${JSON.stringify(rec.exit)}${rec.exit ? '' : ` (no exit within ${RUN_MS / 1000} s, or killed)`}`,
    `- Typed: ${JSON.stringify(rec.typed ? { ...rec.typed, screenBefore: undefined } : 'nothing')}`,
    `- Window-watch hits: ${JSON.stringify(rec.windowHits || [])}`,
    `- Tree seen: ${JSON.stringify(rec.tree)}; killed: ${JSON.stringify(rec.killed)}; survivors: ${JSON.stringify(rec.survivors)}`,
    `- Leftover processes (tree pid+name, or the run dir in the command line; self-excluded): ${JSON.stringify(rec.leftovers)}`,
    '', '## Events', ...rec.events.map((e) => `- ${e}`), '',
    ...(rec.typed && rec.typed.screenBefore ? ['## Screen before the wake (ANSI stripped, redacted)', '```', lb.redact(rec.typed.screenBefore), '```', ''] : []),
    '## PTY text (ANSI stripped, redacted; last 12 KB)', '```', text.slice(-12_000), '```', ''
  ].join('\n');
  fs.writeFileSync(OUT, md);
  console.log(JSON.stringify({ aborted: rec.aborted, error: err && err.message, exit: rec.exit, typed: rec.typed && (rec.typed.text || rec.typed.skipped), gone: rec.gone, survivors: rec.survivors, leftovers: rec.leftovers, hits: rec.windowHits }, null, 1));
  process.exit(err ? 1 : 0);
})();
