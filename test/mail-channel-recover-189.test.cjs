'use strict';
/**
 * MAIL-CHANNEL-STUCK-DEGRADED (1.1.89): a mail channel degrade (§11.10) is no longer for good.
 *  (d) trigger B judges a wake by what FOLLOWS it: a hook clears it, a confirm window that ends with
 *      no hook counts it. Jim's 2026-10-02 17:46-17:51 sequence (two wakes that never started a
 *      turn, then a third whose hooks came 40 ms after it was typed) does not degrade;
 *  (a) a hook from a degraded agent undoes a zero-hook-traffic degrade at its next wake claim (between
 *      turns: no turn switches mode halfway; override cleared, `mail-channel-restored`, the alert
 *      dropped, that wake is injection again) and the watch re-arms: a channel that really
 *      fails degrades again. A status reading is not a hook. A hook says nothing about mail blocks,
 *      so it never undoes a no-mail-block degrade;
 *  (b) the override is persisted (it survives an app restart) and every spawn, respawn and relaunch
 *      (HiveManager.ensureAgent) undoes it, for either reason, before the prompt reads it. Codex
 *      (its running session is never told of a degrade): the first spawn applies it, the next one
 *      undoes it, so the spawn its alert asks for still delivers mail (mail-rig-faults F12).
 * MUTANTS: counting a wake at its commit, no restore on a hook, no restore at a spawn: each caught.
 * Zero model tokens: a real (jailed) hive, a real HookServer, the real coordinator and bridge,
 * wired as src/main/index.ts wires them, with a fake clock on the bridge.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-recover-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const ROOT = path.join(__dirname, '..');
const BRIDGE = 'src/main/inboxWakeBridge.ts';
const HIVE = 'src/main/hive.ts';
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { HookServer } = loadTs('src/main/hooks.ts');
const { MAIL_DEGRADE_AFTER_WAKES } = loadTs(BRIDGE);
const { WorkerWakeWatchdog, SUBMIT_CONFIRM_MS, WORKER_WAKE_COOLDOWN_MS } = loadTs('src/main/workerWake.ts');
const { coordinatorPendingIds } = loadTs('src/main/mailReaders.ts');
const STEP = Math.max(SUBMIT_CONFIRM_MS, WORKER_WAKE_COOLDOWN_MS) + 1_000;

/** The modules under test, real or mutated (a mutant never touches the source tree). */
function mods(mut = {}) {
  return {
    InboxWakeBridge: (mut[BRIDGE] ? loadTs.fromText(BRIDGE, mut[BRIDGE]) : loadTs(BRIDGE)).InboxWakeBridge,
    HiveManager: (mut[HIVE] ? loadTs.fromText(HIVE, mut[HIVE]) : loadTs(HIVE)).HiveManager
  };
}

