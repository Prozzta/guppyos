'use strict';
require('./tools/own-job.cjs');

/**
 * MAILCARD catch-up at every app start (god 38f4b0, Jim 414b4c): the product builds and keeps
 * hive/state/mail-cards current with no manual step (src/main/mailCards.ts startupMailCardCatchUp,
 * called from the claims startup block of src/main/index.ts). Covered here:
 *  - a fresh upgraded floor: the first start builds the index, byte-equal to what the backfill
 *    script (scripts/claims-mailcard-backfill.cjs) writes on a copy; pausing between steps; one
 *    `mailcards-backfill` log row with the counts; a second start records nothing; nothing outside
 *    state/mail-cards is written;
 *  - mail delivered while the app was closed is indexed on the next start, same link rules;
 *  - the derived writer starts only once the catch-up settled, even a slowed one, so what it reads
 *    equals the sync backfill's; a failed catch-up logs, resolves null, and still lets it start;
 *  - index.ts runs the catch-up through the router's own index and starts the derived writer only
 *    through the sequencer (no bare timer).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const MC = loadTs('src/main/mailCards.ts');
const { readDoneMails } = loadTs('src/main/claims/derivedWriter.ts');
const { mailBodyHash } = loadTs('src/main/mailLedger.ts');

const T = '2026-10-26T20:00:00.000Z';
const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'claims-mailcard-backfill.cjs');

const tmp = (t, tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `md-mc-startup-${tag}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); }
const readLines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
const ids = (n) => `2026-10-25T00-00-00-000Z-00000${n}`;

/** Every file under `dir` (relative posix path -> bytes), sorted. */
function treeBytes(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/**
 * An upgraded floor: mail delivered before any mail-cards index existed. d1: a two-party done mail
 * (jim's .sent + god's inbox/.done, no MailLedger entry: only the index gives it to the derived
 * writer); r1: god's reply to it (inherits the card); l1: a MailLedger done mail with a hashing inbox
 * copy (card field); u1: a two-party mail naming no card (unlinked); f1: a forged inbox file.
 */
function upgradedFloor(t, tag) {
  const root = path.join(tmp(t, tag), 'hive');
  writeJson(path.join(root, 'tasks.json'), { tasks: [{ id: 'CARD-ONE' }, { id: 'CARD-TWO' }] });
  writeJson(path.join(root, 'registry.json'), { godId: 'god-1', agents: {} });
  const mail = (id, from, to, extra) => ({ id, from, to, act: 'inform', subject: `s-${id}`, body: `b-${id}`, created_at: `2026-10-0${id.slice(-1)}T00:00:00Z`, ...extra });
  const deliverTo = (m, to, { sent = true, done = true } = {}) => {
    writeJson(path.join(root, 'agents', to, 'inbox', done ? '.done' : '', `${m.id}.json`), m);
    if (sent) writeJson(path.join(root, 'agents', m.from, 'outbox', '.sent', `out-${m.id}.json`), { to: m.to, act: m.act, subject: m.subject, body: m.body });
  };
  for (const a of ['god-1', 'jim-1', 'pam-1']) fs.mkdirSync(path.join(root, 'agents', a, 'inbox', '.done'), { recursive: true });
  const d1 = mail(ids(1), 'jim-1', 'god', { act: 'done', card: 'CARD-ONE', conversation: 'c1', subject: 'CARD-ONE shipped', body: 'done sha 1234abc' });
  const r1 = mail(ids(2), 'god-1', 'jim-1', { in_reply_to: d1.id, conversation: 'c1' });
  const u1 = mail(ids(3), 'god-1', 'pam-1', { subject: 'no card named', body: 'plain words' });
  const f1 = mail(ids(4), 'jim-1', 'pam-1', { card: 'CARD-TWO', subject: 'forged CARD-TWO' });
  deliverTo(d1, 'god-1'); deliverTo(r1, 'jim-1'); deliverTo(u1, 'pam-1'); deliverTo(f1, 'pam-1', { sent: false });
  const l1 = ids(5);
  writeJson(path.join(root, 'state', 'mail', 'pam-1.json'), { entries: { [l1]: { id: l1, from: 'god-1', act: 'done', subject: 'CARD-TWO shipped', bodyHash: mailBodyHash('done sha abcd123'), cardId: 'CARD-TWO', seq: 1, deliveredAt: Date.parse('2026-10-05T00:00:00Z') } } });
  writeJson(path.join(root, 'agents', 'pam-1', 'inbox', '.done', `${l1}.json`), { id: l1, from: 'god-1', act: 'done', subject: 'CARD-TWO shipped', body: 'done sha abcd123', card: 'CARD-TWO' });
  return { root, d1, r1, u1, f1, l1, deliverTo, mail };
}

const runScript = (root) => spawnSync(process.execPath, [SCRIPT, '--hive', root, '--now', T], {
  encoding: 'utf8',
  env: { ...process.env, NODE_OPTIONS: '', GUPPY_FILE_JOB_EXE: '', GUPPY_FILE_JOB_DIR: '', NODE_TEST_CONTEXT: '', MUNDER_HIVE_ROOT: path.join(os.tmpdir(), 'md-no-such-hive') },
});

const catchUp = (root, extra = {}) => {
  const rows = [];
  let pauses = 0;
  const p = MC.startupMailCardCatchUp(root, { log: (r) => rows.push(r), now: () => T, pause: async () => { pauses++; }, ...extra });
  return { promise: p, rows, pauses: () => pauses };
};

test('a fresh upgraded floor: the first start builds the index with no manual step, byte-equal to the backfill script on a copy, pausing between steps; one counts row; a second start records nothing and nothing outside state/mail-cards changes', async (t) => {
  const A = upgradedFloor(t, 'script');
  const B = upgradedFloor(t, 'app');
  const script = runScript(A.root);
  assert.equal(script.status, 0, script.stderr);
  assert.equal(JSON.parse(script.stdout).recorded, 4, 'the script: d1, r1, u1, l1 (the forged copy never enters)');
  const before = treeBytes(B.root);
  assert.equal(fs.existsSync(path.join(B.root, 'state', 'mail-cards')), false, 'the upgraded floor has no index');
  const c = catchUp(B.root);
  const counts = await c.promise;
  assert.ok(counts && counts.recorded === 4, `MUTANT: the catch-up built the index: ${JSON.stringify(counts)}`);
  assert.ok(c.pauses() >= 4, `MUTANT: the catch-up pauses between steps (${c.pauses()} pauses): startup is never blocked for the whole read`);
  assert.deepEqual(treeBytes(path.join(B.root, 'state', 'mail-cards')), treeBytes(path.join(A.root, 'state', 'mail-cards')), 'the app start and the script write one index, byte for byte');
  const L = Object.fromEntries(readLines(path.join(B.root, 'state', 'mail-cards', '_links.jsonl')).map((r) => [r.mailId, r]));
  assert.deepEqual([L[B.d1.id].method, L[B.d1.id].trust, L[B.d1.id].cards], ['field', 'two-party', ['CARD-ONE']]);
  assert.deepEqual([L[B.r1.id].method, L[B.r1.id].cards], ['reply', ['CARD-ONE']]);
  assert.deepEqual([L[B.l1].method, L[B.l1].trust], ['field', 'mail-ledger']);
  assert.equal(L[B.u1.id].method, 'none');
  assert.equal(L[B.f1.id], undefined, 'the forged copy');
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0].kind, MC.MAILCARDS_BACKFILL_ROW);
  assert.deepEqual([c.rows[0].mails, c.rows[0].recorded, c.rows[0].already, c.rows[0].covered, c.rows[0].unlinked], [4, 4, 0, 3, 1]);
  assert.deepEqual(c.rows[0].excluded, { 'no-sender-copy': 1 });
  assert.ok(Number.isFinite(c.rows[0].ms) && c.rows[0].steps >= 4, 'the row says how long and how many steps');
  // nothing outside state/mail-cards was written: mail, ledgers and registry are read only
  const after = treeBytes(B.root);
  const outside = (tree) => Object.fromEntries(Object.entries(tree).filter(([p]) => !p.startsWith('state/mail-cards/')));
  assert.deepEqual(outside(after), outside(before), 'only state/mail-cards changed');
  // second start: a no-op
  const index = treeBytes(path.join(B.root, 'state', 'mail-cards'));
  const again = catchUp(B.root);
  const c2 = await again.promise;
  assert.deepEqual([c2.recorded, c2.already], [0, 4], `MUTANT: the second start records nothing: ${JSON.stringify(c2)}`);
  assert.deepEqual(treeBytes(path.join(B.root, 'state', 'mail-cards')), index, 'the index is unchanged after the second start');
  assert.deepEqual([again.rows[0].kind, again.rows[0].recorded, again.rows[0].already], [MC.MAILCARDS_BACKFILL_ROW, 0, 4]);
});

