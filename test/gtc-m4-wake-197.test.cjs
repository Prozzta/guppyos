'use strict';

/**
 * GTC M4 (1.1.97): agent wakes through hook readiness, a typed send and the provider's own
 * DELIVERED event (src/main/wakeSender.ts), and the Stop-continue wake mid-turn (HookServer +
 * the wake coordinator). The screen gate only shadows. Design: agents/andy-mtuk4y4x/
 * GOD-TERMINAL-CONTROL-DESIGN.md section 15 and 15.10 (Jim 82a3ae: MUST 1-3, SHOULD 1-2, INFO 1-2).
 *
 * Two rigs. `sender()` is the WakeSender alone on fakes. `floor()` is a real (jailed) hive, a real
 * HookServer, the real coordinator and bridge wired as src/main/index.ts wires them, and the
 * WakeSender as the bridge's submit, the turn observer and the Stop-continue. HOME, USERPROFILE,
 * CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-gtc-m4-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const WS = loadTs('src/main/wakeSender.ts');
const { WakeSender, wakePathOf, stopContinueOn, wakeMatch, idSetOf, STOP_CONFIRM_MS, WAKE_CONFIRM_MS, WAKE_BOOT_READY_MS, CODEX_STOP_MAIL_BUDGET } = WS;
const { AutomaticSubmitOwner, payloadFor } = loadTs('src/main/automaticSubmit.ts');
const { CODEX_INBOX_WAKE_SENTINEL, inboxWakeTextForProvider } = loadTs('src/shared/hiveNudge.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { WorkerWakeWatchdog, SUBMIT_CONFIRM_MS } = loadTs('src/main/workerWake.ts');
const { coordinatorPendingIds } = loadTs('src/main/mailReaders.ts');

const IDLE = { lifecycle: 'idle', activeSince: 0, turnStartAt: 10, lastTurnEndAt: 20 };
const markersIn = (text) => [...(text ?? '').matchAll(/\[hive-mail:([^\]]+)\]/g)].map((m) => m[1]);
const ID_A = '2026-10-19T03-00-00-000Z-aaaaaa';
const ID_B = '2026-10-19T04-00-00-000Z-bbbbbb';
const nudge = (ids) => inboxWakeTextForProvider('claude', ids);
const reqFor = (ids, over = {}) => ({ requestId: `inbox-wake:a1:${ids.join('+')}:1`, agentId: 'a1', admissionClass: 'CAPACITY_GATED', text: nudge(ids), ...over });

/** The terminal and the deps every rig shares: one virtual clock, one prompt line. */
function fakes(w) {
  return {
    ptyOf: (agentId) => (agentId === 'nobody' ? undefined : `pty-${agentId}`),
    providerOf: () => w.provider,
    idleFacts: (agentId) => w.facts(agentId),
    spawnedAt: () => w.spawnedAt,
    promptBlock: () => w.block,
    lastHumanInputAt: () => w.lastHuman,
    humanGeneration: () => w.gen,
    inhibited: () => w.inhibited(),
    mirrorNeedle: async (_p, needle) => {
      w.reads = (w.reads ?? 0) + 1;
      if (w.mirror !== 'on') return { reading: null, reason: w.mirror };
      return { reading: { onPromptRow: w.prompt.includes(needle) } };
    },
    exclusive: async (_p, fn) => ({ ran: true, value: await fn() }),
    slot: (_a, fn) => fn(),
    settle: async () => { if (w.inGap) { const f = w.inGap; w.inGap = null; f(); } },
    write: (_p, data) => {
      w.writes.push(data);
      if (data === '\r') { w.prompt = ''; w.entered += 1; } else if (w.showsText) w.prompt += data;
      return { ok: true };
    },
    ownerSubmit: async (r) => { w.owner.push(r); return { kind: 'COMMITTED' }; },
    admit: () => ({ proceed: w.capacity, basis: w.capacity ? 'FRESH_HEALTHY' : 'LIMITED', decision: { grant: (w.grantSeq += 1) } }),
    confirmLaunch: (d) => w.grants.push(['confirm', d.grant]),
    cancelGrant: (d) => w.grants.push(['cancel', d.grant]),
    holdTyped: (ptyId, r, reason, detail) => w.holds.push({ ptyId, requestId: r.requestId, reason, detail }),
    claimAtStop: (agentId) => w.claimAtStop(agentId),
    settleAtStop: (claim, blocked) => w.settleAtStop(claim, blocked),
    log: (row) => w.rows.push(row),
    now: () => w.now,
    sleep: async () => {},
    setTimer: (fn, ms) => { w.timers.push({ at: w.now + ms, fn }); return w.timers.length; }
  };
}

function base(over = {}) {
  return {
    now: 1_000_000, provider: 'claude', spawnedAt: 1, block: undefined, lastHuman: undefined, gen: 0, mirror: 'on',
    prompt: '', showsText: true, writes: [], entered: 0, owner: [], grants: [], grantSeq: 0, holds: [], rows: [], timers: [],
    capacity: true, inGap: null, path: 'term', stop: { claude: true, codex: true, antigravity: true },
    inhibited: () => false, facts: () => ({ ...IDLE }), claimAtStop: () => null, settleAtStop: () => {},
    shadow: { codexFacts: async () => ({ reading: null, reason: 'mirror-off' }) },
    ...over
  };
}

