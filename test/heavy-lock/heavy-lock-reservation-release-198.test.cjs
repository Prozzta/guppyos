'use strict';

/**
 * HEAVY-LOCK-RESERVATION-RELEASE (card, 2026-10-04 07:00Z): Jim got HEAVY SLOT FREE (reserved to
 * 07:04Z), wanted to hand it to Creed, and had no way to: a reservation ended only by its 5 min
 * expiry, the agent's PTY exiting, or the limit going off. The slot idled meanwhile.
 *
 * Now `heavy release` (resources/heavy-cli.cjs, op 'unreserve' on the /heavy route, the per-spawn
 * token) gives up the caller's reservation and queue place; the slot passes on AT ONCE, to the
 * oldest waiter, or first to `--to <agent>` when that agent is queued. A held slot is not touched.
 * `heavy status` reads the lock. HEAVY SLOT FREE names the command.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJ = loadTs('src/main/heavyJob.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const CLI = require('../../resources/heavy-cli.cjs');
const H = { heavy: true, kind: 'suite' };
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hlrr198-'));
test.after(() => { try { fs.rmSync(JAIL, { recursive: true, force: true }); } catch { /* best effort */ } });

function rig(M = HJ, limit = 1) {
  let now = 1_000_000; const logs = []; const notes = []; let changes = 0;
  const l = new M.HeavyJobLock({
    limit: () => limit, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a, k, until) => notes.push({ a, k, until }), alive: () => true
  });
  l.onChange(() => { changes++; });
  return { l, logs, notes, changes: () => changes, tick: (ms) => { now += ms; }, now: () => now };
}
/** a holds; `queue` are denied in order; a's job ends, so the first of them is reserved. */
function reserved(M, queue) {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  for (const q of queue) x.l.acquire(q, H, 'npm ci', `${q}1`, false);
  x.l.callDone('a', 'a1');
  return x;
}

const K = {};

K.releaseHandsOn = async (M = HJ) => {
  const x = reserved(M, ['b', 'c']);
  assert.deepEqual(x.notes.map((n) => n.a), ['b']);
  const a = await x.l.lease('b', { op: 'unreserve' });
  assert.deepEqual(a, { state: 'unreserved', reserved: true, queued: false, next: 'c' }, 'A RESERVED AGENT CAN GIVE ITS SLOT UP');
  assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => r.agentId), ['c'], 'THE SLOT PASSES ON AT ONCE, NOT AFTER 5 MIN');
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'c'], 'THE NEXT WAITER IS TOLD HEAVY SLOT FREE AT ONCE');
  const row = x.logs.find((r) => r.action === 'reserve-released');
  assert.deepEqual(row, { kind: 'heavy-lock', action: 'reserve-released', agentId: 'b', heavyKind: 'suite' }, 'THE RELEASE IS LOGGED');
  assert.ok(!x.logs.some((r) => r.action === 'reserve-expired'), 'not an expiry');
  assert.equal(x.l.acquire('b', H, 'npm ci', 'b2', false).allow, false, 'b has no slot any more');
  assert.equal(x.l.acquire('c', H, 'npm ci', 'c2', false).allow, true, 'c takes it');
};
test('heavy release: a reserved agent gives its slot up and it passes to the next waiter at once', () => K.releaseHandsOn());

K.handToNamed = async (M = HJ) => {
  const x = reserved(M, ['b', 'c', 'd']);
  const a = await x.l.lease('b', { op: 'unreserve', to: 'd' });
  assert.deepEqual(a, { state: 'unreserved', reserved: true, queued: false, next: 'd' }, 'HAND IT TO A NAMED QUEUED AGENT');
  assert.deepEqual(x.notes.map((n) => n.a), ['b', 'd']);
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['c'], 'the others keep their order');
  assert.equal(x.logs.find((r) => r.action === 'reserve-released').to, 'd');
  // d gives it up in turn, naming an agent that is not queued: FIFO, and the answer says so.
  const b = await x.l.lease('d', { op: 'unreserve', to: 'zz' });
  assert.deepEqual(b, { state: 'unreserved', reserved: true, queued: false, next: 'c', to: 'not-queued' }, 'A NAMED AGENT NOT QUEUED: QUEUE ORDER, AND SAID');
};
test('heavy release --to: the slot goes to that queued agent first; one not queued gets FIFO and is said', () => K.handToNamed());

