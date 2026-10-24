'use strict';
/**
 * CLAIMS-90 Phase 3: the answer child. Electron as Node, inside the jailed home that run.cjs made,
 * over a disposable COPY of the frozen snapshot. It wires the product's own modules from the tree
 * at sha C exactly as src/main/index.ts wires them, and answers each item through them:
 *   briefing   createClaimDelivery(...).workingSet(asker, source, WORKING_SET_MAX_CHARS)
 *              (index.ts claimWorkingSetForAgent with part 'briefing')
 *   wake-up    the REAL resources/memory-cli.cjs -> loopback POST /memory/<token> ->
 *              NativeMemoryWiring.handle (validateRequest -> worker wakeUp, + claimWakeup append)
 *   search     the same CLI with the item's argv passed through unchanged -> worker search
 * The index worker is the tree's own runWorker (src/main/nativeMemory/worker.ts), run in this
 * process behind a port that structured-clones every message, as utilityProcess would. When the
 * worker is ready, ClaimsIndexSync.syncAll re-sends every flagged agent's verified claims (main's
 * onWorkerReady), so the index is what sha C builds from the snapshot ledger.
 *
 * The MAC key arrives on stdin (base64, one line) and is never written anywhere.
 * argv[2]: the spec file run.cjs wrote: { tree, hive, userData, resourcesDir, home, now, items, out }.
 * Each output row: { id, asker, briefing: { <source>: {text, chars} }, wakeUp: Run, searches: Run[] },
 * Run = { argv, command, exit, stdout, stderr, condensed }. Plus one final { summary } row.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = fs.openSync(spec.out, 'w');
const emit = (row) => fs.writeSync(out, `${JSON.stringify(row)}\n`);
const LIVE_HIVE_RE = /[\\/]Dunder[\\/]hive([\\/]|$)/i;
const LEAK_RE = /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CLAUDE_CODE_|CLAUDE|CTH_|KG_)/i;

function under(p, root) {
  const r = path.relative(path.resolve(root).toLowerCase(), path.resolve(p).toLowerCase());
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

/** The containment check, before any product code loads (spec 1b isolation). */
function jailProblem() {
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') return 'not Electron as Node';
  for (const k of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) {
    if (!process.env[k] || !under(process.env[k], spec.home)) return `${k} is outside the jailed home`;
  }
  const leaked = Object.keys(process.env).filter((k) => LEAK_RE.test(k));
  if (leaked.length) return `leaked env: ${leaked.join(', ')}`;
  for (const p of [spec.hive, spec.userData]) {
    if (LIVE_HIVE_RE.test(p) || !under(p, spec.home)) return `not a sandbox path: ${p}`;
  }
  return null;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
    process.stdin.on('error', reject);
  });
}

/** The tree's worker, in process, behind a structured-clone port (utilityProcess semantics). */
function inProcessFork(runWorker, deps) {
  const toMain = new Set();
  const exits = new Set();
  const port = {
    postMessage: (msg) => { const m = structuredClone(msg); setImmediate(() => { for (const fn of toMain) fn(m); }); },
    on: (_ev, fn) => { port.fns.add(fn); },
    fns: new Set(),
  };
  let started = false;
  return {
    postMessage(msg) {
      const m = structuredClone(msg);
      if (!started) {
        if (m?.op !== 'init' || !m.config) return;
        started = true;
        runWorker(m.config, port, deps).catch((err) => port.postMessage({ event: 'fatal', error: String(err?.stack ?? err) }));
        return;
      }
      setImmediate(() => { for (const fn of port.fns) fn({ data: m }); });
    },
    on(ev, fn) { (ev === 'exit' ? exits : toMain).add(fn); },
    kill() { for (const fn of exits) fn(0); return true; },
  };
}

