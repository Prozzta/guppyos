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
  const gitArgs = path.join(f.root, 'gitargs.json');
  if (extra.gitArgs) fs.writeFileSync(gitArgs, JSON.stringify(extra.gitArgs));
  const prompt = `SCENARIO:${scenario} IDS:it-1,it-2 ENVLOG:${envLog} ARGVLOG:${argvLog}${decoy ? ` DECOY:${decoy}` : ''}${extra.gitArgs ? ` GITARGS:${gitArgs}` : ''}${extra.realAuth ? ` REALAUTH:${f.authFile}` : ''}`;
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
  assert.deepEqual(MCP.TOOLS.map((t) => t.name), ['list_files', 'read_file', 'search']);
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

// The read subcommands the removed git tool allowed (27bebb97), for the fuzz row.
const OLD_GIT_SUBS = ['log', 'show', 'tag', 'branch', 'rev-parse', 'rev-list', 'describe', 'ls-tree', 'cat-file', 'for-each-ref', 'show-ref', 'merge-base', 'name-rev', 'shortlog', 'grep'];
// Every short letter some git subcommand reads a file through (-f grep/blame, -F tag/commit, -O orderfile, -C/-c, ...).
const FILE_LETTERS = 'fFOCcSmMdDuxX';

function decoyForms(abs) {
  const fwd = abs.replace(/\\/g, '/');
  const mix = fwd.replace(/\//g, (s, i) => (i % 2 ? '\\' : '/'));
  return [abs, fwd, mix, `\\\\?\\${abs}`, 'C:x', '//server/x', `//?/${fwd}`];
}

test('T6 census (Jim 3ac795, god a2e5b2): there is no git tool; every bundled-option read, in every path form, is REFUSED as an unknown tool and the decoy text is in no saved output', async () => {
  assert.deepEqual(MCP.TOOLS.map((t) => t.name), ['list_files', 'read_file', 'search']);
  const f = fixture();
  const decoy = path.join(f.fakeHome, '.claude', '.credentials.json');
  const jim = [];
  for (const d of decoyForms(decoy)) {
    jim.push(['grep', `-Ef${d}`, 'HEAD'], ['grep', `-Eif${d}`, 'HEAD'], ['grep', `-if${d}`, 'HEAD'], ['grep', `-Pf${d}`, 'HEAD'], ['log', `-pO${d}`], ['log', `--orderf=${d}`], ['log', `--fil=${d}`], ['log', '--file', d]);
  }
  // In a session: the server refuses each one, logs it, and the batch is INVALID.
  const r = await session('gitargs', { gitArgs: jim });
  const log = fs.readFileSync(r.f.openLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.tool === 'mcp:git');
  assert.equal(log.length, jim.length, 'every git call reached the server and was logged');
  assert.ok(log.every((x) => x.decision === 'deny'), 'every git call refused');
  const mcpLog = fs.readFileSync(path.join(r.f.runDir, 'mcp-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.tool === 'git');
  assert.ok(mcpLog.length === jim.length && mcpLog.every((x) => x.reason === 'no tool git'), 'refused as an unknown tool');
  assert.notEqual(r.reason, null, 'the batch is INVALID');
  assert.ok(!r.saved.includes(DECOY), 'decoy text absent from events, MCP log, open log, final message and key');
  // Fuzz: each old subcommand x each file letter, in 2- and 3-letter bundles with an attached absolute decoy path.
  let n = 0;
  for (const sub of OLD_GIT_SUBS) for (const L of FILE_LETTERS) for (const d of decoyForms(decoy)) for (const b of [`-E${L}`, `-ip${L}`, `-${L}E`]) {
    const res = MCP.call(f.jail, 'git', { args: [sub, `${b}${d}`, 'HEAD'] });
    assert.equal(res.refused, 'no tool git', `${sub} ${b}`);
    assert.ok(!JSON.stringify(res).includes(DECOY));
    n++;
  }
  assert.equal(n, OLD_GIT_SUBS.length * FILE_LETTERS.length * 7 * 3);
});

function git(cwd, args) { return require('node:child_process').execFileSync('git', ['-c', 'user.name=syn', '-c', 'user.email=syn@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(cwd, '..', 'no-global-config'), GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z' } }); }

test('T6 census (god a2e5b2): a codex jail holds the git facts as plain files equal to a fresh export of the bundle, and no repo.git', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-gitx-'));
  const work = path.join(root, 'work'); fs.mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\n'); git(work, ['add', '.']); git(work, ['commit', '-q', '-m', 'first']);
  git(work, ['checkout', '-q', '-b', 'side']); fs.writeFileSync(path.join(work, 'b.txt'), 'side\n'); git(work, ['add', '.']); git(work, ['commit', '-q', '-m', 'side work']);
  git(work, ['checkout', '-q', 'main']); fs.writeFileSync(path.join(work, 'a.txt'), 'two\x1e minified\n'); git(work, ['commit', '-qa', '-m', 'second', '-m', '\x1e body']); // bytes a fixed separator split breaks on
  git(work, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']); git(work, ['tag', '-a', 'v1', '-m', 'release one']);
  const addDir = path.join(root, 'add'); fs.mkdirSync(addDir);
  git(work, ['bundle', 'create', '-q', path.join(addDir, 'repo-at-ts.bundle'), '--all']);
  const snap = path.join(root, 'snap');
  fs.mkdirSync(path.join(snap, 'hive', 'tasks-archive'), { recursive: true }); fs.mkdirSync(path.join(snap, 'hive', 'agents'));
  for (const n of ['tasks.json', 'board.md', 'PROTOCOL.md']) fs.writeFileSync(path.join(snap, 'hive', n), 'syn\n');
  const doc = (n) => { const p = path.join(root, n); fs.writeFileSync(p, 'syn\n'); return p; };
  const o = { provider: 'codex', batch: doc('batch-01.jsonl'), instructions: doc('i.md'), guide: doc('guide.md'), pilot: doc('pilot.md'), xcheck: doc('xcheck-a.json'), docs: [] };
  const jail = path.join(root, 'jail');
  const files = L.buildJail(jail, o, snap, addDir);
  assert.ok(!fs.existsSync(path.join(jail, 'repo.git')), 'the mirror left the jail');
  assert.ok(!files.some((x) => x.path.startsWith('repo.git/')));
  const mirror = path.join(root, 'fresh.git');
  require('node:child_process').execFileSync('git', ['clone', '--quiet', '--mirror', path.join(addDir, 'repo-at-ts.bundle'), mirror], { stdio: 'ignore' });
  const fresh = path.join(root, 'fresh'); fs.mkdirSync(fresh);
  assert.equal(CX.exportGitFacts(mirror, path.join(fresh, 'git')), 4, 'four commits exported');
  const pick = (list) => list.filter((x) => x.path.startsWith('git/')).map((x) => `${x.path} ${x.sha256}`);
  assert.deepEqual(pick(files), pick(L.jailFiles(fresh)), 'the jail git files equal a fresh export (hash)');
  const logTxt = fs.readFileSync(path.join(jail, 'git', 'log.txt'), 'utf8');
  assert.equal(logTxt.trim().split('\n').length, 4);
  assert.match(logTxt, /^[0-9a-f]{40} parents=[0-9a-f]{40} [0-9a-f]{40} date=2026-10-01T00:00:00(?:Z|[+]00:00) .*merge side$/m, 'the merge lists both parents and its date');
  assert.match(fs.readFileSync(path.join(jail, 'git', 'tags.txt'), 'utf8'), /^v1 [0-9a-f]{40} [0-9a-f]{40} 2026-10-01T00:00:00(?:Z|[+]00:00) release one$/m);
  assert.match(fs.readFileSync(path.join(jail, 'git', 'branches.txt'), 'utf8'), /^main [0-9a-f]{40} .* merge side\nside [0-9a-f]{40} .* side work$/m);
  const second = logTxt.split('\n').find((l) => l.endsWith(' second')).slice(0, 40);
  assert.match(fs.readFileSync(path.join(jail, 'git', 'show', `${second}.txt`), 'utf8'), /^commit [0-9a-f]{40}\n[\s\S]*second[\s\S]*-one\n\+two/);
  assert.equal(fs.readdirSync(path.join(jail, 'git', 'show')).length, 4);
  // The model reads them through the jail tools like any other file.
  assert.match(MCP.call(jail, 'search', { pattern: 'release one', path: 'git' }).text, /^git\/tags\.txt:1:/);
});

test('T6 census (Jim 3ac795 minor): a regex search that backtracks forever is refused at the time limit; the server keeps answering', () => {
  const f = fixture();
  // 2^33 backtracking steps: tens of seconds with no limit (so a census mutant that drops the limit ends), never 1.5 s.
  fs.writeFileSync(path.join(f.jail, 'docs', 'evil.md'), `${'a'.repeat(33)}!\n`);
  const keep = MCP.LIMITS.searchMs;
  MCP.LIMITS.searchMs = 1500;
  try {
    const t0 = Date.now();
    assert.match(MCP.call(f.jail, 'search', { pattern: '^(a+)+$', regex: true }).refused, /did not finish in 1\.5 s/);
    assert.ok(Date.now() - t0 < 10_000, 'ended at the limit');
    assert.match(MCP.call(f.jail, 'search', { pattern: 'it-\\d', regex: true }).text, /docs\/batch-01\.jsonl:1:/, 'a normal regex still answers');
  } finally { MCP.LIMITS.searchMs = keep; }
  assert.equal(MCP.SEARCH_MS, 20_000);
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
