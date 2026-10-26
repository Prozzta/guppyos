'use strict';
/**
 * CLAIMS-90 M4: the contained answerer (god's ruling 18:26, test-only). For each item it starts
 * from the T_s state (a fresh sandbox copy of the snapshot, so the item order cannot change an
 * answer), brings up answer-child.cjs in serve mode over it, and runs ONE Claude Code CLI session
 * that plays the asking agent and makes its own `memory` calls:
 *   - env: the loopback MUNDER_MEMORY_URL, a token for the asker, the jailed MUNDER_HIVE_ROOT;
 *     nothing else of the hive (allow-list), and no hive folder on PATH;
 *   - cwd: an empty folder in the jail; no user, project or MCP settings, no skills or commands;
 *   - hooks: the installed app's tool-output hook entries (shape read from app.asar, recorded),
 *     pointed at the serve child, where the tree's own HookServer.condensedToolOutput answers;
 *     SessionStart hands it the snapshot briefing that main renders for the asker;
 *   - tools: Bash, allowed only for `memory`, and Read, allowed only on its saved tool outputs.
 * The first context is that briefing, then the instruction with the question. Each session's
 * transcript is scanned for live paths and URLs (leak check: a hit makes the item INVALID).
 *
 *   node test/claims-90/answerer.cjs --snapshot <dir> --addendum <dir> --items <items.jsonl>
 *        --instruction <file> --out <dir> [--model <id>] [--claude <exe>] [--resources <dir>] [--keep]
 *        [--build <worktree>]   serve a branch build (its src, out/ hook shape, Electron and memory-cli)
 *        [--hide-stale 0|1]     C90_HIDE_STALE for the serve child (step 3 OFF arm: 0); recorded in run.json appEnv
 *        [--preflight-only]     run the preflight (every verb an agent is shown, one real call each) and stop
 *
 * items.jsonl: { "id": "...", "asker": "<agent id>", "question": "..." }
 * The instruction file may use {asker}, {today} and {question}.
 * Writes only under --out: items/<id>/ (transcript, hook log, call log, briefing), answers.jsonl
 * and run.json. Item text and answers stay local; mails carry counts and shas only.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { drillEnv } = require('../claims-drill/runner.cjs');
const R = require('./run.cjs');
const { memoryMdOf, memoryMdCommand } = require('./memory-md.cjs');
const { UNAVAILABLE_RE } = require('./claims-deps.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MAX_CALLS = 5;
const ITEM_TIMEOUT_MS = 10 * 60_000;
const INSTALLED_APP = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Munder Difflin', 'Guppy');

/** The serve child's environment: the drill allow-list, plus C90_HIDE_STALE when --hide-stale names it (step 3 arms). */
function serveEnv(o, home) {
  const env = drillEnv(home);
  if (o.hideStale !== undefined) env.C90_HIDE_STALE = o.hideStale;
  return env;
}

function parseArgs(argv) {
  const o = { keep: false, model: 'claude-opus-5-5' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (a === '--preflight-only') o.preflightOnly = true;
    else if (/^--(snapshot|addendum|items|instruction|out|model|claude|resources|tree|build)$/.test(a)) o[a.slice(2)] = argv[++i];
    else if (a === '--hide-stale') { o.hideStale = argv[++i]; if (!/^[01]$/.test(o.hideStale)) throw new Error('--hide-stale takes 0 or 1'); }
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['snapshot', 'addendum', 'items', 'instruction', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
  // god 7fea2c: --build serves memory from a branch build (a worktree at that commit, built: out/,
  // node_modules) in place of the installed app: its src is the tree, its out/ the hook shape, its
  // Electron and resources/memory-cli.cjs the shim. --resources (the models) stays the installed one.
  if (o.build) {
    o.build = path.resolve(o.build);
    if (o.tree && path.resolve(o.tree).toLowerCase() !== o.build.toLowerCase()) throw new Error('--tree and --build name different trees');
    o.tree = o.build;
  }
  o.tree = path.resolve(o.tree || REPO);
  o.resources = path.resolve(o.resources || path.join(INSTALLED_APP, 'resources'));
  o.claude = o.claude || claudeExe();
  return o;
}

function parseItems(file) {
  // Jim's DEV item files name the id `itemId`; the gate files name it `id`.
  const items = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
    .map((it) => (it.id === undefined && it.itemId !== undefined ? { ...it, id: it.itemId } : it));
  const ids = new Set();
  for (const it of items) {
    if (typeof it.id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(it.id) || ids.has(it.id)) throw new Error(`item id missing, unsafe or repeated: ${it.id}`);
    ids.add(it.id);
    if (typeof it.asker !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(it.asker)) throw new Error(`${it.id}: bad asker`);
    if (typeof it.question !== 'string' || !it.question.trim()) throw new Error(`${it.id}: no question`);
  }
  return items;
}

/** The Claude Code binary the PATH's claude.cmd starts (the existing CLI login on this PC). */
function claudeExe() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (fs.existsSync(path.join(dir, 'claude.cmd')) && fs.existsSync(exe)) return exe;
  }
  throw new Error('no Claude Code CLI on PATH');
}

/** The tool-output hook entry as the INSTALLED app writes it (hive.ts hookSettings), read from app.asar. */
function installedHookShape(resources) {
  const asarFile = path.join(resources, 'app.asar');
  const asar = require(path.join(REPO, 'node_modules', '@electron', 'asar'));
  const js = asar.extractFile(asarFile, path.join('out', 'main', 'index.js')).toString('utf8');
  return { asarSha256: sha256(fs.readFileSync(asarFile)), ...hookShapeOf(js, 'the installed app.asar') };
}

