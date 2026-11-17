'use strict';
require('./tools/own-job.cjs');

/**
 * ROUTER-ASYNC-DELIVER-107 (Jim's audit, mutants R10/R11/R9): a failed inbox write must never look
 * like a delivery. Both runners pass the write's failure back into the routing steps
 * (steps.throw); a runner that swallowed it (steps.next) would mark the mail delivered, wake the
 * recipient and move the outbox file to .sent without the inbox file ever landing: silent mail
 * loss. Each runner gets one fault-injection case. The third case pins the route chain: a pass
 * that rejects must not poison the passes queued behind it.
 * Invented subjects and bodies only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
// The same cached module object hive.ts imports; its calls read the export at call time.
const AJ = loadTs('src/main/atomicJson.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-inbox-fault-'));
  const priorHome = process.env.HOME;
  const priorUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const hive = new HiveManager(() => home, () => {});
  t.after(() => {
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    if (priorUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = priorUserProfile;
    try { hive.dispose(); } catch { /* disposed by the test */ }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const agentDir = (id) => path.join(hive.root(), 'agents', id);
  // Spies on the two effects a delivery has after its write: the ledger entry and the wake.
  const delivered = [];
  const realMark = hive.mail.markDelivered.bind(hive.mail);
  hive.mail.markDelivered = (agentId, msg) => { delivered.push({ agentId, id: msg.id }); return realMark(agentId, msg); };
  const woken = [];
  hive.setDeliveryObserver((d) => woken.push(d));
  const godInbox = agentDir('god-1') + path.sep + 'inbox' + path.sep;
  const isGodInbox = (file) => String(file).startsWith(godInbox);
  const inboxJson = (id) => fs.readdirSync(path.join(agentDir(id), 'inbox')).filter((f) => f.endsWith('.json'));
  return { hive, home, agentDir, delivered, woken, isGodInbox, inboxJson };
}

const MSG = { to: 'god-1', act: 'inform', subject: 'invented: fault case', body: 'invented body for a write that fails' };

test('R10: send() (sync runner) throws on a failed inbox write; no ledger entry, no wake, no file', async (t) => {
  const f = await floor(t);
  const realWrite = f.hive.atomicWriteJson;
  let failedWrites = 0;
  f.hive.atomicWriteJson = function (file, data) {
    if (f.isGodInbox(file)) { failedWrites++; throw new Error('invented: disk refused the inbox write'); }
    return realWrite.call(this, file, data);
  };
  t.after(() => { f.hive.atomicWriteJson = realWrite; });

  assert.throws(() => f.hive.send(MSG, 'jim-1'), /disk refused the inbox write/);
  assert.equal(failedWrites, 1, 'the injected failure was reached');
  assert.deepEqual(f.inboxJson('god-1'), [], 'nothing landed in the inbox');
  assert.deepEqual(f.delivered.filter((d) => d.agentId === 'god-1'), [], 'no delivered ledger entry');
  assert.deepEqual(f.woken.filter((d) => d.agentId === 'god-1'), [], 'no wake');
});

test('R11: routeOnce (async runner) on a failed inbox write: route-failed, not .sent, no ledger entry, no wake', async (t) => {
  const f = await floor(t);
  const realAsync = AJ.atomicWriteJsonAsync;
  let failedWrites = 0;
  AJ.atomicWriteJsonAsync = async (file, data) => {
    if (f.isGodInbox(file)) { failedWrites++; throw new Error('invented: disk refused the inbox write'); }
    return realAsync(file, data);
  };
  t.after(() => { AJ.atomicWriteJsonAsync = realAsync; });

  const outbox = path.join(f.agentDir('jim-1'), 'outbox');
  const name = 'fault.json';
  fs.writeFileSync(path.join(outbox, name), JSON.stringify(MSG));
  await f.hive.routeOnce();

  assert.equal(failedWrites, 1, 'the injected failure was reached');
  assert.deepEqual(f.inboxJson('god-1'), [], 'nothing landed in the inbox');
  assert.deepEqual(f.delivered.filter((d) => d.agentId === 'god-1'), [], 'no delivered ledger entry');
  assert.deepEqual(f.woken.filter((d) => d.agentId === 'god-1'), [], 'no wake');
  const sent = path.join(outbox, '.sent');
  // A rejection archives the file as .sent/bad-<name>; a delivery would rename it to .sent/<name>.
  const archivedAs = fs.existsSync(sent) ? fs.readdirSync(sent).filter((x) => x.includes('fault')) : [];
  assert.deepEqual(archivedAs, [`bad-${name}`], 'archived as rejected, never as sent');
  const rows = f.hive.logTail(200).filter((e) => e.kind === 'outbox-rejected' && e.file === name);
  assert.equal(rows.length, 1, 'rejected once, visibly');
  assert.equal(rows[0].reason, 'route-failed');
  assert.match(String(rows[0].error ?? rows[0].detail ?? JSON.stringify(rows[0])), /disk refused the inbox write/);
});

