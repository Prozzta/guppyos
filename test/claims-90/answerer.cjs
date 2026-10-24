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
 *
 * items.jsonl: { "id": "...", "asker": "<agent id>", "question": "..." }
 * The instruction file may use {asker}, {today} and {question}.
 * Writes only under --out: items/<id>/ (transcript, hook log, call log, briefing), answers.jsonl
 * and run.json. Item text and answers stay local; mails carry counts and shas only.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { drillEnv } = require('../claims-drill/runner.cjs');
const R = require('./run.cjs');
const Condense = require('../load-ts.cjs')(path.join(__dirname, '..', '..', 'src', 'main', 'toolOutputCondense.ts'));

const REPO = path.resolve(__dirname, '..', '..');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const MAX_CALLS = 5;
const ITEM_TIMEOUT_MS = 10 * 60_000;
const INSTALLED_APP = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Munder Difflin', 'Guppy');

function parseArgs(argv) {
  const o = { keep: false, model: 'claude-opus-5-5' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (/^--(snapshot|addendum|items|instruction|out|model|claude|resources|tree)$/.test(a)) o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  for (const k of ['snapshot', 'addendum', 'items', 'instruction', 'out']) if (!o[k]) throw new Error(`--${k} is required`);
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
  const timeout = /HOOK_HTTP_TIMEOUT_S = (\d+);/.exec(js);
  const entry = /const hook = \(matcher\) => hookUrl \? \{ \.\.\.matcher \? \{ matcher \} : \{\}, hooks: \[\{ type: "http", url: hookUrl, timeout: HOOK_HTTP_TIMEOUT_S \}\] \} : entry\(matcher\)/.exec(js);
  const events = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].filter((e) => js.includes(`${e}: [hook("*")]`));
  if (!timeout || !entry || events.length !== 3) throw new Error('the installed app.asar does not wire the tool hooks as expected');
  return { asarSha256: sha256(fs.readFileSync(asarFile)), mainSha256: sha256(js), entrySource: entry[0], timeout: Number(timeout[1]), events, matcher: '*' };
}

/** The installed `memory` shim, copied into the jail's bin (the same command an agent shell runs). */
function installMemoryShim(binDir) {
  const text = fs.readFileSync(path.join('C:\\', 'Dunder', 'hive', 'bin', 'memory', 'memory'), 'utf8');
  if (!text.includes(path.join(INSTALLED_APP, 'resources', 'memory-cli.cjs').replace(/\\/g, '/'))) throw new Error('the memory shim does not run the installed CLI');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'memory'), text);
  return { sha256: sha256(text) };
}

const fwd = (p) => p.replace(/\\/g, '/');