K.handToFirstIsFifo = async (M = HJ) => {
  // The named agent is already first: same answer as FIFO (no reorder needed).
  const x = reserved(M, ['b', 'c', 'd']);
  assert.equal((await x.l.lease('b', { op: 'unreserve', to: 'c' })).next, 'c');
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['d']);
};
test('heavy release --to the agent already first in the queue', () => K.handToFirstIsFifo());

K.noWaiterFrees = async (M = HJ) => {
  const x = reserved(M, ['b']);
  const a = await x.l.lease('b', { op: 'unreserve' });
  assert.deepEqual(a, { state: 'unreserved', reserved: true, queued: false, next: null }, 'NO ONE WAITS: THE SLOT IS FREE');
  assert.equal(x.l.acquire('e', H, 'npm ci', 'e1', false).allow, true, 'A FREED SLOT IS FREE FOR ANYONE AT ONCE');
};
test('heavy release with nobody queued frees the slot for anyone', () => K.noWaiterFrees());

K.queuedOnlyLeaves = async (M = HJ) => {
  const x = reserved(M, ['b', 'c', 'd']);
  const before = x.changes();
  const a = await x.l.lease('c', { op: 'unreserve' });
  assert.deepEqual(a, { state: 'unreserved', reserved: false, queued: true, next: null }, 'A QUEUED AGENT LEAVES THE QUEUE');
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['d'], 'THE QUEUE PLACE IS GIVEN UP');
  assert.deepEqual(x.l.queueSnapshot().reserved.map((r) => r.agentId), ['b'], "b's reservation is untouched");
  assert.ok(x.logs.some((r) => r.action === 'queue-left' && r.agentId === 'c'));
  assert.ok(x.changes() > before, 'fleet.json is told');
  assert.deepEqual(x.notes.map((n) => n.a), ['b']);
};
test('heavy release while only queued leaves the queue and touches no reservation', () => K.queuedOnlyLeaves());

K.nothingAndHolder = async (M = HJ) => {
  const x = rig(M);
  x.l.acquire('a', H, 'npm ci', 'a1', false);
  x.l.acquire('b', H, 'npm ci', 'b1', false);
  const rows = x.logs.length; const ch = x.changes();
  assert.deepEqual(await x.l.lease('z', { op: 'unreserve' }), { state: 'unreserved', reserved: false, queued: false, next: null });
  assert.deepEqual(await x.l.lease('a', { op: 'unreserve' }), { state: 'unreserved', reserved: false, queued: false, next: null }, 'A HELD SLOT IS NOT RELEASED BY heavy release');
  assert.deepEqual(x.l.snapshot().map((h) => h.agentId), ['a']);
  assert.equal(x.logs.length, rows, 'no row for a no-op');
  assert.equal(x.changes(), ch, 'no change for a no-op');
  assert.deepEqual(x.l.queueSnapshot().waiters.map((w) => w.agentId), ['b']);
};
test('heavy release with nothing reserved or queued, or by the holder, changes nothing', () => K.nothingAndHolder());

K.status = async (M = HJ) => {
  const x = reserved(M, ['b', 'c']);
  const s = await x.l.lease('c', { op: 'status' });
  assert.deepEqual(s, { state: 'status', holders: [], waiters: ['c'], reserved: [{ agentId: 'b', until: new Date(x.now() + M.HEAVY_RESERVE_MS).toISOString() }] }, 'heavy status reads the lock');
  assert.equal(x.logs.filter((r) => r.action === 'deny').length, 2, 'status is not an acquire (no deny row)');
};
test('heavy status: holders, the queue and the reservations', () => K.status());

