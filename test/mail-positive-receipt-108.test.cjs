'use strict';
require('./tools/own-job.cjs');

/**
 * MAIL-POSITIVE-RECEIPT (1.1.108, A14). A surfaced mail is confirmed only on evidence from the
 * agent's side. The http and mcp hook clients (Claude Code, Codex) give up on a hook after 30 s
 * (MAIL_HTTP_HOOK_TIMEOUT_MS) and cannot send us their clock. The server measured a reply's
 * latency from the moment IT read the request to the moment the reply was handed to the kernel
 * ('finish'). A main thread stalled before the read therefore measures a few milliseconds for a
 * reply whose client hung up long ago, and the N1 fallback (2 unconfirmed surfacings: confirm by
 * latency alone, `latency-fallback`) marked that mail surfaced. Stop then archived it to
 * inbox/.done: mail the agent never saw, gone. Seen live on 1.1.78 (2026-10-02, two mails).
 *
 * The same holds for a latency-evidence provider (every provider but claude and codex: no record
 * of its context that we can read). Today those post over the pipe only: an http hook URL is
 * written into Claude's settings alone, the mcp endpoint into Codex's. The server does not rely on
 * that: a latency-evidence agent that posts over http is not confirmed by latency either.
 *
 * The stall here is the real one: the main thread is blocked until each client has given up at
 * the product's own 30 s and has read nothing. It is an event, not a bet on milliseconds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-receipt-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const S = loadTs('src/main/mailSurface.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

/** A hook client on its own thread, so it keeps its clock while the main thread is stalled. It
 *  posts once and gives up `giveUpMs` after the request was written, as the real clients do. It
 *  reports how many response bytes it had read by then: slot 1+i, then one more in slot 0.
 *  `onGiveUp` is what it does with its socket: 'close' destroys it; 'keep-open' walks away from
 *  the request and leaves the socket open (it reads nothing more and never looks at it again). */
const CLIENT = `
const { workerData: w } = require('node:worker_threads');
const http = require('node:http');
const cells = new Int32Array(w.sab);
let got = 0; let over = false;
const done = () => { if (over) return; over = true; Atomics.store(cells, 1 + w.slot, got); Atomics.add(cells, 0, 1); Atomics.notify(cells, 0); };
const u = new URL(w.url); const data = Buffer.from(w.body);
const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
  res.on('data', (d) => { if (!over) got += d.length; }); res.on('end', done);
});
req.on('error', done);
req.end(data, () => setTimeout(() => { if (w.onGiveUp === 'close') req.destroy(); done(); }, w.giveUpMs));
`;

