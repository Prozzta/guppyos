'use strict';
/**
 * ZT-I1-MAIL rig isolation (Dwight's audit 3, god 9b5fc7 / e7e031): the environment every rig
 * process gets is built from an ALLOWLIST, never by subtracting a few known keys from the parent.
 *
 *  - Variables: only the Windows plumbing a process needs (SystemRoot, ComSpec, PATHEXT, ...), the
 *    jailed homes / AppData / TEMP inside the sandbox, and PATH. Nothing else of the parent's reaches
 *    the host, so nothing else reaches any child (stubs, hook shims, sidecars inherit from it).
 *  - PATH: the rig's own bin (the stub shims) FIRST, then a jailed node dir holding ONLY node.exe
 *    (a hard link to this node; the real node dir is not used because an nvm / npm-global node dir
 *    also holds the real claude / codex shims), then the Windows system dirs. No user AppData bin,
 *    no provider install dir, no npm global bin.
 *
 * `checkIsolation` is the fail-fast check the host runs before it loads any product module, and
 * each stub runs on itself: no credential-family variable, no PATH dir outside the sandbox and the
 * Windows system dirs, and no provider command that resolves anywhere but the rig's bin.
 */
const fs = require('node:fs');
const path = require('node:path');

/** Credential families that must never reach a rig process (names, case-insensitive). */
const SECRET_NAME = /(TOKEN|SECRET|PASSW|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|SESSION_?KEY|_KEY$|^KEY$|WEBHOOK|COOKIE|^SLACK_|^ANTHROPIC_|^OPENAI_|^AWS_|^AZURE_|^GOOGLE_|^GCP_|^GEMINI_API|^GH_|^GITHUB_|^NPM_|^HF_|^HUGGING|^XAI_|^GROK_|^MISTRAL_|^COHERE_)/i;
/** The provider CLIs whose real installs must never be reachable by name. */
const PROVIDER_COMMANDS = ['agy', 'codex', 'claude', 'gemini', 'grok', 'opencode', 'cursor-agent', 'qwen'];
/** Parent variables copied as they are (Windows plumbing only; none of them names a user file). */
const PLUMBING = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS'];

const getEnv = (env, name) => { const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase()); return k ? env[k] : undefined; };
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

function systemDirs(env = process.env) {
  const root = getEnv(env, 'SystemRoot') || 'C:\\Windows';
  return [path.join(root, 'System32'), root, path.join(root, 'System32', 'Wbem'), path.join(root, 'System32', 'WindowsPowerShell', 'v1.0')];
}

/**
 * A dir holding ONLY this node's executable (a hard link; a copy if linking fails), shared by every
 * rig of this node version and kept between runs. Not inside a sandbox: a freshly created .exe is
 * held open by the antivirus scan for seconds, which made the sandbox removal fail (EPERM).
 *
 * Keyed by the executable's name as well as the version (RIG-NODE-DIR-SHARED-108): Electron 45 runs
 * as node v24.22.2, the same version as the node leg, so a dir keyed by version alone got
 * electron.exe linked in by an Electron-leg rig, and from then on every node-leg rig refused it
 * ("the node dir holds more than node"). Now each executable has a dir of its own.
 *
 * The Electron leg links a real console node, never electron.exe (RIG-ELECTRON-LEG-NOT-ISOLATED-108).
 * The dir is what the stub CLIs' cmd-shims resolve bare `node` from (rig-host writeShim; PtyManager
 * looks the interpreter up on PATH), and electron.exe cannot be that node: it is a GUI-subsystem
 * program a PTY does not attach, a lone link lacks its sibling DLL / pak / snapshot files, and without
 * ELECTRON_RUN_AS_NODE it starts a real app. It also failed the node-only check below, so every rig
 * file failed whole on the Electron leg. The host itself still runs under Electron (driver.cjs spawns
 * process.execPath with nodeEnv); only the fake provider CLIs run on node, as real CLIs do. The
 * console node comes from consoleNode() (GUPPY_TEST_CONSOLE_NODE, then node on PATH; asserted
 * console-subsystem, not electron.exe, and runs --version); with none it throws by name.
 * `opts` is for the unit pin; the rig calls it bare.
 *
 * On the Electron leg the dir (md-rig-node-<ver>-node) is the node leg's one when the versions match,
 * and the leg must run the node it chose: a dir already holding a DIFFERENT file of that version (another
 * install) is not reused; that node gets a dir keyed by its own real path as well. A keyed dir holding a
 * different file still (the install was replaced in place) throws by name. The node leg runs the same
 * loop with its own execPath (Jim N1): an Electron-leg rig may have seeded the plain dir with its console
 * node, and a node-leg rig must not run that file instead of its own. Where the node leg matched before,
 * it gets the same dir as before.
 */
