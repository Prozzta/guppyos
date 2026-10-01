'use strict';

/**
 * CARD-IDLE-WHILE-WORKING (1.1.78): the Human saw Andy's card read "idle" while he worked. During
 * a long tool call no hook fires (and the PTY can go quiet, which the renderer's quiescence
 * fallback reads as turn-done), so the hook-driven status and the "active 9m ago" age said idle,
 * while the zero-token liveness classification correctly said BUSY_PROGRESSING.
 *
 * Every idle/working display now takes busy-or-not from the liveness classification
 * (shared/activityView.ts): the player card and roster row (AgentCard), the agent panel, the
 * Command Center badge, the office floor's avatars and the LIVE ROSTER line god reads. The tool in
 * progress is shown with its duration. Delivery gating is untouched (it reads the agent's own
 * status; main owns submission).
 *
 * Mutants that must die: MUTANT CENSUS below.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

// hooks.ts pulls Notification from electron; outside Electron seed the surface it touches.
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const ROOT = path.resolve(__dirname, '..');
const ACT = loadTs('src/shared/activityView.ts');
const HOOKS = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const NOW = Date.parse('2026-10-01T19:40:00.000Z');
const MIN = 60_000;
const lv = (classification, extra = {}) => ({
  v: 1, agentId: 'andy', incarnation: 3, lifecycle: 'LIVE', classification, classifiedSince: NOW - 9 * MIN,
  reason: classification === 'BUSY_PROGRESSING' ? 'turn-started' : 'quiescent', evidence: { sampledAt: NOW }, ...extra
});

const K = {};

// ─── The named case: a long tool call with no hooks ─────────────────────────────────────

K.longToolShowsWorking = (A = ACT) => {
  // Nine minutes into a tool call: no hook since PreToolUse, the PTY quiet, so the renderer's
  // quiescence fallback has already flipped the hook-driven status to idle.
  const shown = A.activityStatus('idle', lv('BUSY_PROGRESSING'));
  assert.equal(shown, 'working', 'A LONG-RUNNING TOOL CALL WITH NO HOOKS SHOWS AS WORKING');
  assert.equal(A.runningToolText(shown, { name: 'Bash', since: NOW - 9 * MIN }, NOW), 'using Bash for 9m', 'and names the tool and how long it has run');
};
test('a long-running tool call with no hooks shows as WORKING (liveness BUSY_PROGRESSING), with the tool and its duration', () => K.longToolShowsWorking());

K.idleFromLiveness = (A = ACT) => {
  assert.equal(A.activityStatus('working', lv('IDLE')), 'idle', 'A LIVE IDLE RECORD SHOWS IDLE even if no turn-end hook arrived');
  assert.equal(A.activityStatus('success', lv('BUSY_PROGRESSING')), 'working', 'liveness is the newer fact in the Stop race');
  assert.equal(A.activityStatus('thinking', lv('BUSY_PROGRESSING')), 'thinking', 'thinking is a kind of working: kept');
};
test('busy-or-not follows the classification both ways', () => K.idleFromLiveness());

K.successStaysSuccess = (A = ACT) => {
  assert.equal(A.activityStatus('success', lv('IDLE')), 'success', 'SUCCESS + IDLE STAYS SUCCESS (the floor\'s glyph, the card\'s "done")');
};
test('Andy S1: success + IDLE stays success', () => K.successStaysSuccess());

K.richStatusKept = (A = ACT) => {
  for (const s of ['blocked', 'waiting', 'compacting', 'looping', 'typing', 'ghost']) {
    assert.equal(A.activityStatus(s, lv('BUSY_PROGRESSING')), s, `A RICHER STATUS IS KEPT: ${s}`);
    assert.equal(A.activityStatus(s, lv('IDLE')), s, `A RICHER STATUS IS KEPT: ${s}`);
  }
};
test('a richer status (needs you, waiting, compacting, the breaker pin, a draft, gone) is a different fact and is kept', () => K.richStatusKept());

test('no record, a non-LIVE record or an unclassified state leaves the hook-driven status alone', () => {
  assert.equal(ACT.activityStatus('idle', undefined), 'idle');
  assert.equal(ACT.activityStatus('idle', lv('BUSY_PROGRESSING', { lifecycle: 'ARCHIVED' })), 'idle');
  for (const c of ['SUSPECT', 'STUCK_WAKE', 'CRASHED', 'EXITED', 'UNKNOWN']) assert.equal(ACT.activityStatus('working', lv(c)), 'working', c);
  assert.equal(ACT.runningToolText('idle', { name: 'Bash', since: NOW }, NOW), null, 'no tool text on an idle display');
  assert.equal(ACT.runningToolText('working', undefined, NOW), null);
});

// ─── The LIVE ROSTER line god reads ─────────────────────────────────────────────────────

K.rosterSaysWorking = (A = ACT) => {
  assert.equal(A.rosterActivity(lv('BUSY_PROGRESSING'), NOW, { name: 'Bash', forSec: 540 }), 'WORKING 9m (running Bash 9m)', 'THE ROSTER SAYS WORKING, with the tool');
  assert.equal(A.rosterActivity(lv('BUSY_PROGRESSING'), NOW, null), 'WORKING 9m');
  assert.equal(A.rosterActivity(lv('IDLE'), NOW), 'idle 9m');
  assert.equal(A.rosterActivity(undefined, NOW), null);
  assert.equal(A.rosterActivity(lv('IDLE', { lifecycle: 'ARCHIVED' }), NOW), null);
};
test('the LIVE ROSTER word comes from the liveness record', () => K.rosterSaysWorking());

test('the injected LIVE ROSTER line says WORKING for an agent 9 minutes into a tool call ("active 9m ago")', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-card-idle-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'andy', name: 'Andy', provider: 'claude', cwd: home });
  const since = Date.now() - 9 * MIN;
  hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [{ id: 'andy', name: 'Andy', role: 'agent', lastActiveSecAgo: 540, runningTool: { name: 'Bash', forSec: 540 } }],
    liveness: [{ ...lv('BUSY_PROGRESSING'), classifiedSince: since, evidence: { sampledAt: Date.now() } }]
  });
  const line = hive.rosterContext();
  assert.match(line, /andy "Andy" \(agent, WORKING 9m \(running Bash 9m\), active 9m ago/);
});

// ─── The running tool, as main sees it ──────────────────────────────────────────────────

function hookServer(Hook = HOOKS.HookServer) {
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  return new Hook(hive, () => null, () => ({}), control, undefined, undefined, () => {});
}
K.runningToolTracked = (Hook = HOOKS.HookServer) => {
  const s = hookServer(Hook);
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash' });
  assert.equal(s.runningTool('andy')?.name, 'Bash', 'THE TOOL IN PROGRESS IS KNOWN from its PreToolUse');
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', provider_agent_id: 'sub-1', tool_name: 'Grep' });
  assert.equal(s.runningTool('andy')?.name, 'Bash', 'a subagent\'s tool is not the agent\'s');
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', tool_name: 'Bash' });
  assert.equal(s.runningTool('andy'), undefined, 'THE TOOL ENDS AT ITS PostToolUse');
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash' });
  s.handle({ hook_event_name: 'Stop', agent_id: 'andy' });
  assert.equal(s.runningTool('andy'), undefined, 'or at the turn\'s end');
};
test('main knows each agent\'s tool in progress from its own hooks', () => K.runningToolTracked());

K.parallelToolsKept = (A = ACT, Hook = HOOKS.HookServer) => {
  let l = A.toolStarted(undefined, 'Bash', NOW - 9 * MIN);
  l = A.toolStarted(l, 'Grep', NOW - MIN);
  l = A.toolEnded(l, 'Grep');
  assert.deepEqual(l.map((t) => t.name), ['Bash'], 'A PARALLEL TOOL ENDING LEAVES THE OTHER RUNNING');
  assert.deepEqual(A.toolEnded(l, 'Bash'), []);
  assert.deepEqual(A.toolEnded([{ name: 'Bash', since: 1 }, { name: 'Bash', since: 2 }], 'Bash').map((t) => t.since), [2], 'one of that name, the oldest');
  const s = hookServer(Hook);
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash' });
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Grep' });
  assert.equal(s.runningTool('andy')?.name, 'Bash', 'Jim T1: THE OLDEST TOOL STILL RUNNING IS SHOWN');
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', tool_name: 'Grep' });
  assert.equal(s.runningTool('andy')?.name, 'Bash', 'A PARALLEL TOOL ENDING LEAVES THE OTHER RUNNING (main)');
};
test('Jim N1: a parallel tool\'s PostToolUse ends that tool only', () => K.parallelToolsKept());

K.oldestToolShown = (Hook = HOOKS.HookServer) => {
  const s = hookServer(Hook);
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash' });
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Grep' });
  assert.equal(s.runningTool('andy')?.name, 'Bash', 'Jim T1: THE OLDEST TOOL STILL RUNNING IS SHOWN');
};
test('Jim T1: with parallel tools, main publishes the oldest still running', () => K.oldestToolShown());

// ─── Wiring: every display reads it ─────────────────────────────────────────────────────

test('wiring: the store holds liveness + the running tool (never persisted); useHive feeds both', () => {
  const store = readSource('src/renderer/src/store/store.ts');
  assert.match(store, /applyLiveness: \(rec\) => set\(\(s\) => \{\s*const liveness = applyLivenessUpdate\(s\.liveness, rec\);/);
  assert.match(store, /'contextTokens', 'contextLimit', 'lastPrompt', 'runningTools'\s*\]\);/, 'run-state: a running-tool patch is no durable write');
  assert.match(store, /seedPrompt, runningTools, \.\.\.rest \}\)/, 'and never persisted');
  const hive = readSource('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /if \(e\.event === 'PreToolUse' && e\.tool\) updateAgent\(e\.agentId, \{ runningTools: toolStarted\(self\.runningTools, e\.tool, Date\.now\(\)\) \}\);/);
  assert.match(hive, /else if \(e\.event === 'PostToolUse' \|\| e\.event === 'PostToolUseFailure'\) updateAgent\(e\.agentId, \{ runningTools: toolEnded\(self\.runningTools, e\.tool\) \}\);/, 'Jim N1: one tool ends, not all');
  assert.match(hive, /else if \(e\.event === 'UserPromptSubmit' \|\| e\.event === 'SessionStart' \|\| e\.event === 'PreCompact'\s*\|\| \(\(e\.event === 'Stop' \|\| e\.event === 'SubagentStop'\) && !e\.blocked\)\) updateAgent\(e\.agentId, \{ runningTools: undefined \}\);/, 'the turn ends: none left (Andy N1: the same ends as main)');
  assert.match(hive, /window\.cth\.livenessSnapshot\(\)[\s\S]{0,200}applyLiveness\(r\)/);
  assert.match(hive, /window\.cth\.onLivenessChange\(\(rec\) => \{ if \(rec && rec\.agentId\) useStore\.getState\(\)\.applyLiveness\(rec\); \}\);/);
});

test('wiring: the card, the roster row, the panel, the Command Center badge and the office floor all show the liveness answer', () => {
  const card = readSource('src/renderer/src/components/AgentCard.tsx');
  assert.match(card, /const \{ status, toolText \} = useActivity\(agentId, hookStatus\);/);
  assert.match(card, /const infoLine = held\.impactText \?\? toolText \?\?/);
  const strip = readSource('src/renderer/src/components/AgentStrip.tsx');
  assert.match(strip, /<AgentCard[\s\S]{0,200}agentId=\{a\.id\}[\s\S]{0,200}status=\{a\.status\}/, 'the roster renders AgentCard, which resolves the shown status');
  const panel = readSource('src/renderer/src/components/AgentDetailPanel.tsx');
  assert.match(panel, /const activity = useActivity\(agent\.id, agent\.status\);/);
  assert.match(panel, /<PixelBadge status=\{activity\.status\} \/>/);
  const badge = readSource('src/renderer/src/components/AgentImpactBadge.tsx');
  assert.match(badge, /const view = impactBadge\(activity\.status, useAgentImpact\(agentId\)\);/);
  const floor = readSource('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(floor, /const status = activityStatus\(agent\.status, useStore\.getState\(\)\.liveness\[agent\.id\]\);/);
  assert.match(floor, /const applyState = \(hookAgent: Agent, rt: Runtime, force = false\) => \{\s*\/\/[^\n]*\n\s*const agent = shownAgent\(hookAgent\);/);
  assert.match(floor, /return a \? shownAgent\(a\) : undefined;/);
  assert.match(floor, /if \(s\.agents !== prev\.agents \|\| s\.liveness !== prev\.liveness\) syncAgents\(\);/, 'a liveness change repaints the floor');
  const full = readSource('src/renderer/src/components/FullscreenTerminal.tsx');
  assert.match(full, /const activity = useActivity\(agent\.id, agent\.status\);/, 'Jim C1: the fullscreen row too');
  assert.match(full, /<PixelBadge status=\{typing \? 'typing' : activity\.status\} \/>/);
  const composer = readSource('src/renderer/src/components/MessageQueueComposer.tsx');
  assert.match(composer, /const shownIdle = useActivity\(agent\.id, agent\.status\)\.status === 'idle';/, 'Jim N2: the composer words the shown status');
  assert.match(composer, /placeholder=\{shownIdle \?/);
  assert.match(composer, /composerStatus\(\{ agentName: agent\.name, queueLength: queue\.length, idle: shownIdle,/);
  assert.match(composer, /const block = useTerminalBlock\(agent\.ptyId, queue\.length > 0 && idle\);/, 'the poll the drain relies on keeps the hook status');
  assert.match(composer, /const idle = agent\.status === 'idle';/, 'Jim T2: the raw hook status, for the drain\'s poll');
  const hook = readSource('src/renderer/src/components/useActivity.ts');
  assert.match(hook, /\?\.runningTools\?\.\[0\] : undefined\)\);/, 'Jim T1: the card shows the oldest tool still running');
  assert.match(hook, /const shown = activityStatus\(status, rec\) as StatusKind;/);
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /runningTool: runningToolFor\(id, now\),/, 'fleet.json carries the tool in progress');
});

test('display only: delivery still gates on the agent\'s own status', () => {
  const hive = readSource('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /if \(!canDeliverToAgent\(target\.status, ptyQuietMs\(target\.ptyId, now\), QUIESCE_IDLE_MS\)\) \{/);
  assert.doesNotMatch(hive, /canDeliverToAgent\(activityStatus/);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────

const MUTANT_DIR = path.join(__dirname, '.mutants-card-idle');
function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  // The copy's relative imports resolve back to the real files.
  text = text.replace(/from '(\.\.?\/[^']+)'/g, (_, spec) => `from '${path.relative(MUTANT_DIR, path.join(ROOT, path.dirname(rel), spec)).replace(/\\/g, '/')}'`);
  const file = path.join(MUTANT_DIR, `${tag}.ts`);
  fs.writeFileSync(file, text, 'utf8');
  return loadTs(path.relative(ROOT, file));
}

const MUTANTS = [
  { name: 'the displays ignore liveness (as shipped: hook status only)', file: 'src/shared/activityView.ts', real: ACT, pick: (m) => m,
    edits: [["  if (rec.classification === 'BUSY_PROGRESSING') return status === 'thinking' ? status : 'working';\n", '']],
    killer: 'longToolShowsWorking', dies: /A LONG-RUNNING TOOL CALL WITH NO HOOKS SHOWS AS WORKING/ },
  { name: 'a LIVE IDLE record does not show idle', file: 'src/shared/activityView.ts', real: ACT, pick: (m) => m,
    edits: [["  if (rec.classification === 'IDLE') return status === 'success' ? status : 'idle';\n", '']],
    killer: 'idleFromLiveness', dies: /A LIVE IDLE RECORD SHOWS IDLE/ },
  { name: 'Andy S1: success erased by an IDLE record', file: 'src/shared/activityView.ts', real: ACT, pick: (m) => m,
    edits: [["  if (rec.classification === 'IDLE') return status === 'success' ? status : 'idle';", "  if (rec.classification === 'IDLE') return 'idle';"]],
    killer: 'successStaysSuccess', dies: /SUCCESS \+ IDLE STAYS SUCCESS/ },
  { name: 'liveness overrides a richer status', file: 'src/shared/activityView.ts', real: ACT, pick: (m) => m,
    edits: [["  if (!rec || rec.lifecycle !== 'LIVE' || !BUSY_OR_NOT.has(status)) return status;", "  if (!rec || rec.lifecycle !== 'LIVE') return status;"]],
    killer: 'richStatusKept', dies: /A RICHER STATUS IS KEPT/ },
  { name: 'the roster ignores liveness', file: 'src/shared/activityView.ts', real: ACT, pick: (m) => m,
    edits: [["  if (!rec || rec.lifecycle !== 'LIVE') return null;\n  const age", "  return null;\n  const age"]],
    killer: 'rosterSaysWorking', dies: /THE ROSTER SAYS WORKING/ },
  { name: 'main never records the tool in progress', file: 'src/main/hooks.ts', real: HOOKS, pick: (m) => m.HookServer,
    edits: [["    if (agentId && !fromSubagent) this.noteRunningTool(agentId, event, p);\n", '']],
    killer: 'runningToolTracked', dies: /THE TOOL IN PROGRESS IS KNOWN/ },
  { name: 'the tool never ends at its PostToolUse', file: 'src/main/hooks.ts', real: HOOKS, pick: (m) => m.HookServer,
    edits: [["    } else if (event === 'PostToolUse' || event === 'PostToolUseFailure') {", "    } else if (event === 'PostToolUseFailure') {"]],
    killer: 'runningToolTracked', dies: /THE TOOL ENDS AT ITS PostToolUse/ },
  { name: 'Jim T1: main publishes the newest tool', file: 'src/main/hooks.ts', real: HOOKS, pick: (m) => m.HookServer,
    edits: [['    return this.runningTools.get(agentId)?.[0];', '    return this.runningTools.get(agentId)?.at(-1);']],
    killer: 'oldestToolShown', dies: /THE OLDEST TOOL STILL RUNNING IS SHOWN/ },
  { name: 'Jim N1: a PostToolUse clears every running tool', file: 'src/shared/activityView.ts', real: ACT, pick: (m) => m,
    edits: [["  if (i >= 0 && l.length) l.splice(i < 0 ? 0 : i, 1);\n  return l;", '  return [];']],
    killer: 'parallelToolsKept', dies: /A PARALLEL TOOL ENDING LEAVES THE OTHER RUNNING/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async () => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        await K[m.killer](m.pick(m.real));          // the killer PASSES on the real module...
        let died = null;
        try { await K[m.killer](m.pick(mod)); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message}`);
      });
    }
  } finally {
    fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  }
});