function sender(over = {}) {
  const w = base(over);
  w.d = fakes(w);
  w.ws = new WakeSender(w.d, w.shadow, () => ({ path: w.path, stopContinue: w.stop }));
  w.tick = (ms) => { w.now += ms; const due = w.timers.filter((t) => t.at <= w.now); w.timers = w.timers.filter((t) => t.at > w.now); for (const t of due) t.fn(); };
  w.rowsOf = (kind) => w.rows.filter((r) => r.kind === kind);
  return w;
}
const flushP = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// ─── config: 'owner' is the default; Stop-continue is per provider and term only ─────────────

test('wakePathOf: only "term" is the new path; the 1.1.97 default is the owner', () => {
  assert.equal(wakePathOf('term'), 'term');
  for (const v of [undefined, null, 'owner', 'TERM', 1, {}]) assert.equal(wakePathOf(v), 'owner');
});

test('stopContinueOn: a literal true per provider, on the term path only', () => {
  assert.equal(stopContinueOn('term', { claude: true }, 'claude'), true);
  assert.equal(stopContinueOn('owner', { claude: true }, 'claude'), false, 'never on the owner path');
  assert.equal(stopContinueOn('term', { claude: 'yes' }, 'claude'), false);
  assert.equal(stopContinueOn('term', { claude: true }, 'codex'), false);
  assert.equal(stopContinueOn('term', { gemini: true }, 'gemini'), false, 'only Claude, Codex and AGY');
  assert.equal(stopContinueOn('term', undefined, 'claude'), false);
});

test("'owner' path: the owner, byte for byte, for every class; nothing typed here", async () => {
  const w = sender({ path: 'owner' });
  const req = reqFor([ID_A], { priorText: 'x', settleMs: 7 });
  assert.deepEqual(await w.ws.submit(req), { kind: 'COMMITTED' });
  assert.equal(w.owner.length, 1);
  assert.equal(w.owner[0], req, 'the same request object');
  assert.deepEqual(w.writes, []);
});

test('term path: a class that is not a wake or a boot prompt is the owner\'s', async () => {
  const w = sender();
  await w.ws.submit(reqFor([ID_A], { admissionClass: 'USER_RELEASED' }));
  assert.equal(w.owner.length, 1);
  assert.deepEqual(w.writes, []);
});

// ─── the inbox wake: gates, the send, TYPED_NOT_SENT ─────────────────────────────────────────

test('idle: the nudge as today\'s bytes, ONE Enter, the grant confirmed; COMMITTED via term', async () => {
  const w = sender();
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.deepEqual(o, { kind: 'COMMITTED', via: 'term' });
  assert.deepEqual(w.writes, [payloadFor(nudge([ID_A])), '\r']);
  assert.deepEqual(w.grants, [['confirm', 1]]);
  assert.equal(w.rowsOf('wake-send')[0].outcome, 'COMMITTED');
});

test('the gates refuse with nothing typed and the grant returned', async () => {
  const cases = [
    [{ facts: () => ({ lifecycle: 'active', activeSince: 5, turnStartAt: 5, lastTurnEndAt: 1 }) }, 'NOT_IDLE'],
    [{ inhibited: () => true }, 'PTY_INHIBITED'],
    [{ block: 'draft' }, 'HUMAN_DRAFT'],
    [{ block: 'picker' }, 'PICKER_OPEN'],
    [{ block: 'settling' }, 'PROMPT_SETTLING'],
    [{ block: 'exited' }, 'TERMINAL_EXITED'],
    [{ lastHuman: 1_000_000 - 100 }, 'HUMAN_TYPING'],
    [{ capacity: false }, 'CAPACITY_HOLD']
  ];
  for (const [over, reason] of cases) {
    const w = sender(over);
    const o = await w.ws.submit(reqFor([ID_A]));
    if (reason === 'CAPACITY_HOLD') assert.deepEqual(w.grants, [['cancel', 1]], 'the refused grant goes back');
    assert.equal(o.kind, 'REFUSED', reason);
    assert.equal(o.reason, reason);
    assert.deepEqual(w.writes, [], `${reason}: nothing typed`);
    assert.ok(!w.grants.some(([k]) => k === 'confirm'), `${reason}: no grant spent`);
    assert.deepEqual(w.ws.counters(), {}, `${reason}: no shadow row for a refusal`);
  }
  assert.equal((await sender().ws.submit({ ...reqFor([ID_A]), agentId: 'nobody' })).reason, 'NO_PTY');
});

test('M3 MUST 1 kept: the gates run AGAIN inside the slot, right before the write', async () => {
  const w = sender();
  w.d.exclusive = async (_p, fn) => { w.block = 'draft'; return { ran: true, value: await fn() }; };
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.equal(o.reason, 'HUMAN_DRAFT');
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.grants, [['cancel', 1]]);
});

test('15.7 doubleSubmit: a wake for ids still awaiting their confirm, or delivered within 10 min, is counted', async () => {
  const w = sender();
  const r1 = reqFor([ID_A]);
  await w.ws.submit(r1);
  await w.ws.submit({ ...r1, requestId: r1.requestId.replace(/:1$/, ':2') });
  assert.equal(w.ws.counters().claude.doubleSubmit, 1, 'the first is still in flight');
  w.ws.noteHook('a1', 'UserPromptSubmit', { prompt: nudge([ID_A]) });
  await w.ws.submit({ ...r1, requestId: r1.requestId.replace(/:1$/, ':3') });
  assert.equal(w.ws.counters().claude.doubleSubmit, 2, 'delivered a moment ago');
  await w.ws.submit(reqFor([ID_B]));
  assert.equal(w.ws.counters().claude.doubleSubmit, 2, 'other ids are not a double');
});

