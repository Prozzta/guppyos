'use strict';
/**
 * CLAIMS-90 T6 (god 495956, Jim 475eab): the labeller jail run by Codex instead of Claude Code, so the third read of
 * the H1 key comes from another model family under the same audit. labeller.cjs --provider codex calls this module.
 *
 *   codex exec --json --ephemeral --ignore-user-config --ignore-rules -s read-only, cwd = the mkdtemp jail.
 *   CODEX_HOME is a fresh folder beside the jail (codex refuses helpers under %TEMP%) holding ONLY a copy of the
 *   Codex login. Codex reads it at start; the copy is deleted when codex prints thread.started, which is before any
 *   model reply and so before any command (the unelevated sandbox limits writes, not reads, so an ACL cannot hide
 *   it). A login codex refreshes mid-run is caught, deleted again and written back to the real file (only when that
 *   file is unchanged since the copy), so the Human's login stays valid. The folder is deleted after every run.
 *   The env is the answerer allow-list with no HIVE_*, AGENT_*, MEMORY_*, MUTANT_* (etc.) key and no hive or Guppy
 *   PATH dir; a leak is INVALID before launch.
 *   The read-only sandbox lets no command write and has no network; the model alone talks to the provider. The session
 *   cannot write key.jsonl itself: its final message (codex -o) holds the key lines and the runner writes them.
 *   Every event is audited: a shell command naming a path outside the jail (or reaching one through env, drives or
 *   parent navigation) goes into the open log as outside; any item other than a message, reasoning, a plan or a shell
 *   command is INVALID. A credential value in any output is redacted and INVALID.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const G = require('./labeller-guard.cjs');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ITEM_TYPES = new Set(['agent_message', 'reasoning', 'todo_list', 'command_execution']);
const LEAK_KEY = /^(HIVE|AGENT|MEMORY|MUTANT|MUNDER|GUPPY|CLAUDE|ANTHROPIC|OPENAI|CODEX(?!_HOME$))/i;
const HIVE_DIR = /[\\/](Dunder[\\/]+hive|Munder Difflin)([\\/]|$)/i;
const CODEX_NOTE = '\n\nThis session runs in a read-only sandbox and cannot write files. Do not try to create {keyFile}. End with a final message that holds exactly the lines that file must contain, one JSON object per line, and nothing else.\n';

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

/** The script a codex shell item runs: the -Command argument of its PowerShell launch, else the whole string. */
function shellScript(command) {
  const c = String(command ?? '');
  const m = /^\s*(?:"[^"]*powershell(?:\.exe)?"|\S*powershell(?:\.exe)?)\s+(?:-NoProfile\s+)?-Command\s+([\s\S]*)$/i.exec(c);
  if (!m) return c;
  const s = m[1].trim();
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
}

