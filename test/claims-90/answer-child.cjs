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

  const hive = spec.hive;
  const ud = spec.userData;
  const config = JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8'));
  const logRows = [];
  const log = (row) => { if (logRows.length < 500) logRows.push(row); };
  const tasks = () => { try { return JSON.parse(fs.readFileSync(path.join(hive, 'tasks.json'), 'utf8')).tasks ?? []; } catch { return []; } };
  const registry = () => { try { return loadRegistry(hive); } catch { return DEFAULT_KEY_REGISTRY; } };
  // index.ts claimLevel: the setting narrowed by memory-sources.json `ledger`.
  const claimLevel = (agentId) => effectiveLevel(config.claimLedger, readSourcesConfig(hive).ledger?.[agentId]).level;

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
    agentCwd: (agentId) => { try { return JSON.parse(fs.readFileSync(path.join(hive, 'registry.json'), 'utf8')).agents?.[agentId]?.cwd ?? null; } catch { return null; } },
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
    const m = /^\/memory\/([^/?]+)$/.exec(req.url || '');
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body ?? {})); };
    if (!m || req.method !== 'POST') { req.resume(); reply(404, {}); return; }
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = null; }
      nativeMemory.handle(m[1], body).then((r) => reply(r.status, r.body), () => reply(500, { exit: 4, error: 'memory handler failed' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/memory`;

  // Warm up as an agent's first call does (the lazy fork), then wait for main's re-sync to land.
  const status0 = await nativeMemory.query('status');
  for (let i = 0; i < 600 && !workerReady; i++) await new Promise((r) => setTimeout(r, 100));
  const synced = workerReady ? await workerReady : null;
  const status1 = await nativeMemory.query('status');

  const cap = C.effectiveCap(config.toolOutputCap);
  const cli = path.join(spec.tree, 'resources', 'memory-cli.cjs');
  /** One `memory ...` call, exactly as an agent shell runs it: argv passed through unchanged. */
  const runCli = (asker, argv) => new Promise((resolve) => {
    const env = { ELECTRON_RUN_AS_NODE: '1', MUNDER_HIVE_ROOT: hive, MUNDER_MEMORY_URL: baseUrl, MEMORY_TOKEN: nativeMemory.tokens.mint(asker) };
    for (const k of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) if (process.env[k] !== undefined) env[k] = process.env[k];
    const p = spawn(process.execPath, [cli, ...argv], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    p.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      const command = ['memory', ...argv.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(' ');
      const c = C.capForCommand(command, cap);
      const r = { stdout, stderr, interrupted: false };
      const condensed = code === 0 && C.shouldCondense('Bash', { command }, r, c)
        ? C.condenseOutput({ text: C.outputText(r), cap: c, path: '<tool-output>' })
        : null;
      resolve({ argv, command, exit: code, stdout, stderr, condensed });
    });
  });

  const sources = spec.briefingSources || ['compact', 'startup'];
  let n = 0;
  for (const item of spec.items) {
    const briefing = {};
    for (const s of sources) {
      const text = await claimDelivery.workingSet(item.asker, s, WORKING_SET_MAX_CHARS);
      briefing[s] = { text, chars: text ? text.length : 0 };
    }
    const wakeUp = item.wakeUp === false ? null : await runCli(item.asker, ['wake-up']);
    const searches = [];
    for (const argv of item.searches || []) searches.push(await runCli(item.asker, argv));
    emit({ id: item.id, asker: item.asker, briefing, wakeUp, searches });
    n++;
  }
  emit({ summary: { ok: true, items: n, ledgers, synced, status0: status0.json ?? null, status1: status1.json ?? null, cap, logKinds: [...new Set(logRows.map((r) => r.kind))] } });
  server.close();
  await nativeMemory.shutdown().catch(() => {});
  fs.closeSync(out);
  process.exit(0);
})().catch((e) => { try { emit({ summary: { ok: false, reason: String(e?.stack ?? e).slice(0, 2000) } }); } catch { /* closed */ } process.exit(1); });