test('Q3: an unknown lifecycle (after a restart) is the owner\'s, and counted', async () => {
  const w = sender({ facts: () => ({ lifecycle: 'unknown', activeSince: 0, turnStartAt: 0, lastTurnEndAt: 0 }) });
  await w.ws.submit(reqFor([ID_A]));
  assert.equal(w.owner.length, 1);
  assert.deepEqual(w.ws.counters().claude.ownerFallback, { 'lifecycle-unknown': 1 });
});

test('no mirror reading: the owner (mirror-<reason>); priorText: the owner', async () => {
  const w = sender({ mirror: 'mirror-off' });
  await w.ws.submit(reqFor([ID_A]));
  await w.ws.submit(reqFor([ID_B], { priorText: 'old nudge' }));
  assert.equal(w.owner.length, 2);
  assert.deepEqual(w.ws.counters().claude.ownerFallback, { 'mirror-mirror-off': 1, 'prior-text': 1 });
  assert.deepEqual(w.writes, []);
});

test('Q4 TYPED_NOT_SENT: a person\'s key in the gap = INTERFERED, no Enter, grant cancelled, held by the owner', async () => {
  const w = sender();
  w.inGap = () => { w.gen += 1; };
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.deepEqual(o, { kind: 'INTERFERED', reason: 'WAKE_TYPED_NOT_SENT', detail: 'HUMAN_TYPED', via: 'term' });
  assert.equal(w.entered, 0, 'never an Enter');
  // The gap check answers before the confirm look: the pre-type probe is the only mirror read
  // (WAKE-FALSE-INTERFERED-RESTART widened the look to 3 s; a key already seen never starts it).
  assert.equal(w.reads, 1, 'a key in the gap is answered before any look at the screen');
  assert.deepEqual(w.grants, [['cancel', 1]]);
  assert.deepEqual(w.holds, [{ ptyId: 'pty-a1', requestId: reqFor([ID_A]).requestId, reason: 'WAKE_TYPED_NOT_SENT', detail: 'HUMAN_TYPED' }]);
  let held = true;
  w.inhibited = () => held;
  assert.deepEqual(await w.ws.submit(reqFor([ID_A])), o, 'replayed while held: the same id is never typed twice');
  assert.equal(w.writes.length, 1);
  assert.deepEqual(w.owner, []);
  held = false;
  await w.ws.submit(reqFor([ID_A]));
  await w.ws.submit(reqFor([ID_A]));
  assert.equal(w.owner.length, 2, 'ruled on by a person: the owner\'s from now on (HUMAN_HANDLED or its own send)');
  assert.equal(w.writes.length, 1, 'never typed here again');
  await flushP();
  assert.equal(w.ws.counters().claude.typedNotSent, 1);
});

test('NOT_IN_COMPOSER (an inbox wake): INTERFERED and held; the text was typed once', async () => {
  const w = sender({ showsText: false });
  const o = await w.ws.submit(reqFor([ID_A]));
  assert.equal(o.reason, 'WAKE_TYPED_NOT_SENT');
  assert.equal(o.detail, 'NOT_IN_COMPOSER');
  assert.equal(w.entered, 0);
});

test('the owner\'s hold for a typed wake: a recheck never erases or re-Enters; both rulings release it', async () => {
  const writes = [];
  let gen = 3;
  const owner = new AutomaticSubmitOwner({
    resolvePty: () => 'pty-a1', incarnation: () => 1, humanGeneration: () => gen,
    write: (_p, d) => { writes.push(d); return { ok: true }; }, terminalReady: () => 'READY', eligibility: () => ({ eligible: true }),
    promptBlock: () => null, lastHumanInputAt: () => undefined, abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 300 }),
    readScreen: async () => ({ onPromptRow: true, screenCount: 1 }),
    capacity: { admit: () => ({ verdict: 'ALLOW', reason: 'FRESH_HEALTHY' }), revalidate: () => ({ verdict: 'ALLOW' }), confirmLaunch: () => {}, cancelGrant: () => {}, holdGrant: () => {} },
    now: () => 5, setTimer: () => 0
  });
  const seen = [];
  owner.deps.onInterfered = (r) => seen.push(['interfered', r.reason, r.detail]);
  owner.deps.onOutcome = (r) => seen.push(['outcome', r.outcome.kind, r.outcome.reason]);
  const req = reqFor([ID_A]);
  owner.holdTyped('pty-a1', req, 'WAKE_TYPED_NOT_SENT', 'HUMAN_TYPED');
  assert.equal(owner.inhibition('pty-a1').reason, 'WAKE_TYPED_NOT_SENT');
  assert.deepEqual(seen, [['interfered', 'WAKE_TYPED_NOT_SENT', 'HUMAN_TYPED'], ['outcome', 'INTERFERED', 'WAKE_TYPED_NOT_SENT']]);
  assert.deepEqual(await owner.recheckHeld('pty-a1', req.requestId), { kind: 'HELD', why: 'typed-not-sent', screen: null });
  assert.deepEqual(writes, [], 'the recheck wrote nothing (our text IS on the prompt row)');
  owner.holdTyped('pty-a1', reqFor([ID_B]), 'WAKE_TYPED_NOT_SENT', 'x');
  assert.equal(owner.inhibition('pty-a1').requestId, req.requestId, 'an earlier hold stands');
  assert.equal(owner.resolveInterference('pty-a1', 'SEND_AGAIN'), true);
  assert.equal(owner.inhibition('pty-a1'), null);
  owner.holdTyped('pty-a1', req, 'WAKE_TYPED_NOT_SENT', 'x');
  assert.equal(owner.resolveInterference('pty-a1', 'ALREADY_HANDLED'), true);
  assert.deepEqual(await owner.submit(req), { kind: 'HUMAN_HANDLED' }, 'handled by the person: never typed by the owner either');
  assert.deepEqual(writes, []);
  gen += 0;
});

