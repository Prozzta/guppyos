'use strict';

/**
 * CLAUDE-MODEL-LIST-STALE (1.1.80 candidate; god c2ff06, mechanism verified by Phyllis d70be0):
 * "Refresh models" lists Claude from Claude Code ITSELF (what /model shows), through its initialize
 * handshake: `claude -p --input-format stream-json --output-format stream-json --verbose`, one
 * control_request {subtype: initialize}, `response.response.models` from the control_response; then
 * stdin is ended and the process tree killed inside a 10 s time box. `account` is never kept.
 *
 * The fake claude below is a REAL process (a .cmd shim + node on Windows, a sh script elsewhere) that
 * speaks the protocol: success, signed out, an auth error, no --verbose, a hang, garbage, empty.
 * Its MODELS are the shape claude 2.1.287 returned on 2026-10-02 (account values replaced by fakes).
 * Named mutants (census at the end; compiled from text): C1 signed-out accepted, C2 any request_id
 * accepted, C3 no tree kill, C4 no time box, C5 aliases kept as aliases, C6 the API key used although
 * Claude Code is installed, C7 `account` returned by the parser, C8 --verbose dropped, C9 label
 * without a version, C10 a silent exit 0 reported as "exit 0", C11 run in the caller's cwd; after Creed's audit C12 C13 third-party users called signed out, C14 the verdict on exit not close, C15 C16 no POSIX group kill.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource: read, codeOnly } = require('./read-source.cjs');

const SRC = 'src/main/providerModels.ts';
const P = loadTs(SRC);
const C = loadTs('src/renderer/src/store/config.ts');
const WIN = process.platform === 'win32';

// claude 2.1.287's reply on a Max login (descriptions trimmed; effort fields dropped).
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet 5' },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5' },
  { value: 'claude-fable-5', resolvedModel: 'claude-fable-5', displayName: 'Fable 5' },
  { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' },
  { value: 'claude-opus-4-7', resolvedModel: 'claude-opus-4-7', displayName: 'Opus 4.7' },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6' },
  { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' }
];
// the same CLI signed out: aliases only, displayName without a version
const SIGNED_OUT_MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }
];
const ACCOUNT = { email: 'secret@example.invalid', organization: 'SecretOrg', subscriptionType: 'Claude Max', apiProvider: 'firstParty' };
const LEAK = /secret@example\.invalid|SecretOrg|Claude Max|firstParty|subscriptionType|account|email/i;
const EXPECTED_IDS = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'];

const line = (o) => `${JSON.stringify(o)}\n`;
const reply = (id, models, account, subtype = 'success') => line({ type: 'control_response', response: { subtype, request_id: id, response: { commands: [], models, account, pid: 1 } } });

// ── the parser (pure) ────────────────────────────────────────────────────────────────────

function parseChecks(R) {
  const ok = R.parseClaudeInitialize(line({ type: 'system', subtype: 'init' }) + 'not json\n' + reply(R.CLAUDE_REQUEST_ID, MODELS, ACCOUNT));
  assert.deepEqual(Object.keys(ok).sort(), ['error', 'models', 'signedIn'], 'C7: the parser returns models and "signed in" only, never `account`');
  assert.doesNotMatch(JSON.stringify(ok), LEAK, 'C7: nothing of `account` leaves the parser');
  assert.deepEqual(ok.models.map((m) => m.id), EXPECTED_IDS, 'C5: aliases become their resolved full ids; "default" adds only its model; duplicates once');
  assert.deepEqual(ok.models.slice(0, 4).map((m) => m.label), ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5'], 'C9: the "default" row is labelled by its model, not "Default (recommended)"');
  assert.equal(ok.signedIn, true);
  const out = R.parseClaudeInitialize(reply(R.CLAUDE_REQUEST_ID, SIGNED_OUT_MODELS, { tokenSource: 'none', apiProvider: 'firstParty' }));
  assert.equal(out.signedIn, false, 'signed out: tokenSource none');
  assert.deepEqual(out.models.map((m) => m.label), ['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 4.5'], 'C9: a label without a version takes it from the id');
  assert.equal(R.parseClaudeInitialize(reply(R.CLAUDE_REQUEST_ID, MODELS, { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY' })).signedIn, true, 'an API key counts as signed in');
  assert.equal(R.parseClaudeInitialize(reply(R.CLAUDE_REQUEST_ID, MODELS, undefined)).signedIn, null, 'an older CLI without `account`: unknown, not an error');
  assert.equal(R.parseClaudeInitialize(reply('someone-else', MODELS, ACCOUNT)), null, 'C2: only the reply to OUR request counts');
  assert.equal(R.parseClaudeInitialize('{"broken":\n<html>\n'), null, 'garbage is not a reply');
  assert.deepEqual(R.parseClaudeInitialize(line({ type: 'control_response', response: { subtype: 'error', request_id: R.CLAUDE_REQUEST_ID, error: 'Invalid API key · Please run /login' } })),
    { models: null, signedIn: null, error: 'Invalid API key · Please run /login' });
  const unsafe = R.claudeModelsFromInit([{ value: 'x', resolvedModel: 'claude-x"; calc', displayName: 'X 1' }, { value: 'claude-opus-4-8', displayName: 'Opus 4.8' }]);
  assert.deepEqual(unsafe, [{ id: 'claude-opus-4-8', label: 'Opus 4.8' }], 'an id unsafe for a command line is dropped');
  assert.equal(R.claudeModelsFromInit('nope'), null);
  assert.equal(R.claudeModelsFromInit([]), null);
}
test('parser: the reply to our initialize; aliases -> full ids; labels with versions; signed in or not; never `account`', () => parseChecks(P));

test('failures in plain words', () => {
  assert.equal(P.claudeFailure('Error: When using --print, --output-format=stream-json requires --verbose\n', 1), P.CLAUDE_REASONS.verbose);
  assert.equal(P.claudeFailure('Invalid API key · Please run /login', 1), P.CLAUDE_REASONS.notSignedIn);
  assert.equal(P.claudeFailure('Not logged in', 1), P.CLAUDE_REASONS.notSignedIn);
  assert.equal(P.claudeFailure("error: unknown option '--input-format'", 1), P.CLAUDE_REASONS.tooOld);
  assert.equal(P.claudeFailure('boom', 3), 'exit 3');
  assert.deepEqual(Object.values(P.CLAUDE_REASONS), ['claude not found', 'not signed in: open Claude Code and run /login', 'timed out after 10 s',
    'Claude Code refused --verbose: update Claude Code', 'this Claude Code cannot list its models: update Claude Code', 'no model list in its reply']);
  assert.equal(P.CLAUDE_LIST_TIMEOUT_MS, 10_000, 'the time box is 10 s');
});

// ── a fake claude: a real process speaking the protocol ─────────────────────────────────

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-list-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const FAKE_JS = path.join(JAIL, 'fake-claude.cjs');
fs.writeFileSync(FAKE_JS, `'use strict';
const fs = require('fs');
const mode = process.env.FAKE_CLAUDE_MODE; const log = process.env.FAKE_CLAUDE_LOG;
const MODELS = ${JSON.stringify(MODELS)}; const SIGNED_OUT = ${JSON.stringify(SIGNED_OUT_MODELS)}; const ACCOUNT = ${JSON.stringify(ACCOUNT)};
fs.writeFileSync(log, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
if (mode === 'noverbose') { process.stderr.write('Error: When using --print, --output-format=stream-json requires --verbose\\n'); process.exit(1); }
let buf = '';
process.stdin.on('data', (d) => {
  buf += d; const i = buf.indexOf('\\n'); if (i < 0 || buf === null) return;
  const req = JSON.parse(buf.slice(0, i)); buf = '';
  fs.appendFileSync(log, JSON.stringify({ req }) + '\\n');
  out({ type: 'system', subtype: 'init' }); process.stdout.write('not json at all\\n');
  if (mode === 'hang') return;
  if (mode === 'garbage') { process.stdout.write('{"broken":\\n'); out({ type: 'control_response', response: { subtype: 'success', request_id: 'someone-else', response: { models: MODELS } } }); setTimeout(() => process.exit(Number(process.env.FAKE_EXIT || 0)), 50); return; }
  if (mode === 'autherror') { out({ type: 'control_response', response: { subtype: 'error', request_id: req.request_id, error: 'Invalid API key · Please run /login' } }); return; }
  const account = mode === 'signedout' ? { tokenSource: 'none', apiProvider: 'firstParty' } : ACCOUNT;
  out({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: { commands: [], models: mode === 'signedout' ? SIGNED_OUT : mode === 'empty' ? [] : MODELS, account, pid: process.pid } } });
});
setInterval(() => {}, 1000); // like the real CLI: alive until its tree is killed
`);
const FAKE = WIN ? path.join(JAIL, 'claude.cmd') : path.join(JAIL, 'claude');
fs.writeFileSync(FAKE, WIN ? `@"${process.execPath}" "${FAKE_JS}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${FAKE_JS}" "$@"\n`);
if (!WIN) fs.chmodSync(FAKE, 0o755);

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_|HIVE_|AGENT_|MEMORY_|MUNDER_|FAKE_)/.test(k)));
let n = 0;
/** Deps: real spawn and real taskkill; `where` / `command -v` answer with the fake (or nothing). */
function deps(mode, { found = true, extra = {} } = {}) {
  const log = path.join(JAIL, `log-${++n}.jsonl`);
  const tmpDir = fs.mkdtempSync(path.join(JAIL, 'cwd-'));
  const env = { ...baseEnv, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, SHELL: '/bin/sh', ...extra };
  const d = {
    platform: process.platform, env, tmpDir, exists: (p) => fs.existsSync(p),
    exec: (file, args, opts, cb) => {
      if (file === 'where' || (file === '/bin/sh' && args[0] === '-lc')) { setImmediate(() => cb(found ? null : Object.assign(new Error('nf'), { code: 1 }), found ? `${FAKE}\n` : '')); return { pid: 0 }; }
      return execFile(file, args, opts, (e, so) => cb(e, String(so ?? '')));
    },
    spawn: (f, a, o) => spawn(f, a, o)
  };
  const entries = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { d, log, tmpDir, entries };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid, ms = 4000) { const t = Date.now(); while (alive(pid) && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 100)); return !alive(pid); }
