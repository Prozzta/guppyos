'use strict';
/**
 * CLAIMS-90 brief cost (god 986e89): the search brief's latency (main's claimCardLeadOver, as index.ts calls it)
 * over a COPY of a built hive whose ledgers are re-signed under a throwaway key, so the app's ClaimStore reads and
 * MAC-verifies them as it does in the app. Never point it at a live floor: it copies, and only reads the copy.
 *   cold    each ask on a new ClaimStore (nothing kept: the first ask after a start)
 *   warm    asks on one store, ledgers unchanged
 *   append  one signed line appended to the derived ledger before each ask (a claims sync landing between asks)
 * Usage: node test/tools/claims90-brief-bench.cjs <builtHiveRoot> <termsFile (one query per line)> [--json]
 * Prints p50 / p95 / max ms per mode. Exit 2 on usage, 3 when the re-signed copy does not verify.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const loadTs = require('../load-ts.cjs');

const [src, termsFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!src || !termsFile) { console.error('usage: claims90-brief-bench.cjs <builtHiveRoot> <termsFile> [--json]'); process.exit(2); }
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { keyIdOf, recordMac, sha256Hex } = loadTs('src/main/claims/canonical.ts');
const { claimCardLeadOver } = loadTs('src/main/claims/readWiring.ts');

const SEG = /^\d{4}-\d{2}\.jsonl$/;
const terms = fs.readFileSync(termsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-bench-'));
const hive = path.join(jail, 'hive');
const ud = path.join(jail, 'ud');
fs.mkdirSync(ud, { recursive: true });
for (const f of ['registry.json', 'tasks.json', 'claims-reconcile-queue.json']) {
  if (fs.existsSync(path.join(src, f))) { fs.mkdirSync(hive, { recursive: true }); fs.copyFileSync(path.join(src, f), path.join(hive, f)); }
}
const key = randomBytes(32);
const last = {};  // agent -> { file, line } of its newest signed line
const sign = (agent, rec, prevLine) => {
  const r = { ...rec, agent, prev: prevLine === null ? '' : sha256Hex(prevLine) };
  delete r.mac;
  r.mac = recordMac(key, r);
  return JSON.stringify(r);
};
let lines = 0;
for (const agent of fs.readdirSync(path.join(src, 'agents'))) {
  const from = path.join(src, 'agents', agent, 'memory', 'claims');
  let segs = [];
  try { segs = fs.readdirSync(from).filter((n) => SEG.test(n)).sort(); } catch { continue; }
  if (!segs.length) continue;
  const to = path.join(hive, 'agents', agent, 'memory', 'claims');
  fs.mkdirSync(to, { recursive: true });
  let prev = null;
  for (const s of segs) {
    const out = [];
    for (const l of fs.readFileSync(path.join(from, s), 'utf8').split('\n')) {
      if (!l.trim()) continue;
      let v; try { v = JSON.parse(l); } catch { continue; }
      if (!v || typeof v.id !== 'string' || (v.t !== 'claim' && v.t !== 'event')) continue;
      const line = sign(agent, v, prev);
      out.push(line); prev = line; lines++;
    }
    fs.writeFileSync(path.join(to, s), out.map((l) => l + '\n').join(''));
    if (out.length) last[agent] = { file: path.join(to, s), line: out[out.length - 1] };
  }
}
const agents = () => Object.keys(last);
const tasks = (() => { try { const t = JSON.parse(fs.readFileSync(path.join(hive, 'tasks.json'), 'utf8')); return Array.isArray(t) ? t : (t.tasks ?? []); } catch { return []; } })();
const keys = new SandboxKeyProvider(key);
// main's user-data record of this hive's ledger key (the store refuses a key it has no record of once segments exist).
new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)).set(hive, keyIdOf(key));
const newStore = () => new ClaimStore({ hiveRoot: hive, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)), anchorDelayMs: 1e9 });
const deps = (store) => ({ root: hive, store, agents, tasks: () => tasks });
const ask = (q) => ({ cards: [], texts: [q] });

const probe = newStore();
for (const a of agents()) {
  const r = probe.readLedger(a);
  if (r.chain !== 'ok') { console.error(`re-signed ${a} does not verify: ${JSON.stringify(r.chain)}`); fs.rmSync(jail, { recursive: true, force: true }); process.exit(3); }
}
const ms = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), max: +s[s.length - 1].toFixed(1) };
};
const out = { lines, agents: agents().length, terms: terms.length, named: 0 };
// cold: a new store per ask (no verified read kept, new record arrays, so nothing downstream is kept either).
out.cold = stats(terms.map((q) => ms(() => claimCardLeadOver(deps(newStore()), ask(q)))));
// warm: one store, unchanged ledgers (first ask primes it and is not counted).
const store = newStore();
claimCardLeadOver(deps(store), ask(terms[0]));
out.warm = stats(terms.map((q) => ms(() => { if (claimCardLeadOver(deps(store), ask(q)).named.length) out.named++; })));
// append: one signed derived line before each ask (the largest ledger, the one a claims sync appends to).
const grow = 'derived' in last ? 'derived' : agents()[0];
let n = 0;
out.append = stats(terms.map((q) => {
  const prev = last[grow];
  const line = sign(grow, { t: 'claim', id: `c-bench${String(++n).padStart(8, '0')}`, at: new Date().toISOString(), kind: 'fact', key: `bench.${n}`, text: `bench line ${n}`, source: 'derived' }, prev.line);
  fs.appendFileSync(prev.file, line + '\n');
  last[grow] = { file: prev.file, line };
  return ms(() => claimCardLeadOver(deps(store), ask(q)));
}));
const r = store.readLedger(grow);
out.appendVerified = r.chain === 'ok';
fs.rmSync(jail, { recursive: true, force: true });
if (process.argv.includes('--json')) console.log(JSON.stringify(out));
else for (const [k, v] of Object.entries(out)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
