'use strict';

/**
 * SESSION-PROMPT-ROTATION (1.1.76). A resumed Claude session keeps the system prompt it was
 * started with (1.1.75 real run #3, B4), so a prompt change at an upgrade never reached a
 * running agent, and 1.1.75 needed a hand-run registry clear (fresh-start-175.cjs).
 *
 * The fix, pinned here:
 * - each session is stamped with the fingerprint of the prompt its process was spawned with;
 * - an AUTOMATIC resume of a session with another stamp, or none, starts fresh (logged
 *   `session-rotate`), for the last key and for the previous-key fallback alike;
 * - a resume the human asks for by id is honoured (logged `session-resume-stale`);
 * - "Start fresh" (UI) drops the resume key through the main process, and a late hook from
 *   the old process cannot bring it back.
 *
 * HOME is redirected and asserted before anything touches ~/.claude.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-rot-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
assert.equal(os.homedir(), FAKE_HOME, 'HOME redirect failed - aborting before touching ~/.claude');
test.after(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const loadTs = require('./load-ts.cjs');
const R = loadTs('src/main/sessionRotation.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const OLD = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW = 'bbbbbbbb-0000-4000-8000-000000000002';
const CLR = 'cccccccc-0000-4000-8000-000000000003';

test('promptFingerprint hashes exactly the --append-system-prompt value', () => {
  assert.equal(R.promptFingerprint(['--model', 'x']), null);
  assert.equal(R.promptFingerprint(['--append-system-prompt']), null);
  const a = R.promptFingerprint(['--x', '--append-system-prompt', 'PROMPT v1', '--model', 'm']);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(R.promptFingerprint(['--append-system-prompt', 'PROMPT v1']), a, 'other args do not count');
  assert.notEqual(R.promptFingerprint(['--append-system-prompt', 'PROMPT v2']), a, 'a prompt change changes it');
});

test('staleReason: changed, unrecorded, equal, and nothing to compare', () => {
  assert.equal(R.staleReason('f1', 'f2'), 'prompt-changed');
  assert.equal(R.staleReason(undefined, 'f2'), 'prompt-unrecorded');
  assert.equal(R.staleReason('f2', 'f2'), null);
  assert.equal(R.staleReason(undefined, null), null);
  assert.equal(R.staleReason('f1', null), null);
});

test('withSessionStamp keeps the newest SESSION_PROMPT_CAP stamps, newest last', () => {
  let m;
  for (let i = 0; i < R.SESSION_PROMPT_CAP + 3; i++) m = R.withSessionStamp(m, `s${i}`, `f${i}`);
  const keys = Object.keys(m);
  assert.equal(keys.length, R.SESSION_PROMPT_CAP);
  assert.equal(keys[keys.length - 1], `s${R.SESSION_PROMPT_CAP + 2}`);
  assert.equal(keys[0], 's3');
  m = R.withSessionStamp(m, 's3', 'fx');
  assert.equal(Object.keys(m).pop(), 's3', 're-stamping moves a session to newest');
  assert.equal(m.s3, 'fx');
});

async function oneAgent(t) {
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const cwd = fs.mkdtempSync(path.join(FAKE_HOME, 'cwd-'));
  const hive = new HiveManager(() => harness);
  await hive.ensureAgent({ id: 'jim', name: 'Jim', provider: 'claude', cwd });
  t.after(() => hive.dispose());
  const reg = () => JSON.parse(fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8')).agents.jim;
  const log = () => fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { hive, reg, log };
}

test('a fresh process stamps the session its hook reports; a sample never stamps', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-new', null);
  hive.recordSession('jim', NEW, 'sample');
  assert.equal(reg().sessionPrompts, undefined, 'sample path: no stamp');
  hive.recordSession('jim', NEW, 'hook');
  assert.deepEqual(reg().sessionPrompts, { [NEW]: 'fp-new' });
  assert.equal(hive.sessionPromptStamp('jim', NEW), 'fp-new');
  // A /clear inside the same process opens a new id: it has this process's prompt too.
  hive.recordSession('jim', CLR, 'hook');
  assert.equal(reg().sessionPrompts[CLR], 'fp-new');
  assert.equal(reg().sessionId, CLR);
});

test('a resumed process never stamps the session it resumed (it keeps its old prompt)', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-v1', null);
  hive.recordSession('jim', OLD, 'hook');
  // Upgrade: the human resumes OLD by id under a new prompt.
  hive.noteSpawnPrompt('jim', 'fp-v2', OLD);
  hive.recordSession('jim', OLD, 'hook');
  assert.equal(reg().sessionPrompts[OLD], 'fp-v1', 'the resumed session keeps its original stamp');
  // A session it then opens (/clear) runs on the new prompt.
  hive.recordSession('jim', CLR, 'hook');
  assert.equal(reg().sessionPrompts[CLR], 'fp-v2');
});

test('a legacy (pre-1.1.76, unstamped) session resumed by id is not stamped with the new prompt', async (t) => {
  const { hive, reg } = await oneAgent(t);
  hive.recordSession('jim', OLD, 'hook'); // recorded by 1.1.75: no spawn note, no stamp
  assert.equal(hive.sessionPromptStamp('jim', OLD), undefined);
  hive.noteSpawnPrompt('jim', 'fp-v2', OLD); // Restart & Continue on 1.1.76
  hive.recordSession('jim', OLD, 'hook');
  assert.equal(hive.sessionPromptStamp('jim', OLD), undefined, 'still unrecorded, so the next automatic resume rotates it');
});

test('clearSession drops the resume key, keeps ownership, and a late old hook cannot restore it', async (t) => {
  const { hive, reg, log } = await oneAgent(t);
  hive.noteSpawnPrompt('jim', 'fp-v1', null);
  hive.recordSession('jim', OLD, 'hook');
  hive.recordSession('jim', NEW, 'hook');
  assert.equal(reg().previousSessionId, OLD);
  const r = hive.clearSession('jim', 'start-fresh');
  assert.deepEqual(r, { ok: true, cleared: [NEW, OLD] });
  const a = reg();
  assert.equal(a.sessionId, undefined);
  assert.equal(a.previousSessionId, undefined);
  assert.equal(a.sessionSource, undefined);
  assert.deepEqual(a.hookSessionIds, [OLD, NEW], 'ownership kept');
  assert.equal(hive.lastSession('jim'), undefined);
  hive.recordSession('jim', NEW, 'hook'); // straggler from the killed process
  hive.recordSession('jim', OLD, 'sample');
  assert.equal(reg().sessionId, undefined, 'a retired id never comes back as the resume key');
  hive.noteSpawnPrompt('jim', 'fp-v2', null);
  hive.recordSession('jim', CLR, 'hook'); // the fresh process
  assert.equal(reg().sessionId, CLR);
  assert.equal(reg().previousSessionId, undefined, 'no fallback to the cleared conversation');
  assert.equal(reg().sessionPrompts[CLR], 'fp-v2');
  const row = log().find((e) => e.kind === 'session-fresh');
  assert.deepEqual({ agentId: row.agentId, reason: row.reason, cleared: row.cleared }, { agentId: 'jim', reason: 'start-fresh', cleared: [NEW, OLD] });
  assert.equal(hive.clearSession('nobody', 'start-fresh').ok, false, 'unknown agent refused');
});

test('main: an automatic resume rotates a stale session; the fallback obeys the same check; a typed id is honoured', () => {
  const src = read('src/main/index.ts');
  const block = src.slice(src.indexOf('const explicitSid = typeof opts.resumeSessionId'), src.indexOf('opts.args = args;', src.indexOf('const explicitSid = typeof opts.resumeSessionId')));
  assert.ok(block.length > 0);
  assert.match(block, /const promptFp = promptFingerprint\(args\);/, 'the fingerprint is taken from the args actually passed');
  assert.ok(block.indexOf('const promptFp') > block.indexOf('const explicitSid'));
  assert.match(block, /if \(sid && !explicitSid\) \{\s*const why = staleFor\(sid\);\s*if \(why\) \{[\s\S]*?kind: 'session-rotate'[\s\S]*?sid = undefined;/, 'automatic resume of a stale session starts fresh');
  assert.match(block, /else if \(sid && explicitSid && staleFor\(sid\)\) \{\s*hive\.appendLog\(\{ kind: 'session-resume-stale'/, 'a typed id is resumed, and logged');
  assert.match(block, /chooseResumeSession\(sid, previous, seedFresh, foreign\)/, 'the previous-key fallback uses the stale-aware seed');
  assert.match(block, /if \(staleFor\(s\)\) \{ rotated\.push\(s\); return false; \}/);
  assert.match(block, /hive\.noteSpawnPrompt\(opts\.hive\.id, promptFp, resumedSid\);/);
  assert.match(block, /let resumedSid: string \| null = null;/, 'fresh unless a resume is attached');
  assert.equal((block.match(/\n\s*resumedSid = (sid|pick\.sessionId);/g) || []).length, 2, 'set on both resume paths');
  // The rotation check runs before anything is attached, i.e. before `--resume`.
  assert.ok(block.indexOf("kind: 'session-rotate'") < block.indexOf("args.push('--resume'"));
});

test('main: Start fresh clears the key before the resume blocks and refuses a required resume', () => {
  const src = read('src/main/index.ts');
  const at = src.indexOf('if (opts.startFresh === true && opts.hive)');
  assert.ok(at > 0);
  assert.ok(at < src.indexOf('const explicitSid = typeof opts.resumeSessionId'), 'before the Claude resume block');
  assert.ok(at < src.indexOf('const typedSid = typeof opts.resumeSessionId'), 'before the generic resume block');
  const seg = src.slice(at, at + 700);
  assert.match(seg, /opts\.requireResume === true\) return \{ ok: false/);
  assert.match(seg, /hive\.clearSession\(opts\.hive\.id, 'start-fresh'\)/);
  assert.match(seg, /if \(!cleared\.ok\) return \{ ok: false/, 'a failed clear blocks the spawn instead of resuming');
  assert.match(seg, /opts\.resume = false;\s*opts\.resumeSessionId = undefined;/);
});

test('UI: a Start fresh button per agent (workers and god) spawns with startFresh and never resumes', () => {
  const ui = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.equal((ui.match(/<StartFreshButton agent=\{a\} disabled=\{restarting === a\.id\} onStart=\{\(\) => restartWithModel\(a, a\.model, \{ startFresh: true \}\)\} \/>/g) || []).length, 2);
  assert.match(ui, /let resume = opts\.resume === true && provider === previousProvider && opts\.startFresh !== true;/);
  assert.match(ui, /\.\.\.\(opts\.startFresh === true \? \{ startFresh: true \} : \{\}\)/);
  assert.match(ui, /function StartFreshButton[\s\S]*?window\.confirm\(/, 'asks before ending a conversation');
  assert.match(read('src/preload/index.ts'), /startFresh\?: boolean;/);
});