K.notice = (M = HJ) => {
  const n = M.heavySlotFreeNotice('jim', 'suite', Date.parse('2026-10-04T07:04:00Z'));
  assert.match(n.message.body, /If you no longer need it, run `heavy release` so it passes on at once \(`heavy release --to <agent>` gives it to that queued agent first\)\. No reply is needed\.$/, 'HEAVY SLOT FREE NAMES heavy release');
};
test('HEAVY SLOT FREE tells the agent how to pass the slot on', () => K.notice());

// ─── the CLI over the real broker route ──────────────────────────────────────────────────────

async function broker(t, M) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hlrr198-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    toolOutputDir: (id) => path.join(JAIL, 'agents', id, 'tool-output')
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  const logs = []; const notes = [];
  const lock = new M.HeavyJobLock({ limit: () => 1, log: (r) => logs.push(r), notify: (a) => notes.push(a) });
  s.setHeavyLock(lock);
  s.start();
  t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return { lock, logs, notes, url: (a) => s.hookUrl(a).replace('/hook/', '/ledger/') };
}
async function cli(argv, env) {
  let out = ''; let err = '';
  const code = await CLI.main(argv, env, { out: (s) => { out += s; }, err: (s) => { err += s; } });
  return { code, out, err };
}

K.cliE2E = async (t, M = HJ) => {
  const b = await broker(t, M);
  b.lock.acquire('a', H, 'npm ci', 'a1', false);
  b.lock.acquire('jim', H, 'npm ci', 'j1', false);
  b.lock.acquire('creed', H, 'npm ci', 'c1', false);
  b.lock.acquire('dwight', H, 'npm ci', 'd1', false);
  b.lock.callDone('a', 'a1');
  // One URL per spawn: each hookUrl() mints a new token for the agent (the old one is refused).
  const jim = b.url('jim');
  const st = await cli(['status'], { HIVE_LEDGER_URL: jim });
  assert.equal(st.code, 0, st.err);
  assert.match(st.out, /^held: none; reserved: jim until \d\d:\d\d:\d\dZ; queue: creed, dwight\n$/);
  const r = await cli(['release', '--to', 'dwight'], { HIVE_LEDGER_URL: jim });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, 'heavy: released your reserved slot; it is now reserved for dwight\n', 'THE CLI RELEASES OVER THE /heavy ROUTE');
  assert.deepEqual(b.notes, ['jim', 'dwight']);
  // The token names the caller: another agent's URL cannot give jim's slot away (it has none now).
  const again = await cli(['release'], { HIVE_LEDGER_URL: jim });
  assert.equal(again.out, 'heavy: nothing to release: no slot is reserved for you and you are not queued (a slot you hold frees when its job ends)\n');
  const stale = await cli(['release'], { HIVE_LEDGER_URL: b.url('dwight').replace(/[0-9a-f]{32}$/, '0'.repeat(32)) });
  assert.equal(stale.code, CLI.EXIT.unavailable, 'A WRONG TOKEN IS REFUSED');
  assert.deepEqual(b.lock.queueSnapshot().reserved.map((x) => x.agentId), ['dwight'], 'and changes nothing');
};
test('E2E: `heavy status` and `heavy release --to` over the real hook broker route and per-spawn token', { timeout: 30_000 }, (t) => K.cliE2E(t));

test('the CLI: arguments, and no hive URL', async () => {
  assert.deepEqual(CLI.parseArgs(['release', '--to', 'creed-mukyiphw']), { op: 'unreserve', to: 'creed-mukyiphw' });
  assert.deepEqual(CLI.parseArgs(['status']), { op: 'status' });
  for (const bad of [[], ['release', 'x'], ['release', '--to'], ['release', '--to', 'a b'], ['release', '--to', '$(x)'], ['stop']]) assert.throws(() => CLI.parseArgs(bad), undefined, JSON.stringify(bad));
  assert.equal((await cli(['release'], {})).code, CLI.EXIT.unavailable);
  assert.equal((await cli(['nope'], {})).code, CLI.EXIT.usage);
});

