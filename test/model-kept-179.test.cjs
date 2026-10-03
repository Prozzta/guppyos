'use strict';
// AGENT-MODEL-NOT-KEPT (1.1.79, Jim; diagnosis hive/agents/jim-mtujpe28/CODEX-MODEL-SWITCH-AND-MODEL-NOT-KEPT.md):
//   M1  a person's in-terminal /model is classed 'user': the user/auto window is the previous
//       observation's OWN time (the turn_context stamp), not the clock of the hook that re-read it;
//   M2  the pin is {model, effort}: the effort is read from turn_context, pinned, written into the
//       per-spawn config.toml and the argv, and shown on the card;
//   M3  the app's picker writes requestedEffort (Codex `-c model_reasoning_effort=<e>`), and a
//       person can keep an 'auto' pin as theirs.
// Includes a replay of Dwight's 2026-10-02 switch (log 05:55:46.517 `model-pinned` source auto).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const toml = require('toml');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/codexAgentConfig.ts');
const P = loadTs('src/shared/modelPin.ts');
const { latestTurnContextModel } = loadTs('src/main/codexRolloutCapacity.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const R = loadTs('src/renderer/src/store/config.ts');

const TERRA = 'gpt-5.6-terra';
const LUNA = 'gpt-5.6-luna';
const SOL = 'gpt-5.6-sol';
const SID = '01a0f798-9d5e-7132-81a5-ae794a8c21e8';
const SEED = 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[notice]\nhide_full_access_warning = true\n';

/** A sandboxed hive whose clock the test drives (`clock.at`), with a human-input source. */
function sandbox(t, seed = SEED) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kept179-'));
  const saved = {};
  for (const k of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GEMINI_CLI_HOME']) saved[k] = process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.CODEX_HOME;
  process.env.GEMINI_CLI_HOME = path.join(home, '.gemini');
  const realNow = Date.now;
  const clock = { at: undefined };
  Date.now = () => (clock.at === undefined ? realNow() : clock.at);
  t.after(() => {
    Date.now = realNow;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  if (seed !== undefined) fs.writeFileSync(path.join(home, '.codex', 'config.toml'), seed);
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const keys = { at: undefined };
  hive.setHumanInputSource(() => keys.at);
  const rows = [];
  const append = hive.appendLog.bind(hive);
  hive.appendLog = (e) => { rows.push(e); append(e); };
  return { home, hive, rows, keys, clock };
}

const entry = (hive, id) => hive.registry().agents[id];
const T = (iso) => Date.parse(iso);
const turnContext = (model, effort, iso) => JSON.stringify({ timestamp: iso, type: 'turn_context', payload: { cwd: 'C:/x', model, ...(effort ? { effort } : {}) } });
const eventMsg = (type, iso) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type } });
function rollout(codexHome, lines) {
  const dir = path.join(codexHome, 'sessions', '2026', '10', '01');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `rollout-2026-10-01T15-12-49-${SID}.jsonl`), lines.map((l) => l + '\n').join(''));
}
const server = (hive) => new HookServer(hive, () => null, () => ({ defaultModel: 'claude-fable-5' }));
const hook = (id, event = 'PostToolUse') => ({ hook_event_name: event, agent_id: id, session_id: SID, ...(event === 'PostToolUse' ? { tool_name: 'shell', tool_input: { command: 'ls' } } : {}) });
const DWIGHT = { id: 'dwight-1', name: 'Dwight', provider: 'codex' };
const codexConfig = (inj) => fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');

/** Dwight's spawn as 1.1.79 main makes it: the renderer's persisted command, resolved. */
async function spawnDwight(s, args = ['--model', TERRA, '--dangerously-bypass-approvals-and-sandbox']) {
  const r = P.resolveSpawnArgs(entry(s.hive, DWIGHT.id), args, { effort: 'codex' });
  const inj = await s.hive.ensureAgent({ ...DWIGHT, cwd: s.home }, {
    spawnModel: { requested: r.requested, launch: r.launch, requestedEffort: r.requestedEffort, launchEffort: r.launchEffort, defaultEffort: s.hive.codexSeedEffort() }
  });
  return { r, inj };
}

// ─── M1: the replay ─────────────────────────────────────────────────────────

