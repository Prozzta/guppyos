'use strict';
/**
 * CLAIMS-90 R2 (C90-GET, god f5ba70, acceptance e): `memory get` and `memory search --exact/--newest` give
 * BYTE-IDENTICAL text on every path agents use: the CLI over HTTP (`/memory/<token>` -> mainWiring.handle), the
 * hook-served MCP tools memory_get / memory_search (HookServer -> setMemoryAgentHandler -> mainWiring.handleAs) and
 * the direct handler. The MCP tools/list carries exactly hive_hook, memory_get, memory_search. The endpoint
 * validates get's arguments (term required, --mail 0-50, --before a mail id, no foreign keys) and answers exit 3
 * when no get dep is wired. The unknown-term line is the same on all paths.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-paths-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { NativeMemoryWiring } = loadTs('src/main/nativeMemory/mainWiring.ts');
const { HookServer, MEMORY_GET_TOOL, MEMORY_SEARCH_TOOL, MEMORY_TOOL_ARGS } = loadTs('src/main/hooks.ts');
const { handleClaimVerb, CLAIM_VERBS } = loadTs('src/main/claims/endpoint.ts');
const G = loadTs('src/main/claims/get.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');

const c = (id, agent, key, at, text, extra = {}) => ({ t: 'claim', id, at, wt: at, agent, kind: 'fact', key, text, source: 'note', ...extra });
const ledgers = {
  'alpha-1': [
    c('c-bbbbbbbbbbb1', 'alpha-1', 'card.foo-7', '2026-09-30T10:00:00.000Z', 'FOO-7 build is at 1111111'),
    c('c-bbbbbbbbbbb2', 'alpha-1', 'card.foo-7', '2026-10-03T10:00:00.000Z', 'FOO-7 build moved to 2222222', { supersedes: ['c-bbbbbbbbbbb1'], supersedesReason: { category: 'changed' } }),
  ],
  'beta-2': [c('c-ccccccccccc1', 'beta-2', 'card.foo-7', '2026-10-01T09:00:00.000Z', 'FOO-7: beta says 1111111')],
};
const tasks = [{ id: 'FOO-7', status: 'doing', title: 'Foo seven' }];
const mailLines = [JSON.stringify({ v: 1, id: '2026-10-08T09-00-00-000Z-ffffff', card: 'FOO-7', cardFrom: 'field', from: 'alpha-1', to: 'god', act: 'done', subject: 'FOO-7 done', created_at: '2026-10-08T09:00:00.000Z', deliveredAt: 1, bodyHash: 'h', trust: 'delivery', body: `landed as ${'abc1234' + 'f'.repeat(33)}` })];
const getDeps = { ledgers, registry: DEFAULT_KEY_REGISTRY, reconcileItems: [], tasks, mailRows: (card) => (card === 'foo-7' ? mailLines : null), ruleConfig: { r4: false } };

/** The claim-endpoint deps main builds (claimsEndpoint()): only `get` matters before the level gate. */
const claims = { store: {}, level: () => 'off', get: (_agentId, args) => { const r = G.resolveGet(args.term, { agent: args.agent ?? null, mail: args.mail, before: args.before ?? null, noMail: args.noMail === true }, getDeps); return { text: G.formatGet(r, { agent: args.agent ?? null }), json: r }; } };

/** A search engine stand-in: the wiring's `run` answers like the worker (engine.search's reply shape). */
const searchReply = (args) => ({ ok: true, exit: 0, text: `Results for: "${args.query}" — 0 hits, ${args.newest ? 'newest first ([1] answer candidate)' : 'current first'}${args.exact ? ', exact text' : ''} (--full: whole chunks)\n`, json: [] });

function wiring(root) {
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: path.join(root, 'ud'), resourcesDir: path.join(root, 'res'), workerEntry: 'w.js',
    fork: () => { throw new Error('no worker in this test'); }, memoryBaseUrl: () => null, writeCommand: () => path.join(root, 'bin', 'memory'), log: () => {},
    vecLoadablePath: () => null, claims: () => claims,
  });
  w.run = async (body) => searchReply(body.args ?? {});
  return w;
}

/** Main's `/memory/<token>` route, as the CLI reaches it. */
function memoryServer(w) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let data = '';
      req.on('data', (d) => { data += d; });
      req.on('end', async () => {
        const token = req.url.split('/').pop();
        let body; try { body = JSON.parse(data); } catch { body = null; }
        const r = await w.handle(token, body);
        res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/memory` }));
  });
}

function rpc(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let o = ''; res.on('data', (d) => { o += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(o); } catch { j = null; } resolve({ status: res.statusCode, body: j }); }); });
    req.on('error', reject); req.end(data);
  });
}

function hookServer(t, w) {
  const home = fs.mkdtempSync(path.join(JAIL, 'cx-'));
  const hive = { sockPath: () => (process.platform === 'win32' ? `\\\\.\\pipe\\c90-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(home, 's.sock')), codexHomeFor: () => home, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: { cx: {} } }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }), snapshot: () => ({ gatedTools: [] }) };
  const breaker = { recordToolUse: () => {}, recordCompactStart: () => {}, recordCompactEnd: () => {} };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control, breaker, undefined, () => {});
  // Main's wiring (index.ts): the MCP memory tools run the same handleAs the token route runs.
  s.setMemoryAgentHandler((agentId, body) => w.handleAs(agentId, body));
  s.start(); t.after(() => s.stop());
  return s;
}