const isElectron = (versions) => !!(versions && versions.electron);
/** The name the rig's node has inside the node dir (layer-b-core joins it to RIG_NODE_DIR). */
function nodeExeName({ execPath = process.execPath, versions = process.versions } = {}) {
  return isElectron(versions) ? (process.platform === 'win32' ? 'node.exe' : 'node') : path.basename(execPath);
}
const consoleNodeCache = new Map();
/** consoleNode() once per process for the same inputs: it runs `--version` (windowsHide). */
function cachedConsoleNode(opts) {
  const { KEY } = require('../tools/console-node.cjs');
  const k = JSON.stringify([opts.env[KEY] || '', getEnv(opts.env, 'PATH') || '', opts.execPath]);
  if (!consoleNodeCache.has(k)) consoleNodeCache.set(k, require('../tools/console-node.cjs').consoleNode(opts));
  return consoleNodeCache.get(k);
}
/**
 * Same file: one hard link (dev + ino), or the copy fallback (size + mtime; CopyFile keeps mtime).
 * The fallback also applies when both inos are real and differ, so two installs of one version unpacked
 * from the same archive (same size and mtime) count as one file. They are byte-for-byte the same build.
 */
function sameFile(a, b) {
  const x = fs.statSync(a), y = fs.statSync(b);
  if (x.ino && x.ino === y.ino && x.dev === y.dev) return true;
  return x.size === y.size && Math.trunc(x.mtimeMs) === Math.trunc(y.mtimeMs);
}
function linkInto(dir, exe, real) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${exe}.${process.pid}.tmp`;
  try { fs.linkSync(real, tmp); } catch { fs.copyFileSync(real, tmp); }
  try { fs.renameSync(tmp, exe); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* another rig won */ } }
}
function jailedNodeDir({ execPath = process.execPath, versions = process.versions, env = process.env } = {}) {
  const shared = require('../tools/shared-temp.cjs').sharedTemp();
  const name = nodeExeName({ execPath, versions });
  const exeKey = path.basename(name, path.extname(name)).toLowerCase();
  const found = isElectron(versions) ? cachedConsoleNode({ env, execPath, versions }) : { file: execPath, version: process.version, from: 'this Node' };
  const leg = isElectron(versions) ? "the Electron leg's console node" : "the node leg's node";
  const real = fs.realpathSync(found.file);
  const idKey = require('node:crypto').createHash('sha1').update(real.toLowerCase()).digest('hex').slice(0, 8);
  for (const dir of [path.join(shared, `md-rig-node-${found.version}-${exeKey}`), path.join(shared, `md-rig-node-${found.version}-${exeKey}-${idKey}`)]) {
    const exe = path.join(dir, name);
    if (!fs.existsSync(exe)) linkInto(dir, exe, real);
    if (sameFile(exe, real)) return dir;
  }
  throw new Error(`rig: the node dir for ${leg} ${real} (${found.from}) holds a different ${name}; not running a node the leg did not choose`);
}

/** The ENTIRE environment of the rig host (and so of everything under it). */
function rigEnv(sandbox, parent = process.env, nodeOpts = {}) {
  const env = {};
  for (const k of PLUMBING) { const v = getEnv(parent, k); if (v !== undefined) env[k] = v; }
  const home = path.join(sandbox, 'home');
  const tmp = path.join(sandbox, 'tmp');
  const nodeDir = jailedNodeDir({ env: parent, ...nodeOpts });
  for (const d of [home, tmp, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local'), path.join(sandbox, 'rig', 'bin')]) fs.mkdirSync(d, { recursive: true });
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: tmp,
    TMP: tmp,
    // Windows adds these from the logon session when absent; set them to the jail instead.
    HOMEDRIVE: path.parse(home).root.replace(/[\/]+$/, ''),
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    RIG_NODE_DIR: nodeDir,
    CODEX_HOME: path.join(home, '.codex'),
    // Inside the jail, laid out as a real install is (~/.gemini).
    GEMINI_CLI_HOME: path.join(home, '.gemini'),
    PATH: [path.join(sandbox, 'rig', 'bin'), nodeDir, ...systemDirs(parent)].join(path.delimiter)
  });
  return env;
}

/**
 * Throws, naming every problem, unless `env` is isolated for `sandbox`. `allow(name, value)` may
 * accept a credential-family name the rig itself sets (the provider base URLs at the fake LLM).
 */
function checkIsolation(env, sandbox, { allow = () => false, who = 'rig' } = {}) {
  const problems = [];
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k) && !allow(k, v)) problems.push(`secret-shaped variable ${k}`);
  const sys = systemDirs(env).map((d) => d.toLowerCase());
  const nodeDir = getEnv(env, 'RIG_NODE_DIR');
  const dirs = String(getEnv(env, 'PATH') || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    let ok = inside(sandbox, d) || sys.includes(path.resolve(d).toLowerCase());
    if (!ok && nodeDir && path.resolve(d).toLowerCase() === path.resolve(nodeDir).toLowerCase()) {
      // The shared node dir must hold nothing but node itself.
      let names = [];
      try { names = fs.readdirSync(d).filter((n) => !n.endsWith('.tmp')); } catch { names = []; }
      ok = names.length === 1 && /^node(.exe)?$/i.test(names[0]);
      if (!ok) problems.push(`the node dir holds more than node: ${d} (${names.join(', ')})`);
      continue;
    }
    if (!ok) problems.push(`PATH dir outside the sandbox and the system dirs: ${d}`);
  }
  const exts = ['', ...String(getEnv(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)];
  const rigBin = path.join(sandbox, 'rig', 'bin');
  for (const name of PROVIDER_COMMANDS) {
    for (const d of dirs) {
      for (const e of exts) {
        const p = path.join(d, name + e);
        let isFile = false;
        try { isFile = fs.statSync(p).isFile(); } catch { isFile = false; }
        if (isFile && !inside(rigBin, p)) problems.push(`provider command ${name} resolves outside the rig bin: ${p}`);
      }
    }
  }
  if (problems.length) throw new Error(`${who}: not isolated:\n  ${problems.join('\n  ')}`);
  return true;
}

/** The base URLs the host points at its own loopback fake LLM are the only allowed family names. */
const allowRigBaseUrls = (k, v) => /^(OPENAI|ANTHROPIC|GEMINI)_BASE_URL$/i.test(k) && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(String(v));
/** PIPE-HOOK-NO-TOKEN-192: a stub also carries the hook capability the rig's own host minted for
 *  its spawn (32 hex), exactly as a real agent does; no other token-shaped name. */
const allowRigStub = (k, v) => allowRigBaseUrls(k, v) || (k === 'HIVE_HOOK_TOKEN' && /^[0-9a-f]{32}$/i.test(String(v)));

module.exports = { rigEnv, checkIsolation, allowRigBaseUrls, allowRigStub, SECRET_NAME, PROVIDER_COMMANDS, systemDirs, nodeExeName };
