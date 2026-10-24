'use strict';
require('./tools/own-job.cjs');

/**
 * FLEET-LIVENESS-BLIND (2026-10-16): Dwight (Codex) was shown working for 3h50m with no hook or
 * tool call after ~09:29Z and 5 unread, and nothing told god. src/main/silentTurn.ts finds such a
 * turn and the floor digest lists it as a decision for god. Detection and alert only.
 *
 * The guarantees, each with a mutant in the census below that must die at its assertion:
 *   FIRES      a turn shown working with no hook and no open tool call for 15 min reaches god
 *   LONG TOOL  a long legitimate tool call (a 10-min Bash, a 59-min suite) is never silence
 *   TOOL CAP   a tool call open for an hour is listed (a lost PostToolUse cannot hide a hang)
 *   IDLE       an idle agent (turn ended) is never listed, however old its last hook
 *   DIGEST     the digest turns the finding into god's decision item
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { newMutantDir, cleanupMutantDir } = require('./mutant-dir-helper.cjs');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const readSource = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const ST = loadTs('src/main/silentTurn.ts');
const D = loadTs('src/main/floorDigest.ts');

const MIN = 60_000;
const T0 = Date.parse('2026-10-16T09:29:00.000Z');

/** One agent's facts; `over` replaces fields. */
const agent = (agentId, over = {}) => ({
  agentId, name: agentId, lifecycle: 'active', activeSince: T0 - 20 * MIN, turnStartAt: T0 - 20 * MIN,
  lastHookAt: T0, runningTool: null, mailWaiting: 0, hasPty: true, archived: false, onHold: false, halted: false, ...over
});

