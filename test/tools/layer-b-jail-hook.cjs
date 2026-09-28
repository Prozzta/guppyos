'use strict';

/**
 * ZT-I1-MAIL layer (b), R1 (Jim) + god c0a73f (a): the HARD jail for the real Claude agent.
 *
 * A Claude Code PreToolUse hook, installed by test/tools/layer-b-run.cjs in the JAILED user
 * settings (~/.claude/settings.json inside the sandbox; the product's own --settings file adds its
 * hooks beside it, and Claude runs both). Claude's docs: "PreToolUse hooks fire before any
 * permission-mode check, in every permission mode ... A hook that returns deny blocks the tool even
 * in bypassPermissions mode." So the product keeps its normal Claude arguments
 * (--permission-mode bypassPermissions) and this hook is the guarantee; the permissions rules the
 * runner writes beside it are a second, independent layer.
 *
 * A STRICT ALLOWLIST (Jim's re-audit: a text blocklist over shell commands cannot be made safe):
 *   Read / Glob / Grep / LS    allowed only for a path inside `readRoots`;
 *   Write / Edit / MultiEdit   allowed only for a path inside `writeRoots`;
 *   EVERYTHING ELSE IS DENIED: Bash, PowerShell, every MCP tool, Agent/Task, WebFetch, WebSearch,
 *   NotebookEdit, and any tool this file does not know.
 * The layer-(b) facts need nothing more: the agent reads files and replies by WRITING an outbox JSON.
 *
 * Paths are resolved the way Windows would, then checked on the REAL path:
 *   absolute; drive-less rooted (\x or /x, on the cwd's drive); relative to cwd; `..`; `~`;
 *   device paths (\\?\C:\x, \\.\C:\x -> C:\x; any other device or \\?\UNC\ form is denied); UNC
 *   (denied); 8.3 short names, symlinks and junctions (realpath where the path exists, else the
 *   realpath of its nearest existing parent plus the rest). Denied outright as ambiguous: a single
 *   letter POSIX drive (/c/...), an alternate data stream or any stray colon, a segment ending in a
 *   dot or a space, a reserved device name (CON, NUL, COM1 ...), wildcards in a Read/Write path,
 *   and protected names inside the jail (.claude, .codex, settings, credentials, the policy).
 *
 * Policy (a JSON file, argv[2]; it lives OUTSIDE every root the agent may write):
 *   { writeRoots, readRoots, protect, protectPaths, home, log? }
 *   J1/J2 (Jim): readRoots = the Claude work dir + agent dir only (no credential copy under any of
 *   them); writeRoots = the work dir + the agent's outbox only (never its inbox or any state file);
 *   a Grep/Glob/LS whose root covers a protected path, a protected name or a link is denied.
 * Deny = exit code 2 with the reason on stderr (the documented blocking form). Any error = deny
 * (fail closed). Allow = exit 0, no output.
 */
const fs = require('node:fs');
const path = require('node:path');

const W32 = path.win32;
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/** The real, canonical form of an ABSOLUTE drive path: realpath (8.3 names, links, junctions
 *  resolved) where it exists, else the nearest existing parent's realpath plus the remaining tail. */
function realOf(abs) {
  let probe = abs;
  const tail = [];
  for (let i = 0; i < 128; i++) {
    try {
      const real = fs.realpathSync.native(probe);
      return W32.join(real, ...tail.reverse());
    } catch {
      const parent = W32.dirname(probe);
      if (parent === probe) break;
      tail.push(W32.basename(probe));
      probe = parent;
    }
  }
  return abs;
}
const key = (p) => W32.normalize(p).replace(/[\\/]+$/, '').toLowerCase();
function within(real, roots) {
  const r = key(real);
  return roots.some((root) => { const k = key(realOf(W32.resolve(root))); return r === k || r.startsWith(k + '\\'); });
}

/**
 * Resolve a tool path argument. Returns { abs, real } or { bad }.
 */
function resolveToolPath(raw, policy, cwd) {
  if (typeof raw !== 'string' || !raw.trim()) return { bad: 'no path' };
  let s = raw.trim();
  if (s.includes('\0')) return { bad: 'NUL in the path' };
  // Device paths: only the plain drive forms are unwrapped; everything else is denied.
  const dev = /^[\\/]{2}[?.][\\/](.*)$/.exec(s);
  if (dev) {
    if (!/^[A-Za-z]:[\\/]/.test(dev[1])) return { bad: `device path ${s}` };
    s = dev[1];
  }
  if (/^[\\/]{2}/.test(s)) return { bad: `UNC path ${s}` };
  if (/^\/[A-Za-z](\/|$)/.test(s)) return { bad: `POSIX drive path ${s}` };
  if (s === '~' || /^~[\\/]/.test(s)) s = W32.join(policy.home, s.slice(1));
  else if (/^~/.test(s)) return { bad: `another user's home ${s}` };
  if (/^[A-Za-z]:(?![\\/])/.test(s)) return { bad: `drive-relative path ${s}` };
  // A colon anywhere but right after the drive letter: an alternate data stream or worse.
  if (s.slice(/^[A-Za-z]:/.test(s) ? 2 : 0).includes(':')) return { bad: `a colon in the path ${s}` };
  if (!W32.isAbsolute(cwd || '') || !/^[A-Za-z]:[\\/]/.test(cwd)) return { bad: `no usable cwd (${cwd})` };
  // Drive-less rooted (\x, /x) resolves on the cwd's drive; relative resolves against cwd.
  const abs = W32.resolve(cwd, s);
  if (!/^[A-Za-z]:\\/.test(abs)) return { bad: `unresolvable ${s}` };
  for (const seg of abs.slice(3).split('\\').filter(Boolean)) {
    if (/[. ]$/.test(seg)) return { bad: `a segment ending in a dot or space (${seg})` };
    if (RESERVED.test(seg)) return { bad: `a reserved device name (${seg})` };
  }
  const real = realOf(abs);
  return { abs, real };
}

