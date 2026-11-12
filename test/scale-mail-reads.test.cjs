'use strict';
require('./tools/own-job.cjs');

// SCALE-MESSAGES-INDEX (A10, IPC hive:messages -> voiceMessages) and SCALE-DONE-STAT (A11, IPC
// hive:inbox -> mailHistory, polled every ~3 s): a repeat call reads and stats NO old mail file
// (fs spy), a new file costs one stat + its own read, and the answers are identical to the
// pre-SCALE full scan (a reference copy below) and to a cold HiveManager on the same floor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-scale-mail-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager, redactSecrets } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const made = [];
  const mk = () => { const h = new HiveManager(() => home, () => true); made.push(h); return h; };
  const hive = mk();
  t.after(() => { for (const h of made) h.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  const dir = (id, ...p) => path.join(hive.root(), 'agents', id, ...p);
  fs.mkdirSync(dir('god-1', 'outbox', '.sent'), { recursive: true });
  fs.mkdirSync(dir('andy-1', 'outbox', '.sent'), { recursive: true });
  return { hive, dir, cold: mk };
}

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (i) => new Date(T0 + i * 60_000).toISOString();
/** A mail file with a set mtime (i minutes after T0), as the harness leaves it after the move. */
function put(file, msg, i) {
  fs.writeFileSync(file, typeof msg === 'string' ? msg : JSON.stringify(msg));
  const at = new Date(T0 + i * 60_000);
  fs.utimesSync(file, at, at);
}
const mail = (id, i, extra = {}) => ({ id, from: 'god-1', to: 'andy-1', act: 'inform', subject: `s ${id}`, body: `b ${id} token=abcdef123456`, conversation: 'c', created_at: iso(i), ...extra });

/** Records every path the product code stats, lists or reads while `fn` runs. */
function spy(fn) {
  const seen = { stat: [], read: [], readdir: [] };
  const orig = { statSync: fs.statSync, readFileSync: fs.readFileSync, readdirSync: fs.readdirSync };
  fs.statSync = function (p, ...a) { seen.stat.push(String(p)); return orig.statSync.call(this, p, ...a); };
  fs.readFileSync = function (p, ...a) { seen.read.push(String(p)); return orig.readFileSync.call(this, p, ...a); };
  fs.readdirSync = function (p, ...a) { seen.readdir.push(String(p)); return orig.readdirSync.call(this, p, ...a); };
  try { return { out: fn(), seen }; } finally { Object.assign(fs, orig); }
}
const under = (dirs) => (p) => dirs.some((d) => p.startsWith(d + path.sep));

// The pre-SCALE voiceMessages, verbatim minus types: every file of every folder parsed per call.
function referenceVoice(hive, opts = {}) {
  const root = hive.root();
  const agentsDir = path.join(root, 'agents');
  const listMessages = (d) => {
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith('.json')).sort()
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } })
      .filter((m) => m !== null);
  };
  const wantId = typeof opts.id === 'string' ? opts.id.trim() : '';
  const onlyAgent = typeof opts.agentId === 'string' ? opts.agentId.trim() : '';
  const includeArchived = opts.includeArchived !== false;
  const owners = onlyAgent ? [onlyAgent] : fs.readdirSync(agentsDir).filter((id) => !id.startsWith('.') && fs.existsSync(path.join(agentsDir, id)));
  const seen = new Set();
  const out = [];
  for (const owner of owners) {
    const base = path.join(agentsDir, owner);
    const folders = [{ dir: path.join(base, 'inbox'), direction: 'inbox', archived: false }, { dir: path.join(base, 'outbox'), direction: 'outbox', archived: false }];
    if (includeArchived) {
      folders.push({ dir: path.join(base, 'inbox', '.done'), direction: 'inbox', archived: true });
      folders.push({ dir: path.join(base, 'outbox', '.sent'), direction: 'outbox', archived: true });
    }
    for (const f of folders) {
      for (const m of listMessages(f.dir)) {
        if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue;
        seen.add(m.id);
        if (wantId && m.id !== wantId) continue;
        out.push({ id: m.id, conversation: m.conversation, from: m.from, to: m.to, act: m.act, subject: redactSecrets(m.subject), body: redactSecrets(m.body), requires_reply: !!m.requires_reply, direction: f.direction, owner, archived: f.archived, created_at: m.created_at });
      }
    }
  }
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (wantId) return out.slice(0, 1);
  const lim = typeof opts.limit === 'number' && isFinite(opts.limit) ? Math.max(1, Math.min(40, Math.round(opts.limit))) : 12;
  return out.slice(0, lim);
}