// ─── DELIVERED: MUST 1 (the whole nudge), SHOULD 2 (the sentinel, by-writer) ─────────────────

test('MUST 1: wakeMatch needs the WHOLE nudge; two wakes on the same day are told apart', () => {
  assert.equal(wakeMatch(nudge([ID_A]), nudge([ID_A])), true);
  assert.equal(wakeMatch(`  ${nudge([ID_A])}\n`, nudge([ID_A])), true, 'whitespace is normalized');
  assert.equal(nudge([ID_A]).slice(0, 64), nudge([ID_B]).slice(0, 64), 'the 64-char head IS the same (the M3 fingerprint)');
  assert.equal(wakeMatch(nudge([ID_A]), nudge([ID_B])), false);
  assert.equal(wakeMatch('', ''), false);
});

test('MUST 1: the first wake\'s UserPromptSubmit does not confirm the second (same day, other id)', async () => {
  const w = sender();
  await w.ws.submit(reqFor([ID_A]));
  w.ws.noteHook('a1', 'UserPromptSubmit', { prompt: nudge([ID_A]) });
  assert.equal(w.rowsOf('wake-confirm')[0].by, 'send-id');
  await w.ws.submit(reqFor([ID_B]));
  w.ws.noteHook('a1', 'UserPromptSubmit', { prompt: nudge([ID_A]) });
  assert.equal(w.rowsOf('wake-confirm').length, 1, 'the late copy of wake 1 confirms nothing');
  w.tick(WAKE_CONFIRM_MS);
  const last = w.rowsOf('wake-confirm').at(-1);
  assert.equal(last.confirm, 'UNKNOWN');
  assert.equal(w.rowsOf('wake-attention').length, 1);
});

test('SHOULD 2: Codex: the sentinel UPS confirms by-writer; with no wake in flight it confirms nothing', async () => {
  const w = sender({ provider: 'codex' });
  w.ws.noteHook('a1', 'UserPromptSubmit', { prompt: CODEX_INBOX_WAKE_SENTINEL });
  assert.equal(w.rowsOf('wake-confirm').length, 0);
  assert.equal(w.rowsOf('wake-confirm-orphan').length, 1);
  await w.ws.submit({ ...reqFor([ID_A]), text: CODEX_INBOX_WAKE_SENTINEL });
  w.ws.noteHook('a1', 'UserPromptSubmit', { prompt: 'a person typed this' });
  assert.equal(w.rowsOf('wake-confirm').length, 0, "a person's own prompt is not ours");
  w.ws.noteHook('a1', 'UserPromptSubmit', { prompt: CODEX_INBOX_WAKE_SENTINEL });
  assert.equal(w.rowsOf('wake-confirm')[0].confirm, 'DELIVERED');
  assert.equal(w.rowsOf('wake-confirm')[0].by, 'writer');
});

test('AGY: a PreInvocation after the send is CORRELATED (Q2)', async () => {
  const w = sender({ provider: 'antigravity' });
  await w.ws.submit(reqFor([ID_A]));
  w.ws.noteHook('a1', 'PreInvocation', {});
  assert.equal(w.rowsOf('wake-confirm')[0].confirm, 'DELIVERED-CORRELATED');
});

// ─── boot: SHOULD 1 ──────────────────────────────────────────────────────────────────────────

const bootReq = (over = {}) => ({ requestId: 'boot:a1:1', agentId: 'a1', admissionClass: 'BOOT_SEQUENCE', text: 'You are Andy. Read PROTOCOL.md and start.', ...over });

test('SHOULD 1: a Claude boot waits for this incarnation\'s SessionStart + 1 s; no capacity ask', async () => {
  const w = sender({ spawnedAt: 999_000 });
  assert.equal((await w.ws.submit(bootReq())).reason, 'TERMINAL_NOT_READY');
  w.ws.noteHook('a1', 'SessionStart', { source: 'startup' });
  assert.equal((await w.ws.submit(bootReq())).reason, 'TERMINAL_NOT_READY', 'not inside the settle');
  w.tick(1_000);
  assert.deepEqual(await w.ws.submit(bootReq()), { kind: 'COMMITTED', via: 'term' });
  assert.deepEqual(w.grants, [], 'a boot prompt asks no capacity');
  assert.deepEqual(await w.ws.submit(bootReq()), { kind: 'COMMITTED', via: 'term' }, 'replayed');
  assert.equal(w.entered, 1);
});

test('SHOULD 1: Codex boot is the owner\'s (lazy SessionStart); no ready event in 20 s = the owner', async () => {
  const c = sender({ provider: 'codex' });
  await c.ws.submit(bootReq());
  assert.deepEqual(c.ws.counters().codex.ownerFallback, { 'boot-codex-lazy-session-start': 1 });
  const w = sender({ spawnedAt: 1_000_000 });
  assert.equal((await w.ws.submit(bootReq())).reason, 'TERMINAL_NOT_READY');
  w.tick(WAKE_BOOT_READY_MS);
  await w.ws.submit(bootReq());
  assert.equal(w.owner.length, 1);
  assert.deepEqual(w.writes, []);
});