/** The tool-output hook entry in a built out/main/index.js (hive.ts hookSettings, as bundled). */
function hookShapeOf(js, what) {
  const timeout = /HOOK_HTTP_TIMEOUT_S = (\d+);/.exec(js);
  const entry = /const hook = \(matcher\) => hookUrl \? \{ \.\.\.matcher \? \{ matcher \} : \{\}, hooks: \[\{ type: "http", url: hookUrl, timeout: HOOK_HTTP_TIMEOUT_S \}\] \} : entry\(matcher\)/.exec(js);
  const events = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].filter((e) => js.includes(`${e}: [hook("*")]`));
  if (!timeout || !entry || events.length !== 3) throw new Error(`${what} does not wire the tool hooks as expected`);
  return { mainSha256: sha256(js), entrySource: entry[0], timeout: Number(timeout[1]), events, matcher: '*' };
}

/** A branch build's hook shape, from the out/main/index.js built in its worktree. */
function buildHookShape(build) {
  const file = path.join(build, 'out', 'main', 'index.js');
  if (!fs.existsSync(file)) throw new Error(`the build has no out/main/index.js (build it in its worktree first): ${build}`);
  return { asarSha256: null, ...hookShapeOf(fs.readFileSync(file, 'utf8'), 'the build\'s out/main/index.js') };
}

/** Every file under a folder, hashed in path order (the build's out/ as one identity). */
function treeSha256(dir) {
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map(fwd).sort();
  return sha256(files.map((f) => `${f}\0${sha256(fs.readFileSync(path.join(dir, f)))}`).join('\n'));
}

/** What run.json records of a branch build: its commit, whether src or resources differ from it, its out/. */
function buildInfo(build) {
  const asar = path.join(build, 'dist', 'win-unpacked', 'resources', 'app.asar');
  return {
    dir: path.basename(build),
    commit: R.git(build, ['rev-parse', 'HEAD']),
    dirty: R.git(build, ['status', '--porcelain', '--', 'src', 'resources']) || '',
    outMainSha256: sha256(fs.readFileSync(path.join(build, 'out', 'main', 'index.js'))),
    outSha256: treeSha256(path.join(build, 'out')),
    memoryCliSha256: sha256(fs.readFileSync(path.join(build, 'resources', 'memory-cli.cjs'))),
    asarSha256: fs.existsSync(asar) ? sha256(fs.readFileSync(asar)) : null,
  };
}

/** The tree's toolOutputCondense (the readType test), one load per tree. */
const condensers = new Map();
function condenseOf(tree) {
  if (!condensers.has(tree)) condensers.set(tree, require(path.join(tree, 'test', 'load-ts.cjs'))(path.join(tree, 'src', 'main', 'toolOutputCondense.ts')));
  return condensers.get(tree);
}

/** The installed `memory` shim, copied into the jail's bin (the same command an agent shell runs). */
function installMemoryShim(binDir) {
  const text = fs.readFileSync(path.join('C:\\', 'Dunder', 'hive', 'bin', 'memory', 'memory'), 'utf8');
  if (!text.includes(path.join(INSTALLED_APP, 'resources', 'memory-cli.cjs').replace(/\\/g, '/'))) throw new Error('the memory shim does not run the installed CLI');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'memory'), text);
  return { sha256: sha256(text) };
}

/** A branch build's `memory` shim: the installed shim's form, with the build's Electron and memory-cli.cjs. */
function buildMemoryShim(binDir, build) {
  const cli = path.join(build, 'resources', 'memory-cli.cjs');
  if (!fs.existsSync(cli)) throw new Error('the build has no resources/memory-cli.cjs');
  const text = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${fwd(R.electronOf(build))}" "${fwd(cli)}" "$@"\n`;
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'memory'), text);
  return { sha256: sha256(text.split(fwd(build)).join('<build>')), memoryCliSha256: sha256(fs.readFileSync(cli)) };
}

const fwd = (p) => p.replace(/\\/g, '/');

