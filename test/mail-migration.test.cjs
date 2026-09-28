'use strict';
/**
 * ZT-I1-MAIL 1.1.75 slice 6: the one-shot, idempotent upgrade pass (INBOX-DESIGN.md §7.1,
 * §11.12(c), §11.17 N4, §11.18 #8). A real (jailed) hive; zero model tokens; no windows.
 *  - every active agent's inbox is imported as delivered + legacy:true; .done is NOT imported;
 *  - an archived agent's inbox/*.json moves to inbox/.undelivered/, listed in
 *    state/mail/undelivered-report.json (shown once: seenAt persisted), its ledger never loaded,
 *    nothing pending for it (never woken);
 *  - the `## How I work` lesson scan is reported and logged, the memory files are byte-identical;
 *  - the marker makes it once per hive; a re-run without the marker changes nothing.
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-migration-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager } = loadTs('src/main/hive.ts');
const M = loadTs('src/main/mailMigration.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

const LESSONS = [
  '# Memory - Andy',
  '',
  '## How I work (standing lessons)',
  '- Always run the typecheck before committing.',
  '- After handling a message, move its file to inbox/.done so god sees it handled.',
  '- Never move inbox files until the task is finished.',
  '- Check fleet.json for the backlog.',
  '',
  '## Notes',
  '- mv inbox/x.json inbox/.done/ (a note outside the lessons: not reported)',
  ''
].join('\n');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const writeMsg = (dir, id, extra = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, from: 'god-1', to: 'x', act: 'inform', subject: `s-${id}`, body: `b-${id}`, created_at: '2026-09-01T00:00:00Z', ...extra }));
};

/** A 1.1.74 floor: mail on disk, no ledgers yet. meredith is archived with unread mail. */
async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'meredith-1', name: 'Meredith', provider: 'codex', cwd: home });
  const root = hive.root();
  const dir = (id, ...p) => path.join(root, 'agents', id, ...p);
  writeMsg(dir('andy-1', 'inbox'), 'a1');
  writeMsg(dir('andy-1', 'inbox'), 'a2', { act: 'request' });
  writeMsg(dir('andy-1', 'inbox', '.done'), 'old-done');
  for (let i = 0; i < 3; i++) writeMsg(dir('meredith-1', 'inbox'), `m${i}`, { subject: `for meredith ${i}` });
  writeMsg(dir('meredith-1', 'inbox', '.done'), 'm-old');
  fs.writeFileSync(dir('andy-1', 'memory.md'), LESSONS);
  // Archived the 1.1.74 way (the flag only, no reason, nothing moved): since df70e4 a 1.1.75
  // explicit setArchived would already set her mail aside.
  const regPath = path.join(root, 'registry.json');
  const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'));
  reg.agents['meredith-1'].archived = true;
  fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
  // A clean slate: no ledger was written by the setup (ensureAgent does not touch mail).
  hive.mail.dispose();
  for (const f of fs.existsSync(path.join(root, 'state', 'mail')) ? fs.readdirSync(path.join(root, 'state', 'mail')) : []) fs.rmSync(path.join(root, 'state', 'mail', f), { recursive: true, force: true });
  return { hive, root, dir };
}
const logRows = (hive, kind) => hive.logTail(5000).filter((r) => r && r.kind === kind);

