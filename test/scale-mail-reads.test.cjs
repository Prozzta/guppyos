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
/** Pins a folder's mtime (i minutes after T0): the moves this test makes never share a clock tick
 *  with an earlier listing by accident (the racy case has its own test below). */
const touchDir = (d, i) => { const at = new Date(T0 + i * 60_000); fs.utimesSync(d, at, at); };
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
  touchDir(done, 0);
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
  touchDir(done, 1);
  const third = spy(() => hive.mailHistory('andy-1', { limit: 10 }));
  assert.deepEqual(third.seen.stat.filter(inDone), [fresh], 'only the new file is statted');
  assert.deepEqual(third.seen.read.filter(inDone), [fresh], 'only the new file is read');
  assert.ok(third.out.some((r) => r.id === 'm-new'));
  assert.deepEqual(third.out, cold().mailHistory('andy-1', { limit: 10 }), 'warm = cold after a new file');

  // A file leaves .done: it leaves the panel.
  fs.rmSync(fresh);
  touchDir(done, 2);
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
  for (const d of [done, sent, dir('andy-1', 'outbox', '.sent')]) touchDir(d, 0);

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
  touchDir(sent, 1);
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
  touchDir(sent, 2);
  for (const c of cases) assert.deepEqual(hive.voiceMessages(c), referenceVoice(hive, c), `after a removal ${JSON.stringify(c)}`);
  assert.deepEqual(hive.voiceMessages({ limit: 40 }), cold().voiceMessages({ limit: 40 }));
});

test('racy mtime (Jim B1): a listing, meta or body taken within RACY_MS of the mtime is not trusted; an older one keeps the fast path', async (t) => {
  const { hive, dir } = await floor(t);
  const done = dir('andy-1', 'inbox', '.done');
  for (let i = 0; i < 5; i++) put(path.join(done, `m-${i}.json`), mail(`m-${i}`, i), i);
  const T = Date.parse('2026-06-01T00:00:00.000Z');
  const at = new Date(T);
  fs.utimesSync(done, at, at);
  let now = T + 500;
  hive.mailClock = () => now; // the listing is taken in the same tick as the folder's mtime
  const ids = () => hive.mailHistory('andy-1', { limit: 50 }).map((r) => r.id);
  assert.equal(ids().length, 5);
  // A second move in the same tick: NTFS leaves the folder mtime unchanged.
  put(path.join(done, 'm-b.json'), mail('m-b', 10), 10);
  fs.utimesSync(done, at, at);
  assert.ok(ids().includes('m-b'), 'a file moved in within the same tick as the listed mtime is found');
  // A listing RACY_MS past the mtime is trusted again: one stat of the folder, no readdir, no file stat.
  now = T + 5000;
  ids();
  const warm = spy(ids);
  assert.ok(warm.out.includes('m-b'));
  assert.ok(!warm.seen.readdir.includes(done), 'a trusted listing is not relisted');
  assert.deepEqual(warm.seen.stat.filter(under([done])), []);

  // A live file rewritten in the same tick with the same size keeps its size+mtime key: its meta
  // (order) and body (subject) must still be read again.
  now = T + 500;
  const out = dir('andy-1', 'outbox');
  const live = (id, subject, when) => ({ ...mail(id, 0, { from: 'andy-1', to: 'god-1', subject }), created_at: when });
  const write = (n, m) => { const p = path.join(out, n); fs.writeFileSync(p, JSON.stringify(m)); fs.utimesSync(p, at, at); };
  write('x.json', live('r-x', 'aaaa', '2026-06-01T00:00:01.000Z'));
  write('y.json', live('r-y', 'yyyy', '2026-06-01T00:00:02.000Z'));
  const rows = () => hive.voiceMessages({ agentId: 'andy-1', includeArchived: false, limit: 40 }).map((r) => `${r.id}:${r.subject}`);
  assert.deepEqual(rows(), ['r-y:yyyy', 'r-x:aaaa']);
  const before = fs.statSync(path.join(out, 'x.json')).size;
  write('x.json', live('r-x', 'bbbb', '2026-06-01T00:00:03.000Z'));
  assert.equal(fs.statSync(path.join(out, 'x.json')).size, before, 'same size, same mtime: the key cannot tell');
  assert.deepEqual(rows(), ['r-x:bbbb', 'r-y:yyyy'], 'the rewrite shows: new order (meta) and new subject (body)');
});

