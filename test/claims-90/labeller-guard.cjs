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
const GIT_BAD_OPT = /^(-C|-c|--config-env|--git-dir|--work-tree|--exec-path|--namespace|--output|--no-index|-O|--open-files-in-pager|--ext-diff|--textconv|-f|--file|--contents|--super-prefix|--filters)(=|$)/;
// git takes any unique prefix of a long option (--open = --open-files-in-pager), so a long option
// is bad when its name is a prefix of a bad one, unless it is itself a harmless option.
const GIT_BAD_LONG = ['config-env', 'git-dir', 'work-tree', 'exec-path', 'namespace', 'output', 'no-index', 'open-files-in-pager', 'ext-diff', 'textconv', 'file', 'contents', 'super-prefix', 'filters'];
const GIT_SAFE_LONG = new Set(['text', 'filter']);
// In a short-option cluster (-iOless) these letters are bad wherever they stand; a letter that takes
// a value (-S<string>, -e<pattern>, -A3) ends the cluster, and so does any non-letter.
const SHORT_BAD = 'Of';
const SHORT_VALUE = 'SGLeABCmUMX';
// git tag and git branch list refs only in their list forms; every form that writes a ref is denied.
const REF_WRITE = {
  tag: { short: 'asudfmFe', long: ['annotate', 'sign', 'no-sign', 'local-user', 'force', 'delete', 'message', 'file', 'edit', 'create-reflog', 'cleanup', 'trailer'] },
  branch: { short: 'dDmMcCfut', long: ['delete', 'move', 'copy', 'force', 'set-upstream-to', 'unset-upstream', 'edit-description', 'track', 'no-track', 'create-reflog', 'recurse-submodules'] },
};
// A list-mode option: with one, the other words are patterns or commits, never a new ref name.
const LIST_MODE = /^(-l|--list|-n\d*|--contains|--no-contains|--merged|--no-merged|--points-at)(=|$)/;