/** Dwight, 2026-10-02 (Codex rollout 01a0f798 + hive log): pty #6 runs terra on the seed's high.
 *  05:50:28.663 turn_context terra/high; the Human types /model mid-turn (Codex applies it at
 *  05:51:08.449); the turn ends 05:51:13.181 and the Stop hook (05:51:13.046 in the log) re-reads
 *  the SAME turn_context; 05:55:46.150 the app's inbox wake starts the next turn on luna/medium;
 *  a hook reads it at 05:55:46.517. 1.1.78 logged that `model-pinned` source "auto". */
async function replayDwight(t) {
  const s = sandbox(t);
  s.clock.at = T('2026-10-02T05:40:00.000Z');
  const { inj } = await spawnDwight(s);
  const home = inj.env.CODEX_HOME;
  const srv = server(s.hive);

  s.clock.at = T('2026-10-02T05:50:30.891Z');
  rollout(home, [eventMsg('task_started', '2026-10-02T05:50:28.602Z'), turnContext(TERRA, 'high', '2026-10-02T05:50:28.663Z')]);
  srv.handle(hook(DWIGHT.id));

  s.keys.at = T('2026-10-02T05:51:08.300Z'); // the Human's /model pick (human-origin pty input)
  s.clock.at = T('2026-10-02T05:51:13.046Z');
  rollout(home, [eventMsg('thread_settings_applied', '2026-10-02T05:51:08.449Z'), eventMsg('task_complete', '2026-10-02T05:51:13.181Z')]);
  srv.handle(hook(DWIGHT.id, 'Stop')); // newest turn_context is still 05:50:28 terra/high

  // 05:55:46: the app's own wake turn; no human key since 05:51:08.
  s.clock.at = T('2026-10-02T05:55:46.517Z');
  rollout(home, [eventMsg('task_started', '2026-10-02T05:55:46.120Z'), turnContext(LUNA, 'medium', '2026-10-02T05:55:46.150Z')]);
  srv.handle(hook(DWIGHT.id));
  return { s, inj, srv };
}

test('M1 REPLAY 2026-10-02 05:55:46: the Human\'s /model, re-read at Stop and landed on the app\'s wake turn, is USER (1.1.78: auto)', async (t) => {
  const { s } = await replayDwight(t);
  const e = entry(s.hive, DWIGHT.id);
  assert.equal(e.model, LUNA);
  assert.equal(e.modelPinSource, 'user', 'the person\'s switch must be kept');
  assert.equal(e.modelEffort, 'medium');
  assert.deepEqual(s.rows.filter((r) => r.kind === 'model-pinned'), [{
    kind: 'model-pinned', agentId: DWIGHT.id, provider: 'codex', source: 'user', from: TERRA, to: LUNA, requested: TERRA,
    evidence: 'rollout-turn_context', effort: 'medium', fromEffort: 'high'
  }]);
});

