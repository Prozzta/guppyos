'use strict';
require('./tools/own-job.cjs');

/**
 * MODEL-NOT-KEPT-191 T2 + T3 - the Antigravity user/auto window, and the main-side wiring
 * from a HUMAN pty write to a user pin.
 *
 * T2. AGY runs its statusline after EVERY render, so 1.1.90 moved the window marker on every
 * tick: the render of the closing picker, still showing the old model, landed between the
 * Human's Enter and the new-model tick and passed the key (Phyllis 2026-10-16 18:03:50, an
 * AUTO pin of the Human's Argon pick). F2 (settled with Jim): the marker moves only on a new
 * value; the key must be within AGY_HUMAN_SWITCH_GRACE_MS of the switch tick, with no turn
 * started since it (PreInvocation, or a tick leaving idle); a process's first report is never
 * the person's. Each case names the mutant it kills.
 *
 * T3. Every earlier pin test faked the human source (`() => keys.at`). Here the key goes in
 * through the REAL PtyManager.write(id, data, 'HUMAN') and is read back through the same
 * closure index.ts wires, so a broken link anywhere between the pty and the pin is red.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

const SON = 'Claude Sonnet 5.5 (Medium)';
const ARG = 'Gemini 4 Argon (Medium)';
const ARG_HIGH = 'Gemini 4 Argon (High)';
const ID = 'phyllis-mu11xldm';
const T = (iso) => Date.parse(iso);
const G = HiveManager.AGY_HUMAN_SWITCH_GRACE_MS;

function sandbox(t, { source } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mnk191-'));
  const saved = {};
  for (const k of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'GEMINI_CLI_HOME']) saved[k] = process.env[k];
  process.env.HOME = home; process.env.USERPROFILE = home;
  delete process.env.CODEX_HOME;
  process.env.GEMINI_CLI_HOME = path.join(home, '.gemini');
  const realNow = Date.now;
  const clock = { at: T('2026-10-16T17:53:14.650Z') };
  Date.now = () => clock.at;
  t.after(() => {
    Date.now = realNow;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const keys = { at: undefined };
  hive.setHumanInputSource(source ?? (() => keys.at));
  const rows = [];
  const append = hive.appendLog.bind(hive);
  hive.appendLog = (e) => { rows.push(e); append(e); };
  const server = new HookServer(hive, () => null, () => ({}));
  /** A statusline tick READ at `iso` (the shim's read_at) and handled 20 ms later. */
  const tick = (model, iso, state = 'idle', session = 'sess-1') => {
    clock.at = T(iso) + 20;
    server.handle({ hook_event_name: 'AgyStatusLine', agent_id: ID, read_at: T(iso), agy_status: {
      version: '1.2.8', product: 'antigravity', agent_state: state, session_id: session, model: { id: model, display_name: model }
    } });
  };
  const hook = (event, iso) => { clock.at = T(iso); server.handle({ hook_event_name: event, agent_id: ID, session_id: 'sess-1' }); };
  const spawn = (model = SON) => hive.ensureAgent({ id: ID, name: 'Phyllis', provider: 'antigravity', cwd: home }, { spawnModel: { requested: model, launch: model } });
  const key = (iso) => { keys.at = T(iso); };
  const pins = () => rows.filter((r) => r.kind === 'model-pinned').map((r) => `${r.to}:${r.source}`);

  return { hive, rows, clock, tick, hook, spawn, key, pins };
}

test('T2 REPLAY Phyllis 2026-10-16 18:03:50: the picker-closing render (old model) between the Enter and the switch does not pass the key - USER (1.1.90: auto)', async (t) => {
  const s = sandbox(t);
  await s.spawn();
  s.tick(SON, '2026-10-16T18:03:23.300Z');      // the last render before the pick
  s.key('2026-10-16T18:03:50.600Z');            // the Human's Enter in the picker
  s.tick(SON, '2026-10-16T18:03:50.680Z');      // the picker closing, the model not yet applied
  s.tick(ARG, '2026-10-16T18:03:50.750Z');      // the 18:03:50.750 row
  // Kills: "move the marker on unchanged ticks".
  assert.deepEqual(s.pins(), [`${ARG}:user`]);
  const row = s.rows.find((r) => r.kind === 'model-pinned');
  assert.equal(row.humanAt, T('2026-10-16T18:03:50.600Z'), 'F3: the key is on the row');
  // The later of Sonnet's first sighting (18:03:23.300) and the switch tick minus G.
  assert.equal(row.since, T('2026-10-16T18:03:50.750Z') - G, 'F3: the window start is on the row');
  assert.equal(row.turnAt, null, 'F3: no turn started');
});

