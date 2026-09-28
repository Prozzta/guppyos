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
const os = require('node:os');
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
 */
function jailedNodeDir() {
  const dir = path.join(os.tmpdir(), `md-rig-node-${process.version}`);
  const exe = path.join(dir, path.basename(process.execPath));
  if (fs.existsSync(exe)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${exe}.${process.pid}.tmp`;
  const real = fs.realpathSync(process.execPath);
  try { fs.linkSync(real, tmp); } catch { fs.copyFileSync(real, tmp); }
  try { fs.renameSync(tmp, exe); } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* another rig won */ } }
  return dir;
}

/** The ENTIRE environment of the rig host (and so of everything under it). */
function rigEnv(sandbox, parent = process.env) {
  const env = {};
  for (const k of PLUMBING) { const v = getEnv(parent, k); if (v !== undefined) env[k] = v; }
  const home = path.join(sandbox, 'home');
  const tmp = path.join(sandbox, 'tmp');
  const nodeDir = jailedNodeDir();
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

module.exports = { rigEnv, checkIsolation, allowRigBaseUrls, SECRET_NAME, PROVIDER_COMMANDS, systemDirs };