test('M1: an app-only switch (no human key after the previous turn started) stays AUTO, even though the person typed the PREVIOUS turn\'s prompt', async (t) => {
  const s = sandbox(t);
  s.clock.at = T('2026-10-02T07:00:00.000Z');
  const { inj } = await spawnDwight(s);
  const srv = server(s.hive);
  s.keys.at = T('2026-10-02T07:00:10.000Z'); // the person sends a prompt...
  s.clock.at = T('2026-10-02T07:00:11.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'high', '2026-10-02T07:00:10.500Z')]); // ...which starts this turn
  srv.handle(hook(DWIGHT.id, 'UserPromptSubmit'));
  // Later the app's probe turn runs on another model, nobody at the keyboard.
  s.clock.at = T('2026-10-02T07:05:00.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(SOL, 'high', '2026-10-02T07:04:59.000Z')]);
  srv.handle(hook(DWIGHT.id));
  assert.equal(entry(s.hive, DWIGHT.id).modelPinSource, 'auto');
});

test('M1: a stamp in the future is capped at the hook\'s clock (a keystroke after the read still counts)', async (t) => {
  const s = sandbox(t);
  s.clock.at = T('2026-10-02T08:00:00.000Z');
  const { inj } = await spawnDwight(s);
  const srv = server(s.hive);
  s.clock.at = T('2026-10-02T08:00:05.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'high', '2026-10-02T08:00:09.000Z')]); // skewed 4 s ahead
  srv.handle(hook(DWIGHT.id));
  s.keys.at = T('2026-10-02T08:00:06.000Z');
  s.clock.at = T('2026-10-02T08:00:20.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(SOL, 'high', '2026-10-02T08:00:19.000Z')]);
  srv.handle(hook(DWIGHT.id));
  assert.equal(entry(s.hive, DWIGHT.id).modelPinSource, 'user');
});

test('M1: the window marker never moves back (an older stamp read after a newer one)', async (t) => {
  const s = sandbox(t);
  s.clock.at = T('2026-10-02T08:30:00.000Z');
  await spawnDwight(s);
  s.clock.at = T('2026-10-02T08:31:00.000Z');
  s.hive.observeLiveModel(DWIGHT.id, 'codex', TERRA, { observedAt: T('2026-10-02T08:30:50.000Z'), effort: 'high' });
  s.hive.observeLiveModel(DWIGHT.id, 'codex', TERRA, { observedAt: T('2026-10-02T08:30:10.000Z'), effort: 'high' });
  s.keys.at = T('2026-10-02T08:30:30.000Z'); // after the older stamp, before the newer one
  s.clock.at = T('2026-10-02T08:32:00.000Z');
  s.hive.observeLiveModel(DWIGHT.id, 'codex', SOL, { observedAt: T('2026-10-02T08:31:55.000Z'), effort: 'high' });
  assert.equal(entry(s.hive, DWIGHT.id).modelPinSource, 'auto');
});

// ─── M2: the respawn keeps model AND effort ─────────────────────────────────

test('M2 RESPAWN after the replay: the argv and our config.toml carry luna + medium; the seed file is untouched', async (t) => {
  const { s, srv } = await replayDwight(t);
  s.clock.at = T('2026-10-02T09:00:00.000Z');
  const { r, inj } = await spawnDwight(s); // the renderer's persisted command still says terra, no effort
  assert.deepEqual(r.args, ['--model', LUNA, '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=medium']);
  assert.equal(r.requestedEffort, undefined);
  assert.equal(r.launchEffort, 'medium');
  const cfg = toml.parse(codexConfig(inj));
  assert.equal(cfg.model, LUNA);
  assert.equal(cfg.model_reasoning_effort, 'medium', 'not the seed\'s high');
  assert.equal(cfg.notice.hide_full_access_warning, true, 'the seed\'s other settings are kept');
  const e = entry(s.hive, DWIGHT.id);
  assert.equal(e.model, LUNA);
  assert.equal(e.modelEffort, 'medium');
  assert.equal(e.launchEffort, 'medium');
  assert.equal(e.defaultEffort, 'high');
  assert.equal(fs.readFileSync(path.join(s.home, '.codex', 'config.toml'), 'utf8'), SEED, 'the global file is never written');
  // The new process reports what it was given: no switch, no new row.
  const before = s.rows.length;
  s.clock.at = T('2026-10-02T09:01:00.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(LUNA, 'medium', '2026-10-02T09:00:59.000Z')]);
  srv.handle(hook(DWIGHT.id));
  assert.equal(entry(s.hive, DWIGHT.id).model, LUNA);
  assert.equal(s.rows.slice(before).filter((x) => x.kind.startsWith('model-pin')).length, 0);
  // The card says both.
  assert.equal(P.modelPinLabel(entry(s.hive, DWIGHT.id), TERRA).model, `${LUNA} · medium`);
});

test('M2: an effort-only /model switch pins (user) and comes back after a restart; a return to the default clears it', async (t) => {
  const s = sandbox(t);
  s.clock.at = T('2026-10-02T10:00:00.000Z');
  const { inj } = await spawnDwight(s);
  const srv = server(s.hive);
  s.clock.at = T('2026-10-02T10:00:05.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'high', '2026-10-02T10:00:04.000Z')]);
  srv.handle(hook(DWIGHT.id));
  assert.equal(entry(s.hive, DWIGHT.id).model, undefined, 'the seed effort is not a switch');
  s.keys.at = T('2026-10-02T10:01:00.000Z');
  s.clock.at = T('2026-10-02T10:02:00.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'low', '2026-10-02T10:01:30.000Z')]);
  srv.handle(hook(DWIGHT.id));
  let e = entry(s.hive, DWIGHT.id);
  assert.equal(e.model, TERRA);
  assert.equal(e.modelEffort, 'low');
  assert.equal(e.modelPinSource, 'user');

  s.clock.at = T('2026-10-02T11:00:00.000Z');
  const { r, inj: inj2 } = await spawnDwight(s);
  assert.deepEqual(r.args, ['--model', TERRA, '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=low']);
  assert.equal(toml.parse(codexConfig(inj2)).model_reasoning_effort, 'low');

  s.keys.at = T('2026-10-02T11:01:00.000Z');
  s.clock.at = T('2026-10-02T11:02:00.000Z');
  rollout(inj2.env.CODEX_HOME, [turnContext(TERRA, 'high', '2026-10-02T11:01:30.000Z')]);
  srv.handle(hook(DWIGHT.id));
  e = entry(s.hive, DWIGHT.id);
  assert.equal(e.model, undefined, 'back on the picker model at the default effort: no pin');
  assert.equal(e.modelEffort, undefined);
  assert.ok(s.rows.some((x) => x.kind === 'model-pin-cleared' && x.pinned === TERRA));
});

test('M2: with no seed effort, the first reported effort is the default (not a switch)', async (t) => {
  const s = sandbox(t, 'model = "gpt-6-astra"\n');
  s.clock.at = T('2026-10-02T12:00:00.000Z');
  const { inj } = await spawnDwight(s);
  assert.equal(entry(s.hive, DWIGHT.id).defaultEffort, undefined);
  assert.equal(/model_reasoning_effort/.test(codexConfig(inj)), false, 'nothing to write: Codex keeps its own default');
  const srv = server(s.hive);
  s.clock.at = T('2026-10-02T12:00:05.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'medium', '2026-10-02T12:00:04.000Z')]);
  srv.handle(hook(DWIGHT.id));
  const e = entry(s.hive, DWIGHT.id);
  assert.equal(e.model, undefined);
  assert.equal(e.defaultEffort, 'medium');
  assert.equal(e.liveEffort, 'medium');
});

test('M2 (Creed B1): a /model effort switch BEFORE the first turn, on the seed\'s effort, pins and comes back after a restart', async (t) => {
  const s = sandbox(t); // seed effort high, nothing picked
  s.clock.at = T('2026-10-02T16:00:00.000Z');
  const { inj } = await spawnDwight(s);
  assert.equal(entry(s.hive, DWIGHT.id).defaultEffort, 'high');
  assert.equal(entry(s.hive, DWIGHT.id).launchEffort, undefined);
  const srv = server(s.hive);
  s.keys.at = T('2026-10-02T16:00:20.000Z'); // /model terra medium on the first screen
  s.clock.at = T('2026-10-02T16:00:40.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'medium', '2026-10-02T16:00:35.000Z')]); // the first turn
  srv.handle(hook(DWIGHT.id));
  const e = entry(s.hive, DWIGHT.id);
  assert.equal(e.model, TERRA);
  assert.equal(e.modelEffort, 'medium');
  assert.equal(e.modelPinSource, 'user');
  s.clock.at = T('2026-10-02T17:00:00.000Z');
  const { r } = await spawnDwight(s);
  assert.deepEqual(r.args, ['--model', TERRA, '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=medium']);
});

test('M2 (Creed B1): launched with no --model, an effort switch before the first turn still pins; the seed effort itself is not a switch but is shown', async (t) => {
  const s = sandbox(t);
  s.clock.at = T('2026-10-02T18:00:00.000Z');
  const { inj } = await spawnDwight(s, ['--dangerously-bypass-approvals-and-sandbox']);
  const srv = server(s.hive);
  s.keys.at = T('2026-10-02T18:00:20.000Z');
  s.clock.at = T('2026-10-02T18:00:40.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'low', '2026-10-02T18:00:35.000Z')]);
  srv.handle(hook(DWIGHT.id));
  assert.equal(entry(s.hive, DWIGHT.id).modelEffort, 'low');
  assert.equal(entry(s.hive, DWIGHT.id).modelPinSource, 'user');

  const s2 = sandbox(t);
  s2.clock.at = T('2026-10-02T19:00:00.000Z');
  const { inj: inj2 } = await spawnDwight(s2);
  s2.clock.at = T('2026-10-02T19:00:40.000Z');
  rollout(inj2.env.CODEX_HOME, [turnContext(TERRA, 'high', '2026-10-02T19:00:35.000Z')]);
  server(s2.hive).handle(hook(DWIGHT.id));
  const e2 = entry(s2.hive, DWIGHT.id);
  assert.equal(e2.model, undefined, 'the seed effort is no switch');
  assert.equal(e2.liveEffort, 'high');
  assert.equal(P.modelPinLabel(e2, TERRA).model, `${TERRA} · high`);
});

// ─── M3: the picker and "keep" ──────────────────────────────────────────────

test('M3: the picker\'s effort is the request: written to argv by the renderer, read back, in our config; it beats an older pin', async (t) => {
  assert.equal(R.buildSpawnCommand({ defaultCommand: 'claude', autoMode: true }, TERRA, 'codex', 'XHigh'),
    `codex --model ${TERRA} -c model_reasoning_effort=xhigh --dangerously-bypass-approvals-and-sandbox`);
  assert.equal(R.buildSpawnCommand({ defaultCommand: 'claude', autoMode: false }, TERRA, 'codex', 'high"\nx=1'), `codex --model ${TERRA}`, 'junk is never written');
  assert.equal(R.buildSpawnCommand({ defaultCommand: 'claude', autoMode: false }, 'claude-opus-5-5', 'claude', 'high'), 'claude --model claude-opus-5-5', 'Codex only');

  const { s } = await replayDwight(t); // a user pin luna/medium against terra + no effort
  s.clock.at = T('2026-10-02T13:00:00.000Z');
  const { r, inj } = await spawnDwight(s, ['--model', TERRA, '-c', 'model_reasoning_effort=xhigh']);
  assert.equal(r.requestedEffort, 'xhigh');
  assert.deepEqual(r.args, ['--model', TERRA, '-c', 'model_reasoning_effort=xhigh'], 'the new pick wins');
  const e = entry(s.hive, DWIGHT.id);
  assert.equal(e.model, undefined, 'the pin is dropped');
  assert.equal(e.modelEffort, undefined, 'with its effort');
  assert.equal(e.modelPinnedFromEffort, undefined);
  assert.equal(e.requestedEffort, 'xhigh');
  assert.equal(toml.parse(codexConfig(inj)).model_reasoning_effort, 'xhigh');
  const dropped = s.rows.find((x) => x.kind === 'model-pin-dropped');
  assert.equal(dropped.reason, 'picker-changed');
  assert.equal(dropped.pinnedEffort, 'medium');
  assert.equal(dropped.requestedEffort, 'xhigh');
});

test('M3 keep: an AUTO pin kept by the person is carried on respawn; nothing else can be kept', async (t) => {
  const s = sandbox(t);
  s.clock.at = T('2026-10-02T14:00:00.000Z');
  const { inj } = await spawnDwight(s);
  const srv = server(s.hive);
  s.clock.at = T('2026-10-02T14:00:05.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(TERRA, 'high', '2026-10-02T14:00:04.000Z')]);
  srv.handle(hook(DWIGHT.id));
  s.clock.at = T('2026-10-02T14:05:00.000Z');
  rollout(inj.env.CODEX_HOME, [turnContext(LUNA, 'medium', '2026-10-02T14:04:59.000Z')]);
  srv.handle(hook(DWIGHT.id));
  assert.equal(entry(s.hive, DWIGHT.id).modelPinSource, 'auto');
  assert.equal(P.modelPinLabel(entry(s.hive, DWIGHT.id), TERRA).marker, 'auto');

  assert.equal(s.hive.keepModelPin(DWIGHT.id), true);
  assert.equal(entry(s.hive, DWIGHT.id).modelPinSource, 'user');
  assert.deepEqual(s.rows.find((x) => x.kind === 'model-pin-kept'), { kind: 'model-pin-kept', agentId: DWIGHT.id, pinned: LUNA, effort: 'medium', requested: TERRA });
  assert.equal(s.hive.keepModelPin(DWIGHT.id), false, 'already the person\'s');
  assert.equal(s.hive.keepModelPin('nobody'), false);

  s.clock.at = T('2026-10-02T15:00:00.000Z');
  const { r } = await spawnDwight(s);
  assert.deepEqual(r.args, ['--model', LUNA, '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=medium']);
  assert.equal(entry(s.hive, DWIGHT.id).model, LUNA);
});

test('M3 keep is wired: main exposes it to the renderer only as a person\'s click on an auto pin', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(index, /ipcMain\.handle\('hive:keepModelPin', \(_evt, agentId: unknown\) =>\s+typeof agentId === 'string' && agentId \? hive\.keepModelPin\(agentId\) : false\);/);
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');
  assert.match(preload, /hiveKeepModelPin: \(agentId: string\): Promise<boolean> => ipcRenderer\.invoke\('hive:keepModelPin', agentId\)/);
  const panel = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/AgentDetailPanel.tsx'), 'utf8');
  assert.match(panel, /runModel\.marker === 'auto' && \(\s*<button[\s\S]{0,120}data-testid="agent-keep-model"\s+onClick=\{keepModel\}/);
  // Provider-specific spawn effort options are preserved for both Codex and Claude.
  assert.match(index, /\.\.\.\(provider === 'codex' \? \{ effort: 'codex' as const \} : provider === 'claude' \? \{ effort: 'claude' as const \} : \{\}\)/);
  assert.match(index, /provider === 'codex' \? \{ requestedEffort: r\.requestedEffort, launchEffort: r\.launchEffort, defaultEffort: hive\.codexSeedEffort\(\) \}\s*: provider === 'claude' \? \{ requestedEffort: r\.requestedEffort, launchEffort: r\.launchEffort, defaultEffort: hive\.registry\(\)\.agents\[opts\.hive\.id\]\?\.defaultEffort \}/);
});

// ─── the pieces ─────────────────────────────────────────────────────────────

test('pieces: turn_context effort, the argv effort, our config line, the seed reader', () => {
  assert.deepEqual(latestTurnContextModel(turnContext(LUNA, 'medium', '2026-10-02T05:55:46.150Z')), { model: LUNA, observedAt: T('2026-10-02T05:55:46.150Z'), effort: 'medium' });
  assert.equal(latestTurnContextModel(turnContext(LUNA, null, '2026-10-02T05:55:46.150Z')).effort, null);

  assert.equal(P.codexEffortValue(['-c', 'model_reasoning_effort=high', '--config', 'model_reasoning_effort="low"']), 'low', 'the last one wins; quotes are TOML');
  assert.equal(P.codexEffortValue(['--config=model_reasoning_effort=xhigh']), 'xhigh');
  assert.equal(P.codexEffortValue(['-c', 'check_for_update_on_startup=false']), undefined);
  assert.deepEqual(P.withCodexEffort(['-c', 'model_reasoning_effort=high', 'x'], 'low'), ['-c', 'model_reasoning_effort=low', 'x']);
  assert.deepEqual(P.withCodexEffort(['x'], 'low'), ['x', '-c', 'model_reasoning_effort=low']);
  assert.equal(P.normEffort(' High '), 'high');
  assert.equal(P.normEffort('high"\nx=1'), undefined);

  const out = C.setCodexReasoningEffort(SEED, 'medium');
  assert.equal(toml.parse(out).model_reasoning_effort, 'medium');
  assert.equal((out.match(/model_reasoning_effort/g) || []).length, 1, 'the seed line is replaced, not duplicated');
  assert.equal(C.setCodexReasoningEffort(SEED, undefined), SEED);
  assert.equal(C.setCodexReasoningEffort(SEED, 'x" = 1'), SEED, 'junk is never written');
  const profile = '[profiles.fast]\nmodel_reasoning_effort = "low"\n';
  assert.equal(toml.parse(C.setCodexReasoningEffort(profile, 'high')).profiles.fast.model_reasoning_effort, 'low', 'a profile keeps its own');
  assert.equal(C.codexTopLevelString(SEED, 'model_reasoning_effort'), 'high');
  assert.equal(C.codexTopLevelString(profile, 'model_reasoning_effort'), undefined, 'a table key is not top-level');
});

test('compat: a pin from before 1.1.79 (no effort fields) still applies, and adds no effort', () => {
  const old = { model: SOL, modelPinnedFrom: TERRA, modelPinSource: 'user' };
  const r = P.resolveSpawnArgs(old, ['--model', TERRA], { effort: 'codex' });
  assert.deepEqual(r.args, ['--model', SOL]);
  assert.equal(r.launchEffort, undefined);
  assert.equal(P.modelPinLabel({ ...old, liveModel: SOL }).model, SOL, 'no effort known: the card shows the model alone');
});
