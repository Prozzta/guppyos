'use strict';
/**
 * CLAIM-LEDGER W1 gate G1.1, crash safety: 10,000 appends with simulated crashes, against real
 * files with a real fsync. A crash is one of:
 *   - a torn write: part of the line reaches the file, then the write throws;
 *   - a crash after the write, before the fsync completes (the line is complete but NOT acked);
 * and after a crash the store is often "restarted" (a fresh ClaimStore over the same files).
 * Every acked record must survive, the torn tails must be quarantined and logged, the chain must
 * verify, and the reader must never throw. The crash schedule is a seeded PRNG: reproducible.
 *
 * HOME and USERPROFILE are jailed and asserted before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-crash-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const ROOT = path.join(__dirname, '..');
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));

const N = 10_000;

function prng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

test(`G1.1 crash safety: ${N} appends with simulated crashes; every acked record survives`, { timeout: 15 * 60_000 }, async () => {
  const root = path.join(JAIL, 'hive');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const rand = prng(0xC1A1);
  const keys = new SandboxKeyProvider();
  const keyRecord = new FileLedgerKeyRecord(path.join(JAIL, 'userdata', 'claims-mac.hives.json'));
  let t = Date.parse('2026-10-03T00:00:00Z');
  const now = () => new Date(t);
  let mode = 'none';
  const io = {
    openSync: (p, f) => fs.openSync(p, f),
    writeSync: (fd, buf) => {
      if (mode === 'torn') {
        const n = 1 + Math.floor(rand() * (buf.length - 1));   // at least 1 byte, never the whole line
        fs.writeSync(fd, buf.subarray(0, n));
        throw new Error('simulated crash mid-write');
      }
      return fs.writeSync(fd, buf);
    },
    fsyncSync: (fd) => { if (mode === 'fsync') throw new Error('simulated crash before the fsync returned'); fs.fsyncSync(fd); },
    closeSync: (fd) => fs.closeSync(fd),
  };
  const logs = [];
  const mk = () => new ClaimStore({ hiveRoot: root, keys, keyRecord, now, io, log: (r) => logs.push(r) });
  let store = mk();
  const acked = new Set();
  const unacked = new Set();   // complete lines whose fsync "crashed": allowed to survive, never required
  let torn = 0, fsyncCrashes = 0, restarts = 0, reads = 0;
  for (let i = 0; i < N; i++) {
    t += 1000;
    const r = rand();
    mode = r < 0.02 ? 'torn' : r < 0.03 ? 'fsync' : 'none';
    const text = `fact ${i} ${'x'.repeat(Math.floor(rand() * 120))}`;
    const res = await store.appendRecord('andy', { t: 'claim', kind: 'fact', text }, 'endpoint');
    if (mode === 'none') {
      assert.equal(res.ok, true, `append ${i}: ${JSON.stringify(res)}`);
      acked.add(res.id);
    } else {
      assert.equal(res.ok, false, 'a crashed append is never acked');
      if (mode === 'torn') torn++; else { fsyncCrashes++; unacked.add(text); }
      mode = 'none';
      if (rand() < 0.5) { store.close(); store = mk(); restarts++; }
    }
    if (rand() < 0.002) {
      reads++;
      const rr = mk().readLedger('andy');
      assert.equal(rr.chain, 'ok', `mid-run read ${i}`);
    }
  }
  mode = 'none';
  store.close();
  const final = mk().readLedger('andy');
  assert.equal(final.chain, 'ok');
  const ids = new Set(final.records.map((x) => x.id));
  for (const id of acked) assert.ok(ids.has(id), `acked ${id} survived`);
  const extra = final.records.filter((x) => !acked.has(x.id));
  assert.ok(extra.every((x) => unacked.has(x.text)), 'the only unacked survivors are complete lines whose fsync crashed');
  assert.equal(final.records.length, acked.size + extra.length);
  const quarantined = fs.readFileSync(path.join(root, 'agents', 'andy', 'memory', 'claims.torn.jsonl'), 'utf8').trim().split('\n').length;
  assert.equal(quarantined, torn, 'every torn tail was quarantined');
  assert.equal(logs.filter((l) => l.kind === 'claims-torn').length, torn, 'and logged');
  assert.ok(torn > 100 && fsyncCrashes > 50 && restarts > 50 && reads > 5, `the schedule exercised every path (torn ${torn}, fsync ${fsyncCrashes}, restarts ${restarts}, reads ${reads})`);
  assert.equal(acked.size, N - torn - fsyncCrashes);
});
