'use strict';
require('./tools/own-job.cjs');

// FLEET-CODEX-ACTIVITY: Codex has no OTLP feed. Its bounded rollout fallback
// must nevertheless make the normal usage seam and the context IPC source live.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');

function homeWithExcerpt() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-codex-'));
  const dir = path.join(home, 'sessions', '2026', '10', '20');
  fs.mkdirSync(dir, { recursive: true });
  const id = '01a15577-6e8b-7e90-9ad1-aec51c5f0f97';
  fs.writeFileSync(path.join(dir, `rollout-2026-10-20T20-40-52-${id}.jsonl`), `${JSON.stringify({
    timestamp: '2026-10-20T21:07:20.924Z', ordinal: 8589, type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: 68191296, cached_input_tokens: 65868032, cache_write_input_tokens: 0, output_tokens: 319688, reasoning_output_tokens: 85401 },
      last_token_usage: { input_tokens: 22259, cached_input_tokens: 20224, cache_write_input_tokens: 0, output_tokens: 463, reasoning_output_tokens: 26 },
      model_context_window: 258400
    } }
  })}\n`);
  return { home, id, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

test('Codex rollout supplies fleet usage, activity timestamp and live context without reading Claude', () => {
  const h = homeWithExcerpt();
  const telemetry = new TelemetryCollector({
    resolveProvider: () => 'codex', resolveCodexHome: () => h.home, resolveSessionId: () => h.id
  });
  const usage = telemetry.getAgentUsage('dwight');
  assert.deepEqual(usage && { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, usd: usage.usd, estimated: usage.usdEstimated, ts: usage.ts }, {
    input: 2323264, output: 319688, cacheRead: 65868032, usd: 0, estimated: true,
    ts: Date.parse('2026-10-20T21:07:20.924Z')
  });
  assert.equal(telemetry.getCodexContext('dwight'), 22722);
  h.cleanup();
});

test('fleet falls through only for Codex: Claude without OTLP remains inactive, and rollout usage stays out of breaker budgets', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const hooks = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8');
  assert.match(index, /const u = usageById\.get\(id\) \?\? \(provider === 'codex' \? usageProvider\.getAgentUsage\(id\) : null\);/);
  assert.match(index, /const sample = provider === 'codex' \? null : usageProvider\.getAgentUsage\(id\);/);
  assert.match(index, /costEstimated: !!u\?\.usdEstimated/);
  assert.match(index, /provider === 'codex'\) return telemetry\.getCodexContext\(agentId\)/);
  assert.match(hooks, /this\.contextById\.set\(agentId, context\)/);
  assert.match(hooks, /this\.contextById\.delete\(agentId\);/);
  assert.match(hooks, /this\.codexContextSession\.get\(agentId\) !== sessionId/);
  assert.match(hooks, /limit: read\.usage\.modelContextWindow/);
});
