'use strict';
/**
 * CLAIMS-90 T6 (god cfacba and 8d13d1, Jim f7d551): the only way a codex labeller session reads. A stdio MCP server
 * the runner starts through codex, outside the sandbox, with the jail and a log file as its arguments. Every call's
 * arguments are checked BEFORE anything is read: a refused call reads nothing and returns no file text, and every
 * call (allowed or refused) is one row in the log, which the runner turns into the open log. Shell commands cannot run
 * at all in that session (the jail-only read profile refuses them before CreateProcess).
 *
 *   list_files {path?, glob?}           files under a jail folder (relative paths), at most LIST_MAX
 *   read_file  {path, offset?, limit?}  lines of one jail file, at most READ_MAX_LINES / READ_MAX_BYTES
 *   search     {pattern, path?, glob?, regex?}  matching lines under a jail folder, at most SEARCH_MAX hits
 *   git        {args}                   one read-only git command on the jail's repo.git (GIT_DIR), no shell
 *
 *   node labeller-jail-mcp.cjs <jail> <log.jsonl>
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIST_MAX = 2000;
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 256 * 1024;
const SEARCH_MAX = 200;
const LINE_MAX = 300;
const OUT_MAX = 64 * 1024;
const DEVICE = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[0-9¹²³]|LPT[0-9¹²³])(\..*)?$/i;
const GIT_SUBS = new Set(['log', 'show', 'tag', 'branch', 'rev-parse', 'rev-list', 'describe', 'ls-tree', 'cat-file', 'for-each-ref', 'show-ref', 'merge-base', 'name-rev', 'shortlog', 'grep']);
// Options that read or write a file named in their value, change the repo or run a program.
const GIT_DENY = /^(--output|--git-dir|--work-tree|--exec-path|--no-index|--ext-diff|--textconv|--upload-pack|--receive-pack|--exec|--open-files-in-pager|--orderfile|--ignore-revs-file|--contents|--mailmap-file|--mailmap-blob|--exclude-from|--file|--pathspec-from-file|--stdin|--batch-command|--edit|--delete|--force|--move|--copy|--set-upstream-to|--create-reflog|--sign|--local-user|--message|--cleanup|--annotate)($|=)|^-[OfFdDmMu]/;

/** Why a path argument is refused, or null. Relative jail paths only, judged before anything is read. */
function pathProblem(arg) {
  if (typeof arg !== 'string' || !arg.length) return 'a path must be a non-empty string';
  if (/[\x00-\x1f"<>|*?]/.test(arg)) return 'a path holds a control or wildcard character';
  if (arg.includes(':')) return 'a drive, stream or device path';
  if (/[%$~]/.test(arg)) return 'an env, home or short-name form';
  if (/^[\\/]/.test(arg)) return 'a rooted, UNC or device path';
  for (const seg of arg.split(/[\\/]+/)) {
    if (seg === '..') return 'a parent (..) segment';
    if (seg !== '.' && /[. ]$/.test(seg)) return 'a name ending in a dot or space';
    if (DEVICE.test(seg)) return 'a device name';
  }
  return null;
}

/** The real path of a jail-relative path, or { refused } before any read. No link anywhere on the way. */
function jailPath(jail, arg) {
  const why = pathProblem(arg);
  if (why) return { refused: why };
  const root = fs.realpathSync.native(jail);
  const full = path.resolve(root, arg);
  if (full !== root && !full.startsWith(root + path.sep)) return { refused: 'outside the jail' };
  let cur = root;
  for (const seg of path.relative(root, full).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, seg);
    let st; try { st = fs.lstatSync(cur); } catch { return { refused: 'no such path' }; }
    if (st.isSymbolicLink()) return { refused: 'a link or junction' };
  }
  let real; try { real = fs.realpathSync.native(full); } catch { return { refused: 'no such path' }; }
  if (real !== root && !real.startsWith(root + path.sep)) return { refused: 'resolves outside the jail' };
  return { real, rel: path.relative(root, real).replace(/\\/g, '/') || '.' };
}

/** A glob filter over jail-relative paths (* ? ** only); it can never name a root of its own. */
function globProblem(g) {
  if (g === undefined) return null;
  if (typeof g !== 'string' || !g.length) return 'a glob must be a non-empty string';
  if (/[\x00-\x1f"<>|:%$~]/.test(g) || /^[\\/]/.test(g)) return 'a glob with a drive, root, env or home form';
  if (g.split(/[\\/]+/).includes('..')) return 'a glob with a parent (..) segment';
  return null;
}
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/' || g[i + 1] === '\\') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '/' || c === '\\') re += '/';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Files under a jail folder; never follows a link (a link is reported, not entered). */
function walk(root, real) {
  const files = [];
  const links = [];
  const go = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink() || fs.lstatSync(p).isSymbolicLink()) { links.push(path.relative(root, p)); continue; }
      if (e.isDirectory()) go(p); else if (e.isFile()) files.push(path.relative(root, p).replace(/\\/g, '/'));
    }
  };
  if (fs.statSync(real).isDirectory()) go(real); else files.push(path.relative(root, real).replace(/\\/g, '/'));
  return { files: files.sort(), links };
}

const cut = (s) => (s.length > OUT_MAX ? `${s.slice(0, OUT_MAX)}\n[output cut at ${OUT_MAX} bytes]` : s);

