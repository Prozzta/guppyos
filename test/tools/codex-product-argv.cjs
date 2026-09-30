'use strict';
/**
 * god (on the codex git-window research): a Codex agent outside the app (a repro, a probe) must run
 * with the argv the PRODUCT builds, never a hand-written copy. This module builds it with the
 * product's own code, loaded from src/ (test/load-ts.cjs), in the order spawnAgentCore uses:
 *
 *   tokenizeCommand(command)                 src/shared/commandLine.ts (useHive restore splits so)
 *   resolveSpawnArgs(entry, args, modelFlag) src/shared/modelPin.ts     (MODEL-PINBACK)
 *   codexSupportsNoDaemon(readCodexVersion)  src/main/codexCli.ts       (CODEX-WAKE-161 gate)
 *   HiveManager.ensureAgent(..., {codexNoDaemon, spawnModel})  src/main/hive.ts
 *   args = [...args, ...inj.args]; env += inj.env + nonInteractiveEnvForProvider('codex')
 *
 * The result is BRANDED (a module-private WeakSet): codexArgvProblems() refuses any argv that did not
 * come out of productCodexSpawn(), a hand-written array or a copy of a real one included, and any
 * argv without exactly one --no-daemon. Every repro helper calls assertProductCodexArgv() right before
 * its spawn.
 *
 * HOME/USERPROFILE MUST already point at the repro's own home (the probe-home rule): ensureAgent reads
 * ~/.codex (auth, config, packages) through os.homedir(). Checked before any hive object is built.
 */
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');

const BRAND = new WeakSet();
/** The product adds this to every Codex hive spawn (hive.ts: installCodexHooks path). */
const PRODUCT_CODEX_MARKER = '--dangerously-bypass-hook-trust';
const NO_DAEMON = '--no-daemon';
const LIVE_ROOTS = ['C:\\Dunder\\hive', 'C:\\Dunder\\MunderDevData', 'C:\\Dunder\\palace'];
const low = (p) => path.resolve(p).toLowerCase();
const within = (p, root) => low(p) === low(root) || low(p).startsWith(`${low(root)}${path.sep}`);

function product() {
  return {
    ...loadTs('src/shared/commandLine.ts'),
    ...loadTs('src/shared/modelPin.ts'),
    ...loadTs('src/main/codexCli.ts'),
    ...loadTs('src/shared/agentProvider.ts'),
    HiveManager: loadTs('src/main/hive.ts').HiveManager
  };
}

/**
 * The product's argv + env for one Codex hive agent.
 * @param {{home: string, harnessHome: string, agentId: string, name: string, cwd: string, command: string, commandPath: string}} o
 */
async function productCodexSpawn(o) {
  for (const k of ['home', 'harnessHome', 'agentId', 'name', 'cwd', 'command', 'commandPath']) {
    if (!o || typeof o[k] !== 'string' || !o[k]) throw new Error(`productCodexSpawn: ${k} is required`);
  }
  if (low(os.homedir()) !== low(o.home) || low(process.env.USERPROFILE || '') !== low(o.home)) {
    throw new Error(`productCodexSpawn: HOME/USERPROFILE must be redirected to ${o.home} first (os.homedir() = ${os.homedir()})`);
  }
  for (const p of [o.home, o.harnessHome, o.cwd]) {
    const live = LIVE_ROOTS.find((r) => within(p, r) || within(r, p));
    if (live) throw new Error(`productCodexSpawn: ${p} overlaps the live ${live}`);
  }
  const P = product();
  const [exe, ...requestArgs] = P.tokenizeCommand(o.command.trim());
  if (P.inferAgentProvider(o.command) !== 'codex') throw new Error(`productCodexSpawn: not a codex command: ${o.command}`);
  const version = P.readCodexVersion(o.commandPath);
  const codexNoDaemon = P.codexSupportsNoDaemon(version);
  const hive = new P.HiveManager(() => o.harnessHome);
  try {
    const pin = P.resolveSpawnArgs(hive.registry().agents[o.agentId], requestArgs, { flag: P.providerPreset('codex').modelFlag || '--model' });
    const inj = await hive.ensureAgent(
      { id: o.agentId, name: o.name, provider: 'codex', cwd: o.cwd },
      { codexNoDaemon, spawnModel: { requested: pin.requested, launch: pin.launch } }
    );
    if (inj.refusal) throw new Error(`productCodexSpawn: the product refused the spawn: ${inj.refusal}`);
    const env = { ...inj.env, ...P.nonInteractiveEnvForProvider('codex') };
    const spec = Object.freeze({
      exe, args: Object.freeze([...pin.args, ...inj.args]), env: Object.freeze(env), cwd: o.cwd, version, codexNoDaemon,
      hiveSock: env.HIVE_SOCK || null
    });
    BRAND.add(spec);
    return spec;
  } finally {
    try { hive.dispose(); } catch { /* best-effort */ }
  }
}