test('SCALE-DONE-STAT: a repeat Threads poll stats no .done file; a new one is statted and read once; same rows as a cold scan', async (t) => {
  const { hive, dir, cold } = await floor(t);
  const done = dir('andy-1', 'inbox', '.done');
  for (let i = 0; i < 60; i++) put(path.join(done, `m-${String(i).padStart(3, '0')}.json`), mail(`m-${i}`, i), i);
  put(path.join(done, 'junk.json'), '{not json', 61);
  const live = hive.send({ to: 'andy-1', act: 'inform', subject: 'live', body: 'l' }, 'god-1');
  // A stale .done copy of a still-live message: the live file is the row, the copy is skipped.
  put(path.join(done, `${live.id}.json`), { ...JSON.parse(fs.readFileSync(dir('andy-1', 'inbox', `${live.id}.json`), 'utf8')), subject: 'stale copy' }, 59);
  const first = hive.mailHistory('andy-1', { limit: 10 });
  assert.equal(first.length, 9, 'the unparsable junk.json takes a slot and is dropped, as before');
  const liveRow = first.find((r) => r.id === live.id);
  assert.deepEqual([liveRow.archived, liveRow.subject], [false, 'live'], 'the live file wins over its .done copy');
  assert.deepEqual(first, cold().mailHistory('andy-1', { limit: 10 }), 'warm = cold on the first call');

  const again = spy(() => hive.mailHistory('andy-1', { limit: 10 }));
  assert.deepEqual(again.out, first);
  const inDone = under([done]);
  assert.deepEqual(again.seen.stat.filter(inDone), [], 'no .done file statted on a repeat poll');
  assert.deepEqual(again.seen.read.filter(inDone), [], 'no .done file read on a repeat poll');
  assert.ok(!again.seen.readdir.includes(done), 'an unchanged .done is not even listed');

  const fresh = path.join(done, 'm-new.json');
  put(fresh, mail('m-new', 500), 500);
  const third = spy(() => hive.mailHistory('andy-1', { limit: 10 }));
  assert.deepEqual(third.seen.stat.filter(inDone), [fresh], 'only the new file is statted');
  assert.deepEqual(third.seen.read.filter(inDone), [fresh], 'only the new file is read');
  assert.ok(third.out.some((r) => r.id === 'm-new'));
  assert.deepEqual(third.out, cold().mailHistory('andy-1', { limit: 10 }), 'warm = cold after a new file');

  // A file leaves .done: it leaves the panel.
  fs.rmSync(fresh);
  const gone = hive.mailHistory('andy-1', { limit: 10 });
  assert.ok(!gone.some((r) => r.id === 'm-new'));
  assert.deepEqual(gone, cold().mailHistory('andy-1', { limit: 10 }));
  assert.deepEqual(hive.mailHistory('andy-1', { limit: 200 }), cold().mailHistory('andy-1', { limit: 200 }), 'whole history equal too');
});

test('SCALE-MESSAGES-INDEX: a repeat hive:messages reads and stats no archived mail; answers match the pre-SCALE full scan', async (t) => {
  const { hive, dir, cold } = await floor(t);
  const done = dir('andy-1', 'inbox', '.done');
  const sent = dir('god-1', 'outbox', '.sent');
  for (let i = 0; i < 50; i++) {
    const m = mail(`2026-01-01T00-${String(i).padStart(2, '0')}-00-000Z-x${i}`, (i * 37) % 50); // name order != time order
    put(path.join(done, `${m.id}.json`), m, i);
    if (i % 3 === 0) put(path.join(sent, `${m.id}.json`), m, i); // delivered: in both, deduped
  }
  put(path.join(done, 'old-1.json'), mail('old-1', -5), 0); // a legacy name
  put(path.join(done, 'bad.json'), '{', 0);
  put(path.join(done, 'noid.json'), { subject: 'x' }, 0);
  put(path.join(sent, 'zz-dup.json'), mail('old-1', 999, { subject: 'later copy' }), 0); // dup id: first seen wins
  put(path.join(dir('andy-1', 'outbox'), 'reply.json'), mail('reply-1', 70, { from: 'andy-1', to: 'god-1' }), 70); // live
  hive.send({ to: 'andy-1', act: 'request', subject: 'live ask', body: 'password=hunter2hunter2' }, 'god-1');

  const cases = [{}, { limit: 40 }, { limit: 3 }, { agentId: 'andy-1', limit: 40 }, { includeArchived: false }, { id: 'old-1' }, { id: 'reply-1' }, { id: 'nope' }];
  for (const c of cases) assert.deepEqual(hive.voiceMessages(c), referenceVoice(hive, c), `cold call ${JSON.stringify(c)}`);

  const archived = under([done, sent, dir('andy-1', 'outbox', '.sent'), dir('god-1', 'inbox', '.done')]);
  for (const c of cases) {
    const r = spy(() => hive.voiceMessages(c));
    assert.deepEqual(r.out, referenceVoice(hive, c), `warm call ${JSON.stringify(c)}`);
    assert.deepEqual(r.seen.stat.filter(archived), [], `no archived file statted ${JSON.stringify(c)}`);
    assert.deepEqual(r.seen.read.filter(archived), [], `no archived file read ${JSON.stringify(c)}`);
  }

  // A new delivery: one stat + its own reads, and it tops the list.
  const n = mail('fresh-1', 2_000_000); // after the live send's real date
  const nf = path.join(sent, 'fresh-1.json');
  put(nf, n, 2000);
  const r = spy(() => hive.voiceMessages({ limit: 40 }));
  assert.equal(r.out[0].id, 'fresh-1');
  assert.deepEqual(r.seen.stat.filter(archived), [nf]);
  assert.deepEqual([...new Set(r.seen.read.filter(archived))], [nf]);
  for (const c of cases) assert.deepEqual(hive.voiceMessages(c), referenceVoice(hive, c), `after a new file ${JSON.stringify(c)}`);

  // A live file rewritten in place is re-read (size/mtime key), never served stale.
  put(path.join(dir('andy-1', 'outbox'), 'reply.json'), mail('reply-1', 70, { from: 'andy-1', to: 'god-1', subject: 'edited subject' }), 71);
  assert.equal(hive.voiceMessages({ id: 'reply-1' })[0].subject, 'edited subject');
  // An archived file removed is gone.
  fs.rmSync(nf);
  for (const c of cases) assert.deepEqual(hive.voiceMessages(c), referenceVoice(hive, c), `after a removal ${JSON.stringify(c)}`);
  assert.deepEqual(hive.voiceMessages({ limit: 40 }), cold().voiceMessages({ limit: 40 }));
});
