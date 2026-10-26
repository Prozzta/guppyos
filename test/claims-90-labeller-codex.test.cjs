'use strict';
/**
 * CLAIMS-90 T6 (god 495956 and cfacba, Jim 475eab and f7d551): labeller --provider codex. A fake codex
 * (test/fixtures/claims-90-fake-codex.cjs) that drives the real jail MCP server, and a synthetic login, stand in for
 * the real ones; no real auth, key, batch or H1 file is read. Decoys are made-up files under the test's own folder.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./claims-90/labeller.cjs');
const CX = require('./claims-90/labeller-codex.cjs');
const MCP = require('./claims-90/labeller-jail-mcp.cjs');

const FAKE = path.join(__dirname, 'fixtures', 'claims-90-fake-codex.cjs');
const AUTH = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'synthetic-id-token-0000000001', access_token: 'synthetic-access-token-000001', refresh_token: 'synthetic-refresh-token-00001', account_id: 'synthetic-account-0001' }, last_refresh: '2026-10-18T05:19:01Z' };
const OWN = [{ itemId: 'it-1' }, { itemId: 'it-2' }];
const DECOY = 'DECOY-AUTH-CONTENT-7f3a';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-codex-'));
  const jail = path.join(root, 'jail');
  fs.mkdirSync(path.join(jail, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(jail, 'docs', 'batch-01.jsonl'), '{"itemId":"it-1"}\n{"itemId":"it-2"}\n');
  const scratch = path.join(root, 'scratch'); fs.mkdirSync(scratch);
  const runDir = path.join(root, 'run'); fs.mkdirSync(runDir);
  const realHome = path.join(root, 'realhome'); fs.mkdirSync(realHome);
  const authFile = path.join(realHome, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify(AUTH));
  // Decoys at the real logins' shapes under a made-up home.
  const fakeHome = path.join(root, 'home');
  for (const [d, f] of [['.codex', 'auth.json'], ['.claude', '.credentials.json']]) { fs.mkdirSync(path.join(fakeHome, d), { recursive: true }); fs.writeFileSync(path.join(fakeHome, d, f), `{"decoy":"${DECOY}"}\n`); }
  const openLog = path.join(runDir, 'open-log.jsonl'); fs.writeFileSync(openLog, '');
  return { root, jail, scratch, runDir, realHome, authFile, openLog, fakeHome, keyFile: path.join(jail, 'key.jsonl') };
}

async function session(scenario, extra = {}) {
  const f = fixture();
  const envLog = path.join(f.root, 'env.txt');
  const argvLog = path.join(f.root, 'argv.json');
  const baseEnv = extra.baseEnv ?? { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, USERPROFILE: f.fakeHome };
  const decoy = extra.decoy ? path.join(f.fakeHome, extra.decoy) : '';
  const prompt = `SCENARIO:${scenario} IDS:it-1,it-2 ENVLOG:${envLog} ARGVLOG:${argvLog}${decoy ? ` DECOY:${decoy}` : ''}${extra.realAuth ? ` REALAUTH:${f.authFile}` : ''}`;
  const s = await CX.codexSession({ exe: FAKE, model: null, jail: f.jail, scratch: f.scratch, runDir: f.runDir, keyFile: f.keyFile, openLog: f.openLog, jailFiles: L.jailFiles, prompt, baseEnv, authFile: f.authFile, timeoutMs: 60_000 });
  const key = L.checkKey(fs.existsSync(f.keyFile) ? fs.readFileSync(f.keyFile, 'utf8') : '', OWN);
  const leftHomes = fs.readdirSync(f.root).filter((n) => n.startsWith('codexhome-'));
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
  const saved = [read(path.join(f.runDir, 'events.jsonl')), read(path.join(f.runDir, 'mcp-log.jsonl')), read(f.openLog), read(f.keyFile), read(path.join(f.scratch, 'last-message.txt'))].join('\n');
  return { f, s, key, saved, reason: CX.codexReason(s, key, OWN), envKeys: read(envLog).split('\n'), argv: fs.existsSync(argvLog) ? JSON.parse(read(argvLog)) : [], leftHomes };
}

test('T6 positive control: a clean synthetic batch is VALID, every own row keyed from in-jail reads; the login copy is gone before the first call and CODEX_HOME after the run', async () => {
  const r = await session('ok');
  assert.equal(r.reason, null);
  assert.equal(r.key.keyed, 2);
  assert.equal(r.s.authAtCall, 0);
  assert.equal(r.s.homeRemoved, true);
  assert.equal(r.s.authAbsentAfter, true);
  assert.deepEqual(r.leftHomes, [], 'no CODEX_HOME left beside the jail');
  assert.deepEqual(r.s.homeBefore, ['auth.json'], 'CODEX_HOME held only the login at launch');
  assert.equal(fs.readFileSync(r.f.authFile, 'utf8'), JSON.stringify(AUTH), 'the real login is untouched');
  const log = fs.readFileSync(r.f.openLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((x) => [x.tool, x.place, x.decision]), [['mcp:list_files', 'jail', 'allow'], ['mcp:read_file', 'jail', 'allow'], ['mcp:search', 'jail', 'allow']]);
  assert.match(r.saved, /"auth present at calls: false/);
  assert.match(r.saved, /docs\/batch-01\.jsonl:1:\{\\"itemId\\":\\"it-1\\"\}/, 'search found the row in the jail');
});

test('T6 census: the session gets no shell, no allow rules, the jail-only read profile, every tool feature off and only the jail MCP tools', async () => {
  const r = await session('ok');
  const a = r.argv;
  for (const f of ['--ignore-rules', '--ignore-user-config', '--ephemeral', 'default_permissions="labeller"', 'permissions.labeller.filesystem.:minimal="read"', `permissions.labeller.filesystem.${r.f.jail.replace(/\\/g, '/')}="read"`, 'web_search="disabled"']) assert.ok(a.includes(f), f);
  // codex 0.157.1 keeps quotes in a -c key (smoke: a quoted ":minimal" is refused), so no key segment is quoted.
  assert.ok(!a.some((x) => /^permissions\..*"[^"]*"=/.test(x)), 'no quoted permission key segment');
  for (const bad of ['C:/a.b/jail', 'C:/a=b/jail', 'C:/a"b/jail']) assert.throws(() => CX.codexArgs({ jail: bad, lastMsg: 'C:/m', model: null, mcpLog: 'C:/l' }), /codex cannot key it/, bad);
  for (const f of CX.FEATURES_OFF) assert.ok(a.includes(`features.${f}=false`), f);
  for (const f of ['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'computer_use', 'browser_use']) assert.ok(CX.FEATURES_OFF.includes(f), f);
  assert.ok(!a.includes('features.code_mode_host=false'), 'code mode stays on (off = no tools at all)');
  assert.ok(!a.includes('-s') && !a.includes('--sandbox'), 'no -s: it would replace the jail-only read profile');
  assert.ok(!a.some((x) => /dangerously|approve-for-me|full-auto|rules/.test(x) && x !== '--ignore-rules'), 'no bypass and no rules file');
  assert.deepEqual(MCP.TOOLS.map((t) => t.name), ['list_files', 'read_file', 'search', 'git']);
  assert.match(fs.readFileSync(path.join(r.f.runDir, 'mcp-log.jsonl'), 'utf8'), /"tool":"read_file"/, 'the reads went through the jail server');
});

test('T6 census: an outside read is REFUSED before it runs, logged as outside, and INVALID', async () => {
  const r = await session('outside');
  assert.match(r.reason, /refused before reading/);
  const log = fs.readFileSync(r.f.openLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.filter((x) => x.place === 'outside').map((x) => [x.tool, x.decision]), [['mcp:read_file', 'deny']]);
  assert.ok(!/\[fonts\]|for 16-bit app support/i.test(r.saved), 'no outside file text in any saved output');
});

test('T6 census: decoy logins at the real shapes (~/.codex/auth.json, ~/.claude/.credentials.json) by full path, "/" path, "..", %USERPROFILE% and a search root are all REFUSED; the decoy text is in no saved output', async () => {
  for (const d of [path.join('.codex', 'auth.json'), path.join('.claude', '.credentials.json')]) {
    const r = await session('decoy', { decoy: d });
    const log = fs.readFileSync(r.f.openLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const denied = log.filter((x) => x.decision === 'deny');
    assert.equal(denied.length, 7, `${d}: 5 read shapes + 2 search roots refused`);
    assert.ok(denied.every((x) => x.place === 'outside'));
    assert.ok(!r.saved.includes(DECOY), `${d}: decoy text absent from events, MCP log, open log, final message and key`);
    assert.match(r.reason, /7 call\(s\) asked for a path outside the jail/);
  }
});

test('T6 census: the path check refuses every edge before any read (streams, devices, short names, trailing dot/space, mixed separators, roots)', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.jail, 'a.txt'), 'ALPHA\n');
  for (const p of ['a.txt:stream', 'a.txt::$DATA', 'CON', 'nul', 'docs/COM1.txt', 'LPT1', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', '\\\\srv\\share\\x', 'PROGRA~1', 'docs~1/x', 'a.txt.', 'a.txt ', 'a/..\\b', 'docs\\..\\..\\x', '..', 'C:/x', 'C:x', 'D:', '/etc/x', '\\x', '%USERPROFILE%\\x', '$HOME/x', '~/x', 'a*', '', 'a\u0000b']) {
    assert.ok(MCP.pathProblem(p), `refused: ${JSON.stringify(p)}`);
    assert.ok(MCP.call(f.jail, 'read_file', { path: p }).refused, `read_file refused: ${JSON.stringify(p)}`);
  }
  // A '..' that stays inside the jail and names a real file: only the segment check refuses it.
  for (const p of ['docs/../a.txt', 'docs\\..\\a.txt']) {
    assert.equal(MCP.pathProblem(p), 'a parent (..) segment', p);
    assert.ok(MCP.call(f.jail, 'read_file', { path: p }).refused, `read_file refused: ${p}`);
  }
  for (const p of ['a.txt', './a.txt', 'docs/batch-01.jsonl', 'docs\\batch-01.jsonl']) assert.equal(MCP.pathProblem(p), null, p);
  assert.match(MCP.call(f.jail, 'read_file', { path: 'a.txt' }).text, /ALPHA/);
  assert.ok(MCP.call(f.jail, 'read_file', { path: 7 }).refused);
});

test('T6 census: a junction or symlink inside the jail pointing out is refused by read and search (and the runner refuses a jail holding a link)', () => {
  const f = fixture();
  const out = path.join(f.root, 'outside'); fs.mkdirSync(out);
  fs.writeFileSync(path.join(out, 'secret.txt'), `${DECOY}\n`);
  const link = path.join(f.jail, 'docs', 'out');
  fs.symlinkSync(out, link, 'junction');
  try {
    assert.match(MCP.call(f.jail, 'read_file', { path: 'docs/out/secret.txt' }).refused, /link or junction/);
    assert.match(MCP.call(f.jail, 'search', { pattern: 'DECOY' }).refused, /link or junction/);
    assert.match(MCP.call(f.jail, 'list_files', { path: 'docs' }).refused, /link or junction/);
    assert.match(MCP.call(f.jail, 'search', { pattern: 'DECOY', path: 'docs/out' }).refused, /link or junction/);
    assert.throws(() => L.jailFiles(f.jail), /holds a link/);
  } finally {
    fs.unlinkSync(link);
  }
  assert.ok(fs.existsSync(path.join(out, 'secret.txt')), 'removing the link left the target alone');
});

test('T6 census: search and list globs can never widen the root; output is bounded', () => {
  const f = fixture();
  for (const g of ['../**', '..\\*', '**/../x', 'C:/**', '/**', '\\\\srv\\**', '~/**', '%TEMP%/**', '$HOME/**']) {
    assert.ok(MCP.call(f.jail, 'search', { pattern: 'x', glob: g }).refused, `search glob ${g}`);
    assert.ok(MCP.call(f.jail, 'list_files', { glob: g }).refused, `list glob ${g}`);
  }
  for (const p of ['..', '../', 'C:/', '/', '%TEMP%']) assert.ok(MCP.call(f.jail, 'search', { pattern: 'x', path: p }).refused, `search root ${p}`);
  fs.writeFileSync(path.join(f.jail, 'docs', 'big.md'), Array.from({ length: MCP.SEARCH_MAX + 50 }, (_, i) => `hit ${i} ${'y'.repeat(400)}`).join('\n'));
  const s = MCP.call(f.jail, 'search', { pattern: 'hit' }).text;
  assert.equal(s.split('\n').filter((l) => l.startsWith('docs/big.md:')).length, MCP.SEARCH_MAX);
  assert.match(s, /\[50 more hits not shown\]/);
  assert.ok(s.split('\n').every((l) => l.length <= MCP.OUT_MAX));
  fs.writeFileSync(path.join(f.jail, 'docs', 'long.md'), Array.from({ length: MCP.READ_MAX_LINES + 10 }, (_, i) => `line ${i}`).join('\n'));
  assert.match(MCP.call(f.jail, 'read_file', { path: 'docs/long.md' }).text, /\[more: read again with offset 2000\]/);
  assert.ok(MCP.call(f.jail, 'search', { pattern: '(', regex: true }).refused);
});

test('T6 census: git runs only read commands on repo.git, with no file-reading option and no outside path', () => {
  const f = fixture();
  for (const a of [['config', '--list'], ['diff', '--no-index', 'a', 'b'], ['log', '--output=x'], ['log', '-OC:/x'], ['grep', '-f', 'p'], ['grep', '-fp'], ['log', 'C:\\x'], ['log', '--', '/etc/x'], ['log', '--', '../x'], ['blame', 'a'], ['tag', '-d', 'v1'], ['log', '--git-dir=C:/x'], ['log', '--format=%H', '--work-tree=x'], [], 'log']) {
    assert.ok(MCP.call(f.jail, 'git', { args: a }).refused, JSON.stringify(a));
  }
  assert.ok(MCP.GIT_SUBS.has('log') && MCP.GIT_SUBS.has('show') && !MCP.GIT_SUBS.has('config') && !MCP.GIT_SUBS.has('diff'));
});

test('T6 census: an env leak is INVALID; the session env has no hive key or hive PATH dir', async () => {
  const dirty = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, HIVE_ROOT: 'C:/Dunder/hive', AGENT_ID: 'syn', MEMORY_URL: 'x', MUTANT_RUN: '1', PATH: ['C:\\Dunder\\hive\\bin\\memory', 'C:\\Users\\syn\\AppData\\Local\\Programs\\Munder Difflin\\Guppy\\resources\\heavyjob', process.env.PATH].join(path.delimiter) };
  assert.deepEqual(CX.envLeaks(CX.codexEnv(dirty, 'C:/h')), [], 'codexEnv drops every hive key and PATH dir');
  assert.equal(CX.envLeaks(dirty).length, 6 + CX.envLeaks({ PATH: process.env.PATH }).length, 'four hive keys and two hive PATH dirs on top of the running shell PATH');
  const r = await session('ok', { baseEnv: dirty });
  assert.equal(r.reason, null);
  assert.ok(!r.envKeys.some((k) => /^(HIVE|AGENT|MEMORY|MUTANT)/i.test(k)), 'the session saw no hive key');
  assert.match(CX.codexReason({ ...r.s, envLeaks: ['HIVE_ROOT'] }, r.key, OWN), /^env leak/);
});

test('T6 census: no CODEX_HOME, login copy or codex session file is left; a session file for the jail is INVALID', async () => {
  const r = await session('leftover');
  assert.match(r.reason, /session file\(s\) left/);
  assert.deepEqual(r.leftHomes, []);
  assert.equal(r.s.authAbsentAfter, true);
  assert.match(CX.codexReason({ ...r.s, leftovers: [], homeRemoved: false }, r.key, OWN), /left behind/);
});

test('T6 census: a missing row is INVALID', async () => {
  const r = await session('missing');
  assert.match(r.reason, /1 of 2 rows missing/);
});

test('T6 census: a credential in the output is redacted and INVALID', async () => {
  const c = await session('credential');
  assert.match(c.reason, /credential value/);
  assert.ok(!c.saved.includes(AUTH.tokens.access_token));
});

test('T6 census (Jim 49a485): a login codex writes is deleted and NEVER written back; the real login changed during the run stays as the Human left it; the batch says so', async () => {
  const r = await session('refresh', { realAuth: true });
  assert.ok(r.s.authRefreshed >= 1);
  assert.equal(r.s.authWrittenBack, false);
  assert.equal(r.s.realAuthChanged, true);
  assert.match(fs.readFileSync(r.f.authFile, 'utf8'), /HUMAN/, 'the real login is what the Human (fake) wrote, not the refreshed copy');
  assert.match(r.reason, /NOT written back \(the real login also changed during the run, untouched\)/);
  assert.ok(!r.saved.includes('synthetic-access-REFRESHED-0001'));
  assert.deepEqual(r.leftHomes, []);
  const q = await session('refresh');
  assert.equal(q.s.realAuthChanged, false);
  assert.equal(fs.readFileSync(q.f.authFile, 'utf8'), JSON.stringify(AUTH), 'without a Human change the real login is byte-identical');
  assert.match(q.reason, /NOT written back; run the batch again/);
});

test('T6 census: a shell command, a spawn_agent item, another MCP server, another tool, a jail write or a project layer is INVALID', async () => {
  assert.match((await session('shell')).reason, /more than the jail tools \(command_execution\)/);
  assert.match((await session('spawn')).reason, /more than the jail tools \(collab_tool_call\)/);
  assert.match((await session('foreign')).reason, /more than the jail tools \(mcp:other\)/);
  assert.match((await session('other')).reason, /more than the jail tools \(web_search\)/);
  assert.match((await session('write')).reason, /jail changed/);
  const f = fixture();
  fs.writeFileSync(path.join(f.jail, 'AGENTS.md'), 'x');
  const s = await CX.codexSession({ exe: FAKE, model: null, jail: f.jail, scratch: f.scratch, runDir: f.runDir, keyFile: f.keyFile, openLog: f.openLog, jailFiles: L.jailFiles, prompt: 'SCENARIO:ok IDS:it-1,it-2', baseEnv: { PATH: process.env.PATH }, authFile: f.authFile });
  assert.match(CX.codexReason(s, L.checkKey('', OWN), OWN), /project layer/);
  assert.equal(s.homeRemoved, true);
});

test('T6: the claude provider is unchanged (default model, claude exe); codex takes its own exe and login', () => {
  const base = ['--snapshot', 's', '--addendum', 'a', '--labeller', 'andy', '--group', 'F', '--xcheck', 'x', '--batch', 'b', '--instructions', 'i', '--guide', 'g', '--pilot', 'p', '--prompt', 'q', '--key', 'k', '--out', 'o'];
  const c = L.parseArgs([...base, '--claude', 'c']);
  assert.equal(c.provider, 'claude'); assert.equal(c.model, 'claude-opus-5-5'); assert.equal(c.claude, 'c');
  const x = L.parseArgs([...base, '--provider', 'codex', '--codex', 'e', '--codex-auth', 'A']);
  assert.equal(x.model, null); assert.equal(x.codex, 'e'); assert.equal(x.codexAuth, 'A'); assert.equal(x.claude, undefined);
  assert.throws(() => L.parseArgs([...base, '--provider', 'gemini', '--claude', 'c']), /claude or codex/);
});

test('T6 static: main judges a codex session with codexReason before any key line is appended', () => {
  const src = fs.readFileSync(path.join(__dirname, 'claims-90', 'labeller.cjs'), 'utf8');
  const branch = src.slice(src.indexOf('const s = await CX.codexSession('));
  assert.ok(branch.indexOf('CX.codexReason(s, key, own)') > 0 && branch.indexOf('CX.codexReason(s, key, own)') < branch.indexOf('fs.appendFileSync(keyOut'));
});
