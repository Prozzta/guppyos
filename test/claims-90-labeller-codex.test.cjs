'use strict';
/**
 * CLAIMS-90 T6 (god 495956, Jim 475eab): labeller --provider codex. A fake codex (test/fixtures/claims-90-fake-codex.cjs)
 * and a synthetic login stand in for the real ones; no real auth, key, batch or H1 file is read.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./claims-90/labeller.cjs');
const CX = require('./claims-90/labeller-codex.cjs');

const FAKE = path.join(__dirname, 'fixtures', 'claims-90-fake-codex.cjs');
const AUTH = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'synthetic-id-token-0000000001', access_token: 'synthetic-access-token-000001', refresh_token: 'synthetic-refresh-token-00001', account_id: 'synthetic-account-0001' }, last_refresh: '2026-10-18T05:19:01Z' };
const OWN = [{ itemId: 'it-1' }, { itemId: 'it-2' }];

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
  const openLog = path.join(runDir, 'open-log.jsonl'); fs.writeFileSync(openLog, '');
  return { root, jail, scratch, runDir, realHome, authFile, openLog, keyFile: path.join(jail, 'key.jsonl') };
}

async function session(scenario, extra = {}) {
  const f = fixture();
  const envLog = path.join(f.root, 'env.txt');
  const baseEnv = extra.baseEnv ?? { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP };
  const s = await CX.codexSession({ exe: FAKE, model: null, jail: f.jail, scratch: f.scratch, runDir: f.runDir, keyFile: f.keyFile, openLog: f.openLog, jailFiles: L.jailFiles, prompt: `SCENARIO:${scenario} IDS:it-1,it-2 ENVLOG:${envLog}`, baseEnv, authFile: f.authFile, timeoutMs: 60_000 });
  const key = L.checkKey(fs.existsSync(f.keyFile) ? fs.readFileSync(f.keyFile, 'utf8') : '', OWN);
  const leftHomes = fs.readdirSync(f.root).filter((n) => n.startsWith('codexhome-'));
  return { f, s, key, reason: CX.codexReason(s, key, OWN), envKeys: fs.existsSync(envLog) ? fs.readFileSync(envLog, 'utf8').split('\n') : [], leftHomes };
}

test('T6: a clean codex session is valid; the login copy is gone before the first command and CODEX_HOME after the run', async () => {
  const r = await session('ok');
  assert.equal(r.reason, null);
  assert.equal(r.key.keyed, 2);
  assert.equal(r.s.authAtCommand, 0);
  assert.equal(r.s.homeRemoved, true);
  assert.equal(r.s.authAbsentAfter, true);
  assert.deepEqual(r.leftHomes, [], 'no CODEX_HOME left beside the jail');
  assert.deepEqual(r.s.homeBefore, ['auth.json'], 'CODEX_HOME held only the login at launch');
  assert.equal(r.s.audit.calls.length, 2);
  assert.equal(fs.readFileSync(r.f.authFile, 'utf8'), JSON.stringify(AUTH), 'the real login is untouched');
  const log = fs.readFileSync(r.f.openLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(log.map((x) => [x.tool, x.place, x.decision]), [['shell', 'jail', 'allow'], ['shell', 'jail', 'allow']]);
  assert.match(fs.readFileSync(path.join(r.f.runDir, 'events.jsonl'), 'utf8'), /"auth present at commands: false"/);
});

test('T6 census: an outside read is INVALID and is in the open log as outside', async () => {
  const r = await session('outside');
  assert.match(r.reason, /outside the jail/);
  const log = fs.readFileSync(r.f.openLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.filter((x) => x.place === 'outside').length, 1);
});

test('T6 census: an env leak is INVALID; the session env has no hive key or hive PATH dir', async () => {
  const dirty = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, HIVE_ROOT: 'C:/Dunder/hive', AGENT_ID: 'syn', MEMORY_URL: 'x', MUTANT_RUN: '1', PATH: ['C:\\Dunder\\hive\\bin\\memory', 'C:\\Users\\syn\\AppData\\Local\\Programs\\Munder Difflin\\Guppy\\resources\\heavyjob', process.env.PATH].join(path.delimiter) };
  assert.deepEqual(CX.envLeaks(CX.codexEnv(dirty, 'C:/h')), [], 'codexEnv drops every hive key and PATH dir');
  assert.equal(CX.envLeaks(dirty).length, 6);
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

test('T6: a credential in the output is redacted and INVALID; a refreshed login is written back and INVALID', async () => {
  const c = await session('credential');
  assert.match(c.reason, /credential value/);
  assert.ok(!fs.readFileSync(path.join(c.f.runDir, 'events.jsonl'), 'utf8').includes(AUTH.tokens.access_token));
  const r = await session('refresh');
  assert.ok(r.s.authRefreshed >= 1);
  assert.equal(r.s.authWrittenBack, true);
  assert.match(fs.readFileSync(r.f.authFile, 'utf8'), /REFRESHED/, 'the refreshed login replaced the real one');
  assert.ok(r.reason);
  assert.deepEqual(r.leftHomes, []);
});

test('T6: another tool, a jail write or a project layer is INVALID', async () => {
  assert.match((await session('other')).reason, /more than shell commands \(web_search\)/);
  assert.match((await session('write')).reason, /jail changed/);
  const f = fixture();
  fs.writeFileSync(path.join(f.jail, 'AGENTS.md'), 'x');
  const s = await CX.codexSession({ exe: FAKE, model: null, jail: f.jail, scratch: f.scratch, runDir: f.runDir, keyFile: f.keyFile, openLog: f.openLog, jailFiles: L.jailFiles, prompt: 'SCENARIO:ok IDS:it-1,it-2', baseEnv: { PATH: process.env.PATH }, authFile: f.authFile });
  assert.match(CX.codexReason(s, L.checkKey('', OWN), OWN), /project layer/);
  assert.equal(s.homeRemoved, true);
});

test('T6: the shell judge', () => {
  const jail = 'C:/syn/out/jail-x';
  const place = (s) => CX.judgeShell(s, jail).place;
  for (const s of ['Get-Content docs\\a.txt', 'Get-Content C:\\syn\\out\\jail-x\\docs\\a.txt', 'git log --oneline -5', 'Select-String -Path docs\\*.md -Pattern "merged"', 'Get-ChildItem -Recurse hive\\agents']) assert.equal(place(s), 'jail', s);
  for (const s of ['Get-Content C:\\Windows\\win.ini', 'Get-ChildItem env:', '$env:USERPROFILE', 'Get-Content ..\\x', 'cat ~/x', 'dir \\\\srv\\share', 'Set-Location D:', 'Get-Content /etc/x', '(Get-Item .).Parent', 'cmd /c type x', 'Get-Content "C:/syn/out/other/b.txt"']) assert.equal(place(s), 'outside', s);
  assert.equal(CX.shellScript(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content ''a b.txt'''`), "Get-Content 'a b.txt'");
  assert.equal(CX.shellScript(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "type \\"C:\\x\\b.txt\\""`), 'type "C:\\x\\b.txt"');
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
  const branch = src.slice(src.indexOf("if (o.provider === 'codex') {\n      const s = await"));
  assert.ok(branch.indexOf('CX.codexReason(s, key, own)') > 0 && branch.indexOf('CX.codexReason(s, key, own)') < branch.indexOf('fs.appendFileSync(keyOut'));
});
