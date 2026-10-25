'use strict';
/**
 * CLAIMS-90 labeller jail: the per-call guard (test-only). One rule set, used twice:
 *   - as the session's PreToolUse command hook: it denies a call that would leave the jail and
 *     appends one row per call to the open log;
 *   - by labeller.cjs over the transcript afterwards, so a call the hook never saw is still judged.
 * A path is in the jail if it resolves under the jail folder. The only other readable place is
 * Claude Code's own saved outputs for this jail (projects/<jail slug>/), since a long git output
 * is saved there and read back. Bash runs git only, in a read form, with no path outside the jail.
 *
 *   hook: node labeller-guard.cjs <jail> <open-log.jsonl>   (stdin: the PreToolUse payload)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GIT_READ = new Set(['log', 'show', 'tag', 'branch', 'rev-parse', 'rev-list', 'describe', 'cat-file', 'ls-tree', 'grep', 'diff', 'blame', 'for-each-ref', 'merge-base', 'name-rev', 'shortlog', 'show-ref', 'whatchanged']);
// Options that run a program, write a file, read a file outside the repo, or move the repo.
const GIT_BAD_OPT = /^(-C|-c|--config-env|--git-dir|--work-tree|--exec-path|--namespace|--output|--no-index|-O|--open-files-in-pager|--ext-diff|--textconv|-f|--file|--contents|--super-prefix)(=|$)/;

const norm = (p) => path.resolve(String(p).replace(/^\/([a-zA-Z])\//, '$1:/')).toLowerCase();

/** Claude Code's per-project folder name for a cwd (every non-alphanumeric char becomes '-'). */
const projectSlug = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const ownOutputsDir = (jail) => path.join(os.homedir(), '.claude', 'projects', projectSlug(jail));

function where(p, jail) {
  if (p === undefined || p === null || p === '') return 'jail';
  if (/(^|[\\/])\.\.([\\/]|$)/.test(String(p))) return 'outside';
  const abs = norm(path.isAbsolute(String(p).replace(/^\/([a-zA-Z])\//, '$1:/')) ? p : path.join(jail, String(p)));
  const j = norm(jail);
  if (abs === j || abs.startsWith(j + path.sep)) return 'jail';
  const own = norm(ownOutputsDir(jail));
  if (abs.startsWith(own + path.sep)) return 'own-output';
  return 'outside';
}

/**
 * Split a command into words as a POSIX shell does: unquoted whitespace ends a word, and quoted and
 * unquoted pieces next to each other join into one word (-S"a b" is one word). Inside double quotes
 * a backslash escapes " \ $ ` and is kept before anything else; single quotes are literal. Outside
 * quotes a backslash and the char after it are kept as typed, so \x still reads as a root path.
 */
function words(cmd) {
  const out = [];
  let w = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (/\s/.test(c)) { if (w !== null) out.push(w); w = null; continue; }
    if (w === null) w = '';
    if (c === '\\') { w += cmd.slice(i, i + 2); i++; continue; }
    if (c === "'") { const e = cmd.indexOf("'", i + 1); const end = e < 0 ? cmd.length : e; w += cmd.slice(i + 1, end); i = end; continue; }
    if (c === '"') {
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\' && /["\\$`]/.test(cmd[i + 1] ?? '')) i++;
        w += cmd[i];
      }
      continue;
    }
    w += c;
  }
  if (w !== null) out.push(w);
  return out;
}

/**
 * Judge one tool call. Returns { decision: 'allow'|'deny', place, reason, path }.
 * place 'outside' means the call named a path outside the jail: that makes the batch INVALID.
 */
function check(tool, input, jail, keyFile) {
  const i = input || {};
  const at = (p, extra = {}) => ({ ...extra, path: p ?? null, place: where(p, jail) });
  if (tool === 'Read') { const r = at(i.file_path); return { ...r, decision: r.place === 'outside' ? 'deny' : 'allow', reason: r.place === 'outside' ? 'read outside the jail' : '' }; }
  if (tool === 'Grep' || tool === 'Glob') {
    const r = at(i.path);
    const pat = String(i.pattern ?? '') + ' ' + String(i.glob ?? '');
    const absPat = tool === 'Glob' && /^\s*([a-zA-Z]:|[\\/]|~)/.test(String(i.pattern ?? '')) && where(String(i.pattern).replace(/[*?[{].*$/, ''), jail) === 'outside';
    if (r.place === 'outside' || absPat || /(^|[\\/\s])\.\.([\\/]|$)/.test(tool === 'Glob' ? pat : String(i.glob ?? ''))) return { ...r, place: 'outside', decision: 'deny', reason: `${tool} outside the jail` };
    if (r.place === 'own-output') return { ...r, decision: 'deny', reason: `${tool} on saved outputs: use Read` };
    return { ...r, decision: 'allow', reason: '' };
  }
  if (tool === 'Write') {
    const r = at(i.file_path);
    if (r.place === 'outside') return { ...r, decision: 'deny', reason: 'write outside the jail' };
    if (norm(i.file_path && path.isAbsolute(i.file_path) ? i.file_path : path.join(jail, String(i.file_path))) !== norm(keyFile)) return { ...r, decision: 'deny', reason: 'the key file is the only writable file' };
    return { ...r, decision: 'allow', reason: '' };
  }
  if (tool === 'Bash') {
    const cmd = String(i.command ?? '');
    const unquoted = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    const w = words(cmd);
    const pathWord = w.find((x) => (/^([a-zA-Z]:|[\\/]|~)/.test(x) && !x.startsWith('\\"')) || /(^|[\\/])\.\.([\\/]|$)/.test(x));
    if (pathWord && where(pathWord, jail) === 'outside') return { decision: 'deny', place: 'outside', path: pathWord, reason: 'a path outside the jail' };
    if (w[0] !== 'git' || /[;&|<>`\n\r]|\$\(|\$\{/.test(unquoted)) return { decision: 'deny', place: 'jail', path: null, reason: 'Bash runs one git command, no chain, pipe or redirection' };
    if (!GIT_READ.has(w[1])) return { decision: 'deny', place: 'jail', path: null, reason: `git ${w[1] ?? ''} is not a read command here` };
    const bad = w.slice(2).find((x) => GIT_BAD_OPT.test(x));
    if (bad) return { decision: 'deny', place: 'jail', path: null, reason: `git option ${bad.split('=')[0]} is not allowed` };
    return { decision: 'allow', place: 'jail', path: pathWord ?? null, reason: '' };
  }
  return { decision: 'deny', place: 'jail', path: null, reason: `tool ${tool} is not in the jail's set` };
}

if (require.main === module) {
  const [jail, openLog, keyFile] = process.argv.slice(2);
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; }).on('end', () => {
    let p = {};
    try { p = JSON.parse(raw); } catch { /* judged as an unknown tool below */ }
    const v = check(p.tool_name, p.tool_input, jail, keyFile);
    const i = p.tool_input || {};
    fs.appendFileSync(openLog, `${JSON.stringify({ at: new Date().toISOString(), toolUseId: p.tool_use_id ?? null, tool: p.tool_name ?? null, path: i.file_path ?? i.path ?? null, pattern: i.pattern ?? null, command: i.command ?? null, place: v.place, decision: v.decision, reason: v.reason })}\n`);
    if (v.decision === 'deny') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Labeller jail: ${v.reason}.` } }));
  });
}

module.exports = { check, where, words, projectSlug, ownOutputsDir, GIT_READ };