/** A floor wired like main (mail-epochs.test.cjs world(), plus the 1.1.89 `restore` dep). */
async function world(t, m = mods(), home = fs.mkdtempSync(path.join(JAIL, 'floor-'))) {
  const hive = new m.HiveManager(() => home, () => true);
  const w = { now: Date.now(), queue: [], reqs: [], diags: [] };
  let server = null;
  t.after(() => { try { server?.stop(); } catch { /* noop */ } hive.dispose(); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'cl-1', name: 'cl-1', provider: 'claude', cwd: home });
  const coordinator = new WorkerWakeWatchdog();
  const pending = (a) => coordinatorPendingIds(a, {
    mode: (x) => server.mailChannel(x).mode,
    pending: (x) => hive.mail.pending(x),
    skipped: (x) => server.mailSkippedIds(x),
    files: (x) => hive.inbox(x).map((msg) => msg.id)
  });
  const bridge = new m.InboxWakeBridge({
    coordinator,
    inboxIds: pending,
    facts: (a) => ({ ptyId: `pty-${a}`, lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false }),
    submit: (req) => { w.reqs.push(req); return Promise.resolve({ kind: 'COMMITTED' }); },
    text: (ids) => `You have new hive mail: ${ids.join(', ')}`,
    setImmediate: (fn) => w.queue.push(fn),
    now: () => w.now,
    diag: (stage, fields) => w.diags.push({ stage, ...fields }),
    confirmsTurnStart: () => true,
    mail: {
      mode: (a) => server.mailChannel(a).mode,
      closeTurn: (a, turnId) => { server.closeMailTurn(a, turnId); },
      abortSince: (a, since) => { server.abortMailEpochsSince(a, since, 'submit-unconfirmed'); },
      closeStale: (a, now) => server.closeStaleMailEpochs(a, now),
      hasOpenEpoch: (a) => hive.mail.openEpochs(a).length > 0,
      n1DueIds: (a) => hive.mail.n1Due(a),
      openIds: (a) => hive.mail.openNotDelivered(a),
      degrade: (a, reason, detail) => hive.mail.degradeChannel(a, reason, detail),
      restore: (a, proof, detail) => hive.mail.restoreChannel(a, proof, detail)
    }
  });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  server = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined, () => null,
    (a, e, msg, fi, turn, s) => bridge.onHook(a, e, msg, fi, turn, s));
  server.setMailCoordination({
    lifecycleActive: (a) => { const s = coordinator.state(a); return s.lifecycle === 'active' && !s.provisional; },
    wakeIds: (a) => { const s = coordinator.state(a); return s.lifecycle === 'active' && s.provisional ? [] : s.announced; },
    onEpochClosed: (a, o, r, ids) => bridge.onMailEpochClosed(a, o, r, ids),
    onMailBlock: (a) => bridge.onMailBlock(a)
  });
  hive.setDeliveryObserver(({ agentId, messageId }) => bridge.onDelivery(agentId, messageId));
  Object.assign(w, { hive, server, bridge, home });
  w.flush = async () => { for (let i = 0; i < 5; i++) { while (w.queue.length) w.queue.shift()(); await new Promise((r) => setImmediate(r)); } };
  w.fire = (agent_id, hook_event_name, extra = {}) => server.handle({ agent_id, hook_event_name, session_id: `s-${agent_id}`, transport: 'http', ...extra });
  w.rows = (kind) => hive.logTail(5000).filter((r) => r.kind === kind);
  w.send = (subject) => hive.send({ to: 'cl-1', act: 'inform', subject, body: `b-${subject}` }, 'god-1');
  w.override = () => hive.mail.channelOverride('cl-1');
  w.alert = () => hive.integrityIssues().some((i) => i.error === 'mail-channel-degraded');
  /** Wakes with no hook at all from the agent: each a send, a confirm window, a beat. */
  w.hookless = async (n) => {
    for (let k = 0; k < n; k++) { w.send(`q${w.reqs.length}`); w.now += STEP; w.bridge.reconcileAll(['cl-1']); await w.flush(); }
    w.now += STEP; w.bridge.reconcileAll(['cl-1']); await w.flush();   // the last wake's window ends
  };
  return w;
}

/**
 * Jim, 2026-10-02 (log*.jsonl): 17:46:36 a Stop-edge wake COMMITTED; 17:47:45 submit-unconfirmed and
 * a reconcile wake COMMITTED; 17:49:00 wake-ids-exhausted; no hook 17:48-17:51 (no turn ran);
 * 17:51:45 a reconcile wake COMMITTED and degraded him (wakes 3); 17:51:45.97 his hooks (turn ran),
 * 17:51:49 his Stop. Returns the world after the replay.
 */
async function jimReplay(t, m) {
  const w = await world(t, m);
  w.fire('cl-1', 'Stop');
  w.send('17:46:26 two god mails');
  await w.flush();                                         // 17:46:36 wake 1 COMMITTED (event)
  assert.equal(w.reqs.length, 1, 'wake 1');
  w.now += 69_000; w.bridge.reconcileAll(['cl-1']); await w.flush();   // 17:47:45 submit-unconfirmed + wake 2
  assert.equal(w.reqs.length, 2, 'wake 2 (reconcile)');
  w.now += 75_000; w.bridge.reconcileAll(['cl-1']); await w.flush();   // 17:49:00 wake 2 unconfirmed too
  assert.ok(w.diags.some((d) => d.stage === 'submit-unconfirmed') && w.diags.some((d) => d.stage === 'wake-ids-exhausted' || d.stage === 'submit-unconfirmed'), 'two unconfirmed wakes');
  w.send('17:51:31 creed done');
  w.now += 165_000; w.bridge.reconcileAll(['cl-1']); await w.flush();  // 17:51:45 wake 3 COMMITTED
  assert.equal(w.reqs.length, 3, 'wake 3 (reconcile)');
  w.now += 40;
  w.fire('cl-1', 'UserPromptSubmit', { prompt: w.reqs[2].text });    // 17:51:45.97: the turn ran
  w.fire('cl-1', 'PreToolUse', { tool_name: 'Bash' });
  w.now += 4_000;
  w.fire('cl-1', 'Stop');                                              // 17:51:49
  w.now += STEP; w.bridge.reconcileAll(['cl-1']); await w.flush();
  return w;
}

// ————————————————————————————————————————————————————————————— (d) the false trigger