/** The digest scheduler on a fake clock, run every 5 minutes (the shipped cadence) for `forMs`. */
function runDigest(mods, fleet, forMs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fleet-blind-'));
  try {
    const clock = { now: T0 };
    const sent = [];
    const host = {
      root: () => root, tasks: () => ({ tasks: [] }), taskMeta: () => ({}), flags: () => [], ledgerIssues: () => [],
      silentTurns: () => mods.ST.findSilentTurns(fleet(clock.now), clock.now),
      send: (m, from) => sent.push({ ...m, from, at: clock.now }), appendLog: () => {}
    };
    const digest = new mods.D.FloorDigest(host, () => mods.D.FLOOR_DIGEST_DEFAULTS, () => clock.now);
    for (; clock.now <= T0 + forMs; clock.now += mods.D.FLOOR_DIGEST_DEFAULTS.digestEveryMs) digest.run();
    return sent;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const K = {
  /** Dwight's morning: active, last hook 09:29Z, nothing open, 5 unread. */
  async silentTurnReachesGod({ ST, D }) {
    const sent = runDigest({ ST, D }, () => [agent('dwight', { mailWaiting: 5 })], 4 * 60 * MIN);
    assert.equal(sent.length, 1, 'FIRES: A SILENT WORKING TURN REACHES GOD, ONCE (one silence = one decision)');
    const w = sent[0];
    assert.deepEqual([w.to, w.act, w.from], ['god', 'inform', 'digest']);
    assert.ok(w.at - T0 >= ST.SILENT_TURN_AFTER_MS && w.at - T0 <= 30 * MIN, `god hears within 30 min, not 3h50m (heard at +${(w.at - T0) / MIN} min)`);
    assert.match(w.body, new RegExp(`^- \\[silent-turn:dwight:${T0}\\] dwight is shown working but has made no hook or tool call for .*, 5 unread - the turn may be hung`));
    assert.match(w.body, /nothing was stopped or restarted/);
  },
  /** The same agent, but its hooks keep coming every few minutes: never listed. */
  async hooksKeepItQuiet({ ST, D }) {
    const sent = runDigest({ ST, D }, (now) => [agent('andy', { lastHookAt: now - ((now - T0) % (7 * MIN)) })], 4 * 60 * MIN);
    assert.equal(sent.length, 0, 'a turn whose hooks keep coming is not silent');
  },
  /** A tool call in progress is not silence: a 10-min foreground Bash and a 59-min suite. */
  async longToolIsNotSilence({ ST }) {
    for (const ms of [10 * MIN, 59 * MIN]) {
      // PreToolUse at T0 (the last hook), no PostToolUse yet.
      const rows = [agent('andy', { lastHookAt: T0, runningTool: { name: 'Bash', since: T0 } })];
      for (let now = T0; now <= T0 + ms; now += MIN) {
        assert.deepEqual(ST.findSilentTurns(rows, now), [], `LONG TOOL: AN OPEN TOOL CALL IS NEVER SILENCE (Bash open ${(now - T0) / MIN} min)`);
      }
    }
  },
  /** A tool call open past the cap is listed as such (a lost PostToolUse, or a hung tool). */
  async toolOpenPastCap({ ST, D }) {
    const rows = [agent('creed', { lastHookAt: T0, runningTool: { name: 'Bash', since: T0 }, mailWaiting: 2 })];
    assert.deepEqual(ST.findSilentTurns(rows, T0 + ST.TOOL_OPEN_LONG_MS - 1), []);
    const found = ST.findSilentTurns(rows, T0 + ST.TOOL_OPEN_LONG_MS);
    assert.deepEqual(found, [{ agentId: 'creed', name: 'creed', kind: 'tool-open-long', since: T0, tool: 'Bash', mailWaiting: 2 }],
      'TOOL CAP: A TOOL CALL OPEN FOR AN HOUR IS LISTED');
    const items = D.decisionItems([], [], T0 + 61 * MIN, [], found);
    assert.equal(items[0].id, `tool-open-long:creed:${T0}`);
    assert.match(items[0].line, /^creed has had one tool call \(Bash\) open for .*, 2 unread - it may be hung or its end was lost/);
  },
  /** Idle, archived, on hold, halted, or no PTY: never listed, however old the last hook. */
  async idleNeverListed({ ST }) {
    const now = T0 + 5 * 60 * MIN;
    assert.deepEqual(ST.findSilentTurns([agent('jim', { lifecycle: 'idle' })], now), [], 'IDLE: AN IDLE AGENT IS NEVER SILENT');
    assert.deepEqual(ST.findSilentTurns([agent('jim', { lifecycle: 'unknown' })], now), [], 'IDLE: AN IDLE AGENT IS NEVER SILENT');
    for (const over of [{ archived: true }, { onHold: true }, { halted: true }, { hasPty: false }]) {
      assert.deepEqual(ST.findSilentTurns([agent('jim', over)], now), [], `not listed: ${JSON.stringify(over)}`);
    }
  },
  /** The clock is the newest of the last hook, the turn's start and the active edge. */
  async clockAndThreshold({ ST }) {
    const rows = [agent('dwight')];
    assert.deepEqual(ST.findSilentTurns(rows, T0 + 15 * MIN - 1), [], 'not before 15 min');
    assert.equal(ST.findSilentTurns(rows, T0 + 15 * MIN).length, 1, 'FIRES: AT 15 MIN');
    // A turn that started after the last hook (a new wake, no hook yet) counts from its start.
    const fresh = [agent('dwight', { lastHookAt: T0 - 60 * MIN, turnStartAt: T0, activeSince: T0 })];
    assert.deepEqual(ST.findSilentTurns(fresh, T0 + 14 * MIN), []);
    assert.equal(ST.findSilentTurns(fresh, T0 + 15 * MIN)[0].since, T0);
  },
  /** A new silence after the hooks came back is a new decision. */
  async newSilenceRearms({ ST, D }) {
    const back = T0 + 60 * MIN;
    const sent = runDigest({ ST, D }, (now) => [agent('dwight', { lastHookAt: now < back ? T0 : back })], 3 * 60 * MIN);
    assert.deepEqual(sent.map((s) => s.body.match(/\[(silent-turn:[^\]]+)\]/)[1]), [`silent-turn:dwight:${T0}`, `silent-turn:dwight:${back}`]);
  },
  /** The digest lists it in floor-digest.md's decisions. */
  async digestListsIt({ D }) {
    const { markdown, decisionItems } = D.buildFloorDigest({ tasks: [], meta: {}, flags: [], ledgerIssues: [], agents: [], now: T0 + 230 * MIN,
      silentTurns: [{ agentId: 'dwight-mu32ztys', name: 'Dwight', kind: 'silent', since: T0, mailWaiting: 5 }] });
    assert.equal(decisionItems.length, 1, 'DIGEST: A SILENT TURN IS A DECISION FOR GOD');
    assert.match(markdown, new RegExp(`- \\[silent-turn:dwight-mu32ztys:${T0}\\] Dwight is shown working but has made no hook or tool call for 3\\.8 h, 5 unread`));
  }
};

// ─── Display (second commit): fleet.json's silentTurn, the LIVE ROSTER bit, the card badge ────

// hive.ts pulls electron in; outside Electron seed the surface it touches (as card-idle-178 does).
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const B = loadTs('src/shared/agentBadges.ts');
const HIVE = loadTs('src/main/hive.ts');

/** The words, shared by the roster line and the card badge. */
K.displayWords = ({ B: b = B }) => {
  const now = T0 + 25 * MIN;
  const silent = { kind: 'silent', since: T0 };
  const tool = { kind: 'tool-open-long', since: T0 - 47 * MIN, tool: 'Bash' };
  assert.equal(b.silentTurnText(silent, now), 'SILENT 25 min (no hook, no tool call)');
  assert.equal(b.silentTurnText(tool, now), 'TOOL OPEN Bash 1.2 h', 'DISPLAY: AN OPEN TOOL READS AS ONE, NOT AS SILENCE');
  assert.equal(b.silentBadgeText(silent, now), 'silent 25 min');
  assert.equal(b.silentBadgeText(tool, now), 'tool 1.2 h');
  assert.match(b.silentBadgeTitle(silent, now), /^Shown working, but no hook or tool call for 25 min: the turn may be hung\. .*nothing was stopped or restarted\.$/);
  assert.match(b.silentBadgeTitle(tool, now), /^One tool call \(Bash\) open for 1\.2 h: /);
};

/** The LIVE ROSTER line god reads names the silence, from fleet.json's silentTurn. */
K.rosterSaysSilent = async ({ HIVE: H = HIVE }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-fleet-blind-roster-'));
  const hive = new H.HiveManager(() => home);
  try {
    await hive.ensureAgent({ id: 'dwight', name: 'Dwight', provider: 'codex', cwd: home });
    await hive.ensureAgent({ id: 'andy', name: 'Andy', provider: 'claude', cwd: home });
    const now = Date.now();
    const busy = (agentId) => ({ v: 1, agentId, incarnation: 1, lifecycle: 'LIVE', classification: 'BUSY_PROGRESSING', classifiedSince: now - 230 * MIN, reason: 'pty-traffic', evidence: { sampledAt: now } });
    hive.writeFleetSnapshot({
      ts: now,
      agents: [
        { id: 'dwight', name: 'Dwight', role: 'agent', lastActiveSecAgo: 13800, inboxBacklog: 5, silentTurn: { kind: 'silent', since: now - 230 * MIN } },
        { id: 'andy', name: 'Andy', role: 'agent', lastActiveSecAgo: 600, runningTool: { name: 'Bash', forSec: 600 }, silentTurn: null }
      ],
      liveness: [busy('dwight'), busy('andy')]
    });
    const line = hive.rosterContext();
    assert.match(line, /dwight "Dwight" \(agent, WORKING [^,]+, SILENT 3\.8 h \(no hook, no tool call\), active /, 'ROSTER: A SILENT WORKING TURN IS NAMED ON THE LIVE ROSTER');
    assert.doesNotMatch(line.slice(line.indexOf('andy "Andy"')), /^[^\n]*SILENT/, 'a long tool call is not named silent');
  } finally { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
};

for (const [name, fn] of Object.entries(K)) test(`FLEET-LIVENESS-BLIND: ${name}`, () => fn({ ST, D, B, HIVE }));

test('FLEET-LIVENESS-BLIND: fleet.json, the card-badge IPC, the strip and the card carry the flag (display only)', () => {
  const idx = readSource('src/main/index.ts');
  const snap = idx.slice(idx.indexOf('function writeFleetSnapshot(): void {'));
  assert.match(snap.slice(0, snap.indexOf('\n}\n')), /const silent = silentTurnsById\(now\);[^]*silentTurn: silent\[id\] \?\? null,/);
  assert.match(idx, /for \(const s of findSilentTurns\(silentTurnFacts\(\), now\)\) out\[s\.agentId\] = \{ kind: s\.kind, since: s\.since,/);
  assert.match(idx, /try \{ silentTurns = silentTurnsById\(Date\.now\(\)\); \} catch/);
  assert.match(idx, /const inboxHeld: Record<string, number> = \{\};/);
  assert.match(idx, /const heldUntil: Record<string, number> = \{\};/);
  assert.match(idx, /if \(mail\.inboxHeld && mail\.heldUntil\) \{ inboxHeld\[id\] = mail\.inboxHeld; heldUntil\[id\] = mail\.heldUntil; \}/);
  assert.match(idx, /return \{ flags: boardMonitor\.flags\(\), inboxBacklog, inboxHeld, heldUntil, silentTurns \};/);
  const strip = readSource('src/renderer/src/components/AgentStrip.tsx');
  assert.match(strip, /setSilentByAgent\(silent \?\? \{\}\);/);
  assert.match(strip, /silentTurn=\{silentByAgent\[a\.id\]\}/);
  const card = readSource('src/renderer/src/components/AgentCard.tsx');
  const badge = card.slice(card.indexOf('data-badge="silent"'), card.indexOf('</span>', card.indexOf('data-badge="silent"')));
  assert.match(card, /\{silentTurn && \(\s*<span\s+data-badge="silent"/);
  assert.match(badge, /title=\{silentBadgeTitle\(silentTurn, Date\.now\(\)\)\}/);
  assert.match(badge, /\{silentBadgeText\(silentTurn, Date\.now\(\)\)\}/);
  assert.match(badge, /left: -5, top: -6/, 'its own corner (task: bottom right, mail: top right)');
  assert.doesNotMatch(badge, /onClick/, 'display only');
});

// ─── Creed N1/N2 (third commit): the open-tool bookkeeping this card relies on ───────────────

const HOOKS = loadTs('src/main/hooks.ts');
const HEAVY = loadTs('src/main/heavyJob.ts');
const A = loadTs('src/shared/activityView.ts');

/** A HookServer on stubs; `deny` = the heavy lock refuses every heavy call, `gate` = the HITL gate refuses `gate`. */
function hookServer(Hook, { deny = false, gate = null } = {}) {
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: (_a, tool) => (tool === gate ? { deny: true, reason: 'gated' } : { deny: false }) };
  const s = new Hook(hive, () => null, () => ({}), control, undefined, undefined, () => {});
  // A REAL lock that refuses every acquire: a hand-made partial stub broke when HLO196 added
  // noteCall/noteCallEnd to the interface hooks.ts calls (FLEET-LIVENESS-STUB-196).
  if (deny) {
    const lock = new HEAVY.HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {} });
    lock.acquire = () => ({ allow: false, reason: 'slot busy', holders: [] });
    s.setHeavyLock(lock);
  }
  return s;
}
const SUITE = { command: 'node test/tools/run-tests.cjs' };
/** The facts findSilentTurns reads, with the server's open tool and a last hook at `lastHookAt`. */
const rowOf = (s, lastHookAt) => {
  const t = s.runningTool('andy');
  return agent('andy', { activeSince: T0, turnStartAt: T0, lastHookAt, runningTool: t ? { name: t.name, since: t.since } : null });
};

/** Creed N1 (gaps.cjs G1): a heavy call the lock DENIES gets no PostToolUse; the turn then runs a
 *  Bash call (Pre + Post) and hangs. The denied call must leave nothing open, so the hang reads
 *  SILENT at 15 min, not TOOL OPEN ~1 h after it. */
K.deniedCallLeavesNothingOpen = ({ HOOKS: H = HOOKS }) => {
  const s = hookServer(H.HookServer, { deny: true });
  const out = s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'den-1', tool_input: SUITE });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', 'fixture: the lock denies the suite');
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'ok-1', tool_input: { command: 'git status' } });
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'ok-1', tool_input: { command: 'git status' } });
  const hang = T0 + 30 * MIN;
  assert.deepEqual(ST.findSilentTurns([rowOf(s, hang)], T0 + 45 * MIN).map((x) => x.kind), ['silent'],
    'N1: A DENIED CALL LEAVES NO TOOL OPEN (a hang at +30 reads SILENT at +45)');
  // The HITL gate's deny too (it answers before the lock).
  const g = hookServer(H.HookServer, { gate: 'Bash' });
  g.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'g-1', tool_input: { command: 'ls' } });
  assert.equal(g.runningTool('andy'), undefined, 'N1: A DENIED CALL LEAVES NO TOOL OPEN (HITL gate)');
  // An allowed call is still open until its Post.
  const a = hookServer(H.HookServer);
  a.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'a-1', tool_input: SUITE });
  assert.equal(a.runningTool('andy')?.name, 'Bash', 'an allowed call stays open');
};

