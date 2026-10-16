'use strict';

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

for (const [name, fn] of Object.entries(K)) test(`FLEET-LIVENESS-BLIND: ${name}`, () => fn({ ST, D }));

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

const MUTANT_DIR = path.join(__dirname, '.mutants-fleet189');

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
    killer: 'digestListsIt', dies: /A SILENT TURN IS A DECISION FOR GOD/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  fs.rmSync(MUTANT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  try {
    for (const [i, m] of MUTANTS.entries()) {
      await t.test(`mutant: ${m.name}`, async () => {
        const mod = mutate(m.file, m.edits, `m${i}`);
        const mods = m.file === STF ? { ST: mod, D } : { ST, D: mod };
        await K[m.killer]({ ST, D });                  // the killer PASSES on the real modules...
        let died = null;
        try { await K[m.killer](mods); } catch (e) { died = e; }
        assert.ok(died, `SURVIVED: "${m.name}" was not killed by ${m.killer}`);
        assert.ok(died instanceof assert.AssertionError, `"${m.name}" must die by ASSERTION, got: ${died && died.stack}`);
        assert.match(died.message, m.dies, `"${m.name}" died at the wrong assertion: ${died.message}`);
      });
    }
  } finally { fs.rmSync(MUTANT_DIR, { recursive: true, force: true }); }
});