function settingsFor(shape, hookUrl, briefingFile, toolOutputDir) {
  const http = { matcher: shape.matcher, hooks: [{ type: 'http', url: hookUrl, timeout: shape.timeout }] };
  const hooks = {};
  for (const e of shape.events) hooks[e] = [http];
  hooks.SessionStart = [{ hooks: [{ type: 'command', command: `"${fwd(process.execPath)}" "${fwd(path.join(__dirname, 'briefing-hook.cjs'))}" "${fwd(briefingFile)}"` }] }];
  const live = ['C:/Dunder/hive', fwd(path.join(process.env.APPDATA || '', 'Guppy'))];
  return {
    hooks,
    permissions: {
      allow: ['Bash(memory:*)', `Read(//${fwd(toolOutputDir).replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase())}/**)`],
      deny: [
        ...live.flatMap((p) => { const d = `//${p.replace(/^([A-Za-z]):/, (_, x) => x.toLowerCase())}/**`; return [`Read(${d})`, `Edit(${d})`]; }),
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

const filesIn = (dir) => { try { return dir ? fs.readdirSync(dir, { recursive: true }).length : 0; } catch { return 0; } };

/** What the session did, from its stream-json transcript. Text stays local; the row holds counts. */
function readTranscript(file, allowedRead, liveRes) {
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
  for (const u of uses) {
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
    const server = spawn(R.electronOf(o.tree), [path.join(__dirname, 'answer-child.cjs'), specFile], { cwd: o.tree, env: drillEnv(home), windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
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
    row.memoryShim = installMemoryShim(jailBin);
    const settingsFile = path.join(home, 'claude-settings.json');
    const settings = settingsFor(shape, a.hookUrl, a.briefing, a.toolOutputDir);
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
    const t = readTranscript(transcript, fwd(a.toolOutputDir), LIVE_RES());
    const hookRows = fs.existsSync(serve.hookLogFile) ? fs.readFileSync(serve.hookLogFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const memCalls = fs.existsSync(serve.callsFile) ? fs.readFileSync(serve.callsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const serveRows = fs.existsSync(answers) ? fs.readFileSync(answers, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    row.serve = serveRows.find((r) => r.summary)?.summary ?? { ok: false, reason: serverErr.slice(0, 300) };
    // Gate 1: what the transcript shows the model = the tree's hook = the runner's view.
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
    row.memoryCalls = memCalls.map((m) => ({ cmd: m.cmd, args: m.args, exit: m.exit, chars: m.chars, textSha256: m.textSha256 }));
    row.denied = hookRows.filter((x) => x.denied).length;
    row.init = t.init;
    row.result = t.result;
    row.answerSha256 = t.answer === null ? null : sha256(t.answer);
    fs.writeFileSync(path.join(itemDir, 'answer.txt'), t.answer ?? '');
    row.leaks = t.leaks;
    const initOk = t.init && JSON.stringify([...(t.init.tools || [])].sort()) === JSON.stringify(['Bash', 'Read']) && t.init.mcpServers === 0 && t.init.otherPlugins === 0 && t.init.autoMemoryFiles === 0 && t.init.additionalDirectories === 0;
    if (t.leaks.length) row.invalid = `leak check: ${t.leaks.length} hit(s)`;
    else if (!initOk) row.invalid = 'the session started with more than the shim tools';
    else if (row.exit !== 0 || !t.result || t.result.isError) row.invalid = `session failed (exit ${row.exit}): ${ccErr.slice(0, 200)}`;
    else if (!row.serve.ok) row.invalid = `serve: ${row.serve.reason}`;
    const idx = path.join(userData, 'memory', `${hiveId.to}-v2.sqlite`);
    row.indexAfterSha256 = fs.existsSync(idx) ? sha256(fs.readFileSync(idx)) : null;
    return row;
  } finally {
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
  const shape = installedHookShape(o.resources);
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
  const answersFile = path.join(outDir, 'answers.jsonl');
  fs.writeFileSync(answersFile, '');
  const rows = [];
  for (const item of items) {
    const row = await answerItem(o, v, addDir, item, key, shape, instruction, outDir);
    rows.push(row);
    fs.appendFileSync(answersFile, `${JSON.stringify(row)}\n`);
    console.error(`[claims-90] ${item.id}: ${row.invalid ? `INVALID ${row.invalid}` : 'ok'} calls ${row.calls?.length ?? 0}`);
  }
  const run = {
    card: 'CLAIMS-90', mode: 'answerer', startedAt: t0, finishedAt: new Date().toISOString(),
    snapshot: path.basename(snap), manifestSha256: v.manifestSha256, addendumSha256: ad.addendumSha256, now: v.manifest.takenFrom,
    model: o.model, claudeExeSha256: sha256(fs.readFileSync(o.claude)), hookShape: shape, instructionSha256: sha256(instruction),
    code: { head: R.git(o.tree, ['rev-parse', 'HEAD']), dirty: R.git(o.tree, ['status', '--porcelain', '--', 'src', 'resources/memory-cli.cjs', 'test/claims-90']) || '' },
    itemsSha256: sha256(fs.readFileSync(o.items)), items: items.length,
    invalid: rows.filter((r) => r.invalid).length,
    calls: rows.reduce((n, r) => n + (r.calls?.length ?? 0), 0),
    styleDeviations: rows.reduce((n, r) => n + (r.calls ?? []).filter((c) => c.styleDeviation).length, 0),
    readTypeCalls: rows.reduce((n, r) => n + (r.calls ?? []).filter((c) => c.readType).length, 0),
    allBareItems: rows.filter((r) => itemStyle(r.calls).allBare).length,
    stateSha256: [...new Set(rows.map((r) => r.stateSha256))],
    perItem: rows.map((r) => ({ id: r.id, ...itemStyle(r.calls) })),
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

module.exports = { parseArgs, parseItems, installedHookShape, settingsFor, childEnv, readTranscript, styleDeviation, itemStyle, main };