test('WIRING: `heavy` is written to bin/heavy, put on every agent\'s PATH, and shipped', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /const HEAVY_CLI = join\(app\.isPackaged \? process\.resourcesPath : join\(app\.getAppPath\(\), 'resources'\), 'heavy-cli\.cjs'\);/);
  assert.match(idx, /const heavyDir = hive\.writeHeavyCommand\(HEAVY_CLI\);\s*if \(heavyDir\) opts\.pathPrepend = \[\.\.\.\(opts\.pathPrepend \?\? \[\]\), heavyDir\];\s*\/\/ GOD-TERMINAL-CONTROL: `term` on god's PATH only/, 'not under the god-only branch');
  assert.match(readSource('src/main/hive.ts'), /writeHeavyCommand\(script: string\): string \| null \{\s*return this\.writeCommandDir\('heavy', script\);/);
  const yml = readSource('electron-builder.yml');
  assert.match(yml.slice(yml.indexOf('\nextraResources:')), /- from: resources\/heavy-cli\.cjs\s+to: heavy-cli\.cjs/);
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
const HJF = 'src/main/heavyJob.ts';
const MUTANTS = [
  { name: 'no unreserve op (today)', edits: [["    if (r.op === 'unreserve') return this.unreserve(agentId, typeof r.to === 'string' ? r.to : undefined);\n", '']],
    killer: 'releaseHandsOn', dies: /a lease needs pid and createdMs/ },
  { name: 'the reservation is kept', edits: [['    const reserved = this.reservations.delete(agentId);', '    const reserved = this.reservations.has(agentId);']],
    killer: 'releaseHandsOn', dies: /THE SLOT PASSES ON AT ONCE|A RESERVED AGENT CAN GIVE ITS SLOT UP/ },
  { name: 'no grant: the slot idles', edits: [['    if (reserved) this.grant();\n', '']],
    killer: 'releaseHandsOn', dies: /A RESERVED AGENT CAN GIVE ITS SLOT UP/ },
  { name: 'not logged', edits: [["    if (r) this.log({ kind: 'heavy-lock', action: 'reserve-released', agentId, heavyKind: r.kind, ...(to ? { to } : {}) });\n    else if", '    if (false) {}\n    else if']],
    killer: 'releaseHandsOn', dies: /THE RELEASE IS LOGGED/ },
  { name: '--to ignored', edits: [['      if (i > 0) this.waiters.unshift(...this.waiters.splice(i, 1));\n', '']],
    killer: 'handToNamed', dies: /HAND IT TO A NAMED QUEUED AGENT/ },
  { name: '--to not passed by the route', edits: [["return this.unreserve(agentId, typeof r.to === 'string' ? r.to : undefined);", 'return this.unreserve(agentId);']],
    killer: 'handToNamed', dies: /HAND IT TO A NAMED QUEUED AGENT/ },
  { name: 'a missed --to not said', edits: [['      missed = i < 0;\n', '']],
    killer: 'handToNamed', dies: /A NAMED AGENT NOT QUEUED: QUEUE ORDER, AND SAID/ },
  { name: 'the queue place is kept', edits: [['    this.dequeue(agentId);\n    this.leaseOnly.delete(agentId);\n    const r = this.reservations.get(agentId);\n', '    this.leaseOnly.delete(agentId);\n    const r = this.reservations.get(agentId);\n']],
    killer: 'queuedOnlyLeaves', dies: /THE QUEUE PLACE IS GIVEN UP/ },
  { name: 'no-op still signals a change', edits: [['    if (reserved || queued) this.changed();\n', '    this.changed();\n']],
    killer: 'nothingAndHolder', dies: /no change for a no-op/ },
  { name: 'no status op', edits: [["    if (r.op === 'status') {\n", "    if (r.op === 'status' && false) {\n"]],
    killer: 'status', dies: /a lease needs pid and createdMs/ },
  { name: 'the notice does not name heavy release', edits: [[' If you no longer need it, run \\`heavy release\\` so it passes on at once (\\`heavy release --to <agent>\\` gives it to that queued agent first).', '']],
    killer: 'notice', dies: /HEAVY SLOT FREE NAMES heavy release/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const M = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      await assert.rejects(async () => K[m.killer](M), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
