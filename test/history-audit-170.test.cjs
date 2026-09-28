'use strict';

/**
 * HISTORY-169-AUDIT (Jim) fixes:
 *  - F1: a line longer than budget + skipMax must not stall follow or older paging. The
 *    reader hands back a resync cursor inside that line and carries on from it; probed at
 *    small limits (every call makes progress, every normal line is still returned once).
 *  - F2: a hook-reported transcript_path is trusted only inside the provider's own store,
 *    for all three providers (Claude projects dir, the agent's CODEX_HOME, the AGY brain).
 *  - F3: the agent-id check rejects bad ids by itself (not via a registry miss).
 *
 * HOME and USERPROFILE are redirected into a sandbox and asserted BEFORE anything reads a
 * home directory.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hist170-'));
const HOME = path.join(SANDBOX, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.CLAUDE_CONFIG_DIR;
assert.equal(os.homedir(), HOME, 'os.homedir() must be the sandbox before any module reads it');

const loadTs = require('./load-ts.cjs');
const T = loadTs('src/main/historyTail.ts');
const { HistoryService } = loadTs('src/main/historyService.ts');

test.after(() => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ } });

// Tiny limits: a 1,000-byte line is far longer than budget + skipMax (64 + 64).
const LIMITS = { chunk: 16, budget: 64, maxLine: 32, skipMax: 64 };
const HUGE = 'X'.repeat(1000);

function file(name, text) {
  const p = path.join(SANDBOX, name);
  fs.writeFileSync(p, text);
  return p;
}

// ── F1: resync past a line longer than budget + skipMax ───────────────────

test('F1 forward: follow crosses a line longer than budget + skipMax; every call makes progress', () => {
  const p = file('fwd.jsonl', `a1\na2\n${HUGE}\nb1\nb2\n`);
  const size = fs.statSync(p).size;
  let after = 0;
  const got = [];
  let skipped = 0;
  for (let calls = 0; after < size; calls++) {
    assert.ok(calls < 100, 'bounded number of calls');
    const r = T.readLinesForward(p, after, LIMITS);
    assert.ok(r.end > after, `progress: ${after} -> ${r.end}`);
    assert.ok(r.bytesRead <= LIMITS.budget + LIMITS.skipMax + LIMITS.chunk, `bounded read (${r.bytesRead})`);
    got.push(...r.lines.map((l) => l.text));
    skipped += r.skipped;
    after = r.end;
  }
  assert.deepEqual(got, ['a1', 'a2', 'b1', 'b2']);
  assert.equal(skipped, 1, 'the huge line is skipped exactly once');
});

test('F1 backward: older paging crosses the same line; starts strictly decrease and the window chains', () => {
  const p = file('bwd.jsonl', `a1\na2\n${HUGE}\nb1\nb2\n`);
  let before = null;
  let prevStart = fs.statSync(p).size;
  const pages = [];
  for (let calls = 0; ; calls++) {
    assert.ok(calls < 100, 'bounded number of calls');
    const r = T.readLinesBackward(p, before, () => false, LIMITS);
    if (before !== null) assert.equal(r.end, before, 'each older page ends exactly where the previous one started');
    assert.ok(r.start < prevStart || r.start === 0, `progress: ${prevStart} -> ${r.start}`);
    assert.ok(r.bytesRead <= LIMITS.budget + LIMITS.skipMax + LIMITS.chunk, `bounded read (${r.bytesRead})`);
    pages.unshift(...r.lines.map((l) => l.text));
    if (r.start === 0) break;
    prevStart = r.start;
    before = r.start;
  }
  assert.deepEqual(pages, ['a1', 'a2', 'b1', 'b2']);
});

test('F1 forward: a huge line still being written is not rescanned on every poll', () => {
  const p = file('grow.jsonl', `a1\n${HUGE}`);
  let r = T.readLinesForward(p, 0, LIMITS);
  let after = r.end;
  // Drain what is there: the cursor moves into the unterminated huge line.
  for (let i = 0; i < 100 && after < fs.statSync(p).size; i++) { r = T.readLinesForward(p, after, LIMITS); after = r.end; }
  assert.equal(after, fs.statSync(p).size, 'the cursor reached the end of the partial huge line');
  const idle = T.readLinesForward(p, after, LIMITS);
  assert.equal(idle.bytesRead, 0, 'an unchanged file costs no read');
  fs.appendFileSync(p, 'YYYY\nc1\n');
  const next = T.readLinesForward(p, after, LIMITS);
  assert.deepEqual(next.lines.map((l) => l.text), ['c1']);
  assert.ok(next.bytesRead <= 16, `only the new bytes are read (${next.bytesRead})`);
});

test('F1: an ordinary cursor (a line start) is unaffected; a normal oversized line within skipMax is skipped as before', () => {
  const p = file('norm.jsonl', `a1\n${'Z'.repeat(40)}\nb1\n`);
  const f = T.readLinesForward(p, 0, { ...LIMITS, budget: 1000 });
  assert.deepEqual(f.lines.map((l) => l.text), ['a1', 'b1']);
  assert.equal(f.end, fs.statSync(p).size);
  const b = T.readLinesBackward(p, null, () => false, { ...LIMITS, budget: 1000 });
  assert.deepEqual(b.lines.map((l) => l.text), ['a1', 'b1']);
  assert.equal(b.start, 0);
});

// ── F2: hook transcript_path only inside the provider's store ─────────────

function service(agents, extra = {}) {
  return new HistoryService({
    agent: extra.anyAgent ? () => ({ provider: 'claude' }) : (id) => agents[id] ?? null,
    transcriptPath: (id) => extra.hookPaths?.[id],
    codexHomeFor: (id) => extra.codexHomes?.[id] ?? null,
    geminiHome: () => path.join(HOME, '.gemini')
  });
}
const LINE = '{"type":"user","message":{"content":"hi"}}\n';
function place(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, LINE); return p; }

test('F2 Claude: a hook path inside ~/.claude/projects is used; one outside is not', () => {
  const inside = place(path.join(HOME, '.claude', 'projects', 'k', 'in.jsonl'));
  const outside = place(path.join(SANDBOX, 'elsewhere', 'out.jsonl'));
  assert.equal(service({ c: { provider: 'claude' } }, { hookPaths: { c: inside } }).page({ agentId: 'c' }).fileName, 'in.jsonl');
  assert.deepEqual(service({ c: { provider: 'claude' } }, { hookPaths: { c: outside } }).page({ agentId: 'c' }), { ok: false, reason: 'no-transcript' });
  // A traversal that resolves outside is refused too.
  const sneaky = path.join(HOME, '.claude', 'projects', '..', '..', 'elsewhere', 'out.jsonl');
  assert.deepEqual(service({ c: { provider: 'claude' } }, { hookPaths: { c: sneaky } }).page({ agentId: 'c' }), { ok: false, reason: 'no-transcript' });
});

test('F2 Claude: CLAUDE_CONFIG_DIR/projects is a trusted root when set', () => {
  const cfg = path.join(SANDBOX, 'claude-cfg');
  const p = place(path.join(cfg, 'projects', 'k', 'cfg.jsonl'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    assert.equal(service({ c: { provider: 'claude' } }, { hookPaths: { c: p } }).page({ agentId: 'c' }).fileName, 'cfg.jsonl');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; }
  assert.deepEqual(service({ c: { provider: 'claude' } }, { hookPaths: { c: p } }).page({ agentId: 'c' }), { ok: false, reason: 'no-transcript' });
});

test('F2 Codex: a hook path inside the agent\'s CODEX_HOME is used; one outside is not (kills the inside-home mutant)', () => {
  const home = path.join(SANDBOX, 'agents', 'x', '.codex');
  fs.mkdirSync(home, { recursive: true }); // no sessions dir: no by-id and no newest-rollout fallback
  const inside = place(path.join(home, 'elsewhere-in-home', 'rollout-a.jsonl'));
  const outside = place(path.join(SANDBOX, 'agents', 'y', '.codex', 'rollout-b.jsonl'));
  assert.equal(service({ x: { provider: 'codex' } }, { codexHomes: { x: home }, hookPaths: { x: inside } }).page({ agentId: 'x' }).fileName, 'rollout-a.jsonl');
  assert.deepEqual(service({ x: { provider: 'codex' } }, { codexHomes: { x: home }, hookPaths: { x: outside } }).page({ agentId: 'x' }), { ok: false, reason: 'no-transcript' });
});

test('F2 Antigravity: a transcript.jsonl inside the brain dir is used; one outside is not', () => {
  const inside = place(path.join(HOME, '.gemini', 'antigravity-cli', 'brain', 'conv1', '.system_generated', 'logs', 'transcript.jsonl'));
  const outside = place(path.join(SANDBOX, 'not-brain', 'transcript.jsonl'));
  assert.equal(service({ g: { provider: 'antigravity' } }, { hookPaths: { g: inside } }).page({ agentId: 'g' }).fileName, 'transcript.jsonl');
  assert.deepEqual(service({ g: { provider: 'antigravity' } }, { hookPaths: { g: outside } }).page({ agentId: 'g' }), { ok: false, reason: 'no-transcript' });
});

// ── F3: the agent-id check ─────────────────────────────────────────────────

test('F3: bad agent ids are refused by the id check itself, even when the registry would answer', () => {
  const inside = place(path.join(HOME, '.claude', 'projects', 'k', 'f3.jsonl'));
  const svc = service({}, { anyAgent: true, hookPaths: new Proxy({}, { get: () => inside }) });
  assert.equal(svc.page({ agentId: 'ok-id_1.2' }).ok, true, 'a valid id passes (the registry stub answers anything)');
  for (const bad of ['', 'a b', '../x', 'a/b', 'a\\b', 'x'.repeat(129), 'é', 42, null, undefined, {}]) {
    assert.deepEqual(svc.page({ agentId: bad }), { ok: false, reason: 'no-agent' }, JSON.stringify(bad));
  }
  assert.equal(svc.page({ agentId: 'x'.repeat(128) }).ok, true, '128 characters is the limit');
  assert.deepEqual(svc.page(null), { ok: false, reason: 'no-agent' });
});