test('R9: a route pass that rejects does not poison the passes queued behind it', async (t) => {
  const f = await floor(t);
  const realPass = f.hive.routePass;
  // A pass starts on a later turn, so the stub is one-shot: the first pass throws, later ones are real.
  let calls = 0;
  f.hive.routePass = async function (...args) {
    if (++calls === 1) throw new Error('invented: pass blew up');
    return realPass.apply(this, args);
  };
  t.after(() => { f.hive.routePass = realPass; });
  const failed = f.hive.routeOnce();
  // Queued while the failing pass is still pending, so it chains behind it.
  const outbox = path.join(f.agentDir('jim-1'), 'outbox');
  fs.writeFileSync(path.join(outbox, 'after.json'), JSON.stringify({ ...MSG, subject: 'invented: after the failed pass' }));
  const next = f.hive.routeOnce();
  await assert.rejects(failed, /pass blew up/);
  assert.equal(await next, 1, 'the next pass ran and routed the message');
  assert.equal(calls, 2);
  assert.equal(f.inboxJson('god-1').length, 1);
  await f.hive.routerIdle();
});

/** LAG-SYNC-FS-LOG-108: the synchronous existsSync calls on `<agent>/inbox` made while fn runs. */
async function inboxProbes(f, fn) {
  const real = fs.existsSync;
  const seen = [];
  const inboxes = new Set(['god-1', 'jim-1', 'nobody-9'].map((id) => path.resolve(f.agentDir(id), 'inbox')));
  // The mail ledger's hasAgent (closeAnsweredAsks) asks about an inbox too: another call site,
  // not the delivery's question, so it is not counted here.
  fs.existsSync = (p) => { if (typeof p === 'string' && inboxes.has(path.resolve(p)) && !/MailLedger\./.test(new Error('x').stack)) seen.push(path.basename(path.dirname(path.resolve(p)))); return real(p); };
  try { await fn(); } finally { fs.existsSync = real; }
  return seen;
}

test('LAG-SYNC-FS-LOG-108: routeOnce asks whether the recipient has an inbox off the main thread; send() still asks on its own thread', async (t) => {
  const f = await floor(t);
  const outbox = path.join(f.agentDir('jim-1'), 'outbox');
  fs.writeFileSync(path.join(outbox, 'probe.json'), JSON.stringify(MSG));
  const stats = [];
  const realStat = fs.promises.stat;
  fs.promises.stat = (p, ...rest) => { stats.push(String(p)); return realStat(p, ...rest); };
  let routed;
  let seen;
  try { seen = await inboxProbes(f, async () => { routed = await f.hive.routeOnce(); }); } finally { fs.promises.stat = realStat; }
  assert.equal(routed, 1);
  assert.equal(f.inboxJson('god-1').length, 1, 'delivered');
  assert.deepEqual(seen, [], 'no synchronous existsSync on an inbox folder during the route');
  assert.ok(stats.includes(path.join(f.agentDir('god-1'), 'inbox')), 'the inbox was asked for through fs.promises');
  assert.equal(f.woken.filter((d) => d.agentId === 'god-1').length, 1, 'and the wake followed the write');

  // The synchronous runner is unchanged: the answer and the delivery are there when send() returns.
  const seenSync = await inboxProbes(f, () => { f.hive.send({ ...MSG, subject: 'invented: sent on-thread' }, 'jim-1'); });
  assert.deepEqual(seenSync, ['god-1']);
  assert.equal(f.inboxJson('god-1').length, 2);
});

test('LAG-SYNC-FS-LOG-108: a recipient with no inbox is still reported to the sender on both runners, and nothing is written for it', async (t) => {
  const f = await floor(t);
  // Known to the registry, its folder gone: deliverSteps answers false and the router bounces.
  await f.hive.ensureAgent({ id: 'nobody-9', name: 'Nobody', provider: 'claude', cwd: f.home });
  fs.rmSync(path.join(f.agentDir('nobody-9'), 'inbox'), { recursive: true, force: true });
  const lost = { to: 'nobody-9', act: 'inform', subject: 'invented: no inbox', body: 'invented body for a recipient without an inbox' };
  const before = f.woken.length;
  fs.writeFileSync(path.join(f.agentDir('jim-1'), 'outbox', 'lost.json'), JSON.stringify(lost));
  await f.hive.routeOnce();
  assert.equal(fs.existsSync(path.join(f.agentDir('nobody-9'), 'inbox')), false, 'the missing inbox was not created');
  assert.deepEqual(f.woken.slice(before).filter((d) => d.agentId === 'nobody-9'), [], 'no delivery to it');
  const afterAsync = f.woken.length;
  assert.ok(afterAsync > before, 'someone was told (the bounce)');
  f.hive.send({ ...lost, subject: 'invented: no inbox, on-thread' }, 'jim-1');
  assert.equal(fs.existsSync(path.join(f.agentDir('nobody-9'), 'inbox')), false);
  assert.deepEqual(f.woken.slice(afterAsync).filter((d) => d.agentId === 'nobody-9'), []);
  assert.ok(f.woken.length > afterAsync, 'the same bounce from send()');
});
