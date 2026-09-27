'use strict';
/**
 * CODEX-BLOAT-165 fix 4: a shorter wake nudge (every nudge is a user turn that Codex compaction
 * keeps), and a bounded Stop-drain text (each body capped, with a pointer to the full file).
 *
 * HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { inboxNudgeText, isInboxNudge, INBOX_NUDGE_FIXED_CHARS } = loadTs('src/shared/hiveNudge.ts');
const { HiveManager, drainLines, DRAIN_BODY_MAX_CHARS, DRAIN_TOTAL_MAX_CHARS } = loadTs('src/main/hive.ts');

test('the nudge is short: the fixed text is at most 160 chars (was ~414), ASCII, and still a nudge', () => {
  assert.ok(INBOX_NUDGE_FIXED_CHARS <= 160, `fixed ${INBOX_NUDGE_FIXED_CHARS}`);
  const t = inboxNudgeText(['2026-09-27T10-29-35-315Z-god-dwight-canary5']);
  assert.match(t, /^[\x20-\x7e]+$/);
  assert.ok(isInboxNudge(t));
  assert.match(t, /authoritative/);
  assert.match(t, /inbox\/\.done\//);
  assert.match(t, / - at least: 2026-09-27T10-29-35-315Z-god-dwight-canary5\. Read your inbox/);
});

test('drain caps: exported constants', () => {
  assert.equal(DRAIN_BODY_MAX_CHARS, 2000);
  assert.equal(DRAIN_TOTAL_MAX_CHARS, 8000);
});

const msg = (id, body) => ({ id, from: 'god', act: 'request', subject: `s-${id}`, body });

test('drainLines: a short body is passed whole', () => {
  assert.equal(drainLines([msg('a', 'hello')], 'INBOX'), '- [from god, request] s-a: hello');
});

test('drainLines: a long body is cut at 2,000 chars with a pointer to its file', () => {
  const inbox = path.join('C:', 'hive', 'agents', 'x', 'inbox');
  const out = drainLines([msg('m1', 'y'.repeat(50_000))], inbox);
  assert.ok(out.length < DRAIN_BODY_MAX_CHARS + 300, `len ${out.length}`);
  assert.ok(out.endsWith(`...(truncated; full message at ${path.join(inbox, 'm1.json')})`));
});

test('drainLines: past the total cap, later messages are listed by subject and file only', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, 'z'.repeat(3000)));
  const out = drainLines(msgs, 'INBOX');
  assert.ok(out.length < DRAIN_TOTAL_MAX_CHARS + DRAIN_BODY_MAX_CHARS + 1000, `len ${out.length}`);
  const lines = out.split('\n');
  assert.equal(lines.length, 10, 'every message is still named');
  assert.match(lines[9], /s-m9 \(body not shown; full message at INBOX.m9\.json\)$/);
});

test('drainForStop uses the capped lines (real hive, HOME redirected)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-drain-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  hive.send({ id: 'big-1', to: 'jim-1', act: 'request', subject: 'huge', body: 'q'.repeat(40_000) }, 'god');
  const { block, reason } = hive.drainForStop('jim-1');
  assert.equal(block, true);
  assert.ok(reason.length < 3000, `reason ${reason.length}`);
  assert.match(reason, /truncated; full message at .*big-1\.json/);
});
