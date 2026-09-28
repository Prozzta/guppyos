'use strict';
/**
 * ZT-I1-MAIL layer (b), R1 proof (god c0a73f (a)): the Claude jail hook (test/tools/layer-b-jail-hook.cjs)
 * DENIES writes, reads and shell commands that reach C:\Dunder\hive, the real ~/.claude, ~/.codex or
 * the live userData, and anything outside the sandbox; it allows the agent's own work inside it.
 * Zero tokens: synthetic PreToolUse payloads, both through decide() and through the real script as a
 * child process (stdin JSON -> exit 2 + reason, the documented blocking form). No CLI is started, and
 * nothing outside a temp dir is touched (the denied paths are only named, never opened).
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
  for (const d of [work, path.join(agent, 'outbox'), path.join(home, '.claude')]) fs.mkdirSync(d, { recursive: true });
  const policy = {
    writeRoots: [work, agent], readRoots: [base], home,
    protect: ['.claude', '.codex', '.claude.json', '.credentials.json', 'auth.json', 'settings.json', 'settings.local.json', 'layer-b-jail-policy.json']
  };
  const policyFile = path.join(base, 'layer-b-jail-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  return { base, work, agent, home, policy, policyFile };
}
const pay = (tool, input, cwd) => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd });

const LIVE_TARGETS = () => [
  'C:\\Dunder\\hive\\agents\\god\\inbox\\x.json', 'C:/Dunder/hive/registry.json', 'c:\\dunder\\HIVE\\log.jsonl',
  'C:\\Dunder\\MunderDevData\\hive\\x', path.join(REAL_HOME, '.claude', 'settings.json'), path.join(REAL_HOME, '.claude', '.credentials.json'),
  path.join(REAL_HOME, '.claude.json'), path.join(REAL_HOME, '.codex', 'auth.json'), path.join(LIVE_USERDATA, 'config.json')
];

test('DENY: Write/Edit/MultiEdit/NotebookEdit/Read on the live hive, the real ~/.claude, ~/.codex and the live userData', (t) => {
  const s = sandbox(t);
  for (const target of LIVE_TARGETS()) {
    for (const [tool, key] of [['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path'], ['Read', 'file_path']]) {
      const why = decide(pay(tool, { [key]: target, content: 'x' }, s.work), s.policy);
      assert.ok(why, `${tool} ${target} must be DENIED`);
    }
    assert.ok(decide(pay('Glob', { path: path.dirname(target), pattern: '*' }, s.work), s.policy), `Glob in ${path.dirname(target)}`);
    assert.ok(decide(pay('Grep', { path: target, pattern: 'x' }, s.work), s.policy), `Grep ${target}`);
  }
  // Relative escapes and home forms resolve outside too.
  for (const p of ['..\\..\\..\\x.txt', '~/.claude/settings.json', '/c/Dunder/hive/x', '\\\\server\\share\\x']) {
    assert.ok(decide(pay('Write', { file_path: p, content: 'x' }, s.work), s.policy), `Write ${p}`);
  }
});

test('DENY: shell commands that name a live path, the home, a POSIX drive, a parent escape, a download, a window or a link', (t) => {
  const s = sandbox(t);
  const cmds = [
    'echo x > C:\\Dunder\\hive\\agents\\god\\inbox\\m.json', 'echo x > "C:/Dunder/hive/registry.json"', 'type C:\\Dunder\\hive\\log.jsonl',
    `copy x.txt ${path.join(REAL_HOME, '.claude', 'settings.json')}`, `cat "${path.join(REAL_HOME, '.codex', 'auth.json')}"`,
    'echo x > ~/.claude/settings.json', 'cat $HOME/.codex/auth.json', 'type %USERPROFILE%\\.claude.json', 'Get-Content $env:USERPROFILE\\.claude.json',
    'echo x > /c/Dunder/hive/x', 'cd .. && echo x > y', 'cat ../../x', 'curl https://example.com -o x', 'Invoke-WebRequest https://x -OutFile y',
    'start https://example.com', 'explorer.exe .', 'mklink /J j C:\\Dunder', 'ln -s /c/Dunder j', 'cat /etc/passwd', 'echo x > /tmp/x',
    'cat .credentials.json', 'rm -rf .claude', 'setx PATH x', `echo x > ${LIVE_USERDATA}\\config.json`
  ];
  for (const c of cmds) assert.ok(decide(pay('Bash', { command: c }, s.work), s.policy), `Bash "${c}" must be DENIED`);
  assert.ok(decide(pay('PowerShell', { command: 'Set-Content C:\\Dunder\\hive\\x y' }, s.work), s.policy));
  assert.ok(decide(pay('Bash', { command: 'echo ok' }, 'C:\\Dunder\\hive'), s.policy), 'a shell that starts outside the sandbox');
  assert.ok(decide(pay('WebFetch', { url: 'https://example.com' }, s.work), s.policy));
  assert.ok(decide(pay('WebSearch', { query: 'x' }, s.work), s.policy));
});

test('DENY inside the sandbox: the jail\'s own files (settings, credentials, .claude, the policy) are protected', (t) => {
  const s = sandbox(t);
  for (const p of [path.join(s.home, '.claude', 'settings.json'), path.join(s.home, '.claude', '.credentials.json'), path.join(s.home, '.claude.json'),
    path.join(s.agent, 'settings.json'), path.join(s.agent, '.claude', 'skills', 'x.md'), path.join(s.agent, '.codex', 'auth.json'), s.policyFile]) {
    assert.ok(decide(pay('Write', { file_path: p, content: 'x' }, s.work), s.policy), `Write ${p}`);
    assert.ok(decide(pay('Read', { file_path: p }, s.work), s.policy), `Read ${p}`);
  }
  // The jail root itself is readable but not writable outside the two write roots.
  assert.ok(decide(pay('Write', { file_path: path.join(s.base, 'devroot', 'hive', 'registry.json'), content: 'x' }, s.work), s.policy));
});

test('ALLOW: the agent\'s own work inside the jail (its cwd, its outbox, reads in the sandbox, harmless shell)', (t) => {
  const s = sandbox(t);
  assert.equal(decide(pay('Write', { file_path: path.join(s.agent, 'outbox', 'r1.json'), content: '{}' }, s.work), s.policy), null);
  assert.equal(decide(pay('Write', { file_path: 'notes.txt', content: 'x' }, s.work), s.policy), null, 'relative to its cwd');
  assert.equal(decide(pay('Read', { file_path: path.join(s.work, 'b3-bulk.txt'), offset: 1, limit: 300 }, s.work), s.policy), null);
  assert.equal(decide(pay('Read', { file_path: path.join(s.base, 'devroot', 'hive', 'agents', 'lb-claude', 'memory.md') }, s.work), s.policy), null);
  assert.equal(decide(pay('Glob', { pattern: '*.txt' }, s.work), s.policy), null);
  for (const c of ['sleep 8', 'ping -n 6 127.0.0.1 > /dev/null', 'echo hello', `type "${path.join(s.work, 'b3-bulk.txt')}"`]) {
    assert.equal(decide(pay('Bash', { command: c }, s.work), s.policy), null, `Bash "${c}"`);
  }
  assert.equal(decide(pay('mcp__munder-hive__send', { to: 'god' }, s.work), s.policy), null, 'the product\'s own tools');
});

test('END TO END: the real hook script, fed a PreToolUse payload on stdin, exits 2 (deny) or 0 (allow); garbage fails closed', (t) => {
  const s = sandbox(t);
  const run = (payload) => spawnSync(process.execPath, [HOOK, s.policyFile], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  for (const target of LIVE_TARGETS()) {
    const r = run(pay('Write', { file_path: target, content: 'x' }, s.work));
    assert.equal(r.status, 2, `${target}: ${r.stderr}`);
    assert.match(r.stderr, /\[layer-b jail\] DENIED/);
  }
  const hiveCmd = run(pay('Bash', { command: 'echo x > C:\\Dunder\\hive\\marker.txt' }, s.work));
  assert.equal(hiveCmd.status, 2);
  const ok = run(pay('Write', { file_path: path.join(s.agent, 'outbox', 'r.json'), content: '{}' }, s.work));
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');
  assert.equal(run('not json').status, 2, 'unparseable payload: deny');
  const noPolicy = spawnSync(process.execPath, [HOOK, path.join(s.base, 'missing.json')], { input: '{}', encoding: 'utf8', windowsHide: true });
  assert.equal(noPolicy.status, 2, 'missing policy: deny');
  // Nothing was created at any denied target (they were never opened).
  assert.equal(fs.existsSync('C:\\Dunder\\hive\\marker.txt'), false);
});
