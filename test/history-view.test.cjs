'use strict';

/**
 * HISTORY-VIEW-169: the History tab's main side.
 *  - the per-provider normalisers, on small SYNTHETIC fixtures written from the real
 *    record shapes (no real conversation content is in the repo);
 *  - the bounded tail reader: a big file, a growing file with a frozen mtime, a missing
 *    file, CRLF endings, a partial last line, an oversized line;
 *  - the service: source resolution per provider, paging by byte cursor, follow, reset.
 *
 * HOME and USERPROFILE are redirected into a sandbox and asserted BEFORE anything reads
 * a home directory: projectDir() resolves ~/.claude through os.homedir().
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hist169-'));
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
assert.equal(os.homedir(), HOME, 'os.homedir() must be the sandbox before any module reads it');

const loadTs = require('./load-ts.cjs');
const N = loadTs('src/main/historyNormalize.ts');
const T = loadTs('src/main/historyTail.ts');
const { HistoryService } = loadTs('src/main/historyService.ts');
const H = loadTs('src/shared/history.ts');

const FIX = path.join(__dirname, 'fixtures', 'history');
const lines = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').split(/\r?\n/).filter(Boolean);
const normAll = (provider, name) => lines(name).flatMap((l, i) => N.normalizeLine(provider, l, i));
const brief = (items) => items.map((i) => `${i.kind}:${i.text}`);
const tmp = (name, content) => { const p = path.join(SANDBOX, name); fs.writeFileSync(p, content); return p; };

test.after(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── normalisers ────────────────────────────────────────────────────────────

test('claude: user and assistant text, tools as one line; thinking, tool output, meta, sidechain, compact summary hidden', () => {
  const items = normAll('claude', 'claude.jsonl');
  assert.deepEqual(brief(items), [
    'user:Please add a greeting.',
    'assistant:I will add it.',
    'tool:Bash: echo hi there',
    'system:/clear',
    'system:Conversation compacted',
    'user:Thanks, done?',
    'assistant:Yes.',
    'tool:Read: C:\\proj\\a.ts'
  ]);
  const all = JSON.stringify(items);
  for (const hidden of ['secret thoughts', 'RAW TOOL OUTPUT', 'subagent chatter', 'meta caveat', 'injected context', 'continued (summary)', 'cleared']) {
    assert.ok(!all.includes(hidden), `${hidden} is never shown`);
  }
  assert.equal(items[0].at, Date.parse('2026-01-01T10:00:01.000Z'));
  // Two items from one line get distinct, stable ids.
  const last2 = items.slice(-2);
  assert.equal(last2[0].offset, last2[1].offset);
  assert.notEqual(last2[0].id, last2[1].id);
});

test('codex: item_completed is the source; response_item messages (duplicates, injected context) are skipped; legacy records still read', () => {
  const items = normAll('codex', 'codex.jsonl');
  assert.deepEqual(brief(items), [
    'user:hi',
    'assistant:Hello! Running tests.',
    'tool:shell: npm test (exit 1)',
    'tool:edit: C:\\proj\\a.ts',
    'tool:web search: codex rollout format',
    'system:Context compacted',
    'user:legacy prompt',
    'assistant:legacy reply',
    'tool:shell: bash -lc ls'
  ]);
  const all = JSON.stringify(items);
  for (const hidden of ['RAW TOOL OUTPUT', 'developer instructions', 'environment_context', 'You are Codex', 'gAAAA']) {
    assert.ok(!all.includes(hidden), `${hidden} is never shown`);
  }
});

test('antigravity: the USER_REQUEST text, planner text, tool calls with decoded args; tool output and system notes hidden', () => {
  const items = normAll('antigravity', 'agy.jsonl');
  assert.deepEqual(brief(items), [
    'user:Check the inbox.',
    'tool:view_file: C:\\proj\\memory.md',
    'assistant:The inbox is empty.',
    'system:Context checkpoint',
    'user:You have new hive messages.'
  ]);
  assert.equal(items[0].at, Date.parse('2026-01-01T10:00:00Z'));
  assert.ok(!JSON.stringify(items).includes('RAW TOOL OUTPUT'));
  assert.ok(!JSON.stringify(items).includes('local time'));
});

test('caps: a long message is cut at HISTORY_TEXT_MAX and marked; a tool line at HISTORY_TOOL_MAX; malformed lines yield nothing', () => {
  const long = 'x'.repeat(H.HISTORY_TEXT_MAX * 3);
  const [m] = N.normalizeLine('claude', JSON.stringify({ type: 'user', message: { content: long } }), 7);
  assert.ok(m.text.length <= H.HISTORY_TEXT_MAX + 2);
  assert.equal(m.truncated, true);
  assert.equal(m.id, '7.0');
  const [t] = N.normalizeLine('claude', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'y'.repeat(5000) } }] } }), 0);
  assert.ok(t.text.length <= H.HISTORY_TOOL_MAX);
  assert.ok(!t.text.includes('\n'));
  assert.deepEqual(N.normalizeLine('codex', '{"type":"event_msg", broken', 0), []);
  assert.deepEqual(N.normalizeLine('claude', 'null', 0), []);
  assert.deepEqual(N.normalizeLine('antigravity', '[1,2]', 0), []);
});

test('toolSummary: key argument first, JSON-string args parsed, unknown args fall back to compact JSON', () => {
  assert.equal(N.toolSummary('Grep', { pattern: 'foo', path: 'src' }), 'Grep: src');
  assert.equal(N.toolSummary('shell', '{"command":["git","status"]}'), 'shell: git status');
  assert.equal(N.toolSummary('mystery', { a: 1 }), 'mystery: {"a":1}');
  assert.equal(N.toolSummary('noargs', {}), 'noargs');
});

// ── bounded tail reader ────────────────────────────────────────────────────

const collect = (n) => (newestFirst) => newestFirst.length >= n;

test('tail: a big file is read from the end in bounded chunks, never whole', () => {
  const row = (i) => JSON.stringify({ type: 'user', message: { content: `line ${i} ${'p'.repeat(200)}` } });
  const p = path.join(SANDBOX, 'big.jsonl');
  const fd = fs.openSync(p, 'w');
  let i = 0;
  for (let block = 0; block < 60; block += 1) {   // ~13 MB
    const rows = [];
    for (let k = 0; k < 1000; k += 1) rows.push(row(i++));
    fs.writeSync(fd, rows.join('\n') + '\n');
  }
  fs.closeSync(fd);
  const size = fs.statSync(p).size;
  assert.ok(size > 12 * 1024 * 1024);
  const r = T.readLinesBackward(p, null, collect(20));
  assert.equal(r.lines.length, 20);
  assert.equal(r.end, size);
  assert.ok(r.bytesRead <= T.HISTORY_CHUNK_BYTES, `read ${r.bytesRead} bytes for 20 lines`);
  assert.match(r.lines[19].text, new RegExp(`^\\{"type":"user","message":\\{"content":"line ${i - 1} `));
  assert.equal(r.start, r.lines[0].offset);
  // The next page continues exactly before it.
  const older = T.readLinesBackward(p, r.start, collect(20));
  assert.equal(older.end, r.start);
  assert.match(older.lines[19].text, new RegExp(`"line ${i - 21} `));
  // With no stop condition the byte budget still bounds the read.
  const budgeted = T.readLinesBackward(p, null, () => false, { budget: 256 * 1024 });
  assert.ok(budgeted.bytesRead < 256 * 1024 + T.HISTORY_CHUNK_BYTES);
  assert.ok(budgeted.start > 0);
});

test('tail: a partial last line is never returned, and the window ends before it; CRLF is tolerated', () => {
  const p = tmp('partial.jsonl', '{"a":1}\r\n{"a":2}\r\n{"a":3, "unterm');
  const r = T.readLinesBackward(p, null, () => false);
  assert.deepEqual(r.lines.map((l) => l.text), ['{"a":1}', '{"a":2}']);
  assert.equal(r.start, 0);
  assert.equal(r.end, Buffer.byteLength('{"a":1}\r\n{"a":2}\r\n'));
  assert.equal(r.lines[1].offset, Buffer.byteLength('{"a":1}\r\n'));
  const f = T.readLinesForward(p, 0);
  assert.deepEqual(f.lines.map((l) => l.text), ['{"a":1}', '{"a":2}']);
  assert.equal(f.end, r.end);
  // The line completes: the next forward read from `end` returns it whole.
  fs.appendFileSync(p, ' done"}\r\n');
  const g = T.readLinesForward(p, f.end);
  assert.deepEqual(g.lines.map((l) => l.text), ['{"a":3, "unterm done"}']);
});

test('tail: multi-byte UTF-8 across chunk boundaries decodes intact', () => {
  const text = 'héllo — ✓ 日本語 '.repeat(50);
  const p = tmp('utf8.jsonl', `${JSON.stringify({ t: text })}\n${JSON.stringify({ t: 'b' })}\n`);
  const r = T.readLinesBackward(p, null, () => false, { chunk: 7 });
  assert.equal(JSON.parse(r.lines[0].text).t, text);
  const f = T.readLinesForward(p, 0, { chunk: 5 });
  assert.equal(JSON.parse(f.lines[0].text).t, text);
});

test('tail: an oversized line is skipped without being assembled, both directions', () => {
  const huge = JSON.stringify({ type: 'compacted', payload: { blob: 'z'.repeat(300 * 1024) } });
  const p = tmp('oversized.jsonl', `{"n":1}\n${huge}\n{"n":2}\n`);
  const lim = { maxLine: 64 * 1024, chunk: 16 * 1024 };
  const r = T.readLinesBackward(p, null, () => false, lim);
  assert.deepEqual(r.lines.map((l) => l.text), ['{"n":1}', '{"n":2}']);
  assert.equal(r.skipped, 1);
  const f = T.readLinesForward(p, 0, lim);
  assert.deepEqual(f.lines.map((l) => l.text), ['{"n":1}', '{"n":2}']);
  assert.equal(f.skipped, 1);
});

test('tail: a growing file whose mtime is frozen is still followed (growth is by SIZE)', () => {
  const p = tmp('frozen.jsonl', '{"n":1}\n');
  const frozen = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(p, frozen, frozen);
  const first = T.readLinesForward(p, 0);
  assert.equal(first.lines.length, 1);
  const idle = T.readLinesForward(p, first.end);
  assert.equal(idle.lines.length, 0);
  assert.equal(idle.bytesRead, 0, 'an unchanged file costs a stat, no read');
  fs.appendFileSync(p, '{"n":2}\n{"n":3}\n');
  fs.utimesSync(p, frozen, frozen);   // Windows: the mtime stays at creation
  assert.equal(fs.statSync(p).mtimeMs, frozen.getTime());
  const grown = T.readLinesForward(p, first.end);
  assert.deepEqual(grown.lines.map((l) => l.text), ['{"n":2}', '{"n":3}']);
});

test('tail: a missing file throws (the service turns that into a reason)', () => {
  assert.throws(() => T.readLinesBackward(path.join(SANDBOX, 'nope.jsonl'), null, () => false));
  assert.throws(() => T.readLinesForward(path.join(SANDBOX, 'nope.jsonl'), 0));
});

// ── service ────────────────────────────────────────────────────────────────

function service(agents, extra = {}) {
  return new HistoryService({
    agent: (id) => agents[id] ?? null,
    transcriptPath: (id) => extra.hookPaths?.[id],
    codexHomeFor: (id) => extra.codexHomes?.[id] ?? null,
    geminiHome: () => path.join(HOME, '.gemini')
  }, extra.limits);
}

test('service: Claude resolves projectDir(cwd)/<sessionId>.jsonl inside the sandboxed home; hook path wins', () => {
  const cwd = path.join(SANDBOX, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  const sid = '00000000-0000-4000-8000-000000000001';
  const dir = path.join(HOME, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'claude.jsonl'), path.join(dir, `${sid}.jsonl`));
  const svc = service({ a1: { provider: 'claude', cwd, sessionId: sid } });
  const page = svc.page({ agentId: 'a1' });
  assert.equal(page.ok, true);
  assert.equal(page.provider, 'claude');
  assert.equal(page.fileName, `${sid}.jsonl`);
  assert.equal(page.items.length, 8);
  assert.equal(page.atStart, true);
  assert.equal(page.end, page.size);
  assert.ok(!('file' in page) && !JSON.stringify(page).includes(SANDBOX), 'no path is sent to the renderer');

  // A hook path is trusted only inside Claude's projects dir (HISTORY-169-AUDIT F2).
  const hook = path.join(dir, 'hook.jsonl');
  fs.writeFileSync(hook, lines('claude.jsonl').slice(-2).join('\n') + '\n');
  const svc2 = service({ a1: { provider: 'claude', cwd, sessionId: sid } }, { hookPaths: { a1: hook } });
  assert.deepEqual(brief(svc2.page({ agentId: 'a1' }).items), ['user:Thanks, done?', 'assistant:Yes.', 'tool:Read: C:\\proj\\a.ts']);
});

test('service: Codex resolves the rollout for the sessionId under the agent\'s own CODEX_HOME; paging and follow by byte cursor', () => {
  const home = path.join(SANDBOX, 'agents', 'c1', '.codex');
  const day = path.join(home, 'sessions', '2026', '01', '01');
  fs.mkdirSync(day, { recursive: true });
  const sid = '01a00000-0000-7000-8000-000000000001';
  const file = path.join(day, `rollout-2026-01-01T10-00-00-${sid}.jsonl`);
  fs.copyFileSync(path.join(FIX, 'codex.jsonl'), file);
  // A newer, unrelated rollout: the sessionId must win over "newest".
  fs.writeFileSync(path.join(day, 'rollout-2026-01-01T11-00-00-01a00000-0000-7000-8000-000000000009.jsonl'), '');
  const svc = service({ c1: { provider: 'codex', sessionId: sid } }, { codexHomes: { c1: home } });
  const tail = svc.page({ agentId: 'c1', limit: 3 });
  assert.equal(tail.ok, true);
  assert.deepEqual(brief(tail.items), ['user:legacy prompt', 'assistant:legacy reply', 'tool:shell: bash -lc ls']);
  assert.equal(tail.atStart, false);
  const older = svc.page({ agentId: 'c1', before: tail.start, limit: 400 });
  assert.equal(older.end, tail.start);
  assert.equal(older.atStart, true);
  assert.equal(older.items.length, 6);
  assert.deepEqual(brief([...older.items, ...tail.items]), brief(normAll('codex', 'codex.jsonl')));

  // Follow: nothing new, then growth (mtime frozen), then a partial line.
  assert.deepEqual(svc.page({ agentId: 'c1', after: tail.end }).items, []);
  const frozen = fs.statSync(file).mtime;
  fs.appendFileSync(file, JSON.stringify({ timestamp: '2026-01-01T10:01:00Z', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'new turn' }] } } }) + '\n{"partial":');
  fs.utimesSync(file, frozen, frozen);
  const grown = svc.page({ agentId: 'c1', after: tail.end });
  assert.deepEqual(brief(grown.items), ['assistant:new turn']);
  assert.equal(grown.end, fs.statSync(file).size - Buffer.byteLength('{"partial":'));

  // Truncated or replaced: reset.
  const reset = svc.page({ agentId: 'c1', after: fs.statSync(file).size + 100 });
  assert.equal(reset.reset, true);
});

test('service: Antigravity resolves the brain transcript by conversation id', () => {
  const conv = '11111111-2222-4333-8444-555555555555';
  const dir = path.join(HOME, '.gemini', 'antigravity-cli', 'brain', conv, '.system_generated', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'agy.jsonl'), path.join(dir, 'transcript.jsonl'));
  const svc = service({ g1: { provider: 'antigravity', sessionId: conv } });
  const page = svc.page({ agentId: 'g1' });
  assert.equal(page.ok, true);
  assert.equal(page.items.length, 5);
});

test('service: bad requests and missing sources are reasons, never throws; path-like ids rejected', () => {
  const svc = service({
    x: { provider: 'grok' },
    y: { provider: 'claude', cwd: path.join(SANDBOX, 'nowhere'), sessionId: 'deadbeef-0000-4000-8000-000000000000' },
    z: { provider: 'antigravity', sessionId: '../../etc' },
    w: { provider: 'codex', sessionId: 'abc' }
  });
  assert.deepEqual(svc.page(null), { ok: false, reason: 'no-agent' });
  assert.deepEqual(svc.page({ agentId: '../x' }), { ok: false, reason: 'no-agent' });
  assert.deepEqual(svc.page({ agentId: 'missing' }), { ok: false, reason: 'no-agent' });
  assert.deepEqual(svc.page({ agentId: 'x' }), { ok: false, reason: 'unsupported-provider' });
  assert.deepEqual(svc.page({ agentId: 'y' }), { ok: false, reason: 'no-transcript' });
  assert.deepEqual(svc.page({ agentId: 'z' }), { ok: false, reason: 'no-transcript' });
  assert.deepEqual(svc.page({ agentId: 'w' }), { ok: false, reason: 'no-transcript' });
});

test('service: a vanished file is re-resolved, and reads as no-transcript', () => {
  const vdir = path.join(HOME, '.claude', 'projects', 'vanish');
  fs.mkdirSync(vdir, { recursive: true });
  const p = path.join(vdir, 'vanish.jsonl');
  fs.writeFileSync(p, '{"type":"user","message":{"content":"hey"}}\n');
  const svc = service({ v: { provider: 'claude' } }, { hookPaths: { v: p } });
  assert.equal(svc.page({ agentId: 'v' }).items.length, 1);
  fs.rmSync(p);
  assert.deepEqual(svc.page({ agentId: 'v' }), { ok: false, reason: 'no-transcript' });
});

test('service: Codex with no recorded session falls back to the home\'s newest rollout', () => {
  const home = path.join(SANDBOX, 'agents', 'c2', '.codex');
  const day = path.join(home, 'sessions', '2026', '01', '02');
  fs.mkdirSync(day, { recursive: true });
  const old = path.join(day, 'rollout-2026-01-02T09-00-00-01a00000-0000-7000-8000-00000000000a.jsonl');
  const neu = path.join(day, 'rollout-2026-01-02T10-00-00-01a00000-0000-7000-8000-00000000000b.jsonl');
  fs.writeFileSync(old, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'old' } }) + '\n');
  fs.writeFileSync(neu, JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new' } }) + '\n');
  fs.utimesSync(old, new Date('2026-01-02T09:00:00Z'), new Date('2026-01-02T09:00:00Z'));
  fs.utimesSync(neu, new Date('2026-01-02T10:00:00Z'), new Date('2026-01-02T10:00:00Z'));
  const svc = service({ c2: { provider: 'codex' } }, { codexHomes: { c2: home } });
  assert.deepEqual(brief(svc.page({ agentId: 'c2' }).items), ['user:new']);
  // Not a Codex worker (no home): no transcript, and no walk of anything else.
  assert.deepEqual(service({ c3: { provider: 'codex' } }).page({ agentId: 'c3' }), { ok: false, reason: 'no-transcript' });
});
