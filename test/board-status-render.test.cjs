'use strict';

/**
 * ZT-I3 §3.5: board-status.md is rendered by the harness, deterministically, and says what
 * is RUNNING from the newest app-start row (god's hand-kept block once said 1.1.67 while
 * 1.1.72 ran).
 *
 * Mutants that must die:
 *   M17  the version is read from the OLDEST app-start row (a stale version string)
 *   MBS1 the writer ignores its minimum interval (writes on every change)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { renderBoardStatus, latestAppStart, BoardStatusWriter, BOARD_STATUS_MIN_INTERVAL_MS } = loadTs('src/main/boardStatus.ts');

const H = 3_600_000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');

function fixture() {
  return {
    tasks: { tasks: [
      { id: 'A', title: 'Build it', status: 'doing', assignee: 'jim' },
      { id: 'Q', title: 'Ask', status: 'blocked', assignee: 'ann', humanQA: [{ q: 'go?' }] },
      { id: 'D', title: 'Shipped', status: 'done', assignee: 'andy' },
      { id: 'OLD', title: 'Long ago', status: 'done', assignee: 'andy' }
    ] },
    meta: {
      A: { statusSince: NOW - 2 * H, statusSinceExact: true },
      Q: { statusSince: NOW - 30 * 60_000, statusSinceExact: false },
      D: { statusSince: NOW - H, history: [{ at: NOW - H, to: 'done' }] },
      OLD: { statusSince: NOW - 72 * H, history: [{ at: NOW - 72 * H, to: 'done' }] }
    },
    flags: [{ cardId: 'A', kind: 'DOING_MANY', agentId: 'jim', since: NOW, evidence: 'jim has 4', decision: false }],
    agents: [{ id: 'jim', name: 'Jim', inboxBacklog: 1, liveness: { classification: 'BUSY_PROGRESSING' } }, { id: 'ann', name: 'Ann', onHold: true }],
    appStart: { ts: NOW - 5 * H, version: '1.1.77', packaged: true },
    now: NOW
  };
}

test('renders every section deterministically', () => {
  const md = renderBoardStatus(fixture());
  assert.equal(md, renderBoardStatus(fixture()), 'same input, same bytes');
  assert.match(md, /## Installed \/ running\n\nGuppy 1\.1\.77, started 2026-10-01T07:00:00\.000Z\./);
  assert.match(md, /\| A: Build it \| jim \| 2 h \| DOING_MANY \|/);
  assert.match(md, /- Q \(ann, >= 30 min\): 1 question\(s\) for the Human/);
  assert.match(md, /## Done in the last 24 h\n\n- D \(andy\): Shipped\n\n/);
  assert.doesNotMatch(md, /Long ago/);
  assert.match(md, /- Jim \(jim\): busy_progressing; 1 doing; 1 message\(s\) waiting/);
  assert.match(md, /- Ann \(ann\): on hold; 0 doing/);
});

test('the version is the NEWEST app-start row (M17)', () => {
  const log = [
    JSON.stringify({ ts: 1, kind: 'app-start', version: '1.1.67', packaged: true }),
    JSON.stringify({ ts: 2, kind: 'tasks', count: 3 }),
    JSON.stringify({ ts: 3, kind: 'app-start', version: '1.1.72', packaged: true }),
    '{"torn'
  ].join('\n');
  assert.deepEqual(latestAppStart(log), { ts: 3, version: '1.1.72', packaged: true });
  assert.equal(latestAppStart('{"kind":"tasks"}'), null);
});

test('the writer folds a burst of changes into one write per interval (MBS1)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-board-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'log.jsonl'), JSON.stringify({ ts: NOW, kind: 'app-start', version: '1.1.77', packaged: true }) + '\n');
  const clock = { now: NOW };
  let reads = 0;
  const w = new BoardStatusWriter({ root: () => root, tasks: () => { reads++; return { tasks: [] }; }, taskMeta: () => ({}), flags: () => [] }, () => clock.now);
  t.after(() => w.stop());
  w.request();
  assert.equal(reads, 1, 'the first change writes at once');
  assert.match(fs.readFileSync(path.join(root, 'board-status.md'), 'utf8'), /Guppy 1\.1\.77/);
  w.request();
  w.request();
  assert.equal(reads, 1, 'inside the interval: deferred, not written');
  clock.now += BOARD_STATUS_MIN_INTERVAL_MS;
  w.stop();
  w.request();
  assert.equal(reads, 2, 'once the interval passed, the next change writes');
});

test('the app-start row is read once per launch, not on every render (Jim S6)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-board-status-s6-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'log.jsonl');
  fs.writeFileSync(log, JSON.stringify({ ts: NOW, kind: 'app-start', version: '1.1.77', packaged: true }) + '\n');
  const w = new BoardStatusWriter({ root: () => root, tasks: () => ({ tasks: [] }), taskMeta: () => ({}), flags: () => [] }, () => NOW);
  assert.match(w.write(), /Guppy 1\.1\.77/);
  fs.writeFileSync(log, JSON.stringify({ ts: NOW + 1, kind: 'app-start', version: '9.9.9', packaged: true }) + '\n');
  assert.match(w.write(), /Guppy 1\.1\.77/, 'cached: the log is not re-read');
});
