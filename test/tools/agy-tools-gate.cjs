'use strict';
/**
 * AGY-TOOLS-166 live probe gate (pre-release; the check the 1.1.55 probe lacked).
 *
 * Writes the PRODUCTION agent.md frontmatter (HiveManager.agyAgentMarkdown, with a tiny probe
 * prompt as its body) into a JAILED agy home and checks, on the real agy CLI:
 *   1. TOOLS (one tiny model turn, print mode): a fresh `--agent` conversation runs run_command
 *      AND write_to_file (file on disk + both names in the transcript), the hooks fire, and the
 *      body's instructions apply. An unknown tool name fails here at once (agy exits 3 before any
 *      model call with `unknown component`).
 *   2. IDLE (no model turn): `agy --agent` in a ConPTY with no prompt stays idle for 20 s:
 *      no hook event, so no startup turn.
 *
 * SAFETY: HOME, USERPROFILE, GEMINI_CLI_HOME, APPDATA and LOCALAPPDATA all point into a fresh
 * temp jail (asserted); hive/agent env vars and hive PATH entries are stripped; nothing is read
 * from or written to the real ~/.gemini; no window (hidden child process, in-process ConPTY).
 *
 * usage: node test/tools/agy-tools-gate.cjs [--agy <path to agy.exe>] [--model "<name>"] [--keep]
 * exit 0 = PASS, 1 = FAIL, 2 = could not run.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const AGY = opt('--agy', path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'));
const MODEL = opt('--model', 'Gemini 3.8 Flash (Low)');
const KEEP = argv.includes('--keep');
const REPO = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
const { HiveManager } = loadTs('src/main/hive.ts');

const NONCE = Math.random().toString(36).slice(2, 8);
const MARK = `Amber otters audit the ferry ${NONCE}`;
const AGENT_ID = `gate-${NONCE}`;

function makeJail() {
  const J = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-gate-'));
  const home = path.join(J, 'home');
  const d = {
    J, home, gem: path.join(home, '.gemini'), cwd: path.join(J, 'cwd'), hooklog: path.join(J, 'hooks.log'),
    roaming: path.join(home, 'AppData', 'Roaming'), local: path.join(home, 'AppData', 'Local')
  };
  for (const p of [d.roaming, d.local, d.cwd, path.join(d.gem, 'config'), path.join(d.gem, 'antigravity-cli')]) fs.mkdirSync(p, { recursive: true });
  // First-run onboarding (colour scheme, terms) would block a fresh home: skip it, trust the cwd.
  fs.writeFileSync(path.join(d.gem, 'antigravity-cli', 'settings.json'),
    JSON.stringify({ colorScheme: 'dark', onboardingComplete: true, telemetryEnabled: false, trustedWorkspaces: [d.cwd] }));
  // A harmless hook logger in both hooks.json files the product writes (same group shape).
  const logger = path.join(J, 'hooklog.cjs');
  fs.writeFileSync(logger, [
    "const fs=require('fs');const [log,ev]=process.argv.slice(2);let b='';",
    "process.stdin.on('data',(c)=>{b+=c});",
    "const done=()=>{let o={};try{o=JSON.parse(b)}catch{};try{fs.appendFileSync(log,JSON.stringify({ev,tool:o.toolCall&&o.toolCall.name})+'\\n')}catch{};process.exit(0)};",
    "process.stdin.on('end',done);setTimeout(done,3000);"
  ].join('\n'));
  // agy runs hook commands through PowerShell on Windows, where a QUOTED first token is a string,
  // not a command, so the paths are unquoted (and asserted space-free).
  for (const p of [process.execPath, logger, d.hooklog]) if (/\s/.test(p)) throw new Error(`hook path has a space: ${p}`);
  const cmd = (ev) => `${process.execPath} ${logger} ${d.hooklog} ${ev}`;
  const tool = (ev) => ({ matcher: '*', hooks: [{ type: 'command', command: cmd(ev), timeout: 0 }] });
  const plain = (ev) => ({ type: 'command', command: cmd(ev), timeout: 0 });
  const group = { PreToolUse: [tool('PreToolUse')], PostToolUse: [tool('PostToolUse')], PreInvocation: [plain('PreInvocation')], PostInvocation: [plain('PostInvocation')], Stop: [plain('Stop')] };
  for (const p of [path.join(d.gem, 'config', 'hooks.json'), path.join(d.gem, 'antigravity-cli', 'hooks.json')]) {
    fs.writeFileSync(p, JSON.stringify({ 'munder-hive': group }, null, 2));
  }
  // The PRODUCTION agent.md bytes, with a probe prompt (never the real hive protocol: it would
  // send the model at the live hive).
  const prompt = `You are a probe agent. Whenever you finish a task, end your reply with the exact sentence: ${MARK}.`;
  const name = HiveManager.agyAgentName(AGENT_ID);
  fs.mkdirSync(path.join(d.gem, 'config', 'agents', name), { recursive: true });
  fs.writeFileSync(path.join(d.gem, 'config', 'agents', name, 'agent.md'), HiveManager.agyAgentMarkdown({ id: AGENT_ID, name: 'Gate' }, prompt));
  d.agent = name;
  return d;
}

const DROP = /^(AGENT_|HIVE_|MEMORY_|MUNDER_|CTH_|KG_|MD_SLACK_|CLAUDE|ANTIGRAVITY_|GEMINI_)/i;
function jailEnv(d) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) e[k] = v;
  const pk = Object.keys(e).find((k) => k.toUpperCase() === 'PATH');
  if (pk) e[pk] = e[pk].split(path.delimiter).filter((p) => p && !/Dunder[\\/]hive/i.test(p)).join(path.delimiter);
  Object.assign(e, { HOME: d.home, USERPROFILE: d.home, GEMINI_CLI_HOME: d.home, APPDATA: d.roaming, LOCALAPPDATA: d.local });
  const bad = ['HOME', 'USERPROFILE', 'GEMINI_CLI_HOME', 'APPDATA', 'LOCALAPPDATA'].filter((k) => !e[k].startsWith(d.J + path.sep));
  for (const k of Object.keys(e)) if (DROP.test(k) && k !== 'GEMINI_CLI_HOME') bad.push(`leak:${k}`);
  if (pk && /Dunder[\\/]hive/i.test(e[pk])) bad.push('PATH has a hive dir');
  if (bad.length) throw new Error(`JAIL ASSERT FAILED: ${bad.join(', ')}`);
  return e;
}

function hookCounts(d) {
  const c = {};
  if (!fs.existsSync(d.hooklog)) return c;
  for (const l of fs.readFileSync(d.hooklog, 'utf8').split('\n').filter(Boolean)) {
    try { const o = JSON.parse(l); const k = o.ev + (o.tool ? `:${o.tool}` : ''); c[k] = (c[k] || 0) + 1; } catch { /* skip */ }
  }
  return c;
}
function transcriptTools(d) {
  const B = path.join(d.gem, 'antigravity-cli', 'brain');
  const tools = {};
  if (!fs.existsSync(B)) return tools;
  for (const id of fs.readdirSync(B)) {
    const T = path.join(B, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(T)) continue;
    for (const l of fs.readFileSync(T, 'utf8').split('\n').filter(Boolean)) {
      try { for (const t of JSON.parse(l).tool_calls || []) tools[t.name] = (tools[t.name] || 0) + 1; } catch { /* skip */ }
    }
  }
  return tools;
}

