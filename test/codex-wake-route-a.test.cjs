'use strict';

/** Route A keeps a fixed, useful user sentinel and moves changing inbox facts to
 * the UserPromptSubmit hook's transient developer context. */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HookServer } = loadTs('src/main/hooks.ts');
const { CODEX_INBOX_WAKE_SENTINEL, inboxNudgeText, inboxWakeTextForProvider, isInboxNudge } = loadTs('src/shared/hiveNudge.ts');

test('Route A gives Codex one fixed, meaningful, queue-recognised sentinel and preserves other providers\' legacy nudge', () => {
  assert.ok(CODEX_INBOX_WAKE_SENTINEL.length >= 4);
  assert.equal(inboxWakeTextForProvider('codex', ['dynamic-id']), CODEX_INBOX_WAKE_SENTINEL);
  assert.match(CODEX_INBOX_WAKE_SENTINEL, /inbox/i, 'it remains meaningful if the hook fails');
  assert.equal(isInboxNudge(CODEX_INBOX_WAKE_SENTINEL), true, 'the one-pending queue rule still applies');
  assert.equal(inboxWakeTextForProvider('claude', ['dynamic-id']), inboxNudgeText(['dynamic-id']));
});

test('Route A injects current inbox ids only for Codex UserPromptSubmit sentinel wakes', () => {
  let files = ['first.json'];
  const hive = {
    sockPath: () => null,
    codexHomeFor: (id) => id === 'codex' ? 'C:/throwaway/codex' : null,
    inboxFileNames: () => files,
    recordSession: () => {},
    registry: () => ({ agents: {} }),
    isGod: () => false
  };
  const server = new HookServer(hive, () => null, () => ({}));
  const first = server.handle({ hook_event_name: 'UserPromptSubmit', agent_id: 'codex', prompt: CODEX_INBOX_WAKE_SENTINEL });
  assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(first.hookSpecificOutput.additionalContext.includes('Current unread inbox file ids: ["first"].'));
  assert.match(first.hookSpecificOutput.additionalContext, /inbox\/.done/);
  assert.ok(!first.hookSpecificOutput.additionalContext.includes('You have new hive inbox message'), 'the retained legacy nudge never enters developer context');

  files = ['second.json', 'first.json'];
  const second = server.handle({ hook_event_name: 'UserPromptSubmit', agent_id: 'codex', prompt: CODEX_INBOX_WAKE_SENTINEL });
  assert.match(second.hookSpecificOutput.additionalContext, /\["first","second"\]/, 'each wake re-reads current ids');

  assert.deepEqual(server.handle({ hook_event_name: 'UserPromptSubmit', agent_id: 'claude', prompt: CODEX_INBOX_WAKE_SENTINEL }), {}, 'Claude never receives the Codex-only injection');
  assert.deepEqual(server.handle({ hook_event_name: 'PostToolUse', agent_id: 'codex', prompt: CODEX_INBOX_WAKE_SENTINEL }), {}, 'only UserPromptSubmit can inject it');
});