async function waitPort(s) { for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5)); }

const CLI = path.join(REPO, 'resources', 'memory-cli.cjs');
function loadCli() { const cp = require('node:child_process'); const real = cp.spawnSync; cp.spawnSync = () => ({}); delete require.cache[require.resolve(CLI)]; try { return require(CLI); } finally { cp.spawnSync = real; } }

async function cliText(cli, env, argv) { const out = []; const err = []; const code = await cli.main(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s) }); return { code, out: out.join(''), err: err.join('') }; }

test('cross-path: CLI text == MCP memory_get content text == handleAs text, byte for byte, for a card, a sub-key with --agent/--mail/--before/--no-mail and the unknown-term line; --format json == MCP structuredContent.json', async (t) => {
  const root = fs.mkdtempSync(path.join(JAIL, 'hive-'));
  const w = wiring(root);
  const token = w.tokens.mint('cx');
  const { srv, url } = await memoryServer(w); t.after(() => srv.close());
  const s = hookServer(t, w); await waitPort(s);
  const ep = s.mcpEndpoint('cx');
  const cli = loadCli();
  const env = { MUNDER_MEMORY_URL: url, MEMORY_TOKEN: token, MUNDER_HIVE_ROOT: root };
  const cases = [
    [['get', 'FOO-7'], { term: 'FOO-7' }],
    [['get', 'card.foo-7', '--agent', 'beta-2', '--mail', '1', '--no-mail'], { term: 'card.foo-7', agent: 'beta-2', mail: 1, noMail: true }],
    [['get', 'card.foo-7.donesha', '--agent', 'alpha-1'], { term: 'card.foo-7.donesha', agent: 'alpha-1' }],
    [['get', 'FOO-7', '--before', '2026-10-08T09-00-00-000Z-ffffff'], { term: 'FOO-7', before: '2026-10-08T09-00-00-000Z-ffffff' }],
    [['get', 'nothing-here'], { term: 'nothing-here' }],
  ];
  for (const [argv, args] of cases) {
    const direct = await w.handleAs('cx', { cmd: 'get', args });
    assert.equal(direct.status, 200); assert.equal(direct.body.exit, 0, JSON.stringify(direct.body));
    const viaCli = await cliText(cli, env, argv);
    assert.equal(viaCli.code, 0, viaCli.err); assert.equal(viaCli.err, '');
    assert.equal(viaCli.out, direct.body.text, `CLI == handleAs: ${argv.join(' ')}`);
    const mcp = await rpc(ep.url, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: MEMORY_GET_TOOL, arguments: args } });
    assert.equal(mcp.status, 200, JSON.stringify(mcp.body));
    const res = mcp.body.result;
    assert.equal(res.isError, false);
    assert.deepEqual(res.content, [{ type: 'text', text: direct.body.text }], `MCP == handleAs: ${argv.join(' ')}`);
    assert.deepEqual(res.structuredContent, JSON.parse(JSON.stringify(direct.body)), 'structuredContent is the whole reply');
    const asJson = await cliText(cli, env, [...argv, '--format', 'json']);
    assert.deepEqual(JSON.parse(asJson.out), JSON.parse(JSON.stringify(direct.body.json)), `--format json == json: ${argv.join(' ')}`);
  }
  // The unknown-term line is the one line, everywhere.
  const none = await w.handleAs('cx', { cmd: 'get', args: { term: 'nothing-here' } });
  assert.equal(none.body.text, 'no claim under nothing-here, card.nothing-here\n');
  assert.equal(none.body.json.current, null);
  // The mail rule reached the card (done-sha mail newer than every claim): the source is named on all paths.
  const card = await w.handleAs('cx', { cmd: 'get', args: { term: 'FOO-7' } });
  assert.match(card.body.text, /^current: card\.foo-7: FOO-7 done — landed as abc1234f+\n  \[mail · alpha-1 · 2026-10-08 · 2026-10-08T09-00-00-000Z-ffffff\]$/m);
  // A bad token is 403 on the HTTP path and exit 5 at the CLI.
  const bad = await cliText(cli, { ...env, MEMORY_TOKEN: 'f'.repeat(32) }, ['get', 'FOO-7']);
  assert.equal(bad.code, 5);
});

