'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-HANDOFF-RACE, Jim's audit of 59c87898, NITs 1-3 and the pins of nit 5 (god, conv-9594bd, 2026-10-23).
 *  NIT 1 (P2): a `heavy next` name for an agent that never asks (or a typo: "creed-typo", named by god, stood
 *    6 h and then went ahead of a waiter) never expired. Now a name must be an agent on the floor (refused
 *    'unknown' otherwise), and a standing name nobody asked for within HEAVY_TTL_MS is forgotten ('next-expired').
 *  NIT 2: a refused `heavy next` (and a refused held release) exited 0, so a pack's last line could not see the
 *    refusal. Now a refusal exits 1 (EXIT.refused).
 *  NIT 3 (P3): an agent queued again after a lapse was told "a reservation you leave unused ... queues you again
 *    at the back, once", though its next lapse drops it. Now the deny text says so.
 *  NIT 5: Jim's surviving mutants are pinned: M5 next() grants a slot free now; M6 next() moves the named agent
 *    to the head at once; M9 the 80-char cap on the name; M10 main wires isGod; M13 the lapsed flag survives
 *    the exclusive re-deny path.
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const IXF = 'src/main/index.ts';
const CLF = 'resources/heavy-cli.cjs';
const HJ = loadTs(HJF);
const { HookServer } = loadTs('src/main/hooks.ts');
const CLI = require('../../resources/heavy-cli.cjs');
const H = { heavy: true, kind: 'suite' };
const B = { heavy: true, kind: 'build' };   // shared: two may run beside each other
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hhrnits199-'));
test.after(() => { try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* best effort */ } });

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = []; const lapses = [];
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), notifyLapse: (a, k, why) => lapses.push([a, k, why]),
    alive: () => true, isGod: (a) => a === 'god', ...extra
  });
  const status = async (a) => l.lease(a, { op: 'status' });
  return { l, logs, notes, lapses, status, tick: (ms) => { now += ms; }, now: () => now, rows: (action) => logs.filter((r) => r.action === action) };
}
const waiters = (x) => x.l.queueSnapshot().waiters.map((w) => w.agentId);
const reservedFor = (x) => x.l.queueSnapshot().reserved.map((r) => r.agentId);

const K = {};

K.unknown = async (M = HJ) => {
  // P2: god names "creed-typo"; nobody of that name has a PTY.
  const x = rig(M, { alive: (a) => a !== 'creed-typo' });
  x.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  const no = await x.l.lease('god', { op: 'next', to: 'creed-typo' });
  assert.deepEqual(no, { state: 'next', to: 'creed-typo', queued: false, refused: 'unknown' }, 'A NAME THAT IS NOT AN AGENT ON THE FLOOR IS REFUSED');
  assert.equal((await x.status('god')).next, null, 'A NAME THAT IS NOT AN AGENT ON THE FLOOR IS NOT KEPT');
  assert.deepEqual(x.rows('next').at(-1), { kind: 'heavy-lock', action: 'next', agentId: 'god', to: 'creed-typo', queued: false, refused: 'unknown' }, 'the refusal is logged');
  // The real creed, on the floor but not queued yet, may be named.
  assert.deepEqual(await x.l.lease('god', { op: 'next', to: 'creed' }), { state: 'next', to: 'creed', queued: false });
  assert.equal((await x.status('god')).next, 'creed');
  // Without an `alive` dep (a rig without a PTY roster) every name is taken, as before.
  const y = rig(M, { alive: undefined });
  y.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  assert.deepEqual(await y.l.lease('god', { op: 'next', to: 'whoever' }), { state: 'next', to: 'whoever', queued: false });

  assert.equal(CLI.describe(no), 'heavy: refused: no agent creed-typo is on the floor (heavy status lists the queue; an agent id is like creed-mukyiphw)\n', 'THE CLI SAYS WHY');
};
test('NIT 1: `heavy next` refuses a name that is no agent on the floor (a typo never stands)', () => K.unknown());

