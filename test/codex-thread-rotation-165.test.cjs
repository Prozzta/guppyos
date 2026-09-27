'use strict';
/**
 * CODEX-BLOAT-165 fix 1: an automatic Codex (and Antigravity) resume rotates to a fresh thread
 * when the recorded one started before today's local midnight or has grown past the size cap.
 * A typed session id and "Restart & Continue" (requireResume) still resume.
 *
 * Pure decisions are tested directly; the files live in a temp dir (no HOME is touched: nothing
 * here constructs a hive or reads homedir()). The spawn wiring in index.ts is pinned by source.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const R = loadTs('src/main/codexThreadRotation.ts');
const HOUR = 3_600_000;

test('the thresholds are exported constants: 20 MB for a Codex rollout and for an AGY db', () => {
  assert.equal(R.CODEX_ROTATE_MAX_ROLLOUT_BYTES, 20 * 1024 * 1024);
  assert.equal(R.AGY_ROTATE_MAX_DB_BYTES, 20 * 1024 * 1024);
});

test('the rollout file name is read as LOCAL time (Codex stamps it locally)', () => {
  const t = R.rolloutStartFromName('rollout-2026-09-15T21-45-10-01a0a69a-1460-7fd0-87d9-06b8d76701ec.jsonl');
  assert.equal(t, new Date(2026, 8, 15, 21, 45, 10).getTime());
  assert.equal(R.rolloutStartFromName('not-a-rollout.jsonl'), null);
});

test('localDayStart is local midnight of the same day', () => {
  const now = new Date(2026, 8, 27, 0, 5, 0).getTime();
  assert.equal(R.localDayStart(now), new Date(2026, 8, 27).getTime());
});

test('decide: a thread started today and under the cap is RESUMED', () => {
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const d = R.decideThreadRotation({ path: 'x', bytes: 5 * 1024 * 1024, startedAt: now - 3 * HOUR }, now);
  assert.deepEqual(d, { rotate: false, reason: null, bytes: 5 * 1024 * 1024, ageMs: 3 * HOUR });
});

test('decide: a thread that started before local midnight ROTATES (day-boundary), even a small one a few minutes old', () => {
  const now = new Date(2026, 8, 27, 0, 10, 0).getTime();
  const started = new Date(2026, 8, 26, 23, 55, 0).getTime();
  const d = R.decideThreadRotation({ path: 'x', bytes: 1000, startedAt: started }, now);
  assert.equal(d.rotate, true);
  assert.equal(d.reason, 'day-boundary');
  assert.equal(d.ageMs, 15 * 60_000);
});

test('decide: a rollout above the cap ROTATES (size) even when it started today; exactly at the cap does not', () => {
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const cap = R.CODEX_ROTATE_MAX_ROLLOUT_BYTES;
  assert.equal(R.decideThreadRotation({ path: 'x', bytes: cap + 1, startedAt: now - HOUR }, now).reason, 'size');
  assert.equal(R.decideThreadRotation({ path: 'x', bytes: cap, startedAt: now - HOUR }, now).rotate, false);
  // a custom cap is honoured
  assert.equal(R.decideThreadRotation({ path: 'x', bytes: 11, startedAt: now - HOUR }, now, 10).reason, 'size');
});

test('findCodexRollout walks <home>/sessions/YYYY/MM/DD and returns path, size and the name-stamped start', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-rot-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sid = '01a0a69a-1460-7fd0-87d9-06b8d76701ec';
  const dir = path.join(home, 'sessions', '2026', '09', '15');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-2026-09-15T21-45-10-other-0000-0000-0000.jsonl'), 'x');
  const file = path.join(dir, `rollout-2026-09-15T21-45-10-${sid}.jsonl`);
  fs.writeFileSync(file, 'a'.repeat(1234));
  const info = R.findCodexRollout(home, sid);
  assert.equal(info.path, file);
  assert.equal(info.bytes, 1234);
  assert.equal(info.startedAt, new Date(2026, 8, 15, 21, 45, 10).getTime());
  assert.equal(R.findCodexRollout(home, '11111111-2222-3333-4444-555555555555'), null, 'absent id');
  assert.equal(R.findCodexRollout(home, '../evil'), null, 'not an id');
  assert.equal(R.findCodexRollout(path.join(home, 'nope'), sid), null, 'no sessions dir');
});

test('findAgyConversation stats <gemini>/antigravity-cli/conversations/<id>.db', (t) => {
  const gem = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-agy-'));
  t.after(() => fs.rmSync(gem, { recursive: true, force: true }));
  const id = '11eea414-0000-4000-8000-000000000000';
  const dir = path.join(gem, 'antigravity-cli', 'conversations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.db`), Buffer.alloc(4096));
  const info = R.findAgyConversation(gem, id);
  assert.equal(info.bytes, 4096);
  assert.ok(info.startedAt > Date.now() - 60_000, 'birth time of the file');
  assert.equal(R.findAgyConversation(gem, 'ffffffff-0000-4000-8000-000000000000'), null);
});

test('the log row carries agent id, old sid, reason, size and age', () => {
  const row = R.threadRotatedLogRow('dwight-mu32ztys', 'codex', 'old-sid', { rotate: true, reason: 'size', bytes: 132731252, ageMs: 12.3 * 24 * HOUR });
  assert.deepEqual(row, { kind: 'codex-thread-rotated', agentId: 'dwight-mu32ztys', provider: 'codex', oldSessionId: 'old-sid', reason: 'size', bytes: 132731252, ageHours: 295.2 });
  assert.equal(R.threadRotatedLogRow('p', 'antigravity', 's', { rotate: true, reason: 'day-boundary', bytes: 1, ageMs: 0 }).kind, 'antigravity-thread-rotated');
});

// ── the spawn wiring (index.ts), pinned by source ─────────────────────────────────────────

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');

test('wiring: rotation is gated on an AUTOMATIC resume - never a typed sid, never requireResume', () => {
  assert.match(INDEX, /const mayRotate = !typedSid && opts\.requireResume !== true;/);
  assert.match(INDEX, /\} else if \(mayRotate && rotateCodexThread\(opts\.hive\.id, sid, ownerHome\)\) \{/);
  // the rotate branch sits BEFORE the branch that builds `codex resume <sid>`
  const rot = INDEX.indexOf('mayRotate && rotateCodexThread(');
  const res = INDEX.indexOf('if (args[0] !== rsub) { opts.args = [rsub, sid, ...args]; didResume = true; }');
  assert.ok(rot > 0 && res > rot, 'rotation is decided before the resume args are built');
});

test('wiring: a rotation logs through hive.appendLog, and AGY gets the same rule on --conversation', () => {
  const fn = INDEX.slice(INDEX.indexOf('function rotateCodexThread('), INDEX.indexOf('function findCodexHomeForSession('));
  assert.match(fn, /hive\.appendLog\(threadRotatedLogRow\(agentId, 'codex', sid, d\)\)/);
  assert.match(fn, /decideThreadRotation\(info, Date\.now\(\), CODEX_ROTATE_MAX_ROLLOUT_BYTES\)/);
  assert.match(fn, /catch \(e\) \{[\s\S]*return false;/, 'a failed check keeps resuming');
  assert.match(INDEX, /if \(sid && rf && mayRotate && provider === 'antigravity'\) \{[\s\S]{0,400}AGY_ROTATE_MAX_DB_BYTES[\s\S]{0,300}sid = undefined;/);
});
