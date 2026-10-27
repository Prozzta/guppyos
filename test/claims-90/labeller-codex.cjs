'use strict';
/**
 * CLAIMS-90 T6 (god 495956 and cfacba, Jim 475eab and f7d551): the labeller jail run by Codex instead of Claude Code,
 * so the third read of the H1 key comes from another model family under the same audit. labeller.cjs --provider codex
 * calls this module. Reads outside the jail are PREVENTED before they run, not only detected:
 *
 *   codex exec --json --ephemeral --ignore-user-config --ignore-rules, cwd = the mkdtemp jail, with a permission
 *   profile that makes only :minimal and the jail readable. The unelevated Windows sandbox cannot enforce split read
 *   rules, so it refuses EVERY shell command before CreateProcess (fail-closed); the shell tools are off as well, and
 *   so is every other tool that has a feature flag (images, browser, computer use, apps, plugins, agents...). There are
 *   no execpolicy allow rules: an allow rule skips the sandbox (probe: a Get-Content prefix rule read an outside decoy).
 *   The session reads only through the runner's MCP server (labeller-jail-mcp.cjs), which checks every path argument
 *   before it reads and logs every call; its log is the open log. A refused call never ran and makes the batch INVALID.
 *   Code mode stays on: turning off its host turns off every tool (probe), and its JS has no file or network API (the
 *   real smoke's session C tries each one against an outside decoy and a local listener).
 *   There is no git tool (god a2e5b2): the jail holds git/ (exportGitFacts, from the frozen bundle before launch) and
 *   no repo.git, so no git process ever sees a model argument.
 *   CODEX_HOME is a fresh folder beside the jail (codex refuses helpers under %TEMP%) holding ONLY a copy of the
 *   Codex login. Codex reads it at start; the copy is deleted when codex prints thread.started, before any model
 *   reply. A login codex writes later is deleted too and is NEVER written back (Jim 49a485): the batch is INVALID and
 *   says so. A change to the real login during the run is recorded, never touched. The folder is deleted after every run.
 *   The env is the answerer allow-list with no HIVE_*, AGENT_*, MEMORY_*, MUTANT_* (etc.) key and no hive or Guppy
 *   PATH dir; a leak is INVALID before launch.
 *   The session cannot write: its final message (codex -o) holds the key lines and the runner writes key.jsonl.
 *   Any event item other than a message, reasoning, a plan or a call to the jail MCP server is INVALID. A credential
 *   value in any output is redacted and INVALID.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MCP = require('./labeller-jail-mcp.cjs');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ITEM_TYPES = new Set(['agent_message', 'reasoning', 'todo_list', 'mcp_tool_call']);
const LEAK_KEY = /^(HIVE|AGENT|MEMORY|MUTANT|MUNDER|GUPPY|CLAUDE|ANTHROPIC|OPENAI|CODEX(?!_HOME$))/i;
const HIVE_DIR = /[\\/](Dunder[\\/]+hive|Munder Difflin)([\\/]|$)/i;
// Every tool feature that is on by default in codex-cli 0.157.1 except code_mode_host (off = no tools at all).
const FEATURES_OFF = ['shell_tool', 'unified_exec', 'view_image', 'image_generation', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'in_app_browser', 'computer_use', 'in_app_local_automation', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'skill_search', 'tool_suggest', 'goals', 'hooks', 'workspace_dependencies', 'skill_mcp_dependency_install', 'sleep_tool'];
const CODEX_NOTE = '\n\nThis session reads files only through the jail tools (list_files, read_file, search); paths are relative to the working folder. There is no git command: the repository\'s history at the snapshot is in git/ (read git/README.md first). It cannot run shell commands or write files. Do not try to create {keyFile}. End with a final message that holds exactly the lines that file must contain, one JSON object per line, and nothing else.\n';

const GIT_README = `The snapshot repository's history, exported before this session started. There is no git command.
  log.txt       every commit, newest first: <sha> parents=<sha ...> date=<commit date> author-date=<date> refs=(<refs>) <subject>
  branches.txt  <branch> <tip sha> <commit date> <subject>
  tags.txt      <tag> <object sha> <commit sha> <date> <subject>
  show/<sha>.txt  the full message, stat and patch of that commit (merges: combined diff)
`;

/** Run git on a repo with no system or global config and no pager. Returns the raw stdout bytes. */
function gitOut(repo, args) {
  const r = require('node:child_process').spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=true', ...args], {
    cwd: repo, windowsHide: true, maxBuffer: 1 << 30,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, GIT_DIR: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(repo, 'no-global-config'), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.error ? r.error.message : String(r.stderr).trim()}`);
  return r.stdout;
}

/**
 * The git facts a labeller needs, as plain files under dest (god a2e5b2: no git process sees model arguments).
 * Deterministic: the same repo gives the same bytes, so a jail's git/ can be checked against a fresh export.
 */
function exportGitFacts(repo, dest) {
  fs.mkdirSync(path.join(dest, 'show'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'README.md'), GIT_README);
  const log = gitOut(repo, ['log', '--all', '--date-order', '--format=%H parents=%P date=%cI author-date=%aI refs=(%D) %s']);
  fs.writeFileSync(path.join(dest, 'log.txt'), log);
  fs.writeFileSync(path.join(dest, 'branches.txt'), gitOut(repo, ['for-each-ref', '--sort=refname', '--format=%(refname:short) %(objectname) %(committerdate:iso-strict) %(subject)', 'refs/heads']));
  fs.writeFileSync(path.join(dest, 'tags.txt'), gitOut(repo, ['for-each-ref', '--sort=refname', '--format=%(refname:short) %(objectname) %(*objectname) %(creatordate:iso-strict) %(subject)', 'refs/tags']));
  // One stream for every commit (one spawn per commit is minutes on this repo). A fresh random marker starts
  // each commit: diffs hold any byte (this repo's minified files carry \x1e), never this export's marker.
  const mark = Buffer.from(`\n@@export-${crypto.randomBytes(16).toString('hex')}@@ `, 'latin1');
  const all = Buffer.concat([Buffer.from('\n'), gitOut(repo, ['log', '--all', '--date-order', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--cc', '--stat', '--patch',
    `--format=${mark.toString('latin1').slice(1)}%H%ncommit %H%nparents %P%nauthor %an%ndate %aI%ncommit-date %cI%nrefs %D%n%n%B`])]);
  const shas = log.toString('latin1').split('\n').filter(Boolean).map((l) => l.slice(0, 40));
  let n = 0;
  for (let i = all.indexOf(mark); i !== -1;) {
    const next = all.indexOf(mark, i + mark.length);
    const chunk = all.subarray(i + mark.length, next === -1 ? all.length : next);
    const nl = chunk.indexOf(0x0a);
    const sha = chunk.subarray(0, nl).toString('latin1');
    if (sha !== shas[n]) throw new Error(`git export: commit ${n} is ${sha.slice(0, 50)}, log.txt has ${shas[n]}`);
    // The marker's own newline ends the previous commit's text: give it back.
    fs.writeFileSync(path.join(dest, 'show', `${sha}.txt`), next === -1 ? chunk.subarray(nl + 1) : Buffer.concat([chunk.subarray(nl + 1), Buffer.from('\n')]));
    n++;
    i = next;
  }
  if (n !== shas.length) throw new Error(`git export: ${n} commits shown, log.txt has ${shas.length}`);
  return n;
}

function codexExe() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const exe = path.join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('no Codex CLI on PATH');
}

const realAuthFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');

/** The session env: the labeller's allow-list env, the hive's PATH dirs dropped, CODEX_HOME set. */
function codexEnv(base, home) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!LEAK_KEY.test(k)) env[k] = v;
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = String(env[pathKey] || '').split(path.delimiter).filter((d) => d && !HIVE_DIR.test(d)).join(path.delimiter);
  return { ...env, CODEX_HOME: home };
}

/** Env keys or PATH dirs that must not reach the session. */
function envLeaks(env) {
  const out = Object.keys(env).filter((k) => LEAK_KEY.test(k) && k !== 'CODEX_HOME');
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === 'path') for (const d of String(v).split(path.delimiter)) if (HIVE_DIR.test(d)) out.push(`PATH:${d}`);
  return out;
}

/** The credential strings in a Codex login file (tokens and API key; not the mode or the refresh date). */
function authSecrets(buf) {
  const out = [];
  let j;
  try { j = JSON.parse(String(buf)); } catch { return out; }
  const walk = (v, k) => { if (typeof v === 'string' && v.length >= 12 && !/^(auth_mode|last_refresh)$/.test(k)) out.push(v); else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk); };
  walk(j, '');
  return out;
}

/** text with every secret replaced; found: how many were there. */
function redact(text, secrets) {
  let found = 0;
  let t = String(text ?? '');
  for (const s of secrets) if (t.includes(s)) { found++; t = t.split(s).join('[REDACTED]'); }
  return { text: t, found };
}

/** The codex exec arguments: no shell, no allow rules, the jail-only read profile and the jail MCP server. */
function codexArgs({ jail, lastMsg, model, mcpLog }) {
  const fwd = (p) => p.replace(/\\/g, '/');
  // codex splits a -c key on '.' and keeps quotes in it (a quoted ":minimal" is refused as a relative path), so the
  // filesystem keys go unquoted, and a jail path holding '.' or '=' is refused rather than keyed wrongly.
  if (/[.="]/.test(fwd(jail))) throw new Error('the jail path holds ".", "=" or a quote: codex cannot key it');
  return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', 'never',
    '-c', 'approval_policy="never"', '-c', 'windows.sandbox="unelevated"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
    '-c', 'default_permissions="labeller"', '-c', 'permissions.labeller.filesystem.:minimal="read"', '-c', `permissions.labeller.filesystem.${fwd(jail)}="read"`,
    ...FEATURES_OFF.flatMap((f) => ['-c', `features.${f}=false`]),
    '-c', `mcp_servers.jail.command=${JSON.stringify(fwd(process.execPath))}`,
    '-c', `mcp_servers.jail.args=${JSON.stringify([fwd(path.join(__dirname, 'labeller-jail-mcp.cjs')), fwd(jail), fwd(mcpLog)])}`,
    ...MCP.TOOLS.flatMap((t) => ['-c', `mcp_servers.jail.tools.${t.name}.approval_mode="approve"`]),
    '-C', jail, '-o', lastMsg, ...(model ? ['-m', model] : []), '-'];
}

/** What the session did, from the codex JSON events (tool calls as codex saw them; the reads come from the MCP log). */
function auditEvents(text) {
  const rows = String(text ?? '').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return [{ type: 'unparsed' }]; } });
  const tools = [];
  const other = [];
  for (const r of rows) {
    if (r.type !== 'item.completed' && r.type !== 'item.started') continue;
    const it = r.item || {};
    if (!ITEM_TYPES.has(it.type) || (it.type === 'mcp_tool_call' && it.server !== 'jail')) { other.push(it.type === 'mcp_tool_call' ? `mcp:${it.server}` : String(it.type ?? 'unknown')); continue; }
    if (it.type === 'mcp_tool_call' && r.type === 'item.completed') tools.push({ id: it.id ?? null, tool: it.tool, status: it.status });
  }
  const completed = rows.filter((r) => r.type === 'turn.completed');
  const usage = completed.length ? completed.reduce((u, r) => {
    for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') u[k] = (u[k] || 0) + v;
    return u;
  }, {}) : null;
  return {
    tools,
    otherItems: [...new Set(other)],
    failed: rows.filter((r) => /^(turn\.failed|error)$/.test(r.type)).length,
    unparsed: rows.filter((r) => r.type === 'unparsed').length,
    turnCompleted: completed.length > 0,
    threadStarted: rows.some((r) => r.type === 'thread.started'),
    usage,
  };
}

/** The MCP server's call log as open-log rows: a refused call is 'outside' and was never run. */
function readsFromLog(text) {
  return String(text ?? '').split('\n').filter((l) => l.trim()).map((l) => {
    let j; try { j = JSON.parse(l); } catch { return { tool: 'unparsed', path: null, place: 'outside', decision: 'deny', reason: 'an unreadable MCP log row' }; }
    const a = j.args || {};
    const target = a.path ?? a.glob ?? (Array.isArray(a.args) ? a.args.join(' ') : null);
    return { at: j.at, tool: `mcp:${j.tool}`, path: target, pattern: a.pattern ?? null, place: j.decision === 'allow' ? 'jail' : 'outside', decision: j.decision === 'allow' ? 'allow' : 'deny', reason: j.reason || '' };
  });
}

/** The key lines from the final message: one code fence around them is dropped. */
function keyFromMessage(text) {
  return String(text ?? '').split(/\r?\n/).filter((l) => !/^\s*```[a-z]*\s*$/i.test(l)).join('\n').trim() + '\n';
}

