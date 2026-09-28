'use strict';

/**
 * JOB-ENV-IDENTITY (1.1.71; its own commit so it can be dropped): a hive Claude agent must never
 * be parked into Claude Code's shared background daemon.
 *
 * Live on 2026-09-27 23:27Z, the agent view parked Jim's and Andy's sessions into ONE on-demand
 * daemon. Jim's TUI had started that daemon, so Andy's session ran with Jim's env: AGENT_ID,
 * AGENT_DIR, the OTel agent.id label, and after a restart a dead OTel port.
 *
 * Claude Code 2.1.283's own switch turns the feature off. Its settings schema describes it as
 * "Disable agent view (`claude agents`, `--bg`, /background, the on-demand daemon). ...
 * Equivalent to CLAUDE_CODE_DISABLE_AGENT_VIEW=1." The CLI checks the env var first, then the
 * setting.
 *
 * The hive sets both for every Claude agent: the env var in the spawn env, and disableAgentView
 * in the per-agent settings file. Other providers are untouched. HOME is redirected and
 * asserted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentview-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
assert.equal(os.homedir(), FAKE_HOME, 'HOME redirect failed - aborting before touching ~/.claude');
test.after(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { buildPtyEnv } = loadTs('src/main/ptyEnv.ts');

async function hiveWith(t) {
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const hive = new HiveManager(() => harness);
  t.after(() => hive.dispose());
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: FAKE_HOME, isGod: true });
  return hive;
}

function settingsFileIn(args) {
  const i = args.indexOf('--settings');
  assert.ok(i >= 0, 'a Claude agent is spawned with its own --settings file');
  return JSON.parse(fs.readFileSync(args[i + 1], 'utf8'));
}

test('every Claude agent spawns with CLAUDE_CODE_DISABLE_AGENT_VIEW=1 and disableAgentView in its settings', async (t) => {
  const hive = await hiveWith(t);
  for (const meta of [
    { id: 'jim-mtujpe28', name: 'Jim', provider: 'claude', cwd: FAKE_HOME },
    { id: 'andy-mtuk4y4x', name: 'Andy', provider: 'claude', cwd: FAKE_HOME },
    { id: 'legacy-1', name: 'Legacy', cwd: FAKE_HOME } // no provider = a legacy Claude agent
  ]) {
    const inj = await hive.ensureAgent(meta);
    assert.equal(inj.env.CLAUDE_CODE_DISABLE_AGENT_VIEW, '1', meta.id);
    assert.equal(settingsFileIn(inj.args).disableAgentView, true, meta.id);
  }
});

test('the switch survives the PTY env layering (the inherited CLAUDE_* strip applies to the parent env only)', async (t) => {
  const hive = await hiveWith(t);
  const inj = await hive.ensureAgent({ id: 'jim-mtujpe28', name: 'Jim', provider: 'claude', cwd: FAKE_HOME });
  const env = buildPtyEnv({ CLAUDE_CODE_DISABLE_AGENT_VIEW: '0', CLAUDE_CODE_SESSION_ID: 'parent' }, '/usr/bin', inj.env, 'linux');
  assert.equal(env.CLAUDE_CODE_DISABLE_AGENT_VIEW, '1', 'the agent\'s value wins over anything inherited');
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
});

test('non-Claude agents are untouched', async (t) => {
  const hive = await hiveWith(t);
  const inj = await hive.ensureAgent({ id: 'oscar-1', name: 'Oscar', provider: 'codex', cwd: FAKE_HOME });
  assert.equal(inj.env.CLAUDE_CODE_DISABLE_AGENT_VIEW, undefined);
});