test('§7.1 step 1: every active agent is imported at boot (not on first touch), delivered + legacy:true; .done is NOT imported', async (t) => {
  const { hive, root } = await floor(t);
  assert.equal(fs.existsSync(path.join(root, 'state', 'mail', 'andy-1.json')), false, 'no ledger before the pass');
  const r = hive.migrateMail();
  assert.equal(r.ran, true);
  // The pass wrote the ledger itself (flushAll), before anything else touched the agent.
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'state', 'mail', 'andy-1.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk.entries).sort(), ['a1', 'a2']);
  for (const e of Object.values(onDisk.entries)) {
    assert.equal(e.state, 'delivered');
    assert.equal(e.legacy, true, 'the legacy marker is set on every imported entry');
    assert.equal(e.surfacedAt ?? null, null, 'so the first surfacing carries "(delivered before 1.1.75 …)"');
  }
  assert.equal(onDisk.entries['old-done'], undefined, '.done is history, never imported');
  assert.equal(r.report.agents.find((a) => a.agentId === 'andy-1').legacyPending, 2);
  assert.ok(fs.existsSync(path.join(root, 'state', 'mail', 'god-1.json')), 'god too: EVERY registry agent is touched');
  assert.equal(logRows(hive, 'mail-ledger-migrated').find((x) => x.agentId === 'andy-1').imported, 2);
  const summary = logRows(hive, 'mail-migration');
  assert.equal(summary.length, 1);
  assert.deepEqual({ undelivered: summary[0].undelivered, legacyPending: summary[0].legacyPending, errors: summary[0].errors }, { undelivered: 3, legacyPending: 2, errors: 0 });
});

test('§7.1 step 2: an archived agent\'s inbox moves to inbox/.undelivered, reported once, its ledger never loaded, never woken', async (t) => {
  const { hive, root, dir } = await floor(t);
  const r = hive.migrateMail();
  assert.deepEqual(fs.readdirSync(dir('meredith-1', 'inbox')).filter((n) => n.endsWith('.json')), [], 'nothing left in inbox/');
  assert.deepEqual(fs.readdirSync(dir('meredith-1', 'inbox', '.undelivered')).sort(), ['m0.json', 'm1.json', 'm2.json']);
  assert.ok(fs.existsSync(dir('meredith-1', 'inbox', '.done', 'm-old.json')), '.done is left alone');
  assert.equal(fs.existsSync(path.join(root, 'state', 'mail', 'meredith-1.json')), false, 'an archived agent\'s ledger is never created');
  const report = hive.undeliveredReport();
  assert.equal(report.seenAt, null, 'to be shown');
  assert.deepEqual(report.items.map((i) => [i.agentId, i.id, i.subject, i.from, i.file]),
    [0, 1, 2].map((i) => ['meredith-1', `m${i}`, `for meredith ${i}`, 'god-1', `agents/meredith-1/inbox/.undelivered/m${i}.json`]));
  assert.deepEqual(r.undelivered.length, 3);
  // Never woken: nothing is pending for it by the ledger (not loaded) nor by the files (moved).
  assert.equal(hive.inboxBacklog('meredith-1', { archived: true }), 0);
  // Shown ONCE: dismissing persists; a second dismiss is a no-op.
  assert.equal(hive.markUndeliveredSeen(), true);
  assert.equal(typeof hive.undeliveredReport().seenAt, 'number');
  assert.equal(hive.markUndeliveredSeen(), false);
  assert.equal(logRows(hive, 'mail-undelivered-seen').length, 1);
  // The module holds no wake / nudge / send path at all.
  const src = codeOnly(readSource('src/main/mailMigration.ts'), 'mailMigration.ts');
  assert.doesNotMatch(src, /wake|nudge|\.send\(|routeMessage|requestInbox/i);
});

test('§11.12(c): the How-I-work lesson scan is reported and logged; memory files are never edited', async (t) => {
  const { hive, root, dir } = await floor(t);
  const before = sha(dir('andy-1', 'memory.md'));
  const godBefore = sha(dir('god-1', 'memory.md'));
  hive.migrateMail();
  assert.equal(sha(dir('andy-1', 'memory.md')), before, 'read-only');
  assert.equal(sha(dir('god-1', 'memory.md')), godBefore, 'read-only');
  const rep = JSON.parse(fs.readFileSync(path.join(root, 'state', 'mail', 'migration-report.json'), 'utf8'));
  const andy = rep.lessons.find((l) => l.agentId === 'andy-1');
  assert.deepEqual(andy.hits.map((h) => h.text), [
    '- After handling a message, move its file to inbox/.done so god sees it handled.',
    '- Never move inbox files until the task is finished.'
  ], 'only the rules inside ## How I work; the note outside it is not a lesson');
  assert.equal(rep.lessons.some((l) => l.agentId === 'god-1'), false, 'the seeded section has no inbox rule');
  const row = logRows(hive, 'mail-migration-lesson');
  assert.equal(row.length, 1);
  assert.equal(row[0].agentId, 'andy-1');
  assert.equal(row[0].texts.length, 2);
});

test('scanMailLessons (pure): .done, or the inbox plus a move verb; code fences and other sections do not count', () => {
  const md = (lines) => ['## How I work (standing lessons)', ...lines, '## Other', '- move inbox/x to .done'].join('\n');
  assert.deepEqual(M.scanMailLessons(md(['- read inbox first', '- archive handled inbox mail', '- leave .done alone'])).map((h) => h.text),
    ['- archive handled inbox mail', '- leave .done alone']);
  assert.deepEqual(M.scanMailLessons(md(['- use git mv for renames', '- the inbox is important'])), []);
  assert.deepEqual(M.scanMailLessons('# no section\n- move inbox files to .done\n'), []);
});

test('idempotent: the marker makes it once per hive; a re-run without the marker changes nothing and keeps "seen"', async (t) => {
  const { hive, root } = await floor(t);
  hive.migrateMail();
  const ledgerFile = path.join(root, 'state', 'mail', 'andy-1.json');
  const ledgerBefore = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).entries;
  hive.markUndeliveredSeen();
  const seenAt = hive.undeliveredReport().seenAt;
  assert.equal(hive.migrateMail().ran, false, 'the marker: once per hive');
  assert.equal(logRows(hive, 'mail-migration').length, 1);

  // A crash before the marker (or a lost marker): the whole pass again is harmless.
  fs.rmSync(path.join(root, 'state', 'mail', 'migration.json'));
  hive.mail.dispose();
  const again = hive.migrateMail();
  assert.equal(again.ran, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).entries, ledgerBefore, 'an existing ledger is never re-imported');
  assert.equal(logRows(hive, 'mail-ledger-migrated').filter((x) => x.agentId === 'andy-1').length, 1, 'one import row, ever');
  const rep = hive.undeliveredReport();
  assert.equal(rep.items.length, 3, 'no duplicate items');
  assert.equal(rep.seenAt, seenAt, 'a dismissed report stays dismissed');
  assert.equal(again.undelivered.length, 3);
  assert.ok(fs.existsSync(path.join(root, 'state', 'mail', 'migration.json')));
});

