'use strict';
require('./tools/own-job.cjs');
/**
 * STARTUP-FREEZE-104 (Jim's fb0536fe warm profile): 31.5 s of a 34.5 s main block at +32 s was
 * keyAliasCandidates, the W5 start-up census. It compared every pair of live keyed claims (O(rows^2)) and rebuilt
 * the namespace list for every pair. Now each distinct key's namespace and digits are worked out once, only keys
 * sharing both are compared, and the edit distance is a banded "at most 2". The census also yields between agents.
 * - the output is IDENTICAL to the old implementation (kept here verbatim) over generated censuses: same-key
 *   duplicates, numbered keys, -/_ variants, typos, overlapping namespaces, superseded and foreign rows;
 * - withinEditDistance2 agrees with registry.ts editDistance <= 2;
 * - the namespace list is read once per call, not per pair (MUTANT: per-pair namespace());
 * - a 10x-sized census (17,000 rows) runs in well under a second;
 * - main runs the census one agent per event-loop turn.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { keyAliasCandidates, keysMayAlias, reconcileItemId, withinEditDistance2 } = loadTs(path.join(__dirname, '../src/main/claims/reconcile.ts'));
const { editDistance } = loadTs(path.join(__dirname, '../src/main/claims/registry.ts'));

/** The pre-fix implementation (fb0536fe), verbatim but for types. */
function oldKeyAliasCandidates(agentId, records, state, registry) {
  const rows = records.filter((r) => r.agent === agentId && !!r.key && state.claims[r.id]?.status === 'live')
    .sort((a, b) => a.id.localeCompare(b.id));
  const namespace = (key) => registry.namespaces
    .map((ns) => ns.pattern.endsWith('.*') ? ns.pattern.slice(0, -1).replace('<id>', agentId) : '')
    .filter((prefix) => prefix && key.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0] ?? '';
  const out = [];
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j], ka = a.key, kb = b.key;
    if (ka === kb || namespace(ka) === '' || namespace(ka) !== namespace(kb) || !keysMayAlias(ka, kb)) continue;
    const na = ka.replace(/[-_]/g, ''), nb = kb.replace(/[-_]/g, '');
    if (na !== nb && editDistance(ka, kb) > 2) continue;
    const pair = [a.id, b.id].sort();
    out.push({ itemId: reconcileItemId(agentId, 'key-alias', pair[0], pair[1]), kind: 'key-alias', a: pair[0], b: pair[1], text: `Possible key alias: ${ka} / ${kb}` });
  }
  return out;
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const REG = { v: 1, keys: {}, namespaces: [
  { pattern: 'card.*', cardinality: 'single' }, { pattern: 'release.*', cardinality: 'single' },
  { pattern: 'agent.<id>.*', cardinality: 'single' }, { pattern: 'agent.*', cardinality: 'single' },
  { pattern: 'project', cardinality: 'single' },
] };

function census(seed, n, words) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
  // own-procs-task-kill-pin: its -/_ and separator-free variants are one key to the bare rule but 3+ edits apart.
  const stems = ['startup-freeze', 'int', 'cut', 'mail_rig', 'blob-meeting', 'node-lts', 'e45-int', 'gate', 'heavy-lock', 'claims-export', 'own-procs-task-kill-pin', 'own_procs_task_kill_pin', 'ownprocstaskkillpin'];
  const base = [];
  for (let i = 0; i < words; i++) {
    const ns = pick(['card.', 'release.', 'agent.owner.', 'agent.other.', 'project.', 'misc.']);
    let stem = pick(stems);
    const v = r();
    if (v < 0.25) stem += `-1.1.${100 + Math.floor(r() * 8)}`;
    else if (v < 0.35) stem += `-${Math.floor(r() * 30)}`;
    else if (v < 0.5) stem = stem.replace('-', '_');
    else if (v < 0.6) stem = stem.slice(0, -1);
    else if (v < 0.7) stem = stem + pick(['x', 's', 'ed']);
    else stem += `.${pick(['a', 'b', 'note', 'status'])}`;
    base.push(ns + stem);
  }
  const records = [], claims = {};
  for (let i = 0; i < n; i++) {
    const id = `c-${(Math.floor(r() * 1e9)).toString(16)}-${i}`;
    const agent = r() < 0.9 ? 'owner' : 'other';
    const key = r() < 0.08 ? undefined : pick(base);
    records.push({ id, t: 'claim', agent, key, kind: 'fact', text: 'x' });
    claims[id] = { status: r() < 0.8 ? 'live' : pick(['superseded', 'retracted']) };
  }
  return { records, state: { claims } };
}

test('the new census is identical to the old one (pairs, order, ids, text) over generated censuses', () => {
  let total = 0;
  for (const [seed, n, words] of [[1, 60, 12], [2, 300, 40], [3, 800, 120], [4, 1200, 25], [5, 500, 500], [6, 40, 4]]) {
    const { records, state } = census(seed, n, words);
    const want = oldKeyAliasCandidates('owner', records, state, REG);
    const got = keyAliasCandidates('owner', records, state, REG);
    assert.deepEqual(got, want, `seed ${seed}`);
    total += want.length;
  }
  assert.ok(total > 200, `the generated censuses do propose pairs (${total})`);
});

test('withinEditDistance2 is editDistance <= 2', () => {
  const r = rng(9), abc = 'ab-_.1';
  const word = () => { let s = ''; const n = Math.floor(r() * 9); for (let i = 0; i < n; i++) s += abc[Math.floor(r() * abc.length)]; return s; };
  let yes = 0;
  for (let i = 0; i < 20000; i++) {
    const a = word(), b = r() < 0.5 ? word() : a.slice(0, Math.floor(r() * a.length)) + word().slice(0, 2) + a.slice(Math.floor(r() * a.length));
    const want = editDistance(a, b) <= 2;
    assert.equal(withinEditDistance2(a, b), want, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    if (want) yes++;
  }
  assert.ok(yes > 2000 && yes < 18000, `both answers occur (${yes})`);
});

test('the namespace list is read once per census, not once per pair (MUTANT: per-pair namespace())', () => {
  const { records, state } = census(3, 800, 120);
  let reads = 0;
  const reg = { v: 1, keys: {}, get namespaces() { reads++; return REG.namespaces; } };
  const found = keyAliasCandidates('owner', records, state, reg);
  assert.ok(found.length > 0);
  assert.equal(reads, 1, `namespaces read ${reads} times`);
});

test('a 10x-sized census (17,000 rows, 3,000 keys) takes well under a second', () => {
  const { records, state } = census(11, 17000, 3000);
  const t0 = performance.now();
  const found = keyAliasCandidates('owner', records, state, REG);
  const ms = performance.now() - t0;
  assert.ok(found.length > 0);
  assert.ok(ms < 1000, `${ms.toFixed(0)} ms (the old census took tens of seconds at this size)`);
});

test('main runs the start-up census one agent per event-loop turn', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(src, /void warmed\.then\(async \(\) => \{ for \(const agentId of claimLedgerAgents\(\)\) \{ await new Promise<void>\(\(r\) => setImmediate\(r\)\); try \{ refreshReconcileQueueForHive\(root, agentId, reconcileHiveDeps\(\)\);/);
});