const sameDir = (a, b) => fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();
const noKey = () => undefined;
const noFetch = async () => { throw new Error('the API must not be called'); };

async function successChecks(R) {
  const f = deps('success');
  const r = await R.claudeAdapter(f.d, noKey, noFetch)();
  const [start, got] = f.entries();
  try {
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.deepEqual(r.models.map((m) => m.id), EXPECTED_IDS);
    assert.equal(r.source, 'claude initialize (the /model list)');
    assert.deepEqual(start.argv, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], 'C8: the four flags, --verbose included');
    assert.deepEqual(got.req, { type: 'control_request', request_id: R.CLAUDE_REQUEST_ID, request: { subtype: 'initialize' } }, 'one initialize request');
    assert.ok(sameDir(start.cwd, f.tmpDir), `C11: claude runs in the temp dir, never an agent's project (${start.cwd})`);
    assert.ok(await gone(start.pid), 'C3: the claude process (below the .cmd shim) is killed once it answered');
  } finally { if (start && alive(start.pid)) try { process.kill(start.pid); } catch { /* gone */ } }
}
test('REAL fake claude, success: 11 models, the four flags, one initialize, temp cwd, the process TREE killed', { timeout: 30_000 }, () => successChecks(P));

async function signedOutChecks(R) {
  const f = deps('signedout');
  const r = await R.claudeAdapter(f.d, noKey, noFetch)();
  assert.deepEqual([r.status, r.reason], ['failed', R.CLAUDE_REASONS.notSignedIn], 'C1: a signed-out CLI\'s generic list is not taken as the user\'s list');
  await gone(f.entries()[0].pid);
}
test('REAL fake claude, signed out: failed "not signed in" (its generic list is not used)', { timeout: 30_000 }, () => signedOutChecks(P));