async function floor(t, providers) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  for (const id of Object.keys(providers)) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r0 = reg(); const r = { ...r0, agents: { ...r0.agents } }; for (const [id, p] of Object.entries(providers)) r.agents[id] = { ...r.agents[id], provider: p }; return r; };
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const server = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined, undefined, () => {});
  t.after(() => { try { server.stop(); } catch { /* noop */ } hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  server.start();
  for (let i = 0; i < 200 && server.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  assert.notEqual(server.hookBrokerPort(), null, 'the hook broker is listening');
  const entryOf = (agentId, id) => hive.mail.ledger(agentId).entries[id];
  const logRows = () => { try { return fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { hive, server, entryOf, logRows, home };
}

/** One mail to `agentId`, already surfaced twice with no evidence: the next surfacing is the one
 *  the N1 fallback used to confirm by latency alone. */
function twiceUnconfirmed(f, agentId, event) {
  const m = f.hive.send({ to: agentId, act: 'request', subject: `for ${agentId}`, body: `body for ${agentId}` }, 'god-1');
  for (const e of ['x1', 'x2']) { f.hive.mail.claimSurfacing(agentId, [m.id], e, event); f.hive.mail.closeEpoch(agentId, e, 'normal'); }
  assert.equal(f.entryOf(agentId, m.id).unconfirmedSurfacings, 2);
  return m;
}

const inboxHas = (f, agentId, id) => fs.existsSync(path.join(f.hive.root(), 'agents', agentId, 'inbox', `${id}.json`));
const archived = (f, agentId, id) => fs.existsSync(path.join(f.hive.root(), 'agents', agentId, 'inbox', '.done', `${id}.json`));

/**
 * ONE 30 s stall for every case: four agents, each with one hook in flight. The main thread is
 * blocked until all four clients have given up at the product's own timeout with 0 bytes read.
 */
test('a 30 s main-thread stall before the hook is read: the client gave up unread, so the mail is never confirmed and archived', { timeout: 120_000 }, async (t) => {
  const f = await floor(t, { 'cl-1': 'claude', 'cx-1': 'codex', 'cl-2': 'claude', 'cx-2': 'codex', 'ag-1': 'antigravity' });
  const http = (agentId, onGiveUp) => ({ agentId, transport: 'http', onGiveUp, session: `s-${agentId}`, mail: twiceUnconfirmed(f, agentId, 'UserPromptSubmit'), url: f.server.hookUrl(agentId), body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'go', session_id: `s-${agentId}` }) });
  // A latency-evidence provider (AGY surfaces at PreInvocation) on the http broker: a FIRST
  // surfacing, which the latency rule confirms with no fallback involved.
  const latencyHttp = (agentId, onGiveUp) => ({ agentId, transport: 'http', onGiveUp, session: `s-${agentId}`, evidence: 'latency', surfacedBefore: 0, mail: f.hive.send({ to: agentId, act: 'request', subject: `for ${agentId}`, body: `body for ${agentId}` }, 'god-1'), url: f.server.hookUrl(agentId), body: JSON.stringify({ hook_event_name: 'PreInvocation', session_id: `s-${agentId}` }) });
  const mcp = (agentId, onGiveUp) => {
    const ep = f.server.mcpEndpoint(agentId);
    return { agentId, transport: 'mcp', onGiveUp, session: `thread-${agentId}`, mail: twiceUnconfirmed(f, agentId, 'PostToolUse'), url: ep.url, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hive_hook', arguments: { event: 'PostToolUse', k: ep.token }, _meta: { threadId: `thread-${agentId}` } } }) };
  };
  assert.equal(S.mailEvidenceKind('antigravity'), 'latency');
  const requests = [http('cl-1', 'close'), mcp('cx-1', 'close'), http('cl-2', 'keep-open'), mcp('cx-2', 'keep-open'), latencyHttp('ag-1', 'keep-open')];

  // Every settle of a mail claim, by agent: the product's own verdict on each reply.
  const settled = new Map();
  const waiters = new Map();
  const realSettle = f.server.settleMailClaims.bind(f.server);
  f.server.settleMailClaims = (claims, receivedAt, flushedAt) => {
    realSettle(claims, receivedAt, flushedAt);
    for (const c of claims) { settled.set(c.agentId, { latency: flushedAt === null ? null : flushedAt - receivedAt }); waiters.get(c.agentId)?.(); }
  };

  const giveUpMs = S.MAIL_HTTP_HOOK_TIMEOUT_MS;
  assert.equal(giveUpMs, 30_000, 'the hook timeout of the clients');
  const cells = new Int32Array(new SharedArrayBuffer(4 * (1 + requests.length)));
  const workers = requests.map((r, slot) => new Worker(CLIENT, { eval: true, workerData: { sab: cells.buffer, slot, url: r.url, body: r.body, giveUpMs, onGiveUp: r.onGiveUp } }));
  t.after(() => Promise.all(workers.map((w) => w.terminate())));

  // THE STALL: the main thread does not turn until every client has given up. The requests sit
  // in the kernel, unread.
  const stalledAt = Date.now();
  for (let n = Atomics.load(cells, 0); n < requests.length; n = Atomics.load(cells, 0)) {
    assert.notEqual(Atomics.wait(cells, 0, n, giveUpMs + 30_000), 'timed-out', `HARNESS: a hook client never gave up (${n} of ${requests.length} done)`);
  }
  const stalledMs = Date.now() - stalledAt;
  assert.ok(stalledMs >= giveUpMs, `the main thread was stalled past the client give-up (${stalledMs} ms)`);
  requests.forEach((r, slot) => assert.equal(Atomics.load(cells, 1 + slot), 0, `HARNESS: the ${r.transport} client of ${r.agentId} read a reply before it gave up`));

  // The loop turns again: the server reads the requests, answers them, and settles the claims.
  for (const r of requests) {
    if (settled.has(r.agentId)) continue;
    let watchdog;
    await Promise.race([
      new Promise((resolve) => waiters.set(r.agentId, resolve)),
      new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error(`HARNESS: the ${r.transport} hook for ${r.agentId} never settled a mail claim (the mail was not put in its reply)`)), 20_000); })
    ]);
    clearTimeout(watchdog);
  }

  /** The mail was never seen: it is not confirmed, and the end of the turn leaves it in the inbox
   *  with one more unconfirmed surfacing, to come again with the re-delivered marker. */
  const neverConfirmed = (r) => {
    const id = r.mail.id;
    const e = f.entryOf(r.agentId, id);
    assert.notEqual(e.state, 'surfaced', `MAIL CONFIRMED UNSEEN (${r.transport}, socket ${r.onGiveUp}): the client gave up with 0 bytes read, the server measured ${settled.get(r.agentId).latency} ms and confirmed it by "${e.confirmMethod}"`);
    f.server.handle({ agent_id: r.agentId, hook_event_name: 'Stop', session_id: r.session });
    assert.equal(archived(f, r.agentId, id), false, `MAIL LOST (${r.transport}, socket ${r.onGiveUp}): archived to inbox/.done, never seen by the agent`);
    assert.equal(inboxHas(f, r.agentId, id), true, `the ${r.transport} mail is still in the inbox`);
    const again = f.entryOf(r.agentId, id);
    const want = (r.surfacedBefore ?? 2) + 1;
    assert.ok(again.unconfirmedSurfacings >= want, `the ${r.transport} mail counts one more unconfirmed surfacing (${again.unconfirmedSurfacings}, want ${want})`);
  };

  for (const r of requests) {
    const what = r.onGiveUp === 'close' ? 'closed its socket at give-up (the reply never flushes)' : 'gave up but left its socket open (the reply flushes into a socket nobody reads)';
    await t.test(`${r.transport}${r.evidence === 'latency' ? ' (a latency-evidence provider)' : ''}: the client ${what}`, () => neverConfirmed(r));
  }
});