K.nameExpires = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  x.l.acquire('andy', H, 'npm test', 'a1', false);
  assert.deepEqual(await x.l.lease('jim', { op: 'next', to: 'creed' }), { state: 'next', to: 'creed', queued: false });
  x.tick(M.HEAVY_TTL_MS - 1);
  assert.equal((await x.status('god')).next, 'creed', 'the name stands within the hour');
  x.l.acquire('jim', H, 'sh pack2.sh', 'j2', false);   // jim's re-entry keeps his hold past its own hour
  x.tick(1);
  assert.equal((await x.status('god')).next, null, 'A NAME NOBODY ASKED FOR WITHIN THE HOUR IS FORGOTTEN');
  assert.deepEqual(x.rows('next-expired'), [{ kind: 'heavy-lock', action: 'next-expired', to: 'creed', ageMs: M.HEAVY_TTL_MS }], 'THE FORGOTTEN NAME IS LOGGED');
  // P2's second half: when creed does ask later, he goes in queue order, not ahead of andy.
  assert.equal(x.l.acquire('creed', H, 'npm test', 'c1', false).allow, false);
  assert.deepEqual(waiters(x), ['andy', 'creed'], 'A FORGOTTEN NAME GIVES NO PLACE AT THE HEAD');
  // ... whereas within the hour the standing name puts him at the head when he asks.
  const w = rig(M);
  w.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  w.l.acquire('andy', H, 'npm test', 'a1', false);
  await w.l.lease('jim', { op: 'next', to: 'creed' });
  w.tick(M.HEAVY_TTL_MS - 1);
  assert.equal(w.l.acquire('creed', H, 'npm test', 'c1', false).allow, false);
  assert.deepEqual(waiters(w), ['creed', 'andy'], 'a standing name puts him at the head when he asks');
  // Naming again restarts the hour.
  const y = rig(M);
  y.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  await y.l.lease('jim', { op: 'next', to: 'creed' });
  y.tick(M.HEAVY_TTL_MS / 2);
  await y.l.lease('jim', { op: 'next', to: 'creed' });
  y.tick(M.HEAVY_TTL_MS / 2 + 1);
  assert.equal((await y.status('god')).next, 'creed', 'NAMING AGAIN RESTARTS THE HOUR');
  y.tick(M.HEAVY_TTL_MS / 2);
  assert.equal((await y.status('god')).next, null);
  // A name taken up in time (creed asks, is queued at the head, and is granted) never expires: it is spent.
  const z = rig(M);
  z.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  await z.l.lease('jim', { op: 'next', to: 'creed' });
  z.tick(M.HEAVY_TTL_MS / 2);
  assert.equal(z.l.acquire('creed', H, 'npm test', 'c1', false).allow, false);
  z.l.callDone('jim', 'j1');
  assert.deepEqual(reservedFor(z), ['creed']);
  assert.equal((await z.status('god')).next, null);
  z.tick(M.HEAVY_TTL_MS);
  assert.deepEqual(z.rows('next-expired'), [], 'a spent name is not "expired"');
};
test('NIT 1 (P2): a `heavy next` name nobody asks for within HEAVY_TTL_MS is forgotten, logged; naming again restarts the hour', () => K.nameExpires());

K.lapsedWording = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('h', H, 'npm ci', 'h1', false);
  const fresh = x.l.acquire('creed', H, 'npm test', 'c1', false);
  assert.match(fresh.reason, /passes on and queues you again at the back, once; `heavy status`/, 'A FIRST DENIAL SAYS A LAPSE QUEUES AGAIN ONCE');
  x.l.acquire('dwight', H, 'npm test', 'd1', false);
  x.l.callDone('h', 'h1');
  assert.deepEqual(reservedFor(x), ['creed']);
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(x.lapses, [['creed', 'suite', 'requeued']]);
  // P3: creed, queued again once already, asks again and is denied again.
  const again = x.l.acquire('creed', H, 'npm test', 'c2', false);
  assert.equal(again.allow, false);
  assert.match(again.reason, /A reservation you leave unused for 5 min passes on and takes you out of the queue \(you were queued again once already\); `heavy status` shows your standing and `heavy release` leaves the queue\.$/, 'A REQUEUED AGENT IS TOLD ITS NEXT LAPSE DROPS IT');
  assert.doesNotMatch(again.reason, /queues you again/, 'A REQUEUED AGENT IS NOT PROMISED ANOTHER REQUEUE');
  // Another agent's denial at the same moment is unchanged.
  const other = x.l.acquire('andy', H, 'npm test', 'a1', false);
  assert.match(other.reason, /passes on and queues you again at the back, once;/, 'THE WORDING IS PER AGENT');
};
test('NIT 3 (P3): a requeued agent that is denied again is told the truth: its next unused reservation drops it', () => K.lapsedWording());

