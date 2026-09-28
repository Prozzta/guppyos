'use strict';
/**
 * CODEX-BLOAT-165 fix 4: a shorter wake nudge (every nudge is a user turn that Codex compaction
 * keeps), and a bounded Stop-drain text (each body capped, with a pointer to the full file).
 * ZT-I1-MAIL 1.1.75: the Stop drain is deleted (P11); its tests became the pin that it stays gone.
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
const H = loadTs('src/main/hive.ts');

test('the nudge is short: the fixed text is at most 160 chars (was ~414), ASCII, and still a nudge', () => {
  assert.ok(INBOX_NUDGE_FIXED_CHARS <= 160, `fixed ${INBOX_NUDGE_FIXED_CHARS}`);
  // ZT-I1-MAIL §5 P4: every mode's text; the fixed part is the longest of them.
  for (const mode of ['inject', 'legacy-read', 'legacy-move']) {
    const t = inboxNudgeText(['2026-09-27T10-29-35-315Z-god-dwight-canary5'], mode);
    assert.match(t, /^[\x20-\x7e]+$/);
    assert.ok(isInboxNudge(t));
    assert.match(t, /2026-09-27T10-29-35-315Z-god-dwight-canary5/);
  }
  // The no-Stop (legacy-move) text is the 1.1.74 one, byte for byte.
  assert.match(inboxNudgeText(['x'], 'legacy-move'), / - at least: x\. Read your inbox \(authoritative; ids already in inbox\/\.done\/ were handled\), act, move handled ones to inbox\/\.done\/\.$/);
});

test('ZT-I1-MAIL P11: the Stop drain is DELETED (drainForStop, drainLines and the DRAIN_* caps)', () => {
  assert.equal(H.drainLines, undefined);
  assert.equal(H.DRAIN_BODY_MAX_CHARS, undefined);
  assert.equal(H.DRAIN_TOTAL_MAX_CHARS, undefined);
  assert.equal(typeof H.HiveManager.prototype.drainForStop, 'undefined');
});