test('SHOULD 1: AGY boot: lifecycle idle held for 1 s', async () => {
  const w = sender({ provider: 'antigravity', spawnedAt: 999_000 });
  assert.equal((await w.ws.submit(bootReq())).reason, 'TERMINAL_NOT_READY');
  w.tick(1_000);
  assert.equal((await w.ws.submit(bootReq())).kind, 'COMMITTED');
});

test('SHOULD 1: boot not in the composer (no key) = the owner with our text as prior text, for every retry', async () => {
  const w = sender({ spawnedAt: 999_000, showsText: false });
  w.ws.noteHook('a1', 'SessionStart', { source: 'startup' });
  w.tick(1_000);
  await w.ws.submit(bootReq());
  await w.ws.submit(bootReq());
  assert.equal(w.writes.length, 1, 'typed here once, never again');
  assert.equal(w.owner.length, 2);
  for (const r of w.owner) assert.equal(r.priorText, bootReq().text);
  assert.deepEqual(w.holds, [], 'not held');
});

test('SHOULD 1: a boot with a person\'s key in the gap is held as BOOT_NOT_SUBMITTED', async () => {
  const w = sender({ spawnedAt: 999_000 });
  w.ws.noteHook('a1', 'SessionStart', { source: 'startup' });
  w.tick(1_000);
  w.inGap = () => { w.gen += 1; };
  const o = await w.ws.submit(bootReq());
  assert.equal(o.reason, 'BOOT_NOT_SUBMITTED');
  assert.equal(w.holds[0].reason, 'BOOT_NOT_SUBMITTED');
});

// ─── the shadow: INFO 2 ──────────────────────────────────────────────────────────────────────

test('INFO 2: the shadow is read only and never decides: its deps hold codexFacts and nothing else', async () => {
  const touched = [];
  const shadow = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); if (k === 'codexFacts') return async () => ({ reading: { onPromptRow: false, screenCount: 0, codex: { promptRow: null } }, reason: undefined }); if (k === 'then') return undefined; throw new Error(`shadow touched ${String(k)}`); } });
  const w = sender({ shadow });
  assert.deepEqual(await w.ws.submit(reqFor([ID_A])), { kind: 'COMMITTED', via: 'term' }, 'a screen that would refuse decides nothing');
  w.ws.noteHook('a1', 'UserPromptSubmit', { prompt: nudge([ID_A]) });
  await flushP();
  assert.deepEqual([...new Set(touched)].filter((k) => k !== 'then'), ['codexFacts']);
  const c = w.ws.counters().claude;
  assert.equal(c.delivered, 1);
  assert.equal(c.screenRefusedButDelivered, 1);
  const src = codeOnly(readSource('src/main/wakeSender.ts'));
  const iface = src.slice(src.indexOf('export interface WakeShadowDeps'), src.indexOf('}', src.indexOf('export interface WakeShadowDeps')));
  assert.deepEqual([...iface.matchAll(/^\s+(\w+)\(/gm)].map((m) => m[1]), ['codexFacts']);
  const fn = src.slice(src.indexOf('export async function shadowClass'), src.indexOf('\n}\n', src.indexOf('export async function shadowClass')));
  assert.ok(!/write|settle|align|\\x1b|sd\.(?!codexFacts)/.test(fn), 'shadowClass calls nothing but codexFacts');
});

// ─── the floor: Stop-continue (MUST 2, MUST 3, INFO 1) ───────────────────────────────────────

async function floor(t, { provider = 'claude', stop = { claude: true, codex: true, antigravity: true } } = {}) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  const w = base({ provider, stop, reqs: [], queue: [], diags: [] });
  let server = null;
  t.after(() => { try { server?.stop(); } catch { /* noop */ } hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'a1', name: 'a1', provider: 'claude', cwd: home });
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r = reg(); r.agents.a1 = { ...r.agents.a1, provider }; return r; };
  const coordinator = new WorkerWakeWatchdog();
  const pending = (a) => coordinatorPendingIds(a, {
    mode: (x) => server.mailChannel(x).mode, pending: (x) => hive.mail.pending(x), skipped: (x) => server.mailSkippedIds(x), files: (x) => hive.inbox(x).map((m) => m.id)
  });
  w.facts = (a) => coordinator.livenessFacts(a);
  w.d = fakes(w);
  const ws = new WakeSender(w.d, w.shadow, () => ({ path: w.path, stopContinue: w.stop }));
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: pending,
    facts: (a) => ({ ptyId: `pty-${a}`, lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false, inhibited: false }),
    submit: (req) => { w.reqs.push(req); return ws.submit(req); },
    text: (ids, a) => inboxWakeTextForProvider(a ? provider : undefined, [...ids]),
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
      degrade: (a, reason, detail) => hive.mail.degradeChannel(a, reason, detail)
    }
  });
  w.claimAtStop = (a) => bridge.claimAtStop(a);
  w.settleAtStop = (c, b) => bridge.settleAtStop(c, b);
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  server = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined, () => null,
    (a, e, m, fi, turn, src) => bridge.onHook(a, e, m, fi, turn, src));
  server.setMailCoordination({
    lifecycleActive: (a) => { const s = coordinator.state(a); return s.lifecycle === 'active' && !s.provisional; },
    wakeIds: (a) => { const s = coordinator.state(a); return s.lifecycle === 'active' && s.provisional ? [] : s.announced; },
    onEpochClosed: (a, o, r, ids) => bridge.onMailEpochClosed(a, o, r, ids),
    onMailBlock: (a) => bridge.onMailBlock(a)
  });
  server.setStopContinue({ stopClaim: (a) => ws.stopClaim(a), stopSettle: (a, id, b, n) => ws.stopSettle(a, id, b, n) });
  server.setTurnObserver((a, e, f) => ws.noteHook(a, e, f));
  hive.setDeliveryObserver(({ agentId, messageId }) => bridge.onDelivery(agentId, messageId));
  Object.assign(w, { hive, server, bridge, coordinator, ws });
  w.flush = async () => { for (let i = 0; i < 8; i++) { while (w.queue.length) w.queue.shift()(); await flushP(); } };
  w.fire = (hook_event_name, extra = {}) => { w.now += 1_000; return server.handle({ agent_id: 'a1', hook_event_name, session_id: 's-a1', transport: 'http', ...extra }); };
  w.entry = (id) => hive.mail.ledger('a1').entries[id];
  w.send = (extra = {}) => hive.send({ to: 'a1', act: 'inform', subject: 's', body: 'the body', ...extra }, 'god-1');
  w.tick = (ms) => { w.now += ms; const due = w.timers.filter((x) => x.at <= w.now); w.timers = w.timers.filter((x) => x.at > w.now); for (const x of due) x.fn(); };
  w.beat = async (ms) => { w.tick(ms); bridge.reconcileAll(['a1']); await w.flush(); };
  w.rowsOf = (kind) => w.rows.filter((r) => r.kind === kind);
  return w;
}

