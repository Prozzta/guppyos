'use strict';
require('./tools/own-job.cjs');
/**
 * RESTORE-ORPHAN-FLAG (2026-11-15) + LOG-ARCHIVE-CLEAR. A real (jailed) hive; zero model tokens; no windows.
 * Incident: log.jsonl 20:56:07Z app-start + six spawns, then 20:56:38Z a SECOND app-start in the same
 * hive with the boot sweep archiving all six live agents as 'orphan' and no spawn after it. The second
 * process lost the single-instance lock; Stable's app.quit() is asynchronous, so its whenReady bootstrap
 * (archiveOrphanedAgents included) still ran against the running instance's registry.
 *  - a restore spawn (ensureAgent) of an orphan-archived agent leaves archived:false, no archiveReason,
 *    and now logs that clear (LOG-ARCHIVE-CLEAR);
 *  - a process without the single-instance lock never reaches bootstrapHiveServices.
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-restore-orphan-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager } = loadTs('src/main/hive.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  const root = hive.root();
  const reg = () => JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  const rows = () => hive.logTail(5000).filter((r) => r && r.kind === 'archive');
  return { hive, home, reg, rows };
}

test('an orphan-archived agent restored by ensureAgent is archived:false with no reason, and the clear is logged', async (t) => {
  const { hive, home, reg, rows } = await floor(t);
  hive.setArchived('pam-1', true, 'orphan');           // the boot sweep, exactly as archiveOrphanedAgents calls it
  assert.deepEqual({ a: reg().agents['pam-1'].archived, r: reg().agents['pam-1'].archiveReason }, { a: true, r: 'orphan' });
  const edges = [];
  const off = hive.onArchiveChange((id, archived) => edges.push([id, archived]));
  t.after(off);
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });   // the restore-team spawn
  const pam = reg().agents['pam-1'];
  assert.deepEqual({ archived: pam.archived, hasReason: 'archiveReason' in pam }, { archived: false, hasReason: false });
  assert.deepEqual(edges, [['pam-1', false]], 'one restore edge');
  const last = rows().filter((r) => r.agentId === 'pam-1').pop();
  assert.deepEqual({ archived: last.archived, via: last.via, prevReason: last.prevReason }, { archived: false, via: 'spawn', prevReason: 'orphan' });
  // A spawn of an agent that was NOT archived writes no archive row (no log noise per spawn).
  const before = rows().length;
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  assert.equal(rows().length, before);
  assert.deepEqual(edges, [['pam-1', false]]);
});

test('a process without the single-instance lock never runs the hive bootstrap (no orphan sweep of the live instance)', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const ready = src.indexOf('app.whenReady().then(() => {');
  assert.ok(ready > 0, 'whenReady callback found');
  const guard = src.indexOf('if (!gotInstanceLock) return;', ready);
  const boot = src.indexOf('bootstrapHiveServices();', ready);
  assert.ok(guard > ready, 'the lock guard is in the whenReady callback');
  assert.ok(boot > guard, 'the guard comes before bootstrapHiveServices');
  const head = src.slice(ready, guard);
  assert.doesNotMatch(head, /\bhive\.|archiveOrphanedAgents|bootstrapHiveServices/, 'nothing before the guard touches the hive');
  // Jim nit: both will-quit handlers return first in a lost-lock process (no capacity snapshot,
  // quit sweep, quit-done row or key-registry flush into the live instance's hive).
  const quits = [];
  for (let i = src.indexOf("app.on('will-quit'"); i >= 0; i = src.indexOf("app.on('will-quit'", i + 1)) quits.push(i);
  assert.equal(quits.length, 2, 'two will-quit handlers');
  for (const q of quits) {
    const body = src.slice(q, src.indexOf('});', q));
    assert.match(body, /^app\.on\('will-quit', \((?:e)?\) => \{\s*if \(!gotInstanceLock\) return;/, 'the lock guard is the first statement');
  }
  const flush = src.slice(quits[1], src.indexOf("kind: 'quit-done'", quits[1]));
  assert.match(flush, /if \(!gotInstanceLock\) return;/, 'quit-done is behind the guard');
  // The sweep itself is unchanged for agents that really are dead (lock owner, no live PTY).
  assert.match(src, /if \(ptyForAgent\(id\)\) continue;\s*hive\.setArchived\(id, true, 'orphan'\);/);
});
