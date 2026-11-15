'use strict';
require('./tools/own-job.cjs');
/**
 * STARTUP-FREEZE-104 A1: the startup mail-card catch-up on a floor the size of the Human's (about 30k
 * handled-mail files). 1.1.103/104 re-read every mail file on every start in per-folder sync blocks
 * (5-25 s each, cold cache). Proven here, through the catch-up's own op seam (runOp) and an fs spy:
 * - a second start reads 0 old mail files (sync or async) and records nothing;
 * - a third start reads only the mails delivered since, and records them;
 * - a mail moved from inbox to inbox/.done is not read again;
 * - an unreadable scan manifest is a full read that still gives the same index;
 * - nothing runs in the caller's turn, and main pauses once it worked CATCHUP_SLICE_MS (an injected clock).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const MC = loadTs('src/main/mailCards.ts');
/** The real read, kept before any spy: the test's own op runner is not main's code. */
const realReadFileSync = fs.readFileSync;
const T = '2026-10-26T20:00:00.000Z';
const MAIL_FILES = 30000; // two files per mail: the sender's .sent copy and the recipient's inbox/.done copy
const AGENTS = ['god-1', 'jim-1', 'pam-1', 'dwight-1'];

const tmp = (t, tag) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `md-sf104-a1-${tag}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const pad = (n) => String(n).padStart(6, '0');
function deliver(root, i, { folder = '.done' } = {}) {
  const from = AGENTS[i % AGENTS.length];
  const to = AGENTS[(i + 1) % AGENTS.length];
  const id = `2026-10-01T00-00-00-000Z-${pad(i)}`;
  const m = { id, from, to: to === 'god-1' ? 'god' : to, act: 'inform', subject: `s${i}`, body: `b${i}`, created_at: `2026-10-01T00:00:00.${pad(i).slice(-3)}Z`, ...(i % 3 === 0 ? { card: 'CARD-ONE', conversation: `c${i}` } : {}) };
  fs.writeFileSync(path.join(root, 'agents', to, 'inbox', folder, `${id}.json`), JSON.stringify(m));
  fs.writeFileSync(path.join(root, 'agents', from, 'outbox', '.sent', `out-${id}.json`), JSON.stringify({ to: m.to, act: m.act, subject: m.subject, body: m.body }));
  return { id, to };
}

function bigFloor(t, tag, mails) {
  const root = path.join(tmp(t, tag), 'hive');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'CARD-ONE' }] }));
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId: 'god-1', agents: {} }));
  for (const a of AGENTS) {
    fs.mkdirSync(path.join(root, 'agents', a, 'inbox', '.done'), { recursive: true });
    fs.mkdirSync(path.join(root, 'agents', a, 'outbox', '.sent'), { recursive: true });
  }
  for (let i = 0; i < mails; i++) deliver(root, i);
  return root;
}

/** A mail file: a .sent copy or an inbox copy (the files 1.1.104 re-read on every start). */
const isMailFile = (p) => /[\\/]agents[\\/][^\\/]+[\\/](outbox[\\/]\.sent|inbox)[\\/]/.test(String(p)) && String(p).endsWith('.json');

/** One catch-up with every async op counted, and every sync mail-file read counted by an fs spy. */
async function start(root, extra = {}) {
  const rows = [];
  const ops = { read: [], readdir: 0, write: [] };
  let pauses = 0;
  const realRead = fs.readFileSync;
  const syncMailReads = [];
  fs.readFileSync = function (p, ...rest) { if (isMailFile(p)) syncMailReads.push(String(p)); return realRead.call(this, p, ...rest); };
  try {
    const counts = await MC.startupMailCardCatchUp(root, {
      log: (r) => rows.push(r), now: () => T, pause: async () => { pauses++; },
      runOp: async (op) => {
        if ('read' in op) ops.read.push(op.read); else if ('readdir' in op) ops.readdir++; else if ('save' in op) ops.write.push(op.save);
        return extra.runOp ? extra.runOp(op) : realOp(op);
      },
      ...(extra.clock ? { clock: extra.clock } : {}),
    });
    return { counts, rows, ops, pauses, syncMailReads, mailReads: ops.read.filter(isMailFile) };
  } finally { fs.readFileSync = realRead; }
}
async function realOp(op) {
  if ('readdir' in op) { try { return fs.readdirSync(op.readdir); } catch { return []; } }
  if ('read' in op) { try { return realReadFileSync(op.read, 'utf8'); } catch { return undefined; } }
  fs.mkdirSync(path.dirname(op.save), { recursive: true });
  fs.writeFileSync(op.save, op.text);
  return undefined;
}

test(`a ${MAIL_FILES}-file floor: the first start reads it all once; a second start reads 0 old mail files and records nothing; a third reads only the new mail`, { timeout: 600000 }, async (t) => {
  const mails = MAIL_FILES / 2;
  const root = bigFloor(t, 'big', mails);
  const first = await start(root);
  assert.equal(first.counts.recorded, mails, `the first start indexes every mail: ${JSON.stringify(first.rows)}`);
  assert.equal(first.mailReads.length, MAIL_FILES, 'the first start reads each mail file once');
  assert.equal(first.syncMailReads.length, 0, 'MUTANT: no mail file is read synchronously on main');
  assert.ok(first.ops.write.some((w) => w.includes(`${path.sep}_scan${path.sep}`)), 'the scan manifest is written');

  const second = await start(root);
  assert.deepEqual([second.counts.recorded, second.counts.already, second.counts.mails], [0, mails, mails], `MUTANT: the second start records nothing: ${JSON.stringify(second.rows)}`);
  assert.equal(second.mailReads.length, 0, `MUTANT: a second start reads 0 old mail files (read ${second.mailReads.length}: ${second.mailReads.slice(0, 3).join(', ')})`);
  assert.equal(second.syncMailReads.length, 0, 'MUTANT: and none synchronously');
  assert.deepEqual(second.ops.write, [], 'an unchanged floor writes nothing');
  assert.ok(second.ops.read.length <= AGENTS.length + 2, `only the manifests, _links.jsonl and registry.json are read (${second.ops.read.length})`);

  // mail delivered while the app was closed, and one copy moved from inbox to inbox/.done
  const fresh = [deliver(root, mails), deliver(root, mails + 1, { folder: '' })];
  const moved = deliver(root, mails + 2, { folder: '' });
  const third = await start(root);
  assert.equal(third.counts.recorded, 3, JSON.stringify(third.rows));
  assert.equal(third.mailReads.length, 6, `the third start reads only the 3 new mails' 6 files: ${third.mailReads.join(', ')}`);
  fs.renameSync(path.join(root, 'agents', moved.to, 'inbox', `${moved.id}.json`), path.join(root, 'agents', moved.to, 'inbox', '.done', `${moved.id}.json`));
  const fourth = await start(root);
  assert.deepEqual([fourth.counts.recorded, fourth.mailReads.length], [0, 0], 'MUTANT: a copy moved to inbox/.done is known by its name, not read again');
  assert.ok(fresh.every((f) => MC.readProvenMail(root).mails.some((m) => m.id === f.id)));
});