test('REAL fake claude, auth error / no --verbose / empty list: plain words', { timeout: 30_000 }, async () => {
  for (const [mode, reason] of [['autherror', P.CLAUDE_REASONS.notSignedIn], ['noverbose', P.CLAUDE_REASONS.verbose], ['empty', P.CLAUDE_REASONS.noList]]) {
    const f = deps(mode);
    const r = await P.claudeAdapter(f.d, noKey, noFetch)();
    assert.deepEqual([r.status, r.reason], ['failed', reason], mode);
    await gone(f.entries()[0].pid);
  }
});

async function hangChecks(R) {
  const f = deps('hang');
  const t0 = Date.now();
  const r = await Promise.race([R.runClaudeInit(f.d, FAKE, 1500), new Promise((res) => setTimeout(() => res({ reason: 'NO TIME BOX' }), 6000))]);
  const pid = f.entries()[0]?.pid;
  try {
    assert.deepEqual(r, { reason: R.CLAUDE_REASONS.timeout }, 'C4: a claude that never answers is cut off by the time box');
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(await gone(pid), 'C4: and its process tree is killed');
  } finally { if (pid && alive(pid)) try { process.kill(pid); } catch { /* gone */ } }
}
test('REAL fake claude, hang: timed out inside the box and the tree killed', { timeout: 30_000 }, () => hangChecks(P));

