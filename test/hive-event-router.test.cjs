'use strict';
require('./tools/own-job.cjs');

/**
 * Pre-M1 event-wake bridge, commit 1 — the HYBRID router and the delivery edge
 * (plan: agents/dwight-mu32ztys/floor-self-advance-PLAN.md, test plan A).
 *
 * The router runtime is injected: watchers, the immediate queue and the reconciliation
 * interval are all fakes, so each test proves exactly which path moved a file. The files
 * stay authoritative: a watch callback carries nothing and only asks for one scan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, outboxHintMatters } = loadTs('src/main/hive.ts');

function fakeRuntime() {
  const watchers = new Map();     // dir -> { hint, closed, handlers }
  const immediates = [];
  const timeouts = [];
  const intervals = [];
  return {
    watchers, immediates, timeouts, intervals,
    runtime: {
      watch: (dir, onHint) => {
        const w = {
          dir, hint: onHint, closed: false, handlers: {},
          close() { this.closed = true; },
          on(ev, cb) { this.handlers[ev] = cb; return this; }
        };
        watchers.set(dir, w);
        return w;
      },
      setImmediate: (fn) => { immediates.push(fn); },
      setTimeout: (fn, ms) => { const h = { fn, ms }; timeouts.push(h); return h; },
      setInterval: (fn, ms) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; },
      clearInterval: (h) => { h.cleared = true; }
    },
    idle: async () => {},
    async flush() { while (immediates.length) immediates.shift()(); await this.idle(); },
    fireNextTimeout() { const next = timeouts.shift(); assert.ok(next, 'expected a delayed retry'); next.fn(); },
    live(dir) { const w = watchers.get(dir); return w && !w.closed ? w : null; }
  };
}

async function floor(t, { emit } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-event-router-'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const rt = fakeRuntime();
  const hive = new HiveManager(() => home, emit, rt.runtime);
  rt.idle = () => hive.routerIdle();
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const deliveries = [];
  hive.setDeliveryObserver((d) => deliveries.push(d));
  const outbox = (id) => path.join(home, 'hive', 'agents', id, 'outbox');
  const inbox = (id) => path.join(home, 'hive', 'agents', id, 'inbox');
  const write = (from, msg) => fs.writeFileSync(path.join(outbox(from), `${msg.id}.json`), JSON.stringify(msg));
  const jsons = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  // startRouter queues one catch-up pass; let it settle so each test proves which path moved a file
  const start = async () => { hive.startRouter(); await hive.routerIdle(); };
  return { home, hive, rt, deliveries, outbox, inbox, write, jsons, start };
}
const msg = (id, to, extra = {}) => ({ id, to, act: 'inform', subject: `s-${id}`, body: 'b', ...extra });

test('A1 TIMER-FREE: a watch hint alone routes an outbox file and fires the delivery observer once', async (t) => {
  const f = await floor(t);
  await f.start();
  assert.equal(f.rt.intervals.length, 1, 'the reconciliation interval is captured, never fired');
  f.write('jim-1', msg('m1', 'god-1'));
  f.rt.live(f.outbox('jim-1')).hint();
  await f.rt.flush();
  assert.deepEqual(f.jsons(f.outbox('jim-1')), [], 'moved out of the outbox');
  assert.ok(fs.existsSync(path.join(f.outbox('jim-1'), '.sent', 'm1.json')), 'archived to .sent');
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm1.json')), 'written to the recipient inbox');
  assert.deepEqual(f.deliveries, [{ agentId: 'god-1', messageId: 'm1' }]);
});

test('A2 duplicate / coalesced hints in one turn produce ONE scan: one route, one delivery', async (t) => {
  const f = await floor(t);
  await f.start();
  f.write('jim-1', msg('m2', 'god-1'));
  const w = f.rt.live(f.outbox('jim-1'));
  let scans = 0;
  const real = f.hive.routePass.bind(f.hive);
  f.hive.routePass = (dirty) => { scans++; return real(dirty); };
  w.hint(); w.hint(); w.hint();
  assert.equal(f.rt.immediates.length, 1, 'one queued drain');
  await f.rt.flush();
  assert.equal(scans, 1);
  assert.deepEqual(f.deliveries, [{ agentId: 'god-1', messageId: 'm2' }]);
});

test('A2b a watcher-driven steady-state drain scans only its dirty outbox, not agents again', async (t) => {
  const f = await floor(t);
  await f.start();
  assert.equal(f.rt.intervals[0].ms, HiveManager.ROUTER_RECONCILE_MS, 'the only timer is the slow missed-watch backstop');
  f.write('jim-1', msg('m2b', 'god-1'));
  const agentsDir = path.join(f.home, 'hive', 'agents');
  const real = fs.readdirSync;
  const realAsync = fs.promises.readdir;
  let agentReads = 0;
  let outboxReads = 0;
  fs.readdirSync = function (dir, ...rest) {
    if (String(dir) === agentsDir) agentReads++;
    return real.call(this, dir, ...rest);
  };
  fs.promises.readdir = function (dir, ...rest) {
    if (String(dir) === agentsDir) agentReads++;
    if (String(dir) === f.outbox('jim-1')) outboxReads++;
    return realAsync.call(this, dir, ...rest);
  };
  try {
    f.rt.live(f.outbox('jim-1')).hint();
    await f.rt.flush();
  } finally { fs.readdirSync = real; fs.promises.readdir = realAsync; }
  assert.equal(agentReads, 0, 'no agents readdir (sync or async) on the watcher tick');
  assert.equal(outboxReads, 1, 'the dirty outbox is read once, async');
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm2b.json')));
});

test('A2c coalesced hints from different outboxes drain every dirty outbox', async (t) => {
  const f = await floor(t);
  await f.hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: f.home });
  await f.start();
  f.write('jim-1', msg('m2c-jim', 'god-1'));
  f.write('pam-1', msg('m2c-pam', 'god-1'));
  f.rt.live(f.outbox('jim-1')).hint();
  f.rt.live(f.outbox('pam-1')).hint();
  assert.equal(f.rt.immediates.length, 1, 'one queued drain carries both dirty paths');
  await f.rt.flush();
  assert.deepEqual(f.deliveries.map((d) => d.messageId).sort(), ['m2c-jim', 'm2c-pam']);
});

test('A2d a partial outbox is retried after grace and debounce without another watch hint', async (t) => {
  const f = await floor(t);
  await f.start();
  const file = path.join(f.outbox('jim-1'), 'partial.json');
  fs.writeFileSync(file, '{"id":"partial"');
  f.rt.live(f.outbox('jim-1')).hint();
  await f.rt.flush();
  assert.equal(f.rt.timeouts.length, 1, 'fresh partial schedules its grace retry');
  assert.ok(f.rt.timeouts[0].ms > 0 && f.rt.timeouts[0].ms <= 1000, `grace=${f.rt.timeouts[0].ms}`);

  // The delayed read sees an old incomplete file, establishes the debounce, then
  // the writer completes it without another directory event.
  const old = new Date(Date.now() - 2000);
  fs.utimesSync(file, old, old);
  f.rt.fireNextTimeout(); await f.rt.flush();
  assert.equal(f.rt.timeouts.length, 1, 'the parse retry is also scheduled');
  assert.equal(f.rt.timeouts[0].ms, 250);
  fs.writeFileSync(file, JSON.stringify(msg('partial', 'god-1')));
  f.rt.fireNextTimeout(); await f.rt.flush();
  assert.deepEqual(f.deliveries, [{ agentId: 'god-1', messageId: 'partial' }]);
});

test('A3 a missed watch event is repaired by the reconciliation interval', async (t) => {
  const f = await floor(t);
  await f.start();
  f.write('jim-1', msg('m3', 'god-1'));
  await f.rt.intervals[0].fn();               // no watch callback at all
  await f.rt.flush();
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm3.json')));
  assert.deepEqual(f.deliveries, [{ agentId: 'god-1', messageId: 'm3' }]);
});

test('A4 a newly hired agent is watched at once; a removed or archived agent\'s watcher closes on reconciliation', async (t) => {
  const f = await floor(t);
  await f.start();
  await f.hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: f.home });
  const pam = f.rt.live(f.outbox('pam-1'));
  assert.ok(pam, 'watched immediately, not at the next interval');
  f.write('pam-1', msg('m4', 'god-1'));
  pam.hint(); await f.rt.flush();
  assert.deepEqual(f.deliveries.map((d) => d.messageId), ['m4']);
  fs.rmSync(path.join(f.home, 'hive', 'agents', 'pam-1'), { recursive: true, force: true });
  await f.rt.intervals[0].fn(); await f.rt.flush();
  assert.equal(pam.closed, true, 'a vanished outbox is unwatched');
  const jim = f.rt.live(f.outbox('jim-1'));
  f.hive.setArchived('jim-1', true);
  await f.rt.intervals[0].fn(); await f.rt.flush();
  assert.equal(jim.closed, true, 'an archived agent is not watched');
});

test('A4b agent archive closes its outbox watcher before deleting an empty folder', async (t) => {
  const f = await floor(t);
  await f.start();
  const outbox = f.outbox('jim-1');
  const watcher = f.rt.live(outbox);
  f.hive.closeOutboxWatcher(outbox);
  fs.rmSync(path.dirname(outbox), { recursive: true, force: true });
  assert.equal(watcher.closed, true, 'the watcher is closed before archive removal');
  assert.equal(f.hive.watchedOutboxes().includes(outbox), false);
});

test('A5 the observer fires after a direct delivery and a bounce to god; never for a missing inbox or a terminal handoff', async (t) => {
  const f = await floor(t, { emit: () => true });   // the renderer accepts terminal handoffs
  await f.hive.ensureAgent({ id: 'kim-1', name: 'Kim', provider: 'custom', cwd: f.home });
  f.hive.send(msg('d1', 'jim-1'), 'god-1');
  assert.deepEqual(f.deliveries, [{ agentId: 'jim-1', messageId: 'd1' }], 'direct');
  f.deliveries.length = 0;
  f.hive.send(msg('d2', 'nobody'), 'jim-1');
  assert.equal(f.deliveries.length, 1, 'the bounce to god is a real delivery');
  assert.equal(f.deliveries[0].agentId, 'god-1');
  f.deliveries.length = 0;
  fs.rmSync(f.inbox('jim-1'), { recursive: true, force: true });
  f.hive.send(msg('d3', 'jim-1'), 'god-1');
  assert.ok(!f.deliveries.some((d) => d.agentId === 'jim-1'), 'a missing inbox is never reported as a delivery');
  fs.mkdirSync(path.join(f.inbox('jim-1'), '.done'), { recursive: true });
  f.deliveries.length = 0;
  f.hive.send(msg('d4', 'kim-1'), 'jim-1');
  assert.deepEqual(f.deliveries, [], 'a terminal handoff writes no inbox: no delivery');
  // An observer that throws never turns a durable write into a routing failure.
  f.hive.setDeliveryObserver(() => { throw new Error('boom'); });
  f.hive.send(msg('d5', 'jim-1'), 'god-1');
  assert.ok(fs.existsSync(path.join(f.inbox('jim-1'), 'd5.json')));
});

test('A6 watcher errors and stopRouter lose no files: a later scan or restart still routes them', async (t) => {
  const f = await floor(t);
  await f.start();
  const w = f.rt.live(f.outbox('jim-1'));
  w.handlers.error(new Error('EPERM'));
  assert.equal(w.closed, true, 'a broken watcher is dropped');
  f.write('jim-1', msg('m6', 'god-1'));
  await f.rt.intervals[0].fn(); await f.rt.flush();
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm6.json')), 'reconciliation routes it');
  assert.ok(f.rt.live(f.outbox('jim-1')), 'and re-attaches the watcher');
  // A hint queued, then the router stops: the queued scan never runs after the stop.
  f.write('jim-1', msg('m7', 'god-1'));
  f.rt.live(f.outbox('jim-1')).hint();
  f.hive.stopRouter();
  assert.ok([...f.rt.watchers.values()].every((x) => x.closed), 'stop closes every watcher');
  assert.equal(f.rt.intervals[0].cleared, true);
  await f.rt.flush();
  assert.ok(fs.existsSync(path.join(f.outbox('jim-1'), 'm7.json')), 'still on disk, not lost');
  f.hive.startRouter();                       // restart: the immediate catch-up scan routes it
  await f.hive.routerIdle();
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm7.json')));
});

test('A7 ORDER: the inbox file is on disk before the ledger entry, the ledger before the wake, the wake before .sent', async (t) => {
  const f = await floor(t);
  await f.start();
  const inboxFile = path.join(f.inbox('god-1'), 'm7.json');
  const outboxFile = path.join(f.outbox('jim-1'), 'm7.json');
  const sentFile = path.join(f.outbox('jim-1'), '.sent', 'm7.json');
  const steps = [];
  const off = f.hive.mail.subscribe((ev) => {
    if (ev.agentId !== 'god-1' || ev.id !== 'm7' || ev.stage !== 'delivered') return;
    steps.push({ step: 'ledger', inbox: fs.existsSync(inboxFile), sent: fs.existsSync(sentFile) });
  });
  t.after(off);
  f.hive.setDeliveryObserver((d) => {
    if (d.messageId !== 'm7') return;
    const doc = f.hive.mail.loadedDoc('god-1');
    steps.push({ step: 'wake', inbox: fs.existsSync(inboxFile), ledger: !!(doc && doc.entries.m7), outbox: fs.existsSync(outboxFile), sent: fs.existsSync(sentFile) });
  });
  f.write('jim-1', msg('m7', 'god-1'));
  f.rt.live(f.outbox('jim-1')).hint();
  await f.rt.flush();
  assert.deepEqual(steps, [
    { step: 'ledger', inbox: true, sent: false },
    { step: 'wake', inbox: true, ledger: true, outbox: true, sent: false }
  ]);
  assert.ok(fs.existsSync(sentFile), 'renamed to .sent after the wake');
  assert.ok(!fs.existsSync(outboxFile));
});

test('A8 SINGLE-FLIGHT: concurrent passes never overlap and deliver a mail once', async (t) => {
  const f = await floor(t);
  await f.start();
  let active = 0;
  let maxActive = 0;
  let passes = 0;
  const real = f.hive.routePass.bind(f.hive);
  f.hive.routePass = async (dirty) => {
    active++; passes++; maxActive = Math.max(maxActive, active);
    try { return await real(dirty); } finally { active--; }
  };
  f.write('jim-1', msg('m8', 'god-1'));
  const counts = await Promise.all([f.hive.routeOnce(), f.hive.routeOnce(), f.hive.routeOnce([f.outbox('jim-1')])]);
  // a hint that lands while those passes are queued joins one more pass, never a parallel one
  f.rt.live(f.outbox('jim-1')).hint();
  await f.rt.flush();
  assert.equal(maxActive, 1, 'passes ran one at a time');
  assert.equal(passes, 4);
  assert.deepEqual(counts, [1, 0, 0], 'the first pass routed it; the later ones found nothing');
  assert.deepEqual(f.deliveries.map((d) => d.messageId), ['m8'], 'one wake');
  assert.deepEqual(f.jsons(f.inbox('god-1')).filter((n) => n === 'm8.json'), ['m8.json']);
});

test('A9 only a .json (or unnamed) watch event asks for a scan', () => {
  assert.equal(outboxHintMatters('m1.json'), true);
  assert.equal(outboxHintMatters(Buffer.from('m1.json')), true);
  assert.equal(outboxHintMatters(null), true, 'the platform could not say what changed');
  assert.equal(outboxHintMatters(undefined), true);
  assert.equal(outboxHintMatters(''), true);
  assert.equal(outboxHintMatters('m1.json.tmp-123'), false, 'a temp file the writer renames later');
  assert.equal(outboxHintMatters('.sent'), false, 'the archive dir changing is the router itself');
  assert.equal(outboxHintMatters('notes.txt'), false);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(src, /watchDirectorySafely\(dir, \(_event, name\) => \{ if \(outboxHintMatters\(name\)\) onHint\(\); \}\)/, 'the node runtime filters hints');
});

test('A10 a reconcile reads each outbox once (the pass\'s own read; no separate existence read)', async (t) => {
  const f = await floor(t);
  await f.start();
  f.write('jim-1', msg('m10', 'god-1'));
  const reads = new Map();
  const realAsync = fs.promises.readdir;
  const realSync = fs.readdirSync;
  const count = (dir) => { const k = String(dir); if (/[\\/]outbox$/.test(k)) reads.set(k, (reads.get(k) || 0) + 1); };
  fs.promises.readdir = function (dir, ...rest) { count(dir); return realAsync.call(this, dir, ...rest); };
  fs.readdirSync = function (dir, ...rest) { count(dir); return realSync.call(this, dir, ...rest); };
  try {
    await f.rt.intervals[0].fn();
    await f.rt.flush();
  } finally { fs.promises.readdir = realAsync; fs.readdirSync = realSync; }
  assert.equal(reads.get(f.outbox('jim-1')), 1, 'the busy outbox is read once');
  assert.equal(reads.get(f.outbox('god-1')), 1, 'an idle outbox is read once');
  assert.ok(fs.existsSync(path.join(f.inbox('god-1'), 'm10.json')), 'the reconcile still routes');
});