K.pins = async (M = HJ) => {
  // M5: a name moves a waiter past an exclusive head, and a slot free now goes to it at once.
  const x = rig(M, { limit: () => 2 });
  x.l.acquire('jim', B, 'npm run build', 'j1', false);
  assert.equal(x.l.acquire('andy', H, 'npm test', 'a1', false).allow, false);   // exclusive: waits for the empty machine
  assert.equal(x.l.acquire('creed', B, 'npm run build', 'c1', false).allow, false);   // shared, but behind the exclusive head
  assert.deepEqual(waiters(x), ['andy', 'creed']);
  assert.deepEqual(reservedFor(x), []);
  assert.deepEqual(await x.l.lease('jim', { op: 'next', to: 'creed' }), { state: 'next', to: 'creed', queued: true });
  assert.deepEqual(reservedFor(x), ['creed'], 'M5: A NAMED AGENT GETS A SLOT THAT IS FREE NOW AT ONCE');
  assert.deepEqual(x.notes.map((n) => n.a), ['creed']);
  await K.head(M);
  // M9: a name is capped at 80 characters (the log row and the answer carry the capped name).
  const z = rig(M);
  z.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  const long = 'x'.repeat(100);
  const ans = await z.l.lease('jim', { op: 'next', to: long });
  assert.equal(ans.to, 'x'.repeat(80), 'M9: THE NAME IS CAPPED AT 80 CHARACTERS');
  assert.equal(z.rows('next').at(-1).to.length, 80, 'M9: the log row carries the capped name');
  assert.equal((await z.status('god')).next, 'x'.repeat(80));
};
K.head = async (M = HJ) => {
  // M6: with no free slot the named agent is at the head at once, and status and the deny text agree.
  const y = rig(M);
  y.l.acquire('jim', H, 'sh pack.sh', 'j1', false);
  y.l.acquire('andy', H, 'npm test', 'a1', false);
  y.l.acquire('creed', H, 'npm test', 'c1', false);
  await y.l.lease('jim', { op: 'next', to: 'creed' });
  assert.deepEqual(waiters(y), ['creed', 'andy'], 'M6: THE NAMED AGENT IS AT THE HEAD AT ONCE');
  assert.deepEqual((await y.status('creed')).you, { holding: false, reserved: null, position: 1 }, 'M6: status shows the head position at once');
  assert.match(y.l.acquire('creed', H, 'npm test', 'c2', false).reason, /You are QUEUED \(position 1\)/, 'M6: the deny text shows the head position at once');
};
test('nit 5 pins M5, M6, M9: next() grants a slot free now, moves the named agent to the head at once, caps the name', () => K.pins());

