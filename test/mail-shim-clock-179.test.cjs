'use strict';
// MAIL-PIPE-SHIM-CLOCK (1.1.79, GATE-179 round 1; god's ruling (1)+(a)).
//
// The gate found a LOST message: the real AGY shim printed nothing (its own 5 s give-up), yet the
// ledger said surfaced / confirmed by latency. The two clocks start at different times: the shim
// arms its give-up when it has read its stdin; the server measured from ITS read of the request to
// the flush. On a Windows pipe the flush (libuv's FlushFileBuffers) also completes when the shim
// CLOSES, so a shim descheduled before sending (the server reads late) and again before reading
// exits empty-handed while the server sees an in-time flush.
//  (1) every pipe shim sends shim_elapsed_ms (its running time at send); the server measures
//      shim_elapsed_ms + arrival-to-flush against the same 2.5 s limit;
//  (a) at the give-up, a shim first drains what is already in the pipe and prints a complete reply.
// The descheduling is made deterministic with a --require preload that blocks the REAL shim's main
// thread before and after its request (what a loaded OS does to it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shim-clock-'));
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
const { HiveManager, HOOK_SHIM, AGY_HOOK_SHIM, GEMINI_HOOK_SHIM, GROK_HOOK_SHIM } = loadTs('src/main/hive.ts');

// The deschedule: block the shim's main thread PRE ms before it writes its request and POST ms
// after (the reply arrives while it is blocked; on resume libuv runs the timers phase first).
const PRELOAD = path.join(JAIL, 'deschedule.cjs');
fs.writeFileSync(PRELOAD, `'use strict';
const net = require('node:net');
const pre = Number(process.env.SHIM_TEST_PRE_MS || 0), post = Number(process.env.SHIM_TEST_POST_MS || 0);
const block = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* descheduled */ } };
const orig = net.createConnection;
net.createConnection = function (...a) {
  const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
  return orig.call(this, ...a, function () { block(pre); if (cb) cb.apply(this, arguments); block(post); });
};
`);