function printRun(d, args, timeoutMs) {
  return new Promise((res) => {
    const ch = cp.spawn(AGY, args, { cwd: d.cwd, env: jailEnv(d), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    ch.stdout.on('data', (b) => { out += b; });
    ch.stderr.on('data', (b) => { err += b; });
    const k = setTimeout(() => { try { ch.kill(); } catch { /* gone */ } }, timeoutMs);
    ch.on('close', (code) => { clearTimeout(k); res({ code, out, err }); });
  });
}

async function toolsGate() {
  const d = makeJail();
  console.log('[gate] tools run in', d.J);
  const file = `gate-${NONCE}.txt`;
  const r = await printRun(d, ['--model', MODEL, '--dangerously-skip-permissions', '--print-timeout', '180s', '--agent', d.agent,
    '-p', `Use your shell tool to run: echo gate-${NONCE}  Then create a file named ${file} in the current directory containing ok. Then report briefly.`], 240000);
  const tools = transcriptTools(d);
  const hooks = hookCounts(d);
  const checks = {
    'agy accepted the agent (no exit 3 / unknown component)': r.code !== 3 && !/unknown component/i.test(r.err),
    'run_command in the transcript': !!tools.run_command,
    'write_to_file in the transcript': !!tools.write_to_file,
    'the file is on disk with ok': fs.existsSync(path.join(d.cwd, file)) && /ok/.test(fs.readFileSync(path.join(d.cwd, file), 'utf8')),
    'hooks fired for both tools and Stop': !!hooks['PreToolUse:run_command'] && !!hooks['PreToolUse:write_to_file'] && !!hooks.Stop,
    'the agent.md body applied (marker said)': r.out.includes(MARK)
  };
  return { d, checks, detail: { code: r.code, tools, hooks, err: r.err.slice(-400) } };
}

async function idleGate() {
  let pty;
  try { pty = require(require.resolve('node-pty', { paths: [REPO] })); } catch (e) { return { checks: { 'node-pty available for the idle check': false }, detail: { error: String(e) } }; }
  const d = makeJail();
  console.log('[gate] idle run in', d.J);
  const p = pty.spawn(AGY, ['--model', MODEL, '--dangerously-skip-permissions', '--agent', d.agent],
    { name: 'xterm-256color', cols: 120, rows: 30, cwd: d.cwd, env: jailEnv(d) });
  await new Promise((r) => setTimeout(r, 20000));
  const hooks = hookCounts(d);
  try { p.kill(); } catch { /* gone */ }
  return { d, checks: { 'idle for 20 s: no hook event (no startup turn)': Object.keys(hooks).length === 0 }, detail: { hooks } };
}

(async () => {
  if (!fs.existsSync(AGY)) { console.error(`agy not found at ${AGY} (pass --agy)`); process.exit(2); }
  const results = [await toolsGate(), await idleGate()];
  // The idle check is only meaningful when the hook logger demonstrably works (the tools run fired it).
  results[1].checks['the hook logger works (seen in the tools run), so "no hook" is real'] = Object.keys(results[0].detail.hooks).length > 0;
  let ok = true;
  for (const res of results) {
    for (const [name, pass] of Object.entries(res.checks)) { console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && pass; }
    console.log('      ', JSON.stringify(res.detail));
    if (res.d && !KEEP) fs.rmSync(res.d.J, { recursive: true, force: true });
  }
  console.log(ok ? 'AGY-TOOLS GATE: PASS' : 'AGY-TOOLS GATE: FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('AGY-TOOLS GATE could not run:', e.message); process.exit(2); });
