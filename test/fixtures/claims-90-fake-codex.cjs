'use strict';
// A stand-in for codex exec (T6 labeller tests; synthetic data only). The prompt names the scenario (SCENARIO:<name>)
// and the row ids (IDS:a,b). It reads the login at start as codex does, starts the jail MCP server from the runner's
// -c mcp_servers.jail.* arguments and calls it as the model would, prints codex --json events, and writes the final
// message to -o. ENVLOG:<file> writes its env key names there; ARGVLOG:<file> its arguments. DECOY:<path> names a
// decoy file the decoy scenario asks for in several shapes. GITARGS:<file> holds a JSON list of git argument lists the
// gitargs scenario sends straight to the server as a 'git' call (a model that ignores tools/list).
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
const at = (f) => args[args.indexOf(f) + 1];
const cfg = (k) => { const a = args.find((x) => x.startsWith(`${k}=`)); return a ? JSON.parse(a.slice(k.length + 1)) : null; };
const jail = at('-C');
const lastMsg = at('-o');
const home = process.env.CODEX_HOME;
let prompt = '';
process.stdin.on('data', (d) => { prompt += d; }).on('end', async () => {
  const word = (k) => (new RegExp(`${k}:(\\S+)`).exec(prompt) || [])[1];
  const scenario = word('SCENARIO') || 'ok';
  const ids = (word('IDS') || '').split(',').filter(Boolean);
  if (word('ENVLOG')) fs.writeFileSync(word('ENVLOG'), Object.keys(process.env).join('\n'));
  if (word('ARGVLOG')) fs.writeFileSync(word('ARGVLOG'), JSON.stringify(args));
  const decoy = word('DECOY');
  const auth = fs.readFileSync(path.join(home, 'auth.json'), 'utf8');
  const token = JSON.parse(auth).tokens.access_token;
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  const server = spawn(cfg('mcp_servers.jail.command'), cfg('mcp_servers.jail.args'), { stdio: ['pipe', 'pipe', 'inherit'] });
  let sbuf = ''; let nextId = 1; const waiting = new Map();
  server.stdout.on('data', (d) => {
    sbuf += d; let i;
    while ((i = sbuf.indexOf('\n')) >= 0) { const m = JSON.parse(sbuf.slice(0, i)); sbuf = sbuf.slice(i + 1); waiting.get(m.id)?.(m); }
  });
  const rpc = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  let n = 0;
  const tool = async (name, a, direct = false) => {
    if (!direct && !args.includes(`mcp_servers.jail.tools.${name}.approval_mode="approve"`)) { emit({ type: 'item.completed', item: { id: `item_${n++}`, type: 'mcp_tool_call', server: 'jail', tool: name, arguments: a, result: null, error: { message: 'MCP tool call requires approval, but approval policy is never' }, status: 'failed' } }); return ''; }
    const id = `item_${n++}`;
    emit({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'jail', tool: name, arguments: a, status: 'in_progress' } });
    const r = (await rpc('tools/call', { name, arguments: a })).result;
    emit({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'jail', tool: name, arguments: a, result: { content: r.content }, error: null, status: r.isError ? 'failed' : 'completed' } });
    return r.content[0].text;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18' });
  emit({ type: 'thread.started', thread_id: 'synthetic' });
  emit({ type: 'turn.started' });
  // Give the runner time to take the login away, as a model reply would.
  await new Promise((r) => setTimeout(r, 300));
  const seen = [];
  seen.push(await tool('list_files', {}));
  seen.push(await tool('read_file', { path: 'docs/batch-01.jsonl' }));
  seen.push(await tool('search', { pattern: 'it-1', glob: '**/*.jsonl' }));
  if (scenario === 'outside') seen.push(await tool('read_file', { path: 'C:\\Windows\\win.ini' }));
  if (scenario === 'decoy') {
    const rel = path.relative(jail, decoy);
    for (const p of [decoy, decoy.replace(/\\/g, '/'), rel, `%USERPROFILE%\\${path.basename(path.dirname(decoy))}\\${path.basename(decoy)}`, `docs/../${rel.replace(/\\/g, '/')}`]) seen.push(await tool('read_file', { path: p }));
    seen.push(await tool('search', { pattern: 'DECOY', path: path.dirname(decoy) }));
    seen.push(await tool('search', { pattern: 'DECOY', glob: '../**' }));
  }
  if (scenario === 'gitargs') for (const a of JSON.parse(fs.readFileSync(word('GITARGS'), 'utf8'))) seen.push(await tool('git', { args: a }, true));
  if (scenario === 'link') { seen.push(await tool('read_file', { path: 'docs/out/secret.txt' })); seen.push(await tool('search', { pattern: 'DECOY' })); }
  if (scenario === 'credential') emit({ type: 'item.completed', item: { id: 'item_c', type: 'agent_message', text: token } });
  if (scenario === 'other') emit({ type: 'item.completed', item: { id: 'item_o', type: 'web_search', query: 'q' } });
  if (scenario === 'shell') emit({ type: 'item.completed', item: { id: 'item_s', type: 'command_execution', command: 'Get-Content a.txt', aggregated_output: '', exit_code: 0, status: 'completed' } });
  if (scenario === 'spawn') emit({ type: 'item.completed', item: { id: 'item_a', type: 'collab_tool_call', tool: 'spawn_agent', status: 'failed' } });
  if (scenario === 'foreign') emit({ type: 'item.completed', item: { id: 'item_f', type: 'mcp_tool_call', server: 'other', tool: 'read', status: 'completed' } });
  if (scenario === 'write') fs.writeFileSync(path.join(jail, 'docs', 'note.txt'), 'w');
  if (scenario === 'refresh') {
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-access-REFRESHED-0001', refresh_token: 'synthetic-refresh-REFRESHED-0001' }, last_refresh: 'now' }));
    if (word('REALAUTH')) fs.writeFileSync(word('REALAUTH'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'synthetic-access-HUMAN-000001' }, last_refresh: 'human' }));
  }
  if (scenario === 'leftover') {
    const d = path.join(path.dirname(home), 'realhome', 'sessions', '2026', '10');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'rollout-synthetic.jsonl'), JSON.stringify({ cwd: jail }));
  }
  await new Promise((r) => setTimeout(r, 150));
  emit({ type: 'item.completed', item: { id: `item_${n++}`, type: 'agent_message', text: `auth present at calls: ${fs.existsSync(path.join(home, 'auth.json'))}; seen ${seen.join(' | ').replace(/\s+/g, ' ').slice(0, 2000)}` } });
  const keep = scenario === 'missing' ? ids.slice(1) : ids;
  const key = keep.map((id) => JSON.stringify({ itemId: id, value: 'v', source: 'docs/batch-01.jsonl', quote: 'q' })).join('\n');
  fs.writeFileSync(lastMsg, `\`\`\`jsonl\n${key}\n\`\`\``);
  emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 } });
  server.stdin.end();
});
