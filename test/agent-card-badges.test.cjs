'use strict';
require('./tools/own-job.cjs');

/**
 * CARD-BADGE-AMBIGUOUS: the Human read the "2" on a player card's doing note as unread mail.
 * The task chip now always shows a clipboard AND the count (also for 1), turns amber with
 * "!" when one of the agent's doing cards is flagged, and a separate round mail badge in a
 * different corner shows messages waiting (not "unread": mail not yet acted on).
 *
 * Mutants that must die:
 *   M18 the chip falls back to the bare number (or the old pencil for 1)
 *   M19 the mail badge renders the doing count
 *   MB1 the title says "unread"
 *   MB2 a duplicate id or an archived assignee's card counts twice / still counts
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const B = loadTs('src/shared/agentBadges.ts');

test('the task chip is a clipboard plus the count, for 1 as well (M18)', () => {
  assert.equal(B.taskChipText(1), '📋1');
  assert.equal(B.taskChipText(2), '📋2');
  assert.equal(B.taskChipTitle(1, []), '1 task in progress (doing): click to open');
  assert.equal(B.taskChipTitle(2, ['stale: ZT-I1-MAIL']), '2 tasks in progress (doing): click to open\n! stale: ZT-I1-MAIL');
});

test('the mail badge says messages WAITING, never unread (MB1)', () => {
  assert.equal(B.mailBadgeTitle(1), '1 message waiting');
  assert.equal(B.mailBadgeTitle(3), '3 messages waiting');
  assert.doesNotMatch(B.mailBadgeTitle(3), /unread/i);
});

test('the mail badge labels a bounded quiet hold in local time, and says a due hold is due', () => {
  const until = Date.now() + 15 * 60_000;
  assert.match(B.mailBadgeTitle(1, 1, until), /^inbox 1 \(held until \d{2}:\d{2} local\); 1 message waiting; or sooner with other mail$/);
  assert.match(B.mailBadgeTitle(3, 1, until), /^inbox 3, 1 held until \d{2}:\d{2} local; 3 messages waiting; or sooner with other mail$/);
  assert.equal(B.heldInboxText(1, 1, until - 30 * 60_000, until), 'inbox 1 (held, due)');
});

test('fleet mail keeps a due hold as the earliest release rather than skipping to a later one', () => {
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const fleet = index.slice(index.indexOf('function fleetMail('), index.indexOf('function writeFleetSnapshot'));
  assert.match(fleet, /quietHeld\(id\)\.values\(\)\]\.filter\(\(until\) => Number\.isFinite\(until\)\)/);
  assert.match(fleet, /heldUntil: Math\.min\(\.\.\.heldUntil\)/);
  assert.doesNotMatch(fleet, /until > now/, 'a past-due hold remains visible as due until its next claim releases it');
});

test('per-agent doing cards and flag lines; duplicates once; archived assignees not counted (MB2)', () => {
  const tasks = { tasks: [
    { id: 'A', status: 'doing', assignee: 'jim' }, { id: 'B', status: 'doing', assignee: 'jim' },
    { id: 'A', status: 'doing', assignee: 'jim' }, { id: 'C', status: 'doing', assignee: 'gone' },
    { id: 'D', status: 'todo', assignee: 'jim' }, { id: 'E', status: 'doing', assignee: 'unassigned' }
  ] };
  const flags = [
    { cardId: 'B', kind: 'STALE', agentId: 'jim', evidence: 'x' },
    { cardId: 'C', kind: 'ASSIGNEE_ARCHIVED', agentId: 'gone', evidence: 'x' }
  ];
  assert.deepEqual(B.agentBadges(tasks, flags), { jim: { doing: ['A', 'B'], flagged: ['stale: B'] } });
});

const CARD = codeOnly(readSource('src/renderer/src/components/AgentCard.tsx'));

test('AgentCard draws the chip from taskChipText and a distinct mail badge from inboxBacklog (M18, M19)', () => {
  const chip = CARD.slice(CARD.indexOf('data-badge="task"'), CARD.indexOf('</span>', CARD.indexOf('data-badge="task"')));
  assert.match(chip, /\{taskChipText\(doingCount\)\}\{taskFlags\.length \? '!' : ''\}/);
  assert.doesNotMatch(chip, /doingCount > 1 \? doingCount/, 'never the bare number');
  assert.match(chip, /title=\{taskChipTitle\(doingCount, taskFlags\)\}/);
  assert.match(chip, /bottom: -5/);
  const mail = CARD.slice(CARD.indexOf('data-badge="mail"'), CARD.indexOf('</span>', CARD.indexOf('data-badge="mail"')));
  assert.match(CARD, /\{inboxBacklog > 0 && \(\s*<span\s+data-badge="mail"/);
  assert.match(mail, /\$\{MAIL_GLYPH\}\$\{inboxBacklog\} held \$\{heldUntilText\(heldUntil\)\}/);
  assert.doesNotMatch(mail, /doingCount/);
  assert.match(mail, /title=\{mailBadgeTitle\(inboxBacklog, inboxHeld, heldUntil\)\}/);
  assert.match(mail, /left: 40, bottom: -5/, 'the short label avoids the top-right status pill');
  assert.match(mail, /maxWidth: 126/);
  assert.match(mail, /whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'/);
  assert.match(mail, /borderRadius: 9/, 'a different shape');
});

test('the strip feeds both badges from main (flags + messages waiting)', () => {
  const strip = codeOnly(readSource('src/renderer/src/components/AgentStrip.tsx'));
  assert.match(strip, /setBadgeByAgent\(agentBadges\(raw, flags\)\)/);
  assert.match(strip, /inboxBacklog=\{inboxByAgent\[a\.id\] \?\? 0\}/);
  assert.match(strip, /inboxHeld=\{inboxHeldByAgent\[a\.id\] \?\? 0\}/);
  assert.match(strip, /heldUntil=\{heldUntilByAgent\[a\.id\]\}/);
  assert.match(strip, /taskFlags=\{badgeByAgent\[a\.id\]\?\.flagged\}/);
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(index, /ipcMain\.handle\('hive:cardBadges'/);
  assert.match(index, /const mail = fleetMail\(id\);\n\s+inboxBacklog\[id\] = mail\.inboxBacklog/);
  assert.match(index, /inboxHeld\[id\] = mail\.inboxHeld/);
  assert.match(index, /heldUntil\[id\] = mail\.heldUntil/);
});

test('Kanban status age: exact, bounded (">="), missing', () => {
  const NOW = 10 * 3_600_000;
  assert.equal(B.statusAgeText({ statusSince: NOW - 3 * 3_600_000, statusSinceExact: true }, NOW), '3 h');
  assert.equal(B.statusAgeText({ statusSince: NOW - 20 * 60_000, statusSinceExact: false }, NOW), '>= 20 min');
  assert.equal(B.statusAgeText({ statusSince: 0 }, 72 * 3_600_000), '3 d');
  assert.equal(B.statusAgeText(undefined, NOW), '');
});

test('the Kanban shows each card\'s flags and age, and a FLOOR toggle for the digest panel', () => {
  const kanban = codeOnly(readSource('src/renderer/src/components/TasksKanban.tsx'));
  assert.match(kanban, /flags=\{flags\.filter\(\(f\) => f\.cardId === t\.id\)\}/);
  assert.match(kanban, /age=\{t\.status === 'done' \? '' : statusAgeText\(meta\[t\.id\], Date\.now\(\)\)\}/);
  assert.match(kanban, /\{flags\.length > 0 && \(\s*<span data-flag="card"/);
  assert.match(kanban, /\{showFloor && <FloorDigestPanel \/>\}/);
  const panel = codeOnly(readSource('src/renderer/src/components/FloorDigestPanel.tsx'));
  assert.match(panel, /window\.cth\.hiveFloorDigest\(\)/);
  assert.match(panel, /<SafeMarkdown source=\{text\} \/>/);
});