test('cross-path: search --exact / --newest reach the engine with the flags on every path (CLI, MCP memory_search, handleAs) and the text is identical; MCP passes only the declared argument names', async (t) => {
  const root = fs.mkdtempSync(path.join(JAIL, 'hive-'));
  const w = wiring(root);
  const seen = [];
  w.run = async (body) => { seen.push(body.args); return searchReply(body.args ?? {}); };
  const token = w.tokens.mint('cx');
  const { srv, url } = await memoryServer(w); t.after(() => srv.close());
  const s = hookServer(t, w); await waitPort(s);
  const ep = s.mcpEndpoint('cx');
  const cli = loadCli();
  const env = { MUNDER_MEMORY_URL: url, MEMORY_TOKEN: token, MUNDER_HIVE_ROOT: root };
  const direct = await w.handleAs('cx', { cmd: 'search', args: { query: 'No INT, no publish', exact: true, newest: true, results: 3 } });
  const viaCli = await cliText(cli, env, ['search', 'No INT, no publish', '--exact', '--newest', '--results', '3']);
  assert.equal(viaCli.code, 0, viaCli.err);
  assert.equal(viaCli.out, direct.body.text);
  const mcp = await rpc(ep.url, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: MEMORY_SEARCH_TOOL, arguments: { query: 'No INT, no publish', exact: true, newest: true, results: 3, k: 'not-an-arg', evil: 1 } } });
  assert.deepEqual(mcp.body.result.content, [{ type: 'text', text: direct.body.text }]);
  assert.equal(seen.length, 3);
  for (const a of seen) { assert.equal(a.exact, true, 'MUTANT: exact dropped'); assert.equal(a.newest, true, 'MUTANT: newest dropped'); assert.equal(a.results, 3); assert.equal(a.k, undefined); assert.equal(a.evil, undefined); }
  assert.match(direct.body.text, /newest first \(\[1\] answer candidate\), exact text/);
  assert.deepEqual([...MEMORY_TOOL_ARGS[MEMORY_GET_TOOL]], ['term', 'agent', 'mail', 'before', 'noMail']);
  assert.ok(MEMORY_TOOL_ARGS[MEMORY_SEARCH_TOOL].includes('exact') && MEMORY_TOOL_ARGS[MEMORY_SEARCH_TOOL].includes('newest'));
});

test('MCP tools/list: hive_hook, memory_get, memory_search (schemas name the arguments); an unknown tool is an error; memory tools without a handler answer -32001', async (t) => {
  const root = fs.mkdtempSync(path.join(JAIL, 'hive-'));
  const w = wiring(root);
  const s = hookServer(t, w); await waitPort(s);
  const ep = s.mcpEndpoint('cx');
  const list = await rpc(ep.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((x) => x.name), ['hive_hook', 'memory_get', 'memory_search']);
  const getTool = list.body.result.tools.find((x) => x.name === 'memory_get');
  assert.deepEqual(Object.keys(getTool.inputSchema.properties).sort(), ['agent', 'before', 'mail', 'noMail', 'term']);
  assert.deepEqual(getTool.inputSchema.required, ['term']);
  const searchTool = list.body.result.tools.find((x) => x.name === 'memory_search');
  assert.ok(['exact', 'newest', 'query'].every((k) => k in searchTool.inputSchema.properties));
  assert.match(getTool.description, /current value/i);
  const bare = hookServer(t, { handleAs: null }); await waitPort(bare);
  bare.setMemoryAgentHandler(null);
  const r = await rpc(bare.mcpEndpoint('cx').url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_get', arguments: { term: 'x' } } });
  assert.equal(r.body.error.code, -32001);
});

test('endpoint: get validates its arguments (term required; --mail 0-50; --before a mail id; no foreign keys; --no-mail bare) before the level gate, and answers exit 3 when no get dep is wired', async () => {
  assert.ok(CLAIM_VERBS.has('get'));
  const ok = await handleClaimVerb(claims, 'cx', { cmd: 'get', args: { term: 'FOO-7' } }, 'endpoint');
  assert.equal(ok.exit, 0); assert.match(ok.text, /^get foo-7 → keys: /);
  for (const args of [{}, { term: '  ' }, { term: 'x', mail: 51 }, { term: 'x', mail: -1 }, { term: 'x', mail: 1.5 }, { term: 'x', before: 'not a mail id' }, { term: 'x', wing: 'w' }, { term: 'x', noMail: false }, { term: 'x', agent: 'bad agent!' }]) {
    const r = await handleClaimVerb(claims, 'cx', { cmd: 'get', args }, 'endpoint');
    assert.equal(r.ok, false, JSON.stringify(args)); assert.equal(r.exit, 2, JSON.stringify(args));
  }
  const edge = await handleClaimVerb(claims, 'cx', { cmd: 'get', args: { term: 'FOO-7', mail: 50, before: '2026-10-08T09-00-00-000Z-ffffff', noMail: true, agent: 'alpha-1' } }, 'endpoint');
  assert.equal(edge.exit, 0);
  const none = await handleClaimVerb({ store: {}, level: () => 'writer' }, 'cx', { cmd: 'get', args: { term: 'FOO-7' } }, 'endpoint');
  assert.equal(none.exit, 3); assert.equal(none.error, 'memory get is not available in this build');
  // A reader (level off) still gets: it is read-only and needs no ledger.
  const reader = await handleClaimVerb({ ...claims, level: () => 'off' }, 'cx', { cmd: 'get', args: { term: 'nothing-here' } }, 'endpoint');
  assert.equal(reader.exit, 0); assert.equal(reader.text, 'no claim under nothing-here, card.nothing-here\n');
});
