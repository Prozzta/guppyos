'use strict';
/**
 * CLAIM-LEDGER C4: the Electron-as-Node drill runner (built in W3 for G3.6; W6 reuses it for G6.3
 * and G6.3b). It runs a drill script against ANOTHER build's source tree (a detached worktree of
 * a tag, e.g. v1.1.83) with that tree's own Electron, better-sqlite3, sqlite-vec, onnxruntime and
 * MiniLM model, in a sandbox:
 *   - no installer, no window, no app start: Electron runs as Node (ELECTRON_RUN_AS_NODE=1);
 *   - an ALLOW-LIST env: no HIVE_, AGENT_, MEMORY_, MUNDER_ or CLAUDE_CODE_ variable can leak in;
 *     HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and TMP point into the sandbox home;
 *   - the child asserts the jail BEFORE it loads the drill script;
 *   - the live hive (HIVE_ROOT, C:\Dunder\hive) is refused as a drill hive;
 *   - it FAILS, never skips, when the tree lacks Electron, the model or the vec library (F7).
 * Call it from a `node --test` file so the hive's heavy-job lock covers the run.
 *
 *   runDrill({ tree, hive, home, script, out?, args?, timeoutMs?, needModel? }) -> Promise<result>
 *   needModel: false only for a drill that counts no facts (a ledger drill): then the tree needs no
 *   model and modelLoaded is not required. Every fact-counting drill (G3.6, G6.3) keeps the default.
 *   node test/claims-drill/runner.cjs --tree T --hive H --home D --script S [--out O] [--args JSON]
 *
 * The result is the drill script's return value merged with { ok, checks, reason? }. `ok` needs the
 * script's own ok (not false) AND all three F7 checks: harnessStarted, homeJailed, modelLoaded.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LIVE_HIVES = [process.env.HIVE_ROOT, process.env.MUNDER_HIVE_ROOT, 'C:\\Dunder\\hive'].filter(Boolean);
const LEAK_RE = /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CLAUDE_CODE_|CLAUDE|CTH_|KG_)/i;
const PASS_THROUGH = ['SystemRoot', 'SYSTEMROOT', 'windir', 'SystemDrive', 'PATHEXT', 'ComSpec', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];

function under(p, root) {
  const r = path.relative(path.resolve(root).toLowerCase(), path.resolve(p).toLowerCase());
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** The child's whole environment: an allow-list, never a scrub-list. */
function drillEnv(home, parentEnv = process.env) {
  const env = {};
  for (const k of PASS_THROUGH) if (parentEnv[k] !== undefined) env[k] = parentEnv[k];
  const pk = Object.keys(parentEnv).find((k) => k.toUpperCase() === 'PATH');
  env.PATH = (pk ? parentEnv[pk] : '').split(path.delimiter)
    .filter((d) => d && !/[\\/]Dunder[\\/]hive([\\/]|$)/i.test(d) && !/[\\/]agents[\\/]/i.test(d))
    .join(path.delimiter);
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  env.TEMP = path.join(home, 'tmp');
  env.TMP = env.TEMP;
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

function electronOf(tree) {
  try {
    const p = require(path.join(tree, 'node_modules', 'electron'));
    return typeof p === 'string' ? p : null;
  } catch { return null; }
}

/** What the tree must hold; the first thing missing, or null. */
function treeProblem(tree, needModel = true) {
  if (!fs.existsSync(path.join(tree, 'package.json'))) return 'missing tree (no package.json)';
  const el = electronOf(tree);
  if (!el || !fs.existsSync(el)) return 'missing electron (node_modules/electron)';
  if (!fs.existsSync(path.join(tree, 'test', 'load-ts.cjs'))) return 'missing test/load-ts.cjs';
  const mf = path.join(tree, 'resources', 'models', 'native-memory-manifest.json');
  if (!fs.existsSync(mf)) return 'missing model manifest';
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { return 'unreadable model manifest'; }
  const modelDir = path.join(tree, 'resources', 'models', manifest.model.dir);
  if (needModel && !fs.existsSync(path.join(modelDir, 'onnx', 'model.onnx'))) return 'missing model (onnx/model.onnx)';
  if (needModel && !fs.existsSync(path.join(modelDir, 'tokenizer.json'))) return 'missing model (tokenizer.json)';
  for (const m of ['better-sqlite3', 'sqlite-vec', 'onnxruntime-node', 'typescript']) {
    if (!fs.existsSync(path.join(tree, 'node_modules', m, 'package.json'))) return `missing ${m}`;
  }
  return null;
}

function finish(out, res) {
  try { if (out) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 2)); } } catch { /* the caller still gets res */ }
  return res;
}

async function runDrill(opts) {
  const tree = path.resolve(String(opts.tree || ''));
  const hive = path.resolve(String(opts.hive || ''));
  const home = path.resolve(String(opts.home || ''));
  const script = path.resolve(String(opts.script || ''));
  const out = path.resolve(opts.out || path.join(home, 'drill-result.json'));
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  try { fs.rmSync(out, { force: true }); } catch { /* fresh result */ }
  if (!opts.tree || !opts.hive || !opts.home || !opts.script) return finish(out, { ok: false, reason: 'usage: tree, hive, home and script are required' });
  for (const live of LIVE_HIVES) if (under(hive, live) || under(live, hive)) return finish(out, { ok: false, reason: `refused: ${hive} is (or holds) the live hive` });
  if (path.resolve(home).toLowerCase() === path.resolve(os.homedir()).toLowerCase()) return finish(out, { ok: false, reason: 'refused: home is the real home' });
  if (under(hive, tree) || under(home, tree)) return finish(out, { ok: false, reason: 'refused: the sandbox is inside the tree' });
  if (!fs.existsSync(hive)) return finish(out, { ok: false, reason: `missing hive ${hive} (the drill prepares it)` });
  if (!fs.existsSync(script)) return finish(out, { ok: false, reason: `missing script ${script}` });
  const needModel = opts.needModel !== false;
  const problem = treeProblem(tree, needModel);
  if (problem) return finish(out, { ok: false, reason: problem, tree });
  for (const d of [home, path.join(home, 'tmp'), path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
  const spec = path.join(home, 'drill-spec.json');
  fs.writeFileSync(spec, JSON.stringify({ tree, hive, home, script, out, needModel, args: opts.args ?? {} }, null, 2));
  const env = drillEnv(home);
  const leaked = Object.keys(env).filter((k) => LEAK_RE.test(k));
  if (leaked.length) return finish(out, { ok: false, reason: `env leak ${leaked.join(',')}` });
  const child = path.join(__dirname, 'child.cjs');
  const exit = await new Promise((resolve) => {
    const p = spawn(electronOf(tree), [child, spec], { cwd: tree, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve({ code: null, timedOut: true }); }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: null, error: String(e) }); });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code }); });
  });
  let res;
  try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { res = null; }
  if (!res) return finish(out, { ok: false, reason: exit.timedOut ? `timed out after ${timeoutMs} ms` : `the child wrote no result (exit ${exit.code}${exit.error ? `, ${exit.error}` : ''})` });
  return res;
}

module.exports = { runDrill, drillEnv, treeProblem, under };

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
  runDrill({ tree: get('--tree'), hive: get('--hive'), home: get('--home'), script: get('--script'), out: get('--out'), args: get('--args') ? JSON.parse(get('--args')) : {} })
    .then((r) => { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exitCode = r.ok ? 0 : 1; });
}
