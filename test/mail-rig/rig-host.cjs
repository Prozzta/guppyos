'use strict';
/**
 * ZT-I1-MAIL slice 8 (INBOX-DESIGN §8.2): the SANDBOX INSTANCE of the app's main process, for the
 * fake-agent rig. One Node process per run, driven by `driver.cjs` over a loopback control port.
 *
 * WHAT IS REAL. The main-process modules the mail design lives in, wired to each other exactly as
 * src/main/index.ts wires them (every wiring line below names its index.ts counterpart):
 *   HiveManager (router, ledger, migration, readers), HookServer (the real named pipe, the real HTTP
 *   hook broker and the real Codex MCP endpoint), the wake coordinator (WorkerWakeWatchdog) and its
 *   InboxWakeBridge, the ONE submit owner (AutomaticSubmitOwner + buildOwnerDeps), ControlRegistry
 *   (pause), the Codex rollout lifecycle probe, PtyManager (node-pty/ConPTY, the npm-shim spawn
 *   route) and HiveManager.ensureAgent's per-provider injection (settings.json, config.toml, the AGY
 *   global hooks.json, the gemini system settings, the qwen proxy sidecar).
 *
 * WHAT IS A STAND-IN (layer (a) cannot have these, and each is named where it is built):
 *   - the RENDERER: no window exists. Its three mirrors into main (input-origin state, the prompt
 *     block, the screen oracle) are answered from the fake CLI's own composer file; its terminal
 *     work-order queue (useHive) is a few lines that type the work order through the same owner and
 *     report a COMMITTED write via hive.recordWorkOrderDelivered, as useHive does;
 *   - CAPACITY: a switch the driver flips (`capacityHold`) behind the owner's OwnerCapacity seam;
 *   - the CLOCK of the wake coordinator and bridge: `Date.now() + offset` (the injection point the
 *     bridge and coordinator already take), so the driver can pass 30 minutes or 1 hour at once.
 *     The ledger, the hook server and the owner keep real time.
 *   - the BEATS are not armed on a timer: the driver runs `beat` (the runWorkerWakeBeat body).
 *
 * ISOLATION (asserted before any product module loads): HOME / USERPROFILE / CODEX_HOME /
 * GEMINI_CLI_HOME point into the sandbox, no HIVE_*, AGENT_*, MEMORY_*, MUNDER_*, CTH_*, KG_*,
 * CLAUDE* variable is present, no hive directory is on PATH, the harness home and hive live in the
 * sandbox (the pipe name hashes that root, so it is not the live floor's), OPENAI/ANTHROPIC base URLs
 * point at the rig's own fake LLM. No window of any kind is created: this process loads no Electron.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const argOf = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const SANDBOX = argOf('sandbox');
if (!SANDBOX || !path.isAbsolute(SANDBOX)) { process.stderr.write('rig-host: --sandbox <abs dir> is required\n'); process.exit(2); }

// ————————————————————————————————————————————————————————————— isolation, before anything loads

const BAD_ENV = /^(HIVE_|AGENT_|MEMORY_|MUNDER_|CTH_|KG_|MD_SLACK_|CLAUDE)/i;
const HOME = path.join(SANDBOX, 'home');
function assertIsolated() {
  const inside = (p) => { const r = path.relative(SANDBOX, p); return r !== '' && !r.startsWith('..') && !path.isAbsolute(r); };
  const bad = Object.keys(process.env).filter((k) => BAD_ENV.test(k));
  if (bad.length) throw new Error(`rig-host: env not scrubbed: ${bad.join(', ')}`);
  for (const k of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GEMINI_CLI_HOME']) {
    if (!process.env[k] || !inside(process.env[k]) && process.env[k] !== HOME) throw new Error(`rig-host: ${k} is not jailed (${process.env[k]})`);
  }
  if (path.resolve(os.homedir()) !== path.resolve(HOME)) throw new Error(`rig-host: os.homedir() is ${os.homedir()}, not the jail`);
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path');
  for (const p of String(process.env[pathKey] || '').split(path.delimiter)) {
    if (/dunder[\\/]hive|[\\/]hive[\\/]bin/i.test(p)) throw new Error(`rig-host: a hive dir is on PATH: ${p}`);
  }
}
assertIsolated();
// Allowlist isolation (Dwight audit 3, god e7e031): no credential-family variable, no PATH dir
// outside the sandbox and the Windows system dirs, no provider command resolvable outside rig/bin.
// Fail fast, before any product module loads.
require('./isolation.cjs').checkIsolation(process.env, SANDBOX, { who: 'rig-host' });
fs.mkdirSync(HOME, { recursive: true });
const HARNESS_HOME = path.join(SANDBOX, 'harness');
const RIG_DIR = path.join(SANDBOX, 'rig');
const WORK = path.join(SANDBOX, 'work');
for (const d of [HARNESS_HOME, RIG_DIR, WORK, path.join(RIG_DIR, 'bin'), path.join(RIG_DIR, 'stubs')]) fs.mkdirSync(d, { recursive: true });
// What every stub inherits (through the PTY env): where to record, and its lifeline.
process.env.RIG_DIR = RIG_DIR;
process.env.RIG_HOST_PID = String(process.pid);

// The renderer-facing electron import of hooks.ts (Notification) - there is no Electron here.
const electronPath = require.resolve('electron');
require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const REPO = path.resolve(__dirname, '..', '..');
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
const { screenDraftOf } = require('./screen-draft.cjs');

// ————————————————————————————————————————————————————————————— the fake LLM (qwen proxy upstream)

function startFakeLlm() {
  return new Promise((resolve) => {
    const calls = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        calls.push({ t: Date.now(), url: req.url, bytes: body.length });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'fake', object: 'chat.completion', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/v1`, calls }));
  });
}

// ————————————————————————————————————————————————————————————— the floor

const PROVIDER_OF = { claude: 'claude', codex: 'codex', agy: 'antigravity', gemini: 'gemini', custom: 'custom', cursor: 'cursor', qwen: 'qwen' };

async function buildFloor() {
  const llm = await startFakeLlm();
  // The qwen sidecar's UPSTREAM is read from the app's env (hive.ts startProxyBridge): never a cloud.
  for (const k of ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GEMINI_BASE_URL']) process.env[k] = llm.url;

  const { HiveManager } = loadTs('src/main/hive.ts');
  const { HookServer } = loadTs('src/main/hooks.ts');
  const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
  const { WorkerWakeWatchdog } = loadTs('src/main/workerWake.ts');
  const { ControlRegistry } = loadTs('src/main/control.ts');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const { AutomaticSubmitOwner } = loadTs('src/main/automaticSubmit.ts');
  const { buildOwnerDeps } = loadTs('src/main/automaticSubmitWiring.ts');
  const { CodexRolloutLifecycleSource } = loadTs('src/main/codexRolloutLifecycle.ts');
  const { coordinatorPendingIds } = loadTs('src/main/mailReaders.ts');
  const readers = loadTs('src/main/mailReaders.ts');
  const { mailNudgeMode } = loadTs('src/main/mailSurface.ts');
  const { inboxWakeTextForProvider } = loadTs('src/shared/hiveNudge.ts');

  // The simulated clock of the coordinator/bridge. `at(t)` maps a REAL timestamp another part
  // stamped (a statusline read, a rollout line, PTY output) onto the simulated timeline, using the
  // offset that was in force at that real moment.
  const clock = {
    offset: 0,
    changes: [{ realAt: 0, offset: 0 }],
    now: () => Date.now() + clock.offset,
    advance: (ms) => { clock.offset += ms; clock.changes.push({ realAt: Date.now(), offset: clock.offset }); return clock.offset; },
    at: (t) => { let o = 0; for (const c of clock.changes) { if (c.realAt <= t) o = c.offset; else break; } return t + o; }
  };
  const diags = [];
  const outcomes = [];
  const rig = { clock, diags, outcomes, llm, bootSeen: new Set(), echoSeen: new Map(),stall: new Map(), interfere: new Set(), humanDirty: new Set(), capacityHold: false, holdArchives: false, settleDelay: new Map() };

  // index.ts:361 - the ONE hive; this sandbox's harness home is the "live" home of THIS instance,
  // so the per-provider global writers (AGY hooks.json, statusline) write into the jailed HOME.
  const hive = new HiveManager(() => HARNESS_HOME, (channel, payload) => rendererEmit(channel, payload), {}, (home) => path.resolve(home) === path.resolve(HARNESS_HOME));
  const control = new ControlRegistry();                          // index.ts:377
  const ptyManager = new PtyManager();                            // index.ts:233
  const workerWake = new WorkerWakeWatchdog();                    // index.ts:449
  const codexLifecycle = new CodexRolloutLifecycleSource();       // index.ts:451
  const ptyToAgent = new Map();
  const ptyProvider = new Map();
  const ptyForAgent = (agentId) => { for (const [p, a] of ptyToAgent) if (a === agentId) return p; return undefined; };
  let inboxWake = null;
  let hookServer = null;

  // ——— the renderer stand-ins ———
  const composerOf = (ptyId) => {
    const agentId = ptyToAgent.get(ptyId);
    if (!agentId) return null;
    try { return JSON.parse(fs.readFileSync(path.join(RIG_DIR, 'stubs', agentId, 'composer.json'), 'utf8')); } catch { return null; }
  };
  // RIG-DESYNC (rc/1.1.76 gate #2): what the screen shows is the stub's composer AS OF the newest
  // echo the host has received, never a state whose echo bytes are still in flight. In the app the
  // reading comes from xterm after the bytes it covers are applied (terminalPool term.write('', cb),
  // stamped main-side), so "text visible" and "its echo arrived" are one event; reading the stub's
  // composer.json directly let the rig's screen run ahead of the output generation, and a late echo
  // of our own text then read as "the Enter was lost" (a second Enter).
  // null: the newest received echo fell out of the stub's window, so NO reading (fail closed).
  const screenDraft = (ptyId, c) => screenDraftOf(c.shown, c.draft, rig.echoSeen.get(ptyId) || 0);
  const count = (hay, needle) => { let n = 0; let i = hay.indexOf(needle); while (needle && i >= 0) { n++; i = hay.indexOf(needle, i + needle.length); } return n; };
  // The mirrors the renderer pushes into main (terminalPool / inputOrigin / the prompt mirror).
  const ownerPty = {
    write: (id, data, origin) => {
      const r = ptyManager.write(id, data, origin);
      // A PERSON types right after the owner staged its text (F6): the key lands in the gap.
      const agentId = ptyToAgent.get(id);
      if (r.ok && agentId && rig.interfere.has(agentId) && data !== '\r' && data.length > 1) {
        rig.interfere.delete(agentId);
        // 20 ms after the paste: inside the owner's GAP_MS (140 ms) before its Enter, on the same
        // timer queue as the owner's own wait, so the order is fixed.
        setTimeout(() => { ptyManager.write(id, 'x', 'HUMAN'); rig.humanDirty.add(id); }, 20);
      }
      return r;
    },
    incarnation: (id) => ptyManager.incarnation(id),
    humanInputGeneration: (id) => ptyManager.humanInputGeneration(id),
    lastHumanInputAt: (id) => ptyManager.lastHumanInputAt(id),
    hasOutput: (id) => ptyManager.hasOutput(id),
    inputState: (id) => (ptyManager.incarnation(id) === undefined ? undefined : { mouseTrackingMode: 'none', inputOriginAttached: true, selfTest: 'pass' }),
    promptState: (id) => {
      const c = composerOf(id);
      if (!c) return undefined;
      if (!c.draft) { rig.humanDirty.delete(id); return { block: null }; }
      return { block: rig.humanDirty.has(id) ? 'draft' : null };
    },
    // WAKE-SCREEN-GUARD (1.1.76): the real PtyManager's output generation and spawn cwd.
    outputGeneration: (id) => ptyManager.outputGeneration(id),
    spawnCwd: (id) => ptyManager.spawnCwd(id)
  };
  // WAKE-SCREEN-GUARD: the renderer's Codex screen reading (terminalPool readCodexScreen). The rig's
  // fake Codex is always past startup (its header would show its model); its composer is the stub's.
  const readCodexScreen = async (ptyId, expectedTail) => {
    const c = composerOf(ptyId);
    if (!c) return null;
    const draft = screenDraft(ptyId, c);
    if (draft === null) return null;
    const row = draft.split('\n').pop();
    return {
      onPromptRow: false, screenCount: 0,
      codex: { header: 'MODEL', startingAfterHeader: false, cursorRow: draft ? `\u203a ${row}` : '\u203a Ask Codex to do anything', footer: [] },
      ...(expectedTail !== undefined ? { promptTailMatches: draft.endsWith(expectedTail) } : {})
    };
  };
  const readScreen = async (ptyId, needle, expectedTail) => {
    const c = composerOf(ptyId);
    if (!c) return null;
    const draft = screenDraft(ptyId, c);
    if (draft === null) return null;
    const row = draft.split('\n').pop();
    return { onPromptRow: !!needle && draft.includes(needle) && row.length > 0, screenCount: count(draft, needle), ...(expectedTail !== undefined ? { promptTailMatches: draft.endsWith(expectedTail) } : {}) };
  };
  const decision = (verdict, reason, workClass) => ({ verdict, reason, poolKey: 'rig-pool', state: null, workClass, limitEpochAt: null, grantId: null });
  const capacity = {
    admit: (_agentId, workClass) => (rig.capacityHold ? decision('REFUSE', 'POOL_LIMITED', workClass) : decision('ALLOW', 'POOL_AVAILABLE', workClass)),
    revalidate: () => (rig.capacityHold ? { verdict: 'REFUSE', reason: 'POOL_LIMITED' } : { verdict: 'ALLOW', reason: 'POOL_AVAILABLE' }),
    confirmLaunch: () => {}, cancelGrant: () => {}, holdGrant: () => {}
  };
  // index.ts:560 - the one submit owner.
  const automaticSubmit = new AutomaticSubmitOwner(buildOwnerDeps({
    pty: ownerPty,
    capacity,
    ptyForAgent: (agentId) => ptyForAgent(agentId),
    providerForPty: (ptyId) => ptyProvider.get(ptyId),
    requestScreenReading: readScreen,
    requestCodexScreen: readCodexScreen,
    onScreenGuard: (r) => { diags.push({ stage: 'screen-guard', agentId: r.agentId, why: r.phase + ':' + (r.ok ? 'ok' : 'NO') + ':' + r.reason + ':gen=' + r.observedGeneration + '/' + r.currentGeneration, at: clock.now() }); if (diags.length > 5000) diags.shift(); },
    onOutcome: (r) => { outcomes.push({ agentId: r.agentId, requestId: r.requestId, cls: r.admissionClass, outcome: r.outcome, at: r.at }); if (outcomes.length > 500) outcomes.shift(); }
  }));

  // useHive's terminal-handoff queue (N2): type the work order, and report the COMMITTED write.
  const workOrderText = (m) => ['WORK ORDER FROM HIVE', `Message: ${m.id}`, `From: ${m.from}`, `Subject: ${m.subject}`, `Act: ${m.act}${m.requiresReply ? ' (reply expected)' : ''}`, `Issued: ${m.createdAt}`, '', m.body, '', 'Notes:', '- This arrived through your terminal because this provider does not support hive inbox.'].join('\n');
  // The queue item stays until it is COMMITTED (useHive drains CAPACITY_GATED, or USER_RELEASED when
  // the Human presses "send now": an unmeasured provider's automatic delivery is refused by the gate).
  rig.workOrders = new Map();   // agentId -> [{payload, attempts}]
  function submitWorkOrder(agentId, item, manual) {
    const p = item.payload;
    item.attempts += 1;
    return automaticSubmit.submit({ requestId: `wo-${agentId}-${p.id}-${item.attempts}`, agentId, admissionClass: manual ? 'USER_RELEASED' : 'CAPACITY_GATED', text: workOrderText(p) }).then((o) => {
      diags.push({ stage: 'work-order-submit', agentId, id: p.id, outcome: o.kind, reason: o.reason ?? null, manual, at: clock.now() });
      if (o.kind === 'COMMITTED') {
        rig.workOrders.set(agentId, (rig.workOrders.get(agentId) || []).filter((x) => x !== item));
        hive.recordWorkOrderDelivered(agentId, p.id, { from: p.from, act: p.act, subject: p.subject, requiresReply: p.requiresReply });
      }
      return o;
    });
  }
  function rendererEmit(channel, payload) {
    if (channel !== 'hive:terminalHandoff') return false;
    const ptyId = ptyForAgent(payload.to);
    if (!ptyId) return false;
    const item = { payload, attempts: 0 };
    rig.workOrders.set(payload.to, [...(rig.workOrders.get(payload.to) || []), item]);
    void submitWorkOrder(payload.to, item, false);
    return true;
  }
  rig.sendNow = async (agentId) => {
    const out = [];
    for (const item of [...(rig.workOrders.get(agentId) || [])]) out.push((await submitWorkOrder(agentId, item, true)).kind);
    return out;
  };

  // index.ts:693
  control.setTransitionObserver((agentId, transition) => {
    if (transition === 'UNPAUSED' || transition === 'RESUMED' || transition === 'AUTO_DELIVERY_RELEASED') inboxWake?.onControlRelease(agentId);
  });

  // index.ts:668 wakeMailMode / :678 mailPendingIds
  const wakeMailMode = (agentId) => {
    const mode = hookServer.mailChannel(agentId).mode;
    let override = null;
    try { override = hive.mail.channelOverride(agentId); } catch { override = null; }
    return mailNudgeMode(mode, override);
  };
  const mailPendingIds = (agentId) => coordinatorPendingIds(agentId, {
    mode: (a) => hookServer.mailChannel(a).mode,
    pending: (a) => hive.mail.pending(a),
    skipped: (a) => hookServer.mailSkippedIds(a),
    files: (a) => hive.inbox(a).map((m) => m.id)
  });

  // index.ts:603
  inboxWake = new InboxWakeBridge({
    coordinator: workerWake,
    codexTurnProbe: (agentId) => {
      const home = hive.codexHomeFor(agentId);
      if (!home) return undefined;
      const p = codexLifecycle.probe(home);
      return p.ok && p.latest ? { ...p, latest: { ...p.latest, at: clock.at(p.latest.at) } } : p;
    },
    confirmsTurnStart: (agentId) => { const p = ptyForAgent(agentId); const prov = p ? ptyProvider.get(p) : undefined; return prov === 'claude' || prov === 'codex' || prov === 'antigravity'; },
    inboxIds: (agentId) => mailPendingIds(agentId),
    mail: {
      mode: (agentId) => hookServer.mailChannel(agentId).mode,
      closeTurn: (agentId, turnId) => { hookServer.closeMailTurn(agentId, turnId); },
      abortSince: (agentId, since) => { hookServer.abortMailEpochsSince(agentId, since, 'submit-unconfirmed'); },
      closeStale: (agentId, now) => hookServer.closeStaleMailEpochs(agentId, now),
      hasOpenEpoch: (agentId) => hive.mail.openEpochs(agentId).length > 0,
      n1DueIds: (agentId) => hive.mail.n1Due(agentId),
      openIds: (agentId) => hive.mail.openNotDelivered(agentId),
      degrade: (agentId, reason, detail) => hive.mail.degradeChannel(agentId, reason, detail, { respawnToRestore: hive.registry().agents[agentId]?.provider === 'codex' }),
      log: (row) => hive.appendLog(row)
    },
    facts: (agentId) => {
      const ptyId = ptyForAgent(agentId);
      if (!ptyId) return null;
      const snap = control.snapshot(agentId);
      const out = ptyManager.lastOutputAt(ptyId) ?? 0;
      return { ptyId, lastOutputAt: out > 0 ? clock.at(out) : 0, autoDeliveryPaused: snap.autoDeliveryPaused, paused: snap.paused, halted: snap.halted, inhibited: automaticSubmit.inhibition(ptyId) !== null };
    },
    // P1 (dry #6): the driver can hold the owner's outcome back, so a fast turn's Stop lands first.
    submit: (req) => { const p = automaticSubmit.submit(req); const d = rig.settleDelay.get(req.agentId); return d ? p.then((v) => new Promise((r) => setTimeout(() => r(v), d))) : p; },
    text: (ids, agentId) => inboxWakeTextForProvider(agentId ? hive.registry().agents[agentId]?.provider : undefined, [...ids], agentId ? wakeMailMode(agentId) : 'inject'),
    setImmediate: (fn) => { setImmediate(fn); },
    now: () => clock.now(),
    diag: (stage, fields) => { diags.push({ stage, ...fields, at: clock.now() }); if (diags.length > 5000) diags.shift(); }
  });

  // index.ts:698
  hookServer = new HookServer(
    hive, () => null, () => ({ notifications: false }), control, undefined, () => null,
    (agentId, event, message, fullyIdle, turnId, source) => {
      // C1: the driver can stall THIS process inside the next hook of an agent (a hung main
      // thread), which is what makes a hook response late.
      const st = agentId ? rig.stall.get(agentId) : undefined;
      if (st && (!st.event || st.event === event)) { rig.stall.delete(agentId); const until = Date.now() + st.ms; while (Date.now() < until) { /* stalled main thread */ } }
      inboxWake?.onHook(agentId, event, message, fullyIdle, turnId, source);
    },
    undefined,
    // index.ts:716 - one AGY statusline tick: the lifecycle half (capacity is the stand-in above).
    (agentId, tick) => { if (agentId) inboxWake?.onProviderStatus(agentId, tick.lifecycle, tick.sessionId, clock.at(tick.readAt)); }
  );
  // index.ts:743
  hookServer.setMailCoordination({
    lifecycleActive: (agentId) => { const s = workerWake.state(agentId); return s.lifecycle === 'active' && !s.provisional; },
    wakeIds: (agentId) => { const s = workerWake.state(agentId); return s.lifecycle === 'active' && s.provisional ? [] : s.announced; },
    onEpochClosed: (agentId, outcome, reason, redelivered) => inboxWake?.onMailEpochClosed(agentId, outcome, reason, redelivered),
    onMailBlock: (agentId) => inboxWake?.onMailBlock(agentId)
  });
  // index.ts:757
  hive.setHookBroker({ urlFor: (id) => hookServer.hookUrl(id), mcpFor: (id) => hookServer.mcpEndpoint(id), revoke: (id) => hookServer.revokeHookToken(id) });
  // index.ts:6376 hive.setDeliveryObserver (bootstrapHiveServices)
  hive.setDeliveryObserver(({ agentId, messageId }) => inboxWake?.onDelivery(agentId, messageId));

  // ——— teardown (index.ts:932 teardownPty, the mail-relevant steps) ———
  // Q32 (god 0f1672): index.ts teardownPty(id, archiveReason = 'explicit'): every kill site calls it
  // with the default (a tab / voice kill bounces); only the PTY's own exit passes 'pty-exit'.
  function teardownPty(ptyId, exitCode, archiveReason = 'explicit') {
    const agentId = ptyToAgent.get(ptyId);
    diags.push({ stage: 'pty-exit', ptyId, agentId: agentId ?? null, exitCode: exitCode ?? null, at: clock.now() });
    if (!agentId) return;
    ptyToAgent.delete(ptyId);
    ptyProvider.delete(ptyId);
    try { workerWake.forget(agentId, ptyId); } catch { /* best effort */ }
    if (![...ptyToAgent.values()].includes(agentId)) { try { hookServer.abortMailTurn(agentId, 'pty-exit'); } catch { /* best effort */ } }
    try { hive.stopProxyBridge(agentId); } catch { /* best effort */ }
    try { hive.setArchived(agentId, true, archiveReason); } catch { /* best effort */ }
  }
  // index.ts:1124 (onExit): teardownPty(id, 'pty-exit').
  ptyManager.setExitHandler((id, exitCode) => teardownPty(id, exitCode, 'pty-exit'));
  // The renderer's PTY data sink (there is no window): watch each stream for the stub's
  // boot-complete sentinel, escape sequences removed (ConPTY may interleave them).
  const bootBuf = new Map();
  const echoTail = new Map();
  ptyManager.attachWebContents({
    isDestroyed: () => false,
    send: (channel, data) => {
      if (typeof channel !== 'string' || !channel.startsWith('pty:data:') || typeof data !== 'string') return;
      const id = channel.slice('pty:data:'.length);
      // RIG-DESYNC: the newest stub echo this stream has DELIVERED (its OSC 0 rig-echo-N title;
      // a marker split across chunks is joined through a short tail).
      const scan = (echoTail.get(id) || '') + data;
      for (const m of scan.matchAll(/\x1b\]0;rig-echo-(\d+)(?:\x07|\x1b\\)/g)) {
        const n = Number(m[1]);
        if (n > (rig.echoSeen.get(id) || 0)) rig.echoSeen.set(id, n);
      }
      echoTail.set(id, scan.slice(-48));
      if (rig.bootSeen.has(id)) return;
      const buf = ((bootBuf.get(id) || '') + data.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|[\r\n]/g, '')).slice(-200);
      if (buf.includes('[rig-boot-complete]')) { rig.bootSeen.add(id); bootBuf.delete(id); } else bootBuf.set(id, buf);
    }
  });

  // ——— bootstrapHiveServices (index.ts), the mail-relevant part ———
  hive.ensureHive();
  const migration = hive.migrateMail();          // index.ts: right before archiveOrphanedAgents
  hive.startRouter(400);
  hookServer.start();
  hive.startAgyStatusline();                     // index.ts:6389 (the lease is taken at the first AGY spawn)
  // The HTTP broker binds asynchronously: wait until it answers with a URL.
  for (let i = 0; i < 200; i++) {
    const u = hookServer.hookUrl('rig-probe');
    hookServer.revokeHookToken('rig-probe');
    if (u) break;
    await new Promise((r) => setTimeout(r, 25));
  }

  // index.ts:6419 runWorkerWakeBeat
  function beat() {
    const reg = hive.registry();
    const live = Object.entries(reg.agents || {}).filter(([agentId, a]) => !a?.archived && ptyForAgent(agentId)).map(([agentId]) => agentId);
    for (const agentId of live) {
      try {
        const mode = hookServer.mailChannel(agentId).mode;
        const noStop = mode === 'legacy-move' || (mode === 'legacy-read' && hive.mail.channelOverride(agentId)?.reason === 'zero-hook-traffic');
        if (mode !== 'work-order') hive.mail.reconcileInbox(agentId, { moveIsHandled: noStop });
      } catch { /* the next beat retries */ }
    }
    inboxWake.reconcileAll(live);
    return live;
  }

  // ——— the spawn path (index.ts spawnAgentCore, the steps a hive agent's spawn takes) ———
  let ptySeq = 0;
  function writeShim(flavour) {
    const bin = path.join(RIG_DIR, 'bin');
    const js = path.join(bin, `fake-${flavour}.cjs`);
    fs.writeFileSync(js, `require(${JSON.stringify(path.join(__dirname, 'fake-agent.cjs'))}).main(${JSON.stringify(flavour)});\n`);
    // An npm cmd-shim, byte-shaped like the ones npm writes, so PtyManager takes its REAL
    // Windows route (decode the shim, spawn node + script with an argv array).
    const cmd = path.join(bin, `fake-${flavour}.cmd`);
    fs.writeFileSync(cmd, ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
      `endLocal & goto #_undefined_# 2>NUL || title %COMVAR% & "%_prog%"  "%dp0%\\fake-${flavour}.cjs" %*`, ''].join('\r\n'));
    return cmd;
  }

  async function spawnAgent(a) {
    // A respawn of a live agent replaces its terminal (restart in place): the old one is killed
    // and torn down first, so one CLI per agent is ever alive.
    const old = ptyForAgent(a.id);
    if (old) {
      ptyManager.kill(old);
      teardownPty(old);
      const oldPid = Number(fs.readFileSync(path.join(RIG_DIR, 'stubs', a.id, 'pid'), 'utf8') || 0);
      for (let i = 0; i < 100 && oldPid > 0; i++) { try { process.kill(oldPid, 0); } catch { break; } await new Promise((r) => setTimeout(r, 50)); }
    }
    const flavour = a.flavour;
    const provider = a.provider || PROVIDER_OF[flavour];
    const stubDir = path.join(RIG_DIR, 'stubs', a.id);
    fs.mkdirSync(stubDir, { recursive: true });
    fs.writeFileSync(path.join(stubDir, 'scenario.json'), JSON.stringify(a.scenario || {}));
    const cwd = path.join(WORK, a.id);
    fs.mkdirSync(cwd, { recursive: true });
    const command = writeShim(flavour);
    const inj = await hive.ensureAgent({ id: a.id, name: a.name || a.id, provider, cwd, isGod: a.isGod === true });
    if (inj.refusal) return { ok: false, error: inj.refusal };
    const args = [...(inj.args || [])];
    if (a.resume && flavour === 'claude') { const sid = hive.lastSession(a.id); if (sid) args.push('--resume', sid); }
    const ptyId = `pty-${a.id}-${++ptySeq}`;
    const r = await ptyManager.spawn({ id: ptyId, cwd, command, args, env: { ...(inj.env || {}) }, cols: 120, rows: 30 });
    if (!r.ok) return r;
    ptyToAgent.set(ptyId, a.id);                          // index.ts:3790
    ptyProvider.set(ptyId, provider);
    workerWake.noteSpawn(ptyId, clock.now(), a.id);        // :3794
    try { hookServer.abortMailTurn(a.id, 'respawn'); } catch { /* best effort */ }   // :3798
    return { ok: true, ptyId, provider, argCount: args.length, settings: args.includes('--settings') };
  }

  return { teardownPty, hive, hookServer, inboxWake, workerWake, control, ptyManager, automaticSubmit, ptyToAgent, ptyProvider, ptyForAgent, rig, beat, spawnAgent, migration, readers, mailPendingIds, wakeMailMode };
}