// ── god 8d8fff: the IPC forms run off the caller's turn on fs/promises in 8 ms slices ──
const MS = loadTs('src/main/mailSteps.ts');
/** An async runner's deps that record every op path and every slice; `sliceMs` 1 = a pause at every tick. */
function recorder(extra = {}) {
  const r = { ops: [], pauses: 0, slices: [] };
  r.deps = {
    runOp: (op) => { const walk = (o) => ('batch' in o ? o.batch.forEach(walk) : r.ops.push(o)); walk(op); return MS.runMailOpAsync(op); },
    pause: () => { r.pauses++; return new Promise((res) => setImmediate(res)); },
    onSlice: (ms) => r.slices.push(ms),
    ...extra,
  };
  return r;
}
const opPaths = (ops, kind) => ops.filter((o) => kind in o).map((o) => o[kind]);

async function bigFloor(t, n) {
  const f = await floor(t);
  const done = f.dir('andy-1', 'inbox', '.done');
  const sent = f.dir('god-1', 'outbox', '.sent');
  for (let i = 0; i < n; i++) {
    // created_at repeats every 7 files: ties must keep traversal order (the stable sort it replaces)
    const m = mail(`2026-01-01T00-00-00-000Z-k${String(i).padStart(5, '0')}`, Math.floor(i / 7) % 300);
    put(path.join(i % 2 ? done : sent, `${m.id}.json`), m, i % 500);
  }
  put(path.join(f.dir('andy-1', 'outbox'), 'reply.json'), mail('reply-1', 10, { from: 'andy-1', to: 'god-1' }), 10);
  for (const d of [done, sent]) touchDir(d, 0);
  return { ...f, done, sent };
}

test('sliced: nothing runs in the caller\'s turn; the async answers equal the sync ones and the pre-SCALE scan', async (t) => {
  const { hive, cold } = await bigFloor(t, 600);
  const rec = recorder();
  const seen = spy(() => hive.voiceMessagesAsync({ limit: 40 }, rec.deps));
  assert.equal(rec.ops.length, 0, 'no fs op before the first pause');
  assert.equal(rec.pauses, 1, 'the run starts with a pause');
  assert.deepEqual([...seen.seen.stat, ...seen.seen.read, ...seen.seen.readdir], [], 'no blocking fs call in the caller\'s turn');
  const got = await seen.out;
  const c = cold();
  for (const o of [{}, { limit: 40 }, { limit: 3 }, { agentId: 'andy-1', limit: 40 }, { includeArchived: false }, { id: 'reply-1' }]) {
    assert.deepEqual(await hive.voiceMessagesAsync(o), referenceVoice(hive, o), `async = pre-SCALE ${JSON.stringify(o)}`);
    assert.deepEqual(await c.voiceMessagesAsync(o), c.voiceMessages(o), `cold async = sync ${JSON.stringify(o)}`);
  }
  assert.deepEqual(got, referenceVoice(hive, { limit: 40 }));
  const h = recorder();
  const hp = hive.mailHistoryAsync('andy-1', { limit: 50 }, h.deps);
  assert.equal(h.ops.length, 0);
  assert.deepEqual(await hp, cold().mailHistory('andy-1', { limit: 50 }));
});

test('sliced: a warm call does no fs/promises op on archived mail, and its in-memory walk yields (no single long turn)', async (t) => {
  const { hive, done, sent } = await bigFloor(t, 3000);
  await hive.voiceMessagesAsync({ limit: 40 });
  await hive.mailHistoryAsync('andy-1', { limit: 200 });
  const archived = under([done, sent]);
  const rec = recorder({ sliceMs: 0 }); // a pause at every tick: counts the ticks
  const rows = await hive.voiceMessagesAsync({ limit: 40 }, rec.deps);
  assert.deepEqual(rows, referenceVoice(hive, { limit: 40 }));
  assert.deepEqual(opPaths(rec.ops, 'read').filter(archived), [], 'no archived file read');
  assert.deepEqual(opPaths(rec.ops, 'stat').filter(archived), [], 'no archived file statted');
  assert.ok(rec.pauses >= Math.floor(3000 / MS.TICK_EVERY), `the walk over 3000 entries ticks (${rec.pauses} pauses)`);
  const h = recorder();
  await hive.mailHistoryAsync('andy-1', { limit: 200 }, h.deps);
  assert.deepEqual(opPaths(h.ops, 'stat').filter(archived), [], 'a repeat Threads poll stats no .done file');
  assert.deepEqual(opPaths(h.ops, 'read').filter(archived), []);
});