function settingsFor(shape, hookUrl, briefingFile, toolOutputDir, sandboxHive) {
  const http = { matcher: shape.matcher, hooks: [{ type: 'http', url: hookUrl, timeout: shape.timeout }] };
  const hooks = {};
  for (const e of shape.events) hooks[e] = [http];
  hooks.SessionStart = [{ hooks: [{ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(path.join(__dirname, 'briefing-hook.cjs'))}" "${fwd(briefingFile)}"` }] }];
  const live = ['C:/Dunder/hive', fwd(path.join(process.env.APPDATA || '', 'Guppy'))];
  return {
    hooks,
    permissions: {
      allow: ['Bash(memory:*)', `Read(//${fwd(toolOutputDir).replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase())}/**)`,
        // C0b (god 21:21): the claim-history pointer, on the T_s copy; the hook rewrites a live path to it.
        ...(sandboxHive ? [`Read(//${fwd(sandboxHive).replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase())}/agents/*/memory.md)`] : [])],
      deny: [
        // A deny rule is matched on the path the model typed, before any PreToolUse hook runs (probed on CLI
        // 2.1.310), so a Read deny on the live hive would refuse the memory.md Read the hook rewrites. With a
        // sandbox, the live Read is left to the hook (rewrite or deny) and, behind it, to having no allow rule.
        ...live.flatMap((p, i) => { const d = `//${p.replace(/^([A-Za-z]):/, (_, x) => x.toLowerCase())}/**`; return i === 0 && sandboxHive ? [`Edit(${d})`] : [`Read(${d})`, `Edit(${d})`]; }),
        'WebFetch', 'WebSearch',
      ],
      defaultMode: 'default',
    },
  };
}

function childEnv(jailBin, memEnv) {
  const keep = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'ProgramW6432', 'CommonProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'CLAUDE_CODE_GIT_BASH_PATH'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env.PATH = [jailBin, ...(process.env[pathKey] || '').split(path.delimiter).filter((d) => d && !/[\\/]Dunder[\\/]hive/i.test(d))].join(path.delimiter);
  return { ...env, ...memEnv };
}

const LIVE_RES = () => {
  const res = [/[\\/]+Dunder[\\/]+hive/i];
  const ud = path.join(process.env.APPDATA || 'C:/none', 'Guppy').replace(/[\\/]+/g, '[\\\\/]+').replace(/[.()]/g, '\\$&');
  res.push(new RegExp(ud, 'i'));
  for (const k of ['MUNDER_MEMORY_URL', 'HIVE_LEDGER_URL']) {
    const port = /:(\d{2,5})\b/.exec(process.env[k] || '');
    if (port) res.push(new RegExp(`(127\\.0\\.0\\.1|localhost):${port[1]}\\b`));
  }
  return res;
};

/**
 * Jim 19:03: a call that is not a bare `memory` command (a pipe, a redirection, a chain, #full,
 * or a non-memory command) is a style deviation. It is counted, never dropped. Quoted text (the
 * query) is ignored, so a query holding such characters is still bare.
 */
function styleDeviation(c) {
  if (c.tool !== 'Bash' || typeof c.command !== 'string') return c.tool === 'Bash';
  const unquoted = c.command.trim().replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
  return !/^memory\s/.test(unquoted) || /[|<>;&`]|\$\(|#full/.test(unquoted);
}

/**
 * Jim 19:32 (god 38046f): per item, whether every call was bare, plus the style counts. A Read of
 * a saved output is not bare. A session with no calls is vacuously bare; `calls` shows it.
 */
function itemStyle(calls = []) {
  return {
    allBare: calls.every((c) => c.tool === 'Bash' && !c.styleDeviation),
    calls: calls.length,
    readTypeCalls: calls.filter((c) => c.readType).length,
    fullCalls: calls.filter((c) => typeof c.command === 'string' && /#full/.test(c.command)).length,
    styleDeviations: calls.filter((c) => c.styleDeviation).length,
  };
}

/**
 * God 21:45: memory.md use per item, by command and by path form, and whether the answer quotes it
 * (any 40-char run of the answer, whitespace folded, found in a memory.md copy the item read). Counts only.
 */
function memoryMdUse(calls = [], answer = null, sandboxHive = null) {
  const byCommand = {};
  for (const c of calls) byCommand[c.tool] = (byCommand[c.tool] ?? 0) + 1;
  const fold = (x) => x.replace(/\s+/g, ' ').trim();
  let quoted = false;
  if (calls.length && answer && sandboxHive) {
    const text = [...new Set(calls.flatMap((c) => c.agents))].map((a) => { try { return fold(fs.readFileSync(path.join(sandboxHive, 'agents', a, 'memory.md'), 'utf8')); } catch { return ''; } }).join('\n');
    const ans = fold(answer);
    for (let i = 0; i + 40 <= ans.length && !quoted; i += 5) quoted = text.includes(ans.slice(i, i + 40));
  }
  return { calls: calls.length, byCommand, rewritten: calls.filter((c) => c.kind === 'rewritten').length, sandbox: calls.filter((c) => c.kind === 'sandbox').length, quoted };
}

const filesIn = (dir) => { try { return dir ? fs.readdirSync(dir, { recursive: true }).length : 0; } catch { return 0; } };

/** What the session did, from its stream-json transcript. Text stays local; the row holds counts. */
function readTranscript(file, allowedRead, liveRes, memoryMd = null) {
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
  const init = rows.find((r) => r.type === 'system' && r.subtype === 'init') || null;
  const result = rows.find((r) => r.type === 'result') || null;
  const uses = [];
  const results = new Map();
  for (const r of rows) {
    for (const c of (r.message?.content && Array.isArray(r.message.content) ? r.message.content : [])) {
      if (r.type === 'assistant' && c.type === 'tool_use') uses.push(c);
      if (r.type === 'user' && c.type === 'tool_result') results.set(c.tool_use_id, { text: typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join(''), isError: !!c.is_error });
    }
  }
  const leaks = [];
  // C0b: a memory.md read is not a leak when the serve hook allowed that very call (hooks.jsonl row with
  // memoryMd, same command) and it passes the same rule here; a sandbox-path Read needs no hook row.
  const memoryMdCalls = [];
  for (const u of uses) {
    const h = memoryMd?.hooked.get(u.id);
    if (memoryMd && u.name === 'Read') {
      const m = memoryMdOf(u.input?.file_path, memoryMd.sandboxHive);
      if (m && (m.kind === 'sandbox' || h?.memoryMd?.kind === 'rewritten')) { memoryMdCalls.push({ id: u.id, tool: 'Read', kind: m.kind === 'live' ? 'rewritten' : 'sandbox', agents: [m.agent] }); continue; }
    }
    if (memoryMd && u.name === 'Bash' && h?.memoryMd && h.command === u.input?.command) {
      const b = memoryMdCommand(u.input?.command, memoryMd.sandboxHive);
      if (b) { memoryMdCalls.push({ id: u.id, tool: b.cmd, kind: b.kind, agents: b.agents }); continue; }
    }
    const s = JSON.stringify(u.input);
    for (const re of liveRes) if (re.test(s)) leaks.push({ tool: u.name, id: u.id, pattern: String(re) });
    if (u.name === 'Read' && !String(u.input?.file_path || '').replace(/\\/g, '/').toLowerCase().startsWith(allowedRead.toLowerCase())) leaks.push({ tool: 'Read', id: u.id, pattern: 'outside the tool-output folder' });
  }
  return {
    init: init ? {
      model: init.model, tools: init.tools, mcpServers: (init.mcp_servers || []).length, slashCommands: (init.slash_commands || []).length, skills: (init.skills || []).length,
      // Claude Code's own built-in plugins are part of the CLI; anything else came from a user setting.
      builtinPlugins: (init.plugins || []).filter((p) => p.path === 'builtin').map((p) => p.name), otherPlugins: (init.plugins || []).filter((p) => p.path !== 'builtin').length,
      autoMemoryFiles: filesIn(init.memory_paths?.auto), additionalDirectories: (init.additional_directories || []).length,
      permissionMode: init.permissionMode, claudeCodeVersion: init.claude_code_version,
    } : null,
    calls: uses.map((u) => ({ id: u.id, tool: u.name, command: u.input?.command ?? null, file: u.input?.file_path ?? null, result: results.get(u.id) ?? null })),
    answer: result?.result ?? null,
    result: result ? { isError: !!result.is_error, subtype: result.subtype, turns: result.num_turns, costUsd: result.total_cost_usd, usage: result.usage, denials: (result.permission_denials || []).length } : null,
    leaks,
    memoryMdCalls,
  };
}

function waitFor(file, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { if (fs.existsSync(file)) resolve(true); else if (Date.now() - t0 > ms) resolve(false); else setTimeout(tick, 250); };
    tick();
  });
}

function closeOf(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { p.kill(); }, ms);
    p.on('close', (code) => { clearTimeout(t); resolve(code); });
  });
}

/** Why one preflight call fails, or null: a non-zero exit, a reply that the build does not answer the verb, or nothing. */
function preflightProblem(r) {
  if (r.code !== 0) return `exit ${r.code}`;
  if (UNAVAILABLE_RE.test(`${r.stdout}\n${r.stderr}`)) return 'the build does not answer it';
  if (!r.stdout.trim()) return 'an empty reply';
  return null;
}

/** Jim 4370f6 run guard: the calls of one item that the build did not answer (serve log, and what the transcript shows). */
function unavailableOf(memCalls, transcriptCalls) {
  return {
    serve: memCalls.filter((m) => m.unavailable).length,
    transcript: transcriptCalls.filter((c) => UNAVAILABLE_RE.test(c.result?.text ?? '')).length,
  };
}

/**
 * god 3164a1 (R5): the claude -p child keeps the CLI login and its default config dir, so Claude Code
 * makes a project folder for each session under ~/.claude/projects, named after the session cwd (each
 * character other than a letter or digit becomes '-'). It holds snapshot content (tool-results spills),
 * so after each session the runner copies it into the run dir, checks the bytes, and deletes it: that
 * exact folder only, never one holding a link. A folder still matching the answerer prefixes after that
 * is a leftover: the item is INVALID and the run stops.
 */
const LEFTOVER_PREFIX = 'C--Dunder--work-claims-90-answerer-';
const projectSlug = (cwd) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
const claudeProjectsDir = (env = process.env) => path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'), 'projects');
const leftoverPrefixes = (outDir) => [LEFTOVER_PREFIX, `${projectSlug(outDir)}-`];

function filesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
  walk(dir);
  return out.sort();
}

function sessionFolderOut(projects, cwd, dest) {
  const folder = projectSlug(cwd);
  const src = path.join(projects, folder);
  if (!fs.existsSync(src)) return { folder, created: false, files: 0, removed: false, problem: null };
  if (fs.lstatSync(src).isSymbolicLink() || R.linksUnder(src).length) return { folder, created: true, files: 0, removed: false, problem: 'the session folder holds a link' };
  const to = path.join(dest, folder);
  fs.cpSync(src, to, { recursive: true });
  const files = filesUnder(src);
  const unequal = files.filter((f) => !fs.existsSync(path.join(to, f)) || !fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(to, f))));
  if (unequal.length) return { folder, created: true, files: files.length, removed: false, problem: `${unequal.length} copied file(s) differ` };
  fs.rmSync(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return { folder, created: true, files: files.length, removed: !fs.existsSync(src), problem: fs.existsSync(src) ? 'the session folder could not be deleted' : null };
}

function leftoversIn(projects, prefixes) {
  let names = [];
  try { names = fs.readdirSync(projects); } catch { return []; }
  return names.filter((n) => prefixes.some((p) => n.startsWith(p))).sort();
}

/** The item's (or the preflight's) session folder out of ~/.claude/projects, then the leftover check. */
function sessionGuard(home, dest, outDir) {
  const projects = claudeProjectsDir();
  let session;
  try { session = sessionFolderOut(projects, path.join(home, 'cwd'), dest); } catch (e) { session = { folder: projectSlug(path.join(home, 'cwd')), created: null, files: 0, removed: false, problem: String(e.message || e).slice(0, 200) }; }
  const leftovers = leftoversIn(projects, leftoverPrefixes(outDir));
  return { session, leftovers, problem: session.problem ?? (leftovers.length ? `${leftovers.length} answerer folder(s) left in ~/.claude/projects (${leftovers[0]})` : null) };
}

function runOnce(exe, args, env) {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    p.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Jim 4370f6 MUST 2: before the first item, one real call of every verb an agent is shown (wake-up,
 * search, get <real key> --agent <asker>, history <real claim id>) through a serve child on the
 * staged snapshot, with the build's own memory CLI. A non-zero exit, a reply that the build does not
 * answer the verb, or an empty reply stops the run before any spend. Counts only are kept.
 */
async function preflight(o, v, addDir, key, asker, outDir) {
  const dir = path.join(outDir, 'preflight');
  fs.mkdirSync(dir, { recursive: true });
  const home = fs.mkdtempSync(path.join(outDir, 'sandbox-'));
  for (const d of ['tmp', path.join('AppData', 'Local'), 'cwd']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const calls = [];
  let probe = null;
  try {
    const { hive, userData } = R.stageSandbox(path.resolve(o.snapshot), v.manifest, home);
    const world = path.join(home, 'world.json');
    fs.copyFileSync(path.join(addDir, 'world.json'), world);
    const serve = { askers: [asker], maxCalls: MAX_CALLS, connectFile: path.join(dir, 'connect.json'), callsFile: path.join(dir, 'calls.jsonl'), hookLogFile: path.join(dir, 'hooks.jsonl'), stopFile: path.join(home, 'stop') };
    for (const f of [serve.connectFile, serve.callsFile, serve.hookLogFile]) fs.rmSync(f, { force: true });
    const specFile = path.join(home, 'answer-spec.json');
    fs.writeFileSync(specFile, JSON.stringify({ tree: o.tree, hive, userData, home, resourcesDir: o.resources, now: v.manifest.takenFrom, world, items: [], out: path.join(dir, 'serve.jsonl'), serve }));
    const server = spawn(R.electronOf(o.tree), [path.join(__dirname, 'answer-child.cjs'), specFile], { cwd: o.tree, env: serveEnv(o, home), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let serverErr = '';
    server.stderr.on('data', (d) => { if (serverErr.length < 20000) serverErr += d; });
    const serverClosed = closeOf(server, 10 * 60_000);
    server.stdin.end(`${key}\n`);
    try {
      if (!(await waitFor(serve.connectFile, 5 * 60_000))) return { ok: false, reason: `the serve child did not come up: ${serverErr.slice(0, 300)}`, calls };
      const connect = JSON.parse(fs.readFileSync(serve.connectFile, 'utf8'));
      const p = connect.probe;
      if (!p) return { ok: false, reason: 'no keyed claim in the snapshot to probe get and history with', calls };
      const cliTree = o.build || o.tree;
      const cli = path.join(cliTree, 'resources', 'memory-cli.cjs');
      const env = { ...childEnv(path.join(home, 'bin'), { MUNDER_HIVE_ROOT: hive, MUNDER_MEMORY_URL: connect.url, MEMORY_TOKEN: connect.askers[asker].token }), ELECTRON_RUN_AS_NODE: '1' };
      for (const argv of [['wake-up'], ['search', p.key], ['get', p.key, '--agent', asker], ['history', p.claimId]]) {
        const r = await runOnce(R.electronOf(cliTree), [cli, ...argv], env);
        calls.push({ cmd: argv[0], exit: r.code, chars: r.stdout.length, sha256: sha256(r.stdout), problem: preflightProblem(r) });
      }
    } finally {
      fs.writeFileSync(serve.stopFile, '');
      await serverClosed;
    }
    // god 3164a1: one tiny claude -p from a sandbox cwd proves the session folder is the one the guard
    // names (it must appear) and that the guard moves it out (none may remain).
    probe = await claudeProbe(o, home);
    const guard = sessionGuard(home, path.join(dir, 'session'), outDir);
    probe = { exit: probe.code, costUsd: probe.costUsd, ...guard, problem: probe.code !== 0 ? `claude -p exit ${probe.code}` : !guard.session.created ? `no session folder ${guard.session.folder} in ~/.claude/projects` : guard.problem };
    const bad = calls.filter((c) => c.problem);
    if (probe.problem) bad.push({ cmd: 'claude -p', problem: probe.problem });
    return bad.length ? { ok: false, reason: bad.map((c) => `${c.cmd}: ${c.problem}`).join('; '), calls, probe } : { ok: true, calls, probe };
  } finally {
    if (!o.keep) {
      const inner = R.linksUnder(home);
      if (inner.length) console.error(`[claims-90] kept the sandbox: it holds a link (${inner[0]})`);
      else fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

function claudeProbe(o, home) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', o.model, '--output-format', 'json', '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--tools', 'Read', '--permission-mode', 'default'];
    const p = spawn(o.claude, args, { cwd: path.join(home, 'cwd'), env: childEnv(path.join(home, 'bin'), {}), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    p.stderr.resume();
    p.stdin.end('Reply with the single word ok.');
    p.on('close', (code) => { let costUsd = null; try { costUsd = JSON.parse(stdout).total_cost_usd ?? null; } catch { /* not json */ } resolve({ code, costUsd }); });
  });
}

async function answerItem(o, v, addDir, item, key, shape, instruction, outDir) {
  const itemDir = path.join(outDir, 'items', item.id);
  fs.mkdirSync(itemDir, { recursive: true });
  const home = fs.mkdtempSync(path.join(outDir, 'sandbox-'));
  for (const d of ['tmp', path.join('AppData', 'Local'), 'cwd']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const row = { id: item.id, asker: item.asker };
  try {
    const { hive, userData, hiveId } = R.stageSandbox(path.resolve(o.snapshot), v.manifest, home);
    const queueFile = path.join(hive, 'claims-reconcile-queue.json');
    row.stateSha256 = fs.existsSync(queueFile) ? sha256(fs.readFileSync(queueFile)) : null;
    const world = path.join(home, 'world.json');
    fs.copyFileSync(path.join(addDir, 'world.json'), world);
    const serve = { askers: [item.asker], maxCalls: MAX_CALLS, connectFile: path.join(itemDir, 'connect.json'), callsFile: path.join(itemDir, 'calls.jsonl'), hookLogFile: path.join(itemDir, 'hooks.jsonl'), stopFile: path.join(home, 'stop') };
    for (const f of [serve.connectFile, serve.callsFile, serve.hookLogFile]) fs.rmSync(f, { force: true });
    const specFile = path.join(home, 'answer-spec.json');
    const answers = path.join(itemDir, 'serve.jsonl');
    fs.writeFileSync(specFile, JSON.stringify({ tree: o.tree, hive, userData, home, resourcesDir: o.resources, now: v.manifest.takenFrom, world, items: [], out: answers, serve }));
    const server = spawn(R.electronOf(o.tree), [path.join(__dirname, 'answer-child.cjs'), specFile], { cwd: o.tree, env: serveEnv(o, home), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    let serverErr = '';
    server.stderr.on('data', (d) => { if (serverErr.length < 20000) serverErr += d; });
    const serverClosed = closeOf(server, ITEM_TIMEOUT_MS + 5 * 60_000);
    server.stdin.end(`${key}\n`);
    if (!(await waitFor(serve.connectFile, 5 * 60_000))) {
      fs.writeFileSync(serve.stopFile, '');
      await serverClosed;
      row.invalid = `the serve child did not come up: ${serverErr.slice(0, 300)}`;
      return row;
    }
    const connect = JSON.parse(fs.readFileSync(serve.connectFile, 'utf8'));
    const a = connect.askers[item.asker];
    row.briefing = { chars: a.briefingChars, sha256: a.briefingSha256 };
    const jailBin = path.join(home, 'bin');
    row.memoryShim = o.build ? buildMemoryShim(jailBin, o.build) : installMemoryShim(jailBin);
    const settingsFile = path.join(home, 'claude-settings.json');
    const settings = settingsFor(shape, a.hookUrl, a.briefing, a.toolOutputDir, hive);
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 1));
    row.settingsSha256 = sha256(JSON.stringify({ ...settings, hooks: { ...settings.hooks, SessionStart: '<briefing>' } }).replace(a.hookUrl, '<hook>').replace(/sandbox-[A-Za-z0-9]+/g, 'sandbox-*'));
    const prompt = instruction.replace(/\{asker\}/g, item.asker).replace(/\{today\}/g, v.manifest.takenFrom).replace(/\{question\}/g, item.question);
    const transcript = path.join(itemDir, 'transcript.jsonl');
    const args = ['-p', '--model', o.model, '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      '--settings', settingsFile, '--setting-sources', 'project,local', '--strict-mcp-config', '--disable-slash-commands',
      '--no-session-persistence', '--tools', 'Bash,Read', '--permission-mode', 'default'];
    const env = childEnv(jailBin, { MUNDER_HIVE_ROOT: hive, MUNDER_MEMORY_URL: connect.url, MEMORY_TOKEN: a.token });
    const t0 = Date.now();
    const cc = spawn(o.claude, args, { cwd: path.join(home, 'cwd'), env, windowsHide: true, stdio: ['pipe', fs.openSync(transcript, 'w'), 'pipe'] });
    let ccErr = '';
    cc.stderr.on('data', (d) => { if (ccErr.length < 20000) ccErr += d; });
    cc.stdin.end(prompt);
    row.exit = await closeOf(cc, ITEM_TIMEOUT_MS);
    row.ms = Date.now() - t0;
    fs.writeFileSync(serve.stopFile, '');
    await serverClosed;
    const hookRows = fs.existsSync(serve.hookLogFile) ? fs.readFileSync(serve.hookLogFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const t = readTranscript(transcript, fwd(a.toolOutputDir), LIVE_RES(), { sandboxHive: hive, hooked: new Map(hookRows.filter((x) => x.event === 'PreToolUse' && x.memoryMd).map((x) => [x.toolUseId, x])) });
    const memCalls = fs.existsSync(serve.callsFile) ? fs.readFileSync(serve.callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const serveRows = fs.existsSync(answers) ? fs.readFileSync(answers, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    row.serve = serveRows.find((r) => r.summary)?.summary ?? { ok: false, reason: serverErr.slice(0, 300) };
    // Gate 1: what the transcript shows the model = the tree's hook = the runner's view.
    const Condense = condenseOf(o.tree);
    row.calls = t.calls.map((c) => {
      const h = hookRows.find((x) => x.event === 'PostToolUse' && x.toolUseId === c.id);
      const f = hookRows.find((x) => x.event === 'PostToolUseFailure' && x.toolUseId === c.id);
      const seen = c.result?.text ?? null;
      return {
        // god 19:02 ruling 1: read-type (a pipe through head, grep …: the read cap) or bare, per call.
        tool: c.tool, command: c.command, file: c.file, readType: c.tool === 'Bash' && c.command ? Condense.isReadCommand(c.command) : null, styleDeviation: styleDeviation(c), event: h ? 'PostToolUse' : f ? 'PostToolUseFailure' : null, isError: c.result?.isError ?? null,
        seenChars: seen === null ? null : seen.length, seenSha256: seen === null ? null : sha256(seen),
        condensed: !!h?.hook, hookEqualsRunner: h && 'parity' in h ? h.parity : null, transcriptEqualsHook: h?.hook ? seen === h.hook : null,
        failureErrorEqualsTranscript: f?.failure?.errorSha256 && seen !== null ? f.failure.errorSha256 === sha256(seen) : null,
        responseChars: h?.response?.stdoutChars ?? null, persisted: h?.response?.persisted ?? null,
      };
    });
    row.memoryCalls = memCalls.map((m) => ({ cmd: m.cmd, args: m.args, exit: m.exit, chars: m.chars, textSha256: m.textSha256, unavailable: !!m.unavailable }));
    row.unavailable = unavailableOf(memCalls, t.calls);
    row.denied = hookRows.filter((x) => x.denied).length;
    row.memoryMd = memoryMdUse(t.memoryMdCalls, t.answer, hive);
    row.init = t.init;
    row.result = t.result;
    row.answerSha256 = t.answer === null ? null : sha256(t.answer);
    fs.writeFileSync(path.join(itemDir, 'answer.txt'), t.answer ?? '');
    row.leaks = t.leaks;
    const initOk = t.init && JSON.stringify([...(t.init.tools || [])].sort()) === JSON.stringify(['Bash', 'Read']) && t.init.mcpServers === 0 && t.init.otherPlugins === 0 && t.init.autoMemoryFiles === 0 && t.init.additionalDirectories === 0;
    if (t.leaks.length) row.invalid = `leak check: ${t.leaks.length} hit(s)`;
    else if (!initOk) row.invalid = 'the session started with more than the shim tools';
    else if (row.unavailable.serve || row.unavailable.transcript) row.invalid = `a memory verb was not answered (serve ${row.unavailable.serve}, transcript ${row.unavailable.transcript})`;
    else if (row.exit !== 0 || !t.result || t.result.isError) row.invalid = `session failed (exit ${row.exit}): ${ccErr.slice(0, 200)}`;
    else if (!row.serve.ok) row.invalid = `serve: ${row.serve.reason}`;
    const idx = path.join(userData, 'memory', `${hiveId.to}-v2.sqlite`);
    row.indexAfterSha256 = fs.existsSync(idx) ? sha256(fs.readFileSync(idx)) : null;
    return row;
  } finally {
    const guard = sessionGuard(home, path.join(itemDir, 'session'), outDir);
    row.session = guard.session;
    row.leftovers = guard.leftovers;
    if (guard.problem) row.invalid = `session folder: ${guard.problem}`;
    if (!o.keep) {
      const inner = R.linksUnder(home);
      if (inner.length) console.error(`[claims-90] kept the sandbox: it holds a link (${inner[0]})`);
      else fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

async function main(argv) {
  const o = parseArgs(argv);
  const t0 = new Date().toISOString();
  // The code is recorded when the run starts; a change by the end is recorded beside it (C0 lesson:
  // a commit made during a long run used to be what run.json named).
  const codeAt = () => ({
    head: R.git(o.tree, ['rev-parse', 'HEAD']),
    dirty: R.git(o.tree, ['status', '--porcelain', '--', 'src', 'resources/memory-cli.cjs', 'test/claims-90']) || '',
    runnerSha256: sha256(['answerer.cjs', 'answer-child.cjs', 'run.cjs', 'briefing-hook.cjs'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\0')),
  });
  const code0 = codeAt();
  const snap = path.resolve(o.snapshot);
  if (R.linksUnder(snap).length) throw new Error('the snapshot holds a link or junction');
  const v = R.verifySnapshot(snap);
  if (v.diffs.length) throw new Error(`the snapshot differs from its manifest (${v.diffs.length}): ${v.diffs.slice(0, 3).join('; ')}`);
  const addDir = path.resolve(o.addendum);
  if (R.linksUnder(addDir).length) throw new Error('the addendum holds a link or junction');
  const ad = R.verifyAddendum(addDir, v.manifestSha256);
  if (ad.diffs.length) throw new Error(`the addendum does not match (${ad.diffs.length}): ${ad.diffs.slice(0, 3).join('; ')}`);
  const items = parseItems(o.items);
  const instruction = fs.readFileSync(o.instruction, 'utf8');
  const shape = o.build ? buildHookShape(o.build) : installedHookShape(o.resources);
  // A branch build's hook entry is compared with the installed app's (the same hook, or say so).
  const sameHook = (a, b) => a.entrySource === b.entrySource && a.timeout === b.timeout && JSON.stringify(a.events) === JSON.stringify(b.events) && a.matcher === b.matcher;
  const build = o.build ? { ...buildInfo(o.build), hookEqualsInstalled: sameHook(shape, installedHookShape(o.resources)) } : null;
  const outDir = path.resolve(o.out);
  fs.mkdirSync(outDir, { recursive: true });
  // The key is unwrapped once, from a staged copy, and kept in memory.
  const keyHome = fs.mkdtempSync(path.join(outDir, 'sandbox-key-'));
  let key;
  try {
    for (const d of ['tmp', path.join('AppData', 'Local')]) fs.mkdirSync(path.join(keyHome, d), { recursive: true });
    const { userData } = R.stageSandbox(snap, v.manifest, keyHome);
    key = await R.unwrapKey(o.tree, userData, keyHome);
  } finally { fs.rmSync(keyHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  // Jim 4370f6 MUST 2: every verb an agent is shown answers before any spend.
  const pre = await preflight(o, v, addDir, key, items[0].asker, outDir);
  fs.writeFileSync(path.join(outDir, 'preflight.json'), JSON.stringify(pre, null, 1));
  if (!pre.ok) throw new Error(`preflight failed: ${pre.reason}`);
  if (o.preflightOnly) return { preflightOnly: true, preflight: pre, code: code0, items: 0, invalid: 0, stateSha256: [] };
  const answersFile = path.join(outDir, 'answers.jsonl');
  fs.writeFileSync(answersFile, '');
  const rows = [];
  for (const item of items) {
    const row = await answerItem(o, v, addDir, item, key, shape, instruction, outDir);
    rows.push(row);
    fs.appendFileSync(answersFile, `${JSON.stringify(row)}\n`);
    console.error(`[claims-90] ${item.id}: ${row.invalid ? `INVALID ${row.invalid}` : 'ok'} calls ${row.calls?.length ?? 0}`);
    // god 3164a1: a session folder left in ~/.claude/projects stops the run.
    if (row.session?.problem || row.leftovers?.length) throw new Error(`stopped at ${item.id}: ${row.invalid}`);
  }
  const run = {
    card: 'CLAIMS-90', mode: 'answerer', startedAt: t0, finishedAt: new Date().toISOString(),
    snapshot: path.basename(snap), manifestSha256: v.manifestSha256, addendumSha256: ad.addendumSha256, now: v.manifest.takenFrom,
    model: o.model, claudeExeSha256: sha256(fs.readFileSync(o.claude)), hookShape: shape, instructionSha256: sha256(instruction),
    code: code0,
    // --build: code.head is the build's commit; the runner's own commit is here.
    build, runnerHead: R.git(REPO, ['rev-parse', 'HEAD']),
    // Step 3: the serve child's C90_HIDE_STALE (T2 + T3 switch); null = unset, the default ON.
    appEnv: { C90_HIDE_STALE: o.hideStale ?? null },
    codeAtEnd: (() => { const c = codeAt(); return JSON.stringify(c) === JSON.stringify(code0) ? 'unchanged' : c; })(),
    itemsSha256: sha256(fs.readFileSync(o.items)), items: items.length,
    invalid: rows.filter((r) => r.invalid).length,
    // Jim 4370f6: the preflight's calls, and the items with a verb the build did not answer (each INVALID).
    preflight: pre,
    unavailableItems: rows.filter((r) => r.unavailable && (r.unavailable.serve || r.unavailable.transcript)).length,
    calls: rows.reduce((n, r) => n + (r.calls?.length ?? 0), 0),
    styleDeviations: rows.reduce((n, r) => n + (r.calls ?? []).filter((c) => c.styleDeviation).length, 0),
    readTypeCalls: rows.reduce((n, r) => n + (r.calls ?? []).filter((c) => c.readType).length, 0),
    allBareItems: rows.filter((r) => itemStyle(r.calls).allBare).length,
    memoryMdCalls: rows.reduce((n, r) => n + (r.memoryMd?.calls ?? 0), 0),
    memoryMdByCommand: rows.reduce((o, r) => { for (const [k, n] of Object.entries(r.memoryMd?.byCommand ?? {})) o[k] = (o[k] ?? 0) + n; return o; }, {}),
    memoryMdRewritten: rows.reduce((n, r) => n + (r.memoryMd?.rewritten ?? 0), 0),
    memoryMdItems: rows.filter((r) => r.memoryMd?.calls).length,
    memoryMdQuotedItems: rows.filter((r) => r.memoryMd?.quoted).length,
    stateSha256: [...new Set(rows.map((r) => r.stateSha256))],
    perItem: rows.map((r) => ({ id: r.id, ...itemStyle(r.calls), memoryMdCalls: r.memoryMd?.calls ?? 0, memoryMdQuoted: !!r.memoryMd?.quoted })),
  };
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(run, null, 1));
  return run;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((run) => {
    console.log(JSON.stringify({ items: run.items, invalid: run.invalid, stateSha256: run.stateSha256, head: run.code.head }, null, 1));
    process.exitCode = run.invalid ? 1 : 0;
  }, (e) => { console.error(`[claims-90] ${e.stack || e.message}`); process.exitCode = 2; });
}

module.exports = { projectSlug, claudeProjectsDir, leftoverPrefixes, sessionFolderOut, leftoversIn, LEFTOVER_PREFIX, preflightProblem, unavailableOf, parseArgs, parseItems, installedHookShape, hookShapeOf, buildHookShape, buildInfo, buildMemoryShim, condenseOf, settingsFor, childEnv, readTranscript, styleDeviation, itemStyle, memoryMdUse, main };
