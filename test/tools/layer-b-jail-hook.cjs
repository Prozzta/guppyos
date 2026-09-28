'use strict';

/**
 * ZT-I1-MAIL layer (b), R1 (Jim) + god c0a73f (a): the HARD jail for the real Claude agent.
 *
 * A Claude Code PreToolUse hook, installed by test/tools/layer-b-run.cjs in the JAILED user
 * settings (~/.claude/settings.json inside the sandbox; the product's own --settings file adds its
 * hooks beside it, and Claude runs both). Claude's docs: "PreToolUse hooks fire before any
 * permission-mode check, in every permission mode ... A hook that returns deny blocks the tool even
 * in bypassPermissions mode." So the product keeps its normal Claude arguments
 * (--permission-mode bypassPermissions) and this hook is the guarantee; the permissions.deny rules
 * the runner writes beside it are a second, independent layer.
 *
 * Policy (a JSON file, argv[2]; it lives OUTSIDE every root the agent may write):
 *   writeRoots   Write/Edit/MultiEdit/NotebookEdit only inside these;
 *   readRoots    Read/Glob/Grep/LS/NotebookRead and any absolute path in a shell command only inside
 *                these (the whole sandbox);
 *   protect      path segments that are denied even inside the roots (.claude, .codex, settings,
 *                credentials): the agent can never edit its own jail or read a login;
 *   home         the jailed HOME, for ~ expansion;
 *   log          optional: one JSON line per decision (evidence).
 * Shell commands (Bash, PowerShell) are checked textually: every absolute path they name must be
 * inside readRoots and unprotected, and home/env/UNC/parent-escape/POSIX-drive forms, network
 * downloaders and window-openers are denied outright. WebFetch/WebSearch are denied (not needed).
 * Everything else (the product's mcp__ tools, TodoWrite, Task ...) is allowed: their own file and
 * shell calls come back through this hook.
 *
 * Deny = exit code 2 with the reason on stderr (the documented blocking form). Any error = deny
 * (fail closed). Allow = exit 0, no output.
 */
const fs = require('node:fs');
const path = require('node:path');

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const NET_TOOLS = new Set(['WebFetch', 'WebSearch']);
const W32 = path.win32;

/** Canonical (lower-case, resolved, symlinks/junctions followed where the path exists). */
function canon(p) {
  let probe = W32.resolve(p);
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const real = fs.realpathSync.native(probe);
      return W32.join(real, ...tail.reverse()).replace(/[\\/]+$/, '').toLowerCase();
    } catch {
      const parent = W32.dirname(probe);
      if (parent === probe) break;
      tail.push(W32.basename(probe));
      probe = parent;
    }
  }
  return W32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}
const within = (p, roots) => { const c = canon(p); return roots.some((r) => { const rc = canon(r); return c === rc || c.startsWith(rc + '\\'); }); };
const protectedPath = (p, policy) => {
  const segs = W32.resolve(p).toLowerCase().split(/[\\/]+/);
  return (policy.protect || []).some((name) => segs.includes(String(name).toLowerCase()));
};