K.lapsedExclusive = async (M = HJ) => {
  // M13: a requeued (lapsed) agent, reserved again, whose exclusive call must wait for the other holder
  // goes back to the head still on its last chance: its next unused reservation drops it.
  const x = rig(M, { limit: () => 2 });
  x.l.acquire('jim', B, 'npm run build', 'j1', false);
  x.l.acquire('dwight', B, 'npm run build', 'd1', false);
  assert.equal(x.l.acquire('creed', B, 'npm run build', 'c1', false).allow, false);
  x.l.callDone('jim', 'j1');
  assert.deepEqual(reservedFor(x), ['creed']);
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(x.rows('queue-again').map((r) => r.agentId), ['creed'], 'queued again once');
  assert.deepEqual(reservedFor(x), ['creed'], 'the slot is still free, so reserved again at once (lapsed)');
  // Now creed's heavy call is a suite: exclusive, so it waits for dwight (the reserved-exclusive re-deny path).
  const d = x.l.acquire('creed', H, 'npm test', 'c2', false);
  assert.equal(d.allow, false);
  assert.deepEqual(waiters(x), ['creed']);
  assert.deepEqual(reservedFor(x), []);
  assert.match(d.reason, /takes you out of the queue \(you were queued again once already\)/, 'M13: THE RE-DENY ON THE EXCLUSIVE PATH KEEPS THE LAPSED FLAG (the deny text says so)');
  x.l.callDone('dwight', 'd1');
  assert.deepEqual(reservedFor(x), ['creed']);
  x.tick(M.HEAVY_RESERVE_MS);
  x.l.queueSnapshot();
  assert.deepEqual(waiters(x), [], 'M13: THE SECOND UNUSED RESERVATION DROPS IT');
  assert.deepEqual(x.lapses, [['creed', 'suite', 'expired']], 'M13: told plainly, not requeued a second time (the first lapse re-reserved the free slot at once: "HEAVY SLOT FREE" again, no lapse notice)');
  assert.deepEqual(x.notes.map((n) => n.a), ['creed', 'creed', 'creed']);
  assert.equal(x.rows('queue-again').length, 1, 'M13: queued again ONCE');
};
test('nit 5 pin M13: the lapsed flag survives the exclusive re-deny path', () => K.lapsedExclusive());

K.indexWires = (text = readSource(IXF)) => {
  const start = text.indexOf('const heavyLock = new HeavyJobLock({');
  assert.ok(start >= 0, 'main builds the lock');
  const block = text.slice(start, text.indexOf('});', start));
  assert.ok(block.includes('isGod: (agentId) => hive.isGod(agentId),'), 'M10: MAIN WIRES isGod INTO THE LOCK (god may name the next holder)');
  assert.ok(block.includes('alive: (agentId) => [...ptyToAgent.values()].includes(agentId),'), 'main wires alive into the lock (a `heavy next` name must be on the floor)');
};
test('nit 5 pin M10: main wires isGod (and alive) into the lock', () => K.indexWires());

test('NIT 2: the CLI exit codes: a refused `heavy next` and a refused held release exit 1 (EXIT.refused), not 0', () => {
  assert.deepEqual(CLI.EXIT, { ok: 0, refused: 1, usage: 2, unavailable: 3, timeout: 4 });
  const src = readSource(CLF);
  assert.ok(src.includes("if ((b.state === 'next' && b.refused) || (b.held && !b.held.dropped)) return EXIT.refused;"), 'a refusal returns EXIT.refused after its line is printed');
});

// ─── E2E over the real hook broker route ──────────────────────────────────────────────────

