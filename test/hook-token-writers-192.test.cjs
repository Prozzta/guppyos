'use strict';
require('./tools/own-job.cjs');

/**
 * PIPE-HOOK-NO-TOKEN-192 (Jim SHOULD-2 + NIT): every hook writer that is not the Claude or AGY
 * shim (gemini, grok, the pi extension, the opencode plugin, the proxy sidecar) sends the spawn's
 * HIVE_HOOK_TOKEN as hook_token on each frame it writes, and without one it writes nothing and says
 * so ONCE on stderr. Real runs of the real sources against a fake hive socket.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-token-writers-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { PI_EXTENSION, OPENCODE_PLUGIN, PROXY_BRIDGE_SHIM, GEMINI_HOOK_SHIM, GROK_HOOK_SHIM } = loadTs('src/main/hive.ts');
const TOKEN = 'ab'.repeat(16);
const MISSING = '[munder] missing HIVE_HOOK_TOKEN';

/** The child's whole env: this process's, minus every hive identity it may carry (a real agent's). */
function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HIVE_|AGENT_|MEMORY_)/i.test(k)) env[k] = v;
  return { ...env, HOME: JAIL, USERPROFILE: JAIL, ...extra };
}

/** A fake hive socket: collects every JSON frame written to it. */
async function fakeSock(t) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\md-token-writers-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(fs.mkdtempSync(path.join(JAIL, 's-')), 's.sock');
  const frames = [];
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    // One frame per connection; the shims that wait for an answer get an empty one.
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i !== -1) { frames.push(JSON.parse(buf.slice(0, i))); buf = ''; c.end('{}\n'); }
    });
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  return { sock, frames };
}

/** Run `file` with node; resolves with its stderr once it exits (a hang guard kills it). */
function run(file, env, stdin = '') {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [file], { env, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let err = ''; ch.stderr.on('data', (d) => { err += d; });
    const guard = setTimeout(() => { try { ch.kill(); } catch { /* gone */ } }, 30_000);
    ch.on('close', (code) => { clearTimeout(guard); resolve({ code, err }); });
    ch.stdin.on('error', () => {});
    ch.stdin.end(stdin);
  });
}
const settle = () => new Promise((r) => setTimeout(r, 200));
const write = (name, src) => { const f = path.join(fs.mkdtempSync(path.join(JAIL, 'w-')), name); fs.writeFileSync(f, src); return f; };
const count = (s, sub) => s.split(sub).length - 1;

/** The pi extension, loaded the way pi loads it, fires agent_end. */
async function runPi(env) {
  const ext = write('hive-bridge.js', PI_EXTENSION);
  const driver = write('drive.cjs', `const ext = require(${JSON.stringify(ext)}); const pi = { h: {}, on(n, f) { this.h[n] = f; } }; ext(pi); pi.h.agent_end(); pi.h.tool_result({ name: 'bash' });`);
  return run(driver, env);
}
/** The opencode plugin (ESM), loaded the way opencode loads it, sees session.idle. */
async function runOpencode(env) {
  const plugin = write('hive-bridge.mjs', OPENCODE_PLUGIN);
  const driver = write('drive.mjs', `const m = await import(${JSON.stringify(pathToFileURL(plugin).href)}); const h = await m.default(); await h.event({ event: { type: 'session.idle' } }); await h['tool.execute.after']({ tool: 'bash' });`);
  return run(driver, env);
}
/** The proxy sidecar forwards one chat completion to a fake upstream and emits its usage. */
async function runProxy(t, env) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 5, completion_tokens: 2 } })); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  t.after(() => upstream.close());
  const shim = write('hive-proxy.cjs', PROXY_BRIDGE_SHIM);
  const ch = spawn(process.execPath, [shim], { env: { ...env, UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}` }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  ch.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => ch.on('close', r));
  t.after(() => { try { ch.kill(); } catch { /* gone */ } });
  const port = await new Promise((resolve) => ch.stdout.on('data', (d) => { out += d; const m = /"port":(\d+)/.exec(out); if (m) resolve(Number(m[1])); }));
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' } }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'gpt-4o', messages: [] }));
  });
  await settle();
  ch.kill(); await exited;
  return { err };
}

const WRITERS = [
  ['PI_EXTENSION', (t, env) => runPi(env), ['Stop', 'PostToolUse']],
  ['OPENCODE_PLUGIN', (t, env) => runOpencode(env), ['Stop', 'PostToolUse']],
  ['PROXY_BRIDGE_SHIM', (t, env) => runProxy(t, env), ['Status', 'CostSample']],
  ['GEMINI_HOOK_SHIM', (t, env) => run(write('gemini-hook.cjs', GEMINI_HOOK_SHIM), env, JSON.stringify({ hook_event_name: 'AfterAgent' })), ['Stop']],
  ['GROK_HOOK_SHIM', (t, env) => run(write('grok-hook.cjs', GROK_HOOK_SHIM), env, JSON.stringify({ hookEventName: 'stop' })), ['Stop']]
];

for (const [name, go, events] of WRITERS) {
  test(`${name}: every frame carries the spawn's HIVE_HOOK_TOKEN as hook_token`, async (t) => {
    const { sock, frames } = await fakeSock(t);
    const r = await go(t, childEnv({ HIVE_SOCK: sock, AGENT_ID: 'ag-1', HIVE_HOOK_TOKEN: TOKEN }));
    await settle();
    assert.deepEqual(frames.map((f) => f.hook_event_name).sort(), [...events].sort(), `the frames ${name} writes`);
    for (const f of frames) { assert.equal(f.hook_token, TOKEN, `${f.hook_event_name} carries the token`); assert.equal(f.agent_id, 'ag-1'); }
    assert.equal(count(r.err, MISSING), 0, 'no warning with a token');
  });

  test(`${name}: without HIVE_HOOK_TOKEN it writes nothing and says so once on stderr`, async (t) => {
    const { sock, frames } = await fakeSock(t);
    const r = await go(t, childEnv({ HIVE_SOCK: sock, AGENT_ID: 'ag-1' }));
    await settle();
    assert.deepEqual(frames, [], 'no tokenless frame');
    assert.equal(count(r.err, MISSING), 1, `one stderr line: ${JSON.stringify(r.err)}`);
  });
}

test('outside the hive (no HIVE_SOCK) no writer warns', async (t) => {
  for (const [name, go] of WRITERS) {
    const r = await go(t, childEnv({ AGENT_ID: 'ag-1' }));
    assert.equal(count(r.err, MISSING), 0, name);
  }
});
