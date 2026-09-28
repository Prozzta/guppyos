'use strict';

/**
 * Regression for the 2026-08-15 webhook-card loss: ASK ME had read an eight-card
 * ledger, the webhook appended card nine, then ASK ME overwrote tasks.json with
 * its stale eight-card snapshot while recording an answer. Renderer actions must
 * mutate one card against the latest main-process ledger instead of replacing the
 * whole collection they happened to read earlier.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-task-mutate-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return hive;
}

function card(id, extra = {}) {
  return {
    id,
    title: id,
    status: 'todo',
    dependsOn: [],
    priority: 3,
    createdAt: '2026-08-15T08:00:00.000Z',
    ...extra
  };
}

function tasks(hive) {
  return hive.tasks().tasks;
}

test('patching a stale UI card preserves a concurrently appended webhook card', (t) => {
  const hive = floor(t);
  const question = card('needs-human', {
    status: 'blocked',
    humanQA: [{ q: 'Which option?', askedAt: '2026-08-15T08:00:00.000Z' }]
  });
  hive.writeTasks([question]);

  // The renderer still holds this one-card snapshot when the webhook arrives.
  const staleQuestion = structuredClone(tasks(hive)[0]);
  const webhook = card('webhook-1', {
    webhook: { tokenHash: 'a'.repeat(64) }
  });
  assert.equal(hive.addTask(webhook), true);

  staleQuestion.humanQA[0].a = 'Option B';
  staleQuestion.humanQA[0].answeredAt = '2026-08-15T08:00:01.000Z';
  assert.equal(hive.patchTask(staleQuestion.id, { humanQA: staleQuestion.humanQA }), true);

  assert.deepEqual(tasks(hive).map((task) => task.id), ['needs-human', 'webhook-1']);
  assert.equal(tasks(hive)[0].humanQA[0].a, 'Option B');
  assert.equal(tasks(hive)[1].webhook.tokenHash, 'a'.repeat(64));
});

test('atomic add is idempotent and delete removes only the named card', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]);

  assert.equal(hive.addTask(card('new')), true);
  assert.equal(hive.addTask(card('new', { title: 'duplicate' })), false);
  assert.equal(hive.deleteTask('existing'), true);
  assert.equal(hive.deleteTask('missing'), false);

  assert.deepEqual(tasks(hive).map((task) => task.id), ['new']);
  assert.equal(tasks(hive)[0].title, 'new');
});

test('patch refuses an unknown card without rewriting the ledger', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]);

  assert.equal(hive.patchTask('missing', { status: 'done' }), false);
  assert.deepEqual(tasks(hive), [card('existing')]);
});

test('malformed tasks.json is quarantined and addTask refuses to overwrite it', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]);
  const file = path.join(hive.root(), 'tasks.json');
  const corrupt = '{"tasks":["half-written"';
  fs.writeFileSync(file, corrupt, 'utf8');

  assert.throws(() => hive.addTask(card('new')), /tasks\.json is invalid JSON; refusing to overwrite it/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt, 'the bad authority file remains untouched for repair');
  const copies = fs.readdirSync(hive.root()).filter((name) => name.startsWith('tasks.json.corrupt-'));
  assert.equal(copies.length, 1, 'one byte-identical copy is quarantined');
  assert.equal(fs.readFileSync(path.join(hive.root(), copies[0]), 'utf8'), corrupt);
  assert.match(fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8'), /"kind":"hive-authority-corrupt"/,
    'the operator gets a durable, loud integrity event');
});

test('malformed registry.json keeps read-only views alive but refuses every mutation', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('existing')]); // bootstraps the authoritative hive files
  const file = path.join(hive.root(), 'registry.json');
  const corrupt = '{"agents":';
  fs.writeFileSync(file, corrupt, 'utf8');

  assert.deepEqual(hive.registry(), { godId: null, agents: {} }, 'read-only consumers receive safe defaults');
  assert.match(hive.integrityIssues()[0].quarantine, /^registry\.json\.corrupt-/);
  assert.match(hive.setAgentHold('nobody', true).error, /registry\.json is invalid JSON; refusing to overwrite it/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  const copies = fs.readdirSync(hive.root()).filter((name) => name.startsWith('registry.json.corrupt-'));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(hive.root(), copies[0]), 'utf8'), corrupt);
});

test('missing authorities bootstrap with defaults, while a corrupt cursor refuses its write', (t) => {
  const hive = floor(t);
  hive.ensureHive();
  const root = hive.root();
  fs.rmSync(path.join(root, 'registry.json'));
  fs.rmSync(path.join(root, 'tasks.json'));
  assert.deepEqual(hive.registry(), { godId: null, agents: {} });
  assert.deepEqual(hive.tasks(), { tasks: [] });
  assert.equal(hive.addTask(card('first')), true, 'missing tasks.json may be freshly created');

  const agent = path.join(root, 'agents', 'probe');
  fs.mkdirSync(path.join(agent, 'inbox', '.done'), { recursive: true });
  fs.writeFileSync(path.join(agent, 'cursor.json'), '{"lastProcessed":', 'utf8');
  assert.throws(() => hive.drainForStop('probe'), /cursor\.json is invalid JSON; refusing to overwrite it/);
});

test('Windows rename retries publish after transient locks and leave no temp file', (t) => {
  const hive = floor(t);
  hive.writeTasks([card('old')]);
  const file = path.join(hive.root(), 'tasks.json');
  const renameSync = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (...args) => {
    attempts++;
    if (attempts < 3) {
      const error = new Error('simulated Windows sharing violation');
      error.code = 'EPERM';
      throw error;
    }
    return renameSync(...args);
  };
  try {
    hive.writeTasks([card('new')]);
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.map((task) => task.id), ['new']);
  assert.equal(fs.readdirSync(hive.root()).some((name) => name.startsWith('tasks.json.tmp-')), false);
});

test('renderer task actions never send a whole stale ledger back to main', () => {
  const root = path.resolve(__dirname, '..');
  const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const sources = [
    'src/renderer/src/components/AskMeTab.tsx',
    'src/renderer/src/components/TaskDetailOverlay.tsx',
    'src/renderer/src/components/TasksKanban.tsx',
    'src/renderer/src/hooks/useHive.ts'
  ].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));

  for (const source of sources) {
    assert.doesNotMatch(source, /hiveWriteTasks\s*\(/,
      'renderer code must use atomic task IPC rather than overwrite tasks.json');
  }
  assert.doesNotMatch(preload, /hiveWriteTasks\s*:/,
    'the renderer bridge must not expose the unsafe whole-ledger write primitive');
  assert.doesNotMatch(main, /ipcMain\.handle\('hive:writeTasks'/,
    'main must not accept whole-ledger writes from a stale renderer');
  assert.match(sources[0], /hivePatchTask\s*\(/);
  assert.match(sources[1], /hivePatchTask\s*\(/);
  assert.match(sources[2], /hiveDeleteTask\s*\(/);
  assert.match(sources[3], /hiveAddTask\s*\(/);
});

test('webhook dispatch appends via atomic addTask, not a stale whole-ledger rewrite', () => {
  const root = path.resolve(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  const fn = main.slice(main.indexOf('function dispatchWebhookWork'),
    main.indexOf('function handleWebhookMessage'));
  // The card must be appended through hive.addTask(card) — which reads the LATEST
  // on-disk ledger and is idempotent by task id — never through a re-read of a
  // snapshot the caller happened to hold, which would overwrite a concurrently
  // added card (the 2026-08-15 regression this suite guards).
  assert.match(fn, /hive\.addTask\s*\(card\)/,
    'dispatchWebhookWork must add the card via the atomic addTask');
  assert.doesNotMatch(fn, /writeTasks\s*\(\[\s*\.\.\.existing/,
    'dispatchWebhookWork must not rebuild a stale whole-ledger snapshot');
});