test('T2 (i) a prompt Enter, a turn start, then the plan-limit fallback 2 s later is AUTO (PreInvocation, or a tick leaving idle)', async (t) => {
  for (const turn of ['pre-invocation', 'busy-tick']) {
    await t.test(turn, async (tt) => {
      const s = sandbox(tt);
      await s.spawn(ARG);
      // Each variant isolates its own rule (Jim SHOULD 1): with the agent already busy, no tick
      // leaves idle, so only the PreInvocation hook can mark the turn start.
      s.tick(ARG, '2026-10-16T19:00:00.000Z', turn === 'pre-invocation' ? 'working' : 'idle');
      s.key('2026-10-16T19:00:10.000Z');                                  // the prompt's Enter
      if (turn === 'pre-invocation') s.hook('PreInvocation', '2026-10-16T19:00:10.300Z');
      else s.tick(ARG, '2026-10-16T19:00:10.400Z', 'working');
      s.tick(SON, '2026-10-16T19:00:12.000Z', 'working');                 // quota hit: AGY falls back
      // Kills: "drop the turn-start rule" (the key is inside G and after the marker).
      assert.deepEqual(s.pins(), [`${SON}:auto`]);
      assert.equal(typeof s.rows.find((r) => r.kind === 'model-pinned').turnAt, 'number', 'F3: the turn start is on the row');
    });
  }
});

test('T2 (i) edges: a turn start at the key\'s own ms makes it AUTO; a new session\'s first busy tick is a turn start', async (t) => {
  await t.test('same ms (Jim NIT 1: >= not >)', async (tt) => {
    const s = sandbox(tt);
    await s.spawn(ARG);
    s.tick(ARG, '2026-10-16T19:00:00.000Z', 'working');
    s.key('2026-10-16T19:00:10.000Z');
    s.hook('PreInvocation', '2026-10-16T19:00:10.000Z');
    s.tick(SON, '2026-10-16T19:00:12.000Z', 'working');
    assert.deepEqual(s.pins(), [`${SON}:auto`]);
  });
  await t.test('new session (Jim NIT 2)', async (tt) => {
    const s = sandbox(tt);
    await s.spawn(ARG);
    s.tick(ARG, '2026-10-16T19:00:00.000Z', 'working', 'sess-old');     // the old process ended busy
    s.key('2026-10-16T19:00:10.000Z');
    s.tick(SON, '2026-10-16T19:00:11.000Z', 'working', 'sess-new');     // the new process's first turn
    assert.deepEqual(s.pins(), [`${SON}:auto`]);
  });
});

test('T2 (i) a pick made DURING a long turn still counts: only a turn that STARTED after the key makes it auto', async (t) => {
  const s = sandbox(t);
  await s.spawn();
  s.tick(SON, '2026-10-16T19:00:00.000Z', 'working');  // a turn running since before the key
  s.tick(SON, '2026-10-16T19:00:05.000Z', 'working');
  s.key('2026-10-16T19:00:20.000Z');
  s.tick(ARG, '2026-10-16T19:00:20.300Z', 'working');
  assert.deepEqual(s.pins(), [`${ARG}:user`]);
});

test('T2 (ii) the grace bound: the switch tick more than G after the key is AUTO; inside G it is USER', async (t) => {
  for (const [label, gap, want] of [['G+1s', G + 1000, 'auto'], ['G-1s', G - 1000, 'user']]) {
    await t.test(label, async (tt) => {
      const s = sandbox(tt);
      await s.spawn();
      s.tick(SON, '2026-10-16T19:00:00.000Z');
      s.key('2026-10-16T19:00:30.000Z');
      s.tick(ARG, new Date(T('2026-10-16T19:00:30.000Z') + gap).toISOString());
      // Kills: "drop the observedAt - G term".
      assert.deepEqual(s.pins(), [`${ARG}:${want}`]);
    });
  }
});