/** A turn is running (the provider's own prompt), and mail lands in it. */
async function turnWithMail(w, extra = {}) {
  w.fire(w.provider === 'antigravity' ? 'PreInvocation' : 'UserPromptSubmit', { prompt: 'go', ...extra });
  await w.flush();
  const m = w.send();
  await w.flush();
  assert.deepEqual(w.reqs, [], 'mid-turn: no wake');
  return m;
}

test('MUST 2: the Stop block carries the <hive-mail> block itself, claimed in THIS epoch with hookKind Stop', async (t) => {
  const w = await floor(t);
  const m1 = await turnWithMail(w);
  const epoch = w.server.mailEpoch('a1');
  const res = w.fire('Stop');
  assert.equal(res.decision, 'block');
  assert.match(res.reason, /<hive-mail/);
  assert.deepEqual(markersIn(res.reason), [m1.id]);
  const st = w.coordinator.state('a1');
  assert.ok(st.announced.includes(m1.id) && !st.pending.includes(m1.id), 'the Stop-continue spent the ids (COMMITTED, not REFUSED)');
  const e = w.entry(m1.id);
  assert.equal(e.state, 'surfacing');
  assert.equal(e.hookKind, 'Stop');
  assert.equal(e.epoch, epoch, 'the turn\'s own epoch, kept open');
  assert.equal(w.server.takeMailClaims().length, 1, 'the transport settles the claim at the flush, as at UPS');
  const stop = w.rowsOf('wake-stop')[0];
  assert.equal(stop.outcome, 'BLOCKED');
  assert.equal(stop.reasonChars, res.reason.length);
  // The continued turn: its next hook does not inject the same mail again.
  const post = w.fire('PostToolUse', { tool_name: 'Read', tool_input: {} });
  assert.deepEqual(markersIn(post?.hookSpecificOutput?.additionalContext ?? ''), [], 'not injected a second time');
  assert.equal(w.rowsOf('wake-confirm')[0].by, 'stop');
  // Its Stop (stop_hook_active) is not blocked and closes the epoch: the id is acted.
  w.server.takeMailClaims();
  w.hive.mail.confirmSurfaced('a1', [m1.id], epoch, 'evidence');
  const end = w.fire('Stop', { stop_hook_active: true });
  assert.equal(end.decision, undefined);
  w.hive.mail.flushAll();
  assert.equal(w.entry(m1.id).state, 'acted');
  await w.flush();
  assert.deepEqual(w.reqs, [], 'never a typed wake for that mail');
  assert.equal(w.ws.counters().claude?.doubleSubmit, undefined);
});

/** Codex keeps a Stop block's reason in its rollout as one user message, wrapped and escaped
 *  (the live shape: test/fixtures/codex-stop-hook-prompt-0.157.1.jsonl). */
function codexHookPromptLine(run, reason) {
  const text = `<hook_prompt hook_run_id="${run}:7:C:\\x\\.codex\\config.toml">${reason.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</hook_prompt>`;
  return `${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } })}\n`;
}