async function garbageChecks(R) {
  const f = deps('garbage');
  assert.deepEqual(await R.runClaudeInit(f.d, FAKE), { reason: R.CLAUDE_REASONS.noList }, 'C2/C10: garbage and a reply to someone else, then exit 0: no list');
  const g = deps('garbage', { extra: { FAKE_EXIT: '3' } });
  assert.deepEqual(await R.runClaudeInit(g.d, FAKE), { reason: 'exit 3' });
}
test('REAL fake claude, garbage: no list (a foreign reply does not count); a failing exit is named', { timeout: 30_000 }, () => garbageChecks(P));

async function byokChecks(R) {
  let fetched = 0;
  const fetchJson = async () => { fetched++; return { status: 200, body: { data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }] } }; };
  const present = deps('success');
  const r = await R.claudeAdapter(present.d, () => 'sk-ant-test', fetchJson)();
  assert.deepEqual([r.status, r.source, fetched], ['ok', 'claude initialize (the /model list)', 0], 'C6: Claude Code installed: the CLI is the source, the API key is not used');
  await gone(present.entries()[0].pid);
  const missing = deps('success', { found: false });
  missing.d.exists = () => false;
  assert.deepEqual(await R.claudeAdapter(missing.d, noKey, noFetch)(), { status: 'not-installed', reason: 'claude not found' });
  const viaKey = await R.claudeAdapter(missing.d, () => 'sk-ant-test', fetchJson)();
  assert.deepEqual([viaKey.status, viaKey.source, fetched], ['ok', 'Anthropic Models API (your API key; Claude Code not found)', 1], 'not installed + a stored key: the API, said plainly');
  const denied = await R.claudeAdapter(missing.d, () => 'k', async () => ({ status: 401, body: {} }))();
  assert.deepEqual([denied.status, denied.reason], ['failed', 'Claude Code not found; the API key listing failed: HTTP 401']);
}
test('the CLI is the source of truth: the API key only when Claude Code is not installed', { timeout: 30_000 }, () => byokChecks(P));

test('the models file: validated, nothing of `account` in the file or the log; the picker keeps the [1m] variants', { timeout: 30_000 }, async (t) => {
  const f = deps('success');
  const dir = fs.mkdtempSync(path.join(JAIL, 'store-'));
  const logs = [];
  const store = new P.ProviderModelStore({ path: path.join(dir, 'models.json'), now: () => 5000, log: (r) => logs.push(r) });
  const { file, rows } = await store.refresh({ claude: P.claudeAdapter(f.d, noKey, noFetch) });
  await gone(f.entries()[0].pid);
  const text = fs.readFileSync(path.join(dir, 'models.json'), 'utf8');
  assert.doesNotMatch(text, LEAK, 'no account field or value in models.json');
  assert.doesNotMatch(JSON.stringify(logs), LEAK, 'none in the log row');
  assert.doesNotMatch(JSON.stringify(rows), LEAK, 'none in the Refresh rows');
  assert.deepEqual(P.validModelsFile(JSON.parse(text)), file, 'the written file survives re-validation unchanged');
  assert.deepEqual([rows[0].provider, rows[0].status, rows[0].count], ['claude', 'ok', 11]);
  C.setModelCatalog(file);
  t.after(() => C.setModelCatalog(null));
  const ids = C.modelsForProvider('claude').map((m) => m.id);
  assert.deepEqual(ids.slice(0, 2), [undefined, 'claude-opus-5-5']);
  for (const v of ['claude-opus-5-5[1m]', 'claude-opus-4-8[1m]', 'claude-sonnet-4-6[1m]']) assert.ok(ids.includes(v), `${v} kept for its listed base id`);
});