function resolveArg(p, policy, cwd) {
  let s = String(p || '').trim();
  if (!s) return null;
  if (s === '~' || /^~[\\/]/.test(s)) s = W32.join(policy.home, s.slice(1));
  if (/^\/[a-zA-Z]\//.test(s)) return { bad: `POSIX drive path ${s}` };      // /c/Users/... (Git Bash form)
  if (/^\\\\|^\/\//.test(s)) return { bad: `UNC path ${s}` };
  return { abs: W32.isAbsolute(s) && /^[A-Za-z]:/.test(s) ? W32.resolve(s) : W32.resolve(cwd, s) };
}

/** A shell command: every absolute path inside readRoots and unprotected; risky forms refused. */
function checkShell(cmd, policy, cwd) {
  const text = String(cmd || '');
  const refuse = [
    [/(^|[\s"'=(;|&])~(?=[\\/\s"']|$)/, 'the home directory (~)'],
    [/\$HOME\b|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|%APPDATA%|%LOCALAPPDATA%|\$env:/i, 'a home/profile variable'],
    [/(^|[\s"'=])\/[a-zA-Z]\//, 'a POSIX drive path (/c/...)'],
    [/\\\\[^\s\\]+\\|(^|[\s"'])\/\/[^\s/]/, 'a UNC path'],
    [/(^|[\\/\s"'])\.\.([\\/\s"']|$)/, 'a parent-directory escape (..)'],
    [/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer|certutil|bitsadmin)\b/i, 'a network download'],
    [/\b(start|explorer(\.exe)?|Start-Process|rundll32|mshta|msedge|chrome|firefox|cmd\s+\/c\s+start)\b/i, 'a window/app launcher'],
    [/\b(mklink|New-Item\s+[^|]*-ItemType\s+(SymbolicLink|Junction)|ln\s+-s)\b/i, 'a link (could escape the jail)'],
    [/\b(setx|reg(\.exe)?\s+(add|delete)|Set-ItemProperty)\b/i, 'a registry/env write']
  ];
  for (const [re, what] of refuse) if (re.test(text)) return `the command uses ${what}`;
  const drives = text.match(/[A-Za-z]:[\\/][^\s"'|;&<>`]*/g) || [];
  for (const d of drives) {
    if (!within(d, policy.readRoots)) return `the command names ${d}, outside the sandbox`;
    if (protectedPath(d, policy)) return `the command names ${d}, a protected jail file`;
  }
  // Absolute POSIX paths other than /dev/null (e.g. /tmp, /usr, /etc) are outside the jail.
  const posix = text.match(/(^|[\s"'=<>|;&])\/(?!dev\/null\b)[A-Za-z0-9_.-][^\s"'|;&<>]*/g) || [];
  if (posix.length) return `the command names ${posix[0].trim()}, outside the sandbox`;
  const names = (policy.protect || []).filter((n) => new RegExp(`(^|[\\\\/\\s"'])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\\\/\\s"']|$)`, 'i').test(text));
  if (names.length) return `the command names the protected ${names[0]}`;
  if (!within(cwd, policy.readRoots)) return `the shell starts outside the sandbox (${cwd})`;
  return null;
}

/** The decision for one PreToolUse payload: null = allow, a string = the deny reason. */
function decide(payload, policy) {
  if (!payload || typeof payload !== 'object') return 'unreadable hook payload';
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : policy.home;
  if (NET_TOOLS.has(tool)) return `${tool} is not allowed in the layer-b jail`;
  if (SHELL_TOOLS.has(tool)) return checkShell(input.command, policy, cwd);
  if (WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    const raw = input.file_path ?? input.notebook_path ?? input.path ?? (READ_TOOLS.has(tool) ? cwd : null);
    const r = resolveArg(raw, policy, cwd);
    if (!r) return `${tool} without a path`;
    if (r.bad) return `${tool}: ${r.bad}`;
    const roots = WRITE_TOOLS.has(tool) ? policy.writeRoots : policy.readRoots;
    if (!within(r.abs, roots)) return `${tool} outside the jail: ${r.abs}`;
    if (protectedPath(r.abs, policy)) return `${tool} on a protected jail file: ${r.abs}`;
    // A Glob pattern may itself be absolute.
    if (tool === 'Glob' && typeof input.pattern === 'string' && /^[A-Za-z]:[\\/]|^[\\/~]/.test(input.pattern)) {
      const pr = resolveArg(input.pattern.replace(/[*?[{].*$/, ''), policy, cwd);
      if (!pr || pr.bad || !within(pr.abs, roots)) return `Glob pattern outside the jail: ${input.pattern}`;
    }
    return null;
  }
  return null;
}

module.exports = { decide, checkShell, canon, within };

if (require.main === module) {
  let policy = null;
  let verdict = 'the jail hook could not run';
  let payload = null;
  try {
    policy = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    verdict = decide(payload, policy);
  } catch (e) {
    verdict = `the jail hook failed closed: ${e && e.message}`;
  }
  try {
    if (policy && policy.log) fs.appendFileSync(policy.log, JSON.stringify({ t: Date.now(), tool: payload && payload.tool_name, deny: verdict }) + '\n');
  } catch { /* evidence is best effort; the decision is not */ }
  if (verdict) {
    process.stderr.write(`[layer-b jail] DENIED: ${verdict}\n`);
    process.exit(2);
  }
  process.exit(0);
}