/** Creed f0ea31a1 audit (gaps-server.cjs 'identity'): a deny drops ONLY the entry its own Pre opened.
 *  A long Bash is open; a heavy Bash (lock) and a Grep (HITL gate) are denied; the long Bash keeps
 *  its id and start, and its own Post then closes it. */
K.denyDropsOnlyItsOwnEntry = ({ HOOKS: H = HOOKS }) => {
  const s = hookServer(H.HookServer, { deny: true, gate: 'Grep' });
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'long', tool_input: { command: 'sleep 999' } });
  const longSince = s.runningTool('andy').since;
  const d1 = s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'den-1', tool_input: SUITE });
  assert.equal(d1.hookSpecificOutput.permissionDecision, 'deny', 'fixture: the lock denies the suite');
  const d2 = s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Grep', tool_use_id: 'g-1', tool_input: { pattern: 'x' } });
  assert.equal(d2.hookSpecificOutput.permissionDecision, 'deny', 'fixture: the gate denies Grep');
  const t = s.runningTool('andy');
  assert.deepEqual(t && [t.id, t.since], ['long', longSince], 'N1: A DENY DROPS ONLY ITS OWN ENTRY (the open long Bash survives)');
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'long', tool_input: { command: 'sleep 999' } });
  assert.equal(s.runningTool('andy'), undefined, 'its own Post then closes it');
};