test('WIRING: the app passes spawn; claude is listed by claudeAdapter; no credentials file is read', () => {
  const idx = codeOnly(read('src/main/index.ts'));
  assert.match(idx, /spawn: \(file: string, args: string\[\], opts: Parameters<typeof spawn>\[2\]\) => spawn\(file, args, opts\)/);
  const src = codeOnly(read(SRC));
  assert.match(src, /claude: claudeAdapter\(d, getAnthropicKey, fetchJson\)/);
  assert.doesNotMatch(src, /\.credentials|credentials\.json|readFileSync\([^)]*claude/i, 'the app never reads Claude credentials');
  assert.doesNotMatch(src, /spawnSync|execSync|execFileSync/);
});

// ── Creed's notes (N1-N3): an injected child, so the event order and the platform are exact ──

const { EventEmitter } = require('node:events');
/** A scripted child: `script(child)` runs once the request is written. */
function scriptedDeps(platform, script, env = {}) {
  const seen = { opts: null, kills: [], writes: [] };
  const d = {
    platform, env: { ComSpec: 'cmd.exe', ...env }, tmpDir: os.tmpdir(), exists: () => true,
    exec: (file, args, opts, cb) => { seen.kills.push([file, ...args]); setImmediate(() => cb(null, '')); return { pid: 1 }; },
    kill: (pid, sig) => { seen.kills.push([pid, sig]); },
    spawn: (file, args, opts) => {
      seen.opts = opts;
      const c = new EventEmitter(); c.pid = 4321;
      c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
      c.stdin = { on: () => {}, end: () => {}, write: (s) => { seen.writes.push(s); setImmediate(() => script(c, JSON.parse(s))); } };
      c.kill = (sig) => seen.kills.push(['child.kill', sig]);
      return c;
    }
  };
  return { d, seen };
}

async function closeChecks(R) {
  // node may emit 'exit' before the last stderr chunk; the verdict must wait for 'close'
  const { d } = scriptedDeps('win32', (c) => {
    c.emit('exit', 1, null);
    c.stderr.emit('data', 'Error: When using --print, --output-format=stream-json requires --verbose\n');
    c.emit('close', 1, null);
  });
  assert.deepEqual(await R.runClaudeInit(d, 'C:\\x\\claude.exe', 3000), { reason: R.CLAUDE_REASONS.verbose }, 'C14: the final parse waits for close (stderr read)');
  const late = scriptedDeps('win32', (c, req) => {
    c.emit('exit', 0, null);
    c.stdout.emit('data', reply(req.request_id, MODELS, ACCOUNT).slice(0, 40));
    c.stdout.emit('data', reply(req.request_id, MODELS, ACCOUNT).slice(40));
    c.emit('close', 0, null);
  });
  const r = await R.runClaudeInit(late.d, 'C:\\x\\claude.exe', 3000);
  assert.deepEqual(r.init && r.init.models.map((m) => m.id), EXPECTED_IDS, 'C14: a reply that lands after exit still counts');
}
test('N1: the verdict waits for close: stderr or a reply arriving after exit still counts', () => closeChecks(P));

async function groupKillChecks(R) {
  const { d, seen } = scriptedDeps('linux', (c, req) => c.stdout.emit('data', reply(req.request_id, MODELS, ACCOUNT)));
  const r = await R.runClaudeInit(d, '/usr/local/bin/claude', 3000);
  assert.equal(r.init.models.length, 11);
  assert.equal(seen.opts.detached, true, 'C16: on POSIX claude leads its own process group');
  assert.deepEqual(seen.kills, [[-4321, 'SIGKILL']], 'C15: the whole group is killed (negative pid), not just the direct child');
  const w = scriptedDeps('win32', (c, req) => c.stdout.emit('data', reply(req.request_id, MODELS, ACCOUNT)));
  await R.runClaudeInit(w.d, 'C:\\x\\claude.exe', 3000);
  assert.equal(w.seen.opts.detached, undefined, 'Windows: no detached (it would open a console)');
  assert.deepEqual(w.seen.kills, [['taskkill', '/PID', '4321', '/T', '/F']]);
}
test('N3: POSIX kills the detached process GROUP; Windows the tree (taskkill /T)', () => groupKillChecks(P));