test('(d) Jim 10-02 17:46-17:51: two wakes that never started a turn, then one whose hooks came 40 ms later: NOT degraded', async (t) => {
  const w = await jimReplay(t);
  assert.equal(w.override(), null, 'still inject');
  assert.equal(w.server.mailChannel('cl-1').mode, 'inject');
  assert.deepEqual(w.rows('mail-channel-degraded'), []);
  assert.equal(w.alert(), false);
});

test('(d) the rule still catches a dead hook channel: 3 wakes whose confirm windows end with no hook degrade, at the third window, not at the third commit', async (t) => {
  const w = await world(t);
  w.fire('cl-1', 'Stop');
  for (let k = 1; k <= MAIL_DEGRADE_AFTER_WAKES; k++) { w.send(`d${k}`); w.now += STEP; w.bridge.reconcileAll(['cl-1']); await w.flush(); }
  assert.equal(w.override(), null, 'the third wake is not judged yet');
  w.now += STEP; w.bridge.reconcileAll(['cl-1']); await w.flush();
  assert.equal(w.override()?.reason, 'zero-hook-traffic');
  const row = w.rows('mail-channel-degraded')[0];
  assert.equal(row.wakes, MAIL_DEGRADE_AFTER_WAKES);
  assert.equal(w.alert(), true);
});

// ————————————————————————————————————————————————————————————— (a) recovery on a hook

test('(a) degrade, then the agent\'s own hooks: restored at the next wake claim (override cleared, mail-channel-restored, no alert, inject), never mid-turn; the watch re-arms and a dead channel degrades again', async (t) => {
  const w = await world(t);
  w.fire('cl-1', 'Stop');
  await w.hookless(MAIL_DEGRADE_AFTER_WAKES);
  assert.equal(w.override()?.reason, 'zero-hook-traffic', 'degraded');
  assert.equal(w.server.mailChannel('cl-1').mode, 'legacy-read');
  // A status reading is not a hook: no flap on telemetry alone.
  w.fire('cl-1', 'Status', {});
  assert.equal(w.override()?.reason, 'zero-hook-traffic', 'a status reading does not restore');
  // A turn of the degraded agent: its hooks are the proof, but the turn ends in the mode it began in.
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.fire('cl-1', 'PreToolUse', { tool_name: 'Bash' });
  assert.equal(w.override()?.reason, 'zero-hook-traffic', 'no switch in the middle of a turn');
  w.fire('cl-1', 'Stop');
  // The next wake is claimed between turns: restored there, and that wake is injection again.
  const reqs = w.reqs.length;
  w.send('after the proof');
  w.now += STEP;
  await w.flush();
  assert.equal(w.reqs.length, reqs + 1, 'the next wake');
  assert.equal(w.override(), null, 'restored');
  assert.equal(w.server.mailChannel('cl-1').mode, 'inject');
  assert.equal(w.alert(), false, 'the alert is dropped');
  const row = w.rows('mail-channel-restored')[0];
  assert.deepEqual({ agentId: row.agentId, proof: row.proof, reason: row.reason, event: row.event }, { agentId: 'cl-1', proof: 'hook', reason: 'zero-hook-traffic', event: 'Stop' });
  assert.ok(w.diags.some((d) => d.stage === 'mail-channel-restored'));
  // Persisted: a new ledger over the same hive reads inject.
  w.hive.mail.flushAll();
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.hive.root(), 'state', 'mail', 'cl-1.json'), 'utf8')).channel ?? null, null, 'cleared on disk');
  // Re-armed: the hooks die again (the restoring wake brings none either), 3 hookless wakes degrade again.
  await w.hookless(MAIL_DEGRADE_AFTER_WAKES);
  assert.equal(w.override()?.reason, 'zero-hook-traffic', 'degraded again');
  assert.equal(w.rows('mail-channel-degraded').length, 2);
});

test('(a) a hook never undoes a no-mail-block degrade (hooks were never the problem there)', async (t) => {
  const w = await world(t);
  w.hive.mail.degradeChannel('cl-1', 'no-mail-block', {});
  w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
  w.fire('cl-1', 'Stop');
  assert.equal(w.override()?.reason, 'no-mail-block');
  assert.deepEqual(w.rows('mail-channel-restored'), []);
});

// ————————————————————————————————————————————————————————————— (b) persistence and respawn

