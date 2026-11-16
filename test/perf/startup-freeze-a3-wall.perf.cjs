'use strict';
require('../tools/own-job.cjs');
/**
 * STARTUP-FREEZE-A3-WALL (god c94e19): the wall-clock half of test/startup-freeze-a3.test.cjs's warm()
 * test, in the SERIAL PERF LANE (test/tools/run-tests.cjs runs every test/perf/*.perf.cjs with
 * --test-concurrency=1, after the parallel suite).
 *
 * Why a lane of its own: in the parallel suite the pause-to-pause wall measured the machine, not
 * warm(). The suite runs in a Job Object hard-capped at 50% CPU; when the parallel burst hits the cap,
 * Windows takes every thread of the job off the CPU until the next rate interval. Under suite load
 * the worst gap reached 603-820 ms with 0 ms of this thread's CPU and 0 ms in fs/promises reads, a
 * setTimeout(0) probe and monitorEventLoopDelay frozen for the same 600-820 ms, and a worker thread
 * of the same process frozen too (so a control thread cannot tell such a freeze from a code block).
 * Alone, and late in the suite, the worst gap is 9-37 ms. The bar is unchanged: 500 ms, a single
 * measurement, as in the parallel suite before. The correctness half (it pauses, the CPU per slice,
 * no synchronous segment read, the cached read after) stays in test/startup-freeze-a3.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-a3-wall-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) { try { s.close(); } catch { /* closed */ } }
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('../load-ts.cjs');
const ROOT = path.join(__dirname, '..', '..');
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { canonicalJson, recordMac, sha256Hex } = loadTs(path.join(ROOT, 'src/main/claims/canonical.ts'));

const KEY = crypto.randomBytes(32);
let n = 0;
function setup() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  fs.mkdirSync(ud, { recursive: true });
  const keys = new SandboxKeyProvider(KEY);
  const keyRecord = new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE));
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const cp = { text: null, load() { return this.text; }, save(t) { this.text = t; } };
  const mk = () => {
    let t = Date.parse('2026-11-12T10:00:00Z');
    const store = new ClaimStore({ hiveRoot: root, keys, keyRecord, headAnchor: anchors, checkpoint: cp, now: () => new Date(t += 1000), alert() {}, log() {} });
    STORES.push(store);
    return store;
  };
  const claimsDir = (a) => path.join(root, 'agents', a, 'memory', 'claims');
  return { root, keyRecord, anchors, mk, claimsDir };
}

/** The same generated ledger as the parallel test: one real append gives the record shape, then chained, MAC'd lines. */
async function writeLedger(x, a, months) {
  const probe = setup();
  const r = await probe.mk().appendRecord('tmpl', { t: 'claim', kind: 'fact', text: 'template' }, 'endpoint');
  assert.equal(r.ok, true, JSON.stringify(r));
  const TEMPLATE = JSON.parse(fs.readFileSync(path.join(probe.claimsDir('tmpl'), fs.readdirSync(probe.claimsDir('tmpl'))[0]), 'utf8').split('\n')[0]);
  x.keyRecord.set(x.root, crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 16));
  fs.mkdirSync(x.claimsDir(a), { recursive: true });
  let prev = ''; let i = 0;
  for (const [name, count] of Object.entries(months)) {
    const out = [];
    for (let k = 0; k < count; k++, i++) {
      const rec = { ...TEMPLATE, agent: a, id: `c-${(i + 1).toString(16).padStart(12, '0')}`, text: `fact number ${String(i).padStart(6, '0')} of ${a}`, prev };
      for (const f of ['wt', 'at']) if (f in rec) rec[f] = `${name.slice(0, 7)}-05T10:00:00.000Z`;
      delete rec.mac;
      rec.mac = recordMac(KEY, rec);
      const line = canonicalJson(rec);
      out.push(line);
      prev = sha256Hex(line);
    }
    fs.appendFileSync(path.join(x.claimsDir(a), name), out.map((l) => l + '\n').join(''));
  }
  x.anchors.set(x.root, a, { head: prev, lastId: `c-${i.toString(16).padStart(12, '0')}` });
}

test('warm(): no slice blocks the event loop for 500 ms (wall between two pauses, real 4 ms slices, 7000 lines)', async () => {
  const y = setup();
  await writeLedger(y, 'andy', { '2026-09.jsonl': 3000, '2026-10.jsonl': 3000, '2026-11.jsonl': 1000 });
  const s2 = y.mk();
  let lastWall = 0; let worstWall = 0; let pauses = 0;
  lastWall = performance.now();
  const res = await s2.warm(['andy'], { sliceMs: 4, pause: () => new Promise((r) => setImmediate(() => { const wall = performance.now(); worstWall = Math.max(worstWall, wall - lastWall); pauses++; lastWall = wall; r(); })) });
  assert.deepEqual(res.warmed, ['andy']);
  assert.ok(pauses >= 3, `the warm paused between slices (${pauses})`);
  assert.ok(worstWall < 500, `no slice blocked the event loop for 500 ms (${worstWall.toFixed(1)} ms)`);
});