/** Creed N1, second half: overlapping same-name calls end by their own id, so the one still running
 *  keeps its own start time (the oldest-by-name rule gave it the later call's). */
K.overlappingCallsEndById = ({ HOOKS: H = HOOKS, A: act = A }) => {
  const two = [{ name: 'Bash', since: 1, id: 'long' }, { name: 'Bash', since: 2, id: 'short' }];
  assert.deepEqual(act.toolEnded(two, 'Bash', 'short'), [two[0]], 'N1: OVERLAPPING SAME-NAME CALLS END BY THEIR OWN ID (toolEnded)');
  const s = hookServer(H.HookServer);
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'long', tool_input: { command: 'sleep 999' } });
  const longSince = s.runningTool('andy').since;
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'short', tool_input: { command: 'ls' } });
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'short', tool_input: { command: 'ls' } });
  assert.equal(s.runningTool('andy')?.id, 'long', 'N1: OVERLAPPING SAME-NAME CALLS END BY THEIR OWN ID');
  assert.equal(s.runningTool('andy').since, longSince);
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', tool_name: 'Bash', tool_use_id: 'long', tool_input: { command: 'sleep 999' } });
  assert.equal(s.runningTool('andy'), undefined);
};

/** Creed N2 (gaps.cjs G2): a degraded Codex mcp PreToolUse names no tool; a tool IS running, so an
 *  'unknown' entry opens (no SILENT at +20), and its Post closes it, degraded or named. */