test('mail delivered while the app was closed is indexed on the next start, under the same link rules (a reply inherits its card); the earlier records stay as written', async (t) => {
  const B = upgradedFloor(t, 'closed');
  await catchUp(B.root).promise;
  const linksBefore = fs.readFileSync(path.join(B.root, 'state', 'mail-cards', '_links.jsonl'), 'utf8');
  // the app was closed; the router of another build delivered a reply to d1 (jim's inbox + god's sent copy)
  const d2 = B.mail(ids(6), 'god-1', 'jim-1', { in_reply_to: B.d1.id, conversation: 'c1', act: 'done', body: 'merged' });
  B.deliverTo(d2, 'jim-1', { done: false });
  const c = catchUp(B.root);
  const counts = await c.promise;
  assert.deepEqual([counts.recorded, counts.already], [1, 4], `MUTANT: the new mail is indexed on the next start: ${JSON.stringify(counts)}`);
  const links = fs.readFileSync(path.join(B.root, 'state', 'mail-cards', '_links.jsonl'), 'utf8');
  assert.ok(links.startsWith(linksBefore), 'append only: the earlier link records are untouched');
  const rec = readLines(path.join(B.root, 'state', 'mail-cards', '_links.jsonl')).find((r) => r.mailId === d2.id);
  assert.deepEqual([rec.method, rec.cards, rec.trust, rec.at], ['reply', ['CARD-ONE'], 'two-party', T]);
  const rows = readLines(path.join(B.root, 'state', 'mail-cards', 'card-one.jsonl')).filter((r) => r.id === d2.id);
  assert.deepEqual(rows.map((r) => [r.to, r.act, r.cardFrom]), [['jim-1', 'done', 'reply']]);
});