/** Run a real shim (its source text) with the deschedule; resolves its stdout and run time. */
function runShim(source, args, env, stdin, { pre = 0, post = 0 } = {}) {
  return new Promise((resolve) => {
    const file = path.join(JAIL, `shim-${Math.random().toString(36).slice(2)}.cjs`);
    fs.writeFileSync(file, source);
    const t0 = Date.now();
    const ch = spawn(process.execPath, ['--require', PRELOAD, file, ...args], { env: { ...process.env, ...env, SHIM_TEST_PRE_MS: String(pre), SHIM_TEST_POST_MS: String(post) }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = ''; ch.stdout.on('data', (d) => { out += d; });
    const guard = setTimeout(() => { try { ch.kill(); } catch { /* gone */ } }, 30_000);
    ch.on('close', () => { clearTimeout(guard); resolve({ out, ms: Date.now() - t0 }); });
    ch.stdin.end(stdin);
  });
}

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  const server = { current: null };
  t.after(() => { try { server.current?.stop(); } catch { /* noop */ } hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'ag-1', name: 'ag-1', provider: 'claude', cwd: home });
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r = reg(); r.agents['ag-1'] = { ...r.agents['ag-1'], provider: 'antigravity' }; return r; };
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined, undefined, () => {});
  server.current = s;
  const entryOf = (id) => hive.mail.ledger('ag-1').entries[id];
  const logRows = () => { try { return fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  s.start();
  return { hive, server: s, entryOf, logRows, home };
}

/** One AGY PreInvocation through the real shim and the real HookServer pipe; the settled outcome. */
async function agyRound(t, deschedule) {
  const f = await floor(t);
  const m = f.hive.send({ to: 'ag-1', act: 'request', subject: 'for agy', body: 'agy body' }, 'god-1');
  const r = await runShim(AGY_HOOK_SHIM, ['PreInvocation'], { AGENT_ID: 'ag-1', HIVE_SOCK: f.hive.sockPath() }, JSON.stringify({ conversationId: 'conv-1', workspacePaths: [f.home] }), deschedule);
  const late = () => f.logRows().find((x) => x.kind === 'mail-hook-late' && x.ids.includes(m.id));
  for (let i = 0; i < 400 && f.entryOf(m.id).state !== 'surfaced' && !late(); i++) await new Promise((res) => setTimeout(res, 5));
  const e = f.entryOf(m.id);
  return { printed: r.out.includes(`[hive-mail:${m.id}]`), out: r.out, ms: r.ms, state: e.state, confirm: e.confirmMethod, late: late() ?? null };
}

/** THE invariant: a message is never confirmed by latency unless its block was printed. */
function neverSurfacedUnprinted(r, what) {
  if (r.state === 'surfaced') assert.ok(r.printed, `${what}: LOST: the ledger says surfaced/${r.confirm} but the shim printed nothing (${r.ms} ms)`);
}

test('(1) unit: shimElapsedMs reads a finite non-negative number, capped at the shim\'s 5 s give-up; anything else is 0 (an older shim)', () => {
  assert.equal(S.shimElapsedMs(1234), 1234);
  assert.equal(S.shimElapsedMs(12.6), 13);
  assert.equal(S.shimElapsedMs(0), 0);
  assert.equal(S.shimElapsedMs(60_000), S.MAIL_PIPE_HOOK_TIMEOUT_MS);
  for (const v of [undefined, null, -5, NaN, Infinity, '3000', {}]) assert.equal(S.shimElapsedMs(v), 0, String(v));
});

test('GATE-179 (the lost message): the AGY shim descheduled 3.5 s before its request and 2 s after is LATE (its own time counted), never surfaced unprinted', async (t) => {
  const r = await agyRound(t, { pre: 3_500, post: 2_000 });
  neverSurfacedUnprinted(r, 'gate shape');
  assert.ok(r.late, `(1): a mail-hook-late row: the shim's 3.5 s before sending is counted (${JSON.stringify(r)})`);
  assert.ok(r.late.latencyMs >= 3_500 && r.late.latencyMs >= S.MAIL_PIPE_LATENCY_LIMIT_MS, `latency ${r.late.latencyMs}`);
  assert.equal(r.state, 'surfacing', 'not confirmed: it is re-surfaced with the marker');
});

test('(a) Creed\'s case: a reply already in the pipe when the shim\'s give-up fires (0.5 s before, 4.6 s after its request) is PRINTED, and measured late', async (t) => {
  const r = await agyRound(t, { pre: 500, post: 4_600 });
  assert.ok(r.printed, `(a): the give-up drains the pipe and prints the complete reply (${r.ms} ms, ${r.out.length} B)`);
  assert.ok(JSON.parse(r.out).injectSteps[0].userMessage.startsWith('<hive-mail>'), 'a whole, valid AGY reply');
  neverSurfacedUnprinted(r, 'after-finish');
  assert.ok(r.late && r.late.latencyMs >= S.MAIL_PIPE_LATENCY_LIMIT_MS, 'the server measure is late (a marked duplicate at worst)');
});

test('control: an undisturbed shim prints at once and is confirmed by latency (the clock adds only its few ms)', async (t) => {
  const r = await agyRound(t, {});
  assert.ok(r.printed && r.ms < 4_000, `${r.ms} ms`);
  assert.deepEqual({ state: r.state, confirm: r.confirm, late: r.late }, { state: 'surfaced', confirm: 'latency', late: null });
});

test('(1) the server strips shim_elapsed_ms before handling, and an older shim (no field) keeps the old measure', async (t) => {
  const f = await floor(t);
  const seen = [];
  const handle = f.server.handle.bind(f.server);
  f.server.handle = (p) => { seen.push({ ...p }); return handle(p); };
  const send = (payload) => new Promise((resolve) => {
    const c = net.createConnection(f.hive.sockPath(), () => c.write(JSON.stringify(payload) + '\n'));
    let out = ''; c.setEncoding('utf8'); c.on('data', (d) => { out += d; }); c.on('end', () => resolve(out)); c.on('error', () => resolve(null));
  });
  await send({ hook_event_name: 'PostToolUse', agent_id: 'ag-1', shim_elapsed_ms: 1_000 });
  await send({ hook_event_name: 'PostToolUse', agent_id: 'ag-1' });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((p) => !('shim_elapsed_ms' in p)), 'the field never reaches handle()');
  // An older shim and a 2.4 s server: on time, as before. The same with a shim that had run 2 s: late.
  const late = [];
  const settle = f.server.settleMailClaims.bind(f.server);
  f.server.settleMailClaims = (claims, receivedAt, flushedAt) => { late.push(flushedAt - receivedAt); return settle(claims, receivedAt, flushedAt); };
  for (const shimMs of [undefined, 2_000]) {
    f.hive.send({ to: 'ag-1', act: 'request', subject: `s${shimMs}`, body: 'b' }, 'god-1');
    await send({ hook_event_name: 'PreInvocation', agent_id: 'ag-1', ...(shimMs ? { shim_elapsed_ms: shimMs } : {}) });
  }
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(late.length, 2, 'both claims settled');
  assert.ok(late[0] < 1_000, `no field: the server's own measure (${late[0]} ms)`);
  assert.ok(late[1] >= 2_000, `with the field: the shim's 2 s are added (${late[1]} ms)`);
});

