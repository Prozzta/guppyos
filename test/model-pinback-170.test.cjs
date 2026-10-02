'use strict';
/**
 * MODEL-PINBACK (1.1.70):
 *   G1 - OUR per-agent Codex config.toml names the model the agent is launched with (a `--model`
 *        flag beats config.toml, so the seed's `model` line was inert and misleading); with no
 *        picked model the seed's line stays. The user's ~/.codex/config.toml is never written.
 *   G2 - a live in-TUI model switch is pinned back to the agent record (Claude status line, Codex
 *        rollout turn_context, AGY statusline) ONLY when it differs from what the process was
 *        launched with; stale lines and other sessions never pin.
 *   RESPAWN-KEEPS-SWITCH - after a pinned switch, the next spawn's args carry the switched model,
 *        per provider; a picker change since the pin wins over it.
 *
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME ARE REDIRECTED AND ASSERTED before any hive
 * is built. No CLI, app or window is started.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/codexAgentConfig.ts');
const P = loadTs('src/shared/modelPin.ts');
const { CodexRolloutCapacitySource, latestTurnContextModel } = loadTs('src/main/codexRolloutCapacity.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const ASTRA = 'gpt-6-astra';
const TERRA = 'gpt-5.6-terra';
const SOL = 'gpt-5.6-sol';
const LUNA = 'gpt-5.6-luna';

function sandbox(t, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin170-'));
  const saved = {};
  for (const k of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GEMINI_CLI_HOME']) saved[k] = process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.CODEX_HOME;
  process.env.GEMINI_CLI_HOME = path.join(home, '.gemini');
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  if (seed !== undefined) fs.writeFileSync(path.join(home, '.codex', 'config.toml'), seed);
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  // The human-input source main wires from PtyManager.lastHumanInputAt: `type()` is a human
  // keystroke on the agent's pty right now. Until then there has been none.
  const keys = { at: undefined };
  hive.setHumanInputSource(() => keys.at);
  const rows = [];
  const append = hive.appendLog.bind(hive);
  hive.appendLog = (e) => { rows.push(e); append(e); };
  return { home, hive, rows, type: () => { keys.at = Date.now() + 1; } };
}

const entry = (hive, id) => hive.registry().agents[id];
const codexConfig = (inj) => fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');

// ─── G1 ─────────────────────────────────────────────────────────────────────

test('G1 setCodexModel: the seed model line is replaced by the picked one; nothing picked keeps the seed', () => {
  const seed = 'model = "gpt-6-astra"\n"model_reasoning_effort" = "high"\n\n[profiles.fast]\nmodel = "gpt-5.6-luna"\n';
  const out = C.setCodexModel(seed, TERRA);
  const cfg = toml.parse(out); // a duplicate key would throw
  assert.equal(cfg.model, TERRA);
  assert.equal(cfg.model_reasoning_effort, 'high');
  assert.equal(cfg.profiles.fast.model, LUNA, 'a profile table is left alone');
  assert.equal((out.match(/^model\s*=/gm) || []).length, 2, 'ours + the profile one, no stray seed line');
  assert.equal(C.setCodexModel(seed, undefined), seed);
  assert.equal(C.setCodexModel(seed, '  '), seed);
  assert.equal(toml.parse(C.setCodexModel("'model' = 'x'\n", TERRA)).model, TERRA, 'a quoted seed key is replaced too');
  assert.equal(toml.parse(C.setCodexModel('', TERRA)).model, TERRA);
});

test('G1: a picked model is what OUR config.toml says; the global file is byte-identical', async (t) => {
  const seed = `model = "${ASTRA}"\n\n[tui]\ntheme = "dark"\n`;
  const s = sandbox(t, seed);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home },
    { spawnModel: { requested: TERRA, launch: TERRA } });
  const text = codexConfig(inj);
  const cfg = toml.parse(text);
  assert.equal(cfg.model, TERRA);
  assert.ok(!text.includes(ASTRA), 'no stray seed model line');
  assert.equal(cfg.tui.theme, 'dark');
  assert.ok(cfg.hooks && cfg.hooks.Stop, 'our hooks are still wired');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), seed, 'the global file is never written');
  const e = entry(s.hive, 'dw-1');
  assert.equal(e.requestedModel, TERRA);
  assert.equal(e.launchModel, TERRA);
  assert.equal(typeof e.launchedAt, 'number');
});

test('G1: with no picked model the seed model line is kept (Codex uses it)', async (t) => {
  const seed = `model = "${ASTRA}"\n`;
  const s = sandbox(t, seed);
  const inj = await s.hive.ensureAgent({ id: 'dw-2', name: 'Dwight', provider: 'codex', cwd: s.home }, { spawnModel: {} });
  assert.equal(toml.parse(codexConfig(inj)).model, ASTRA);
  const inj2 = await s.hive.ensureAgent({ id: 'dw-3', name: 'Dwight', provider: 'codex', cwd: s.home }, {});
  assert.equal(toml.parse(codexConfig(inj2)).model, ASTRA, 'an older caller (no spawnModel) is unchanged');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), seed);
});

test('G1: the generated Claude settings and the AGY agent file carry no model key at all', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'cl-1', name: 'Jim', provider: 'claude', cwd: s.home }, {});
  const i = inj.args.indexOf('--settings');
  assert.ok(i >= 0, 'claude gets a per-agent settings file');
  const settings = JSON.parse(fs.readFileSync(inj.args[i + 1], 'utf8'));
  assert.equal('model' in settings, false);
  const md = HiveManager.agyAgentMarkdown({ id: 'ag-1', name: 'Kelly' }, 'protocol');
  assert.doesNotMatch(md, /^model\s*:/m);
});

// ─── spawn-arg resolution (pure) ────────────────────────────────────────────

test('resolveSpawnArgs: the request wins without a pin; a pin wins only against its own request', () => {
  const args = ['--model', TERRA, '--dangerously-bypass-approvals-and-sandbox'];
  assert.deepEqual(P.resolveSpawnArgs(undefined, args).args, args);
  const pinned = { model: SOL, modelPinnedFrom: TERRA };
  const r = P.resolveSpawnArgs(pinned, args);
  assert.deepEqual(r.args, ['--model', SOL, '--dangerously-bypass-approvals-and-sandbox']);
  assert.equal(r.requested, TERRA);
  assert.equal(r.launch, SOL);
  assert.deepEqual(P.resolveSpawnArgs(pinned, ['--model', LUNA]).args, ['--model', LUNA], 'a picker change wins');
  assert.deepEqual(P.resolveSpawnArgs({ model: SOL }, ['x']).args, ['x', '--model', SOL], 'pinned with no request: appended');
  assert.deepEqual(P.resolveSpawnArgs(undefined, ['x'], { fallback: 'claude-fable-5' }).args, ['x', '--model', 'claude-fable-5']);
  assert.deepEqual(P.resolveSpawnArgs(pinned, [`--model=${TERRA}`]).args, [`--model=${SOL}`]);
});

// ─── G2: Codex ──────────────────────────────────────────────────────────────

const SID = '01a0e4e6-0000-7000-8000-000000000001';
const OTHER = '01a0e4e6-0000-7000-8000-000000000002';
const turnContext = (model, ts) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'turn_context', payload: { cwd: 'C:/x', model, effort: 'medium' } });

function rollout(codexHome, sid, lines) {
  const dir = path.join(codexHome, 'sessions', '2026', '09', '28');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-28T01-01-07-${sid}.jsonl`);
  fs.appendFileSync(file, lines.map((l) => l + '\n').join(''));
  return file;
}

function codexServer(hive) {
  return new HookServer(hive, () => null, () => ({ defaultModel: 'claude-fable-5' }));
}
const codexHook = (id, sid, extra = {}) => ({ hook_event_name: 'PostToolUse', agent_id: id, session_id: sid, tool_name: 'shell', tool_input: { command: 'ls' }, ...extra });

test('latestTurnContextModel: the newest turn_context model with its own time', () => {
  const tail = [turnContext(TERRA, 1000), '{"type":"event_msg","payload":{}}', turnContext(SOL, 2000), 'garbage'].join('\n');
  assert.deepEqual(latestTurnContextModel(tail), { model: SOL, observedAt: 2000, effort: 'medium' }); // 1.1.79 M2: + effort
  assert.equal(latestTurnContextModel('{"type":"event_msg"}'), null);
});

test('observeRollout: the model comes from the SAME tail read, bound to the hook session', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin170-roll-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  rollout(home, SID, [turnContext(TERRA, Date.now())]);
  rollout(home, OTHER, [turnContext(SOL, Date.now() + 5000)]);
  const src = new CodexRolloutCapacitySource(() => 'scope');
  assert.equal(src.observeRollout(home, { sessionId: SID }).turnModel.model, TERRA, 'not the other session, even if newer');
  assert.deepEqual(src.observeRollout(home, { sessionId: SID }), { capacity: null, turnModel: null }, 'an unchanged file is not re-read');
});

test('G2 Codex: first turn_context = launch model does not pin; a switch pins; a return clears; stale lines never pin', async (t) => {
  const s = sandbox(t, `model = "${ASTRA}"\n`);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home },
    { spawnModel: { requested: TERRA, launch: TERRA } });
  const home = inj.env.CODEX_HOME;
  const server = codexServer(s.hive);
  const launchedAt = entry(s.hive, 'dw-1').launchedAt;

  // A resumed thread's rollout still ends with the previous process's turns.
  rollout(home, SID, [turnContext(SOL, launchedAt - 3_600_000)]);
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, undefined, 'a stale line must not pin');

  rollout(home, SID, [turnContext(TERRA, Date.now() + 1000)]);
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, undefined, 'the launch model is not a switch');

  rollout(home, SID, [turnContext(SOL, Date.now() + 2000)]);
  s.type();
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, SOL, 'an in-TUI /model is pinned');
  assert.equal(entry(s.hive, 'dw-1').modelPinSource, 'user');
  assert.equal(entry(s.hive, 'dw-1').modelPinnedFrom, TERRA);
  assert.equal(entry(s.hive, 'dw-1').liveModel, SOL);

  rollout(home, SID, [turnContext(TERRA, Date.now() + 3000)]);
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, undefined, 'a return to the requested model clears the pin');
});

test('G2 Codex: another session\'s rollout, a subagent hook, or no session id never pins', async (t) => {
  const s = sandbox(t, '');
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home },
    { spawnModel: { requested: TERRA, launch: TERRA } });
  const home = inj.env.CODEX_HOME;
  const server = codexServer(s.hive);
  rollout(home, SID, [turnContext(TERRA, Date.now() + 1000)]);
  rollout(home, OTHER, [turnContext(SOL, Date.now() + 2000)]);
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, undefined, 'the other (newer) rollout is not read');
  server.handle(codexHook('dw-1', OTHER, { provider_agent_id: 'sub-1' }));
  assert.equal(entry(s.hive, 'dw-1').model, undefined, 'a subagent runs its own model');
  rollout(home, SID, [turnContext(LUNA, Date.now() + 3000)]);
  server.handle(codexHook('dw-1', undefined));
  assert.equal(entry(s.hive, 'dw-1').model, undefined, 'unbound (no session id) never pins');
});

test('G2 Codex: launched on the CLI default (no --model), the first turn_context is the baseline, not a switch', async (t) => {
  const s = sandbox(t, `model = "${ASTRA}"\n`);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, { spawnModel: {} });
  const server = codexServer(s.hive);
  rollout(inj.env.CODEX_HOME, SID, [turnContext(ASTRA, Date.now() + 1000)]);
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, undefined);
  assert.equal(entry(s.hive, 'dw-1').liveModel, ASTRA);
  rollout(inj.env.CODEX_HOME, SID, [turnContext(SOL, Date.now() + 2000)]);
  s.type();
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, SOL);
  assert.equal(entry(s.hive, 'dw-1').modelPinnedFrom, undefined);
});

test('RESPAWN-KEEPS-SWITCH Codex: the next spawn args and config.toml carry the switched model; a picker change wins', async (t) => {
  const seed = `model = "${ASTRA}"\n`;
  const s = sandbox(t, seed);
  const meta = { id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home };
  const inj = await s.hive.ensureAgent(meta, { spawnModel: { requested: TERRA, launch: TERRA } });
  const server = codexServer(s.hive);
  rollout(inj.env.CODEX_HOME, SID, [turnContext(TERRA, Date.now() + 1000), turnContext(SOL, Date.now() + 2000)]);
  s.type();
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, SOL);

  // The renderer's persisted command still says terra.
  const rendererArgs = ['--model', TERRA, '--dangerously-bypass-approvals-and-sandbox'];
  const r = P.resolveSpawnArgs(entry(s.hive, 'dw-1'), rendererArgs);
  assert.deepEqual(r.args, ['--model', SOL, '--dangerously-bypass-approvals-and-sandbox']);
  const inj2 = await s.hive.ensureAgent(meta, { spawnModel: { requested: r.requested, launch: r.launch } });
  assert.equal(toml.parse(codexConfig(inj2)).model, SOL, 'our config.toml names the model it runs');
  assert.equal(entry(s.hive, 'dw-1').model, SOL, 'the pin survives the respawn');
  assert.equal(entry(s.hive, 'dw-1').launchModel, SOL);

  // The resumed thread's old turn_context lines (terra, then sol) are stale for this process.
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').model, SOL);

  // The Human picks luna in the app: the picker wins and the pin is dropped.
  const r2 = P.resolveSpawnArgs(entry(s.hive, 'dw-1'), ['--model', LUNA]);
  assert.deepEqual(r2.args, ['--model', LUNA]);
  const inj3 = await s.hive.ensureAgent(meta, { spawnModel: { requested: r2.requested, launch: r2.launch } });
  assert.equal(entry(s.hive, 'dw-1').model, undefined);
  assert.equal(toml.parse(codexConfig(inj3)).model, LUNA);
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), seed, 'the global file is never written');
});

// ─── G2: Antigravity ────────────────────────────────────────────────────────

const PRO = 'Gemini 3.1 Pro (High)';
const FLASH = 'Gemini 3.5 Flash (High)';

function agyPayload(model, at = Date.now()) {
  const bucket = (seconds) => ({ remaining_fraction: 0.5, reset_time: new Date(at + seconds * 1000).toISOString(), reset_in_seconds: seconds });
  return {
    version: '1.2.8', product: 'antigravity', agent_state: 'working', session_id: 'sess-1',
    model: { id: model, display_name: model, effort: 'high' },
    quota: { '3p-5h': bucket(18000), '3p-weekly': bucket(604800), 'gemini-5h': bucket(17000), 'gemini-weekly': bucket(71000) }
  };
}
const agyTick = (id, model, readAt = Date.now()) => ({ hook_event_name: 'AgyStatusLine', agent_id: id, read_at: readAt, agy_status: agyPayload(model) });

test('G2 AGY: the launch model does not pin; a switch pins; a pre-launch tick and a personal session never pin', async (t) => {
  const s = sandbox(t);
  await s.hive.ensureAgent({ id: 'ag-1', name: 'Kelly', provider: 'antigravity', cwd: s.home },
    { spawnModel: { requested: PRO, launch: PRO } });
  const ticks = [];
  const server = new HookServer(s.hive, () => null, () => ({}), undefined, undefined, undefined, undefined, undefined,
    (agentId, tick) => ticks.push(agentId));
  const launchedAt = entry(s.hive, 'ag-1').launchedAt;

  server.handle(agyTick('ag-1', FLASH, launchedAt - 10_000));
  assert.equal(entry(s.hive, 'ag-1').model, undefined, 'a tick read before this launch is stale');
  server.handle(agyTick(null, FLASH));
  assert.equal(entry(s.hive, 'ag-1').model, undefined, 'a session nobody spawned moves nothing');
  server.handle(agyTick('ag-1', PRO));
  assert.equal(entry(s.hive, 'ag-1').model, undefined, 'the launch model is not a switch');
  s.type();
  server.handle(agyTick('ag-1', FLASH));
  assert.equal(entry(s.hive, 'ag-1').model, FLASH);
  assert.equal(entry(s.hive, 'ag-1').modelPinnedFrom, PRO);
  assert.ok(ticks.includes('ag-1'), 'the capacity/lifecycle tick is still delivered');
});

test('RESPAWN-KEEPS-SWITCH AGY: the next spawn args carry the switched label', async (t) => {
  const s = sandbox(t);
  const meta = { id: 'ag-1', name: 'Kelly', provider: 'antigravity', cwd: s.home };
  await s.hive.ensureAgent(meta, { spawnModel: { requested: PRO, launch: PRO } });
  const server = new HookServer(s.hive, () => null, () => ({}));
  server.handle(agyTick('ag-1', PRO));
  s.type();
  server.handle(agyTick('ag-1', FLASH));
  const r = P.resolveSpawnArgs(entry(s.hive, 'ag-1'), ['--model', PRO, '--dangerously-skip-permissions']);
  assert.deepEqual(r.args, ['--model', FLASH, '--dangerously-skip-permissions']);
  await s.hive.ensureAgent(meta, { spawnModel: { requested: r.requested, launch: r.launch } });
  assert.equal(entry(s.hive, 'ag-1').model, FLASH);
  assert.equal(P.effectiveModel(entry(s.hive, 'ag-1')), FLASH, 'G3: the effective model is the switched one');
});

test('G2 AGY: a Codex agent never takes an AGY model (provider gate)', async (t) => {
  const s = sandbox(t, '');
  await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, { spawnModel: { requested: TERRA, launch: TERRA } });
  new HookServer(s.hive, () => null, () => ({})).handle(agyTick('dw-1', FLASH));
  assert.equal(entry(s.hive, 'dw-1').model, undefined);
});

// ─── Claude ─────────────────────────────────────────────────────────────────

const statusTick = (id, model) => ({ hook_event_name: 'Status', agent_id: id, model: { id: model } });

test('RESPAWN-KEEPS-SWITCH Claude (no picked model): a /model switch pins and the next spawn args carry it', async (t) => {
  const s = sandbox(t);
  const meta = { id: 'cl-1', name: 'Jim', provider: 'claude', cwd: s.home };
  const cfg = { defaultModel: 'claude-fable-5' };
  const first = P.resolveSpawnArgs(undefined, ['--permission-mode', 'bypassPermissions'], { fallback: cfg.defaultModel });
  await s.hive.ensureAgent(meta, { spawnModel: { requested: first.requested, launch: first.launch } });
  const server = new HookServer(s.hive, () => null, () => cfg);
  server.handle(statusTick('cl-1', 'claude-fable-5'));
  assert.equal(entry(s.hive, 'cl-1').model, undefined, 'the launch model is not a switch');
  s.type();
  server.handle(statusTick('cl-1', 'claude-opus-5-5[1m]'));
  assert.equal(entry(s.hive, 'cl-1').model, 'claude-opus-5-5[1m]');
  const r = P.resolveSpawnArgs(entry(s.hive, 'cl-1'), ['--permission-mode', 'bypassPermissions'], { fallback: cfg.defaultModel });
  assert.deepEqual(r.args, ['--permission-mode', 'bypassPermissions', '--model', 'claude-opus-5-5[1m]']);
});

test('RESPAWN-KEEPS-SWITCH Claude (picked model): the switch beats the unchanged pick; a new pick beats the switch', async (t) => {
  const s = sandbox(t);
  const meta = { id: 'cl-2', name: 'Pam', provider: 'claude', cwd: s.home };
  const cfg = { defaultModel: 'claude-fable-5' };
  await s.hive.ensureAgent(meta, { spawnModel: { requested: 'claude-sonnet-5', launch: 'claude-sonnet-5' } });
  const server = new HookServer(s.hive, () => null, () => cfg);
  server.handle(statusTick('cl-2', 'claude-sonnet-5'));
  assert.equal(entry(s.hive, 'cl-2').model, undefined, 'the picked model is not a pin');
  s.type();
  server.handle(statusTick('cl-2', 'claude-opus-5-5'));
  const r = P.resolveSpawnArgs(entry(s.hive, 'cl-2'), ['--model', 'claude-sonnet-5'], { fallback: cfg.defaultModel });
  assert.deepEqual(r.args, ['--model', 'claude-opus-5-5']);
  const r2 = P.resolveSpawnArgs(entry(s.hive, 'cl-2'), ['--model', 'claude-haiku-4-5-20251001'], { fallback: cfg.defaultModel });
  assert.deepEqual(r2.args, ['--model', 'claude-haiku-4-5-20251001']);
});

// ─── USER OR AUTO (god's correction to Jim's SHOULD-FIX) ─────────────────────

test('USER/AUTO: no human input since launch -> an AUTO pin, shown, logged, and NOT carried on respawn', async (t) => {
  const s = sandbox(t);
  const meta = { id: 'cl-3', name: 'Andy', provider: 'claude', cwd: s.home };
  const cfg = { defaultModel: 'claude-fable-5' };
  await s.hive.ensureAgent(meta, { spawnModel: { requested: 'claude-opus-5-5', launch: 'claude-opus-5-5' } });
  const server = new HookServer(s.hive, () => null, () => cfg);
  server.handle(statusTick('cl-3', 'claude-opus-5-5'));
  // The plan-limit fallback: the CLI reports Sonnet with nobody at the keyboard.
  server.handle(statusTick('cl-3', 'claude-sonnet-5'));
  const e = entry(s.hive, 'cl-3');
  assert.equal(e.model, 'claude-sonnet-5');
  assert.equal(e.modelPinSource, 'auto');
  assert.deepEqual(s.rows.filter((r) => r.kind === 'model-pinned'),
    [{ kind: 'model-pinned', agentId: 'cl-3', provider: 'claude', source: 'auto', from: 'claude-opus-5-5', to: 'claude-sonnet-5', requested: 'claude-opus-5-5', evidence: 'status-line' }]);

  const r = P.resolveSpawnArgs(e, ['--model', 'claude-opus-5-5'], { fallback: cfg.defaultModel });
  assert.deepEqual(r.args, ['--model', 'claude-opus-5-5'], 'the respawn runs the picker model');
  await s.hive.ensureAgent(meta, { spawnModel: { requested: r.requested, launch: r.launch } });
  assert.equal(entry(s.hive, 'cl-3').model, undefined);
  assert.equal(entry(s.hive, 'cl-3').modelPinSource, undefined);
  const dropped = s.rows.find((x) => x.kind === 'model-pin-dropped');
  assert.equal(dropped.reason, 'auto-not-kept');
  assert.equal(dropped.source, 'auto');
  assert.equal(dropped.pinned, 'claude-sonnet-5');
  assert.equal(dropped.requested, 'claude-opus-5-5');
});

test('USER/AUTO: a keystroke only BEFORE the previous observation does not make a later switch the user\'s', async (t) => {
  const s = sandbox(t, '');
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, { spawnModel: { requested: TERRA, launch: TERRA } });
  const server = codexServer(s.hive);
  s.type();
  await new Promise((r) => setTimeout(r, 10));
  rollout(inj.env.CODEX_HOME, SID, [turnContext(TERRA, Date.now() + 1000)]);
  server.handle(codexHook('dw-1', SID)); // an observation AFTER the keystroke
  await new Promise((r) => setTimeout(r, 5));
  rollout(inj.env.CODEX_HOME, SID, [turnContext(SOL, Date.now() + 2000)]);
  server.handle(codexHook('dw-1', SID));
  assert.equal(entry(s.hive, 'dw-1').modelPinSource, 'auto');
  assert.deepEqual(s.rows.find((x) => x.kind === 'model-pinned'),
    { kind: 'model-pinned', agentId: 'dw-1', provider: 'codex', source: 'auto', from: TERRA, to: SOL, requested: TERRA, evidence: 'rollout-turn_context', effort: 'medium', fromEffort: 'medium' }); // 1.1.79 M2: + effort columns
});

test('USER/AUTO: a user pin logs source user, is carried on respawn, and a clear logs too', async (t) => {
  const s = sandbox(t);
  const meta = { id: 'ag-1', name: 'Kelly', provider: 'antigravity', cwd: s.home };
  await s.hive.ensureAgent(meta, { spawnModel: { requested: PRO, launch: PRO } });
  const server = new HookServer(s.hive, () => null, () => ({}));
  s.type();
  server.handle(agyTick('ag-1', FLASH));
  assert.deepEqual(s.rows.find((x) => x.kind === 'model-pinned'),
    { kind: 'model-pinned', agentId: 'ag-1', provider: 'antigravity', source: 'user', from: PRO, to: FLASH, requested: PRO, evidence: 'agy-statusline' });
  const r = P.resolveSpawnArgs(entry(s.hive, 'ag-1'), ['--model', PRO]);
  assert.deepEqual(r.args, ['--model', FLASH], 'a user pin is carried');
  await s.hive.ensureAgent(meta, { spawnModel: { requested: r.requested, launch: r.launch } });
  assert.equal(entry(s.hive, 'ag-1').modelPinSource, 'user');
  s.type();
  server.handle(agyTick('ag-1', PRO));
  assert.equal(entry(s.hive, 'ag-1').model, undefined);
  const cleared = s.rows.find((x) => x.kind === 'model-pin-cleared');
  assert.equal(cleared.pinned, FLASH);
  assert.equal(cleared.to, PRO);
  assert.equal(cleared.requested, PRO);
  assert.equal(cleared.evidence, 'agy-statusline');
});

test('AGY live shapes: a model:null boot tick is ignored; a silent retired-id substitution is AUTO and not carried', async (t) => {
  const s = sandbox(t);
  const MED = 'Gemini 3.5 Flash (Medium)';
  const SUB = 'Gemini 3.8 Flash (High)';
  const meta = { id: 'ag-2', name: 'Kevin', provider: 'antigravity', cwd: s.home };
  await s.hive.ensureAgent(meta, { spawnModel: { requested: MED, launch: MED } });
  const server = new HookServer(s.hive, () => null, () => ({}));
  // The live capture's first ticks: model null, and no quota map at all.
  const boot = { hook_event_name: 'AgyStatusLine', agent_id: 'ag-2', read_at: Date.now(),
    agy_status: { version: '1.2.8', product: 'antigravity', agent_state: 'idle', model: null, session_id: 's', conversation_id: 'c', cwd: s.home } };
  server.handle(boot);
  assert.equal(entry(s.hive, 'ag-2').liveModel, undefined, 'null is never a baseline');
  assert.equal(entry(s.hive, 'ag-2').model, undefined, 'null is never a pin');
  // Every later tick reports the substituted id; nobody typed. No quota map either.
  const tick = { hook_event_name: 'AgyStatusLine', agent_id: 'ag-2', read_at: Date.now(),
    agy_status: { version: '1.2.8', product: 'antigravity', agent_state: 'idle', model: { id: SUB, display_name: SUB, effort: 'high' }, session_id: 's', conversation_id: 'c' } };
  server.handle(tick);
  server.handle(tick);
  const e = entry(s.hive, 'ag-2');
  assert.equal(e.model, SUB);
  assert.equal(e.modelPinSource, 'auto');
  assert.equal(s.rows.filter((x) => x.kind === 'model-pinned').length, 1, 'one row, not one per tick');
  const label = P.modelPinLabel(e, MED);
  assert.equal(label.model, SUB, 'the panel shows what really runs');
  assert.equal(label.marker, 'auto');
  const r = P.resolveSpawnArgs(e, ['--model', MED, '--dangerously-skip-permissions']);
  assert.deepEqual(r.args, ['--model', MED, '--dangerously-skip-permissions'], 'the respawn keeps the picked id');
  await s.hive.ensureAgent(meta, { spawnModel: { requested: r.requested, launch: r.launch } });
  assert.equal(entry(s.hive, 'ag-2').model, undefined);
  assert.equal(s.rows.find((x) => x.kind === 'model-pin-dropped').reason, 'auto-not-kept');
});

test('USER/AUTO: only HUMAN-origin pty writes move lastHumanInputAt (app writes never count)', () => {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const pm = new PtyManager();
  pm.sessions.set('pty-x', { id: 'pty-x', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true, humanInputGeneration: 0, incarnation: 1, proc: { write: () => {} } });
  pm.write('pty-x', 'inbox wake\r', 'PROGRAMMATIC');
  pm.write('pty-x', '\x1b[?997;1n', 'CONTROL');
  assert.equal(pm.lastHumanInputAt('pty-x'), undefined, 'app-injected and control writes are not a human');
  const before = Date.now();
  pm.write('pty-x', '/model\r', 'HUMAN');
  assert.ok(pm.lastHumanInputAt('pty-x') >= before);
});

test('G3 panel text: pinned (user) vs auto vs none', () => {
  const user = P.modelPinLabel({ model: SOL, modelPinSource: 'user', liveModel: SOL, launchModel: TERRA }, TERRA);
  assert.equal(user.model, SOL);
  assert.equal(user.marker, 'pinned');
  assert.equal(user.tooltip, `Runs ${SOL}. Pinned: switched by you in the terminal over the picked ${TERRA}; kept after a restart. Change the model picker to override.`);
  const auto = P.modelPinLabel({ model: 'claude-sonnet-5', modelPinSource: 'auto', liveModel: 'claude-sonnet-5' }, 'claude-opus-5-5');
  assert.equal(auto.marker, 'auto');
  assert.equal(auto.tooltip, 'Runs claude-sonnet-5. Auto: the CLI switched model on its own (e.g. a usage-limit fallback) over the picked claude-opus-5-5; not kept after a restart. If it was you, press keep.'); // 1.1.79 M3
  const none = P.modelPinLabel({ launchModel: TERRA }, TERRA);
  assert.equal(none.marker, '');
  assert.equal(none.tooltip, `Runs ${TERRA}.`);
  assert.equal(P.modelPinLabel(undefined).model, undefined);
});
