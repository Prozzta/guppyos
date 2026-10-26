'use strict';
// A stand-in for codex exec (T6 labeller tests; synthetic data only). The prompt names the scenario (SCENARIO:<name>)
// and the row ids (IDS:a,b). It reads the login at start as codex does, prints codex --json events, and writes the
// final message to -o. ENVLOG:<file> in the prompt makes it write its env key names there.
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const jail = at('-C');
const lastMsg = at('-o');
const home = process.env.CODEX_HOME;
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; }).on('end', () => {
  const scenario = (/SCENARIO:(\S+)/.exec(prompt) || [])[1] || 'ok';
  const ids = ((/IDS:(\S+)/.exec(prompt) || [])[1] || '').split(',').filter(Boolean);
  const envLog = (/ENVLOG:(\S+)/.exec(prompt) || [])[1];
  if (envLog) fs.writeFileSync(envLog, Object.keys(process.env).join('\n'));
  const auth = fs.readFileSync(path.join(home, 'auth.json'), 'utf8');
  const token = JSON.parse(auth).tokens.access_token;
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const sh = (id, script, output = 'x') => {
    emit({ type: 'item.started', item: { id, type: 'command_execution', command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${script}'`, status: 'in_progress' } });
    emit({ type: 'item.completed', item: { id, type: 'command_execution', command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${script}'`, aggregated_output: output, exit_code: 0, status: 'completed' } });
  };
  emit({ type: 'thread.started', thread_id: 'synthetic' });
  emit({ type: 'turn.started' });
  // Give the runner time to take the login away, as a model reply would.
  setTimeout(() => {
    sh('item_0', 'Get-Content docs\\batch-01.jsonl');
    if (scenario === 'outside') sh('item_1', 'Get-Content C:\\Windows\\win.ini');
    if (scenario === 'credential') sh('item_1', 'Get-Content docs\\a.txt', token);
    if (scenario === 'other') emit({ type: 'item.completed', item: { id: 'item_1', type: 'web_search', query: 'q' } });
    if (scenario === 'write') fs.writeFileSync(path.join(jail, 'docs', 'note.txt'), 'w');
    if (scenario === 'refresh') fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-access-REFRESHED-0001', refresh_token: 'synthetic-refresh-REFRESHED-0001' }, last_refresh: 'now' }));
    if (scenario === 'leftover') {
      const d = path.join(path.dirname(home), 'realhome', 'sessions', '2026', '10');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'rollout-synthetic.jsonl'), JSON.stringify({ cwd: jail }));
    }
    setTimeout(() => {
      sh('item_2', 'git log --oneline -3');
      emit({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: `auth present at commands: ${fs.existsSync(path.join(home, 'auth.json'))}` } });
      const keep = scenario === 'missing' ? ids.slice(1) : ids;
      const key = keep.map((id) => JSON.stringify({ itemId: id, value: 'v', source: 'docs/batch-01.jsonl', quote: 'q' })).join('\n');
      fs.writeFileSync(lastMsg, `\`\`\`jsonl\n${key}\n\`\`\``);
      emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } });
    }, 150);
  }, 300);
});