/** Session files Codex kept in the real home for this jail (it should keep none under --ephemeral). */
function codexLeftovers(realHome, jail, sinceMs) {
  const needles = [jail, jail.replace(/\\/g, '/'), jail.replace(/\\/g, '\\\\')].map((s) => s.toLowerCase());
  const out = [];
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = path.join(realHome, sub);
    const walk = (d) => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          let st; try { st = fs.statSync(p); } catch { continue; }
          if (st.mtimeMs < sinceMs) continue;
          let t = ''; try { t = fs.readFileSync(p, 'utf8').toLowerCase(); } catch { continue; }
          if (needles.some((n) => t.includes(n))) out.push(path.relative(realHome, p));
        }
      }
    };
    walk(root);
  }
  return out.sort();
}

/**
 * One codex session in the jail. Returns what the verdict needs; never leaves CODEX_HOME or the login copy behind.
 * opts: { exe, model, jail, scratch, runDir, prompt, keyFile, baseEnv, authFile, realHome, timeoutMs, openLog, jailFiles }.
 */
async function codexSession(opts) {
  const { exe, model, jail, scratch, runDir, keyFile, baseEnv, authFile, openLog, jailFiles } = opts;
  const realHome = opts.realHome ?? path.dirname(authFile);
  const home = fs.mkdtempSync(path.join(path.dirname(scratch), `codexhome-${path.basename(jail)}-`));
  const homeAuth = path.join(home, 'auth.json');
  const lastMsg = path.join(scratch, 'last-message.txt');
  const events = path.join(runDir, 'events.jsonl');
  const mcpLog = path.join(runDir, 'mcp-log.jsonl');
  const res = { exit: null, ms: 0, envLeaks: [], projectLayer: [], homeBefore: [], authAtCall: 0, authRefreshed: 0, authWrittenBack: false, realAuthChanged: false, credentialHits: 0, homeRemoved: false, authAbsentAfter: false, leftovers: [], jailChanged: false, audit: null, reads: [], refused: 0, stderrTail: '' };
  const original = fs.readFileSync(authFile);
  let secrets = authSecrets(original);
  const takeAuth = () => {
    if (!fs.existsSync(homeAuth)) return false;
    const b = fs.readFileSync(homeAuth);
    if (!b.equals(original)) secrets = [...new Set([...secrets, ...authSecrets(b)])];
    fs.rmSync(homeAuth, { force: true });
    return true;
  };
  // Built before the login copy: a jail path codex cannot key throws with nothing to clean up.
  const args = codexArgs({ jail, lastMsg, model, mcpLog });
  try {
    fs.copyFileSync(authFile, homeAuth);
    res.homeBefore = fs.readdirSync(home).sort();
    const env = codexEnv(baseEnv, home);
    res.envLeaks = envLeaks(env);
    const files = jailFiles(jail);
    // A project layer in the jail could weaken the sandbox or add instructions (codex-trust lesson).
    res.projectLayer = files.map((x) => x.path).filter((p) => !p.startsWith('repo.git/') && /(^|\/)(\.codex|AGENTS(\.override)?\.md)(\/|$)/i.test(p));
    if (res.envLeaks.length || res.projectLayer.length || res.homeBefore.join() !== 'auth.json') return res;
    const before = JSON.stringify(files);
    fs.writeFileSync(mcpLog, '');
    const t0 = Date.now();
    let started = false;
    let out = '';
    let buf = '';
    res.exit = await new Promise((resolve) => {
      const child = /\.c?js$/i.test(exe) ? spawn(process.execPath, [exe, ...args], { cwd: jail, env, windowsHide: true }) : spawn(exe, args, { cwd: jail, env, windowsHide: true });
      let err = '';
      child.stdout.on('data', (d) => {
        out += d; buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (!started && j.type === 'thread.started') { started = true; takeAuth(); continue; }
          if (j.type === 'item.started' && j.item?.type !== 'agent_message' && fs.existsSync(homeAuth)) res.authAtCall++;
          if (started && takeAuth()) res.authRefreshed++;
        }
      });
      child.stderr.on('data', (d) => { err += d; });
      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 90 * 60_000);
      child.on('close', (code) => { clearTimeout(timer); res.stderrTail = err.slice(-300); resolve(code); });
      child.on('error', () => { clearTimeout(timer); resolve(-1); });
      child.stdin.end(opts.prompt);
    });
    res.ms = Date.now() - t0;
    if (takeAuth() && started) res.authRefreshed++;
    // Never written back (Jim 49a485): the real login is only compared, so the batch can say whether it changed.
    res.realAuthChanged = !fs.readFileSync(authFile).equals(original);
    const ev = redact(out, secrets);
    const tail = redact(res.stderrTail, secrets);
    const msg = redact(fs.existsSync(lastMsg) ? fs.readFileSync(lastMsg, 'utf8') : '', secrets);
    const log = redact(fs.readFileSync(mcpLog, 'utf8'), secrets);
    res.credentialHits = ev.found + tail.found + msg.found + log.found;
    res.stderrTail = tail.text;
    fs.writeFileSync(events, ev.text);
    fs.writeFileSync(mcpLog, log.text);
    res.audit = auditEvents(ev.text);
    // The open log: one row per MCP call, as the server judged it before reading.
    res.reads = readsFromLog(log.text);
    res.refused = res.reads.filter((r) => r.decision === 'deny').length;
    fs.appendFileSync(openLog, res.reads.map((r) => `${JSON.stringify(r)}\n`).join(''));
    res.jailChanged = JSON.stringify(jailFiles(jail)) !== before;
    if (!res.credentialHits && msg.text.trim()) fs.writeFileSync(keyFile, keyFromMessage(msg.text));
    res.leftovers = codexLeftovers(realHome, jail, t0);
    return res;
  } finally {
    if (fs.existsSync(homeAuth)) fs.rmSync(homeAuth, { force: true });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    res.authAbsentAfter = !fs.existsSync(homeAuth);
    res.homeRemoved = !fs.existsSync(home);
  }
}