// ————————————————————————————————————————————————————————————— the control port

async function main() {
  const f = await buildFloor();
  const { hive, hookServer, workerWake, control, ptyManager, automaticSubmit, rig } = f;
  const ptyOf = (id) => { const p = f.ptyForAgent(id); if (!p) throw new Error(`no pty for ${id}`); return p; };
  const cmds = {
    ping: () => ({ pid: process.pid, home: os.homedir(), hiveRoot: hive.root(), sock: hive.sockPath(), llm: rig.llm.url, envNames: Object.keys(process.env).sort(), path: process.env.PATH || '' }),
    spawn: (a) => f.spawnAgent(a),
    register: async (a) => { const cwd = path.join(WORK, a.id); fs.mkdirSync(cwd, { recursive: true }); await hive.ensureAgent({ id: a.id, name: a.name || a.id, provider: a.provider || 'claude', cwd, isGod: a.isGod === true }); if (a.archived) hive.setArchived(a.id, true); return { ok: true }; },
    // The EXPLICIT archive (the `hive:setArchived` IPC / the voice setArchived action), never the boot orphan pass.
    // index.ts:4487 passes no reason: hive.setArchived(id, archived === true), the 'explicit' default.
    archiveExplicit: ({ id }) => { hive.setArchived(id, true); return { ok: true }; },
    // The boot orphan pass (index.ts:1531 archiveOrphanedAgents): hive.setArchived(id, true, 'orphan').
    archiveOrphan: ({ id }) => { hive.setArchived(id, true, 'orphan'); return { ok: true }; },
    // Un-archive (the same IPC with archived false): restores .undelivered/ (Q32 safeguard).
    unarchive: ({ id }) => { hive.setArchived(id, false); return { ok: true }; },
    send: ({ from = 'god-1', ...msg }) => hive.send(msg, from),
    routeOnce: () => hive.routeOnce(),
    ledger: ({ id }) => hive.mail.ledger(id),
    flush: () => { hive.mail.flushAll(); return true; },
    logRows: ({ kinds, n = 20000 } = {}) => hive.logTail(n).filter((r) => !kinds || kinds.includes(r.kind)),
    wakeState: ({ id }) => ({ ...workerWake.state(id), turn: workerWake.turnFacts(id) }),
    pending: ({ id }) => f.mailPendingIds(id),
    // Is any live agent mid-wake (a submit in flight) or mid-turn? The driver waits for quiet
    // before it moves the simulated clock, so a slow real turn is never mistaken for a lost one.
    busy: () => {
      const reg = hive.registry();
      return Object.keys(reg.agents || {}).filter((a) => f.ptyForAgent(a)).some((a) => { const s = workerWake.state(a); return !!s.inFlight || s.lifecycle === 'active'; });
    },
    // LOAD-FLAKES-176: is any wake being typed right now (the host half of Rig.stubsIdle)?
    inFlight: () => Object.keys(hive.registry().agents || {}).some((a) => !!workerWake.state(a).inFlight),
    diags: ({ since = 0 } = {}) => rig.diags.filter((d) => d.at >= since),
    outcomes: () => rig.outcomes,
    advance: ({ ms }) => rig.clock.advance(ms),
    beat: () => f.beat(),
    pause: ({ id, on }) => { control.pause(id, on); return control.snapshot(id); },
    resume: ({ id }) => { control.resume(id); return control.snapshot(id); },
    steer: ({ id, text }) => { control.steer(id, text); return true; },
    capacityHold: ({ on }) => { rig.capacityHold = on; if (!on) f.inboxWake.onCapacityChange(); return on; },
    armInterfere: ({ id }) => { rig.interfere.add(id); return true; },
    resolveInterference: ({ id, how }) => { const ok = automaticSubmit.resolveInterference(ptyOf(id), how); if (ok) f.inboxWake.onInterferenceResolved(id, how); return ok; },
    inhibition: ({ id }) => automaticSubmit.inhibition(ptyOf(id)),
    sendNow: ({ id }) => rig.sendNow(id),
    workOrders: ({ id }) => (rig.workOrders.get(id) || []).map((w) => w.payload.id),
    humanType: ({ id, text }) => { const p = ptyOf(id); const r = ptyManager.write(p, text, 'HUMAN'); if (/[^\r\x15\x03]/.test(text)) rig.humanDirty.add(p); return r; },
    // The `pty:kill` IPC (index.ts:3937): kill, then the shared teardown.
    killPty: ({ id }) => { const p = ptyOf(id); const r = ptyManager.kill(p); f.teardownPty(p); return r; },
    hasPty: ({ id }) => !!f.ptyForAgent(id),
    // Has this agent's CURRENT PTY carried the stub's boot-complete sentinel (the last bytes it
    // writes at boot)? The driver moves the simulated clock only after it has (Rig.settleBoot).
    bootSeen: ({ id }) => { const p = f.ptyForAgent(id); return !!p && rig.bootSeen.has(p); },
    stallNextHook: ({ id, ms, event }) => { rig.stall.set(id, { ms, event }); return true; },
    delaySettle: ({ id, ms }) => { if (ms) rig.settleDelay.set(id, ms); else rig.settleDelay.delete(id); return true; },
    // C1 (deterministic lateness): the NEXT mail-claim settle of this agent is measured as if its
    // response had flushed `ms` after the hook arrived. The response itself leaves at once, so it
    // never races the provider shim's own give-up timer (the AGY shim exits 5 s after it starts).
    // A test seam on the rig's own instance, like holdArchives; the product method runs unchanged.
    lateNextFlush: ({ id, ms }) => {
      const orig = hookServer.settleMailClaims;
      hookServer.settleMailClaims = function lateOnce(claims, receivedAt, flushedAt) {
        // MAIL-RIG-C1-FLAKE: anchored at the FLUSH, so the measured latency is exactly `ms` whatever
        // the real hook-to-flush time was on this machine (it used to be ms + that time).
        if (claims.some((c) => c.agentId === id)) { hookServer.settleMailClaims = orig; return orig.call(this, claims, flushedAt === null ? receivedAt - ms : flushedAt - ms, flushedAt); }
        return orig.call(this, claims, receivedAt, flushedAt);
      };
      return true;
    },
    holdArchives: ({ on }) => {
      // F2: freeze the harness `.done` rename AFTER the durable ledger write, and say so on disk,
      // so the driver can kill -9 this process exactly between the two (a test seam on the rig's
      // own instance; the production method is untouched).
      const ledger = hive.mail;
      if (on && !ledger.__origRunArchives) {
        ledger.__origRunArchives = ledger.runArchives;
        ledger.runArchives = function held(st) { if (st.archive.size) fs.writeFileSync(path.join(RIG_DIR, 'at-rename.json'), JSON.stringify({ agentId: st.agentId, ids: [...st.archive] })); };
      } else if (!on && ledger.__origRunArchives) { ledger.runArchives = ledger.__origRunArchives; delete ledger.__origRunArchives; }
      return true;
    },
    mailChannel: ({ id }) => hookServer.mailChannel(id),
    channelOverride: ({ id }) => hive.mail.channelOverride(id),
    integrity: () => hive.integrityIssues(),
    registry: () => hive.registry(),
    migration: () => f.migration,
    undelivered: () => hive.undeliveredReport(),
    readers: ({ id }) => ({
      fleet: f.readers.fleetMailFields(hive.mail, id),
      actionableBacklog: f.readers.actionableBacklog(hive.mail, id),
      actionablePending: f.readers.actionablePending(hive.mail, id),
      hasBacklog: f.readers.hasBacklog(hive.mail, id),
      floor: f.readers.floorMailActivityAt(hive.mail, [id]),
      coordinationAt: f.readers.mailCoordinationAt(hive.mail, id),
      ledgerInbox: f.readers.ledgerInboxMessages(hive.mail, id),
      backlog: hive.inboxBacklog(id),
      history: hive.mailHistory(id).map((m) => ({ id: m.id, mail_state: m.mail_state, archived: m.archived })),
      lastActivityAt: hive.mail.lastActivityAt(id),
      lastActedAt: hive.mail.lastActedAt(id)
    }),
    mailEpoch: ({ id }) => hookServer.mailEpoch(id),
    shutdown: async () => { setTimeout(() => shutdown(0), 10); return true; }
  };

  let closing = false;
  async function shutdown(code) {
    if (closing) return;
    closing = true;
    try { await ptyManager.killAllAsync(3000); } catch { /* best effort */ }
    try { hookServer.stop(); } catch { /* best effort */ }
    try { hive.stopRouter(); hive.stopAllProxyBridges(); hive.dispose(); } catch { /* best effort */ }
    try { rig.llm.srv.close(); } catch { /* best effort */ }
    process.exit(code);
  }

  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let out;
      try {
        const { cmd, args } = JSON.parse(body || '{}');
        if (!cmds[cmd]) throw new Error(`unknown rig command ${cmd}`);
        out = { ok: true, value: await cmds[cmd](args || {}) };
      } catch (e) {
        out = { ok: false, error: String((e && e.stack) || e) };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? { ok: true, value: null }));
    });
  });
  srv.listen(0, '127.0.0.1', () => {
    const info = { pid: process.pid, port: srv.address().port, hiveRoot: hive.root(), home: os.homedir() };
    fs.writeFileSync(path.join(RIG_DIR, `host-${process.pid}.json`), JSON.stringify(info));
    process.stdout.write(`__RIG_READY__${JSON.stringify(info)}\n`);
  });
  process.on('SIGTERM', () => shutdown(0));
  // The driver is this process's lifeline too: a crashed test never leaves an instance behind.
  const parent = Number(argOf('parent', '0'));
  if (parent > 0) setInterval(() => { try { process.kill(parent, 0); } catch { shutdown(0); } }, 500).unref();
}

main().catch((e) => { process.stderr.write(`rig-host failed: ${(e && e.stack) || e}\n`); process.exit(1); });