test('a new archived message on a re-run is appended and shown again; a clash in .undelivered never overwrites', async (t) => {
  const { hive, root, dir } = await floor(t);
  hive.migrateMail();
  hive.markUndeliveredSeen();
  fs.rmSync(path.join(root, 'state', 'mail', 'migration.json'));
  writeMsg(dir('meredith-1', 'inbox'), 'm0', { subject: 'second m0' });
  hive.migrateMail();
  assert.deepEqual(fs.readdirSync(dir('meredith-1', 'inbox', '.undelivered')).sort(), ['m0.1.json', 'm0.json', 'm1.json', 'm2.json']);
  const rep = hive.undeliveredReport();
  assert.equal(rep.items.length, 4);
  assert.equal(rep.seenAt, null, 'new items are shown');
  assert.equal(rep.items[3].subject, 'second m0');
});

test('a damaged registry: the pass throws and writes no marker (it runs at the next boot)', async (t) => {
  const { hive, root } = await floor(t);
  fs.writeFileSync(path.join(root, 'registry.json'), '{ not json');
  assert.throws(() => hive.migrateMail());
  assert.equal(fs.existsSync(path.join(root, 'state', 'mail', 'migration.json')), false);
  assert.equal(M.mailMigrationDone(root), false);
});

test('WIRING: index.ts runs the pass at boot BEFORE archiveOrphanedAgents (after it every agent reads archived)', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const body = src.slice(src.indexOf('function bootstrapHiveServices'));
  const mig = body.indexOf('hive.migrateMail()');
  const orphan = body.indexOf('archiveOrphanedAgents();');
  assert.ok(mig > 0 && orphan > 0 && mig < orphan, 'migrateMail before archiveOrphanedAgents');
  assert.ok(body.indexOf('hive.ensureHive()') < mig);
});
