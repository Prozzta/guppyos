'use strict';

/**
 * START-FIXES-163 (2) — non-Claude agents never read Claude transcripts. One of the three fixes the Human approved from Jim's WHY-162.
 *
 *   (1) PHANTOM RESUME KEY. A resumed Claude emits its start-up OTel metric under a
 *       fresh process session id that has no transcript. The 30 s beat copied it into
 *       the registry as the --resume key, so a quick restart came up FRESH and lost its
 *       context (4 of 54 starts, god on 1.1.62). Now a sample id only fills an empty
 *       key or one whose transcript exists; the replaced id is kept, and a key with no
 *       transcript resumes the previous one, logging a resume-miss row either way.
 *   (2) NON-CLAUDE AGENTS NEVER READ CLAUDE TRANSCRIPTS (the Human's rule). Codex/AGY
 *       ids can never match a Claude record, yet the usage fallback parsed all 546 MB
 *       of C:/PrzEdit for each of them on the first beat of every start (~5-6 s
 *       main-process freeze). Every per-agent reader refuses unless provider is
 *       exactly 'claude'.
 *   (3) BOOT-SUBMIT LOGGING ONLY. A boot-submit row per attempt, per Enter write and
 *       for the thrown case; the renderer no longer swallows the error. The submit
 *       behaviour itself is unchanged.
 *
 * Every test that touches ~/.claude redirects HOME first and asserts it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sandboxHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sf163-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before touching ~/.claude');
  return home;
}

const T = loadTs('src/main/transcript.ts');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');

function claudeProject(cwd, sessions) {
  const dir = T.projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  for (const [sid, out] of Object.entries(sessions)) {
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({
      type: 'assistant', sessionId: sid,
      message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    })}\n`);
  }
  return dir;
}

// ── (2) non-Claude agents never read Claude transcripts ─────────────────────────────────

const NON_CLAUDE = ['codex', 'antigravity', 'gemini', 'grok', 'crush', 'opencode', 'copilot', 'custom', 'some-future-provider', undefined, null];

/** Count every fs touch under ~/.claude/projects while `fn` runs. */
function countProjectReads(home, fn) {
  const root = path.join(home, '.claude', 'projects');
  const names = ['readdirSync', 'openSync', 'readFileSync', 'statSync', 'readSync', 'fstatSync'];
  const orig = {};
  let hits = 0;
  for (const n of names) {
    orig[n] = fs[n];
    fs[n] = function (p, ...rest) {
      if (typeof p === 'string' && path.resolve(p).startsWith(root)) hits += 1;
      if (typeof p === 'number' && (n === 'readSync' || n === 'fstatSync')) hits += 1;
      return orig[n].call(this, p, ...rest);
    };
  }
  try { fn(); } finally { for (const n of names) fs[n] = orig[n]; }
  return hits;
}

test('(2) readAgentUsage / readContextTokens read NOTHING for any non-Claude provider (default excluded)', (t) => {
  const home = sandboxHome(t);
  const cwd = path.join(home, 'shared');
  const dir = claudeProject(cwd, { 'claude-s': 7, 'codex-rollout-id': 9 });
  const tp = path.join(dir, 'claude-s.jsonl');
  for (const provider of NON_CLAUDE) {
    let u; let c;
    const hits = countProjectReads(home, () => {
      u = T.readAgentUsage(cwd, { sessionId: 'codex-rollout-id', provider });
      c = T.readContextTokens(tp, provider);
    });
    assert.equal(hits, 0, `${String(provider)}: zero Claude-transcript reads`);
    assert.equal(u.outputTokens, 0, String(provider));
    assert.equal(c, null, String(provider));
  }
  assert.equal(T.readAgentUsage(cwd).outputTokens, 0, 'no options at all = excluded');
  // The control: a Claude agent still reads, with the same numbers as before.
  const hits = countProjectReads(home, () => {
    assert.equal(T.readAgentUsage(cwd, { sessionId: 'claude-s', provider: 'claude' }).outputTokens, 7);
    assert.equal(T.readContextTokens(tp, 'claude'), 17);
  });
  assert.ok(hits > 0, 'the Claude control really read');
});

test('(2) the beat/fallback path: a Codex/AGY agent with no OTel sample causes ZERO transcript reads', (t) => {
  const home = sandboxHome(t);
  const cwd = path.join(home, 'PrzEdit');
  claudeProject(cwd, Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`claude-${i}`, 100])));
  const reg = {
    dwight: { cwd, sessionId: '019a-codex-rollout', provider: 'codex' },
    phyllis: { cwd, sessionId: 'agy-conversation-id', provider: 'antigravity' },
    legacy: { cwd, sessionId: 'claude-3' },               // no provider = a legacy CLAUDE agent
    ghost: undefined
  };
  const telemetry = new TelemetryCollector({
    resolveCwd: (id) => reg[id]?.cwd ?? null,
    resolveSessionId: (id) => reg[id]?.sessionId,
    resolveProvider: (id) => (reg[id] ? (reg[id].provider ?? 'claude') : undefined)
  });
  const before = { ...T.transcriptReadStats };
  const hits = countProjectReads(home, () => {
    assert.equal(telemetry.getAgentUsage('dwight'), null);
    assert.equal(telemetry.getAgentUsage('phyllis'), null);
    assert.equal(telemetry.getAgentUsage('ghost'), null);
  });
  assert.equal(hits, 0, 'Codex + AGY + unknown: zero reads under ~/.claude/projects');
  assert.equal(T.transcriptReadStats.usageDirScans, before.usageDirScans);
  // A collector with no provider resolver at all treats every agent as unknown = excluded.
  const bare = new TelemetryCollector({ resolveCwd: () => cwd, resolveSessionId: () => 'claude-3' });
  assert.equal(countProjectReads(home, () => assert.equal(bare.getAgentUsage('x'), null)), 0);
  // The legacy Claude agent keeps today's number (its own session only).
  assert.equal(telemetry.getAgentUsage('legacy').output, 100);
});

test('(2) every call site passes the provider; the UI context poll is gated too', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /resolveProvider: \(agentId\) => \{\s*const a = hive\.registry\(\)\.agents\[agentId\];\s*return a \? \(a\.provider \?\? 'claude'\) : undefined;/);
  assert.match(idx, /if \(!mayReadClaudeTranscripts\(provider\)\) return null;\s*return readContextTokens\(tp, provider\) \?\? 0;/, 'hive:agentContext');
  assert.match(idx, /readAgentUsage\(cwd, \{ provider: 'claude' \}\)/, 'hive:agentUsage is per-cwd, explicitly Claude');
  assert.match(read('src/main/telemetry.ts'), /if \(!mayReadClaudeTranscripts\(provider\)\) return null;\s*const u = readAgentUsage\(cwd, \{ sessionId, provider \}\);/);
  assert.match(read('src/main/usage.ts'), /readAgentUsage\(info\.cwd, \{ provider: info\.provider \}\)/);
  // No per-agent reader call anywhere without a provider.
  for (const f of ['src/main/index.ts', 'src/main/telemetry.ts', 'src/main/usage.ts']) {
    const s = read(f);
    for (const m of s.matchAll(/readAgentUsage\(([^)]*)\)/g)) assert.match(m[1], /provider/, `${f}: ${m[0]}`);
    for (const m of s.matchAll(/readContextTokens\(([^)]*)\)/g)) assert.match(m[1], /provider/, `${f}: ${m[0]}`);
  }
});