test('an unreadable scan manifest is a full read of that agent that gives the same index (the manifest is a cache, never the record)', { timeout: 120000 }, async (t) => {
  const root = bigFloor(t, 'torn', 200);
  await start(root);
  const links = fs.readFileSync(path.join(root, 'state', 'mail-cards', '_links.jsonl'), 'utf8');
  const scan = path.join(root, 'state', 'mail-cards', '_scan', 'jim-1.json');
  const good = fs.readFileSync(scan, 'utf8');
  fs.writeFileSync(scan, good.slice(0, 40));
  const again = await start(root);
  assert.deepEqual([again.counts.recorded, again.counts.already], [0, 200]);
  assert.ok(again.mailReads.length > 0 && again.mailReads.every((p) => p.includes(`${path.sep}jim-1${path.sep}`)), `only jim-1's files are read again: ${again.mailReads.filter((p) => !p.includes(`${path.sep}jim-1${path.sep}`)).slice(0, 3)}`);
  assert.equal(fs.readFileSync(scan, 'utf8'), good, 'the manifest is rewritten as it was');
  assert.equal(fs.readFileSync(path.join(root, 'state', 'mail-cards', '_links.jsonl'), 'utf8'), links, 'the index is unchanged');
});

test('nothing runs in the caller\'s turn, and main pauses whenever it worked CATCHUP_SLICE_MS (an injected clock)', { timeout: 120000 }, async (t) => {
  const root = bigFloor(t, 'slice', 300);
  // the caller's turn: no op before the first await returns control
  let opsInTurn = 0;
  const p = MC.startupMailCardCatchUp(root, { log: () => {}, now: () => T, runOp: async (op) => { opsInTurn++; return realOp(op); } });
  assert.equal(opsInTurn, 0, 'MUTANT: the catch-up never reads in the caller\'s turn (claimsEndpoint can be reached from an IPC)');
  await p;
  // the budget: every clock read advances 1 ms, so main pauses about every CATCHUP_SLICE_MS reads
  let now = 0;
  const fresh = bigFloor(t, 'slice2', 300);
  const s = await start(fresh, { clock: () => (now += 1) });
  const ops = s.ops.read.length + s.ops.readdir + s.ops.write.length;
  assert.equal(MC.CATCHUP_SLICE_MS, 8);
  assert.ok(s.pauses >= Math.floor(ops / MC.CATCHUP_SLICE_MS), `MUTANT: main pauses on the time budget, not only per folder (${s.pauses} pauses, ${ops} ops)`);
  // a clock that never moves: only the hard pause points remain (per folder / per CATCHUP_SLICE), far fewer
  const still = await start(bigFloor(t, 'slice3', 300), { clock: () => 0 });
  assert.ok(still.pauses < s.pauses / 4, `the budget is what adds the pauses (${still.pauses} vs ${s.pauses})`);
});