(async () => {
  const jail = jailProblem();
  if (jail) { emit({ summary: { ok: false, reason: jail } }); process.exit(2); }
  const keyB64 = await readStdin();
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) { emit({ summary: { ok: false, reason: 'no MAC key on stdin' } }); process.exit(2); }

  process.chdir(spec.tree);
  const loadTsMod = require(path.join(spec.tree, 'test', 'load-ts.cjs'));
  const L = (rel) => loadTsMod(path.resolve(spec.tree, rel));
  const treeRequire = createRequire(path.join(spec.tree, 'package.json'));
  const { ClaimStore } = L('src/main/claims/store.ts');
  const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = L('src/main/claims/keyProvider.ts');
  const { ClaimsIndexSync, verifiedPrefix } = L('src/main/claims/indexSync.ts');
  const { derive } = L('src/main/claims/derive.ts');
  const { worldView } = L('src/main/claims/world.ts');
  const { createClaimDelivery, WORKING_SET_MAX_CHARS } = L('src/main/claims/delivery.ts');
  const { reconcileQueueForHive } = L('src/main/claims/reconcile.ts');
  const { reconcileApiForHive, refreshReconcileQueueForHive } = L('src/main/claims/reconcileHive.ts');
  const { DEFAULT_KEY_REGISTRY, loadRegistry } = L('src/main/claims/registry.ts');
  const { importSettled } = L('src/main/claims/ingest.ts');
  const { NativeMemoryWiring } = L('src/main/nativeMemory/mainWiring.ts');
  const { runWorker } = L('src/main/nativeMemory/worker.ts');
  const { readSourcesConfig } = L('src/main/nativeMemory/sources.ts');
  const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = L('src/main/nativeMemory/wordpiece.ts');
  const { effectiveLevel } = L('src/shared/claims.ts');
  const C = L('src/main/toolOutputCondense.ts');
  const { normalizeAgentProvider } = L('src/shared/agentProvider.ts');

  const hive = spec.hive;
  const ud = spec.userData;
  const config = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
  const logRows = [];
  const log = (row) => { if (logRows.length < 500) logRows.push(row); };
  const tasks = () => { try { return JSON.parse(fs.readFileSync(path.join(hive, 'tasks.json'), 'utf8')).tasks ?? []; } catch { return []; } };
  const registry = () => { try { return loadRegistry(hive); } catch { return DEFAULT_KEY_REGISTRY; } };
  // index.ts claimLevel: the setting narrowed by memory-sources.json `ledger`.
  const claimLevel = (agentId) => effectiveLevel(config.claimLedger, readSourcesConfig(hive).ledger?.[agentId]).level;
  const reg = JSON.parse(fs.readFileSync(path.join(hive, 'registry.json'), 'utf8'));
  const world = JSON.parse(fs.readFileSync(spec.world, 'utf8'));
  const worldCalls = { git: 0, fileExists: 0, unrecorded: [] };
  const frozenGit = async (cwd, args) => {
    worldCalls.git++;
    if (world.cwds?.[cwd]?.git !== 'not-a-repository') worldCalls.unrecorded.push(`git ${args[0]} in ${cwd}`);
    return null; // runGit's answer outside a repository (a non-zero exit)
  };
  const frozenFileExists = (abs) => {
    worldCalls.fileExists++;
    if (!Object.prototype.hasOwnProperty.call(world.files ?? {}, abs)) { worldCalls.unrecorded.push(`fileExists ${abs}`); return false; }
    return world.files[abs];
  };

  const store = new ClaimStore({
    hiveRoot: hive,
    keys: new SandboxKeyProvider(key),
    keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)),
    headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)),
    log,
    taskStatus: (id) => tasks().find((t) => t.id === id)?.status ?? null,
  });
  const endpoint = { root: hive, store, level: claimLevel };
  const ledgerAgents = () => {
    let withSegments = [];
    try { withSegments = fs.readdirSync(path.join(hive, 'agents')).filter((a) => store.segments(a).length > 0); } catch { /* none */ }
    return [...new Set([...withSegments, ...store.anchoredAgents()])];
  };

  // Integrity before any answer (spec M4): every ledger verifies to its full length, or the run stops.
  const ledgers = {};
  for (const a of ledgerAgents()) {
    const r = store.readLedger(a);
    const vp = verifiedPrefix(r);
    ledgers[a] = { records: r.records.length, verified: vp ? vp.records.length : null, chain: r.chain === 'ok' ? 'ok' : r.chain, torn: !!r.torn, level: claimLevel(a), importSettled: importSettled(hive, a) };
  }
  const broken = Object.entries(ledgers).filter(([, v]) => v.verified !== v.records);
  if (broken.length) { emit({ summary: { ok: false, reason: 'a ledger does not verify to its full length', ledgers } }); process.exit(3); }

  let tokenCount = null;
  const reconcileHiveDeps = () => ({
    endpoint: () => endpoint,
    queue: reconcileQueueForHive,
    countTokens: (text) => tokenCount?.(text) ?? 0,
    log,
    registry: () => registry(),
    isOwner: (agentId) => claimLevel(agentId) === 'writer',
  });
  const nativeMemory = new NativeMemoryWiring({
    hiveRoot: () => hive,
    enabled: () => config.semanticMemory !== false,
    userData: ud,
    resourcesDir: spec.resourcesDir,
    workerEntry: 'in-process',
    fork: () => inProcessFork(runWorker, { Database: treeRequire('better-sqlite3'), ort: treeRequire('onnxruntime-node') }),
    memoryBaseUrl: () => baseUrl,
    writeCommand: () => null,
    log,
    vecLoadablePath: () => treeRequire('sqlite-vec').getLoadablePath(),
    // Claim verbs are writes: the answerer may not write, so they answer as a build without a ledger.
    claims: () => null,
    claimLedger: () => config.claimLedger,
    anchoredAgents: () => store.anchoredAgents(),
    onWorkerReady: () => { workerReady = claimsIndex.syncAll(); },
  });
  let workerReady = null;
  const claimsIndex = new ClaimsIndexSync({
    readLedger: (a) => store.readLedger(a),
    derive: () => derive,
    registry: () => registry(),
    ruleConfig: () => ({ r4: false }),
    level: claimLevel,
    agents: ledgerAgents,
    send: (args) => nativeMemory.syncClaims(args),
    onIndexed: (agentId) => { try { refreshReconcileQueueForHive(hive, agentId, reconcileHiveDeps()); } catch (e) { log({ kind: 'claims-reconcile-refresh-failed', agentId, error: String(e).slice(0, 160) }); } },
    log,
  });
  const claimDelivery = createClaimDelivery({
    hiveRoot: () => hive,
    level: claimLevel,
    readLedger: (agentId) => store.readLedger(agentId),
    registry: () => registry(),
    derive,
    worldView,
    agentCwd: (agentId) => reg.agents?.[agentId]?.cwd ?? null,
    // M3: the world view answers from the addendum's world.json, recorded once, never the live disk.
    git: frozenGit,
    fileExists: frozenFileExists,
    tasks,
    usage: (agentId) => { try { return fs.readFileSync(store.usageFile(agentId), 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } },
    countTokens: () => {
      if (tokenCount) return tokenCount;
      const cfg = nativeMemory.workerConfig();
      if (!cfg) return null;
      const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(cfg.modelDir, 'tokenizer.json'), 'utf8'))));
      tokenCount = (text) => tok.count(text);
      return tokenCount;
    },
    reconcileCandidates: (agentId, day, source) => reconcileApiForHive(hive, reconcileHiveDeps())?.peekForTurn(agentId, day, source) ?? [],
    commitReconcile: (agentId, day, ids, source) => { reconcileApiForHive(hive, reconcileHiveDeps())?.commitRendered(agentId, day, ids, source); },
    onTurnCompleted: () => { /* no turns in a frozen run */ },
    now: spec.now ? () => new Date(spec.now) : undefined,
    log,
  });
  nativeMemory.setClaimWakeupProvider((agentId) => claimDelivery.workingSet(agentId));

  // The loopback route, as hooks.ts onMemory serves it: POST <base>/<token>, JSON in, {status, body} out.
  const server = http.createServer((req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body ?? {})); };
    const h = /^\/hook\/([^/?]+)$/.exec(req.url || '');
    if (h && req.method === 'POST' && hookHandler) {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        let p = null;
        try { p = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { p = null; }
        let r = {};
        try { r = hookHandler(h[1], p) ?? {}; } catch (e) { r = {}; fs.appendFileSync(spec.serve.hookLogFile, `${JSON.stringify({ error: String(e).slice(0, 300) })}\n`); }
        reply(200, r);
      });
      return;
    }
    const m = /^\/memory\/([^/?]+)$/.exec(req.url || '');
    if (!m || req.method !== 'POST') { req.resume(); reply(404, {}); return; }
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = null; }
      const logCall = (status, b) => {
        if (!spec.serve) return;
        const text = typeof b?.text === 'string' ? b.text : '';
        const row = { at: new Date().toISOString(), asker: askerOf.get(m[1]) ?? null, cmd: body?.cmd ?? null, args: body?.args ?? null, status, exit: b?.exit ?? null, chars: text.length, textSha256: crypto.createHash('sha256').update(text).digest('hex') };
        fs.appendFileSync(spec.serve.callsFile, `${JSON.stringify(row)}\n`);
      };
      nativeMemory.handle(m[1], body).then((r) => { logCall(r.status, r.body); reply(r.status, r.body); }, () => { logCall(500, null); reply(500, { exit: 4, error: 'memory handler failed' }); });
    });
  });
  const askerOf = new Map();
  let hookHandler = null;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/memory`;

  // Warm up as an agent's first call does (the lazy fork), then wait for main's re-sync to land.
  const status0 = await nativeMemory.query('status');
  for (let i = 0; i < 600 && !workerReady; i++) await new Promise((r) => setTimeout(r, 100));
  const synced = workerReady ? await workerReady : null;
  const status1 = await nativeMemory.query('status');

  const cli = path.join(spec.tree, 'resources', 'memory-cli.cjs');
  const CLAUDE_CODE_PERSIST_CHARS = 30_000;
  const persistRisk = [];
  // An unrecorded world question (M3) or an output Claude Code would have saved itself (S2) fails the run.
  const verdict = () => {
    if (worldCalls.unrecorded.length) return { ok: false, reason: `the world view asked ${worldCalls.unrecorded.length} unrecorded question(s): ${worldCalls.unrecorded[0]}` };
    if (persistRisk.length) return { ok: false, reason: `${persistRisk.length} output(s) reached Claude Code's persist size (${CLAUDE_CODE_PERSIST_CHARS} chars): ${persistRisk[0]}` };
    return { ok: true };
  };
  // Jim NIT: mailChannel falls back to codex for an agent with no provider; every asker must name one.
  const askerIds = spec.serve ? spec.serve.askers : spec.items.map((it) => it.asker);
  const noProvider = [...new Set(askerIds)].filter((a) => !normalizeAgentProvider(reg.agents?.[a]?.provider));
  if (noProvider.length) { emit({ summary: { ok: false, reason: `asker(s) with no provider in the snapshot registry: ${noProvider.join(', ')}` } }); process.exit(3); }
  /**
   * What the asker READS from one call, as hooks.ts condensedToolOutput gives it (ruling G1):
   * - Claude Code's Bash tool hands the hook stdout and stderr trimmed (identity check: the live
   *   tool text is the CLI's output without its leading and trailing newlines);
   * - only a claude-provider agent is condensed; god gets at least the read cap unless the registry
   *   sets its own cap (M2);
   * - a trailing `#full` is a shell comment: the CLI never sees it, the condenser skips (M1);
   * - the full text is saved under the asker's jailed tool-output folder, and that real path is the
   *   footer (m2). footerSensitive: the kept body would differ with a live-hive path of the
   *   production length.
   */
  const viewOf = (asker, command, code, stdout, stderr, callId, toolUseId) => {
    const meta = reg.agents?.[asker] ?? {};
    const provider = normalizeAgentProvider(meta.provider);
    const r = { stdout: stdout.trim(), stderr: stderr.trim(), interrupted: false };
    const seenRaw = C.outputText(r);
    // Jim S2: past this size Claude Code saves the output itself and the hook condenses a head and
    // tail of that file, which the runner does not model: such a row fails the run.
    if (seenRaw.length >= CLAUDE_CODE_PERSIST_CHARS) persistRisk.push(command);
    if (provider && provider !== 'claude') return { provider, cap: 0, seen: seenRaw, condensed: null };
    const own = meta.toolOutputCap;
    const isGod = typeof own !== 'number' && (reg.godId === asker || !!meta.isGod);
    const configured = C.effectiveCap(typeof own === 'number' ? own : config.toolOutputCap);
    const cap = C.capForCommand(command, isGod && configured ? Math.max(configured, C.TOOL_OUTPUT_CAP_READ) : configured);
    // Jim S1, measured on Claude Code 2.1.310: a non-zero exit fires PostToolUseFailure with no
    // tool_response, which condensedToolOutput never touches; the model reads "Exit code N" + output.
    if (code !== 0) return { provider: provider ?? null, cap, seen: `Exit code ${code}\n${seenRaw}`, condensed: null };
    if (!C.shouldCondense('Bash', { command }, r, cap)) return { provider: provider ?? null, cap, seen: seenRaw, condensed: null };
    const id = toolUseId || `toolu_${crypto.createHash('sha256').update(callId).digest('base64url').replace(/[-_]/g, '').slice(0, 24)}`;
    const dir = path.join(hive, 'agents', asker, 'tool-output');
    fs.mkdirSync(dir, { recursive: true });
    const saved = path.join(dir, `${id}.txt`);
    fs.writeFileSync(saved, seenRaw, 'utf8');
    const condensed = C.condenseOutput({ text: seenRaw, cap, path: saved });
    const liveLength = C.condenseOutput({ text: seenRaw, cap, path: path.join('C:\\Dunder\\hive', 'agents', asker, 'tool-output', `${id}.txt`) });
    const body = (t) => t.slice(0, t.lastIndexOf('\n[full output: '));
    return { provider: provider ?? null, cap, seen: condensed, condensed, savedAs: path.relative(hive, saved), footerSensitive: body(condensed) !== body(liveLength) };
  };
  /** One `memory ...` call, exactly as an agent shell runs it: argv passed through unchanged (a
   *  trailing `#full` is the shell comment, so it is not passed). */
  const runCli = (asker, argv, callId) => new Promise((resolve) => {
    const full = argv[argv.length - 1] === '#full';
    const cliArgv = full ? argv.slice(0, -1) : argv;
    const env = { ELECTRON_RUN_AS_NODE: '1', MUNDER_HIVE_ROOT: hive, MUNDER_MEMORY_URL: baseUrl, MEMORY_TOKEN: nativeMemory.tokens.mint(asker) };
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[k] !== undefined) env[k] = process.env[k];
    const p = spawn(process.execPath, [cli, ...cliArgv], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    p.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      const command = ['memory', ...cliArgv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(' ') + (full ? ' #full' : '');
      resolve({ argv, command, exit: code, stdout, stderr, ...viewOf(asker, command, code, stdout, stderr, callId) });
    });
  });

  if (spec.serve) {
    // M4 serve mode: the same wiring, kept up for a contained answerer session that makes its own
    // `memory` calls (MUNDER_MEMORY_URL + its token). Its first context is the briefing written
    // here (the compact render, as receipts show agents live in). Every call is logged; it stops
    // when the stop file appears.
    // The tool-output hook: the tree's own HookServer.condensedToolOutput decides and condenses
    // (provider, registry cap, god's read cap, #full, the saved file). Only the HTTP accept and the
    // token-to-agent lookup are stand-ins; the reply has the shape hooks.ts sends for PostToolUse.
    // For each PostToolUse the runner's own view (viewOf) of the same output is logged beside it:
    // gate 1 compares the two.
    const { HookServer } = L('src/main/hooks.ts');
    const hiveStub = {
      registry: () => reg,
      isGod: (id) => reg.godId === id || !!reg.agents?.[id]?.isGod,
      toolOutputDir: (id) => (id ? path.join(hive, 'agents', id, 'tool-output') : null),
      appendLog: (row) => log(row),
    };
    const hooks = new HookServer(hiveStub, () => null, () => config);
    const hookTokens = new Map();
    const preCalls = new Map();
    hookHandler = (token, p) => {
      const asker = hookTokens.get(token);
      if (!asker || !p || typeof p !== 'object') return {};
      const event = p.hook_event_name;
      const command = typeof p.tool_input?.command === 'string' ? p.tool_input.command : null;
      const row = { at: new Date().toISOString(), asker, event, tool: p.tool_name ?? null, toolUseId: p.tool_use_id ?? null, command };
      let updatedToolOutput = null;
      if (event === 'PreToolUse') {
        // Spec 1b: at most 5 tool calls per item; a later call is refused, and logged.
        const n = (preCalls.get(asker) ?? 0) + 1;
        preCalls.set(asker, n);
        row.call = n;
        if (n > spec.serve.maxCalls) {
          row.denied = 'call limit';
          fs.appendFileSync(spec.serve.hookLogFile, `${JSON.stringify(row)}\n`);
          return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `The limit is ${spec.serve.maxCalls} tool calls.` } };
        }
      } else if (event === 'PostToolUse') {
        try { updatedToolOutput = hooks.condensedToolOutput(asker, { ...p, transport: 'http' }); } catch { updatedToolOutput = null; }
        const r = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : {};
        row.response = { stdoutChars: typeof r.stdout === 'string' ? r.stdout.length : null, stderrChars: typeof r.stderr === 'string' ? r.stderr.length : null, persisted: !!r.persistedOutputPath, interrupted: r.interrupted === true };
        row.hook = updatedToolOutput ? updatedToolOutput.stdout : null;
        if (p.tool_name === 'Bash' && command && typeof r.stdout === 'string') {
          const v = viewOf(asker, command, 0, r.stdout, typeof r.stderr === 'string' ? r.stderr : '', null, p.tool_use_id);
          row.runner = v.condensed;
          row.parity = row.hook === row.runner;
        }
      } else if (event === 'PostToolUseFailure') {
        row.failure = { errorChars: typeof p.error === 'string' ? p.error.length : null, errorSha256: typeof p.error === 'string' ? crypto.createHash('sha256').update(p.error).digest('hex') : null, response: 'tool_response' in p };
      }
      fs.appendFileSync(spec.serve.hookLogFile, `${JSON.stringify(row)}\n`);
      return updatedToolOutput ? { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } } : {};
    };
    const askers = {};
    for (const asker of spec.serve.askers) {
      const hookToken = crypto.randomBytes(16).toString('hex');
      hookTokens.set(hookToken, asker);
      const token = nativeMemory.tokens.mint(asker);
      askerOf.set(token, asker);
      const text = await claimDelivery.workingSet(asker, 'compact', WORKING_SET_MAX_CHARS);
      const file = path.join(path.dirname(spec.serve.connectFile), `briefing-${asker}.txt`);
      fs.writeFileSync(file, text ?? '', 'utf8');
      askers[asker] = { token, hookUrl: `${baseUrl.replace(/\/memory$/, '/hook')}/${hookToken}`, briefing: file, briefingChars: text ? text.length : 0, briefingSha256: crypto.createHash('sha256').update(text ?? '').digest('hex'), toolOutputDir: path.join(hive, 'agents', asker, 'tool-output') };
    }
    const connect = { url: baseUrl, hive, cli, askers, env: { MUNDER_HIVE_ROOT: hive, MUNDER_MEMORY_URL: baseUrl, MEMORY_TOKEN: '<askers[id].token>' }, calls: spec.serve.callsFile, stop: spec.serve.stopFile, ledgers, synced, worldCalls };
    fs.writeFileSync(spec.serve.connectFile, JSON.stringify(connect, null, 1));
    while (!fs.existsSync(spec.serve.stopFile)) await new Promise((r) => setTimeout(r, 500));
    emit({ summary: { ...verdict(), persistRisk: persistRisk.length,served: Object.keys(askers), ledgers, synced, worldCalls } });
    server.close();
    await nativeMemory.shutdown().catch(() => {});
    fs.closeSync(out);
    process.exit(0);
  }

  const sources = spec.briefingSources || ['compact', 'startup'];
  let n = 0;
  for (const item of spec.items) {
    const briefing = {};
    // Each render leases the reconcile prompts it shows (W5), so a briefing before the wake-up
    // changes what the wake-up shows. briefing: false answers the wake-up as a mid-session call.
    for (const s of item.briefing === false ? [] : sources) {
      const text = await claimDelivery.workingSet(item.asker, s, WORKING_SET_MAX_CHARS);
      briefing[s] = { text, chars: text ? text.length : 0 };
    }
    const wakeUp = item.wakeUp === false ? null : await runCli(item.asker, ['wake-up'], `${item.id}#w`);
    const searches = [];
    for (const [i, argv] of (item.searches || []).entries()) searches.push(await runCli(item.asker, argv, `${item.id}#s${i + 1}`));
    emit({ id: item.id, asker: item.asker, briefing, wakeUp, searches });
    n++;
  }
  emit({ summary: { ...verdict(), persistRisk: persistRisk.length,items: n, ledgers, synced, worldCalls, status0: status0.json ?? null, status1: status1.json ?? null, cap: C.effectiveCap(config.toolOutputCap), logKinds: [...new Set(logRows.map((r) => r.kind))] } });
  server.close();
  await nativeMemory.shutdown().catch(() => {});
  fs.closeSync(out);
  process.exit(0);
})().catch((e) => { try { emit({ summary: { ok: false, reason: String(e?.stack ?? e).slice(0, 2000) } }); } catch { /* closed */ } process.exit(1); });