test('T2 (iii) the first report of a new process is never the person\'s, even with a key 1 s before it', async (t) => {
  const s = sandbox(t);
  s.clock.at = T('2026-10-17T06:16:37.611Z');
  await s.spawn();
  s.key('2026-10-17T06:16:37.800Z');
  s.tick(ARG, '2026-10-17T06:16:38.801Z');   // AGY reporting its stored model before --model applies
  assert.deepEqual(s.pins(), [`${ARG}:auto`]);
  s.tick(SON, '2026-10-17T06:16:39.883Z');   // --model applies: the pin clears (06:16:39.883 live)
  assert.equal(s.hive.registry().agents[ID].model, undefined);
});

test('T2 (iv) an effort-only change moves the marker; an identical tick does not', async (t) => {
  const s = sandbox(t);
  await s.spawn(ARG);
  s.tick(ARG, '2026-10-16T19:00:00.000Z');
  s.key('2026-10-16T19:00:05.000Z');
  s.tick(ARG_HIGH, '2026-10-16T19:00:05.200Z');   // the person raises the effort: a new value
  s.tick(ARG_HIGH, '2026-10-16T19:00:05.400Z');   // re-render, same value
  s.tick(SON, '2026-10-16T19:00:07.000Z');        // a key-less fallback 2 s later, inside G
  // The marker moved to 05.200 with the effort change, so the 05.000 key is before it. Kills:
  // "only a model change moves the marker" (it would still be 00.000 and the fallback USER).
  assert.deepEqual(s.pins(), [`${ARG_HIGH}:user`, `${SON}:auto`]);
  assert.equal(s.rows.filter((r) => r.kind === 'model-pinned')[1].since, T('2026-10-16T19:00:05.200Z'),
    'the window starts at the High tick: the identical 05.400 tick did not move it');
});

test('T2 (v) two switches in a row: the person\'s pick is USER, the key-less fallback after it AUTO', async (t) => {
  const s = sandbox(t);
  await s.spawn();
  s.tick(SON, '2026-10-16T19:00:00.000Z');
  s.key('2026-10-16T19:00:10.000Z');
  s.tick(ARG, '2026-10-16T19:00:10.200Z');
  s.tick(ARG_HIGH, '2026-10-16T19:00:13.000Z');   // 3 s later, inside G, no key, no turn
  assert.deepEqual(s.pins(), [`${ARG}:user`, `${ARG_HIGH}:auto`]);
});

// ─── T3: the real pty ingress ─────────────────────────────────────────────────

function realPty() {
  const pm = new PtyManager();
  const procWrites = [];
  pm.sessions.set('pty-ph', {
    id: 'pty-ph', cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: true,
    humanInputGeneration: 0, incarnation: 1, outputGeneration: 1,
    proc: { write: (d) => { procWrites.push(d); } }
  });
  // index.ts:2607's closure, over a pty map like ptyForAgent.
  const ptyForAgent = (agentId) => (agentId === ID ? 'pty-ph' : undefined);
  const source = (agentId) => { const ptyId = ptyForAgent(agentId); return ptyId ? pm.lastHumanInputAt(ptyId) : undefined; };
  return { pm, procWrites, source };
}

test('T3 a HUMAN write through the real PtyManager makes the AGY pick USER; CONTROL and PROGRAMMATIC writes never do', async (t) => {
  for (const origin of ['HUMAN', 'CONTROL', 'PROGRAMMATIC']) {
    await t.test(origin, async (tt) => {
      const { pm, procWrites, source } = realPty();
      const s = sandbox(tt, { source });
      await s.spawn();
      s.tick(SON, '2026-10-16T18:03:23.300Z');
      s.clock.at = T('2026-10-16T18:03:50.600Z');
      assert.deepEqual(pm.write('pty-ph', '\r', origin), { ok: true });
      assert.deepEqual(procWrites, ['\r'], 'the byte reached the process');
      s.tick(SON, '2026-10-16T18:03:50.680Z');
      s.tick(ARG, '2026-10-16T18:03:50.750Z');
      assert.deepEqual(s.pins(), [`${ARG}:${origin === 'HUMAN' ? 'user' : 'auto'}`]);
      assert.equal(s.rows.find((r) => r.kind === 'model-pinned').humanAt, origin === 'HUMAN' ? T('2026-10-16T18:03:50.600Z') : null);
    });
  }
});

test('T3 index.ts still feeds the hive from PtyManager.lastHumanInputAt for the agent\'s live pty', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  assert.match(src, /hive\.setHumanInputSource\(\(agentId\) => \{\s*const ptyId = ptyForAgent\(agentId\);\s*return ptyId \? ptyManager\.lastHumanInputAt\(ptyId\) : undefined;\s*\}\);/);
});