async function broker(t, M, alive) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hhrnits199-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  const logs = [];
  const lock = new M.HeavyJobLock({ limit: () => 1, log: (r) => logs.push(r), notify: () => {}, isGod: (a) => a === 'god', alive });
  s.setHeavyLock(lock);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return { lock, logs, url: (a) => s.hookUrl(a).replace('/hook/', '/ledger/') };
}
async function cli(argv, env) {
  let out = ''; let err = '';
  const code = await CLI.main(argv, env, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

test('E2E: a refused `heavy next` (unknown name, not a holder, self) exits 1 over the route; an accepted one exits 0', { timeout: 30_000 }, async (t) => {
  const b = await broker(t, HJ, (a) => a !== 'creed-typo');
  b.lock.acquire('jim', H, 'sh pack.sh', 'j1', false);
  b.lock.acquire('andy', H, 'npm test', 'a1', false);
  const typo = await cli(['next', 'creed-typo'], { HIVE_LEDGER_URL: b.url('god') });
  assert.equal(typo.code, 1, 'NIT 2: A REFUSED `heavy next` EXITS 1');
  assert.equal(typo.out, 'heavy: refused: no agent creed-typo is on the floor (heavy status lists the queue; an agent id is like creed-mukyiphw)\n');
  assert.equal((await cli(['next', 'creed'], { HIVE_LEDGER_URL: b.url('andy') })).code, 1, 'not a holder: exits 1');
  assert.equal((await cli(['next', 'jim'], { HIVE_LEDGER_URL: b.url('jim') })).code, 1, 'self: exits 1');
  const ok = await cli(['next', 'creed'], { HIVE_LEDGER_URL: b.url('jim') });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.out, 'heavy: the next freed slot goes to creed (not queued yet: it goes to the head when it next asks)\n');
  assert.equal((await cli(['status'], { HIVE_LEDGER_URL: b.url('god') })).code, 0, 'status exits 0');
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  { name: 'any name is taken (no floor check)', edits: [["        : !this.alive(to) ? 'unknown' as const : undefined;", '        : undefined;']],
    killer: 'unknown', dies: /A NAME THAT IS NOT AN AGENT ON THE FLOOR IS REFUSED/ },
  { name: 'a name never expires', edits: [['    if (this.nextUp && t - this.nextAt >= HEAVY_TTL_MS) {', '    if (false) {']],
    killer: 'nameExpires', dies: /A NAME NOBODY ASKED FOR WITHIN THE HOUR IS FORGOTTEN/ },
  { name: 'the expired name is not logged', edits: [["      this.log({ kind: 'heavy-lock', action: 'next-expired', to: this.nextUp, ageMs: t - this.nextAt });\n", '']],
    killer: 'nameExpires', dies: /THE FORGOTTEN NAME IS LOGGED/ },
  { name: 'naming again does not restart the hour', edits: [['    this.nextAt = this.now();\n', '    if (!this.nextAt) this.nextAt = this.now();\n']],
    killer: 'nameExpires', dies: /NAMING AGAIN RESTARTS THE HOUR/ },
  { name: 'a requeued agent is promised another requeue (NIT 3)', edits: [["    const lapsed = !!this.waiters.find((w) => w.agentId === agentId)?.lapsed;", '    const lapsed = false;']],
    killer: 'lapsedWording', dies: /A REQUEUED AGENT IS TOLD ITS NEXT LAPSE DROPS IT/ },
  { name: 'every agent is told its next lapse drops it', edits: [["    const lapsed = !!this.waiters.find((w) => w.agentId === agentId)?.lapsed;", '    const lapsed = true;']],
    killer: 'lapsedWording', dies: /A FIRST DENIAL SAYS A LAPSE QUEUES AGAIN ONCE/ },
  { name: 'M5: next() does not grant a slot that is free now', edits: [['    if (queued) this.grant();\n    return { state: \'next\', to, queued };', '    return { state: \'next\', to, queued };']],
    killer: 'pins', dies: /M5: A NAMED AGENT GETS A SLOT THAT IS FREE NOW AT ONCE/ },
  // M6 alone (the unshift in next()) is shadowed by grant()'s own reorder, which next() calls when the name is
  // queued (M5); the behaviour is pinned, so the mutant drops both the unshift and that grant() call.
  { name: 'M6: next() neither moves the named agent to the head at once nor re-reads the queue', edits: [['    if (i > 0) { this.waiters.unshift(...this.waiters.splice(i, 1)); this.changed(); }\n', ''], ['    if (queued) this.grant();\n    return { state: \'next\', to, queued };', '    return { state: \'next\', to, queued };']],
    killer: 'head', dies: /M6: THE NAMED AGENT IS AT THE HEAD AT ONCE/ },
  { name: 'M9: no 80-char cap on the name', edits: [['    to = to.slice(0, 80);\n', '']],
    killer: 'pins', dies: /M9: THE NAME IS CAPPED AT 80 CHARACTERS/ },
  { name: 'M13: the lapsed flag is lost on the exclusive re-deny path', edits: [['exclusive: true, lapsed: r.lapsed });', 'exclusive: true, lapsed: false });']],
    killer: 'lapsedExclusive', dies: /M13: THE RE-DENY ON THE EXCLUSIVE PATH KEEPS THE LAPSED FLAG/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mutated = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      await assert.rejects(async () => K[m.killer](mutated), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
  await t.test('mutant: M10: main does not wire isGod', () => {
    const text = mutateText(IXF, [['  isGod: (agentId) => hive.isGod(agentId),\n', '']], 'M10');
    assert.throws(() => K.indexWires(text), /M10: MAIN WIRES isGod INTO THE LOCK/, 'M10: MUST DIE');
  });
});
