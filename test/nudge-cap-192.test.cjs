'use strict';
/**
 * NUDGE-CAP-192: the inbox wake nudge names at most INBOX_NUDGE_MAX_IDS (8) ids, the oldest, then
 * "and N more". It used to list every pending id (~43 chars each), so 60 ids wrapped to ~33 rows at
 * 80 columns, past the 24-row screen reading (TUI-COMPOSER-ALLOWLIST-191 own-draft-clipped).
 *
 * The ids are diagnostic, not a work list: the harness marks the CLAIM's ids announced, never ids
 * parsed from the text. But a legacy-read / work-order / degraded-read agent is told to read
 * "those files", and the harness archives every announced id at its Stop: a capped list must send
 * it to EVERY file in its inbox, or the unnamed mail would be archived unread.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const N = loadTs('src/shared/hiveNudge.ts');
const MODES = ['inject', 'legacy-read', 'legacy-move', 'work-order', 'degraded-move', 'degraded-read'];
const id = (i) => `2026-10-17T08-${String(Math.floor(i / 60)).padStart(2, '0')}-${String(i % 60).padStart(2, '0')}-000Z-${(i * 7919).toString(16).padStart(6, '0')}`;
const ids = (n) => Array.from({ length: n }, (_, i) => id(i));

/** The 1.1.91 text, every id listed: the cap must leave it byte for byte up to 8 ids. */
function uncapped(list, mode) {
  const l = list.join(', ');
  const tail = list.length ? `: ${l}` : '';
  if (mode === 'inject') return `You have new hive mail (delivered in context below)${tail}.`;
  if (mode === 'degraded-move') return `You have new hive mail${tail}. Mail channel degraded: read each file in your inbox/ and move it to inbox/.done/ yourself once handled.`;
  if (mode === 'degraded-read') return `You have new hive mail${tail}. Mail channel degraded: read those files in your inbox/ and act; the harness archives them when your turn ends.`;
  if (mode === 'legacy-read' || mode === 'work-order') return `You have new hive mail${tail}. Read those files in your inbox/ and act; the harness archives them when your turn ends.`;
  return `You have new hive inbox message(s)${list.length ? ` - at least: ${l}` : ''}. Read your inbox (authoritative; ids already in inbox/.done/ were handled), act, move handled ones to inbox/.done/.`;
}

test('the cap is 8, and up to 8 ids every mode\'s text is unchanged', () => {
  assert.equal(N.INBOX_NUDGE_MAX_IDS, 8);
  for (const mode of MODES) for (const n of [0, 1, 2, 8]) assert.equal(N.inboxNudgeText(ids(n), mode), uncapped(ids(n), mode), `${mode} ${n}`);
});

test('60 ids: the 8 oldest are named, then "and 52 more"; no other id appears', () => {
  const all = ids(60);
  for (const mode of MODES) {
    const t = N.inboxNudgeText(all, mode);
    for (const x of all.slice(0, 8)) assert.ok(t.includes(x), `${mode}: names ${x}`);
    for (const x of all.slice(8)) assert.ok(!t.includes(x), `${mode}: does not name ${x}`);
    assert.match(t, /, and 52 more[.]/, mode);
    assert.equal(N.isInboxNudge(t), true, `${mode}: still a nudge (the queue's one-pending rule)`);
    assert.match(t, /^[\x20-\x7e]+$/, `${mode}: printable ASCII (CODEX-WAKE-162)`);
  }
  // 9 ids: one over the cap.
  assert.equal(N.inboxNudgeText(ids(9)), `You have new hive mail (delivered in context below): ${ids(9).slice(0, 8).join(', ')}, and 1 more.`);
});

test('the oldest are the FIRST 8 as given: the wake passes its ids sorted (timestamp first), and the text keeps that order', () => {
  const all = ids(20);
  const t = N.inboxNudgeText(all);
  assert.equal(t, `You have new hive mail (delivered in context below): ${all.slice(0, 8).join(', ')}, and 12 more.`);
});

test('bounded: with any number of real-shaped ids the nudge fits the 24-row reading at 80 columns', () => {
  for (const mode of MODES) for (const n of [9, 60, 500]) {
    const t = N.inboxNudgeText(ids(n), mode);
    assert.ok(t.length <= N.INBOX_NUDGE_FIXED_CHARS + 8 * (id(0).length + 2) + 24, `${mode} ${n}: ${t.length}`);
    assert.ok(Math.ceil((t.length + 2) / 80) <= 10, `${mode} ${n}: ${Math.ceil((t.length + 2) / 80)} rows at 80 cols`);
  }
});

test('a capped list never tells a read-mode agent to read only "those files": it reads EVERY file (its Stop archives every announced id)', () => {
  for (const mode of ['legacy-read', 'work-order', 'degraded-read']) {
    const t = N.inboxNudgeText(ids(60), mode);
    assert.doesNotMatch(t, /those files/, mode);
    assert.match(t, /[Rr]ead every file in your inbox\//, mode);
    assert.match(t, /the harness archives them when your turn ends/, mode);
  }
  // The move modes already read every file (legacy-move: "Read your inbox (authoritative ...)").
  assert.match(N.inboxNudgeText(ids(60), 'degraded-move'), /read each file in your inbox\//);
  assert.match(N.inboxNudgeText(ids(60), 'legacy-move'), / - at least: .*, and 52 more\. Read your inbox \(authoritative/);
});

test('Codex still gets only its fixed sentinel, whatever the count', () => {
  assert.equal(N.inboxWakeTextForProvider('codex', ids(60)), N.CODEX_INBOX_WAKE_SENTINEL);
});