/** J1 (Jim): a SEARCH (Grep/Glob/LS) may not cover anything protected. Its root is refused when it
 *  equals or is an ancestor of a protected concrete path (policy.protectPaths), or when a bounded
 *  walk under it (no link followed) meets a protected NAME or any link/junction, or is too big to
 *  prove clean. A hidden directory is walked like any other: nothing relies on the search tool
 *  skipping it. */
const SEARCH_WALK_LIMIT = 20_000;
function searchRootProblem(rootReal, policy) {
  for (const pp of policy.protectPaths || []) {
    const k = key(realOf(W32.resolve(pp)));
    const r = key(rootReal);
    if (k === r || k.startsWith(r + '\\')) return `the search root covers the protected ${pp}`;
  }
  const names = new Set((policy.protect || []).map((n) => String(n).toLowerCase()));
  const stack = [rootReal];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { if (d === rootReal && e.code === 'ENOENT') return null; return `cannot list ${d} to prove it holds nothing protected`; }
    for (const e of ents) {
      if (++seen > SEARCH_WALK_LIMIT) return 'the search root is too large to prove it holds nothing protected';
      const f = W32.join(d, e.name);
      if (names.has(e.name.toLowerCase())) return `the search root holds the protected ${f}`;
      if (e.isSymbolicLink()) return `the search root holds a link (${f})`;
      if (e.isDirectory()) {
        try { if (fs.lstatSync(f).isSymbolicLink()) return `the search root holds a junction (${f})`; } catch { /* raced */ }
        stack.push(f);
      }
    }
  }
  return null;
}

const protectedPath = (p, policy) => {
  const segs = key(p).split('\\');
  return (policy.protect || []).some((name) => segs.includes(String(name).toLowerCase()));
};

/** The decision for one PreToolUse payload: null = allow, a string = the deny reason. */
function decide(payload, policy) {
  if (!payload || typeof payload !== 'object') return 'unreadable hook payload';
  if (!policy || !Array.isArray(policy.readRoots) || !Array.isArray(policy.writeRoots)) return 'no jail policy';
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : '';
  const isRead = READ_TOOLS.has(tool);
  const isWrite = WRITE_TOOLS.has(tool);
  if (!isRead && !isWrite) return `${tool || 'an unnamed tool'} is not allowed in the layer-b jail (allowlist: Read, Glob, Grep, LS, Write, Edit, MultiEdit)`;
  // The cwd itself must be inside the sandbox (relative paths resolve against it).
  const c = resolveToolPath(cwd, policy, cwd);
  if (c.bad || !within(c.real, policy.readRoots)) return `the session cwd is outside the sandbox (${cwd})`;
  const roots = isWrite ? policy.writeRoots : policy.readRoots;
  let raw;
  if (tool === 'Read' || isWrite) raw = input.file_path;
  else raw = input.path === undefined || input.path === null || input.path === '' ? cwd : input.path;
  if (isWrite || tool === 'Read') {
    if (typeof raw !== 'string') return `${tool} without a file_path`;
    if (/[*?]/.test(raw)) return `${tool}: a wildcard in the path`;
  }
  const r = resolveToolPath(raw, policy, cwd);
  if (r.bad) return `${tool}: ${r.bad}`;
  if (!within(r.real, roots)) return `${tool} outside the jail: ${r.real}`;
  if (protectedPath(r.real, policy) || protectedPath(r.abs, policy)) return `${tool} on a protected jail file: ${r.real}`;
  if (isRead && tool !== 'Read') {
    const why = searchRootProblem(r.real, policy);
    if (why) return `${tool}: ${why}`;
  }
  // Glob/Grep patterns: never absolute, rooted, home-based or climbing.
  for (const field of ['pattern', 'glob']) {
    const pat = tool === 'Glob' || (tool === 'Grep' && field === 'glob') ? input[field] : undefined;
    if (typeof pat !== 'string') continue;
    if (/^([A-Za-z]:|[\\/~])/.test(pat) || /(^|[\\/])\.\.([\\/]|$)/.test(pat) || pat.includes(':')) return `${tool} ${field} leaves the search root: ${pat}`;
  }
  if (tool === 'MultiEdit' && input.edits !== undefined && !Array.isArray(input.edits)) return 'MultiEdit with malformed edits';
  return null;
}

module.exports = { decide, resolveToolPath, realOf, within, searchRootProblem, READ_TOOLS, WRITE_TOOLS };

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