test('the derived writer starts only once the catch-up settled, even a slowed one: what it reads equals the sync backfill\'s; a failed catch-up logs, resolves null and still lets it start', async (t) => {
  // the reference: the sync backfill (the script's path), then the derived writer's done-mail read
  const C = upgradedFloor(t, 'sync');
  MC.backfillMailCards(C.root, T);
  const expected = readDoneMails(C.root).map((m) => m.id).sort();
  assert.ok(expected.includes(C.d1.id) && expected.includes(C.l1), 'the index gives the two-party done mail the MailLedger lacks');
  // the app start: a slowed catch-up (every pause sleeps) and the derived start sequenced after it
  const D = upgradedFloor(t, 'slow');
  let settled = false;
  const slow = catchUp(D.root, { pause: () => new Promise((r) => setTimeout(r, 5)) });
  const p = slow.promise.then((c) => { settled = true; return c; });
  let seenAtStart = null;
  let settledAtStart = null;
  await MC.startAfterMailCardCatchUp(p, () => { settledAtStart = settled; seenAtStart = readDoneMails(D.root).map((m) => m.id).sort(); });
  assert.equal(settledAtStart, true, 'MUTANT: the derived writer started beside the running catch-up');
  assert.deepEqual(seenAtStart, expected, 'MUTANT: the derived writer read a partial index (its ledger would depend on timing)');
  // a failed catch-up: the failure row, null, and the derived writer still starts
  const E = upgradedFloor(t, 'fail');
  // MAILCARD-CATCHUP-RACE adds the index's catch-up hooks (begin, deferred ids, settle) to the stub.
  const broken = { linkOf: () => null, conversationCards: () => [], record: () => { throw new Error('disk full'); }, beginCatchUp: () => {}, isDeferred: () => false, endCatchUp: () => ({ queued: 0, recorded: 0, failed: 0 }) };
  const f = catchUp(E.root, { index: broken });
  let started = 0;
  await MC.startAfterMailCardCatchUp(f.promise, () => { started++; });
  assert.equal(await f.promise, null, 'a failed catch-up resolves null, never throws');
  assert.equal(started, 1, 'the derived writer starts after a failed catch-up too');
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].kind, MC.MAILCARDS_BACKFILL_FAILED_ROW, `MUTANT: the failure is logged: ${JSON.stringify(f.rows)}`);
  assert.match(f.rows[0].error, /disk full/);
  assert.equal(fs.existsSync(path.join(E.root, 'state', 'mail-cards')), false, 'nothing was written');
  // a rejected catch-up promise still starts the derived writer
  let started2 = 0;
  await MC.startAfterMailCardCatchUp(Promise.reject(new Error('x')), () => { started2++; });
  assert.equal(started2, 1);
});

test('index.ts: the claims startup block runs the catch-up through the router\'s own index (hive.mailCardIndexFor) and starts the derived writer only through the sequencer, never on a bare timer', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  const run = src.indexOf("const mailCardCatchUp = startupMailCardCatchUp(root, { log: (row) => hive.appendLog(row), index: hive.mailCardIndexFor(root) });");
  const seq = src.indexOf('void startAfterMailCardCatchUp(mailCardCatchUp, () => derivedClaims?.start());');
  assert.ok(run > 0, 'MUTANT: the startup block runs the catch-up through the router\'s index');
  assert.ok(seq > run, 'MUTANT: the derived writer starts through the sequencer, after the catch-up line');
  assert.doesNotMatch(src, /setImmediate\(\(\) => derivedClaims\?\.start\(\)\)/, 'MUTANT: no bare timer starts the derived writer');
  assert.equal((src.match(/derivedClaims\?\.start\(\)/g) || []).length, 1, 'one start call');
  assert.match(src, /import \{ startAfterMailCardCatchUp, startupMailCardCatchUp \} from '\.\/mailCards';/);
  const hive = fs.readFileSync(path.join(REPO, 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(hive, /mailCardIndexFor\(root: string\): MailCardIndex \| null \{ return this\.root\(\) === root \? this\.mailCards\(\) : null; \}/, 'the router hands its own index out');
  const mc = fs.readFileSync(path.join(REPO, 'src', 'main', 'mailCards.ts'), 'utf8');
  assert.match(mc, /const pause = d\.pause \?\? \(\(\) => new Promise<void>\(\(r\) => setImmediate\(r\)\)\);/, 'the default pause is a macrotask turn');
  assert.match(mc, /export function backfillMailCards\(hiveRoot: string, now: string\): MailCardBackfillCounts \{\r?\n\s+return drain\(backfillMailCardSteps\(hiveRoot, now\)\);/, 'the script path and the startup path are one generator (CRLF checkouts too)');
});