for (const [run, kept] of [['stop', true], ['user_prompt_submit', false]]) {
  test(`GTC stop-continue (Codex): the rollout's ${run} hook_prompt ${kept ? 'confirms the Stop-surfaced id; it is acted and never typed again' : 'is not evidence: the id goes back unconfirmed and is typed again'}`, async (t) => {
    const w = await floor(t, { provider: 'codex' });
    const dir = fs.mkdtempSync(path.join(JAIL, 'rollout-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ro = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(ro, '');
    const m1 = await turnWithMail(w, { turn_id: 'T1', transcript_path: ro });
    const res = w.fire('Stop', { turn_id: 'T1', transcript_path: ro });
    assert.equal(res.decision, 'block');
    assert.deepEqual(markersIn(res.reason), [m1.id]);
    w.server.takeMailClaims();
    fs.appendFileSync(ro, codexHookPromptLine(run, res.reason));
    w.fire('Stop', { turn_id: 'T1', transcript_path: ro, stop_hook_active: true });
    w.hive.mail.flushAll();
    await w.flush();
    const e = w.entry(m1.id);
    if (kept) {
      assert.deepEqual({ state: e.state, method: e.confirmMethod }, { state: 'acted', method: 'evidence' });
      assert.deepEqual(w.reqs, [], 'no duplicate turn');
    } else {
      assert.notEqual(e.state, 'acted', 'not confirmed: returned to be surfaced again');
      assert.equal(e.unconfirmedSurfacings, 1);
    }
  });
}

test('MUST 2: a ledger error at the claim = no block; the ids go back and the Stop edge wakes as today', async (t) => {
  const w = await floor(t);
  const m1 = await turnWithMail(w);
  w.hive.mail.claimSurfacing = () => { throw new Error('ledger down'); };
  const res = w.fire('Stop');
  assert.equal(res.decision, undefined, 'the Stop stays non-blocking');
  assert.equal(w.rowsOf('wake-stop')[0].outcome, 'NOT_BLOCKED');
  assert.deepEqual(w.grants.filter(([k]) => k === 'cancel').length, 1, 'the grant went back');
  await w.flush();
  assert.equal(w.reqs.length, 1, 'the ordinary wake');
  assert.ok(w.reqs[0].text.includes(m1.id));
});

test('MUST 2: no mail that fits (headers only, nothing claimed) = no block', async (t) => {
  const w = await floor(t);
  await turnWithMail(w);
  const realClaim = w.hive.mail.claimSurfacing.bind(w.hive.mail);
  w.hive.mail.claimSurfacing = () => [];
  assert.equal(w.fire('Stop').decision, undefined);
  w.hive.mail.claimSurfacing = realClaim;
});

test('MUST 3: a tool-free continuation 90 s long does not re-pend; one Stop later the mail is acted; doubleSubmit 0', async (t) => {
  const w = await floor(t);
  const m1 = await turnWithMail(w);
  const epoch = w.server.mailEpoch('a1');
  assert.equal(w.fire('Stop').decision, 'block');
  await w.beat(90_000);
  assert.ok(!w.diags.some((d) => d.stage === 'submit-unconfirmed'), 'no submit-unconfirmed at 60 s');
  assert.deepEqual(w.reqs, [], 'no second wake');
  w.server.takeMailClaims();
  w.hive.mail.confirmSurfaced('a1', [m1.id], epoch, 'evidence');
  w.fire('Stop', { stop_hook_active: true });
  w.hive.mail.flushAll();
  assert.equal(w.entry(m1.id).state, 'acted');
  await w.beat(STOP_CONFIRM_MS);
  assert.deepEqual(w.reqs, []);
  assert.equal(w.rowsOf('wake-confirm')[0].by, 'stop');
  assert.equal(w.ws.counters().claude?.doubleSubmit, undefined);
  assert.ok(STOP_CONFIRM_MS > SUBMIT_CONFIRM_MS + 30_000);
});

test('Jim 24e45c SHOULD: a Stop-continue epoch never confirmed leaves no recheck: the next wake carries no prior text', async (t) => {
  const w = await floor(t);
  const m1 = await turnWithMail(w);
  assert.equal(w.fire('Stop').decision, 'block');
  // The continued turn never shows a hook: past STOP_CONFIRM_MS the epoch ends unconfirmed.
  await w.beat(STOP_CONFIRM_MS + 1_000);
  assert.ok(w.diags.some((d) => d.stage === 'submit-unconfirmed') || w.coordinator.state('a1').lifecycle !== 'active', 'the epoch ended unconfirmed');
  w.fire('Stop', { fully_idle: true });
  await w.beat(1_000);
  assert.ok(w.reqs.length >= 1, 'the mail is woken again');
  for (const r of w.reqs) assert.equal(r.priorText, undefined, 'no nudge was ever typed for a Stop-continue: nothing to recheck');
  assert.ok(w.reqs.some((r) => r.text.includes(m1.id)));
});

test('MUST 3: Codex: the continued turn\'s PostToolUse (same turn id) confirms; new mail waits for its real Stop', async (t) => {
  const w = await floor(t, { provider: 'codex' });
  await turnWithMail(w, { turn_id: 'T1' });
  assert.equal(w.fire('Stop', { turn_id: 'T1' }).decision, 'block');
  w.fire('PostToolUse', { turn_id: 'T1', tool_name: 'Read', tool_input: {} });
  assert.equal(w.coordinator.state('a1').lifecycle, 'active');
  assert.equal(w.coordinator.state('a1').provisional, false, 'confirmed by the continued turn');
  w.send({ subject: 'during the continuation' });
  await w.flush();
  assert.deepEqual(w.reqs, [], 'nothing typed into the continued turn');
  await w.beat(90_000);
  assert.deepEqual(w.reqs, []);
  w.fire('Stop', { turn_id: 'T1' });
  await w.flush();
  assert.equal(w.reqs.length, 1, 'the new mail wakes after the real Stop');
});

test('Codex: the Stop block reason is capped (CODEX-BLOAT-165)', async (t) => {
  const w = await floor(t, { provider: 'codex' });
  w.fire('UserPromptSubmit', { prompt: 'go', turn_id: 'T1' });
  await w.flush();
  for (let i = 0; i < 6; i++) w.send({ subject: `big ${i}`, body: 'x'.repeat(1_500) });
  await w.flush();
  const res = w.fire('Stop', { turn_id: 'T1' });
  assert.equal(res.decision, 'block');
  assert.ok(res.reason.length <= CODEX_STOP_MAIL_BUDGET, `reason ${res.reason.length} chars`);
});

test('guard 4 / INFO 1: one block per turn; a new turn has a fresh key', async (t) => {
  const w = await floor(t, { provider: 'antigravity' });
  await turnWithMail(w);
  assert.equal(w.fire('Stop', { fully_idle: true }).decision, 'block');
  w.send({ subject: 'second' });
  await w.flush();
  assert.equal(w.fire('Stop', { fully_idle: true }).decision, undefined, 'the same turn is never blocked twice (a cancelled continuation)');
  await w.flush();
  w.reqs.length = 0;
  await turnWithMail(w);
  assert.equal(w.fire('Stop', { fully_idle: true }).decision, 'block', 'the next turn\'s Stop can carry mail again');
});

test('guard 1: a Stop with stop_hook_active (another Stop hook continued this turn) is never blocked', async (t) => {
  const w = await floor(t);
  await turnWithMail(w);
  assert.equal(w.fire('Stop', { stop_hook_active: true }).decision, undefined);
  assert.deepEqual(w.rowsOf('wake-stop'), [], 'no claim was even asked');
});

test('a Stop with no mail to carry: no block, and the grant goes back', async (t) => {
  const w = await floor(t);
  w.fire('UserPromptSubmit', { prompt: 'go' });
  await w.flush();
  assert.equal(w.fire('Stop').decision, undefined);
  assert.deepEqual(w.grants, [['cancel', 1]]);
});

test('AGY: a mid-chain Stop (fully_idle false) is never blocked', async (t) => {
  const w = await floor(t, { provider: 'antigravity' });
  await turnWithMail(w);
  assert.equal(w.fire('Stop', { fully_idle: false }).decision, undefined);
});

test('the flags: off for the provider, or the owner path = the Stop reply stays non-blocking', async (t) => {
  const off = await floor(t, { stop: { claude: false, codex: true } });
  await turnWithMail(off);
  assert.equal(off.fire('Stop').decision, undefined);
  const owner = await floor(t);
  owner.path = 'owner';
  await turnWithMail(owner);
  assert.equal(owner.fire('Stop').decision, undefined);
  await owner.flush();
  assert.equal(owner.reqs.length, 1, 'the ordinary wake through the owner');
  assert.equal(owner.owner.length, 1);
});

test('guard 3: a draft or a person\'s recent key at the Stop = no block', async (t) => {
  const w = await floor(t);
  await turnWithMail(w);
  w.block = 'draft';
  assert.equal(w.fire('Stop').decision, undefined);
  const k = await floor(t);
  await turnWithMail(k);
  k.lastHuman = k.now + 500;
  assert.equal(k.fire('Stop').decision, undefined);
});

// INT-1.1.97 (autocompact-pilot-181): the compact-health watcher sees EVERY Stop before any early
// return; a blocked Stop still ends a provider request. Only the claims lease (a completed turn) waits.
test('a blocked Stop still reaches compact-health and the incarnation latch; it takes no claims lease', async (t) => {
  const w = await floor(t);
  const seen = [];
  w.server.setCompactHealth({ noteCompact: () => {}, onStop: (a) => seen.push(`health:${a}`), noteRead: () => {}, noteCarry: () => {} });
  w.server.setClaimTurnCompletedListener((a) => seen.push(`lease:${a}`));
  w.server.setWakeIncarnationObserver((a, inc) => seen.push(`inc:${a}:${inc}`));
  await turnWithMail(w);
  assert.equal(w.fire('Stop', { munder_wake_incarnation: 'inc-1', transcript_path: 'C:/t/a1.jsonl' }).decision, 'block');
  assert.ok(seen.includes('health:a1'), 'A BLOCKED STOP STILL REACHES COMPACT-HEALTH');
  assert.ok(seen.includes('inc:a1:inc-1'), 'a blocked Stop still latches the incarnation');
  assert.ok(!seen.includes('lease:a1'), 'a continued turn is not a completed one: no claims lease');
  await w.flush();
  assert.equal(w.fire('Stop', { fully_idle: true }).decision, undefined);
  assert.deepEqual(seen.filter((s) => !s.startsWith('inc:')), ['health:a1', 'lease:a1', 'health:a1'], 'the continued turn\'s own Stop is the completed one');
});

test('a subagent\'s Stop is never blocked', async (t) => {
  const w = await floor(t);
  await turnWithMail(w);
  const r = w.fire('Stop', { provider_agent_id: 'sub-1' });
  assert.equal(r.decision, undefined);
});

// ─── source pins ─────────────────────────────────────────────────────────────────────────────

test('pins: the only Stop block is the Stop-continue; index wires the sender everywhere a wake goes', () => {
  const hooks = codeOnly(readSource('src/main/hooks.ts'));
  assert.equal(hooks.split("return { decision: 'block', reason: stopReason }").length - 1, 1);
  assert.equal(hooks.split('stopReason = this.stopContinueReason(agentId, p)').length - 1, 1);
  assert.match(hooks, /if \(agentId && !fromSubagent && stopReason === null\) this\.trackTurn\(agentId, event, p\);/);
  assert.match(hooks, /stopReason !== null \? false :/, 'a blocked Stop reaches the coordinator as mid-chain');
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /submit: \(req\) => \(wakeSender \? wakeSender\.submit\(req\)/);
  assert.match(idx, /write: \(ptyId, data\) => ptyManager\.write\(ptyId, data, 'PROGRAMMATIC'\)/);
  assert.match(idx, /hookServer\.setStopContinue\(\{/);
  assert.match(idx, /wakeSender\?\.noteHook\(agentId, event, f\)/);
  assert.match(idx, /path: wakePathOf\(c\.wakePath\)/);
  assert.equal(idSetOf('inbox-wake:a1:abc:7'), 'abc');
  assert.equal(SUBMIT_CONFIRM_MS, 60_000);
});