const norm = (p) => path.resolve(String(p).replace(/^\/([a-zA-Z])\//, '$1:/')).toLowerCase();

/** Claude Code's per-project folder name for a cwd (every non-alphanumeric char becomes '-'). */
const projectSlug = (cwd) => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
const ownOutputsDir = (jail) => path.join(os.homedir(), '.claude', 'projects', projectSlug(jail));

function where(p, jail) {
  if (p === undefined || p === null || p === '') return 'jail';
  if (/(^|[\\/])\.\.([\\/]|$)/.test(String(p))) return 'outside';
  // A shell expands ~ to the home folder, never to a folder in the jail.
  if (String(p).startsWith('~')) return 'outside';
  const abs = norm(path.isAbsolute(String(p).replace(/^\/([a-zA-Z])\//, '$1:/')) ? p : path.join(jail, String(p)));
  const j = norm(jail);
  if (abs === j || abs.startsWith(j + path.sep)) return 'jail';
  const own = norm(ownOutputsDir(jail));
  if (abs.startsWith(own + path.sep)) return 'own-output';
  return 'outside';
}

/**
 * Read a command as a POSIX shell does, in one pass. words: unquoted whitespace ends a word, and so
 * does an unquoted operator char (; & | < > newline: `cd /jail; ls` gives the word /jail, not
 * /jail; which read as a sibling folder outside the jail, LABELLER-GUARD-FALSEPOS a); the operator
 * itself is never part of a word, only an op. Quoted and unquoted pieces next to each other join
 * into one word (-S"a b" is one word; 'a;b' keeps its ;). Inside
 * double quotes a backslash escapes " \ $ ` and is kept before anything else; single quotes are
 * literal. Outside quotes a backslash and the char after it are kept as typed, so \x still reads as
 * a root path. ops: every chain, pipe, redirection or substitution the shell would act on (; & | < >
 * newline outside quotes, ` $( ${ outside single quotes), and an operator char escaped with an
 * unquoted backslash (denied too, to be safe). vars: the names of the variables the shell expands.
 */
function scan(cmd) {
  const out = [];
  const ops = [];
  const vars = [];
  const dollar = (i) => {
    const rest = cmd.slice(i + 1);
    if (rest[0] === '(' || rest[0] === '{') ops.push(`$${rest[0]}`);
    const m = /^\{?([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(rest);
    if (m) vars.push(m[1]);
  };
  let w = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (/[;&|<>\n\r`]/.test(c)) ops.push(c);
    // An unquoted operator ends the word before it and starts none: the shell never passes it to a
    // command, so a path next to it is judged without it (a path after it is judged on its own).
    if (/[;&|<>\s]/.test(c)) { if (w !== null) out.push(w); w = null; continue; }
    if (w === null) w = '';
    if (c === '\\') { if (/[;&|<>`]/.test(cmd[i + 1] ?? '')) ops.push(`\\${cmd[i + 1]}`); w += cmd.slice(i, i + 2); i++; continue; }
    if (c === "'") { const e = cmd.indexOf("'", i + 1); const end = e < 0 ? cmd.length : e; w += cmd.slice(i + 1, end); i = end; continue; }
    if (c === '"') {
      for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
        if (cmd[i] === '\\' && /["\\$`]/.test(cmd[i + 1] ?? '')) i++;
        else if (cmd[i] === '`') ops.push('`');
        else if (cmd[i] === '$') dollar(i);
        w += cmd[i];
      }
      continue;
    }
    if (c === '$') dollar(i);
    w += c;
  }
  if (w !== null) out.push(w);
  return { words: out, ops, vars };
}
const words = (cmd) => scan(cmd).words;

/** The first bad option among git's words (after the subcommand), or null. */
function badGitOption(args) {
  for (const x of args) {
    if (GIT_BAD_OPT.test(x)) return x.split('=')[0];
    if (/^--[^=]/.test(x)) {
      const name = x.slice(2).split('=')[0];
      if (!GIT_SAFE_LONG.has(name) && GIT_BAD_LONG.some((o) => o.startsWith(name))) return `--${name}`;
    } else if (/^-[^-]/.test(x)) {
      for (const c of x.slice(1)) {
        if (SHORT_BAD.includes(c)) return `-${c}`;
        if (!/[a-zA-Z]/.test(c) || SHORT_VALUE.includes(c)) break;
      }
    }
  }
  return null;
}

/** For git tag / git branch: the word that would write a ref, or null for a list form. */
function refWrite(sub, args) {
  const rule = REF_WRITE[sub];
  if (!rule) return null;
  for (const x of args) {
    if (/^--[^=]/.test(x)) {
      const name = x.slice(2).split('=')[0];
      if (rule.long.some((o) => o.startsWith(name))) return x;
    } else if (/^-[^-]/.test(x) && [...x.slice(1)].some((c) => rule.short.includes(c))) return x;
  }
  if (args.some((x) => LIST_MODE.test(x))) return null;
  return args.find((x) => !x.startsWith('-')) ?? null;
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
    const { words: w, ops, vars } = scan(cmd);
    if (vars.includes('HOME')) return { decision: 'deny', place: 'outside', path: w.find((x) => /\$\{?HOME/.test(x)) ?? null, reason: 'a path outside the jail' };
    const pathWords = w.filter((x) => (/^([a-zA-Z]:|[\\/]|~)/.test(x) && !x.startsWith('\\"')) || /(^|[\\/])\.\.([\\/]|$)/.test(x));
    const outside = pathWords.find((x) => where(x, jail) === 'outside');
    if (outside) return { decision: 'deny', place: 'outside', path: outside, reason: 'a path outside the jail' };
    if (w[0] !== 'git' || ops.length) return { decision: 'deny', place: 'jail', path: null, reason: 'Bash runs one git command, no chain, pipe or redirection' };
    if (vars.length) return { decision: 'deny', place: 'jail', path: null, reason: 'Bash runs git with no shell variables' };
    if (!GIT_READ.has(w[1])) return { decision: 'deny', place: 'jail', path: null, reason: `git ${w[1] ?? ''} is not a read command here` };
    const bad = badGitOption(w.slice(2));
    if (bad) return { decision: 'deny', place: 'jail', path: null, reason: `git option ${bad} is not allowed` };
    const write = refWrite(w[1], w.slice(2));
    if (write) return { decision: 'deny', place: 'jail', path: null, reason: `git ${w[1]} ${write} writes a ref; only its list forms are allowed` };
    return { decision: 'allow', place: 'jail', path: pathWords[0] ?? null, reason: '' };
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

module.exports = { check, where, words, scan, projectSlug, ownOutputsDir, GIT_READ };