test('sliced: the runner hands main back once the 8 ms budget is spent, and a cold call on real files keeps every slice under the 50 ms bar', async (t) => {
  // Deterministic: a clock that moves 1 ms per look; a 4000-item sort must pause about every 8 ticks.
  let now = 0;
  const rec = recorder({ clock: () => now++ });
  const sorted = await MS.runMailSliced(MS.sortSteps(Array.from({ length: 4000 }, (_, i) => (i * 7919) % 4000), (a, b) => a - b), rec.deps);
  assert.deepEqual(sorted, Array.from({ length: 4000 }, (_, i) => i));
  assert.ok(rec.slices.every((ms) => ms <= MS.CATCHUP_SLICE_MS + 2), `every slice within budget: ${Math.max(...rec.slices)}`);
  assert.ok(rec.pauses >= 8, `the sort pauses inside each pass, not only between passes (${rec.pauses})`);
  // Measured: a cold run over 3000 real files.
  const { hive } = await bigFloor(t, 3000);
  const real = recorder({ pause: undefined });
  delete real.deps.pause;
  await hive.voiceMessagesAsync({ limit: 40 }, real.deps);
  assert.ok(Math.max(...real.slices) < 50, `worst slice ${Math.max(...real.slices).toFixed(1)} ms`);
});

test('sliced: identical concurrent calls share one run; the order an incremental listing derives equals a fresh sort', async (t) => {
  const { hive, done, cold } = await bigFloor(t, 400);
  const a = hive.voiceMessagesAsync({ limit: 5 });
  assert.equal(hive.voiceMessagesAsync({ limit: 5 }), a, 'one run');
  assert.notEqual(hive.voiceMessagesAsync({ limit: 6 }), a);
  await a;
  await hive.mailHistoryAsync('andy-1', { limit: 1000 });
  // New files (one ties an old mtime, one sorts before every name) and a removal: merged, not re-sorted.
  put(path.join(done, '0000-first.json'), mail('first', 999), 3);
  put(path.join(done, 'zzzz-last.json'), mail('last', 998), 3);
  fs.rmSync(path.join(done, fs.readdirSync(done).filter((n) => n.includes('k0000'))[0] ?? 'none'), { force: true });
  touchDir(done, 7);
  for (const o of [{ limit: 40 }, { agentId: 'andy-1', limit: 40 }]) assert.deepEqual(await hive.voiceMessagesAsync(o), referenceVoice(hive, o));
  assert.deepEqual(await hive.mailHistoryAsync('andy-1', { limit: 1000 }), cold().mailHistory('andy-1', { limit: 1000 }));
});

test('PIN: the hive:inbox and hive:messages handlers use the sliced async forms', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /return hive\.mailHistoryAsync\(id, \{ archived \}\);/);
  assert.match(main, /ipcMain\.handle\('hive:messages', \(_evt, opts: unknown\) =>\s+hive\.voiceMessagesAsync\(/);
});

test('sliced: the in-memory walk itself ticks (pauses between the last fs op and the answer scale with the last folder)', async (t) => {
  const { hive } = await bigFloor(t, 3000); // .sent (the last folder walked) holds 1500 files
  await hive.voiceMessagesAsync({ agentId: 'god-1', limit: 1 });
  let atLastOp = 0;
  const rec = recorder({ sliceMs: 0 });
  const inner = rec.deps.runOp;
  rec.deps.runOp = (op) => { atLastOp = rec.pauses; return inner(op); };
  await hive.voiceMessagesAsync({ agentId: 'god-1', limit: 1 }, rec.deps);
  // after the .sent stat: its cached-meta pass ticks every 512 names, and so must the walk (+ one row tick)
  const after = rec.pauses - atLastOp;
  assert.ok(after >= 2 * Math.floor(1500 / MS.TICK_EVERY) + 2, `walk + meta pass both tick (${after} pauses after the last op)`);
});