K.degradedPreOpensUnknown = ({ HOOKS: H = HOOKS, A: act = A }) => {
  const pre = { hook_event_name: 'PreToolUse', agent_id: 'andy', transport: 'mcp', payload_degraded: true };
  const s = hookServer(H.HookServer);
  s.handle({ ...pre });
  assert.equal(s.runningTool('andy')?.name, 'unknown', 'N2: A DEGRADED PRE OPENS AN UNKNOWN TOOL');
  assert.deepEqual(ST.findSilentTurns([rowOf(s, T0)], T0 + 20 * MIN), [], 'N2: A DEGRADED PRE OPENS AN UNKNOWN TOOL (no SILENT at +20)');
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', transport: 'mcp', payload_degraded: true });
  assert.equal(s.runningTool('andy'), undefined, 'N2: ITS POST CLOSES IT (degraded Post)');
  s.handle({ ...pre });
  s.handle({ hook_event_name: 'PostToolUse', agent_id: 'andy', transport: 'mcp', tool_name: 'exec_command' });
  assert.equal(s.runningTool('andy'), undefined, 'N2: ITS POST CLOSES IT (named Post)');
  // The same rule, on the shared helper the renderer uses too.
  assert.deepEqual(act.toolEnded([{ name: 'unknown', since: 1 }], 'exec_command'), [], 'N2: ITS POST CLOSES IT (toolEnded)');
  assert.deepEqual(act.toolEnded([{ name: 'Bash', since: 1 }], 'Grep'), [{ name: 'Bash', since: 1 }], 'a Post of another named tool closes nothing');
};

