'use strict';
/**
 * TEST-BASH-PATH-197: the Git Bash a test runs, found by path and never by a bare `bash`.
 *
 * Why: `spawn('bash', ...)` resolves only when the suite is started from a Git Bash shell. A Claude
 * agent's shell is one; a Codex agent's commands start from PowerShell, where no folder of the
 * machine or user PATH holds bash.exe (Git for Windows puts only Git\cmd there). The same test then
 * failed with `spawn bash ENOENT` (heavy-lock-release-lag-197: 9 of 45, on any branch), or skipped
 * without a word. A bare name can also resolve to WSL's System32\bash.exe, which does not share
 * this filesystem's paths.
 *
 * The product has no locator of its own (it never spawns bash), so the order is this file's:
 *   1. CLAUDE_CODE_GIT_BASH_PATH, the variable Claude Code itself reads, when it names a file;
 *   2. the standard installs: %ProgramFiles%, %ProgramW6432%, %ProgramFiles(x86)% and
 *      %LOCALAPPDATA%\Programs, each \Git\bin\bash.exe;
 *   3. beside a git.exe on PATH (Git\cmd\git.exe or Git\bin\git.exe -> Git\bin\bash.exe);
 *   4. a bash.exe on PATH that is not Windows' own (System32, WindowsApps: WSL), preferring the
 *      install's bin\bash.exe over its usr\bin\bash.exe.
 * bin\bash.exe is the launcher: it gives the shell Git's PATH (usr\bin, mingw64\bin), which
 * usr\bin\bash.exe started from a Windows process does not have.
 *
 * Off Windows the answer is `bash`: it is part of the system there.
 */
const fs = require('node:fs');
const path = require('node:path');

const WINDOWS_OWN = /\\(system32|sysnative|syswow64|windowsapps)\\?$/i;

/** Env lookup that ignores case, as Windows does (a spread copy of process.env loses that). */
function envOf(env, name) {
  if (env[name] !== undefined) return env[name];
  const k = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : env[k];
}

/** Every path probed, in order, with why. Pure: `exists` is asked only by findGitBash. */
function candidates(env = process.env) {
  const w = path.win32;
  const out = [];
  // `needs`: a file that must exist for the candidate to count. Such a candidate never shadows a
  // later unconditional one for the same path.
  const add = (file, why, needs) => {
    if (file && !out.some((c) => !c.needs && c.file.toLowerCase() === file.toLowerCase())) out.push(needs ? { file, why, needs } : { file, why });
  };
  const named = envOf(env, 'CLAUDE_CODE_GIT_BASH_PATH');
  if (named) add(w.normalize(named), 'CLAUDE_CODE_GIT_BASH_PATH');
  for (const v of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    const base = envOf(env, v);
    if (base) add(w.join(base, 'Git', 'bin', 'bash.exe'), `%${v}%`);
  }
  const local = envOf(env, 'LOCALAPPDATA');
  if (local) add(w.join(local, 'Programs', 'Git', 'bin', 'bash.exe'), '%LOCALAPPDATA%\\Programs');
  const dirs = String(envOf(env, 'PATH') || '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  for (const d of dirs) add(w.join(d, '..', 'bin', 'bash.exe'), `beside git.exe in ${d}`, w.join(d, 'git.exe'));
  for (const d of dirs) {
    if (WINDOWS_OWN.test(d.replace(/\\?$/, '\\'))) continue;
    if (/\\usr\\bin\\?$/i.test(d)) add(w.join(d, '..', '..', 'bin', 'bash.exe'), `the launcher of ${d}`);
    add(w.join(d, 'bash.exe'), `PATH ${d}`);
  }
  return out;
}

/** { file, why, probed } for the first candidate that exists; file is null when none does. */
function findGitBash({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  if (platform !== 'win32') return { file: 'bash', why: 'not Windows: bash is part of the system', probed: [] };
  const probed = [];
  for (const c of candidates(env)) {
    // "beside git.exe" holds only where a git.exe is: any PATH folder has a ..\bin.
    if (c.needs && !exists(c.needs)) continue;
    if (!probed.includes(c.file)) probed.push(c.file);
    if (exists(c.file)) return { file: c.file, why: c.why, probed };
  }
  return { file: null, why: null, probed };
}

/** The path, or a throw that says what was tried: a test that needs bash fails, it does not skip. */
function gitBash(opts) {
  const r = findGitBash(opts);
  if (r.file) return r.file;
  throw new Error(
    'Git Bash not found: this test runs a real bash and does not take one from PATH by bare name. ' +
    'Install Git for Windows, or set CLAUDE_CODE_GIT_BASH_PATH to its bin\\bash.exe. ' +
    `Probed (${r.probed.length}): ${r.probed.join('; ') || 'nothing: no ProgramFiles, LOCALAPPDATA or PATH in the environment'}`
  );
}

module.exports = { gitBash, findGitBash, candidates };