async function thirdPartyChecks(R) {
  assert.equal(R.parseClaudeInitialize(reply(R.CLAUDE_REQUEST_ID, MODELS, { tokenSource: 'none', apiProvider: 'bedrock' })).signedIn, null, 'C13: a Bedrock account shape is "cannot tell", not signed out');
  for (const k of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    const { d } = scriptedDeps('win32', (c, req) => c.stdout.emit('data', reply(req.request_id, SIGNED_OUT_MODELS, { tokenSource: 'none', apiProvider: 'firstParty' })), { [k]: '1' });
    d.exec = (file, args, opts, cb) => { setImmediate(() => cb(null, file === 'where' ? 'C:\\x\\claude.exe\r\n' : '')); return { pid: 1 }; };
    const r = await R.claudeAdapter(d, noKey, noFetch)();
    assert.equal(r.status, 'ok', `C12: ${k}=1 is never "not signed in" (${r.reason})`);
  }
  assert.equal(R.thirdPartyProvider({ CLAUDE_CODE_USE_BEDROCK: '0' }), false);
  assert.equal(R.thirdPartyProvider({}), false);
}
test('N2: Bedrock / Vertex / Foundry users are never called "not signed in"', () => thirdPartyChecks(P));

// ── Mutant census ────────────────────────────────────────────────────────────────────────

const MUTANTS = [
  ['C1 signed-out accepted', "    if (r.init.signedIn === false && !thirdPartyProvider(d.env)) return { status: 'failed', reason: CLAUDE_REASONS.notSignedIn, source };\n", '', signedOutChecks],
  ['C2 any request_id accepted', ' || j.response.request_id !== requestId) continue;', ') continue;', parseChecks],
  ['C3 no tree kill', 'const killTree = (): void => {\n      if (exited) return;', 'const killTree = (): void => {\n      return;', successChecks],
  ['C4 no time box', '    timer = setTimeout(() => done({ reason: CLAUDE_REASONS.timeout }), timeout);\n', '', hangChecks],
  ['C5 aliases kept', "const id = typeof m.resolvedModel === 'string' && m.resolvedModel.trim() ? m.resolvedModel.trim() : m.value.trim();", 'const id = m.value.trim();', parseChecks],
  ['C6 API key used with Claude Code installed', "const exe = await resolveCliAsync(d, 'claude');\n    if (!exe) {", "const exe = await resolveCliAsync(d, 'claude');\n    if (!exe || getKey()) {", byokChecks],
  ['C7 parser returns account', 'return { models: claudeModelsFromInit(r?.models), signedIn: signedInFrom(r?.account), error: null };', 'return { models: claudeModelsFromInit(r?.models), signedIn: signedInFrom(r?.account), error: null, account: r?.account } as ClaudeInit;', parseChecks],
  ['C8 --verbose dropped', "'--output-format', 'stream-json', '--verbose'];", "'--output-format', 'stream-json'];", successChecks],
  ['C9 label without version', "const label = m.value !== 'default' && /\\d/.test(shown) ? shown : claudeLabel(id);", 'const label = shown || claudeLabel(id);', parseChecks],
  ['C10 silent exit 0 as "exit 0"', 'c === 0 && !err.trim() ? CLAUDE_REASONS.noList : ', '', garbageChecks],
  ['C11 caller cwd', 'cwd: d.tmpDir ?? tmpdir(),', 'cwd: process.cwd(),', successChecks],
  ['C12 third-party env ignored', ' && !thirdPartyProvider(d.env)) return', ') return', thirdPartyChecks],
  ['C13 third-party account shape ignored', "  if (has('apiProvider') && a.apiProvider !== 'firstParty') return null;\n", '', thirdPartyChecks],
  ['C14 final parse on exit', "child.on('close', (code) => {", "child.on('exit', (code) => {", closeChecks],
  ['C15 only the direct child killed', "(d.kill ?? process.kill)(-pid, 'SIGKILL')", "(d.kill ?? process.kill)(pid, 'SIGKILL')", groupKillChecks],
  ['C16 not detached on POSIX', "...(d.platform === 'win32' ? {} : { detached: true }), ", '', groupKillChecks]
];

test('MUTANT CENSUS CLAUDE-MODEL-LIST: C1-C16 each apply once and die', { timeout: 300_000 }, async (t) => {
  const source = fs.readFileSync(path.join(__dirname, '..', SRC), 'utf8').replace(/\r\n/g, '\n');
  for (const [name, from, to, killer] of MUTANTS) {
    await t.test(name, async () => {
      assert.equal(source.split(from).length - 1, 1, `${name}: the edit applies exactly once`);
      const R = loadTs.fromText(SRC, source.replace(from, () => to));
      let died = null;
      try { await killer(R); } catch (e) { died = e; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${name}${died ? ` (died of ${died.message})` : ''}`);
    });
  }
});