/** One tool call: { text, refused? }. Exported for the tests; the server below only frames it. */
function call(jail, name, a = {}) {
  const root = fs.realpathSync.native(jail);
  if (name === 'read_file') {
    const p = jailPath(jail, a.path);
    if (p.refused) return { refused: p.refused };
    if (!fs.statSync(p.real).isFile()) return { refused: 'not a file' };
    const buf = fs.readFileSync(p.real);
    const lines = buf.subarray(0, READ_MAX_BYTES).toString('utf8').split(/\r?\n/);
    const from = Math.max(0, Number(a.offset) || 0);
    const n = Math.min(READ_MAX_LINES, Math.max(1, Number(a.limit) || READ_MAX_LINES));
    const part = lines.slice(from, from + n);
    const more = from + n < lines.length || buf.length > READ_MAX_BYTES;
    return { text: cut(part.map((l, i) => `${from + i + 1}\t${l}`).join('\n') + (more ? `\n[more: read again with offset ${from + n}]` : '')) };
  }
  if (name === 'list_files' || name === 'search') {
    const p = jailPath(jail, a.path ?? '.');
    if (p.refused) return { refused: p.refused };
    const gp = globProblem(a.glob);
    if (gp) return { refused: gp };
    const { files, links } = walk(root, p.real);
    if (links.length) return { refused: `the folder holds a link or junction (${links[0]})` };
    const re = a.glob ? globRe(a.glob) : null;
    const hit = files.filter((f) => !re || re.test(f) || re.test(path.posix.basename(f)));
    if (name === 'list_files') return { text: cut(hit.slice(0, LIST_MAX).join('\n') + (hit.length > LIST_MAX ? `\n[${hit.length - LIST_MAX} more not listed]` : '')) };
    if (typeof a.pattern !== 'string' || !a.pattern.length) return { refused: 'search needs a pattern' };
    let test;
    if (a.regex) { let r; try { r = new RegExp(a.pattern, 'i'); } catch { return { refused: 'not a valid regular expression' }; } test = (l) => r.test(l); }
    else { const q = a.pattern.toLowerCase(); test = (l) => l.toLowerCase().includes(q); }
    const out = [];
    let total = 0;
    for (const f of hit) {
      if (f.startsWith('repo.git/')) continue;
      const lines = fs.readFileSync(path.join(root, f)).subarray(0, READ_MAX_BYTES).toString('utf8').split(/\r?\n/);
      lines.forEach((l, i) => { if (test(l)) { total++; if (out.length < SEARCH_MAX) out.push(`${f}:${i + 1}:${l.slice(0, LINE_MAX)}`); } });
    }
    return { text: cut(out.join('\n') + (total > SEARCH_MAX ? `\n[${total - SEARCH_MAX} more hits not shown]` : '') || 'no match') };
  }
  if (name === 'git') {
    const args = a.args;
    if (!Array.isArray(args) || !args.length || !args.every((x) => typeof x === 'string')) return { refused: 'git needs args: a list of strings' };
    if (!GIT_SUBS.has(args[0])) return { refused: `git ${args[0]} is not a read command here` };
    for (const x of args.slice(1)) {
      if (/[\x00-\x1f]/.test(x)) return { refused: 'a control character' };
      if (GIT_DENY.test(x)) return { refused: `git option ${x.split('=')[0]} is not allowed` };
      if (/(^|=)([A-Za-z]:|[\\/])/.test(x)) return { refused: 'an absolute, drive or UNC path' };
      if (/(^|[\\/=])\.\.([\\/]|$)/.test(x)) return { refused: 'a parent (..) segment' };
    }
    const sub = ['tag', 'branch'].includes(args[0]) ? [args[0], '--list', ...args.slice(1)] : args;
    const gitDir = path.join(root, 'repo.git');
    const r = spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', ...sub], {
      cwd: gitDir, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 8 * OUT_MAX,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GIT_DIR: gitDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(gitDir, 'no-global-config'), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    return { text: cut(`${r.stdout || ''}${r.stderr ? `\n[stderr] ${r.stderr}` : ''}${r.status ? `\n[exit ${r.status}]` : ''}`) };
  }
  return { refused: `no tool ${name}` };
}

const TOOLS = [
  { name: 'list_files', description: 'List files under a folder of the working folder (relative paths only). Optional glob filter with * ? **.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, glob: { type: 'string' } } } },
  { name: 'read_file', description: 'Read lines of one file in the working folder by relative path. offset is 0-based; limit is a line count.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] } },
  { name: 'search', description: 'Find lines containing pattern (case-insensitive; regex true for a regular expression) in files under a folder of the working folder. Optional glob filter.', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' }, regex: { type: 'boolean' } }, required: ['pattern'] } },
  { name: 'git', description: 'Run one read-only git command on the snapshot repository, e.g. {"args":["log","--oneline","-20"]}. Allowed: log show tag branch rev-parse rev-list describe ls-tree cat-file for-each-ref show-ref merge-base name-rev shortlog grep.', inputSchema: { type: 'object', properties: { args: { type: 'array', items: { type: 'string' } } }, required: ['args'] } },
];

function serve(jail, log) {
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jail', version: '1' } } });
      else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
      else if (m.method === 'tools/call') {
        const name = m.params?.name;
        const args = m.params?.arguments ?? {};
        let r; try { r = call(jail, name, args); } catch (e) { r = { refused: `error: ${String(e.message || e).slice(0, 120)}` }; }
        fs.appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), tool: name, args, decision: r.refused ? 'deny' : 'allow', reason: r.refused ?? '' })}\n`);
        send({ jsonrpc: '2.0', id: m.id, result: r.refused ? { isError: true, content: [{ type: 'text', text: `Refused: ${r.refused}. Only relative paths inside the working folder.` }] } : { content: [{ type: 'text', text: r.text }] } });
      } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
    }
  });
}

if (require.main === module) serve(process.argv[2], process.argv[3]);

module.exports = { pathProblem, jailPath, globProblem, globRe, call, TOOLS, GIT_SUBS, SEARCH_MAX, LIST_MAX, READ_MAX_LINES, OUT_MAX };
