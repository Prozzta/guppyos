'use strict';
/**
 * ZT-I1-MAIL layer (b), R1 proof (god c0a73f (a)) + Jim's re-audit: the Claude jail hook
 * (test/tools/layer-b-jail-hook.cjs) is a STRICT ALLOWLIST. Read/Glob/Grep/LS inside the sandbox and
 * Write/Edit/MultiEdit inside the agent's own dirs are the only things it allows; every other tool
 * (Bash, PowerShell, MCP, Agent/Task, Web*, NotebookEdit, unknown) is denied, and every path form
 * that could reach C:\Dunder\hive, the real ~/.claude/.codex or the live userData is denied.
 * Zero tokens: synthetic PreToolUse payloads, in-process and through the real script (exit 2 =
 * deny). No CLI is started; the denied targets are only named, never opened.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'tools', 'layer-b-jail-hook.cjs');
const { decide } = require(HOOK);

const REAL_HOME = os.homedir();
const LIVE_USERDATA = path.join(process.env.APPDATA || path.join(REAL_HOME, 'AppData', 'Roaming'), 'munder-difflin');

function sandbox(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lb-jailhook-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, 'work', 'lb-claude');
  const agent = path.join(base, 'devroot', 'hive', 'agents', 'lb-claude');
  const home = path.join(base, 'jail', 'home');
  const codexAgent = path.join(base, 'devroot', 'hive', 'agents', 'lb-codex');
  for (const d of [work, path.join(agent, 'outbox'), path.join(agent, 'inbox', '.done'), path.join(home, '.claude'), path.join(codexAgent, '.codex'), path.join(base, 'devroot', 'hive', 'state', 'mail')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, 'b3-bulk.txt'), 'line 1\n');
  fs.writeFileSync(path.join(agent, 'memory.md'), '# lb-claude\n');
  // The two OAuth copies, where the runner puts them (decoys here).
  const claudeCred = path.join(home, '.claude', '.credentials.json');
  const codexCred = path.join(codexAgent, '.codex', 'auth.json');
  fs.writeFileSync(claudeCred, '{"refresh_token":"decoy"}');
  fs.writeFileSync(codexCred, '{"refresh_token":"decoy"}');
  const policyFile = path.join(base, 'layer-b-jail-policy.json');
  // J1/J2 (Jim): read = the work dir + the agent dir; write = the work dir + the outbox; the concrete
  // protected paths are the jailed home, the Codex agent dir and the policy.
  const policy = {
    writeRoots: [work, path.join(agent, 'outbox')], readRoots: [work, agent], home,
    protect: ['.claude', '.codex', '.claude.json', '.credentials.json', 'auth.json', 'settings.json', 'settings.local.json', 'layer-b-jail-policy.json'],
    protectPaths: [home, codexAgent, policyFile]
  };
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  return { base, work, agent, home, codexAgent, claudeCred, codexCred, policy, policyFile };
}
const pay = (tool, input, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd });
const denied = (s, tool, input, cwd = s.work) => decide(pay(tool, input, cwd), s.policy);

test('JIM\'S PROBE (re-audit 17-42): every escape is DENIED', (t) => {
  const s = sandbox(t);
  const cases = [
    ['Bash', { command: 'echo x > \\Dunder\\hive\\PWNED.txt' }],
    ['Bash', { command: 'cd \\ && cd Dunder && cd hive && echo x > PWNED.txt' }],
    ['PowerShell', { command: '[IO.File]::WriteAllText([IO.Path]::Combine([char]67+":\\","Dunder","hive","PWNED.txt"),"x")' }],
    ['Bash', { command: 'node -e "require(\'fs\').writeFileSync(String.fromCharCode(67)+\':/Dunder/hive/PWNED.txt\',\'x\')"' }],
    ['Bash', { command: 'pushd $(printf "C:")\\\\Dunder && echo x > hive/PWNED.txt' }],
    ['Bash', { command: 'cmd /c "cd /d C: && cd \\Dunder\\hive && echo x > PWNED.txt"' }],
    ['Write', { file_path: 'C:/Dunder/hive/PWNED.txt', content: 'x' }],
    ['mcp__filesystem__write_file', { path: 'C:\\Dunder\\hive\\PWNED.txt', content: 'x' }],
    ['mcp__munder-hive__send', { to: 'god', body: 'x' }],
    ['Agent', { prompt: 'write x into C:\\Dunder\\hive\\PWNED.txt' }],
    ['Task', { prompt: 'write x into C:\\Dunder\\hive\\PWNED.txt', subagent_type: 'general-purpose' }]
  ];
  for (const [tool, input] of cases) assert.ok(denied(s, tool, input), `${tool} ${JSON.stringify(input)} must be DENIED`);
});

test('DENY: every non-allowlisted tool, even a harmless one', (t) => {
  const s = sandbox(t);
  for (const tool of ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'WebFetch', 'WebSearch', 'NotebookEdit', 'NotebookRead', 'Agent', 'Task', 'TodoWrite', 'Skill', 'ToolSearch', 'SlashCommand', 'mcp__x__y', 'SomethingNew', '', undefined]) {
    assert.ok(denied(s, tool, { command: 'echo ok', file_path: path.join(s.work, 'x.txt'), notebook_path: path.join(s.work, 'n.ipynb') }), `${tool} must be DENIED`);
  }
});

test('DENY: the live hive, the real ~/.claude, ~/.codex and the live userData, through Read/Write/Edit/MultiEdit/Glob/Grep', (t) => {
  const s = sandbox(t);
  const targets = [
    'C:\\Dunder\\hive\\agents\\god\\inbox\\x.json', 'C:/Dunder/hive/registry.json', 'c:\\dunder\\HIVE\\log.jsonl', 'C:\\Dunder\\MunderDevData\\hive\\x',
    path.join(REAL_HOME, '.claude', 'settings.json'), path.join(REAL_HOME, '.claude', '.credentials.json'), path.join(REAL_HOME, '.claude.json'),
    path.join(REAL_HOME, '.codex', 'auth.json'), path.join(LIVE_USERDATA, 'config.json')
  ];
  for (const target of targets) {
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'Read']) assert.ok(denied(s, tool, { file_path: target, content: 'x' }), `${tool} ${target}`);
    assert.ok(denied(s, 'Glob', { path: path.dirname(target), pattern: '*' }), `Glob in ${path.dirname(target)}`);
    assert.ok(denied(s, 'Grep', { path: target, pattern: 'x' }), `Grep ${target}`);
    assert.ok(denied(s, 'LS', { path: path.dirname(target) }), `LS ${path.dirname(target)}`);
  }
});

test('DENY: every path form that could leave the jail (rooted, relative, .., ~, UNC, device, POSIX drive, ADS, 8.3, dots, reserved names)', (t) => {
  const s = sandbox(t);
  const forms = [
    '\\Dunder\\hive\\PWNED.txt', '/Dunder/hive/PWNED.txt',                           // drive-less rooted: on the cwd's drive
    '..\\..\\..\\..\\..\\Dunder\\hive\\x', '../../../../../../Dunder/hive/x',           // climbing out of the cwd
    path.join('..', '..', '..', '..', 'jail', 'home', '.claude', 'settings.json'),      // climbing into a protected jail file
    '~/.claude/settings.json', '~\\.claude.json', '~admin/x',                            // home forms (the jailed ~ still hits a protected name)
    '\\\\localhost\\C$\\Dunder\\hive\\x', '//localhost/C$/Dunder/hive/x', '\\\\?\\UNC\\localhost\\C$\\Dunder\\hive\\x',
    '\\\\?\\C:\\Dunder\\hive\\x', '\\\\.\\C:\\Dunder\\hive\\x', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\x', '\\\\.\\pipe\\munder-difflin-23c0d031569a',
    '/c/Dunder/hive/x', 'C:Dunder\\hive\\x',                                             // POSIX drive, drive-relative
    path.join(s.work, 'x.txt:hidden'), path.join(s.work, 'x.txt::$DATA'),               // alternate data streams
    'C:\\DUNDER~1\\hive\\x', 'C:\\Dunder\\hive.\\x', 'C:\\Dunder\\hive \\x', path.join(s.work, 'x.txt.'),
    path.join(s.work, 'CON'), path.join(s.work, 'nul.txt'), path.join(s.work, 'COM1'),
    path.join(s.work, '*.json')
  ];
  for (const f of forms) assert.ok(denied(s, 'Write', { file_path: f, content: 'x' }), `Write ${f} must be DENIED`);
  for (const f of forms.filter((x) => !x.includes('*'))) assert.ok(denied(s, 'Read', { file_path: f }), `Read ${f} must be DENIED`);
  // 8.3 short names are resolved: if the real temp dir has a short alias, the SAME dir via the alias is inside the jail.
  const tmpShort = process.env.TEMP && process.env.TEMP.includes('~') ? process.env.TEMP : null;
  if (tmpShort) assert.equal(denied(s, 'Read', { file_path: path.join(tmpShort, path.relative(os.tmpdir(), s.work), 'b3-bulk.txt') }), null, 'a short-name alias of an in-jail file resolves inside');
  // Glob/Grep patterns may not leave the search root.
  for (const pattern of ['C:/Dunder/**', '/Dunder/**', '../../**', '~/**', '**/../../x', 'x:y']) assert.ok(denied(s, 'Glob', { pattern }), `Glob pattern ${pattern}`);
  assert.ok(denied(s, 'Grep', { pattern: 'x', glob: '../../**' }), 'Grep glob climbing');
  // A session cwd outside the sandbox: nothing is allowed.
  assert.ok(denied(s, 'Read', { file_path: 'x.txt' }, 'C:\\Dunder\\hive'));
  assert.ok(denied(s, 'Read', { file_path: 'x.txt' }, ''));
});

