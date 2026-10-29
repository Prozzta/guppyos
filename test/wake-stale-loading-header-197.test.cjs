'use strict';
require('./tools/own-job.cjs');

// WAKE-LIFECYCLE-UNKNOWN-197: after the 1.1.97 restart a resumed Codex kept the startup draft's
// `model: loading` box as the NEWEST header in its buffer while the live chat widget was up (empty
// composer + `<model> <effort> · <cwd> · <thread>`). codexPastStartup refused it `header-loading`
// on every reconcile retry, so mail sat until a person typed. The stale header now opens CONDITION 1
// only with the agent's own status line, no Resuming/Forking line, AND the owner's post-handoff
// latch for this incarnation. Mutant census: test/tools/wake-stale-loading-mutants.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/shared/codexScreen.ts');
const CWD = 'C:\\PrzEdit';
const HOME = 'C:\\Users\\someone';
const HEADER = [
  '╭────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.157.1)                 │',
  '│                                            │',
  '│ model:       loading   /model to change    │',
  '│ directory:   C:\\PrzEdit                    │',
  '│ permissions: YOLO mode                     │',
  '╰────────────────────────────────────────────╯'
];
// The 17:01:53Z wake-screen-guard reading: no Resuming line, a replayed transcript, the empty
// composer and the three-part status line.
const STALE = [
  ...HEADER,
  '',
  '› [hive] check inbox',
  '  • Heavy-slot notice was stale; no bench run started.',
  '  18:59',
  '',
  '› Ask Codex to do anything',
  '',
  '  GPT-5.6-Terra medium · C:\\PrzEdit · Check hive inbox',
  '  ? for shortcuts'
];
const facts = (rows) => S.extractCodexScreen((i) => rows[i], rows.length, rows.indexOf('› Ask Codex to do anything'));

test('STALE: a latched resume with a loading header and its own status line is past startup', () => {
  const f = facts(STALE);
  assert.equal(f.header, 'LOADING');
  assert.equal(f.startingAfterHeader, false);
  assert.deepEqual(S.codexPastStartup(f, CWD, HOME, true), { open: true, reason: 'status-line-over-loading' });
});

test('UNLATCHED: the same screen without the post-handoff latch is refused, so it never creates the latch', () => {
  const f = facts(STALE);
  assert.deepEqual(S.codexPastStartup(f, CWD, HOME, false), { open: false, reason: 'header-loading' });
  assert.deepEqual(S.codexPastStartup(f, CWD, HOME), { open: false, reason: 'header-loading' }, 'the default is unlatched');
});

test('NO STATUS LINE: a latched loading header with only `? for shortcuts` under the composer is refused', () => {
  const rows = STALE.filter((r) => !r.includes(' · '));
  assert.deepEqual(S.codexPastStartup(facts(rows), CWD, HOME, true), { open: false, reason: 'header-loading' });
});

test('RESUMING: a latched loading header with its Resuming/Forking line is refused, status line or not', () => {
  for (const line of ['  Resuming session…', '  Forking session…']) {
    const rows = [...HEADER, line, ...STALE.slice(HEADER.length)];
    const f = facts(rows);
    assert.equal(f.startingAfterHeader, true, line);
    assert.deepEqual(S.codexPastStartup(f, CWD, HOME, true), { open: false, reason: 'header-loading' }, line);
  }
});

test('OTHER CWD: a status line for another folder does not open a latched loading header', () => {
  const rows = STALE.map((r) => r.replace('· C:\\PrzEdit ·', '· C:\\Elsewhere ·'));
  assert.deepEqual(S.codexPastStartup(facts(rows), CWD, HOME, true), { open: false, reason: 'header-loading' });
});

test('DRAFT FIXTURE: the real resume draft stays refused even latched', () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wake-screen-guard', '4-resume-resumedraft.json'), 'utf8'));
  const f = S.extractCodexScreen((i) => fx.lines[i], fx.lines.length, fx.cursorRow);
  assert.equal(S.codexPastStartup(f, 'C:\\Dunder\\_work\\andy-176-wsg-capture\\real2\\dir-b', null, true).open, false);
});

test('WIRING: the owner passes its latch for this incarnation at both admission reads, and the startup probe passes none', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'automaticSubmit.ts'), 'utf8');
  assert.ok(src.includes('codexPastStartup(r.facts, deps.spawnCwd?.(ptyId), deps.homeDir?.(), this.postHandoff.get(ptyId) === incarnation)'), 'the screen gate passes the latch');
  assert.ok(src.includes('codexPastStartup(g.facts, deps.spawnCwd?.(ptyId), deps.homeDir?.(), this.postHandoff.get(ptyId) === held.incarnation)'), 'the held recheck passes the latch');
  const probe = src.slice(src.indexOf('async observeStartup('), src.indexOf('async observeStartup(') + 1500);
  assert.ok(probe.includes('codexPastStartup(r.facts, deps.spawnCwd?.(ptyId), deps.homeDir?.());'), 'the latch probe reads unlatched');
});