// Ways to reach outside the jail without naming a path: env, provider drives, the home and parent navigation.
const REACH = /\$env:|\$\{env:|(^|[^\w-])env:|\$HOME\b|\$PSHOME\b|\$PROFILE\b|\[(System\.)?Environment\]|%[A-Za-z_][A-Za-z0-9_]*%|\b(HKLM|HKCU|HKCR|HKU|HKCC|Registry|Cert|Variable|Function|Alias|WSMan):|GetParent|\.Parent\b|Get-PSDrive|GetLogicalDrives|DriveInfo|SpecialFolder|GetFolderPath|GetTempPath|-EncodedCommand|\b(iex|Invoke-Expression|Start-Process|cmd(\.exe)?\s+\/c)\b/i;

/** Judge one shell script: place 'outside' with the first offending path, else 'jail'. */
function judgeShell(script, jail) {
  const s = String(script ?? '');
  const reach = REACH.exec(s);
  if (reach) return { place: 'outside', path: reach[0].trim(), reason: 'reaches outside the jail without a path' };
  if (/(^|[\\/\s'"=(,])\.\.([\\/\s'"),;]|$)/.test(s)) return { place: 'outside', path: '..', reason: 'a path outside the jail' };
  if (/(^|[\s'"=(,])~([\\/\s'"),;]|$)/.test(s)) return { place: 'outside', path: '~', reason: 'a path outside the jail' };
  if (/(^|[\s'"=(,])\\\\/.test(s)) return { place: 'outside', path: '\\\\', reason: 'a UNC or device path' };
  for (const m of s.matchAll(/(?<![A-Za-z0-9_])([A-Za-z]:(?:[\\/][^\s'"`;|,)]*)?)/g)) {
    const p = m[1];
    if (!/[\\/]/.test(p)) return { place: 'outside', path: p, reason: 'a drive outside the jail' };
    if (G.where(p, jail) === 'outside') return { place: 'outside', path: p, reason: 'a path outside the jail' };
  }
  for (const m of s.matchAll(/(?:^|[\s'"=(,])([\\/](?:[A-Za-z0-9_.$-][^\s'"`;|,)]*)?)(?=$|[\s'"`;|,)])/g)) return { place: 'outside', path: m[1], reason: 'a rooted path' };
  return { place: 'jail', path: null, reason: '' };
}

/** What the session did, from the codex JSON events. */
function auditEvents(text, jail) {
  const rows = String(text ?? '').split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return [{ type: 'unparsed' }]; } });
  const calls = [];
  const other = [];
  for (const r of rows) {
    if (r.type !== 'item.completed' && r.type !== 'item.started') continue;
    const it = r.item || {};
    if (!ITEM_TYPES.has(it.type)) { other.push(String(it.type ?? 'unknown')); continue; }
    if (it.type === 'command_execution' && r.type === 'item.completed') {
      const script = shellScript(it.command);
      calls.push({ id: it.id ?? null, tool: 'shell', command: script, exitCode: it.exit_code ?? null, ...judgeShell(script, jail) });
    }
  }
  const completed = rows.filter((r) => r.type === 'turn.completed');
  const usage = completed.length ? completed.reduce((u, r) => {
    for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') u[k] = (u[k] || 0) + v;
    return u;
  }, {}) : null;
  return {
    calls,
    outside: calls.filter((c) => c.place === 'outside').length,
    otherItems: [...new Set(other)],
    failed: rows.filter((r) => /^(turn\.failed|error)$/.test(r.type)).length,
    unparsed: rows.filter((r) => r.type === 'unparsed').length,
    turnCompleted: completed.length > 0,
    threadStarted: rows.some((r) => r.type === 'thread.started'),
    usage,
  };
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
 * opts: { exe, model, jail, scratch, runDir, prompt, keyFile, baseEnv, authFile, realHome, timeoutMs, openLog }.
 */
async function codexSession(opts) {
  const { exe, model, jail, scratch, runDir, keyFile, baseEnv, authFile, openLog, jailFiles } = opts;
  const realHome = opts.realHome ?? path.dirname(authFile);
  const home = fs.mkdtempSync(path.join(path.dirname(scratch), `codexhome-${path.basename(jail)}-`));
  const homeAuth = path.join(home, 'auth.json');
  const lastMsg = path.join(scratch, 'last-message.txt');
  const events = path.join(runDir, 'events.jsonl');
  const res = { exit: null, ms: 0, envLeaks: [], projectLayer: [], homeBefore: [], authAtCommand: 0, authRefreshed: 0, authWrittenBack: false, credentialHits: 0, homeRemoved: false, authAbsentAfter: false, leftovers: [], jailChanged: false, audit: null, stderrTail: '' };
  const original = fs.readFileSync(authFile);
  let secrets = authSecrets(original);
  let latest = null;
  const takeAuth = () => {
    if (!fs.existsSync(homeAuth)) return false;
    const b = fs.readFileSync(homeAuth);
    if (!b.equals(original)) { latest = b; secrets = [...new Set([...secrets, ...authSecrets(b)])]; }
    fs.rmSync(homeAuth, { force: true });
    return true;
  };
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
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-s', 'read-only',
      '-c', 'windows.sandbox="unelevated"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-C', jail, '-o', lastMsg, ...(model ? ['-m', model] : []), '-'];
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
          if (j.type === 'item.started' && j.item?.type === 'command_execution' && fs.existsSync(homeAuth)) res.authAtCommand++;
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
    // Keep the Human's login valid: a refreshed copy goes back, only if the real file is unchanged since the copy.
    if (latest && fs.readFileSync(authFile).equals(original)) {
      fs.writeFileSync(`${authFile}.c90-tmp`, latest);
      fs.renameSync(`${authFile}.c90-tmp`, authFile);
      res.authWrittenBack = true;
    }
    const ev = redact(out, secrets);
    const tail = redact(res.stderrTail, secrets);
    const msg = redact(fs.existsSync(lastMsg) ? fs.readFileSync(lastMsg, 'utf8') : '', secrets);
    res.credentialHits = ev.found + tail.found + msg.found;
    res.stderrTail = tail.text;
    fs.writeFileSync(events, ev.text);
    res.audit = auditEvents(ev.text, jail);
    // The open log: one row per shell command, judged as the guard judges a call.
    fs.appendFileSync(openLog, res.audit.calls.map((c) => `${JSON.stringify({ at: new Date().toISOString(), toolUseId: c.id, tool: 'shell', path: c.path, pattern: null, command: c.command, place: c.place, decision: c.place === 'outside' ? 'deny' : 'allow', reason: c.reason })}\n`).join(''));
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
  if (s.authAtCommand) return `the login copy was present while ${s.authAtCommand} command(s) started`;
  if (s.authRefreshed) return `codex refreshed the login during the session (${s.authWrittenBack ? 'written back' : 'not written back'}); run the batch again`;
  const a = s.audit;
  if (!a) return 'the session did not run';
  if (a.otherItems.length) return `the session used more than shell commands (${a.otherItems.join(', ')})`;
  if (a.outside) return `a call named a path outside the jail (events ${a.outside})`;
  if (s.jailChanged) return 'the jail changed during the session';
  if (s.exit !== 0 || !a.turnCompleted || a.failed || a.unparsed) return `session failed (exit ${s.exit})`;
  if (key.problems.length) return `key file: ${key.problems[0]}`;
  if (key.missing.length) return `key file: ${key.missing.length} of ${own.length} rows missing`;
  return null;
}

const codexTokens = (u) => (u ? (u.input_tokens || 0) + (u.output_tokens || 0) : null);

module.exports = { codexExe, realAuthFile, codexEnv, envLeaks, authSecrets, redact, shellScript, judgeShell, auditEvents, keyFromMessage, codexLeftovers, codexSession, codexReason, codexTokens, CODEX_NOTE, ITEM_TYPES, sha256 };
