'use strict';

/**
 * SESSION-CROSSWIRE (1.1.70): an agent could resume, and be charged for, another agent's
 * Claude session.
 *
 * Seen live on 1.1.69. Two agents (Jim, Andy) ran in one cwd (C:/PrzEdit), so they had
 * one ~/.claude/projects dir. Andy's Claude Code background-job session df0ccd91 reported
 * its OTel metrics under agent.id=jim, while its hooks correctly said "andy".
 *
 * Two writers of the resume key disagreed:
 * - The hook (hooks.ts, recordSession from the payload) wrote Jim=f4d20619 and
 *   Andy=df0ccd91.
 * - The 30 s beat (index.ts) took the OTel sample's session id and wrote Jim=df0ccd91.
 *
 * The 1.1.63 phantom guard (shouldRecordSampleSession) only asks "is the transcript on
 * disk?". In a shared cwd, Andy's transcript is. So the key flipped every tick. A restart
 * at the wrong moment resumed Andy's conversation as Jim, and Jim's cost sample summed
 * Andy's session.
 *
 * The fix:
 * - Ownership is the hook's word: `hookSessionIds` plus `sessionSource`.
 * - A sample never replaces a hook-recorded key, and never takes an id another agent
 *   claims.
 * - An automatic resume refuses a foreign id, for both the last key and the previous-key
 *   fallback.
 * - Telemetry charges each session to its hook-recorded owner.
 * - The phantom protection of 1.1.63 is kept, and tested here alongside.
 *
 * HOME is redirected and asserted before anything touches ~/.claude.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'crosswire-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
assert.equal(os.homedir(), FAKE_HOME, 'HOME redirect failed - aborting before touching ~/.claude');
test.after(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const loadTs = require('./load-ts.cjs');
const T = loadTs('src/main/transcript.ts');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const JIM_OWN = 'f4d20619-e77e-4b1d-a703-d18759e63e3d';
const ANDY_LIVE = 'df0ccd91-6527-4fa7-a6c1-f8385ae9124b';
const PHANTOM = 'phantom-6e7277b5';

/** One shared cwd whose Claude project dir holds both agents' transcripts. */
function sharedCwd(sessions) {
  const cwd = fs.mkdtempSync(path.join(FAKE_HOME, 'PrzEdit-'));
  const dir = T.projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  for (const sid of sessions) {
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({
      type: 'assistant', sessionId: sid,
      message: { model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    })}\n`);
  }
  return cwd;
}

async function twoAgents(t, cwd) {
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const hive = new HiveManager(() => harness);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd, isGod: true });
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd });
  await hive.ensureAgent({ id: 'andy', name: 'Andy', provider: 'claude', cwd });
  t.after(() => hive.dispose());
  return hive;
}

function sessionRows(hive) {
  const log = path.join(hive.root(), 'log.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'session');
}

/** The OTLP/JSON metric batch Claude Code exports, as the collector receives it. */
function metrics(agentLabel, sessionId, usd, output = 10) {
  const kv = (key, v) => ({ key, value: { stringValue: v } });
  return {
    resourceMetrics: [{
      resource: { attributes: [kv('agent.id', agentLabel)] },
      scopeMetrics: [{ metrics: [
        { name: 'claude_code.token.usage', sum: { dataPoints: [{ attributes: [kv('session.id', sessionId), kv('type', 'output'), kv('model', 'claude-sonnet-5')], asInt: output }] } },
        { name: 'claude_code.cost.usage', sum: { dataPoints: [{ attributes: [kv('session.id', sessionId), kv('model', 'claude-sonnet-5')], asDouble: usd }] } }
      ] }]
    }]
  };
}

/** The 30 s beat's two writes, exactly as index.ts makes them. */
function beat(hive, telemetry, id) {
  const sample = telemetry.getAgentUsage(id);
  if (sample?.sessionId && T.shouldRecordSampleSession(hive.lastSession(id), sample.sessionId, hive.registry().agents[id]?.cwd)) {
    hive.recordSession(id, sample.sessionId, 'sample');
  }
  return sample;
}

// ── the live repro: two agents, one cwd, a mislabelled OTel session ─────────────────────

test('repro: the mislabelled sample passes the 1.1.63 transcript gate in a shared cwd (the precondition)', () => {
  const cwd = sharedCwd([JIM_OWN, ANDY_LIVE]);
  assert.equal(T.shouldRecordSampleSession(JIM_OWN, ANDY_LIVE, cwd), true, 'the transcript gate alone lets another agent\'s real session through');
});

test('two agents in one cwd: the sample can no longer flip Jim onto Andy\'s session (10 beats)', async (t) => {
  const cwd = sharedCwd([JIM_OWN, ANDY_LIVE]);
  const hive = await twoAgents(t, cwd);
  const telemetry = new TelemetryCollector({ resolveSessionOwners: () => hive.hookSessionOwners() });
  hive.recordSession('andy', ANDY_LIVE); // Andy's own hook
  hive.recordSession('jim', JIM_OWN); // Jim's own hook
  for (let i = 0; i < 10; i++) {
    telemetry.ingestMetrics(metrics('jim', ANDY_LIVE, 0.5)); // Andy's session, labelled as Jim
    beat(hive, telemetry, 'jim');
    beat(hive, telemetry, 'andy');
    hive.recordSession('jim', JIM_OWN); // hooks keep landing
    hive.recordSession('andy', ANDY_LIVE);
  }
  assert.equal(hive.lastSession('jim'), JIM_OWN);
  assert.equal(hive.lastSession('andy'), ANDY_LIVE);
  assert.equal(sessionRows(hive).length, 2, 'one row per agent, no flips');
});

test('the sample path itself refuses a foreign id even when telemetry still mislabels it (defence in depth)', async (t) => {
  const cwd = sharedCwd([JIM_OWN, ANDY_LIVE]);
  const hive = await twoAgents(t, cwd);
  hive.recordSession('andy', ANDY_LIVE);
  hive.recordSession('jim', JIM_OWN);
  hive.recordSession('jim', ANDY_LIVE, 'sample'); // as 1.1.69's beat would
  assert.equal(hive.lastSession('jim'), JIM_OWN);
  assert.equal(hive.previousSession('jim'), undefined, 'nothing shifted');
});

test('a sample never replaces a hook-recorded key, even an unclaimed one with a transcript', async (t) => {
  const cwd = sharedCwd([JIM_OWN, 'jim-other']);
  const hive = await twoAgents(t, cwd);
  hive.recordSession('jim', JIM_OWN);
  hive.recordSession('jim', 'jim-other', 'sample');
  assert.equal(hive.lastSession('jim'), JIM_OWN);
  assert.equal(hive.registry().agents.jim.sessionSource, 'hook');
});

test('the sample remains a fallback: it fills an EMPTY key, and a later hook takes over', async (t) => {
  const cwd = sharedCwd([JIM_OWN]);
  const hive = await twoAgents(t, cwd);
  hive.recordSession('jim', JIM_OWN, 'sample'); // hooks not landing yet
  assert.equal(hive.lastSession('jim'), JIM_OWN);
  assert.equal(hive.registry().agents.jim.sessionSource, 'sample');
  assert.deepEqual(hive.registry().agents.jim.hookSessionIds, undefined, 'a sample is not a claim');
  hive.recordSession('jim', JIM_OWN); // first hook: same id, marks ownership
  assert.equal(hive.registry().agents.jim.sessionSource, 'hook');
  assert.deepEqual(hive.registry().agents.jim.hookSessionIds, [JIM_OWN]);
  assert.equal(sessionRows(hive).length, 1, 'marking ownership of the same id is not a new session row');
});

test('an empty key is still never filled with an id another agent claims', async (t) => {
  const cwd = sharedCwd([ANDY_LIVE]);
  const hive = await twoAgents(t, cwd);
  hive.recordSession('andy', ANDY_LIVE);
  hive.recordSession('jim', ANDY_LIVE, 'sample');
  assert.equal(hive.lastSession('jim'), undefined);
});

// ── the 1.1.63 phantom protection is kept ───────────────────────────────────────────────

test('phantom protection (1.1.63) still holds: a no-transcript sample id never replaces the key', async (t) => {
  const cwd = sharedCwd([JIM_OWN]);
  const hive = await twoAgents(t, cwd);
  hive.recordSession('jim', JIM_OWN, 'sample'); // even a sample-sourced key
  assert.equal(T.shouldRecordSampleSession(JIM_OWN, PHANTOM, cwd), false, 'the transcript gate refuses the phantom');
  const telemetry = new TelemetryCollector({ resolveSessionOwners: () => hive.hookSessionOwners() });
  telemetry.ingestMetrics(metrics('jim', PHANTOM, 0.01));
  beat(hive, telemetry, 'jim');
  assert.equal(hive.lastSession('jim'), JIM_OWN, 'the phantom did not become the resume key');
});

// ── restart: the resume guard ───────────────────────────────────────────────────────────

test('resume guard: a foreign last key falls back to the agent\'s own previous id; a foreign id is never seeded', () => {
  const seeded = [];
  const seed = (s) => { seeded.push(s); return true; };
  const foreign = (s) => s === ANDY_LIVE;
  assert.deepEqual(T.chooseResumeSession(ANDY_LIVE, JIM_OWN, seed, foreign), { sessionId: JIM_OWN, miss: true, outcome: 'resumed-previous', refused: [ANDY_LIVE] });
  assert.deepEqual(seeded, [JIM_OWN], 'the foreign transcript was not copied or touched');
});

test('resume guard covers the previousSessionId fallback: a foreign previous id -> fresh', () => {
  const seed = (s) => s !== PHANTOM; // the last key is a phantom (no transcript)
  const foreign = (s) => s === ANDY_LIVE;
  assert.deepEqual(T.chooseResumeSession(PHANTOM, ANDY_LIVE, seed, foreign), { miss: true, outcome: 'fresh', refused: [ANDY_LIVE] });
});

test('resume guard leaves the 1.1.63 outcomes unchanged when nothing is foreign', () => {
  const seed = (s) => s === 'real-prev';
  assert.deepEqual(T.chooseResumeSession('phantom-last', 'real-prev', seed), { sessionId: 'real-prev', miss: true, outcome: 'resumed-previous' });
  assert.deepEqual(T.chooseResumeSession('real-prev', 'x', seed), { sessionId: 'real-prev', miss: false });
});

test('upgrade from 1.1.69: a key two agents hold (no hook records yet) resumes for neither; own ids still resume', async (t) => {
  const cwd = sharedCwd([JIM_OWN, ANDY_LIVE, 'andy-older']);
  const hive = await twoAgents(t, cwd);
  // The registry as 1.1.69 can leave it mid-flip: both agents hold Andy's live session.
  const regPath = path.join(hive.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  Object.assign(reg.agents.jim, { sessionId: ANDY_LIVE, previousSessionId: JIM_OWN });
  Object.assign(reg.agents.andy, { sessionId: ANDY_LIVE, previousSessionId: 'andy-older' });
  fs.writeFileSync(regPath, JSON.stringify(reg));
  const seed = (s) => T.seedSessionTranscript(cwd, s);
  const pick = (id) => T.chooseResumeSession(hive.lastSession(id), hive.previousSession(id), seed, (s) => hive.sessionClaimedByOther(id, s));
  assert.deepEqual(pick('jim'), { sessionId: JIM_OWN, miss: true, outcome: 'resumed-previous', refused: [ANDY_LIVE] }, 'Jim resumes his own thread, not Andy\'s');
  assert.deepEqual(pick('andy'), { sessionId: 'andy-older', miss: true, outcome: 'resumed-previous', refused: [ANDY_LIVE] }, 'contested: nobody gets it until a hook claims it');
  // Once Andy's hook claims it, it is his again, and Jim's stale key/fallback stay refused.
  hive.recordSession('andy', ANDY_LIVE);
  assert.equal(hive.sessionClaimedByOther('andy', ANDY_LIVE), false);
  assert.deepEqual(pick('andy'), { sessionId: ANDY_LIVE, miss: false });
  assert.equal(hive.sessionClaimedByOther('jim', ANDY_LIVE), true);
  hive.recordSession('jim', JIM_OWN); // Jim's hook: ANDY_LIVE shifts into Jim's previousSessionId
  assert.equal(hive.previousSession('jim'), ANDY_LIVE);
  assert.equal(hive.sessionClaimedByOther('jim', hive.previousSession('jim')), true, 'the fallback id is refused too');
});

test('ownership record is capped', async (t) => {
  const cwd = sharedCwd([]);
  const hive = await twoAgents(t, cwd);
  for (let i = 0; i < 30; i++) hive.recordSession('jim', `s-${i}`);
  const ids = hive.registry().agents.jim.hookSessionIds;
  assert.equal(ids.length, 20);
  assert.equal(ids[ids.length - 1], 's-29');
});

// ── cost attribution ────────────────────────────────────────────────────────────────────

test('cost: a mislabelled session is charged to its hook owner, not to the label', async (t) => {
  const cwd = sharedCwd([JIM_OWN, ANDY_LIVE]);
  const hive = await twoAgents(t, cwd);
  hive.recordSession('andy', ANDY_LIVE);
  hive.recordSession('jim', JIM_OWN);
  const telemetry = new TelemetryCollector({ resolveSessionOwners: () => hive.hookSessionOwners() });
  telemetry.ingestMetrics(metrics('jim', JIM_OWN, 1));
  telemetry.ingestMetrics(metrics('jim', ANDY_LIVE, 5)); // Andy's work, labelled Jim
  const jim = telemetry.getAgentUsage('jim');
  const andy = telemetry.getAgentUsage('andy');
  assert.equal(jim.usd, 1);
  assert.equal(jim.sessionId, JIM_OWN);
  assert.equal(andy.usd, 5);
  assert.equal(andy.sessionId, ANDY_LIVE);
  const snap = telemetry.snapshot().usage.map((s) => [s.agentId, s.usd]).sort();
  assert.deepEqual(snap, [['andy', 5], ['jim', 1]]);
});

test('cost: pushes go to the owner, and tool spans follow the owner (breaker progress)', async (t) => {
  const cwd = sharedCwd([JIM_OWN, ANDY_LIVE]);
  const hive = await twoAgents(t, cwd);
  hive.recordSession('andy', ANDY_LIVE);
  const telemetry = new TelemetryCollector({ resolveSessionOwners: () => hive.hookSessionOwners() });
  const pushed = [];
  telemetry.onAgentUsage((s) => pushed.push(s.agentId));
  telemetry.ingestMetrics(metrics('jim', ANDY_LIVE, 2));
  assert.deepEqual(pushed, ['andy']);
  const kv = (key, v) => ({ key, value: { stringValue: v } });
  telemetry.ingestLogs({ resourceLogs: [{ resource: { attributes: [kv('agent.id', 'jim')] }, scopeLogs: [{ logRecords: [{ attributes: [kv('event.name', 'tool_result'), kv('session.id', ANDY_LIVE), kv('tool_name', 'Bash')] }] }] }] });
  assert.equal(telemetry.getSpans('jim').length, 0);
  assert.equal(telemetry.getSpans('andy').length, 1);
});

test('cost: without an ownership record the OTel label still attributes (no regression)', () => {
  const telemetry = new TelemetryCollector({});
  telemetry.ingestMetrics(metrics('jim', JIM_OWN, 1));
  telemetry.ingestMetrics(metrics('jim', 'jim-2', 2));
  assert.equal(telemetry.getAgentUsage('jim').usd, 3);
});

// ── wiring ──────────────────────────────────────────────────────────────────────────────

test('wiring: the beat marks its write as a sample; telemetry resolves owners from the hive; the spawn guards resume', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /hive\.recordSession\(id, sample\.sessionId, 'sample'\)/);
  assert.match(src, /resolveSessionOwners: \(\(\) => \{[\s\S]{0,300}hive\.hookSessionOwners\(\)/);
  assert.match(src, /const foreign = \(s: string\): boolean => hive\.sessionClaimedByOther\(agentId, s\);/);
  assert.match(src, /if \(\(explicitSid \|\| !foreign\(sid\)\) && seedSessionTranscript\(opts\.cwd, sid\)\)/);
  // SESSION-PROMPT-ROTATION (1.1.76): the fallback's seed also refuses a stale-prompt session;
  // the foreign guard is unchanged and still passed.
  assert.match(src, /chooseResumeSession\(sid, previous, seedFresh, foreign\)/);
  assert.match(src, /const seedFresh = \(s: string\): boolean => \{\s*if \(staleFor\(s\)\) \{ rotated\.push\(s\); return false; \}\s*return seedSessionTranscript\(cwd, s\);/);
  assert.doesNotMatch(src, /chooseResumeSession\(sid, previous, \(s\) => seedSessionTranscript\(cwd, s\), foreign\)/);
  const hooks = read('src/main/hooks.ts');
  assert.match(hooks, /this\.hive\.recordSession\(agentId, p\.session_id\)/, 'the hook write keeps the default source, hook');
});