test('Creed N1: a call the hook DENIES leaves no tool open, and same-name calls end by id', () => {
  K.deniedCallLeavesNothingOpen({});
  K.denyDropsOnlyItsOwnEntry({});
  K.overlappingCallsEndById({});
});
test('Creed N2: a degraded Codex PreToolUse opens an unknown tool that its Post closes', () => K.degradedPreOpensUnknown({}));

test('FLEET-LIVENESS-BLIND: main wires the hook clock and the open tool into the digest (never PTY output)', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /silentTurns: \(\) => findSilentTurns\(silentTurnFacts\(\), Date\.now\(\)\),/);
  const body = idx.slice(idx.indexOf('function silentTurnFacts(): SilentTurnFacts[] {'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.match(fn, /lastHookAt: hookSeenAt\.get\(agentId\) \?\? 0, runningTool: tool \? \{ name: tool\.name, since: tool\.since \} : null,/);
  assert.match(fn, /const tool = hookServer\.runningTool\(agentId\);/);
  assert.match(fn, /lifecycle: wake\.lifecycle, activeSince: wake\.activeSince, turnStartAt: wake\.turnStartAt,/);
  assert.doesNotMatch(fn, /lastTrafficAt|livenessFacts\(ptyId\)/, 'PTY output is never the clock');
  assert.match(idx, /if \(agentId\) hookSeenAt\.set\(agentId, Date\.now\(\)\);/, 'every hook stamps the clock');
  // Detection only: the module only reads facts.
  assert.doesNotMatch(readSource('src/main/silentTurn.ts'), /^import (?!type )/m, 'silentTurn.ts imports types only (it acts on nothing)');
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────

let MUTANT_DIR;

function mutate(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  // A copy in MUTANT_DIR resolves its relative imports back to the real files.
  text = text.replace(/from '(\.\.?\/[^']+)'/g, (_, m) => `from '${path.relative(MUTANT_DIR, path.join(ROOT, path.dirname(rel), m)).replace(/\\/g, '/')}'`);
  const file = path.join(MUTANT_DIR, `${tag}.ts`);
  fs.writeFileSync(file, text, 'utf8');
  return loadTs(path.relative(ROOT, file));
}

const STF = 'src/main/silentTurn.ts';
const DGF = 'src/main/floorDigest.ts';
const MUTANTS = [
  { name: 'the detector never fires', file: STF,
    edits: [['    if (since > 0 && now - since >= silentAfterMs) out.push(', '    if (false) out.push(']],
    killer: 'silentTurnReachesGod', dies: /A SILENT WORKING TURN REACHES GOD/ },
  { name: 'an open tool call counts as silence', file: STF,
    edits: [['    if (r.runningTool) {', '    if (false) {']],
    killer: 'longToolIsNotSilence', dies: /AN OPEN TOOL CALL IS NEVER SILENCE \(Bash open 15 min\)/ },
  { name: 'a tool call is never listed, however long', file: STF,
    edits: [['      if (now - r.runningTool.since >= toolOpenLongMs) out.push(', '      if (false) out.push(']],
    killer: 'toolOpenPastCap', dies: /A TOOL CALL OPEN FOR AN HOUR IS LISTED/ },
  { name: 'the turn state is not checked (idle agents listed)', file: STF,
    edits: [[" || r.halted || r.lifecycle !== 'active') continue;", ' || r.halted) continue;']],
    killer: 'idleNeverListed', dies: /AN IDLE AGENT IS NEVER SILENT/ },
  { name: 'the threshold is the 5-min SUSPECT window', file: STF,
    edits: [['export const SILENT_TURN_AFTER_MS = 15 * 60_000;', 'export const SILENT_TURN_AFTER_MS = 5 * 60_000;']],
    killer: 'clockAndThreshold', dies: /^not before 15 min/ },
  { name: 'the digest drops silent turns', file: DGF,
    edits: [['  for (const s of silentTurns) {', '  for (const s of silentTurns.slice(0, 0)) {']],
    killer: 'digestListsIt', dies: /A SILENT TURN IS A DECISION FOR GOD/ },
  { name: 'the LIVE ROSTER leaves the silence out', file: 'src/main/hive.ts',
    edits: [['...(state ? [state] : []), ...(silent ? [silent] : []),', '...(state ? [state] : []),']],
    killer: 'rosterSaysSilent', dies: /A SILENT WORKING TURN IS NAMED ON THE LIVE ROSTER/ },
  { name: 'the display calls an open tool silence', file: 'src/shared/agentBadges.ts',
    edits: [["  return s.kind === 'silent'\n    ? `SILENT", "  return true\n    ? `SILENT"]],
    killer: 'displayWords', dies: /AN OPEN TOOL READS AS ONE, NOT AS SILENCE/ },
  { name: 'Creed N1: a denied call keeps its open entry', file: 'src/main/hooks.ts',
    edits: [["    if (opened && decision === 'deny') {", '    if (false) {']],
    killer: 'deniedCallLeavesNothingOpen', dies: /N1: A DENIED CALL LEAVES NO TOOL OPEN \(a hang at \+30 reads SILENT at \+45\)/ },
  { name: 'Creed N1: a deny drops every entry of its name', file: 'src/main/hooks.ts',
    edits: [['.filter((t) => t !== opened.tool);', '.filter((t) => t.name !== opened.tool.name);']],
    killer: 'denyDropsOnlyItsOwnEntry', dies: /N1: A DENY DROPS ONLY ITS OWN ENTRY/ },
  { name: 'Creed N1: a deny drops the oldest entry', file: 'src/main/hooks.ts',
    edits: [['.filter((t) => t !== opened.tool);', '.filter((_t, k) => k !== 0);']],
    killer: 'denyDropsOnlyItsOwnEntry', dies: /N1: A DENY DROPS ONLY ITS OWN ENTRY/ },
  { name: 'Creed N1: a Post ends the oldest of its name, not its own call', file: 'src/shared/activityView.ts',
    edits: [['  let i = id ? l.findIndex((t) => t.id === id) : -1;', '  let i = -1;'],
      ['  if (i < 0 && name) i = l.findIndex((t) => t.name === name && (!id || !t.id));', '  if (i < 0 && name) i = l.findIndex((t) => t.name === name);']],
    killer: 'overlappingCallsEndById', dies: /N1: OVERLAPPING SAME-NAME CALLS END BY THEIR OWN ID/ },
  { name: 'Creed N2: a degraded Pre opens nothing', file: 'src/main/hooks.ts',
    edits: [["    if (event === 'PreToolUse' && (name || p.payload_degraded === true)) {", "    if (event === 'PreToolUse' && name) {"]],
    killer: 'degradedPreOpensUnknown', dies: /N2: A DEGRADED PRE OPENS AN UNKNOWN TOOL/ },
  { name: 'Creed N2: a named Post never closes an unknown entry', file: 'src/shared/activityView.ts',
    edits: [['  if (i < 0) i = l.findIndex((t) => t.name === UNKNOWN_TOOL);\n', '']],
    killer: 'degradedPreOpensUnknown', dies: /N2: ITS POST CLOSES IT/ }
];
const MOD_KEY = { [STF]: 'ST', [DGF]: 'D', 'src/main/hive.ts': 'HIVE', 'src/shared/agentBadges.ts': 'B', 'src/main/hooks.ts': 'HOOKS', 'src/shared/activityView.ts': 'A' };

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  MUTANT_DIR = newMutantDir('fleet189');
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async () => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        const real = { ST, D, B, HIVE, HOOKS, A };
        const mods = { ...real, [MOD_KEY[m.file]]: mod };
        await K[m.killer](real);                       // the killer PASSES on the real modules...
        let died = null;
        try { await K[m.killer](mods); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message}`);
      });
    }
  } finally { cleanupMutantDir(MUTANT_DIR); }
});
