'use strict';

/** Route A keeps a fixed, useful user sentinel and moves changing inbox facts to
 * the UserPromptSubmit hook's transient developer context.
 *
 * ZT-I1-MAIL 1.1.75 (slice 2): that developer context is now the <hive-mail> block with the
 * message BODIES from the ledger's delivered ids (§2.2 Codex row), replacing the <hive-inbox-wake>
 * id list and its "read the inbox, move handled files" instruction (P5). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { CODEX_INBOX_WAKE_SENTINEL, inboxNudgeText, inboxWakeTextForProvider, isInboxNudge } = loadTs('src/shared/hiveNudge.ts');

test('Route A gives Codex one fixed, meaningful, queue-recognised sentinel and preserves other providers\' legacy nudge', () => {
  assert.ok(CODEX_INBOX_WAKE_SENTINEL.length >= 4);
  assert.equal(inboxWakeTextForProvider('codex', ['dynamic-id']), CODEX_INBOX_WAKE_SENTINEL);
  assert.match(CODEX_INBOX_WAKE_SENTINEL, /inbox/i, 'it remains meaningful if the hook fails');
  assert.equal(isInboxNudge(CODEX_INBOX_WAKE_SENTINEL), true, 'the one-pending queue rule still applies');
  assert.equal(inboxWakeTextForProvider('claude', ['dynamic-id']), inboxNudgeText(['dynamic-id']));
});

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-route-a-'));
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.CODEX_HOME = path.join(home, '.codex'); process.env.GEMINI_CLI_HOME = home;
  assert.equal(os.homedir(), home, 'HOME must be jailed before HiveManager construction');
  const hive = new HiveManager(() => home);
  t.after(() => {
    hive.dispose();
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'codex-1', name: 'Dwight', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'claude-1', name: 'Jim', provider: 'claude', cwd: home });
  const reg = hive.registry.bind(hive);
  hive.registry = () => { const r = reg(); r.agents['codex-1'] = { ...r.agents['codex-1'], provider: 'codex' }; return r; };
  const server = new HookServer(hive, () => null, () => ({ notifications: false }));
  return { hive, server };
}

test('Route A: a Codex sentinel wake carries the <hive-mail> block (bodies, from the ledger) in place of the <hive-inbox-wake> id list; the epoch is Codex\'s turn_id', async (t) => {
  const { hive, server } = await floor(t);
  const first = hive.send({ to: 'codex-1', act: 'request', subject: 'first', body: 'the first body' }, 'god-1');
  const r = server.handle({ hook_event_name: 'UserPromptSubmit', agent_id: 'codex-1', prompt: CODEX_INBOX_WAKE_SENTINEL, turn_id: 'turn-1', transport: 'pipe' });
  assert.equal(r.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const c = r.hookSpecificOutput.additionalContext;
  assert.ok(c.includes(`[hive-mail:${first.id}]`) && c.includes('the first body'), c);
  assert.ok(!c.includes('<hive-inbox-wake>') && !c.includes('Current unread inbox file ids'), 'the id list is gone');
  assert.ok(!/move handled files/.test(c), 'no move instruction in the block');
  assert.ok(!c.includes('You have new hive inbox message'), 'the retained legacy nudge never enters developer context');
  const e = hive.mail.ledger('codex-1').entries[first.id];
  assert.deepEqual({ state: e.state, epoch: e.epoch, hookKind: e.hookKind }, { state: 'surfacing', epoch: 'turn-1', hookKind: 'UserPromptSubmit' });
  const claims = server.takeMailClaims();
  assert.equal(claims.length, 1);
  assert.equal(claims[0].evidence, 'codex-rollout', 'Codex is confirmed from its rollout, not by latency');

  // turn-1 ends normally (its surfacing confirmed): the mail is acted.
  hive.mail.confirmSurfaced('codex-1', [first.id], 'turn-1', 'evidence');
  server.handle({ hook_event_name: 'Stop', agent_id: 'codex-1', turn_id: 'turn-1', transport: 'pipe' });
  assert.equal(hive.mail.ledger('codex-1').entries[first.id].state, 'acted');
  // A later sentinel wake with nothing new: a short note, never a stale list, and (Q12) a
  // `mail-empty-wake` row, since the coordinator woke the agent for nothing.
  const again = server.handle({ hook_event_name: 'UserPromptSubmit', agent_id: 'codex-1', prompt: CODEX_INBOX_WAKE_SENTINEL, turn_id: 'turn-2', transport: 'pipe' });
  assert.equal(again.hookSpecificOutput.additionalContext, '<hive-mail>\nNo new hive mail to show for this wake.\n</hive-mail>');
  const empty = hive.logTail(200).filter((r) => r.kind === 'mail-empty-wake');
  assert.deepEqual(empty.map((r) => [r.agentId, r.epoch]), [['codex-1', 'turn-2']]);

  // New mail mid-turn reaches Codex on its PostToolUse (mcp), in the same epoch.
  const second = hive.send({ to: 'codex-1', act: 'inform', subject: 'second', body: 'the second body' }, 'god-1');
  const post = server.handle({ hook_event_name: 'PostToolUse', agent_id: 'codex-1', turn_id: 'turn-2', transport: 'mcp' });
  assert.ok(post.hookSpecificOutput.additionalContext.includes(`[hive-mail:${second.id}]`));
  assert.equal(hive.mail.ledger('codex-1').entries[second.id].epoch, 'turn-2');

  // Claude never receives the Codex-only note; a PostToolUse with nothing pending is untouched.
  assert.deepEqual(server.handle({ hook_event_name: 'UserPromptSubmit', agent_id: 'claude-1', prompt: CODEX_INBOX_WAKE_SENTINEL }), {}, 'Claude never receives the Codex-only note');
  assert.deepEqual(server.handle({ hook_event_name: 'PostToolUse', agent_id: 'codex-1', turn_id: 'turn-2', prompt: CODEX_INBOX_WAKE_SENTINEL }), {}, 'nothing pending: nothing injected');
});