/** Why this argv may NOT be used for a repro ([] = it may). */
function codexArgvProblems(spec) {
  const p = [];
  if (!spec || typeof spec !== 'object' || !BRAND.has(spec)) p.push('the argv was not built by the product (productCodexSpawn): a hand-written or copied argv is refused');
  const args = spec && Array.isArray(spec.args) ? spec.args : [];
  const n = args.filter((a) => a === NO_DAEMON).length;
  if (n !== 1) p.push(`${NO_DAEMON} appears ${n} times (exactly 1 required: the product runs Codex without the detached daemon)`);
  if (!args.includes(PRODUCT_CODEX_MARKER)) p.push(`no ${PRODUCT_CODEX_MARKER}: not the product's Codex hive argv`);
  if (spec && spec.codexNoDaemon !== true) p.push(`the product gate did not grant ${NO_DAEMON} (codex version ${spec && spec.version})`);
  return p;
}
function assertProductCodexArgv(spec) {
  const p = codexArgvProblems(spec);
  if (p.length) throw new Error(`refusing the Codex spawn: ${p.join('; ')}`);
  return spec;
}

/** How the product's PtyManager starts that argv on Windows: the npm shim decoded by the PRODUCT's
 *  parseNpmCmdShim (src/main/pty.ts), the interpreter found on PATH (as its resolver does), then
 *  pty.spawn(interpreter, [script, ...args]). Only for a spec the guard accepts. */
function productLaunch(spec, commandPath, pathEnv = process.env.PATH || '') {
  assertProductCodexArgv(spec);
  const fs = require('node:fs');
  const { parseNpmCmdShim } = loadTs('src/main/pty.ts');
  const t = parseNpmCmdShim(commandPath, fs.readFileSync(commandPath, 'utf8'));
  if (!t) throw new Error(`productLaunch: the product cannot decode the shim ${commandPath} (it would fall back to cmd.exe)`);
  if (t.interpreter === null) return { file: t.scriptPath, args: [...spec.args] };
  const exts = t.interpreter.includes('.') ? [''] : ['.exe', '.cmd', ''];
  for (const d of String(pathEnv).split(path.delimiter).filter(Boolean)) {
    for (const e of exts) {
      const f = path.join(d, `${t.interpreter}${e}`);
      if (fs.existsSync(f) && fs.statSync(f).isFile()) return { file: f, args: [t.scriptPath, ...spec.args] };
    }
  }
  throw new Error(`productLaunch: ${t.interpreter} is not on PATH`);
}

/** The env the product's PtyManager gives a spawned agent: src/main/ptyEnv.ts buildPtyEnv(parent env,
 *  the user PATH, the agent env), as pty.ts:699 calls it (win32; no memory PATH prepend here). */
function productPtyEnv(parentEnv, agentEnv = {}) {
  const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');
  const pk = Object.keys(parentEnv).find((k) => k.toUpperCase() === 'PATH');
  return buildPtyEnv(parentEnv, pk ? parentEnv[pk] : '', agentEnv, 'win32', []);
}

module.exports = { productPtyEnv, productCodexSpawn, codexArgvProblems, assertProductCodexArgv, productLaunch, PRODUCT_CODEX_MARKER, NO_DAEMON };
