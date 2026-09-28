'use strict';

/**
 * START-FIXES-163 (1) — phantom resume key. One of the three fixes the Human approved from Jim's WHY-162.
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

// ── (1) phantom resume key ──────────────────────────────────────────────────────────────

test('(1) the real resume key is KEPT against a phantom OTel sample id (no transcript)', (t) => {
  const home = sandboxHome(t);
  const cwd = path.join(home, 'proj');
  claudeProject(cwd, { 'real-071b012e': 5 });
  assert.equal(T.shouldRecordSampleSession('real-071b012e', 'phantom-6e7277b5', cwd), false, 'phantom must not replace the real key');
  assert.equal(T.shouldRecordSampleSession('real-071b012e', 'real-071b012e', cwd), false, 'unchanged: no write');
  assert.equal(T.shouldRecordSampleSession(undefined, 'phantom-6e7277b5', cwd), true, 'an EMPTY key still takes the sample (the only source)');
  claudeProject(cwd, { 'next-session': 1 });
  assert.equal(T.shouldRecordSampleSession('real-071b012e', 'next-session', cwd), true, 'a sample id WITH a transcript may replace it');
  assert.equal(T.shouldRecordSampleSession('real', '../../x', cwd), false, 'path-unsafe ids never pass');
});

test('(1) phantom last key + real previous -> resumes the PREVIOUS, and a miss is reported', (t) => {
  const home = sandboxHome(t);
  const cwd = path.join(home, 'proj');
  claudeProject(cwd, { 'real-prev': 5 });
  const seed = (sid) => T.seedSessionTranscript(cwd, sid);
  assert.deepEqual(T.chooseResumeSession('phantom-last', 'real-prev', seed), { sessionId: 'real-prev', miss: true, outcome: 'resumed-previous' });
  assert.deepEqual(T.chooseResumeSession('phantom-last', 'phantom-older', seed), { miss: true, outcome: 'fresh' });
  assert.deepEqual(T.chooseResumeSession('phantom-last', undefined, seed), { miss: true, outcome: 'fresh' });
  assert.deepEqual(T.chooseResumeSession('real-prev', 'whatever', seed), { sessionId: 'real-prev', miss: false }, 'a good last key is used as before');
  assert.deepEqual(T.chooseResumeSession(undefined, 'real-prev', seed), { miss: false }, 'no key = fresh, not a miss');
});

test('(1) the registry keeps the id a new session replaced (previousSessionId)', async (t) => {
  const home = sandboxHome(t);
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  hive.recordSession('god', 'real-1');
  assert.equal(hive.lastSession('god'), 'real-1');
  assert.equal(hive.previousSession('god'), undefined);
  hive.recordSession('god', 'real-2');
  assert.equal(hive.lastSession('god'), 'real-2');
  assert.equal(hive.previousSession('god'), 'real-1');
  hive.recordSession('god', 'real-2');
  assert.equal(hive.previousSession('god'), 'real-1', 'an unchanged id does not shift the history');
  hive.dispose(); // before the sandbox is removed
});

test('(1) wiring: the beat gates the sample id; the spawn resumes the previous id and logs resume-miss', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /if \(sample\?\.sessionId && shouldRecordSampleSession\(hive\.lastSession\(id\), sample\.sessionId, reg\.agents\[id\]\?\.cwd\)\) \{\s*hive\.recordSession\(id, sample\.sessionId, 'sample'\);/);
  assert.doesNotMatch(src, /if \(sample\?\.sessionId\) hive\.recordSession\(id, sample\.sessionId\);/, 'the ungated copy is gone');
  assert.match(src, /chooseResumeSession\(sid, previous, \(s\) => seedSessionTranscript\(cwd, s\), foreign\)/);
  assert.match(src, /kind: 'resume-miss', agentId: opts\.hive\.id, missing: sid, previous: previous \?\? null, outcome: pick\.outcome/);
});