// Every request/response pipe shim with the 5 s give-up carries (1) and (a): a fake pipe server
// that records the request and answers at once; the shim is descheduled 3 s before and 5.5 s after.
const SHIMS = [
  ['HOOK_SHIM (Claude/Codex command hooks)', () => HOOK_SHIM, ['--agent', 'cx-1'], { hook_event_name: 'UserPromptSubmit' }],
  ['AGY_HOOK_SHIM', () => AGY_HOOK_SHIM, ['PreInvocation'], { conversationId: 'c' }],
  ['GEMINI_HOOK_SHIM', () => GEMINI_HOOK_SHIM, [], { hook_event_name: 'BeforeAgent' }],
  ['GROK_HOOK_SHIM', () => GROK_HOOK_SHIM, [], { hookEventName: 'user_prompt_submit' }]
];
for (const [name, src, args, input] of SHIMS) {
  test(`(1)+(a) ${name}: sends shim_elapsed_ms (its time before sending) and, descheduled past its give-up, still prints the reply already in the pipe`, async () => {
    const sock = process.platform === 'win32' ? `\\\\.\\pipe\\md-shim-clock-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(JAIL, `s-${Math.random().toString(36).slice(2)}.sock`);
    const got = [];
    const server = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
        got.push(JSON.parse(buf.slice(0, nl)));
        conn.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'X', additionalContext: 'CTX-REACHED-THE-CLI' } }));
      });
      conn.on('error', () => {});
    });
    await new Promise((res) => server.listen(sock, res));
    try {
      const r = await runShim(src(), args, { AGENT_ID: 'cx-1', HIVE_SOCK: sock }, JSON.stringify(input), { pre: 3_000, post: 5_500 });
      assert.equal(got.length, 1, 'the request arrived');
      assert.ok(got[0].shim_elapsed_ms >= 3_000 && got[0].shim_elapsed_ms <= 5_000, `(1): shim_elapsed_ms ${got[0].shim_elapsed_ms}`);
      assert.ok(r.out.includes('CTX-REACHED-THE-CLI'), `(a): printed at the give-up (${r.ms} ms): ${JSON.stringify(r.out)}`);
    } finally { server.close(); }
  });
}

for (const [name, src, args, input] of SHIMS) {
  test(`(a) ${name}: a give-up with NO complete reply in the pipe still exits empty, within its bound (never prints a partial reply)`, async () => {
    const sock = process.platform === 'win32' ? `\\\\.\\pipe\\md-shim-clock-partial-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(JAIL, `p-${Math.random().toString(36).slice(2)}.sock`);
    const server = net.createServer((conn) => { conn.on('data', () => conn.write('{"hookSpecificOutput":{"additionalCon')); conn.on('error', () => {}); });
    await new Promise((res) => server.listen(sock, res));
    try {
      const r = await runShim(src(), args, { AGENT_ID: 'cx-1', HIVE_SOCK: sock }, JSON.stringify(input), {});
      assert.equal(r.out, '', 'nothing printed: a partial reply is no reply (AGY even reads any stdout object as a decision)');
      assert.ok(r.ms >= 4_900 && r.ms < 15_000, `gave up at its 5 s bound (${r.ms} ms)`);
    } finally { server.close(); }
  });
}