/** The first reason a codex session is INVALID, or null. Same order of judgement as the claude path. */
function codexReason(s, key, own) {
  if (s.envLeaks.length) return `env leak: ${s.envLeaks.length} key(s) or PATH dir(s) (${s.envLeaks[0]})`;
  if (s.projectLayer.length) return `the jail holds a codex project layer (${s.projectLayer[0]})`;
  if (s.homeBefore.join() !== 'auth.json') return `CODEX_HOME held more than the login before launch (${s.homeBefore.join(', ')})`;
  if (!s.homeRemoved || !s.authAbsentAfter) return 'CODEX_HOME or the login copy was left behind';
  if (s.leftovers.length) return `${s.leftovers.length} codex session file(s) left for this jail (${s.leftovers[0]})`;
  if (s.credentialHits) return `a credential value appeared in the session output (${s.credentialHits}, redacted)`;
  if (s.authAtCall) return `the login copy was present while ${s.authAtCall} tool call(s) started`;
  if (s.authRefreshed) return `codex wrote a new login during the session; it was deleted and NOT written back${s.realAuthChanged ? ' (the real login also changed during the run, untouched)' : ''}; run the batch again`;
  const a = s.audit;
  if (!a) return 'the session did not run';
  if (a.otherItems.length) return `the session used more than the jail tools (${a.otherItems.join(', ')})`;
  if (s.refused) return `${s.refused} call(s) asked for a path outside the jail and were refused before reading (${s.reads.find((r) => r.decision === 'deny').reason})`;
  if (s.jailChanged) return 'the jail changed during the session';
  if (s.exit !== 0 || !a.turnCompleted || a.failed || a.unparsed) return `session failed (exit ${s.exit})`;
  if (key.problems.length) return `key file: ${key.problems[0]}`;
  if (key.missing.length) return `key file: ${key.missing.length} of ${own.length} rows missing`;
  return null;
}

const codexTokens = (u) => (u ? (u.input_tokens || 0) + (u.output_tokens || 0) : null);

module.exports = { exportGitFacts, GIT_README, codexExe, realAuthFile, codexEnv, envLeaks, authSecrets, redact, codexArgs, auditEvents, readsFromLog, keyFromMessage, codexLeftovers, codexSession, codexReason, codexTokens, CODEX_NOTE, ITEM_TYPES, FEATURES_OFF, sha256 };