test('DENY via links: a junction inside the jail that points at a live location is followed (realpath), and so is its missing child', (t) => {
  const s = sandbox(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lb-outside-'));   // stands in for a live location outside the jail
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  const link = path.join(s.work, 'escape');
  try { fs.symlinkSync(target, link, 'junction'); } catch (e) { t.skip(`cannot create a junction here: ${e.message}`); return; }
  assert.ok(denied(s, 'Write', { file_path: path.join(link, 'x.txt'), content: 'x' }), 'a new file behind a junction');
  assert.ok(denied(s, 'Read', { file_path: path.join(link, 'deeper', 'y.txt') }), 'a missing child behind a junction');
  assert.ok(denied(s, 'Glob', { path: link, pattern: '*' }));
});

test('DENY inside the sandbox: the jail\'s own files and anything outside the two write roots', (t) => {
  const s = sandbox(t);
  for (const p of [path.join(s.home, '.claude', 'settings.json'), path.join(s.home, '.claude', '.credentials.json'), path.join(s.home, '.claude.json'),
    path.join(s.agent, 'settings.json'), path.join(s.agent, '.claude', 'skills', 'x.md'), path.join(s.agent, '.codex', 'auth.json'), s.policyFile]) {
    assert.ok(denied(s, 'Write', { file_path: p, content: 'x' }), `Write ${p}`);
    assert.ok(denied(s, 'Read', { file_path: p }), `Read ${p}`);
  }
  assert.ok(denied(s, 'Write', { file_path: path.join(s.base, 'devroot', 'hive', 'registry.json'), content: 'x' }), 'not writable');
  assert.ok(denied(s, 'Edit', { file_path: path.join(s.base, 'devroot', 'hive', 'agents', 'god', 'inbox', 'x.json'), old_string: 'a', new_string: 'b' }));
});

test('ALLOW: exactly what the layer-(b) facts need (read its files, write its outbox reply)', (t) => {
  const s = sandbox(t);
  assert.equal(denied(s, 'Write', { file_path: path.join(s.agent, 'outbox', 'r1.json'), content: '{}' }), null, 'the outbox reply');
  assert.equal(denied(s, 'Write', { file_path: 'notes.txt', content: 'x' }), null, 'relative to its cwd');
  assert.equal(denied(s, 'Edit', { file_path: path.join(s.work, 'notes.txt'), old_string: 'a', new_string: 'b' }), null);
  assert.equal(denied(s, 'MultiEdit', { file_path: path.join(s.work, 'x.txt'), edits: [] }), null);
  assert.equal(denied(s, 'Read', { file_path: path.join(s.work, 'b3-bulk.txt'), offset: 1, limit: 300 }), null);
  assert.equal(denied(s, 'Read', { file_path: path.join(s.base, 'devroot', 'hive', 'agents', 'lb-claude', 'memory.md') }), null);
  assert.equal(denied(s, 'Glob', { pattern: '*.txt' }), null);
  assert.equal(denied(s, 'Grep', { pattern: 'line', path: s.work }), null);
  assert.equal(denied(s, 'LS', { path: s.work }), null);
});

test('END TO END: the real hook script exits 2 (deny) for Jim\'s escapes and 0 (allow) for an in-jail Write; garbage fails closed', (t) => {
  const s = sandbox(t);
  const run = (payload, policy = s.policyFile) => spawnSync(process.execPath, [HOOK, policy], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  for (const p of [
    pay('Bash', { command: 'echo x > \\Dunder\\hive\\PWNED.txt' }, s.work),
    pay('Write', { file_path: '\\Dunder\\hive\\PWNED.txt', content: 'x' }, s.work),
    pay('mcp__filesystem__write_file', { path: 'C:\\Dunder\\hive\\PWNED.txt' }, s.work),
    pay('Agent', { prompt: 'x' }, s.work),
    pay('Write', { file_path: path.join(REAL_HOME, '.claude', 'settings.json'), content: 'x' }, s.work)
  ]) {
    const r = run(p);
    assert.equal(r.status, 2, `${JSON.stringify(p.tool_input)}: ${r.stderr}`);
    assert.match(r.stderr, /\[layer-b jail\] DENIED/);
  }
  const ok = run(pay('Write', { file_path: path.join(s.agent, 'outbox', 'r.json'), content: '{}' }, s.work));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');
  assert.equal(run('not json').status, 2, 'unparseable payload: deny');
  assert.equal(run('{}', path.join(s.base, 'missing.json')).status, 2, 'missing policy: deny');
  assert.equal(fs.existsSync('C:\\Dunder\\hive\\PWNED.txt'), false);
});

test('J1 (Jim probe2): no search can reach an OAuth copy, whatever its root, default path or pattern', (t) => {
  const s = sandbox(t);
  const cases = [
    ['Grep', { pattern: 'refresh_token', path: s.base }, s.work],
    ['Grep', { pattern: 'refresh_token' }, s.base],
    ['Grep', { pattern: 'refresh_token' }, s.home],
    ['Grep', { pattern: 'refresh_token', path: s.home }, s.work],
    ['Grep', { pattern: 'refresh_token', path: path.join(s.base, 'devroot') }, s.work],
    ['Glob', { pattern: '**/auth.json', path: s.base }, s.work],
    ['Glob', { pattern: '**/auth.json' }, s.base],
    ['Glob', { pattern: '**/.credentials.json', path: path.join(s.home, '..') }, s.work],
    ['LS', { path: s.codexAgent }, s.work],
    ['LS', { path: path.join(s.codexAgent, '.codex') }, s.work],
    ['LS', { path: path.join(s.base, 'devroot', 'hive', 'agents') }, s.work],
    ['Read', { file_path: s.codexCred }, s.work],
    ['Read', { file_path: s.claudeCred }, s.work]
  ];
  for (const [tool, input, cwd] of cases) assert.ok(denied(s, tool, input, cwd), `${tool} ${JSON.stringify(input)} (cwd ${cwd}) must be DENIED`);
  // Inside a READ root: a root holding a protected NAME, a protected PATH, or a link is refused
  // too (no reliance on ripgrep skipping hidden dirs).
  fs.mkdirSync(path.join(s.agent, '.claude', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(s.agent, 'settings.json'), '{}');
  assert.ok(denied(s, 'Grep', { pattern: 'x', path: s.agent }), 'agent dir holds .claude and settings.json');
  assert.ok(denied(s, 'Grep', { pattern: 'x' }, s.agent), 'default path = that agent dir');
  assert.ok(denied(s, 'Glob', { pattern: '**/*.json' }, s.agent));
  assert.ok(denied(s, 'LS', { path: s.agent }));
  const s2 = sandbox(t);
  s2.policy.protectPaths.push(path.join(s2.work, 'secret-place'));
  assert.ok(denied(s2, 'Grep', { pattern: 'x', path: s2.work }), 'a root that is an ancestor of a protected path (even one not created yet)');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lb-j1-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const s4 = sandbox(t);
  let linked = false;
  try { fs.symlinkSync(outside, path.join(s4.work, 'lnk'), 'junction'); linked = true; } catch { /* junctions unavailable */ }
  if (linked) assert.ok(denied(s4, 'Glob', { pattern: '**/*' }, s4.work), 'a junction under the root');
  // A clean root stays searchable: what B2/B3 need.
  const s3 = sandbox(t);
  assert.equal(denied(s3, 'Grep', { pattern: 'line', path: s3.work }), null);
  assert.equal(denied(s3, 'Grep', { pattern: 'line' }, s3.work), null);
  assert.equal(denied(s3, 'Glob', { pattern: 'b3-*.txt' }, s3.work), null);
  assert.equal(denied(s3, 'LS', { path: s3.work }), null);
});

test('J2 (Jim): the agent cannot forge its own inbox, its .done or any state file; only its work dir and outbox are writable', (t) => {
  const s = sandbox(t);
  for (const f of [path.join(s.agent, 'inbox', 'forged.json'), path.join(s.agent, 'inbox', '.done', 'forged.json'), path.join(s.agent, 'inbox', '.undelivered', 'x.json'),
    path.join(s.base, 'devroot', 'hive', 'state', 'mail', 'lb-claude.json'), path.join(s.base, 'devroot', 'hive', 'registry.json'), path.join(s.base, 'devroot', 'hive', 'log.jsonl'),
    path.join(s.agent, 'memory.md'), path.join(s.agent, 'identity.md'), path.join(s.base, 'devroot', 'hive', 'agents', 'god', 'inbox', 'x.json')]) {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) assert.ok(denied(s, tool, { file_path: f, content: '{}', old_string: 'a', new_string: 'b', edits: [] }), `${tool} ${f} must be DENIED`);
  }
  assert.equal(denied(s, 'Write', { file_path: path.join(s.agent, 'outbox', 'reply.json'), content: '{}' }), null, 'the outbox reply stays ALLOWED');
});