test('(b) the override survives an app restart (persisted), and the next spawn undoes it, for either reason', async (t) => {
  for (const reason of ['zero-hook-traffic', 'no-mail-block']) {
    const w = await world(t);
    w.hive.mail.degradeChannel('cl-1', reason, {});
    w.hive.mail.flushAll();
    // An app restart: a new HiveManager over the same hive reads the override back.
    const { HiveManager } = mods();
    const again = new HiveManager(() => w.home, () => true);
    t.after(() => again.dispose());
    assert.equal(again.mail.channelOverride('cl-1')?.reason, reason, `${reason}: persisted across a restart`);
    await again.ensureAgent({ id: 'cl-1', name: 'cl-1', provider: 'claude', cwd: w.home });
    assert.equal(again.mail.channelOverride('cl-1'), null, `${reason}: undone at the spawn`);
    const row = again.logTail(5000).filter((r) => r.kind === 'mail-channel-restored').pop();
    assert.deepEqual({ proof: row.proof, reason: row.reason }, { proof: 'respawn', reason });
    assert.equal(again.integrityIssues().some((i) => i.error === 'mail-channel-degraded'), false);
  }
});

test('(b) Codex: the first spawn after a degrade applies it (the legacy prompt reaches the session), the next one undoes it', async (t) => {
  const w = await world(t);
  await w.hive.ensureAgent({ id: 'cx-1', name: 'cx-1', provider: 'codex', cwd: w.home });
  w.hive.mail.degradeChannel('cx-1', 'no-mail-block', {});
  await w.hive.ensureAgent({ id: 'cx-1', name: 'cx-1', provider: 'codex', cwd: w.home });
  const o = w.hive.mail.channelOverride('cx-1');
  assert.equal(o?.reason, 'no-mail-block', 'kept by the spawn that applies it');
  assert.ok(o.applied > 0, 'marked applied');
  assert.deepEqual(w.rows('mail-channel-restored'), []);
  await w.hive.ensureAgent({ id: 'cx-1', name: 'cx-1', provider: 'codex', cwd: w.home });
  assert.equal(w.hive.mail.channelOverride('cx-1'), null, 'undone by the next spawn');
  assert.equal(w.rows('mail-channel-restored')[0]?.proof, 'respawn');
});

// ————————————————————————————————————————————————————————————— mutants

const MUTANTS = [
  {
    name: '(d) a wake counted at its commit (the 1.1.88 rule)', file: BRIDGE,
    from: '    w.unjudged = this.deps.now();\n',
    to: "    w.unjudged = 0; w.quiet += 1;\n    if (w.quiet >= MAIL_DEGRADE_AFTER_WAKES) this.degrade(agentId, w, 'zero-hook-traffic', { wakes: w.quiet });\n",
    // (a) would restore Jim at his next hook, so the degrade itself is what must not happen.
    run: async (t, m) => { const w = await jimReplay(t, m); return w.override() === null && w.rows('mail-channel-degraded').length === 0; }
  },
  {
    name: '(a) no restore on a hook', file: BRIDGE,
    from: '      this.hookProof.set(agentId, event);\n', to: '',
    run: async (t, m) => {
      const w = await world(t, m);
      w.fire('cl-1', 'Stop');
      await w.hookless(MAIL_DEGRADE_AFTER_WAKES);
      w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
      w.fire('cl-1', 'Stop');
      w.send('after the proof'); w.now += STEP; await w.flush();
      return w.override() === null;
    }
  },
  {
    name: '(a) restored on the hook itself, mid-turn', file: BRIDGE,
    from: '      this.hookProof.set(agentId, event);\n', to: '      this.restoreOnHook(agentId, event);\n',
    run: async (t, m) => {
      const w = await world(t, m);
      w.fire('cl-1', 'Stop');
      await w.hookless(MAIL_DEGRADE_AFTER_WAKES);
      w.fire('cl-1', 'UserPromptSubmit', { prompt: 'go' });
      return w.override()?.reason === 'zero-hook-traffic';
    }
  },
  {
    name: '(b) no restore at a spawn', file: HIVE,
    from: "    try { this.mail.restoreChannel(meta.id, 'respawn', {}, { applyFirst: normalizeAgentProvider(meta.provider) === 'codex' }); } catch (e) { console.warn('[hive] mail channel restore failed:', e); }\n", to: '',
    run: async (t, m) => {
      const w = await world(t, m);
      w.hive.mail.degradeChannel('cl-1', 'zero-hook-traffic', {});
      await w.hive.ensureAgent({ id: 'cl-1', name: 'cl-1', provider: 'claude', cwd: w.home });
      return w.override() === null;
    }
  }
];

test('the real code passes every mutant scenario', async (t) => {
  for (const mu of MUTANTS) assert.equal(await mu.run(t, mods()), true, `${mu.name}: passes unmutated`);
});

for (const mu of MUTANTS) {
  test(`MUTANT caught: ${mu.name}`, async (t) => {
    const text = src(mu.file);
    assert.equal(text.split(mu.from).length, 2, 'the mutated text is in the source once');
    const ok = await mu.run(t, mods({ [mu.file]: text.replace(mu.from, mu.to) }));
    assert.equal(ok, false, 'the scenario fails under the mutant');
  });
}
