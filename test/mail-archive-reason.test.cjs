'use strict';
/**
 * ZT-I1-MAIL 1.1.75, god's rulings Q31/Q32/Q34 (7048a1), the archive-reason refinement (0f1672),
 * the work-order leftover correction (1c7544) and Jim's slice 6/7 audit (migration report loss).
 * A real (jailed) hive; zero model tokens; no windows.
 *  - Q32: the registry records WHY an agent is archived. Only an EXPLICIT archive (IPC, realtime
 *    action, tab kill, voice kill; or a reason-less 1.1.74 archive) bounces (§4.2). The boot sweep
 *    ('orphan') and a process that died on its own ('pty-exit') keep receiving mail: delivered now,
 *    pending (surfaced) once the agent is restored. A restore clears the reason.
 *  - Q31: the §7.1 step-2 migration sets aside only explicit archives; it runs BEFORE the sweep.
 *  - 0f1672: a restore brings inbox/.undelivered back into inbox/ and the ledger, exactly once.
 *  - Jim M1: the undelivered report is built from .undelivered/ itself, so a failed or interrupted
 *    pass loses no item, and the marker waits for a pass with no error.
 *  - 1c7544 + Q34: a work-order agent's leftover inbox file goes out as a normal terminal work
 *    order, is acted via work-order + archived on the COMMITTED write, and is re-announced at most
 *    3 times (then stops, stays listed, one loud row).
 * HOME, USERPROFILE, CODEX_HOME and GEMINI_CLI_HOME are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mail-archive-reason-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager, archivedForMail } = loadTs('src/main/hive.ts');
const { coordinatorPendingIds } = loadTs('src/main/mailReaders.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

const BOUNCE = (to, subject) => `[undeliverable: ${to} is archived — resend to an active agent or god] ${subject}`;
const writeMsg = (dir, id, extra = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, from: 'god-1', to: 'x', act: 'inform', subject: `s-${id}`, body: `b-${id}`, created_at: '2026-09-01T00:00:00Z', ...extra }));
};

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const emitted = [];
  let emitOk = true;
  const hive = new HiveManager(() => home, (channel, payload) => { if (channel === 'hive:terminalHandoff') { if (!emitOk) return false; emitted.push(payload); } return true; });
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  const root = hive.root();
  const dir = (id, ...p) => path.join(root, 'agents', id, ...p);
  const files = (id, ...p) => { try { return fs.readdirSync(dir(id, 'inbox', ...p)).filter((n) => n.endsWith('.json')).sort(); } catch { return []; } };
  const reg = () => JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  const patchReg = (fn) => { const r = reg(); fn(r); fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify(r, null, 2)); };
  const rows = (kind) => hive.logTail(5000).filter((r) => r && r.kind === kind);
  const restore = (id) => hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const pending = (id) => coordinatorPendingIds(id, { mode: () => 'inject', pending: (a) => hive.mail.pending(a), skipped: () => [], files: () => [] });
  return { hive, root, dir, files, reg, patchReg, rows, restore, pending, emitted, setEmitOk: (v) => { emitOk = v; }, home };
}

// ————————————————————————————————————————————————— Q32: which archives bounce

test('archivedForMail (pure): explicit or reason-less archives bounce; orphan and pty-exit do not; active never', () => {
  assert.equal(archivedForMail({ archived: true, archiveReason: 'explicit' }), true);
  assert.equal(archivedForMail({ archived: true }), true, 'a 1.1.74 archive (no reason) counts as explicit');
  assert.equal(archivedForMail({ archived: true, archiveReason: 'orphan' }), false);
  assert.equal(archivedForMail({ archived: true, archiveReason: 'pty-exit' }), false);
  assert.equal(archivedForMail({ archived: false }), false);
  assert.equal(archivedForMail(undefined), false);
});

test('Q32: an EXPLICIT archive (the default reason: IPC, realtime, tab kill, voice kill) is recorded and bounces', async (t) => {
  const { hive, files, reg, rows } = await floor(t);
  hive.setArchived('pam-1', true);
  assert.deepEqual({ archived: reg().agents['pam-1'].archived, reason: reg().agents['pam-1'].archiveReason }, { archived: true, reason: 'explicit' });
  assert.equal(rows('archive').at(-1).reason, 'explicit');
  hive.send({ id: 'x1', to: 'pam-1', act: 'inform', subject: 'hello', body: 'b' }, 'jim-1');
  assert.deepEqual(files('pam-1'), []);
  assert.deepEqual(hive.inbox('jim-1').map((m) => m.subject), [BOUNCE('pam-1', 'hello')]);
  assert.equal(rows('drop').filter((r) => r.reason === 'archived').length, 1);
});

test('Q32: an ORPHAN archive (boot sweep) keeps receiving mail: delivered, no bounce, pending once restored', async (t) => {
  const { hive, files, reg, rows, restore, pending } = await floor(t);
  hive.setArchived('pam-1', true, 'orphan');
  assert.equal(reg().agents['pam-1'].archiveReason, 'orphan');
  hive.send({ id: 'o1', to: 'pam-1', act: 'request', subject: 'while orphaned', body: 'b', requires_reply: true }, 'jim-1');
  assert.deepEqual(files('pam-1'), ['o1.json'], 'delivered');
  assert.deepEqual(hive.inbox('jim-1'), [], 'no bounce to the sender');
  assert.equal(rows('drop').length, 0);
  assert.deepEqual(rows('message').find((r) => r.id === 'o1').delivered, ['pam-1']);
  assert.equal(hive.mail.ledger('pam-1').entries.o1.state, 'delivered');
  await restore('pam-1');
  assert.equal(reg().agents['pam-1'].archived, false);
  assert.equal('archiveReason' in reg().agents['pam-1'], false, 'the restore cleared the reason');
  assert.deepEqual(pending('pam-1'), ['o1'], 'the restored agent is woken for it and its hook surfaces it');
});

test('0f1672: a crash exit (pty-exit) keeps mail; a tab kill (explicit) bounces', async (t) => {
  const { hive, files, rows } = await floor(t);
  hive.setArchived('pam-1', true, 'pty-exit');
  hive.send({ id: 'c1', to: 'pam-1', act: 'inform', subject: 'after the crash', body: 'b' }, 'jim-1');
  assert.deepEqual(files('pam-1'), ['c1.json']);
  assert.deepEqual(hive.inbox('jim-1'), []);
  hive.setArchived('jim-1', true); // tab kill: teardownPty's default reason
  hive.send({ id: 'k1', to: 'jim-1', act: 'inform', subject: 'after the kill', body: 'b' }, 'god-1');
  assert.deepEqual(files('jim-1'), []);
  assert.deepEqual(hive.inbox('god-1').map((m) => m.subject), [BOUNCE('jim-1', 'after the kill')]);
  assert.deepEqual(rows('drop').map((r) => r.to), ['jim-1']);
});

test('Q32: mail in the first seconds after boot to a worker being restored is delivered, not bounced', async (t) => {
  const { hive, files, reg, rows, restore, pending } = await floor(t);
  // The last session QUIT with pam live: a quit never archives, so the registry says active.
  assert.equal(reg().agents['pam-1'].archived, false);
  // Boot: the migration, then the orphan sweep (no PTY yet for anybody), exactly as index.ts does.
  hive.migrateMail();
  hive.setArchived('pam-1', true, 'orphan');
  hive.setArchived('jim-1', true, 'orphan');
  // god mails pam before the renderer has restored her tab.
  hive.send({ id: 'early-1', to: 'pam-1', act: 'request', subject: 'first thing', body: 'go', requires_reply: true }, 'god-1');
  // jim (orphan-archived too) mails pam: an orphan sender is no reason to route anything to god.
  hive.send({ id: 'early-2', to: 'pam-1', act: 'inform', subject: 'fyi', body: 'x' }, 'jim-1');
  assert.deepEqual(files('pam-1'), ['early-1.json', 'early-2.json']);
  assert.deepEqual(rows('drop'), []);
  assert.deepEqual(hive.inbox('god-1'), []);
  await restore('pam-1');
  assert.deepEqual(pending('pam-1'), ['early-1', 'early-2']);
  assert.equal(reg().agents['pam-1'].archiveReason, undefined);
});

test('Q32: restore clears the reason (setArchived(false) and a respawn); explicit is never downgraded, orphan is upgraded', async (t) => {
  const { hive, reg, restore } = await floor(t);
  hive.setArchived('pam-1', true, 'orphan');
  hive.setArchived('pam-1', true);                  // the Human archives the orphaned card
  assert.equal(reg().agents['pam-1'].archiveReason, 'explicit', 'upgraded');
  hive.setArchived('pam-1', true, 'orphan');        // a later sweep never downgrades it
  hive.setArchived('pam-1', true, 'pty-exit');
  assert.equal(reg().agents['pam-1'].archiveReason, 'explicit');
  hive.setArchived('pam-1', false);
  assert.deepEqual({ archived: reg().agents['pam-1'].archived, has: 'archiveReason' in reg().agents['pam-1'] }, { archived: false, has: false });
  hive.setArchived('jim-1', true, 'pty-exit');
  await restore('jim-1');
  assert.deepEqual({ archived: reg().agents['jim-1'].archived, has: 'archiveReason' in reg().agents['jim-1'] }, { archived: false, has: false });
  // The registry is written through the strict mutation path: a damaged registry is never replaced.
  const src = codeOnly(readSource('src/main/hive.ts'), 'hive.ts');
  const body = src.slice(src.indexOf('  setArchived(id: string, archived: boolean'), src.indexOf('  restoreUndelivered(id: string)'));
  assert.match(body, /const reg = this\.registryForMutation\(\);/);
  assert.match(body, /this\.atomicWriteJson\(join\(root, 'registry\.json'\), reg\);/);
});

test('WIRING (0f1672): which index.ts path sets which reason', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(src, /function teardownPty\(id: string, archiveReason: ArchiveReason = 'explicit'\): void \{/);
  assert.match(src, /hive\.setArchived\(agentId, true, archiveReason\)/);
  // The onExit handler (the process died on its own): pty-exit.
  const onExit = src.slice(src.indexOf('ptyManager.setExitHandler('), src.indexOf('ptyManager.setExitHandler(') + 2500);
  assert.match(onExit, /teardownPty\(id, 'pty-exit'\);\s*\}\);/);
  // Every kill path keeps the explicit default: tab kill, voice kill, breaker stop, workers.
  assert.match(src, /ipcMain\.handle\('pty:kill'[\s\S]{0,400}?teardownPty\(id\);/);
  assert.match(src, /killAgent: \(id\) => \{\s*const r = ptyManager\.kill\(id\);\s*teardownPty\(id\);/);
  assert.equal((src.match(/teardownPty\([^)]*'pty-exit'\)/g) || []).length, 1, 'only the onExit path');
  // The boot sweep: orphan. IPC and realtime setArchived: the explicit default.
  assert.match(src, /hive\.setArchived\(id, true, 'orphan'\);/);
  assert.match(src, /ipcMain\.handle\('hive:setArchived'[\s\S]{0,300}?hive\.setArchived\(id, archived === true\);/);
  assert.match(src, /setArchived: \(id, archived\) => \{\s*if \(!hive\.enabled\(\)\) return[^\n]*\n\s*hive\.setArchived\(id, archived\);/);
});

// ————————————————————————————————————————————————— Q31 migration + restore of .undelivered

test('Q31: the migration sets aside EXPLICIT archives only; a reason-less 1.1.74 archive counts as explicit (meredith); an orphan is an active agent', async (t) => {
  const { hive, root, dir, files, patchReg, rows } = await floor(t);
  await hive.ensureAgent({ id: 'meredith-1', name: 'Meredith', provider: 'codex', cwd: root });
  for (let i = 0; i < 3; i++) writeMsg(dir('meredith-1', 'inbox'), `m${i}`, { subject: `for meredith ${i}` });
  writeMsg(dir('pam-1', 'inbox'), 'p0');
  writeMsg(dir('jim-1', 'inbox'), 'j0');
  // meredith: archived by 1.1.74 (no reason); pam: explicit; jim: orphan (an earlier 1.1.75 sweep).
  patchReg((r) => {
    Object.assign(r.agents['meredith-1'], { archived: true }); delete r.agents['meredith-1'].archiveReason;
    Object.assign(r.agents['pam-1'], { archived: true, archiveReason: 'explicit' });
    Object.assign(r.agents['jim-1'], { archived: true, archiveReason: 'orphan' });
  });
  hive.mail.dispose();
  const res = hive.migrateMail();
  assert.equal(res.ran, true);
  assert.deepEqual(files('meredith-1'), [], 'meredith: nothing left in inbox/');
  assert.deepEqual(files('meredith-1', '.undelivered'), ['m0.json', 'm1.json', 'm2.json']);
  assert.deepEqual(files('pam-1', '.undelivered'), ['p0.json']);
  assert.deepEqual(files('jim-1'), ['j0.json'], 'the orphan keeps its inbox');
  assert.deepEqual(files('jim-1', '.undelivered'), []);
  assert.equal(hive.mail.ledger('jim-1').entries.j0.state, 'delivered', 'imported like any active agent');
  const report = hive.undeliveredReport();
  assert.deepEqual(report.items.map((i) => `${i.agentId}/${i.id}`).sort(), ['meredith-1/m0', 'meredith-1/m1', 'meredith-1/m2', 'pam-1/p0']);
  assert.deepEqual(rows('mail-migration').at(-1).undelivered, 4);
});

test('0f1672: restoring meredith returns her .undelivered files to inbox/ and the ledger exactly once; the report drops them', async (t) => {
  const { hive, root, dir, files, patchReg, rows, restore, pending } = await floor(t);
  await hive.ensureAgent({ id: 'meredith-1', name: 'Meredith', provider: 'codex', cwd: root });
  for (let i = 0; i < 3; i++) writeMsg(dir('meredith-1', 'inbox'), `m${i}`, { subject: `for meredith ${i}` });
  writeMsg(dir('pam-1', 'inbox'), 'p0');
  patchReg((r) => { r.agents['meredith-1'].archived = true; r.agents['pam-1'].archived = true; });
  hive.mail.dispose();
  hive.migrateMail();
  assert.deepEqual(files('meredith-1', '.undelivered'), ['m0.json', 'm1.json', 'm2.json']);
  await restore('meredith-1');
  assert.deepEqual(files('meredith-1'), ['m0.json', 'm1.json', 'm2.json']);
  assert.deepEqual(files('meredith-1', '.undelivered'), []);
  const entries = hive.mail.ledger('meredith-1').entries;
  for (const id of ['m0', 'm1', 'm2']) assert.equal(entries[id].state, 'delivered', id);
  assert.deepEqual(pending('meredith-1'), ['m0', 'm1', 'm2']);
  const restored = rows('mail-undelivered-restored');
  assert.equal(restored.length, 1);
  assert.deepEqual({ agentId: restored[0].agentId, count: restored[0].count }, { agentId: 'meredith-1', count: 3 });
  assert.equal(hive.mail.ledger('meredith-1').entries.m0.legacy, false, 'never taken for a legacy first-touch import');
  assert.deepEqual(hive.undeliveredReport().items.map((i) => i.agentId), ['pam-1'], 'her items left the report');
  // Exactly once: a second restore, an un-archive or a respawn moves and logs nothing.
  await restore('meredith-1');
  hive.setArchived('meredith-1', false);
  hive.restoreUndelivered('meredith-1');
  assert.equal(rows('mail-undelivered-restored').length, 1);
  assert.deepEqual(files('meredith-1'), ['m0.json', 'm1.json', 'm2.json']);
  // pam via the IPC/realtime un-archive path.
  hive.setArchived('pam-1', false);
  assert.deepEqual(files('pam-1'), ['p0.json']);
  assert.equal(hive.mail.ledger('pam-1').entries.p0.state, 'delivered');
  assert.equal(hive.undeliveredReport().items.length, 0);
  hive.mail.flushAll();
  assert.ok(hive.logTail(5000).some((r) => r.kind === 'mail' && r.stage === 'delivered' && r.reason === 'undelivered-restored' && r.id === 'p0'));
});

test('0f1672: a returning file whose name is taken (inbox, .done or the ledger) gets a fresh <stem>.N; nothing is overwritten', async (t) => {
  const { hive, dir, files } = await floor(t);
  writeMsg(dir('pam-1', 'inbox', '.undelivered'), 'dup', { subject: 'the returning one' });
  writeMsg(dir('pam-1', 'inbox', '.undelivered'), 'done-dup', { subject: 'returning 2' });
  hive.send({ id: 'dup', to: 'pam-1', act: 'inform', subject: 'the live one', body: 'live' }, 'god-1');
  writeMsg(dir('pam-1', 'inbox', '.done'), 'done-dup');
  hive.setArchived('pam-1', true);
  hive.setArchived('pam-1', false);
  assert.deepEqual(files('pam-1'), ['done-dup.1.json', 'dup.1.json', 'dup.json']);
  assert.equal(JSON.parse(fs.readFileSync(dir('pam-1', 'inbox', 'dup.json'), 'utf8')).subject, 'the live one');
  assert.equal(hive.mail.ledger('pam-1').entries['dup.1'].subject, 'the returning one');
});

test('WIRING (Q31 pin): the migration runs BEFORE the orphan sweep, reads explicit archives, and the sweep records orphan', async (t) => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const body = src.slice(src.indexOf('function bootstrapHiveServices'));
  const mig = body.indexOf('hive.migrateMail()');
  const orphan = body.indexOf('archiveOrphanedAgents();');
  assert.ok(mig > 0 && orphan > mig, 'migrateMail before archiveOrphanedAgents');
  const sweep = src.slice(src.indexOf('function archiveOrphanedAgents(): void {'), src.indexOf('function ensureDefaultMissions'));
  assert.match(sweep, /if \(a\.archived\) continue;/, 'an agent already archived keeps its reason (or its reason-less 1.1.74 archive)');
  assert.match(sweep, /hive\.setArchived\(id, true, 'orphan'\);/);
  const hive = codeOnly(readSource('src/main/hive.ts'), 'hive.ts');
  assert.match(hive, /\.map\(\(id\) => \(\{ id, archived: archivedForMail\(reg\.agents\[id\]\) \}\)\);\s*return runMailMigration\(/);
  // Behaviour: had the sweep run first, a live-at-quit worker would read orphan, never explicit.
  const { hive: h, dir, files } = await floor(t);
  writeMsg(dir('pam-1', 'inbox'), 'q0');
  h.setArchived('pam-1', true, 'orphan');
  h.mail.dispose();
  h.migrateMail();
  assert.deepEqual(files('pam-1'), ['q0.json']);
  assert.deepEqual(files('pam-1', '.undelivered'), []);
});

// ————————————————————————————————————————————————— Jim M1: the report survives a failed pass

test('Jim M1: one archived agent fails mid-move: no marker, the report still lists every file moved; the retry completes it', async (t) => {
  const { hive, root, dir, files, patchReg } = await floor(t);
  for (let i = 0; i < 3; i++) writeMsg(dir('pam-1', 'inbox'), `p${i}`);
  writeMsg(dir('jim-1', 'inbox'), 'j0');
  patchReg((r) => { r.agents['pam-1'].archived = true; r.agents['jim-1'].archived = true; });
  hive.mail.dispose();
  const real = fs.renameSync;
  fs.renameSync = function (src, dst, ...rest) {
    if (String(src).endsWith(`${path.sep}p1.json`) && String(dst).includes('.undelivered')) { const e = new Error('EACCES: av lock'); e.code = 'EACCES'; throw e; }
    return real.call(this, src, dst, ...rest);
  };
  let first;
  try { first = hive.migrateMail(); } finally { fs.renameSync = real; }
  assert.equal(first.ran, true);
  assert.equal(fs.existsSync(path.join(root, 'state', 'mail', 'migration.json')), false, 'no marker after an error');
  assert.deepEqual(files('pam-1'), ['p1.json']);
  assert.deepEqual(files('pam-1', '.undelivered'), ['p0.json', 'p2.json'], 'the other files still moved');
  const key = (r) => r.items.map((i) => `${i.agentId}/${i.id}`).sort();
  assert.deepEqual(key(hive.undeliveredReport()), ['jim-1/j0', 'pam-1/p0', 'pam-1/p2'], 'every moved file is in the report');
  assert.ok(hive.logTail(5000).some((r) => r.kind === 'mail-migration-error' && r.agentId === 'pam-1'));
  // The retry (next boot) moves the rest and the report is complete, with no duplicates.
  const second = hive.migrateMail();
  assert.equal(second.ran, true);
  assert.equal(fs.existsSync(path.join(root, 'state', 'mail', 'migration.json')), true);
  assert.deepEqual(key(hive.undeliveredReport()), ['jim-1/j0', 'pam-1/p0', 'pam-1/p1', 'pam-1/p2']);
});

test('Jim M1: a pass interrupted between the renames and the report write (files already in .undelivered/) loses nothing on the retry', async (t) => {
  const { hive, dir, files, patchReg } = await floor(t);
  writeMsg(dir('pam-1', 'inbox', '.undelivered'), 'moved-before-crash', { subject: 'moved by the crashed pass' });
  writeMsg(dir('pam-1', 'inbox'), 'still-in-inbox');
  patchReg((r) => { r.agents['pam-1'].archived = true; });
  hive.mail.dispose();
  hive.migrateMail();
  assert.deepEqual(files('pam-1', '.undelivered'), ['moved-before-crash.json', 'still-in-inbox.json']);
  const items = hive.undeliveredReport().items;
  assert.deepEqual(items.map((i) => i.id).sort(), ['moved-before-crash', 'still-in-inbox']);
  assert.equal(items.find((i) => i.id === 'moved-before-crash').subject, 'moved by the crashed pass');
});

// ————————————————————————————————————————————————— 1c7544 + Q34: work-order leftovers

async function workOrderFloor(t) {
  const w = await floor(t);
  await w.hive.ensureAgent({ id: 'kev-1', name: 'Kevin', provider: 'claude', cwd: w.home });
  return w;
}

test('1c7544: a pre-1.1.75 leftover in a work-order agent\'s inbox goes out as a normal terminal work order; COMMITTED = acted via work-order + archived to .done', async (t) => {
  const { hive, dir, files, patchReg, emitted, rows } = await workOrderFloor(t);
  writeMsg(dir('kev-1', 'inbox'), 'old-1', { act: 'request', subject: 'left from 1.1.74', body: 'the whole body' });
  patchReg((r) => { r.agents['kev-1'].provider = 'kimi'; });
  hive.mail.dispose();
  hive.migrateMail(); // the §7.1 first touch imports it (delivered, legacy)
  assert.equal(hive.mail.ledger('kev-1').entries['old-1'].state, 'delivered');
  const t0 = 1_000_000;
  assert.deepEqual(hive.handOffWorkOrderLeftovers('kev-1', t0).handedOff, ['old-1']);
  assert.equal(emitted.length, 1);
  assert.deepEqual({ id: emitted[0].id, to: emitted[0].to, subject: emitted[0].subject, body: emitted[0].body }, { id: 'old-1', to: 'kev-1', subject: 'left from 1.1.74', body: 'the whole body' });
  assert.deepEqual(hive.handOffWorkOrderLeftovers('kev-1', t0 + 1000).handedOff, [], 'not re-offered while the renderer holds it');
  // The renderer confirms the PTY write.
  assert.equal(hive.recordWorkOrderDelivered('kev-1', 'old-1'), true);
  const e = hive.mail.ledger('kev-1').entries['old-1'];
  assert.deepEqual({ state: e.state, via: e.via }, { state: 'acted', via: 'work-order' });
  hive.mail.flushAll();
  assert.deepEqual(files('kev-1'), [], 'the harness moved it; the agent moves nothing');
  assert.deepEqual(files('kev-1', '.done'), ['old-1.json']);
  assert.ok(rows('mail').some((r) => r.stage === 'acted' && r.via === 'work-order' && r.reason === 'work-order-leftover' && r.ids[0] === 'old-1'));
  assert.deepEqual(hive.handOffWorkOrderLeftovers('kev-1', t0 + 60 * 60_000).handedOff, []);
  assert.equal(emitted.length, 1);
  assert.deepEqual(hive.mail.backlog('kev-1'), []);
});

test('1c7544: a provider switch (mail delivered while it ran claude, then it became a work-order agent) hands the files off, then archives them', async (t) => {
  const { hive, files, patchReg, emitted } = await workOrderFloor(t);
  hive.send({ id: 'sw-1', to: 'kev-1', act: 'inform', subject: 'one', body: 'b1' }, 'god-1');
  hive.send({ id: 'sw-2', to: 'kev-1', act: 'request', subject: 'two', body: 'b2', requires_reply: true }, 'god-1');
  assert.deepEqual(files('kev-1'), ['sw-1.json', 'sw-2.json']);
  patchReg((r) => { r.agents['kev-1'].provider = 'crush'; });
  assert.deepEqual(hive.handOffWorkOrderLeftovers('kev-1', 5).handedOff, ['sw-1', 'sw-2']);
  assert.deepEqual(emitted.map((m) => [m.id, m.body]), [['sw-1', 'b1'], ['sw-2', 'b2']]);
  hive.recordWorkOrderDelivered('kev-1', 'sw-1');
  hive.recordWorkOrderDelivered('kev-1', 'sw-2');
  hive.mail.flushAll();
  assert.deepEqual(files('kev-1'), []);
  assert.deepEqual(files('kev-1', '.done'), ['sw-1.json', 'sw-2.json']);
  assert.deepEqual(hive.mail.openRequests('kev-1').map((o) => o.entry.id), ['sw-2'], 'acted, but its reply is still owed');
});

test('Q34 bound: an unconfirmed leftover is re-announced at most 3 times (5/10/20 min), then stops, stays listed, one loud row', async (t) => {
  const { hive, dir, files, patchReg, emitted, rows, setEmitOk } = await workOrderFloor(t);
  writeMsg(dir('kev-1', 'inbox'), 'stuck-1', { subject: 'nobody confirms me' });
  patchReg((r) => { r.agents['kev-1'].provider = 'kimi'; });
  const MIN = 60_000;
  // The renderer is down: a failed emit is not an announcement.
  setEmitOk(false);
  assert.deepEqual(hive.handOffWorkOrderLeftovers('kev-1', 0).handedOff, []);
  setEmitOk(true);
  const at = [1, 1 + 5 * MIN, 1 + 15 * MIN, 1 + 35 * MIN];
  for (const now of at) assert.deepEqual(hive.handOffWorkOrderLeftovers('kev-1', now).handedOff, ['stuck-1'], `announce at ${now}`);
  // Between the due times nothing goes out.
  assert.deepEqual(hive.handOffWorkOrderLeftovers('kev-1', 1 + 36 * MIN).handedOff, []);
  assert.equal(emitted.length, 4, 'the first announcement + 3 re-announcements');
  assert.equal(rows('mail-work-order-file-stuck').length, 0);
  const r = hive.handOffWorkOrderLeftovers('kev-1', 1 + 70 * MIN);
  assert.deepEqual(r, { handedOff: [], stuck: ['stuck-1'] });
  const row = rows('mail-work-order-file-stuck');
  assert.equal(row.length, 1);
  assert.deepEqual({ agentId: row[0].agentId, ids: row[0].ids, announces: row[0].announces }, { agentId: 'kev-1', ids: ['stuck-1'], announces: 4 });
  for (let h = 2; h < 30; h++) hive.handOffWorkOrderLeftovers('kev-1', h * 60 * MIN);
  assert.equal(emitted.length, 4, 'no endless loop');
  assert.equal(rows('mail-work-order-file-stuck').length, 1, 'one loud row');
  assert.deepEqual(files('kev-1'), ['stuck-1.json'], 'the file stays listed');
  assert.ok(hive.inbox('kev-1').some((m) => m.id === 'stuck-1'));
  assert.equal(hive.inboxBacklog('kev-1'), 1);
});

test('WIRING (1c7544): the wake beat hands work-order leftovers off; a work-order agent is never nudged about files', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(src, /if \(mode !== 'work-order'\) hive\.mail\.reconcileInbox\(agentId, \{ moveIsHandled: noStop \}\);\s*(\/\/[^\n]*\n\s*)*else hive\.handOffWorkOrderLeftovers\(agentId\);/);
  assert.deepEqual(coordinatorPendingIds('x', { mode: () => 'work-order', pending: () => [{ id: 'a' }], skipped: () => [], files: () => ['f1'] }), []);
});
